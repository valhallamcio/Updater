/*
 * File: unpacker.js
 * Project: Valhalla-Updater
 * File Created: Sunday, 12th May 2024 1:50:29 am
 * Author: flaasz
 * -----
 * Last Modified: Wednesday, 29th May 2024 12:25:52 am
 * Modified By: flaasz
 * -----
 * Copyright 2024 flaasz
 */

const tar = require('tar');
const progress = require('progress');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const {
    Writable
} = require('stream');
const {
    pipeline
} = require('stream/promises');
const sessionLogger = require('./sessionLogger');

module.exports = {

    /**
     * Reads a .tar.gz end to end to prove it is complete.
     *
     * Size checks cannot tell a truncated archive from a small one, and the only other
     * thing that finds out is the unpack itself - by which point /restore has already
     * wiped the instance. Costs a full read of the file and no disk.
     * @param {string} archivePath Path to the archive.
     * @returns {boolean} Whether the whole gzip stream decompresses.
     */
    verify: async function (archivePath) {
        try {
            await pipeline(
                fs.createReadStream(archivePath),
                zlib.createGunzip(),
                new Writable({
                    write(chunk, encoding, callback) {
                        callback();
                    }
                })
            );
            return true;
        } catch (error) {
            sessionLogger.warn('Unpacker', `${archivePath} did not decompress cleanly: ${error.message}`);
            return false;
        }
    },

    /**
     * Unpacks a tar.gz file into the specified destination path.
     * Only plain files and folders come out. A backup holds whatever a panel user or a mod
     * wrote on the server, and a link in it would make the merge read or write outside the
     * tree (a link to the bot's .env would be uploaded back to the server). Setuid, setgid
     * and sticky bits are dropped. strict turns every tar warning into an error, so a bad
     * archive aborts here, before the deploy wipes anything.
     * @param {string} archive Path to a tar.gz file.
     * @param {string} destinationPath Path to the destination folder.
     */
    unpack: async function (archive, destinationPath) {
        await fs.promises.mkdir(destinationPath, {
            recursive: true
        });
        const progressBar = new progress(`Unpacking ${path.basename(archive)} [:bar] :rate/bps :percent :etas`, {
            width: 40,
            complete: '=',
            incomplete: ' ',
            renderThrottle: 100,
            total: fs.statSync(archive).size
        });
        const skipped = [];

        await new Promise((resolve, reject) => {
            const input = fs.createReadStream(archive);
            const extract = tar.x({
                cwd: destinationPath,
                strict: true,
                filter: (entryPath, entry) => {
                    if (!['File', 'OldFile', 'ContiguousFile', 'Directory'].includes(entry.type)) {
                        skipped.push(entryPath);
                        return false;
                    }
                    if (typeof entry.mode === 'number') entry.mode &= 0o777;
                    return true;
                }
            });
            input.on('data', chunk => progressBar.tick(chunk.length));
            input.on('error', reject);
            extract.on('error', reject);
            extract.on('close', resolve);
            input.pipe(extract);
        });

        if (skipped.length > 0) {
            sessionLogger.warn('Unpacker', `Skipped ${skipped.length} link or special entries in ${path.basename(archive)}: ${skipped.slice(0, 10).join(', ')}`);
        }
    },
};