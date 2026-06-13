/*
 * rebootAlerts.js
 *
 * Pure, version-aware builder for reboot player-alert console commands.
 *
 * Players miss `say` chat (scrolled, hidden, or — on 1.7.10 — not where they look),
 * so the reboot warning is sent as a *mix* of console commands chosen for the target
 * server's Minecraft version: title / subtitle / actionbar / bossbar / playsound / tellraw,
 * with a minimal `say` kept as a fallback. The backend MC server runs these against `@a`.
 *
 * Capability + syntax boundaries (verified against MC command history / Minecraft Wiki):
 *   - /title <player> title|subtitle|times  : added 1.8  (no title at all on 1.7.x)
 *   - /title <player> actionbar              : added 1.11
 *   - /bossbar ...                           : added 1.13
 *   - /playsound <sound> <source> <targets>  : <source> category required from 1.9
 *                                              (1.7-1.8: /playsound <sound> <player> ...)
 *   - /tellraw <player> <json>               : added 1.7.2 (works everywhere we target)
 *   - sound name eras: 1.7-1.8 `note.pling`; 1.9-1.12 `block.note.pling`
 *                      (1.9 "sounds overhaul"); 1.13+ `block.note_block.pling` ("Flattening").
 *
 * Everything here is pure (string in -> string[] out) so it is unit-tested without a server.
 *
 * NOTE on `@a` for legacy /playsound: 1.7.x resolves the playsound target with a singular
 * selector, so `@a` may only reach one player on true-vanilla 1.7. Sound is a secondary cue
 * on legacy; the tellraw chat line (which fans out to all players) is the reliable channel.
 */

const BOSSBAR_ID = 'minecraft:reboot';

// Keyed by sound era. Names chosen to exist (under that era's name) on every version in the era.
const DEFAULT_SOUNDS = {
    pre19: { notify: 'note.pling', urgent: 'mob.wither.spawn' },
    s19: { notify: 'block.note.pling', urgent: 'entity.wither.spawn' },
    s13: { notify: 'block.note_block.pling', urgent: 'entity.wither.spawn' },
};

/**
 * Parse a Minecraft version string ("1.7.10", "1.12", "1.20.1") into parts.
 * @returns {{major:number,minor:number,patch:number}|null} null if unparseable.
 */
function parseMcVersion(v) {
    if (typeof v !== 'string') return null;
    const m = v.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
    if (!m) return null;
    return { major: Number(m[1]), minor: Number(m[2]), patch: m[3] ? Number(m[3]) : 0 };
}

/**
 * Derive the per-version capabilities and sound era from a version string.
 */
function caps(version) {
    const p = parseMcVersion(version);
    if (!p || p.major !== 1) return { known: false };
    const minor = p.minor;
    return {
        known: true,
        minor,
        hasTitle: minor >= 8,
        hasActionbar: minor >= 11,
        hasBossbar: minor >= 13,
        playsoundSource: minor >= 9,
        soundEra: minor < 9 ? 'pre19' : (minor < 13 ? 's19' : 's13'),
    };
}

/**
 * Coarse capability tier, mostly for readability/tests.
 * @returns {'chatonly'|'legacy17'|'title18'|'actionbar11'|'modern13'}
 */
function tierFor(version) {
    const c = caps(version);
    if (!c.known) return 'chatonly';
    if (c.minor < 8) return 'legacy17';
    if (c.minor < 11) return 'title18';
    if (c.minor < 13) return 'actionbar11';
    return 'modern13';
}

// --- text components (named colors work on every version we target) ---

function comp(text, { color, bold, italic } = {}) {
    const o = { text: String(text) };
    if (color) o.color = color;
    if (bold) o.bold = true;
    if (italic) o.italic = true;
    return o;
}

const json = (c) => JSON.stringify(c);

// --- primitive command builders (return [] when the version can't do it) ---

function titleCmds(version, titleComp, subComp, times = {}) {
    if (!caps(version).hasTitle) return [];
    const { fadeIn = 10, stay = 70, fadeOut = 20 } = times;
    const out = [`title @a times ${fadeIn} ${stay} ${fadeOut}`];
    if (subComp) out.push(`title @a subtitle ${json(subComp)}`);
    out.push(`title @a title ${json(titleComp)}`); // title is set last — it triggers display
    return out;
}

function actionbarCmd(version, textComp) {
    if (!caps(version).hasActionbar) return [];
    return [`title @a actionbar ${json(textComp)}`];
}

// tellraw works on every targeted version (1.7.2+); fans out to all players.
function chatCmd(components) {
    return [`tellraw @a ${json(components)}`];
}

function sayCmd(text) {
    return [`say ${text}`];
}

function soundCmd(version, key, sounds) {
    const c = caps(version);
    if (!c.known) return [];
    const table = (sounds && sounds[c.soundEra]) || DEFAULT_SOUNDS[c.soundEra];
    const name = table[key] || table.notify;
    // 1.9+ requires the <source> category; 1.7-1.8 has no source argument.
    return c.playsoundSource ? [`playsound ${name} master @a`] : [`playsound ${name} @a`];
}

function buildBossbarSetup(version, maxSeconds, nameComp, id = BOSSBAR_ID) {
    if (!caps(version).hasBossbar) return [];
    return [
        `bossbar add ${id} ${json(nameComp || comp('Server restart', { color: 'red' }))}`,
        `bossbar set ${id} color red`,
        `bossbar set ${id} style notched_10`,
        `bossbar set ${id} max ${maxSeconds}`,
        `bossbar set ${id} value ${maxSeconds}`,
        `bossbar set ${id} players @a`,
        `bossbar set ${id} visible true`,
    ];
}

function buildBossbarTeardown(version, id = BOSSBAR_ID) {
    if (!caps(version).hasBossbar) return [];
    return [`bossbar remove ${id}`];
}

// --- humanize ---

function humanize(seconds) {
    if (seconds >= 60 && seconds % 60 === 0) {
        const m = seconds / 60;
        return `${m} minute${m === 1 ? '' : 's'}`;
    }
    return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

const isEnabled = (channels, key) => !channels || channels[key] !== false; // default: all on

// --- high-level composition (what the scheduler calls) ---

/**
 * Commands for a milestone announcement (e.g. "restart in 5 minutes").
 * @param {string} version  server.serverVersion
 * @param {number} seconds  seconds-before-reboot this milestone represents (for the label)
 * @param {object} opts     { channels, sounds, serverName }
 */
function buildMilestoneCommands(version, seconds, opts = {}) {
    const { channels, sounds, serverName } = opts;
    const c = caps(version);
    const human = humanize(seconds);
    const name = serverName || 'The server';
    const line = `${name} restarts in ${human}`;
    const cmds = [];

    if (isEnabled(channels, 'title') && c.hasTitle) {
        cmds.push(...titleCmds(
            version,
            comp(human, { color: 'red', bold: true }),
            comp('until restart', { color: 'gray' }),
            { fadeIn: 5, stay: 60, fadeOut: 10 },
        ));
    }
    if (isEnabled(channels, 'actionbar')) {
        cmds.push(...actionbarCmd(version, comp(line, { color: 'gold' })));
    }
    if (isEnabled(channels, 'chat')) {
        cmds.push(...chatCmd([
            comp('[!] ', { color: 'red', bold: true }),
            comp(`${line}. Find a safe spot.`, { color: 'yellow' }),
        ]));
    }
    if (isEnabled(channels, 'sound')) {
        cmds.push(...soundCmd(version, 'notify', sounds));
    }
    if (isEnabled(channels, 'say')) {
        cmds.push(...sayCmd(`Restart in ${human}.`));
    }
    return cmds;
}

/**
 * Commands for a single second of the final-minute countdown. The scheduler calls this
 * once per second; this decides what to render at that exact second.
 * @param {string} version
 * @param {number} secondsLeft
 * @param {object} opts { channels, sounds }
 */
function buildCountdownCommands(version, secondsLeft, opts = {}) {
    const { channels, sounds } = opts;
    const c = caps(version);
    const cmds = [];
    const tick10 = secondsLeft % 10 === 0;
    const finalFew = secondsLeft <= 5;

    if (isEnabled(channels, 'title') && c.hasTitle && (tick10 || finalFew)) {
        const color = finalFew ? 'red' : secondsLeft <= 10 ? 'gold' : 'yellow';
        cmds.push(...titleCmds(
            version,
            comp(String(secondsLeft), { color, bold: true }),
            comp('until restart', { color: 'gray' }),
            { fadeIn: 0, stay: 25, fadeOut: 5 },
        ));
    }
    if (isEnabled(channels, 'bossbar') && c.hasBossbar) {
        // value drains every second (cheap, 1 command); the name only refreshes on a
        // tick second to keep per-second send bursts small so the countdown stays on time.
        cmds.push(`bossbar set ${BOSSBAR_ID} value ${Math.max(0, secondsLeft)}`);
        if (tick10 || finalFew) {
            cmds.push(`bossbar set ${BOSSBAR_ID} name ${json(comp(`Restart in ${secondsLeft}s`, { color: 'red' }))}`);
        }
    }
    if (isEnabled(channels, 'sound') && (tick10 || finalFew)) {
        cmds.push(...soundCmd(version, finalFew ? 'urgent' : 'notify', sounds));
    }
    // Legacy / no-title clients get a sparse chat countdown so they still see the final seconds.
    if (isEnabled(channels, 'chat') && !c.hasTitle && (secondsLeft === 30 || secondsLeft === 10 || finalFew)) {
        cmds.push(...chatCmd([
            comp('[!] ', { color: 'red', bold: true }),
            comp(`Restart in ${secondsLeft}s`, { color: 'red' }),
        ]));
    }
    return cmds;
}

module.exports = {
    BOSSBAR_ID,
    DEFAULT_SOUNDS,
    parseMcVersion,
    caps,
    tierFor,
    humanize,
    buildMilestoneCommands,
    buildCountdownCommands,
    buildBossbarSetup,
    buildBossbarTeardown,
    // primitives exported for fine-grained tests/reuse
    titleCmds,
    actionbarCmd,
    soundCmd,
};
