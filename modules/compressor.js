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

const AdmZip = require('adm-zip');
const archiver = require('archiver');
const ProgressBar = require('progress');
const sessionLogger = require('./sessionLogger');
const fs = require('fs');
const path = require('path');
const {
    calculateTotalSize
} = require('./functions');


module.exports = {

    /**
     * Decompresses a zip file to the specified path.
     * @param {string} zipFilePath Path to the zip file to decompress.
     * @param {string} extractToPath Path to the extracted files.
     * @returns
     */
    decompress: async function (zipFilePath, extractToPath) {
        return new Promise((resolve, reject) => {
            const zip = new AdmZip(zipFilePath);
            const zipEntries = zip.getEntries();

            // Calculate total size of entries for progress bar
            let totalSize = 0;
            zipEntries.forEach(entry => {
                totalSize += entry.header.size;
            });

            // Initialize progress bar
            const bar = new ProgressBar(`Extracting ${zipFilePath.split("/").at(-1)} [:bar] :rate/bps :percent :etas`, {
                complete: '=',
                incomplete: ' ',
                width: 40,
                total: totalSize
            });

            // Extract entries
            zipEntries.forEach(entry => {
                // Extract entry
                zip.extractEntryTo(entry, extractToPath, true, true);

                // Update progress bar
                bar.tick(entry.header.size);
            });

            resolve();
        });
    },

    /**
     * Compresses a list of files to a zip file.
     * @param {Array} filesToCompress Array with files to compress.
     * @param {string} outputPath Path to the output zip file.
     * @returns
     */
    compressFile: async function (filesToCompress, outputPath) {
        return new Promise((resolve, reject) => {
            const zip = new AdmZip();

            // Add files to zip
            filesToCompress.forEach(file => {
                zip.addLocalFile(file);
            });

            // Initialize progress bar
            const totalSize = zip.toBuffer().length;
            const bar = new ProgressBar(`Compressing ${outputPath.split("/").at(-1)} [:bar] :rate/bps :percent :etas`, {
                complete: '=',
                incomplete: ' ',
                width: 40,
                total: totalSize
            });

            // Write zip to output path
            zip.writeZip(outputPath, () => {
                // Update progress bar
                bar.tick(totalSize);
                resolve();
            });
        });
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
            const archive = archiver('zip', {
                zlib: {
                    level: 9
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

            archive.directory(sourceDir, false);

            archive.finalize();
        });
    }
};