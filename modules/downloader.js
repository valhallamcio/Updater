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
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
    pipeline
} = require('stream/promises');
const FormData = require('form-data');
const progress = require('progress');
const sessionLogger = require('./sessionLogger');

// A stalled CDN connection must fail the run, not hang it. Idle time, not total time.
const IDLE_TIMEOUT_MS = 60000;

// Files fetched at once by downloadList. A big FTB update has hundreds of additions.
const LIST_CONCURRENCY = 8;

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
            responseType: 'stream',
            timeout: IDLE_TIMEOUT_MS
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
     * The list is an FTB manifest, so every entry is untrusted: its path must stay inside
     * the folder, its URL must be https, and its bytes must match the manifest's hash.
     * @param {Array} list Array containing the objects of files to be downloaded.
     * @param {string} destinationFolder Path to save the downloaded files.
     * @throws On the first file that fails; the rest are not started.
     */
    downloadList: async function (list, destinationFolder) {
        const root = path.resolve(destinationFolder);
        const queue = list.filter(file => file.clientonly !== true);
        const progressBar = new progress(`Downloading list [:bar] :current/:total :percent :etas`, {
            width: 40,
            complete: '=',
            incomplete: ' ',
            renderThrottle: 100,
            total: Math.max(queue.length, 1)
        });

        const fetchOne = async (file) => {
            const destinationPath = path.resolve(root, file.path, file.name);
            if (!destinationPath.startsWith(root + path.sep)) {
                throw new Error(`manifest entry ${file.path}/${file.name} points outside ${destinationFolder}`);
            }

            if (!file.url) {
                file.url = `https://edge.forgecdn.net/files/${file.curseforge.file.toString().substring(0, 4)}/${file.curseforge.file.toString().substr(4, 7)}/${file.name}`;
            }
            if (new URL(file.url).protocol !== 'https:') {
                throw new Error(`refusing a non-https download for ${file.name}: ${file.url}`);
            }

            const expected = file.hashes && file.hashes.sha256 ? ['sha256', file.hashes.sha256]
                : file.sha1 ? ['sha1', file.sha1] : null;
            const hash = expected ? crypto.createHash(expected[0]) : null;

            await fs.promises.mkdir(path.dirname(destinationPath), {
                recursive: true
            });
            const {
                data
            } = await axios({
                url: file.url,
                method: 'GET',
                responseType: 'stream',
                timeout: IDLE_TIMEOUT_MS
            });
            await pipeline(data, async function* (source) {
                for await (const chunk of source) {
                    if (hash) hash.update(chunk);
                    yield chunk;
                }
            }, fs.createWriteStream(destinationPath));

            if (hash && hash.digest('hex') !== String(expected[1]).toLowerCase()) {
                fs.rmSync(destinationPath, {
                    force: true
                });
                throw new Error(`${file.name} does not match its ${expected[0]} from the manifest`);
            }
            progressBar.tick();
        };

        let failed = false;
        const worker = async () => {
            while (!failed && queue.length > 0) {
                try {
                    await fetchOne(queue.shift());
                } catch (error) {
                    failed = true;
                    throw error;
                }
            }
        };
        await Promise.all(Array.from({
            length: Math.min(LIST_CONCURRENCY, queue.length)
        }, worker));

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