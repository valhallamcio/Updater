/*
 * File: inventoryEmbed.js
 * Project: valhalla-updater
 * -----
 * Shared inventory-embed rendering for /inventory and /rescue (the command loader only
 * picks up top-level files in commands/, so this util is never registered as a command).
 */

const { EmbedBuilder } = require('discord.js');

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

/**
 * Build the standard inventory embed from a GET .../inventory response (live = green,
 * stale snapshot = orange). Returns null when the response carries no inventory.
 */
function buildInventoryEmbed(data, player, server) {
    const src = data.source === 'live' ? data.inventory : data.snapshot;
    if (!src) return null;

    const embed = new EmbedBuilder()
        .setColor(data.stale ? 0xe67e22 : 0x2ecc71)
        .setTimestamp();

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
    return { embed, itemCount: items.length };
}

module.exports = { slotLabel, itemLines, addChunkedFields, buildInventoryEmbed };
