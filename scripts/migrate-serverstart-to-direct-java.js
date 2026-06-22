/**
 * migrate-serverstart-to-direct-java.js
 *
 * One-off ops tool. Some 1.12.2 servers launch via `./ServerStart.sh` (the Cleanroom/AllTheMods
 * ServerStarter wrapper). That wrapper runs the MC server inside a bash auto-restart loop and never
 * exits on stop, so Pterodactyl never reports `offline` — every VU reboot of those servers times
 * out (60s) and falls through to a hard kill, and status/uptime/crash-detection are all wrong.
 *
 * Fix: set the server's Startup Command to launch java DIRECTLY (so java is the watched process and
 * `stop` -> offline works). We don't invent the command — we reuse the EXACT one the wrapper itself
 * already runs successfully, read from each server's /logs/serverstart.log ("Attempting to execute
 * [ ... ]"), with the jar path made relative.
 *
 * SAFE BY DEFAULT: dry-run unless --apply is passed. Only touches servers whose startup command is
 * exactly `./ServerStart.sh` AND whose settings.cfg MC_VER is 1.12.2 AND whose derived java command
 * passes sanity checks (starts with java, has -jar <jar> nogui, and that jar actually exists in the
 * server root). The previous startup + environment of every changed server is written to a backup
 * JSON so the change is reversible.
 *
 * Usage:
 *   node scripts/migrate-serverstart-to-direct-java.js                 # dry run, list the plan
 *   node scripts/migrate-serverstart-to-direct-java.js --only 580feb79 # dry run, one server
 *   node scripts/migrate-serverstart-to-direct-java.js --apply         # apply to all eligible
 *   node scripts/migrate-serverstart-to-direct-java.js --apply --only 580feb79  # apply to one
 *
 * Tradeoff once migrated: the wrapper no longer auto-updates Cleanroom, so when the loader is bumped
 * the jar name in the startup command must be updated (or keep a stable jar name). Pterodactyl's own
 * crash-detection replaces the wrapper's crash-restart loop.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const HOST = require('../config/config.json').pterodactyl.pterodactylHostName;
const KEY = process.env.PTERODACTYL_APIKEY;
const HDR = { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` };

const APPLY = process.argv.includes('--apply');
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? process.argv[i + 1] : null; })();

const req = (method, url, data) => axios({
    method, url, data, headers: HDR, timeout: 25000, validateStatus: s => s < 600,
    // serverstart.log / settings.cfg come back as text; everything else is JSON
    transformResponse: [d => { try { return JSON.parse(d); } catch { return d; } }],
});

async function listAllServers() {
    const out = [];
    let page = 1;
    for (;;) {
        const r = await req('GET', `${HOST}api/application/servers?per_page=100&page=${page}`);
        if (r.status !== 200) throw new Error(`list servers failed: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
        out.push(...r.data.data);
        const p = r.data.meta.pagination;
        if (p.current_page >= p.total_pages) break;
        page++;
    }
    return out;
}

const fileContents = async (id, file) =>
    req('GET', `${HOST}api/client/servers/${id}/files/contents?file=${encodeURIComponent(file)}`);

async function rootFileNames(id) {
    const r = await req('GET', `${HOST}api/client/servers/${id}/files/list?directory=%2F`);
    if (r.status !== 200 || !r.data?.data) return [];
    return r.data.data.map(x => x.attributes.name);
}

/** Build the direct java startup from the wrapper's own logged command; returns {startup, jar} or null. */
function deriveStartup(serverstartLog) {
    if (typeof serverstartLog !== 'string') return null;
    const m = [...serverstartLog.matchAll(/Attempting to execute \[ (.+?) \]/g)];
    if (!m.length) return null;
    let cmd = m[m.length - 1][1].trim();
    const jarMatch = cmd.match(/-jar\s+(\S+)/);
    if (!jarMatch) return null;
    const jar = jarMatch[1].split('/').pop();          // basename -> relative
    cmd = cmd.replace(/-jar\s+\S+/, `-jar ${jar}`);    // make jar path relative to /home/container
    return { startup: cmd, jar };
}

/** Egg variable values as the {ENV: value} map the startup PATCH requires. */
async function buildEnvironment(internalId) {
    const r = await req('GET', `${HOST}api/application/servers/${internalId}?include=variables`);
    if (r.status !== 200) throw new Error(`get server ${internalId} failed: ${r.status}`);
    const a = r.data.attributes;
    const vars = a.relationships?.variables?.data || [];
    const env = {};
    for (const v of vars) {
        const va = v.attributes;
        env[va.env_variable] = va.server_value != null ? va.server_value : va.default_value;
    }
    return { env, egg: a.egg, image: a.container.image };
}

async function main() {
    if (!KEY) throw new Error('PTERODACTYL_APIKEY not set');
    console.log(`Mode: ${APPLY ? 'APPLY (will modify startup commands)' : 'DRY RUN (no changes)'}${ONLY ? ` | only ${ONLY}` : ''}\n`);

    const all = await listAllServers();
    let targets = all.filter(s => (s.attributes.container?.startup_command || '').trim() === './ServerStart.sh');
    if (ONLY) targets = targets.filter(s => s.attributes.identifier === ONLY);

    const changes = [];
    const skipped = [];

    for (const s of targets) {
        const a = s.attributes;
        const tag = `${a.identifier} (${a.name.slice(0, 40)})`;

        const settings = await fileContents(a.identifier, '/settings.cfg');
        const mcVer = typeof settings.data === 'string' ? (settings.data.match(/MC_VER=(\S+)/) || [])[1] : null;
        if (mcVer !== '1.12.2') { skipped.push(`${tag}: MC_VER=${mcVer} (not 1.12.2)`); continue; }

        // Only migrate a RUNNING server: then the logged "Attempting to execute" command is known to
        // work in the current container/java right now. A stopped server could have a stale log that
        // no longer matches an upgraded image -> skip and handle manually.
        const res = await req('GET', `${HOST}api/client/servers/${a.identifier}/resources`);
        const state = res.data?.attributes?.current_state;
        if (state !== 'running') { skipped.push(`${tag}: current_state=${state} (not running)`); continue; }

        const log = await fileContents(a.identifier, '/logs/serverstart.log');
        const derived = deriveStartup(log.data);
        if (!derived) { skipped.push(`${tag}: no "Attempting to execute" line in serverstart.log`); continue; }

        // sanity: a 1.12.2 java launch
        if (!/^java\s/.test(derived.startup) || !/ -jar \S+\.jar /.test(derived.startup) || !/\bnogui\b/.test(derived.startup)) {
            skipped.push(`${tag}: derived command failed sanity check -> ${derived.startup.slice(0, 80)}`); continue;
        }
        // sanity: the jar must actually exist in the server root
        const files = await rootFileNames(a.identifier);
        if (!files.includes(derived.jar)) { skipped.push(`${tag}: jar "${derived.jar}" not found in server root`); continue; }

        const build = await buildEnvironment(a.id);
        changes.push({ id: a.id, identifier: a.identifier, name: a.name, oldStartup: a.container.startup_command, ...derived, ...build });
    }

    console.log(`Eligible to change: ${changes.length} | skipped: ${skipped.length}\n`);
    for (const c of changes) {
        console.log(`• ${c.identifier}  ${c.name.slice(0, 45)}`);
        console.log(`    OLD: ${c.oldStartup}`);
        console.log(`    NEW: ${c.startup}\n`);
    }
    if (skipped.length) { console.log('Skipped:'); for (const s of skipped) console.log(`  - ${s}`); console.log(); }

    if (!APPLY) { console.log('Dry run only. Re-run with --apply to write these startup commands.'); return; }
    if (!changes.length) { console.log('Nothing to apply.'); return; }

    // Backup before mutating, so every change is reversible.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(__dirname, `serverstart-migration-backup-${stamp}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(changes.map(c => ({
        id: c.id, identifier: c.identifier, name: c.name, oldStartup: c.oldStartup, newStartup: c.startup, egg: c.egg, image: c.image, environment: c.env,
    })), null, 2));
    console.log(`Backup written: ${backupPath}\n`);

    for (const c of changes) {
        const body = { startup: c.startup, environment: c.env, egg: c.egg, image: c.image, skip_scripts: true };
        const r = await req('PATCH', `${HOST}api/application/servers/${c.id}/startup`, body);
        if (r.status === 200) {
            const now = (r.data?.attributes?.container?.startup_command || '').slice(0, 60);
            console.log(`✓ ${c.identifier} updated -> ${now}...`);
        } else {
            console.log(`✗ ${c.identifier} FAILED ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
        }
    }
    console.log('\nDone. Change takes effect on each server\'s next start/restart (not applied live).');
}

main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
