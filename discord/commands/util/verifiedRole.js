/*
 * File: verifiedRole.js
 * Project: valhalla-updater
 * -----
 * The optional Verified role /link and /unlink keep in sync with the Minecraft link.
 * Off by default: `discordLink.verifiedRoleId` in config/config.json holds the role id,
 * anything else (missing, false) means no role is touched at all.
 *
 * Nothing here may fail a link - the link lives in Mongo and the role is decoration, so
 * every path swallows its own error and logs it. The member is fetched over REST
 * (`guild.members.fetch`), which needs no GuildMembers intent - same as roleAssigner.
 * The bot needs Manage Roles and its own top role above the Verified role.
 */

const sessionLogger = require('../../../modules/sessionLogger');

/**
 * Reads the configured role id.
 * @returns {string|null} The role id, or null when the feature is off (the default).
 */
function getVerifiedRoleId() {
    try {
        const config = require('../../../config/config.json');
        const id = config.discordLink && config.discordLink.verifiedRoleId;
        return typeof id === 'string' && id ? id : null;
    } catch (_) {
        return null; // no config = feature off
    }
}

/**
 * Gives a Discord user the Verified role.
 * @param {object} interaction The guild interaction (its guild is used for the fetch).
 * @param {string} userId Discord id to grant it to.
 * @returns {Promise<'off'|'added'|'failed'>} What happened; never throws.
 */
async function addVerifiedRole(interaction, userId) {
    const roleId = module.exports.getVerifiedRoleId();
    if (!roleId) return 'off';

    try {
        const member = await interaction.guild.members.fetch(userId);
        await member.roles.add(roleId);
        return 'added';
    } catch (error) {
        sessionLogger.error('DiscordLink',
            `Could not add the Verified role ${roleId} to ${userId} (does the bot have Manage Roles, and is its top role above that one?)`,
            error.message);
        return 'failed';
    }
}

/**
 * Takes the Verified role back once a Discord user has no linked accounts left.
 * @param {object} interaction The guild interaction.
 * @param {string} userId Discord id to remove it from.
 * @returns {Promise<'off'|'removed'|'failed'>} What happened; never throws.
 */
async function removeVerifiedRole(interaction, userId) {
    const roleId = module.exports.getVerifiedRoleId();
    if (!roleId) return 'off';

    try {
        const member = await interaction.guild.members.fetch(userId);
        await member.roles.remove(roleId);
        return 'removed';
    } catch (error) {
        sessionLogger.error('DiscordLink',
            `Could not remove the Verified role ${roleId} from ${userId}`, error.message);
        return 'failed';
    }
}

module.exports = { getVerifiedRoleId, addVerifiedRole, removeVerifiedRole };
