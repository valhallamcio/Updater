/*
 * File: inventory.js
 * Project: valhalla-updater
 * -----
 * Player inventory via the biforesting link (v2 phase 4): live inspect op when the
 * server is linked, newest stored snapshot (marked stale) when it isn't.
 */

const {
    SlashCommandBuilder,
    EmbedBuilder
} = require('discord.js');
const yggdrasil = require('../../modules/yggdrasil');
const sessionLogger = require('../../modules/sessionLogger');

/** slots 0-35 main, 36-39 armor, 40 offhand, 100+ ender chest */
function slotLabel(slot) {
    if (slot >= 100) return `E${slot - 100}`;
    if (slot === 40) return 'offhand';
    if (slot >= 36) return ['boots', 'legs', 'chest', 'helm'][slot - 36];
    return `${slot}`;
}

function itemLines(items) {
    return items.map(i => `\`${slotLabel(i.slot).padStart(7)}\` ${i.id} ×${i.count}`);
}

/** Discord embed fields cap at 1024 chars — chunk the lines. */
function addChunkedFields(embed, title, lines) {
    if (lines.length === 0) {
        embed.addFields({ name: title, value: '*empty*' });
        return;
    }
    let chunk = [];
    let len = 0;
    let part = 1;
    const flush = () => {
        if (chunk.length === 0) return;
        embed.addFields({ name: part === 1 ? title : `${title} (${part})`, value: chunk.join('\n') });
        chunk = []; len = 0; part++;
    };
    for (const line of lines) {
        if (len + line.length + 1 > 1000) flush();
        chunk.push(line);
        len += line.length + 1;
    }
    flush();
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('inventory')
        .setDescription('Show a player\'s inventory via the server link!')
        .setDefaultMemberPermissions(1099511627776)
        .addStringOption(option =>
            option.setName('player')
            .setDescription('Player name or UUID')
            .setRequired(true))
        .addStringOption(option =>
            option.setName('server')
            .setDescription('Server tag or id')
            .setRequired(true))
        .setDMPermission(false),

    async execute(interaction) {
        const player = interaction.options.getString('player');
        const server = interaction.options.getString('server');
        await interaction.deferReply();

        let data;
        try {
            data = await yggdrasil.getPlayerInventory(server, player);
        } catch (err) {
            const msg = err.response?.status === 404
                ? `No inventory found for **${player}** on **${server}** (never linked/snapshotted).`
                : `❌ ${err.message}`;
            await interaction.editReply(msg);
            return;
        }

        const embed = new EmbedBuilder()
            .setColor(data.stale ? 0xe67e22 : 0x2ecc71)
            .setTimestamp();

        const src = data.source === 'live' ? data.inventory : data.snapshot;
        if (!src) {
            await interaction.editReply(`❌ Empty response for **${player}** on **${server}**.`);
            return;
        }

        const items = src.items || [];
        const inv = items.filter(i => i.slot < 100);
        const ender = items.filter(i => i.slot >= 100);

        embed.setTitle(`${src.name || player} — ${server}`);
        if (data.source === 'live') {
            embed.setDescription(`🟢 Live (\`${src.dim}\` @ ${src.pos?.map(n => Math.round(n)).join(', ')})`);
        } else {
            embed.setDescription(
                `🟠 **Stale snapshot** — player offline, showing \`${src.reason}\` snapshot from ` +
                `<t:${Math.floor(new Date(src.takenAt).getTime() / 1000)}:R> (\`${src.dim}\`)`);
        }
        addChunkedFields(embed, 'Inventory', itemLines(inv));
        addChunkedFields(embed, 'Ender Chest', itemLines(ender));

        try {
            await interaction.editReply({ embeds: [embed] });
        } catch (err) {
            sessionLogger.error('Inventory', 'Failed to send embed:', err.message);
            await interaction.editReply(`❌ Embed too large — ${items.length} items. (${err.message})`);
        }
    }
};
