/*
 * /reply <player> <text> [report]
 *
 * Answers a player in game from Discord. Inserts a bifrost.mail doc; the proxy's change
 * stream delivers it inline when they are online, otherwise it waits in their inbox and
 * they read it with /mail on their next login. Staff-only.
 *
 * With `report` (the id from the report embed), the mail goes out first. Then that report
 * in bifrost.reports is closed the way the proxy's `/reports close <id> <note>` closes it,
 * with the text as the note. The player reads it under the report in `/report list`. Only
 * a report the player filed is closed. For any other id the mail still goes out and the
 * reply says why the report stayed open.
 */

const { SlashCommandBuilder } = require('discord.js');
const mongo = require('../../modules/mongo');
const sessionLogger = require('../../modules/sessionLogger');
const { BODY_CAP, buildMailDoc } = require('./util/mailDoc');
const {
    ID_SCAN_LIMIT, shortId, idMatches, parseReportId, buildReportClose, reportChoice
} = require('./util/reportClose');

/**
 * Closes the player's report `raw` with the mail text. Never throws: the mail is out already.
 * @param {object} identity The player's bifrost.players doc.
 * @param {string} raw The `report` option.
 * @param {object} mail The mail doc that went out.
 * @returns {Promise<string>} The line for the staff reply.
 */
async function answerReport(identity, raw, mail) {
    const name = mail.toName;
    const parsed = parseReportId(raw);
    if (!parsed.ok) {
        return '⚠️ Report not updated: that is not a report id. Use the 6-character id from the report embed.';
    }
    const want = parsed.id;
    try {
        const own = await mongo.findReportIdsOf(identity.uuid, ID_SCAN_LIMIT);
        const hits = own.filter(doc => idMatches(doc._id, want));
        if (hits.length > 1) {
            return `⚠️ Report not updated: #${want} fits more than one report from **${name}**. Type more of the id.`;
        }
        if (hits.length === 0) {
            const others = await mongo.findRecentReportIds(ID_SCAN_LIMIT);
            const owners = [...new Set(others
                .filter(doc => idMatches(doc._id, want) && !(doc.reporter && doc.reporter.uuid === identity.uuid))
                .map(doc => (doc.reporter && doc.reporter.username) || 'another player'))];
            if (owners.length > 0) {
                return `⚠️ Report not updated: #${want} belongs to **${owners.join(', ')}**. Only a report from **${name}** takes this reply.`;
            }
            return `⚠️ Report not updated: **${name}** has no report #${want}.`;
        }
        const found = hits[0];
        const id = shortId(found._id);
        if (found.status === 'closed') return `⚠️ Report not updated: #${id} is already closed.`;
        const res = await mongo.closeReport(found._id, identity.uuid,
            buildReportClose({ staffName: mail.from.name, text: mail.body, now: mail.sentAt }));
        if (!res || !res.matchedCount) return `⚠️ Report not updated: #${id} is already closed.`;
        return `✅ Report #${id} is closed. **${name}** sees this text as the answer in /report list.`;
    } catch (error) {
        sessionLogger.error('Reply', `Could not close report ${want} for ${identity.uuid}`, error.message);
        return '⚠️ Report not updated: the database did not answer. Close it in game with /reports close.';
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('reply')
        .setDescription('Send a player an in-game message from staff (delivered now or at their next login)')
        .setDefaultMemberPermissions(16)
        .setDMPermission(false)
        .addStringOption(option =>
            option.setName('player')
                .setDescription('Player username')
                .setRequired(true)
                .setAutocomplete(true))
        .addStringOption(option =>
            option.setName('text')
                .setDescription(`What to tell them (max ${BODY_CAP} chars)`)
                .setRequired(true))
        .addStringOption(option =>
            option.setName('report')
                .setDescription('Their report id (from the report embed). The text closes it as the answer.')
                .setRequired(false)
                .setAutocomplete(true)),

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused(true);
        if (focused.name === 'report') {
            // Needs the player first: the choices are that player's open reports.
            const player = interaction.options.getString('player');
            if (!player) return interaction.respond([]);
            try {
                const identity = await mongo.getPlayerIdentity(player);
                if (!identity || !identity.uuid) return interaction.respond([]);
                const typed = String(focused.value || '').trim().toLowerCase().replace(/^#/, '');
                const choices = (await mongo.findOpenReportsOf(identity.uuid, 25))
                    .map(reportChoice)
                    .filter(c => !typed || c.name.toLowerCase().includes(typed) || c.value.endsWith(typed));
                return interaction.respond(choices.slice(0, 25));
            } catch (error) {
                return interaction.respond([]);
            }
        }
        if (focused.name !== 'player') return;
        const usernames = await mongo.searchPlayerUsernames(focused.value, 25);
        usernames.sort((a, b) => a.localeCompare(b));
        await interaction.respond(usernames.map(u => ({ name: u, value: u })));
    },

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const player = interaction.options.getString('player');
        const text = interaction.options.getString('text');
        const report = interaction.options.getString('report');

        const identity = await mongo.getPlayerIdentity(player);
        if (!identity || !identity.uuid) {
            await interaction.editReply(`❌ No player named \`${player}\` — pick one from the autocomplete.`);
            return;
        }

        const built = buildMailDoc({
            toUuid: identity.uuid,
            toName: identity.username || player,
            fromName: interaction.user.username,
            discordId: interaction.user.id,
            text: text,
            now: new Date()
        });
        if (!built.ok) {
            await interaction.editReply(`❌ ${built.error}`);
            return;
        }

        await mongo.insertMail(built.doc);
        const sent = `✅ Sent — **${built.doc.toName}** sees it in game (now if online, else at next login).`;
        if (parseReportId(report) === null) {
            await interaction.editReply(sent);
            return;
        }
        await interaction.editReply(`${sent}\n${await answerReport(identity, report, built.doc)}`);
    },
};
