/*
 * File: downloader.js
 * Project: Valhalla-Updater
 * File Created: Friday, 10th May 2024 10:32:29 pm
 * Author: flaasz
 * -----
 * Last Modified: Tuesday, 28th May 2024 10:19:05 pm
 * Modified By: flaasz
 * -----
 * Copyright 2024 flaasz
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const progress = require('progress');
const sessionLogger = require('./sessionLogger');


// Promisify pipeline for better error handling

module.exports = {
    /**
     * Downloads a file from the specified URL to the destination path.
     * @param {string} fileUrl URL of the file to be downloaded.
     * @param {string} destinationPath Path to save the downloaded file.
     */
    download: async function (fileUrl, destinationPath) {
        const fileName = path.basename(destinationPath);
        if (!fs.existsSync(path.dirname(destinationPath))) {
            fs.mkdirSync(path.dirname(destinationPath), {
                recursive: true
            });
        }
        const writer = fs.createWriteStream(destinationPath);
        const {
            data,
            headers
        } = await axios({
            url: fileUrl,
            method: 'GET',
            responseType: 'stream'
        });

        const totalLength = parseInt(headers['content-length'], 10);
        const progressBar = new progress(`Downloading ${fileName} [:bar] :rate/bps :percent :etas`, {
            width: 40,
            complete: '=',
            incomplete: ' ',
            renderThrottle: 100,
            total: totalLength
        });

        data.on('data', (chunk) => {
            progressBar.tick(chunk.length);
        });

        data.pipe(writer);

        // A half-written file is worse than none: it satisfies every exists/non-zero check
        // downstream, and for a vault archive that means a truncated backup being kept as
        // the rollback point while the good copy is diverted to scratch and later deleted.
        const discardPartial = () => {
            try {
                fs.rmSync(destinationPath, {
                    force: true
                });
            } catch (error) {
                sessionLogger.warn('Downloader', `Could not remove partial ${fileName}: ${error.message}`);
            }
        };

        try {
            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
                data.on('error', reject);
            });
        } catch (error) {
            discardPartial();
            throw error;
        }

        // A connection reset mid-transfer ends the stream cleanly, so 'finish' alone proves
        // nothing. Skipped when the length is unknown (chunked) or when the body was encoded
        // in transit, where the declared length is not what lands on disk.
        const written = fs.statSync(destinationPath).size;
        if (Number.isFinite(totalLength) && !headers['content-encoding'] && written !== totalLength) {
            discardPartial();
            throw new Error(`${fileName} is incomplete: got ${written} of ${totalLength} bytes`);
        }

        sessionLogger.info('Downloader', `${fileName} downloaded successfully`);
    },

    /**
     * Downloads a list of files to the specified destination folder.
     * @param {Array} list Array containing the objects of files to be downloaded.
     * @param {string} destinationFolder Path to save the downloaded files.
     */
    downloadList: async function (list, destinationFolder) {
        const progressBar = new progress(`Downloading list [:bar] :rate/bps :percent :etas`, {
            width: 40,
            complete: '=',
            incomplete: ' ',
            renderThrottle: 100,
            total: list.length
        });
    
        const downloadPromises = list.map(async (file) => {
            progressBar.tick(1);
    
            if (file.clientonly === true) return;
    
            let destinationPath = path.join(destinationFolder, file.path, file.name);
    
            if (!fs.existsSync(path.dirname(destinationPath))) {
                fs.mkdirSync(path.dirname(destinationPath), {
                    recursive: true
                });
            }
    
            if (!file.url) {
                file.url = `https://edge.forgecdn.net/files/${file.curseforge.file.toString().substring(0, 4)}/${file.curseforge.file.toString().substr(4, 7)}/${file.name}`;
            }
    
            const writer = fs.createWriteStream(destinationPath);
            const { data } = await axios({
                url: file.url,
                method: 'GET',
                responseType: 'stream'
            });
    
            data.pipe(writer);
    
            return new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });
        });
    
        // Wait for all downloads to complete
        await Promise.all(downloadPromises);
    
        sessionLogger.info('Downloader', `List downloaded successfully`);
    },

    /**
     * Uploads a file to the specified URL.
     * @param {string} file Path to the file to upload.
     * @param {string} uploadUrl URL to upload to.
     */
    upload: async function (file, uploadUrl) {
        const fileName = path.basename(file);
        const fileSize = fs.statSync(file).size;
        const fileStream = fs.createReadStream(file);

        const progressBar = new progress(`Uploading ${fileName} [:bar] :percent :etas`, {
            width: 40,
            complete: '=',
            incomplete: ' ',
            renderThrottle: 100,
            total: fileSize
        });

        const config = {
            onUploadProgress: (progressEvent) => {
                progressBar.tick(progressEvent.loaded);
            }
        };

        const formData = new FormData();
        formData.append('files', fileStream, fileName);

        try {
            await axios.post(uploadUrl, formData, {
                ...config,
                headers: {
                    ...formData.getHeaders()
                }
            });
            sessionLogger.info('Downloader', `${fileName} uploaded successfully`);
        } catch (error) {
            sessionLogger.error('Downloader', 'Error uploading file:', error);
        }
    }
};