/*
 * File: merger.js
 * Project: Valhalla-Updater
 * File Created: Friday, 10th May 2024 10:43:43 pm
 * Author: flaasz
 * -----
 * Last Modified: Tuesday, 28th May 2024 7:25:50 pm
 * Modified By: flaasz
 * -----
 * Copyright 2024 flaasz
 */

var fs = require('fs');
const {
    resolve,
    sep,
    join,
    dirname
} = require('path');
const {
    downloadList
} = require('./downloader');
const {
    hashFile
} = require('./functions');
const textMerge = require('./textMerge');
const sessionLogger = require('./sessionLogger');

const isFile = (file) => fs.existsSync(file) && fs.statSync(file).isFile();

// Pack paths come as "/config/a.toml" (comparator) or "./config/a.toml" (manifests)
const packRelative = (path) => String(path).replace(/^\.?\/+/, '');

/**
 * Sorts the outcome of one three-way file merge into the report and logs it.
 * @returns {Buffer|null} Content to write over the pack's new file, or null to keep that.
 */
function recordOutcome(report, rel, outcome, live) {
    sessionLogger.info('Merger', `Three-way ${rel}: ${outcome.status}`);
    switch (outcome.status) {
        case 'merged':
            report.merged.push(rel);
            return outcome.content;
        case 'same':
            report.kept.push(rel);
            return live;
        case 'conflict':
            report.conflicts.push(rel);
            return null;
        case 'binary':
            report.overwritten.push(rel);
            return null;
        default:
            return null;
    }
}

module.exports = {
    /**
     * Merges the changes from the changeList to the temp directory.
     * A file the pack changed that the server also edited gets a line-level three-way
     * merge when it is text. Everything else the pack changed is replaced, as before.
     * @param {String} dir Work directory to merge changes to.
     * @param {Object} changeList ChangeList object containing the changes.
     * @returns {Object} Merge report from textMerge.emptyReport.
     */
    merge: function (dir, changeList) {
        const report = textMerge.emptyReport();
        const deleted = new Set(changeList.deletions);
        const results = [];

        // Read before the copy below replaces the live files
        for (const path of changeList.additions) {
            if (!deleted.has(path)) continue;
            const livePath = `${dir}/compare/main${path}`;
            const oldPath = `${dir}/compare/old${path}`;
            const newPath = `${dir}/compare/new${path}`;
            if (![livePath, oldPath, newPath].every(isFile)) continue;
            const rel = packRelative(path);
            try {
                if (textMerge.filesEqual(livePath, oldPath)) continue;
                if (!textMerge.isTextPath(rel) || fs.statSync(livePath).size > textMerge.MAX_TEXT_BYTES) {
                    recordOutcome(report, rel, { status: 'binary' });
                    continue;
                }
                const live = fs.readFileSync(livePath);
                const outcome = textMerge.mergeBuffers(live, fs.readFileSync(oldPath), fs.readFileSync(newPath), rel);
                const content = recordOutcome(report, rel, outcome, live);
                if (content) results.push({ path, content });
            } catch (error) {
                // The pack's new file is the fallback, as before this merge existed
                sessionLogger.warn('Merger', `Three-way ${rel} failed, taking the pack's file: ${error.message}`);
                report.overwritten.push(rel);
            }
        }

        for (let path of changeList.deletions) {
            if (fs.existsSync(`${dir}/compare/main${path}`)) {
                fs.rmSync(`${dir}/compare/main${path}`, {
                    recursive: true,
                    force: true
                });
            }
        }
        sessionLogger.info('Merger', "Removed old files");
        for (let path of changeList.additions) {
            try {
                const sourcePath = `${dir}/compare/new${path}`;
                const destPath = `${dir}/compare/main${path}`;
                
                // Check if source path exists before copying
                if (fs.existsSync(sourcePath)) {
                    // Create parent directory if it doesn't exist
                    const parentDir = destPath.substring(0, destPath.lastIndexOf('/'));
                    if (!fs.existsSync(parentDir)) {
                        fs.mkdirSync(parentDir, { recursive: true });
                    }
                    
                    fs.cpSync(sourcePath, destPath, {
                        recursive: true
                    });
                } else {
                    sessionLogger.warn('Merger', `Source path does not exist: ${sourcePath}`);
                }
            } catch (error) {
                sessionLogger.error('Merger', `Error copying file ${path}: ${error.message}`);
                // Continue with next file instead of failing the entire update
            }
        }
        sessionLogger.info('Merger', "Added new files");

        for (const {
                path,
                content
            } of results) {
            fs.writeFileSync(`${dir}/compare/main${path}`, content);
        }
        return report;
    },

    /**
     * Merges the changes from the changeList to the temp directory.
     * With the old manifest, a text file the pack changed that the server also edited gets
     * a three-way merge. FTB ships no old pack on disk, so the old copies of those few
     * files are fetched from the old manifest's URLs, with its hashes checked.
     * @param {string} dir The directory to merge the changes to.
     * @param {object} changeList Object containing the changes.
     * @param {object} newManifest Object containing the new manifest.
     * @param {object} oldManifest Manifest of the version the server runs. Without it every changed file is replaced.
     * @param {object} options baseDir (scratch for the old copies) and fetchList (downloader, injectable for tests).
     * @returns {Object} Merge report from textMerge.emptyReport.
     */
    mergeFromManifest: async function (dir, changeList, newManifest, oldManifest = null, options = {}) {
        const report = textMerge.emptyReport();
        const fetchList = options.fetchList || downloadList;
        const baseDir = options.baseDir || join(dirname(resolve(dir)), 'merge-base');
        const entryPath = (file) => (file.path.endsWith('/') ? file.path : file.path + '/') + file.name;
        let candidates = [];

        if (oldManifest) {
            const root = resolve(dir);
            const oldByPath = new Map(oldManifest.files.map(file => [entryPath(file), file]));
            const newByPath = new Map(newManifest.files.map(file => [entryPath(file), file]));
            const deleted = new Set(changeList.deletions);
            for (const path of changeList.additions) {
                const oldEntry = oldByPath.get(path);
                const newEntry = newByPath.get(path);
                const rel = packRelative(path);
                const livePath = join(dir, rel);
                if (!deleted.has(path) || !oldEntry || !newEntry || !resolve(livePath).startsWith(root + sep) || !isFile(livePath)) continue;
                const liveSize = fs.statSync(livePath).size;
                const text = textMerge.isTextPath(rel) && [liveSize, oldEntry.size, newEntry.size]
                    .every(size => !(size > textMerge.MAX_TEXT_BYTES));
                // A different size is an edit on its own; the hash is only worth reading when it is not
                if (liveSize === oldEntry.size && oldEntry.sha1 && hashFile(livePath) === String(oldEntry.sha1).toLowerCase()) continue;
                if (!text) {
                    recordOutcome(report, rel, { status: 'binary' });
                    continue;
                }
                candidates.push({
                    path,
                    rel,
                    live: fs.readFileSync(livePath),
                    oldEntry
                });
            }

            if (candidates.length > 0) {
                try {
                    fs.rmSync(baseDir, { recursive: true, force: true });
                    await fetchList(candidates.map(candidate => ({ ...candidate.oldEntry })), baseDir);
                } catch (error) {
                    sessionLogger.warn('Merger', `Could not fetch the old copies for the three-way merge, taking the pack's files: ${error.message}`);
                    for (const candidate of candidates) report.overwritten.push(candidate.rel);
                    candidates = [];
                }
            }
        }

        // Diagnostic logging for deletions
        sessionLogger.info('Merger', `Attempting to delete ${changeList.deletions.length} files`);
        if (changeList.deletions.length > 0) {
            sessionLogger.info('Merger', `First 3 deletion paths: ${JSON.stringify(changeList.deletions.slice(0, 3))}`);
        }

        let deletedCount = 0;
        let notFoundCount = 0;
        const root = resolve(dir);
        for (let path of changeList.deletions) {
            // Strip leading ./ from path before concatenating
            const relativePath = path.startsWith('./') ? path.substring(2) : path;
            const fullPath = `${dir}/${relativePath}`;
            // Deletions come from the FTB manifests. A `..` path would rm -r outside the instance tree.
            if (!resolve(fullPath).startsWith(root + sep)) {
                throw new Error(`manifest path ${path} points outside ${dir}`);
            }

            sessionLogger.debug('Merger', `Checking: ${fullPath}`);

            if (fs.existsSync(fullPath)) {
                await fs.rmSync(fullPath, {
                    recursive: true,
                    force: true
                });
                deletedCount++;
            } else {
                notFoundCount++;
                if (notFoundCount <= 3) {
                    sessionLogger.warn('Merger', `File not found: ${fullPath}`);
                }
            }
        }
        sessionLogger.info('Merger', `Removed ${deletedCount} old files, ${notFoundCount} files not found`);

        // Helper function to normalize paths (ensure trailing slash)
        const normalizePath = (path) => path.endsWith('/') ? path : path + '/';

        let toDownload = newManifest.files.filter(obj => {
            const fullPath = normalizePath(obj.path) + obj.name;
            return changeList.additions.includes(fullPath);
        });

        // Diagnostic logging for toDownload filtering
        sessionLogger.info('Merger', `Filtering ${newManifest.files.length} manifest files against ${changeList.additions.length} additions`);
        if (newManifest.files.length > 0) {
            const firstFile = newManifest.files[0];
            sessionLogger.info('Merger', `First manifest file path format (normalized): "${normalizePath(firstFile.path)}${firstFile.name}"`);
        }
        sessionLogger.info('Merger', `Filtered down to ${toDownload.length} files to download`);
        if (toDownload.length > 0) {
            sessionLogger.info('Merger', `First 3 files to download: ${JSON.stringify(toDownload.slice(0, 3).map(f => normalizePath(f.path) + f.name))}`);
        } else if (changeList.additions.length > 0) {
            sessionLogger.warn('Merger', `WARNING: toDownload is empty but changeList has ${changeList.additions.length} additions! First addition: ${changeList.additions[0]}`);
        }

        await fetchList(toDownload, dir);
        sessionLogger.info('Merger', "Added new files");

        for (const candidate of candidates) {
            const newPath = join(dir, candidate.rel);
            const oldPath = join(baseDir, candidate.rel);
            try {
                const outcome = textMerge.mergeBuffers(candidate.live, fs.readFileSync(oldPath), fs.readFileSync(newPath), candidate.rel);
                const content = recordOutcome(report, candidate.rel, outcome, candidate.live);
                if (content) fs.writeFileSync(newPath, content);
            } catch (error) {
                sessionLogger.warn('Merger', `Three-way ${candidate.rel} failed, taking the pack's file: ${error.message}`);
                report.overwritten.push(candidate.rel);
            }
        }
        if (candidates.length > 0) fs.rmSync(baseDir, { recursive: true, force: true });
        return report;
    }
};