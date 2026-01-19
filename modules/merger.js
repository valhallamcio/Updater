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
    downloadList
} = require('./downloader');
const sessionLogger = require('./sessionLogger');

module.exports = {
    /**
     * Merges the changes from the changeList to the temp directory.
     * @param {String} dir Work directory to merge changes to.
     * @param {Object} changeList ChangeList object containing the changes.
     */
    merge: function (dir, changeList) {
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
    },

    /**
     * Merges the changes from the changeList to the temp directory.
     * @param {string} dir The directory to merge the changes to.
     * @param {object} changeList Object containing the changes.
     * @param {object} newManifest Object containing the new manifest.
     */
    mergeFromManifest: async function (dir, changeList, newManifest) {
        // Diagnostic logging for deletions
        sessionLogger.info('Merger', `Attempting to delete ${changeList.deletions.length} files`);
        if (changeList.deletions.length > 0) {
            sessionLogger.info('Merger', `First 3 deletion paths: ${JSON.stringify(changeList.deletions.slice(0, 3))}`);
        }

        let deletedCount = 0;
        let notFoundCount = 0;
        for (let path of changeList.deletions) {
            // Strip leading ./ from path before concatenating
            const relativePath = path.startsWith('./') ? path.substring(2) : path;
            const fullPath = `${dir}/${relativePath}`;

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

        await downloadList(toDownload, dir);
        sessionLogger.info('Merger', "Added new files");
    }
};