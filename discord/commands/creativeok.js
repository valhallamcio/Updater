/*
 * /creativeok add|remove|list
 *
 * Clears a player for creative on named servers, so Bifrost's exploit-guard stops kicking them.
 * A clearance is one `bifrost.exploitguard.creative` entry per server in bifrost.players, each with
 * a `server=<name>` context. A tag (pri) covers every server that carries it. The same command is
 * `/creativeok` in game (Bifrost exploit-guard/clearance.ts); keep the two in step. Staff-only.
 *
 * permission-api's change stream fires on a whole-array $set of `permissions` only, and a
 * same-value $set fires nothing. So the write sets the array without the node, then the result.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const mongo = require('../../modules/mongo');
const sessionLogger = require('../../modules/sessionLogger');

const CREATIVE_PERM = 'bifrost.exploitguard.creative';

/** Servers a query names: an exact id or name gives one, a tag gives all that carry it. */
function matchServers(servers, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const one = servers.find(s => String(s.serverId).toLowerCase() === q)
        || servers.find(s => String(s.name || '').trim().toLowerCase() === q);
    if (one) return [one];
    return servers.filter(s => String(s.tag || '').toLowerCase() === q);
}

const scopeOf = e => ((e.context || []).find(c => c.key === 'server') || {}).value ?? null;

/** Server names the player is cleared on. An unscoped entry reads as '*' (everywhere). */
function clearedServers(perms) {
    return (perms || []).filter(e => e.key === CREATIVE_PERM && e.value).map(e => scopeOf(e) ?? '*');
}

/** The permission array after the edit. `servers` null on remove takes every clearance away. */
function editClearance(perms, op, servers) {
    const hit = e => e.key === CREATIVE_PERM && (servers === null || (scopeOf(e) !== null && servers.includes(scopeOf(e))));
    const kept = (perms || []).filter(e => !hit(e));
    if (op === 'remove') return kept;
    return [...kept, ...(servers || []).map(s => ({ key: CREATIVE_PERM, value: true, context: [{ key: 'server', value: s }] }))];
}

const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const playerOption = o => o.setName('player').setDescription('Minecraft name').setRequired(true);

module.exports = {
    CREATIVE_PERM,
    matchServers,
    clearedServers,
    editClearance,
    data: new SlashCommandBuilder()
        .setName('creativeok')
        .setDescription('Clear a player for creative on a server, so the exploit guard stops kicking them')
        .setDefaultMemberPermissions(1099511627776) // ModerateMembers: every staff role from Helper up
        .setDMPermission(false)
        .addSubcommand(s => s.setName('add').setDescription('Clear a player for creative on a server or a tag')
            .addStringOption(playerOption)
            .addStringOption(o => o.setName('server').setDescription('Server tag, id or name (a tag covers all its servers)')
                .setRequired(true).setAutocomplete(true)))
        .addSubcommand(s => s.setName('remove').setDescription('Take a creative clearance back')
            .addStringOption(playerOption)
            .addStringOption(o => o.setName('server').setDescription('Server tag, id or name, or all')
                .setRequired(true).setAutocomplete(true)))
        .addSubcommand(s => s.setName('list').setDescription('Who is cleared for creative, and where')
            .addStringOption(o => o.setName('player').setDescription('Minecraft name (empty: everyone)').setRequired(false))),

    async autocomplete(interaction) {
        const focused = String(interaction.options.getFocused() || '').toLowerCase();
        const db = await mongo.getBifrostDb();
        const servers = await db.collection('servers').find({}, { projection: { serverId: 1, name: 1, tag: 1 } }).toArray();
        const byTag = new Map();
        for (const s of servers) if (s.tag) byTag.set(s.tag, [...(byTag.get(s.tag) || []), s]);
        const choices = [...byTag].map(([tag, list]) => ({
            name: `${tag}: ${list.map(s => String(s.name || s.serverId).trim()).join(', ')}`.slice(0, 100),
            value: tag
        }));
        if (interaction.options.getSubcommand() === 'remove') choices.unshift({ name: 'all: every server', value: 'all' });
        await interaction.respond(choices.filter(c => c.name.toLowerCase().includes(focused)).slice(0, 25));
    },

    /**
     * @param {object} interaction The slash command.
     * @param {object} deps Injectable for tests: db (the bifrost Db).
     */
    async execute(interaction, deps = {}) {
        await interaction.deferReply();
        const db = deps.db || await mongo.getBifrostDb();
        const players = db.collection('players');
        const sub = interaction.options.getSubcommand();
        const typed = interaction.options.getString('player');
        const actor = interaction.user.username;

        if (sub === 'list' && !typed) {
            const rows = await players.find({ permissions: { $elemMatch: { key: CREATIVE_PERM, value: true } } },
                { projection: { uuid: 1, username: 1, permissions: 1 } }).limit(50).toArray();
            await interaction.editReply(rows.length
                ? rows.map(r => `**${r.username || r.uuid}**: ${clearedServers(r.permissions).join(', ')}`).join('\n').slice(0, 1900)
                : 'Nobody is cleared for creative.');
            return;
        }

        const doc = await players.findOne({ username: { $regex: `^${escapeRegex(typed.trim())}$`, $options: 'i' } },
            { projection: { uuid: 1, username: 1, permissions: 1 } });
        if (!doc) {
            await interaction.editReply(`❌ No player named \`${typed}\`.`);
            return;
        }
        const name = doc.username || typed;
        const current = doc.permissions || [];
        if (sub === 'list') {
            const on = clearedServers(current);
            await interaction.editReply(on.length ? `**${name}** is cleared on ${on.join(', ')}.` : `**${name}** is not cleared anywhere.`);
            return;
        }

        const query = interaction.options.getString('server');
        let servers = null;
        if (!(sub === 'remove' && query.trim().toLowerCase() === 'all')) {
            const all = await db.collection('servers').find({}, { projection: { serverId: 1, name: 1, tag: 1 } }).toArray();
            const hits = matchServers(all, query);
            if (!hits.length) {
                await interaction.editReply(`❌ No server matches \`${query}\`. Use its tag, id or name.`);
                return;
            }
            servers = hits.map(s => String(s.name).trim());
        }

        const next = editClearance(current, sub, servers);
        const without = current.filter(e => e.key !== CREATIVE_PERM);
        const match = doc.permissions === undefined ? { $exists: false } : current;
        const a = await players.updateOne({ uuid: doc.uuid, permissions: match }, { $set: { permissions: without } });
        if (a.matchedCount !== 1) {
            await interaction.editReply(`❌ ${name}'s permissions changed just now. Run it again.`);
            return;
        }
        if (JSON.stringify(next) !== JSON.stringify(without)) {
            await players.updateOne({ uuid: doc.uuid, permissions: without }, { $set: { permissions: next } });
        }

        const where = servers ? servers.join(', ') : 'every server';
        sessionLogger.info('CreativeOk', `${actor} ${sub === 'add' ? 'cleared' : 'uncleared'} ${name} for creative on ${where}`);
        const on = clearedServers(next);
        await interaction.editReply({
            embeds: [new EmbedBuilder()
                .setColor(sub === 'add' ? 0x2ecc71 : 0xe67e22)
                .setTitle(sub === 'add' ? `${name} is cleared for creative` : `${name}'s creative clearance is off`)
                .setDescription([
                    `${sub === 'add' ? 'Added' : 'Removed'}: ${where}`,
                    `Cleared now: ${on.length ? on.join(', ') : 'nowhere'}`,
                    'Command blocks still ban.'
                ].join('\n'))
                .setFooter({ text: `by ${actor}` })
                .setTimestamp()]
        });
    }
};
