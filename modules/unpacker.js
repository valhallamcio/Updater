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

const unpacker = require("unpacker-with-progress");
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
     * @param {string} zip Path to a tar.gz file.
     * @param {string} destinationPath Path to the destination folder.
     * @returns 
     */
    unpack: async function (zip, destinationPath) {
        const fileSize = fs.statSync(zip).size;
        const progressBar = new progress(`Unpacking ${path.basename(zip)} [:bar] :rate/bps :percent :etas`, {
            width: 40,
            complete: '=',
            incomplete: ' ',
            renderThrottle: 100,
            total: fileSize
        });
        return Promise.all([
            unpacker(zip, destinationPath, {
                onprogress(progress) {
                    progressBar.update(progress.percent);
                }
            })
        ]);
    },
};