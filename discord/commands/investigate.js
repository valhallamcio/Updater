const {
    SlashCommandBuilder,
    EmbedBuilder,
    AttachmentBuilder
} = require('discord.js');
const mongo = require('../../modules/mongo');
const yggdrasil = require('../../modules/yggdrasil');
const { mongoBase64ToUuid } = require('../../modules/uuidUtils');

// command logging shipped in Bifrost on this date — no command rows exist before it
const COMMAND_LOGGING_SINCE = new Date('2026-07-11T00:00:00Z');

/**
 * Parses a flexible date input (UTC): "2026-07-10", "2026-07-10 14:00",
 * ISO strings, or relative ("24h", "7d", "30m" ago).
 * @param {string} str Input.
 * @param {boolean} endOfDay Date-only inputs snap to end of day instead of midnight.
 * @returns {Date|null} Parsed date or null.
 */
function parseWhen(str, endOfDay = false) {
    if (!str) return null;
    const s = str.trim();

    const rel = s.match(/^(\d+)\s*(m|h|d|w)$/i);
    if (rel) {
        const mult = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[rel[2].toLowerCase()];
        return new Date(Date.now() - parseInt(rel[1]) * mult);
    }

    const dateOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateOnly) {
        const d = new Date(`${s}T${endOfDay ? '23:59:59.999' : '00:00:00'}Z`);
        return isNaN(d) ? null : d;
    }

    const dateTime = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/);
    if (dateTime) {
        const d = new Date(`${dateTime[1]}T${dateTime[2]}Z`);
        return isNaN(d) ? null : d;
    }

    const d = new Date(s);
    return isNaN(d) ? null : d;
}

function fmtTs(date) {
    return date ? new Date(date).toISOString().replace('T', ' ').slice(0, 19) : '?';
}

function fmtDuration(ms) {
    if (!ms || ms < 0) return '0m';
    const h = Math.floor(ms / 3600e3);
    const m = Math.floor((ms % 3600e3) / 60e3);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function cleanIp(raw) {
    if (!raw) return null;
    const m = String(raw).match(/^\/?([0-9a-fA-F.:]+?)(?::\d+)?$/);
    return m ? m[1] : null;
}

function playerUuid(identity) {
    if (!identity || !identity.uuid) return null;
    try {
        if (identity.uuid.buffer) {
            return mongoBase64ToUuid(Buffer.from(identity.uuid.buffer).toString('base64'));
        }
        return String(identity.uuid);
    } catch {
        return null;
    }
}

/**
 * Builds one chronological transcript line from a log row.
 * @param {object} row bifrost/valhallamc logs row.
 * @param {string} target Target username (marked with '>').
 * @returns {string} Transcript line.
 */
function transcriptLine(row, target) {
    const mark = row.username === target ? '>' : ' ';
    const ts = fmtTs(row.timestamp);
    const server = row.server_name ? ` (${String(row.server_name).replace(/\0/g, '').trim()})` : '';
    switch (row.log_type) {
        case 'chat':
            return `[${ts}] ${mark} CHAT ${server} ${row.username}: ${row.chat_message}`;
        case 'command':
            return `[${ts}] ${mark} CMD  ${server} ${row.username}: /${row.command}`;
        case 'connect':
            return `[${ts}] ${mark} JOIN  ${row.username} connected (${cleanIp(row.ip_address) || '?'})`;
        case 'disconnect':
            return `[${ts}] ${mark} LEAVE ${row.username} disconnected (${row.disconnect_state || '?'})`;
        case 'server_change':
            return `[${ts}] ${mark} MOVE ${server} ${row.username} switched server`;
        default:
            return `[${ts}] ${mark} ${String(row.log_type || '?').toUpperCase()} ${row.username}`;
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('investigate')
        .setDescription('Investigate a player dispute from logged evidence')
        .setDefaultMemberPermissions(1099511627776)
        .setDMPermission(false)
        .addSubcommand(subcommand =>
            subcommand
                .setName('timeline')
                .setDescription('Chronological transcript of what a player said and did')
                .addStringOption(option =>
                    option.setName('player')
                        .setDescription('Player username')
                        .setRequired(true)
                        .setAutocomplete(true))
                .addStringOption(option =>
                    option.setName('from')
                        .setDescription('Range start (UTC): 2026-07-10, 2026-07-10 14:00, or relative 24h/7d (default: 24h)')
                        .setRequired(false))
                .addStringOption(option =>
                    option.setName('to')
                        .setDescription('Range end (UTC), same formats (default: now)')
                        .setRequired(false))
                .addStringOption(option =>
                    option.setName('server')
                        .setDescription('Scope room context to this server')
                        .setRequired(false)
                        .setAutocomplete(true))
                .addBooleanOption(option =>
                    option.setName('context')
                        .setDescription('Include other players\' chat on the same server (default: false)')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('alts')
                .setDescription('Find accounts sharing IPs with a player')
                .addStringOption(option =>
                    option.setName('player')
                        .setDescription('Player username')
                        .setRequired(true)
                        .setAutocomplete(true))),

    async autocomplete(interaction) {
        const focusedOption = interaction.options.getFocused(true);

        if (focusedOption.name === 'player') {
            const usernames = await mongo.searchPlayerUsernames(focusedOption.value, 25);
            usernames.sort((a, b) => a.localeCompare(b));
            await interaction.respond(
                usernames.map(u => ({ name: u, value: u })),
            );
        } else if (focusedOption.name === 'server') {
            const focusedValue = focusedOption.value;
            const serverList = await yggdrasil.getServers();
            const choices = [];

            for (const server of serverList) {
                if (!server.excludeFromServerList) {
                    choices.push(server.name.trim());
                }
            }

            const filtered = choices.filter(choice => choice.toLowerCase().includes(focusedValue.toLowerCase()));
            await interaction.respond(
                filtered.slice(0, 25).map(choice => ({
                    name: choice,
                    value: choice
                })),
            );
        }
    },

    async execute(interaction) {
        await interaction.deferReply();

        try {
            const subcommand = interaction.options.getSubcommand();
            if (subcommand === 'timeline') {
                await this.timeline(interaction);
            } else if (subcommand === 'alts') {
                await this.alts(interaction);
            }
        } catch (error) {
            console.error('Error in investigate command:', error);
            await interaction.editReply(`❌ **Error:** ${error.message}`);
        }
    },

    async timeline(interaction) {
        const playerInput = interaction.options.getString('player');
        const fromInput = interaction.options.getString('from');
        const toInput = interaction.options.getString('to');
        const serverInput = interaction.options.getString('server');
        const wantContext = interaction.options.getBoolean('context') || false;

        const from = fromInput ? parseWhen(fromInput) : new Date(Date.now() - 24 * 3600e3);
        const to = toInput ? parseWhen(toInput, true) : new Date();
        if (!from) return interaction.editReply(`❌ Can't parse \`from\`: \`${fromInput}\`. Use \`2026-07-10\`, \`2026-07-10 14:00\` or relative \`24h\`/\`7d\`.`);
        if (!to) return interaction.editReply(`❌ Can't parse \`to\`: \`${toInput}\`.`);
        if (from > to) return interaction.editReply(`❌ \`from\` (${fmtTs(from)}) is after \`to\` (${fmtTs(to)}).`);

        // canonical casing so the indexed exact-match queries hit
        const identity = await mongo.getPlayerIdentity(playerInput);
        const username = identity?.username || playerInput;

        const [activity, sessions, punishments, altScan] = await Promise.all([
            mongo.getPlayerActivity(username, from, to),
            mongo.getPlayerSessions(username, from, to),
            mongo.getPlayerPunishments(username),
            mongo.findAlts(username).catch(() => ({ ips: [], alts: [] }))
        ]);

        if (!identity && activity.length === 0 && sessions.length === 0) {
            return interaction.editReply(`❌ No trace of **${playerInput}** — no player doc, no logs, no sessions. Check the spelling (use the autocomplete).`);
        }

        // room context: the chosen server, or every server the player was seen on in range
        let contextRows = [];
        let contextServers = [];
        if (wantContext) {
            contextServers = serverInput
                ? [serverInput]
                : [...new Set(activity.map(r => r.server_name).filter(Boolean))];
            for (const srv of contextServers.slice(0, 5)) {
                const rows = await mongo.getRoomContext(srv, from, to);
                contextRows.push(...rows.filter(r => r.username !== username));
            }
        }

        // interleave everything chronologically
        const punishInRange = punishments.filter(p => p.date && p.date >= from && p.date <= to);
        const lines = [
            ...activity.map(r => ({ ts: r.timestamp, line: transcriptLine(r, username) })),
            ...contextRows.map(r => ({ ts: r.timestamp, line: transcriptLine(r, username) })),
            ...punishInRange.map(p => ({
                ts: p.date,
                line: `[${fmtTs(p.date)}] > PUNISH ${p.type.toUpperCase()} by ${p.staff_name}: ${p.reason || 'no reason'}${p.expiration_date ? ` (until ${fmtTs(p.expiration_date)})` : ''}`
            }))
        ].sort((a, b) => a.ts - b.ts);

        const counts = { chat: 0, command: 0, connect: 0, disconnect: 0, server_change: 0 };
        for (const r of activity) if (counts[r.log_type] !== undefined) counts[r.log_type]++;

        // transcript file
        const header = [
            `=== Investigation: ${username} | ${fmtTs(from)} -> ${fmtTs(to)} UTC ===`,
            `Lines starting with '>' are the target player.${wantContext ? ` Context from: ${contextServers.join(', ') || 'none'}.` : ''}`,
            counts.command === 0 && from < COMMAND_LOGGING_SINCE
                ? `NOTE: commands are only recorded since ${fmtTs(COMMAND_LOGGING_SINCE).slice(0, 10)} — earlier ranges show none, that does NOT mean the player ran none.`
                : null,
            ''
        ].filter(l => l !== null);
        const transcript = header.concat(lines.length ? lines.map(l => l.line) : ['(no activity in this range)']).join('\n');

        // summary embed
        const activePunish = punishments.filter(p => p.active);
        const sessionIps = [...new Set(sessions.map(s => s.ip).filter(Boolean))];
        const firstSeen = identity?.first_seen ? Object.values(identity.first_seen).sort((a, b) => a - b)[0] : null;
        const lastSeen = identity?.last_seen ? Object.values(identity.last_seen).sort((a, b) => b - a)[0] : null;
        const playtime = identity?.playtime ? Object.values(identity.playtime).reduce((a, b) => a + (b || 0), 0) : 0;
        const uuid = playerUuid(identity);

        const embed = new EmbedBuilder()
            .setColor(activePunish.length ? 0xff5555 : 0x9c59b6)
            .setTitle(`🔍 Investigation: ${username}`)
            .setDescription(`${fmtTs(from)} → ${fmtTs(to)} UTC`)
            .addFields(
                { name: 'Identity', value: [uuid && `UUID: \`${uuid}\``, firstSeen && `First seen: ${fmtTs(firstSeen)}`, lastSeen && `Last seen: ${fmtTs(lastSeen)}`, playtime && `Playtime: ${fmtDuration(playtime)}`].filter(Boolean).join('\n') || 'no player doc', inline: false },
                { name: 'Activity in range', value: `${counts.chat} chat, ${counts.command} commands, ${counts.connect} joins, ${counts.disconnect} leaves, ${counts.server_change} switches`, inline: false },
                { name: `Sessions in range (${sessions.length})`, value: sessions.length ? `IPs: ${sessionIps.slice(0, 5).map(ip => `\`${ip}\``).join(', ')}${sessionIps.length > 5 ? ` +${sessionIps.length - 5} more` : ''}` : 'none', inline: false },
                { name: `Punishments (${punishments.length} total, ${activePunish.length} active)`, value: punishments.slice(0, 5).map(p => `${p.active ? '🔴' : '⚪'} ${p.type} — ${(p.reason || 'no reason').slice(0, 80)} (${fmtTs(p.date).slice(0, 10)})`).join('\n').slice(0, 1024) || 'none', inline: false }
            )
            .setTimestamp();

        if (altScan.alts.length) {
            embed.addFields({
                name: `⚠️ Shared IPs (${altScan.alts.length} account${altScan.alts.length === 1 ? '' : 's'})`,
                value: (altScan.alts.slice(0, 8).map(a => `**${a.username}**`).join(', ') + ` — run \`/investigate alts\` for detail`).slice(0, 1024),
                inline: false
            });
        }

        const attachment = new AttachmentBuilder(Buffer.from(transcript, 'utf-8'), {
            name: `investigate_${username}_${fmtTs(from).slice(0, 10)}.txt`
        });
        await interaction.editReply({ embeds: [embed], files: [attachment] });
    },

    async alts(interaction) {
        const playerInput = interaction.options.getString('player');
        const identity = await mongo.getPlayerIdentity(playerInput);
        const username = identity?.username || playerInput;

        // deep pass regex-scans bifrost.logs — slow-ish, fine behind deferReply
        const { ips, alts } = await mongo.findAlts(username, { deep: true });

        if (ips.length === 0) {
            return interaction.editReply(`No recorded IPs for **${username}**.`);
        }

        const embed = new EmbedBuilder()
            .setColor(alts.length ? 0xffa500 : 0x00ff00)
            .setTitle(`🔍 Alt scan: ${username}`)
            .addFields(
                { name: `IPs (${ips.length})`, value: ips.slice(0, 15).map(ip => `\`${ip}\``).join(', ').slice(0, 1024) + (ips.length > 15 ? ` +${ips.length - 15} more` : ''), inline: false }
            )
            .setTimestamp();

        if (alts.length === 0) {
            embed.setDescription('No other accounts seen on these IPs.');
        } else {
            let used = 0;
            for (const alt of alts) {
                const name = alt.username;
                const value = `Shared: ${alt.ips.slice(0, 5).map(ip => `\`${ip}\``).join(', ')}${alt.lastSeen ? `\nLast seen: ${fmtTs(alt.lastSeen)}` : ''}`.slice(0, 1024);
                if (used + name.length + value.length > 4500) {
                    embed.setFooter({ text: `Showing some of ${alts.length} accounts` });
                    break;
                }
                embed.addFields({ name, value, inline: true });
                used += name.length + value.length;
            }
            embed.setDescription(`⚠️ **${alts.length}** other account${alts.length === 1 ? '' : 's'} seen on shared IPs. Shared IP ≠ same person (families, schools, VPNs).`);
        }

        await interaction.editReply({ embeds: [embed] });
    }
};
