#!/usr/bin/env node
/*
 * Builds a server pack zip from a CurseForge client pack. It runs the same code as an
 * update with a cf-client server pack source (modules/cfClientServerPack), so a first
 * live tree built here matches the reference packs that later updates build.
 *
 * Usage:
 *   node scripts/cf-client-serverpack.js <modpackId> <fileId> <out.zip> [--exclude a,b,...]
 *
 * --exclude takes CurseForge modIds and jar file name regexes (case-insensitive),
 * comma-separated. It may be given more than once. Use the same list as the pack's
 * serverPackSources entry in config/config.json.
 * CURSEFORGE_APIKEY comes from the repo's .env, as for the app. It is never printed.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ENV_PATH = path.join(__dirname, '..', '.env');
require('dotenv').config({ path: ENV_PATH });

const USAGE = 'usage: node scripts/cf-client-serverpack.js <modpackId> <fileId> <out.zip> [--exclude a,b,...]';

function fail(message, code = 2) {
    console.error(message);
    process.exit(code);
}

function parseArgs(argv) {
    const positional = [];
    const exclude = [];
    const addExclude = (value) => {
        if (value === undefined || value === '') fail(`--exclude needs a value\n${USAGE}`);
        exclude.push(...value.split(',').map(item => item.trim()).filter(Boolean));
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--exclude') addExclude(argv[++i]);
        else if (arg.startsWith('--exclude=')) addExclude(arg.slice('--exclude='.length));
        else if (arg.startsWith('--')) fail(`unknown option ${arg}\n${USAGE}`);
        else positional.push(arg);
    }
    if (positional.length !== 3) fail(USAGE);
    const [modpackId, fileId, out] = positional;
    if (!/^\d+$/.test(modpackId) || !/^\d+$/.test(fileId)) fail(`modpackId and fileId must be numbers\n${USAGE}`);
    return { modpackId: Number(modpackId), fileId: Number(fileId), out: path.resolve(out), exclude };
}

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!process.env.CURSEFORGE_APIKEY) fail(`CURSEFORGE_APIKEY is not set in ${ENV_PATH} or the environment`);
    const { build } = require('../modules/cfClientServerPack');

    const result = await build(args.modpackId, args.fileId, args.out, { exclude: args.exclude }, {
        log: line => console.error(`- ${line}`)
    });

    const lines = [];
    const loaders = (result.minecraft?.modLoaders || []).map(l => l.id).join(', ') || 'none named';
    lines.push(`Built ${result.zip} (${fs.statSync(result.zip).size} bytes, sha256 ${sha256(result.zip)})`);
    lines.push(`Minecraft ${result.minecraft?.version || '?'}, loader ${loaders}`);
    lines.push(`\nKept ${result.kept.length} mod file(s):`);
    for (const k of result.kept) lines.push(`  ${k.fileName}  (${k.name}, modId ${k.modId}, file ${k.fileId})`);
    lines.push(`\nSkipped ${result.skipped.length} manifest file(s):`);
    for (const s of result.skipped) lines.push(`  ${s.fileName}  (${s.name}, modId ${s.modId}, file ${s.fileId}): ${s.reasons.join('; ')}`);
    lines.push(`\nOverrides: ${result.overrides.keep.length} file(s) copied, ${result.overrides.skipped.length} skipped`);
    for (const s of result.overrides.skipped) lines.push(`  ${s.path}: ${s.reasons.join('; ')}`);
    if (result.unusedExclude.length > 0) lines.push(`\nExclude entries that matched nothing: ${result.unusedExclude.join(', ')}`);
    console.log(lines.join('\n'));
}

// The session logger keeps timers alive, so the script ends itself.
main().then(() => process.exit(0), (error) => fail(`build failed: ${error.message}`, 1));
