/*
 * /sync-group status|freeze|unfreeze <group>
 *
 * Reads and sets the move freeze of a player sync group (Yggdrasil /v1/biforesting/sync/:group).
 * VU freezes a group around updates and restores, and leaves it frozen when a run fails. Staff
 * use this command to lift that freeze, or to hold moves by hand. A staff freeze reason starts
 * with "staff ", so an update that starts later leaves it on. Staff-only.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const yggdrasil = require('../../modules/yggdrasil');
const playerSync = require('../../modules/playerSync');
const sessionLogger = require('../../modules/sessionLogger');

const groupOf = server => (typeof server.group === 'string' ? server.group.trim() : '');

/**
 * The sync group a typed value names.
 * @param {Array} servers Server docs from Yggdrasil.
 * @param {string} input A group name, or a tag whose instances share one group.
 * @returns {{group: string|null, error: string|null}} A name that matches nothing is used as is,
 *   so a group that no server doc lists can still be read.
 */
function resolveGroup(servers, input) {
    const needle = String(input || '').trim();
    if (!needle) return { group: null, error: 'No group given.' };
    const lower = needle.toLowerCase();

    const groups = [...new Set(servers.map(groupOf).filter(Boolean))];
    const byName = groups.find(g => g === needle) || groups.find(g => g.toLowerCase() === lower);
    if (byName) return { group: byName, error: null };

    const tagIds = servers.filter(s => String(s.tag || '').toLowerCase() === lower).map(s => s.serverId);
    if (tagIds.length > 0) {
        const shared = playerSync.sharedGroup(servers, tagIds);
        if (shared) return { group: shared, error: null };
        return { group: null, error: `The instances of \`${needle}\` share no sync group.` };
    }
    return { group: needle, error: null };
}

/** One line per instance: linked or not, and its pack fingerprint. */
function instanceLines(status, servers) {
    const instances = Array.isArray(status.instances) ? status.instances : [];
    if (instances.length === 0) return 'Yggdrasil lists no instances.';
    return instances.map(i => {
        const doc = servers.find(s => s.serverId === i.serverId);
        const name = doc && doc.name ? ` ${String(doc.name).trim()}` : '';
        const pack = `pack ${i.fp ?? 'none'}${i.fpMatch === true ? '' : ' (differs)'}`;
        return `${i.live ? '🟢' : '🔴'} \`${i.serverId}\`${name}: ${i.live ? 'linked' : 'not linked'}, ${pack}`;
    }).join('\n');
}

/** The state of a group as an embed. */
function statusEmbed(group, status, servers, color = 0x3498db) {
    const blocker = playerSync.unfreezeBlocker(status);
    const frozen = status.frozen
        ? `Yes: ${status.freezeReason || 'no reason given'}`
        : 'No, players can move';
    return new EmbedBuilder()
        .setColor(color)
        .setTitle(`Player sync: ${group}`)
        .addFields(
            { name: 'Mode', value: String(status.mode || 'unknown'), inline: true },
            { name: 'Moves paused', value: frozen.slice(0, 1024), inline: true },
            { name: 'Instances', value: instanceLines(status, servers).slice(0, 1024), inline: false },
            { name: 'Ready to open moves', value: (blocker ? `No: ${blocker}` : 'Yes: every instance is linked on one pack').slice(0, 1024), inline: false }
        )
        .setTimestamp();
}

module.exports = {
    resolveGroup,
    data: new SlashCommandBuilder()
        .setName('sync-group')
        .setDescription('Read or set the move freeze of a player sync group')
        .setDefaultMemberPermissions(16)
        .setDMPermission(false)
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('Show the mode, the freeze and the instances of a sync group')
                .addStringOption(option =>
                    option.setName('group')
                        .setDescription('Sync group, or a tag whose instances share one')
                        .setRequired(true)
                        .setAutocomplete(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('freeze')
                .setDescription('Pause moves between the instances of a sync group')
                .addStringOption(option =>
                    option.setName('group')
                        .setDescription('Sync group, or a tag whose instances share one')
                        .setRequired(true)
                        .setAutocomplete(true))
                .addStringOption(option =>
                    option.setName('reason')
                        .setDescription('Why moves are paused (shown in the status)')
                        .setRequired(false)
                        .setMaxLength(150)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('unfreeze')
                .setDescription('Open moves between the instances of a sync group again')
                .addStringOption(option =>
                    option.setName('group')
                        .setDescription('Sync group, or a tag whose instances share one')
                        .setRequired(true)
                        .setAutocomplete(true))
                .addBooleanOption(option =>
                    option.setName('force')
                        .setDescription('Open moves even when an instance is down or on another pack')
                        .setRequired(false))),

    async autocomplete(interaction) {
        const focused = String(interaction.options.getFocused() || '').toLowerCase();
        const servers = await yggdrasil.getServers(yggdrasil.SERVER_LIST_MAX_AGE_MS);
        const byGroup = new Map();
        for (const server of servers) {
            const group = groupOf(server);
            if (!group) continue;
            if (!byGroup.has(group)) byGroup.set(group, []);
            byGroup.get(group).push(server);
        }
        const choices = [...byGroup].map(([group, members]) => ({
            name: `${group} (${members.length} instances, tag ${[...new Set(members.map(m => m.tag))].join(', ')})`.slice(0, 100),
            value: group.slice(0, 100)
        }));
        await interaction.respond(choices.filter(c => c.name.toLowerCase().includes(focused)).slice(0, 25));
    },

    /**
     * @param {object} interaction The slash command.
     * @param {object} deps Injectable for tests: sync (a playerSync client), listServers.
     */
    async execute(interaction, deps = {}) {
        const sync = deps.sync || playerSync;
        const listServers = deps.listServers || (() => yggdrasil.getServers(yggdrasil.SERVER_LIST_MAX_AGE_MS));
        await interaction.deferReply();

        const subcommand = interaction.options.getSubcommand();
        const user = interaction.user.username;
        let servers = [];
        try {
            servers = await listServers();
        } catch (error) {
            sessionLogger.warn('SyncGroup', `Could not read the server list (${error.message}), using the group name as typed`);
        }

        const { group, error } = resolveGroup(servers, interaction.options.getString('group'));
        if (!group) {
            await interaction.editReply(`❌ ${error}`);
            return;
        }

        let status;
        try {
            status = await sync.getGroup(group);
        } catch (err) {
            await interaction.editReply(`❌ Could not read sync group \`${group}\`: ${err.message}`);
            return;
        }
        if (!status) {
            await interaction.editReply(`❌ Yggdrasil has no sync doc for \`${group}\`.`);
            return;
        }

        if (subcommand === 'status') {
            await interaction.editReply({ embeds: [statusEmbed(group, status, servers)] });
            return;
        }

        if (subcommand === 'freeze') {
            if (status.frozen) {
                await interaction.editReply({
                    content: `Moves of \`${group}\` are already paused. Nothing changed.`,
                    embeds: [statusEmbed(group, status, servers)]
                });
                return;
            }
            const reason = `staff ${user}: ${interaction.options.getString('reason') || 'paused by hand'}`;
            try {
                await sync.setFrozen(group, true, reason);
            } catch (err) {
                await interaction.editReply(`❌ Could not pause moves of \`${group}\`: ${err.message}`);
                return;
            }
            sessionLogger.info('SyncGroup', `${user} froze sync group ${group} (${reason})`);
            const after = await sync.getGroup(group).catch(() => null) || { ...status, frozen: true, freezeReason: reason };
            await interaction.editReply({
                content: `⏸️ Moves between the \`${group}\` instances are paused. An update or a restore leaves this freeze on. Open moves with \`/sync-group unfreeze\`.`,
                embeds: [statusEmbed(group, after, servers, 0xffa500)]
            });
            return;
        }

        if (subcommand === 'unfreeze') {
            if (!status.frozen) {
                await interaction.editReply({
                    content: `Moves of \`${group}\` are already open. Nothing changed.`,
                    embeds: [statusEmbed(group, status, servers)]
                });
                return;
            }
            const force = interaction.options.getBoolean('force') === true;
            const blocker = playerSync.unfreezeBlocker(status);
            if (blocker && !force) {
                await interaction.editReply({
                    content: `❌ Moves of \`${group}\` stay paused: ${blocker}. Wait until every instance is linked on one pack, or run this again with \`force:true\`.`,
                    embeds: [statusEmbed(group, status, servers, 0xff0000)]
                });
                return;
            }
            try {
                await sync.setFrozen(group, false);
            } catch (err) {
                await interaction.editReply(`❌ Could not open moves of \`${group}\`: ${err.message}`);
                return;
            }
            sessionLogger.info('SyncGroup', `${user} unfroze sync group ${group} (was: ${status.freezeReason || 'no reason'}${blocker ? `, forced past: ${blocker}` : ''})`);
            const notes = [];
            if (blocker) notes.push(`Opened with force past: ${blocker}.`);
            if (playerSync.isUpdaterFreeze(status.freezeReason)) {
                notes.push(`VU paused moves for \`${status.freezeReason}\`. If that run is still going, players can now start a move while its instances are down.`);
            }
            const after = await sync.getGroup(group).catch(() => null) || { ...status, frozen: false, freezeReason: null };
            await interaction.editReply({
                content: [`▶️ Moves between the \`${group}\` instances are open again.`, ...notes].join('\n'),
                embeds: [statusEmbed(group, after, servers, 0x00ff00)]
            });
            return;
        }

        await interaction.editReply('Unknown subcommand!');
    }
};
