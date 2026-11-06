/*
 * File: githubServerPack.js
 * Project: valhalla-updater
 * -----
 * Server packs from GitHub releases, for CurseForge packs whose author ships no
 * CurseForge server pack. The release is looked up by the exact version of the
 * CurseForge file. A missing release or asset is an error, never a nearby version.
 */

const axios = require('axios');

const HEADERS = {
    'User-Agent': 'Valhalla-Updater',
    'Accept': 'application/vnd.github+json'
};

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// x.y.z with an optional suffix that starts with a letter (0.5.6-beta, 1.0.0-rc.2).
// The suffix must start with a letter, so "1.20.1-0.13.15" yields two versions.
// A fourth part (1.2.3.4) matches nothing.
const VERSION_PATTERN = /(?<![\d.])\d+\.\d+\.\d+(?!\.?\d)(?:-[A-Za-z][0-9A-Za-z]*(?:\.\d+)*)?/g;

/**
 * Reads the source for a pack: the server doc field first, then the
 * `serverPackSources` map keyed by tag in config.json.
 * @param {object} pack Server doc.
 * @param {object} [config] Parsed config.json. Defaults to the real one.
 * @returns {object|null} The raw source, or null when the pack has none.
 */
function sourceFor(pack, config) {
    if (pack.serverPackSource) return pack.serverPackSource;
    if (!config) {
        try {
            config = require('../config/config.json');
        } catch (error) {
            // config.json is generated on first run. No map means no source.
            return null;
        }
    }
    return config.serverPackSources?.[pack.tag] || null;
}

/**
 * Checks a source and compiles its asset pattern.
 * @param {object} source {type: "github", repo: "owner/name", asset: "regex"}.
 * @returns {{repo: string, asset: RegExp}}
 * @throws If a field is missing or invalid.
 */
function parseSource(source) {
    if (!source || source.type !== 'github') {
        throw new Error(`server pack source type must be "github", got ${JSON.stringify(source?.type)}`);
    }
    if (typeof source.repo !== 'string' || !REPO_PATTERN.test(source.repo)) {
        throw new Error(`server pack source repo must be "owner/name", got ${JSON.stringify(source.repo)}`);
    }
    if (typeof source.asset !== 'string' || source.asset === '') {
        throw new Error('server pack source has no asset pattern');
    }
    let asset;
    try {
        asset = new RegExp(source.asset);
    } catch (error) {
        throw new Error(`server pack source asset pattern is not a valid regex: ${error.message}`);
    }
    return { repo: source.repo, asset };
}

/**
 * Takes the last x.y.z[-suffix] out of a name.
 * @param {string} name A CurseForge displayName or fileName.
 * @returns {string|null} The version, or null when the name has none.
 */
function versionFromName(name) {
    if (typeof name !== 'string') return null;
    const matches = name.match(VERSION_PATTERN);
    return matches ? matches[matches.length - 1] : null;
}

/**
 * The version of a CurseForge file. The displayName comes first: TFG's fileName
 * carries a "-curseforge" suffix that is not part of the release tag.
 * @param {object} file CurseForge file data.
 * @returns {string|null}
 */
function versionOfFile(file) {
    if (!file) return null;
    return versionFromName(file.displayName) || versionFromName(file.fileName);
}

/**
 * Picks the one asset whose name matches the pattern.
 * @param {object} release Raw GitHub release.
 * @param {RegExp} pattern Asset name pattern.
 * @returns {object} The raw asset.
 * @throws If no asset or more than one asset matches.
 */
function pickAsset(release, pattern) {
    const matches = (release.assets || []).filter(a => typeof a.name === 'string' && pattern.test(a.name) && a.browser_download_url);
    if (matches.length === 0) {
        throw new Error(`GitHub release ${release.tag_name} has no asset matching /${pattern.source}/`);
    }
    if (matches.length > 1) {
        throw new Error(`GitHub release ${release.tag_name} has ${matches.length} assets matching /${pattern.source}/ (${matches.map(a => a.name).join(', ')})`);
    }
    return matches[0];
}

/**
 * Fetches the release tagged with the version, or with v<version>.
 * @param {string} repo "owner/name".
 * @param {string} version Exact version.
 * @param {object} [http] axios-like client.
 * @returns {Promise<object>} The raw release.
 * @throws If neither tag exists or GitHub fails.
 */
async function findRelease(repo, version, http = axios) {
    const tags = [version, `v${version}`];
    for (const tag of tags) {
        try {
            const response = await http.get(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
                headers: HEADERS
            });
            const release = response.data;
            if (release && !release.draft && release.tag_name === tag) return release;
        } catch (error) {
            if (error.response?.status === 404) continue;
            throw new Error(`GitHub lookup of ${repo} release ${tag} failed (${error.response?.status || error.message})`);
        }
    }
    throw new Error(`GitHub repo ${repo} has no release tagged ${tags.join(' or ')}`);
}

/**
 * Finds the server pack asset for one exact version.
 * @param {object} source Raw source (see parseSource).
 * @param {string} version Exact version from the CurseForge file.
 * @param {object} [http] axios-like client.
 * @returns {Promise<{tag: string, name: string, url: string, size: number}>}
 * @throws If the source is invalid, or the release or asset is missing.
 */
async function resolve(source, version, http = axios) {
    const { repo, asset } = parseSource(source);
    const release = await findRelease(repo, version, http);
    const picked = pickAsset(release, asset);
    return {
        tag: release.tag_name,
        name: picked.name,
        url: picked.browser_download_url,
        size: picked.size
    };
}

module.exports = {
    sourceFor,
    parseSource,
    versionFromName,
    versionOfFile,
    pickAsset,
    findRelease,
    resolve
};
