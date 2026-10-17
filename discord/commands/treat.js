/*
 * /treat player:<name>
 *
 * Halloween 2026, item E13. A linked player sends an in-game friend one cake from their
 * own bank. This writes one row into bifrost.halloween_discord_treats. The proxy delivers
 * it when the friend is online and marks it done or failed. The checks and the texts live
 * in modules/halloweenTreat.js. Every reply is ephemeral.
 *
 * config.json may move the window: `halloween.treat.opensAt` and `closesAt`, ISO strings.
 */

const { SlashCommandBuilder } = require('discord.js');
const mongo = require('../../modules/mongo');
const sessionLogger = require('../../modules/sessionLogger');
const { createTreat } = require('../../modules/halloweenTreat');
const linkFlow = require('./util/linkFlow');

const LOG = 'Treat';

// One service for the process: its busy set must see every send.
let service = null;

function treatConfig() {
    try {
        const config = require('../../config/config.json');
        return (config.halloween && config.halloween.treat) || null;
    } catch (_) {
        return null;
    }
}

function getService() {
    if (!service) {
        service = createTreat({
            db: () => mongo.getBifrostDb(),
            linkChannelId: () => linkFlow.linkChannelId(),
            window: treatConfig(),
            log: message => sessionLogger.warn(LOG, message)
        });
    }
    return service;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('treat')
        .setDescription('Halloween: send an in-game friend one cake from your bank')
        .setDMPermission(false)
        .addStringOption(option =>
            option.setName('player')
                .setDescription('Their Minecraft name')
                .setRequired(true)
                .setMaxLength(32)),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const treat = getService();
        let result;
        try {
            result = await treat.send(interaction.user.id, interaction.options.getString('player'));
        } catch (error) {
            sessionLogger.error(LOG, `A treat from ${interaction.user.id} failed`, error.message);
            await interaction.editReply('Something went wrong. Your treat was not sent. Try again later.');
            return;
        }

        await interaction.editReply({
            content: result.text,
            components: result.reason === 'not_linked' ? [linkFlow.buildOpenRow()] : [],
            allowedMentions: { parse: [] }
        });
        if (result.reason !== 'sent') return;
        sessionLogger.info(LOG, `${interaction.user.username} (${interaction.user.id}) sent a treat to ${result.targetName}`);

        const outcome = await treat.watch(result.id, result.targetName);
        if (!outcome) return;
        try {
            await interaction.editReply({ content: outcome, components: [], allowedMentions: { parse: [] } });
        } catch (error) {
            sessionLogger.warn(LOG, 'Could not edit a treat reply with its outcome', error.message);
        }
    },

    _internals: {
        /** Tests hand in a service over a fake db and clock. Null goes back to the real one. */
        setService(next) {
            service = next;
        }
    }
};
