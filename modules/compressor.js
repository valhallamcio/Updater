/*
 * File: compressor.js
 * Project: Valhalla-Updater
 * File Created: Friday, 10th May 2024 9:43:10 pm
 * Author: flaasz
 * -----
 * Last Modified: Wednesday, 29th May 2024 12:43:23 am
 * Modified By: flaasz
 * -----
 * Copyright 2024 flaasz
 */

const yauzl = require('yauzl');
const archiver = require('archiver');
const ProgressBar = require('progress');
const sessionLogger = require('./sessionLogger');
const fs = require('fs');
const path = require('path');
const {
    pipeline
} = require('stream/promises');
const {
    calculateTotalSize
} = require('./functions');

// Server packs unpack to a few GB. A zip that claims more than this is a bomb.
const MAX_UNPACKED_BYTES = 32 * 1024 ** 3;

// Deflating these again costs CPU and saves nothing: jars and region files are already compressed.
const STORE_ONLY = /\.(jar|zip|gz|tgz|xz|zst|7z|png|jpe?g|ogg|mca)$/i;

// Never follow a link someone left where a file is about to be written.
const WRITE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0);

/**
 * Unix file type bits of a zip entry. 0 when the zip was made on a host that does not store them.
 * @param {yauzl.Entry} entry Zip entry.
 * @returns {number} The S_IFMT bits.
 */
function unixType(entry) {
    return (entry.externalFileAttributes >>> 16) & 0o170000;
}

module.exports = {

    /**
     * Unpacks a zip into a folder, one entry at a time, straight from disk.
     * Packs come from CurseForge, FTB and GitHub, so the zip is untrusted. yauzl rejects
     * absolute and `..` names and checks each entry's real size against its header.
     * On top of that: links and other special entries are skipped, every file is written
     * as a plain 0644 file, and a write never goes through a link or out of the folder.
     * @param {string} zipFilePath Path to the zip file to decompress.
     * @param {string} extractToPath Path to the extracted files.
     */
    decompress: async function (zipFilePath, extractToPath) {
        const root = path.resolve(extractToPath);
        await fs.promises.mkdir(root, {
            recursive: true
        });
        const realRoot = await fs.promises.realpath(root);

        const assertInside = async (dir) => {
            const real = await fs.promises.realpath(dir);
            if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
                throw new Error(`${dir} resolves outside ${root}`);
            }
        };

        const zip = await yauzl.openPromise(zipFilePath);
        const bar = new ProgressBar(`Extracting ${path.basename(zipFilePath)} [:bar] :current/:total :percent :etas`, {
            complete: '=',
            incomplete: ' ',
            width: 40,
            total: Math.max(zip.entryCount, 1)
        });
        const skipped = [];
        let declaredBytes = 0;

        const extractEntry = async (entry) => {
            const target = path.join(root, entry.fileName);
            if (entry.fileName.endsWith('/')) {
                await fs.promises.mkdir(target, {
                    recursive: true
                });
                await assertInside(target);
                return;
            }

            const type = unixType(entry);
            if (type !== 0 && type !== 0o100000) {
                skipped.push(entry.fileName);
                return;
            }

            declaredBytes += entry.uncompressedSize;
            if (declaredBytes > MAX_UNPACKED_BYTES) {
                throw new Error(`${path.basename(zipFilePath)} unpacks to more than ${MAX_UNPACKED_BYTES} bytes, refusing it`);
            }

            await fs.promises.mkdir(path.dirname(target), {
                recursive: true
            });
            await assertInside(path.dirname(target));
            await pipeline(
                await zip.openReadStreamPromise(entry),
                fs.createWriteStream(target, {
                    flags: WRITE_FLAGS,
                    mode: 0o644
                })
            );
        };

        try {
            await new Promise((resolve, reject) => {
                zip.on('error', reject);
                zip.on('end', resolve);
                zip.on('entry', (entry) => {
                    extractEntry(entry).then(() => {
                        bar.tick();
                        zip.readEntry();
                    }, reject);
                });
                zip.readEntry();
            });
        } finally {
            zip.close();
        }

        if (skipped.length > 0) {
            sessionLogger.warn('Compressor', `Skipped ${skipped.length} link or special entries in ${path.basename(zipFilePath)}: ${skipped.slice(0, 10).join(', ')}`);
        }
    },

    /**
     * Compresses content of the directory to a zip file.
     * @param {string} sourceDir Path to a directory to compress.
     * @param {string} outPath Path to the output zip file.
     * @returns
     */
    compressDirectory: function (sourceDir, outPath) {
        sessionLogger.info('Compressor', `Compressing ${sourceDir} to ${outPath}...`);
        const totalSize = calculateTotalSize(sourceDir);

        // Initialize progress bar
        const bar = new ProgressBar(`Compressing ${outPath} [:bar] :rate/bps :percent :etas`, {
            complete: '=',
            incomplete: ' ',
            width: 40,
            total: totalSize
        });
        return new Promise((resolve, reject) => {
            const output = fs.createWriteStream(outPath);
            // Level 9 took far longer than 6 for almost no smaller archive, and most bytes are STORE_ONLY anyway
            const archive = archiver('zip', {
                zlib: {
                    level: 6
                }
            });

            output.on('close', function () {
                bar.update(1);
                sessionLogger.info('Compressor', `${outPath} compression complete`);
                resolve();
            });

            archive.on('error', function (err) {
                reject(err);
            });

            // Without this the promise never settles when the destination is unwritable
            // (missing parent directory, disk full) and the whole update hangs silently
            output.on('error', function (err) {
                sessionLogger.error('Compressor', `Failed writing ${outPath}:`, err.message);
                reject(err);
            });

            archive.on('progress', function (progress) {
                bar.tick(progress.fs.processedBytes - bar.curr);
            });

            archive.pipe(output);

            archive.directory(sourceDir, false, entry => (STORE_ONLY.test(entry.name) ? {
                ...entry,
                store: true
            } : entry));

            archive.finalize();
        });
    }
};