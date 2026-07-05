/*
 * File: give-item.js
 * Project: valhalla-updater
 * -----
 * Give items to a player via the biforesting link (v2 phase 5). Offline targets
 * queue durably and fire on the player's next login. The `id` option autocompletes
 * from the server's item registry (v2 phase 8) — legacy metaitem variants show as
 * `id@meta`. NBT items: use /execute /give.
 */

const {
    SlashCommandBuilder,
    EmbedBuilder
} = require('discord.js');
const yggdrasil = require('../../modules/yggdrasil');

/** Discord caps choice name + value at 100 chars — "Display (id)", truncated to fit. */
function label(display, id) {
    const full = `${display} (${id})`;
    return full.length <= 100 ? full : full.slice(0, 97) + '…';
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('give-item')
        .setDescription('Give items to a player via the server link!')
        .setDefaultMemberPermissions(1099511627776)
        .addStringOption(o => o.setName('player').setDescription('Player name').setRequired(true))
        .addStringOption(o => o.setName('server').setDescription('Server tag or id').setRequired(true))
        .addStringOption(o => o.setName('id').setDescription('Item id (legacy meta as id@meta)').setRequired(true).setAutocomplete(true))
        .addIntegerOption(o => o.setName('count').setDescription('How many (default 1)'))
        .addStringOption(o => o.setName('overflow').setDescription('When inventory is full')
            .addChoices({ name: 'fail (default)', value: 'fail' }, { name: 'drop at feet', value: 'drop' }))
        .setDMPermission(false),

    // Item-id autocomplete off the server's registry (phase 8). Needs the `server` option filled
    // first (the registry is per-instance); otherwise it hints to pick a server. Must respond
    // within 3s — the search endpoint is indexed, and any error falls back to an empty list.
    async autocomplete(interaction) {
        const focused = interaction.options.getFocused(true);
        if (focused.name !== 'id') return interaction.respond([]);
        const server = interaction.options.getString('server');
        if (!server) {
            return interaction.respond([{ name: 'Pick a server first, then search items…', value: focused.value || 'minecraft:stone' }]);
        }
        const query = (focused.value || '').trim();
        try {
            const data = await yggdrasil.searchItems(server, query || undefined, 25);
            const choices = [];
            for (const it of data.items ?? []) {
                if (Array.isArray(it.variants) && it.variants.length > 0) {
                    // legacy metaitem — surface each variant as id@meta (narrow by the typed text)
                    const q = query.toLowerCase();
                    const variants = q
                        ? it.variants.filter(v => `${v.display} ${it.id}`.toLowerCase().includes(q))
                        : it.variants;
                    for (const v of (variants.length ? variants : it.variants)) {
                        choices.push({ name: label(`${v.display}`, `${it.id}@${v.meta}`), value: `${it.id}@${v.meta}` });
                        if (choices.length >= 25) break;
                    }
                } else {
                    choices.push({ name: label(it.display || it.id, it.id), value: it.id });
                }
                if (choices.length >= 25) break;
            }
            // Discord rejects the whole response if any value exceeds 100 chars — drop those.
            return interaction.respond(choices.filter(c => c.value.length <= 100).slice(0, 25));
        } catch (err) {
            return interaction.respond([]);
        }
    },

    async execute(interaction) {
        const player = interaction.options.getString('player');
        const server = interaction.options.getString('server');
        const params = { id: interaction.options.getString('id') };
        const count = interaction.options.getInteger('count');
        const overflow = interaction.options.getString('overflow');
        if (count) params.count = count;
        if (overflow) params.overflow = overflow;

        await interaction.deferReply();
        try {
            const doc = await yggdrasil.runOp(server, {
                type: 'give_item',
                params,
                target: { name: player }
            }, 15000);
            const res = doc.result?.data;
            if (doc.state === 'completed') {
                await interaction.editReply({
                    embeds: [new EmbedBuilder().setColor(0x2ecc71)
                        .setTitle(`Gave ${res?.given ?? '?'}× ${params.id} to ${res?.player ?? player}`)
                        .setDescription(res?.full ? '⚠️ Inventory filled up — gave a partial amount.' : null)]
                });
            } else if (doc.state === 'waiting_player') {
                await interaction.editReply(`📬 **${player}** is offline — queued, delivers on their next login (op \`${doc._id}\`).`);
            } else {
                await interaction.editReply(`Give ${doc.state}: ${doc.result?.error ?? 'see /ops'}`);
            }
        } catch (err) {
            // runOp times out while the op is parked waiting_player — that's the queued case
            if (String(err.message).includes('not terminal')) {
                await interaction.editReply(`📬 **${player}** is offline — queued, delivers on their next login.`);
                return;
            }
            await interaction.editReply(`❌ ${err.response?.data?.error?.message ?? err.message}`);
        }
    }
};
