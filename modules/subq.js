/*
 * File: subq.js
 * Project: valhalla-updater
 * -----
 * SubQ decision API client (https://docs.subq.ai). One call: POST /v1/systemone with a body
 * the caller builds. The key comes from the caller (SUBQ_API_KEY in .env).
 *
 * Every failure is thrown as a new plain Error with the status or the network code. An axios
 * error carries the request headers, so it never leaves this file and the key cannot reach
 * a log.
 */

const axios = require('axios');

const ENDPOINT = 'https://api.subq.ai/v1/systemone';
// SubQ takes a body of up to 13 MiB.
const MAX_BODY = 13 * 1024 * 1024;

/**
 * @param {object} options
 * @param {string} options.apiKey The SubQ API key.
 * @param {number} [options.timeoutMs] Per request. Default 15 s.
 * @param {object} [options.http] An axios-like client. Only tests pass one.
 * @returns {{decide: function(object): Promise<object>}}
 */
function createClient({ apiKey, timeoutMs = 15000, http = axios }) {
    return {
        /**
         * @param {object} body The request body.
         * @returns {Promise<object>} The response body.
         * @throws {Error} With "status" set on an HTTP error, "code" on a network error or timeout.
         */
        decide: async function (body) {
            let response;
            try {
                response = await http.post(ENDPOINT, body, {
                    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
                    timeout: timeoutMs,
                    maxBodyLength: MAX_BODY,
                    validateStatus: () => true
                });
            } catch (error) {
                const failure = new Error('SubQ request failed: ' + (error.code === 'ECONNABORTED' ? 'timed out after ' + timeoutMs + ' ms' : error.code || error.message));
                failure.code = error.code || 'ENETWORK';
                throw failure;
            }
            if (response.status < 200 || response.status >= 300) {
                const detail = response.data && response.data.detail;
                const failure = new Error('SubQ answered ' + response.status + (detail && detail.message ? ': ' + String(detail.message).slice(0, 200) : ''));
                failure.status = response.status;
                throw failure;
            }
            return response.data;
        }
    };
}

module.exports = { ENDPOINT, createClient };
