/*
 * File: account-reset.js
 * Project: valhalla-updater
 * -----
 * Full account reset via the biforesting compound op (v2 phase 7): snapshot -> quest
 * reset -> claims transfer/release -> team reset -> inventory clear, one checkpointed
 * chain. Dangerous tier: staff must TYPE THE PLAYER NAME to confirm. Live per-child
 * progress via the ops WS events; a failed chain names its checkpoint and can be
 * resumed with the button (fresh child, completed steps stay done).
 */

const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const yggdrasil = require('../../modules/yggdrasil');
const sessionLogger = require('../../modules/sessionLogger');

const CHAIN = ['inspect_inventory (snapshot)', 'quest_reset (ALL)', 'claims', 'team_reset', 'inventory_clear'];

function progressEmbed(player, server, children, state) {
    const lines = CHAIN.map((label, i) => {
        const child = children.find(c => c.childIndex === i);
        const mark = !child ? '·' : child.state === 'completed' ? '✅'
            : ['failed', 'expired', 'cancelled'].includes(child.state) ? '❌'
                : child.state === 'waiting_player' ? '⏸ (waiting for login)' : '⏳';
        return `${mark} ${label}`;
    });
    const color = state === 'completed' ? 0x2ecc71 : state === 'failed' ? 0xe74c3c : 0xf39c12;
    return new EmbedBuilder()
        .setColor(color)
        .setTitle(`Account reset — ${player} on ${server} (${state})`)
        .setDescription(lines.join('\n'));
}

async function watchChain(interaction, opId, player, server) {
    for (let i = 0; i < 150; i++) { // ~5 min at 2s
        let doc;
        try {
            doc = await yggdrasil.getOp(opId);
        } catch {
            await new Promise(r => setTimeout(r, 2000));
            continue;
        }
        const children = doc.result?.data?.children ?? doc.children ?? [];
        // live child states come from listing (result only lands terminally)
        let liveChildren = children;
        try {
            const ops = await yggdrasil.listOps(server, { limit: 50 });
            liveChildren = ops.filter(o => o.parentOpId === opId)
                .map(o => ({ childIndex: o.childIndex, state: o.state, type: o.type }));
        } catch { /* keep terminal summary */ }

        const components = [];
        if (doc.state === 'failed') {
            components.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('resume').setLabel('Resume from checkpoint').setStyle(ButtonStyle.Primary)));
        }
        const msg = await interaction.editReply({
            embeds: [progressEmbed(player, server, liveChildren, doc.state)],
            components
        });

        if (doc.state === 'completed') return;
        if (doc.state === 'failed') {
            let press;
            try {
                press = await msg.awaitMessageComponent({
                    filter: i2 => i2.user.id === interaction.user.id,
                    time: 300000
                });
            } catch {
                return; // no resume click — leave the failed embed
            }
            await press.update({ components: [] });
            try {
                await yggdrasil.resumeOp(opId);
            } catch (err) {
                await interaction.followUp(`❌ Resume failed: ${err.response?.data?.error?.message ?? err.message}`);
                return;
            }
            continue; // keep watching the resumed chain
        }
        await new Promise(r => setTimeout(r, 2000));
    }
    await interaction.followUp('⏳ Still running after 5 min — check `/ops` later (waiting_player children finish on next login).');
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('account-reset')
        .setDescription('FULL account reset: quests, claims, team, inventory (dangerous!)')
        .setDefaultMemberPermissions(1099511627776)
        .addStringOption(o => o.setName('player').setDescription('Player name').setRequired(true))
        .addStringOption(o => o.setName('server').setDescription('Server tag or id').setRequired(true))
        .addStringOption(o => o.setName('claims').setDescription('transfer (default, to hold team) | release')
            .addChoices({ name: 'transfer', value: 'transfer' }, { name: 'release', value: 'release' }))
        .addStringOption(o => o.setName('holdteam').setDescription('Hold team name (default valhallamc)'))
        .setDMPermission(false),

    async execute(interaction) {
        const player = interaction.options.getString('player');
        const server = interaction.options.getString('server');
        const claims = interaction.options.getString('claims');
        const holdTeam = interaction.options.getString('holdteam');

        // dangerous tier: type the player name to confirm
        const modal = new ModalBuilder()
            .setCustomId('account-reset-confirm')
            .setTitle(`Reset ${player}'s account?`)
            .addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('typed')
                    .setLabel(`Type "${player.slice(0, 38)}" to confirm`)
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)));
        await interaction.showModal(modal);

        let submitted;
        try {
            submitted = await interaction.awaitModalSubmit({
                filter: i => i.user.id === interaction.user.id && i.customId === 'account-reset-confirm',
                time: 60000
            });
        } catch {
            return; // modal timed out
        }
        const typed = submitted.fields.getTextInputValue('typed');
        if (typed.toLowerCase() !== player.toLowerCase()) {
            await submitted.reply({ content: `❌ Name mismatch ("${typed}" ≠ "${player}") — aborted.`, ephemeral: true });
            return;
        }
        await submitted.deferReply();

        const params = {};
        if (claims) params.claims = claims;
        if (holdTeam) params.holdTeam = holdTeam;
        let created;
        try {
            created = await yggdrasil.createOp(server, {
                type: 'account_reset',
                params,
                target: { name: player }
            });
        } catch (err) {
            sessionLogger.error('AccountReset', 'create failed:', err.message);
            await submitted.editReply(`❌ Failed to start: ${err.response?.data?.error?.message ?? err.message}`);
            return;
        }
        sessionLogger.info('AccountReset', `${interaction.user.tag} started account_reset ${created.op._id} for ${player} on ${server}`);
        await watchChain(submitted, created.op._id, player, server);
    }
};
