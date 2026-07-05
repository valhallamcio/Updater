/*
 * File: quest.js
 * Project: valhalla-updater
 * -----
 * Quest ops via the biforesting link (v2 phase 6): /quest search finds ids by name
 * (FTBQ hex / BQ int), /quest complete|reset run the op on the backend with the
 * console output captured in the result. Reset sits behind a confirm button.
 */

const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');
const yggdrasil = require('../../modules/yggdrasil');
const sessionLogger = require('../../modules/sessionLogger');

function questLine(q) {
    const chapter = q.chapterTitle ? `[${q.chapterTitle}] ` : '';
    const tasks = q.taskCount ? ` (${q.taskCount} task${q.taskCount === 1 ? '' : 's'})` : '';
    return `\`${q.questId}\` ${chapter}**${q.title || '(untitled)'}**${tasks}`;
}

function opOutcomeEmbed(title, doc) {
    const res = doc.result?.data;
    const ok = doc.state === 'completed';
    return new EmbedBuilder()
        .setColor(ok ? 0x2ecc71 : 0xe74c3c)
        .setTitle(`${title} — ${doc.state}`)
        .setDescription([
            res?.command ? `\`${res.command}\`` : null,
            res?.output ? `\`\`\`\n${String(res.output).slice(0, 1500)}\n\`\`\`` : (ok ? '*no output*' : null),
            !ok && doc.result?.error ? doc.result.error : null
        ].filter(Boolean).join('\n'));
}

async function runQuestOp(interaction, server, type, player, questId, timeoutMs = 20000) {
    const op = { type, target: { name: player }, params: {} };
    if (questId) op.params.questId = questId;
    try {
        return await yggdrasil.runOp(server, op, timeoutMs);
    } catch (err) {
        // runOp throws 'not terminal' on parked waiting_player ops — that's the queued case
        await interaction.followUp(`⏳ Didn't finish (${err.message}) — quest ops need the player ONLINE; if they're off it queued for their next login (cancel via ops API if unwanted).`);
        return null;
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('quest')
        .setDescription('Quest registry + quest ops via the biforesting link!')
        .setDefaultMemberPermissions(1099511627776)
        .addSubcommand(s => s.setName('search')
            .setDescription('Find quest ids by name (title/subtitle/chapter)')
            .addStringOption(o => o.setName('server').setDescription('Server tag or id').setRequired(true))
            .addStringOption(o => o.setName('text').setDescription('Search text (or an exact quest id)').setRequired(true)))
        .addSubcommand(s => s.setName('complete')
            .setDescription('Complete a quest for a player (player must be online)')
            .addStringOption(o => o.setName('player').setDescription('Player name').setRequired(true))
            .addStringOption(o => o.setName('server').setDescription('Server tag or id').setRequired(true))
            .addStringOption(o => o.setName('questid').setDescription('Quest id (find it with /quest search)').setRequired(true)))
        .addSubcommand(s => s.setName('reset')
            .setDescription('Reset quest progress for a player — omit questid to reset ALL')
            .addStringOption(o => o.setName('player').setDescription('Player name').setRequired(true))
            .addStringOption(o => o.setName('server').setDescription('Server tag or id').setRequired(true))
            .addStringOption(o => o.setName('questid').setDescription('Quest id — LEAVE EMPTY to reset everything')))
        .setDMPermission(false),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const server = interaction.options.getString('server');
        await interaction.deferReply();

        if (sub === 'search') {
            const text = interaction.options.getString('text');
            let data;
            try {
                data = await yggdrasil.searchQuests(server, text, 10);
            } catch (err) {
                await interaction.editReply(`❌ Search failed: ${err.response?.data?.error?.message ?? err.message}`);
                return;
            }
            if (!data.registryCount) {
                await interaction.editReply(`No quest registry stored for **${server}** yet — the mod dumps it when CAP_QUEST_OPS is granted (or run a \`pull_quest_registry\` op).`);
                return;
            }
            const embed = new EmbedBuilder()
                .setColor(0x3498db)
                .setTitle(`Quest search "${text}" on ${data.instanceKey}`)
                .setDescription(data.quests.map(questLine).join('\n') || '*no matches*')
                .setFooter({ text: `${data.count} match(es) of ${data.registryCount} quests (${data.source}) — dumped ${data.dumpedAt ? new Date(data.dumpedAt).toLocaleString() : '?'}` });
            await interaction.editReply({ embeds: [embed] });
            return;
        }

        const player = interaction.options.getString('player');
        const questId = interaction.options.getString('questid');

        if (sub === 'complete') {
            const doc = await runQuestOp(interaction, server, 'quest_complete', player, questId);
            if (doc) await interaction.editReply({ embeds: [opOutcomeEmbed(`quest_complete ${questId} for ${player}`, doc)] });
            else await interaction.editReply('Queued.');
            return;
        }

        // reset — dangerous tier, confirm first (extra scary when it's ALL quests)
        const scope = questId ? `quest \`${questId}\`` : '**ALL quests**';
        const embed = new EmbedBuilder()
            .setColor(0xe74c3c)
            .setTitle(`Reset ${questId ? 'a quest' : 'ALL QUESTS'} for ${player} on ${server}?`)
            .setDescription(`This resets ${scope} progress for **${player}**. No undo (progress isn't snapshotted).`);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('confirm').setLabel(questId ? 'Reset it' : 'Reset EVERYTHING').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary));
        const msg = await interaction.editReply({ embeds: [embed], components: [row] });

        let press;
        try {
            press = await msg.awaitMessageComponent({
                filter: i => i.user.id === interaction.user.id,
                time: 120000
            });
        } catch {
            await interaction.editReply({ components: [] });
            return;
        }
        if (press.customId !== 'confirm') {
            await press.update({ embeds: [embed.setColor(0x95a5a6).setTitle('Cancelled')], components: [] });
            return;
        }
        await press.update({ components: [] });

        try {
            const doc = await runQuestOp(interaction, server, 'quest_reset', player, questId);
            if (doc) await interaction.followUp({ embeds: [opOutcomeEmbed(`quest_reset ${questId ?? 'ALL'} for ${player}`, doc)] });
        } catch (err) {
            sessionLogger.error('Quest', 'reset failed:', err.message);
            await interaction.followUp(`❌ Reset failed: ${err.response?.data?.error?.message ?? err.message}`);
        }
    }
};
