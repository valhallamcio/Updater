/*
 * File: textMerge.js
 * Project: valhalla-updater
 * -----
 * Line-level three-way merge for pack files that both the pack and the server changed.
 *
 * The file merge replaces a file the pack changed, so our live edits in it were lost.
 * For text files this applies the pack's old->new change onto the live file instead,
 * like `git merge-file`. A file that does not merge cleanly keeps the pack's new copy,
 * which is what the update did before, and gets listed as a conflict.
 *
 * node-diff3 does the region split. Lines are compared without their line ending and
 * trailing whitespace, so a CRLF checkout or a stray space is not an edit. The output
 * takes each line from the side the region came from.
 */

const fs = require('fs');
const path = require('path');
const {
    diff3MergeRegions
} = require('node-diff3');

// Config and script formats that packs ship and that we edit by hand
const TEXT_EXTENSIONS = new Set([
    '.toml', '.json', '.json5', '.jsonc', '.snbt', '.cfg', '.conf', '.ini', '.properties',
    '.yaml', '.yml', '.txt', '.js', '.zs', '.mcmeta', '.lang', '.csv', '.xml', '.md'
]);

// Larger files are generated data, not hand-edited config
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

const BOM = '\uFEFF';

/** @returns {boolean} Whether the path has an extension we merge as text. */
function isTextPath(relPath) {
    return TEXT_EXTENSIONS.has(path.extname(String(relPath)).toLowerCase());
}

/**
 * A buffer is text when it is small, has no NUL byte and is valid UTF-8. The last check
 * matters: decoding bad UTF-8 replaces bytes, and writing that back would corrupt the file.
 */
function isTextBuffer(buffer) {
    if (buffer.length > MAX_TEXT_BYTES || buffer.includes(0)) return false;
    return Buffer.from(buffer.toString('utf8'), 'utf8').equals(buffer);
}

function stripBom(text) {
    return text.startsWith(BOM) ? text.slice(1) : text;
}

function toLines(text) {
    return stripBom(text).replace(/\r\n?/g, '\n').split('\n');
}

function lineKey(line) {
    return line.replace(/[ \t]+$/, '');
}

/** Text with LF endings, no trailing whitespace and no trailing blank lines, for comparing. */
function normalise(text) {
    return toLines(text).map(lineKey).join('\n').replace(/\n+$/, '');
}

/** CRLF when most line breaks in the text are CRLF. */
function lineEnding(text) {
    const crlf = (text.match(/\r\n/g) || []).length;
    const lf = (text.match(/\n/g) || []).length;
    return crlf > 0 && crlf * 2 >= lf ? '\r\n' : '\n';
}

function sameKeys(left, right) {
    return left.length === right.length && left.every((line, i) => line === right[i]);
}

/**
 * Three-way merge of one text file.
 * @param {string} live The server's current file.
 * @param {string} old The file in the pack version the server runs.
 * @param {string} next The file in the new pack version.
 * @returns {{status: string, text?: string}} status is one of
 *   unedited - live equals old after normalising, so take the new file;
 *   same - live already equals the new file, so keep it;
 *   merged - text holds the merged file, in the new file's line ending style;
 *   conflict - both sides changed the same lines, so take the new file.
 */
function mergeText(live, old, next) {
    if (normalise(live) === normalise(old)) return { status: 'unedited' };
    if (normalise(live) === normalise(next)) return { status: 'same' };

    const sides = {
        a: toLines(live),
        o: toLines(old),
        b: toLines(next)
    };
    const regions = diff3MergeRegions(sides.a.map(lineKey), sides.o.map(lineKey), sides.b.map(lineKey));

    const out = [];
    for (const region of regions) {
        if (region.stable) {
            out.push(...sides[region.buffer].slice(region.bufferStart, region.bufferStart + region.bufferLength));
        } else if (sameKeys(region.aContent, region.bContent)) {
            // Both sides made the same change
            out.push(...sides.a.slice(region.aStart, region.aStart + region.aLength));
        } else {
            return { status: 'conflict' };
        }
    }

    const bom = next.startsWith(BOM) ? BOM : '';
    return {
        status: 'merged',
        text: bom + out.join(lineEnding(next))
    };
}

/**
 * Three-way merge of one file given as buffers.
 * @param {Buffer} live The server's current file.
 * @param {Buffer} old The file in the pack version the server runs.
 * @param {Buffer} next The file in the new pack version.
 * @param {string} relPath Path inside the pack, used for the extension check.
 * @returns {{status: string, content?: Buffer}} The mergeText statuses, plus
 *   binary - live differs from old but the file is not mergeable text, so take the new file.
 */
function mergeBuffers(live, old, next, relPath) {
    if (live.equals(old)) return { status: 'unedited' };
    if (live.equals(next)) return { status: 'same' };
    if (!isTextPath(relPath) || ![live, old, next].every(isTextBuffer)) return { status: 'binary' };

    const result = mergeText(live.toString('utf8'), old.toString('utf8'), next.toString('utf8'));
    if (result.status !== 'merged') return { status: result.status };
    return {
        status: 'merged',
        content: Buffer.from(result.text, 'utf8')
    };
}

/** Compares two files chunk by chunk, so a big jar is never read into memory whole. */
function filesEqual(first, second) {
    if (fs.statSync(first).size !== fs.statSync(second).size) return false;
    const size = 1024 * 1024;
    const left = Buffer.alloc(size);
    const right = Buffer.alloc(size);
    const fdLeft = fs.openSync(first, 'r');
    const fdRight = fs.openSync(second, 'r');
    try {
        for (;;) {
            const readLeft = fs.readSync(fdLeft, left, 0, size, null);
            const readRight = fs.readSync(fdRight, right, 0, size, null);
            if (readLeft !== readRight) return false;
            if (readLeft === 0) return true;
            if (!left.subarray(0, readLeft).equals(right.subarray(0, readRight))) return false;
        }
    } finally {
        fs.closeSync(fdLeft);
        fs.closeSync(fdRight);
    }
}

/** @returns {Object} An empty merge report: lists of pack-relative paths per outcome. */
function emptyReport() {
    return {
        merged: [],
        conflicts: [],
        overwritten: [],
        kept: []
    };
}

/**
 * Formats a merge report for the progress message.
 * @param {Object} report From emptyReport, filled by the merger.
 * @param {number} limit Paths listed per category. Conflicts get twice as many.
 * @returns {string} " Merge: ..." or "" when no file was edited on both sides.
 */
function formatReport(report, limit = 3) {
    if (!report) return "";
    const total = report.merged.length + report.conflicts.length + report.overwritten.length + report.kept.length;
    if (total === 0) return "";
    const list = (paths, max) => {
        if (paths.length === 0) return "";
        const shown = paths.slice(0, max).join(', ');
        return ` (${shown}${paths.length > max ? ` +${paths.length - max} more` : ""})`;
    };
    let out = ` Merge: merged ${report.merged.length}${list(report.merged, limit)}, conflicts ${report.conflicts.length}${list(report.conflicts, limit * 2)}`;
    if (report.overwritten.length > 0) out += `, overwritten ${report.overwritten.length}${list(report.overwritten, limit)}`;
    if (report.kept.length > 0) out += `, already up to date ${report.kept.length}`;
    return `${out}.`;
}

module.exports = {
    TEXT_EXTENSIONS,
    MAX_TEXT_BYTES,
    isTextPath,
    isTextBuffer,
    normalise,
    lineEnding,
    mergeText,
    mergeBuffers,
    filesEqual,
    emptyReport,
    formatReport
};
