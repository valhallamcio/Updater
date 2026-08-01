/*
 * File: perInstanceFiles.js
 * Project: valhalla-updater
 * -----
 * Files that legitimately differ between instances sharing a pack tag, and the
 * helpers used to carry them across an update.
 *
 * Instances are merged from their OWN files (see updateManager), so per-instance
 * state survives on its own - nothing here needs to enumerate it. This list only
 * covers the narrower case where the MODPACK ITSELF ships a changed copy of one of
 * these files: the merge would then hand every instance the pack's version and
 * quietly give them the same ports / backup destination / metrics port.
 */

const fs = require('fs');
const path = require('path');
const comparator = require('./comparator');
const sessionLogger = require('./sessionLogger');

// Confirmed to differ across every multi-instance pack on the network (il2, pri, mg2).
const DEFAULTS = [
    'server.properties', // server-port, query.port, max-tick-time
    'config/AdvancedBackups.properties', // backup destination + schedule - shared paths corrupt the incremental chain
    'config/prometheus_exporter-server.toml' // listen_port - a shared port means one JVM fails to bind
];

module.exports = {
    DEFAULTS,

    /**
     * Files to force-protect for a pack tag. Optional per-tag overrides live under
     * `multiInstance.protectedFiles` in config.json; an absent key means the defaults.
     * @param {string} tag Pack tag (e.g. "il2").
     * @param {Array} extra Additional platform-specific paths (e.g. GTO's config/gtocore.yaml).
     * @returns {Array} Relative paths, de-duplicated.
     */
    forTag: function (tag, extra = []) {
        let overrides = [];
        try {
            const config = require('../config/config.json');
            overrides = config.multiInstance?.protectedFiles?.[tag] || [];
        } catch (error) {
            // config.json is generated on first run - defaults are fine until it exists
        }
        return [...new Set([...DEFAULTS, ...extra, ...overrides])];
    },

    /**
     * Reads the protected files out of an unpacked instance tree, before the pack merge
     * runs over it. Missing files are skipped - not every pack ships all of them.
     * @param {string} dir Path to the instance's unpacked files.
     * @param {Array} files Relative paths to read.
     * @returns {Object} Map of relative path -> Buffer.
     */
    stashProtected: function (dir, files) {
        const stash = {};
        for (const file of files) {
            const full = path.join(dir, file);
            if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
            stash[file] = fs.readFileSync(full);
        }
        return stash;
    },

    /**
     * Lists every file under a directory as a path relative to it, so a snapshot folder
     * can be fed straight back into stashProtected.
     * @param {string} dir Directory to walk.
     * @returns {Array} Relative paths, or [] if the directory does not exist.
     */
    listRelativeFiles: function (dir) {
        if (!fs.existsSync(dir)) return [];
        const walk = (current) => fs.readdirSync(current, {
            withFileTypes: true
        }).flatMap(entry => {
            const full = path.join(current, entry.name);
            return entry.isDirectory() ? walk(full) : [path.relative(dir, full).replace(/\\/g, '/')];
        });
        return walk(dir);
    },

    /**
     * Writes stashed files back over a merged tree, so the deployed archive already
     * carries this instance's identity. Done before upload rather than after deploy:
     * a post-deploy write can fail and strand the instance on another one's settings.
     * @param {string} dir Path to the merged instance tree.
     * @param {Object} stash Map of relative path -> Buffer, from stashProtected.
     * @returns {Array} Relative paths that were actually restored.
     */
    applyProtectedOverlay: function (dir, stash) {
        const restored = [];
        for (const [file, content] of Object.entries(stash)) {
            const full = path.join(dir, file);
            fs.mkdirSync(path.dirname(full), {
                recursive: true
            });
            fs.writeFileSync(full, content);
            restored.push(file);
        }
        return restored;
    },

    /**
     * Diffs the file manifests of every instance against the first one, to surface what
     * actually differs between them. Content-hashed, not size-compared: the ports in
     * server.properties and prometheus_exporter-server.toml differ at identical byte length.
     * Purely informational - the per-instance merge already preserves all of it.
     *
     * The order is passed in rather than taken from Object.keys: an all-digit Pterodactyl
     * id like "29494616" is treated as an array index and would jump ahead of "0ae41dd1",
     * silently making a different instance the baseline.
     * @param {Object} manifests Map of serverId -> manifest array (from modules/manifest).
     * @param {Array} order Server ids, first one is the baseline. Defaults to insertion order.
     * @returns {Array} One {serverId, baseId, onlyHere, onlyThere, different} entry per compared instance.
     */
    diffInstanceManifests: async function (manifests, order = null) {
        const ids = (order || Object.keys(manifests)).filter(id => manifests[id]);
        if (ids.length < 2) return [];

        const [baseId, ...others] = ids;
        const report = [];
        for (const id of others) {
            const diff = await comparator.compareManifest(manifests[baseId], manifests[id]);
            const name = entry => `${entry.path}${entry.name}`.replace(/^\.\//, '');
            report.push({
                serverId: id,
                baseId,
                onlyHere: diff.leftOnly.map(name).sort(),
                onlyThere: diff.rightOnly.map(name).sort(),
                different: diff.different.map(d => name(d.left)).sort()
            });
        }
        return report;
    },

    /**
     * Formats diffInstanceManifests output for a Discord progress message, capped so a
     * pack with thousands of drifted files cannot blow the message limit.
     * @param {Array} report Output of diffInstanceManifests.
     * @param {number} limit Max paths to list per category.
     * @returns {string} Markdown summary, or "" when there is nothing to report.
     */
    formatInstanceDiff: function (report, limit = 8) {
        if (report.length === 0) return "";

        let out = "";
        for (const entry of report) {
            const total = entry.onlyHere.length + entry.onlyThere.length + entry.different.length;
            out += `\n- \`${entry.serverId}\` vs \`${entry.baseId}\`: ${total} instance-specific file(s)`;
            const section = (label, list) => {
                if (list.length === 0) return "";
                const shown = list.slice(0, limit).map(f => `\n   - ${f}`).join("");
                return `\n  ${label} (${list.length}):${shown}${list.length > limit ? `\n   - ...and ${list.length - limit} more` : ""}`;
            };
            out += section("different content", entry.different);
            out += section(`only on ${entry.baseId}`, entry.onlyHere);
            out += section(`only on ${entry.serverId}`, entry.onlyThere);
        }
        sessionLogger.info('PerInstanceFiles', `Cross-instance diff: ${JSON.stringify(report)}`);
        return out;
    }
};
