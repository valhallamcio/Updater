/*
 * /pingroles [pack] [hours]
 *
 * Read-only: who plays a pack enough to be worth its ping role. Nothing is assigned -
 * pack roles stay opt-in through the role assigner buttons, this is the list staff look
 * at before nudging anyone.
 *
 * Only linked accounts can appear, because a Discord id is the only way from a player to
 * a member. Playtime comes off bifrost.players (`playtime.<tag>` minus `afk_time.<tag>`,
 * milliseconds) - the same active measure the pack role assigner grants on, so the report
 * and the assigner name the same people.
 *
 * Whether somebody ALREADY holds the role needs the guild member list, and that needs
 * the GuildMembers privileged intent - without it the report still lists everyone, it
 * just cannot mark the rows, and says so.
 */

const { SlashCommandBuilder } = require('discord.js');
const mongo = require('../../modules/mongo');
const yggdrasil = require('../../modules/yggdrasil');
const sessionLogger = require('../../modules/sessionLogger');
const { fetchGuildMembers } = require('../../modules/guildMembers');
const plan = require('../../modules/roleSyncPlan');

const DEFAULT_HOURS = 10;
const MAX_ROWS_PER_PACK = 15;
const REPLY_CAP = 1900;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('pingroles')
        .setDescription('Show which linked members would qualify for which pack ping role (report only)')
        .setDefaultMemberPermissions(16)
        .setDMPermission(false)
        .addStringOption(option =>
            option.setName('pack')
                .setDescription('Limit the report to one pack tag')
                .setRequired(false)
                .setAutocomplete(true))
        .addIntegerOption(option =>
            option.setName('hours')
                .setDescription(`Active playtime needed to qualify (default ${DEFAULT_HOURS})`)
                .setMinValue(1)
                .setMaxValue(1000)
                .setRequired(false)),

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused(true);
        if (focused.name !== 'pack') return;

        let tags = [];
        try {
            const servers = await yggdrasil.getServers();
            const typed = String(focused.value || '').toLowerCase();
            tags = [...new Set(servers.map(s => s.tag).filter(Boolean))]
                .filter(tag => tag.toLowerCase().startsWith(typed))
                .sort()
                .slice(0, 25);
        } catch (error) {
            sessionLogger.warn('PingRoles', 'Could not list packs for autocomplete', error.message);
        }
        await interaction.respond(tags.map(tag => ({ name: tag, value: tag })));
    },

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const pack = interaction.options.getString('pack');
        const hours = interaction.options.getInteger('hours') || DEFAULT_HOURS;

        const [servers, players] = await Promise.all([
            yggdrasil.getServers(),
            // without withPlaytime the docs come back with no playtime map, so every row
            // reads as 0 hours and the report is always empty; afk_time rides playtime
            mongo.findLinkedBifrostPlayers({ withPlaytime: true })
        ]);

        const wanted = pack
            ? servers.filter(s => String(s.tag).toLowerCase() === pack.toLowerCase())
            : servers;

        // Best effort - the report is worth having without it.
        const fetched = await fetchGuildMembers(interaction.guild, 'PingRoles');
        const memberRoles = fetched.ok
            ? new Map(fetched.members.map(m => [m.id, m.roles]))
            : null;

        const report = plan.planPingRoles({
            servers: wanted,
            players: players,
            minHours: hours,
            memberRoles: memberRoles
        });

        if (report.length === 0) {
            await interaction.editReply(
                `Nobody linked has ${hours}h of active playtime on ${pack ? `\`${pack}\`` : 'any pack with a ping role'}.`);
            return;
        }

        const lines = [`**Ping role candidates** — linked accounts with ${hours}h+ ACTIVE playtime on a pack:`];
        for (const row of report) {
            const missing = memberRoles ? row.qualified.filter(q => !q.hasRole) : row.qualified;
            lines.push('');
            lines.push(`**${row.name}** (\`${row.tag}\`) <@&${row.roleId}> — ${row.qualified.length} qualify` +
                (memberRoles ? `, ${missing.length} without the role` : ''));
            for (const q of missing.slice(0, MAX_ROWS_PER_PACK)) {
                lines.push(`• <@${q.discordId}> — ${q.username}, ${q.hours}h active`);
            }
            if (missing.length > MAX_ROWS_PER_PACK) lines.push(`• …and ${missing.length - MAX_ROWS_PER_PACK} more`);
        }
        if (!memberRoles) {
            lines.push('');
            lines.push('_Who already holds a role is unknown — the GuildMembers intent is not enabled for this bot._');
        }

        let text = lines.join('\n');
        if (text.length > REPLY_CAP) text = `${text.slice(0, REPLY_CAP)}\n…truncated, narrow it with \`pack:\`.`;

        await interaction.editReply({ content: text, allowedMentions: { parse: [] } });
    },
};
