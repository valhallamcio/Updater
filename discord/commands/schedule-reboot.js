const {
    SlashCommandBuilder,
    EmbedBuilder
} = require('discord.js');
const timeManager = require('../../modules/timeManager');
const mongo = require('../../modules/mongo');
const sessionLogger = require('../../modules/sessionLogger');

// Helper function to safely reply to Discord interactions - NEVER throws
async function safeEditReply(interaction, content) {
    try {
        if (!interaction) return; // Safety check
        return await interaction.editReply(content);
    } catch (error) {
        try {
            sessionLogger.warn('ScheduleRebootCommand', 'Failed to send Discord reply (token likely expired)', error.message);
        } catch (logError) {
            // Even logging failed - fallback to console (guaranteed to work)
            console.warn('Discord reply failed AND logging failed:', error.message, logError.message);
        }
        // Never rethrow - this function must NEVER crash the caller
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('schedule-reboot')
        .setDescription('Manage automatic server reboots')
        .setDefaultMemberPermissions(16)
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('Check current reboot status and timing'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('force')
                .setDescription('Force start reboot sequence immediately'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('enable')
                .setDescription('Enable automatic reboot scheduling'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('disable')
                .setDescription('Disable automatic reboot scheduling'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('history')
                .setDescription('View recent reboot history')
                .addIntegerOption(option =>
                    option.setName('days')
                        .setDescription('Number of days to look back (default: 7)')
                        .setRequired(false)
                        .setMinValue(1)
                        .setMaxValue(30)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('abort')
                .setDescription('Abort current reboot sequence (EMERGENCY)'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('cleanup')
                .setDescription('Emergency cleanup of stuck reboot state (EMERGENCY)'))
        .setDMPermission(false),

    async execute(interaction) {
        await interaction.deferReply();
        
        const subcommand = interaction.options.getSubcommand();
        
        try {
            switch (subcommand) {
                case 'status':
                    await this.showRebootStatus(interaction);
                    break;
                case 'force':
                    await this.forceReboot(interaction);
                    break;
                case 'enable':
                    await this.enableRebootScheduling(interaction);
                    break;
                case 'disable':
                    await this.disableRebootScheduling(interaction);
                    break;
                case 'history':
                    await this.showRebootHistory(interaction);
                    break;
                case 'abort':
                    await this.abortReboot(interaction);
                    break;
                case 'cleanup':
                    await this.emergencyCleanup(interaction);
                    break;
                default:
                    await interaction.editReply('Unknown subcommand!');
            }
        } catch (error) {
            sessionLogger.error('ScheduleRebootCommand', `Error in schedule-reboot ${subcommand}`, error.message);
            
            // Try to respond, but don't crash if Discord interaction has expired
            if (interaction.deferred || interaction.replied) {
                await safeEditReply(interaction, 'An error occurred while processing the command.');
            } else {
                try {
                    await interaction.reply('An error occurred while processing the command.');
                } catch (discordError) {
                    sessionLogger.warn('ScheduleRebootCommand', 'Failed to send error response to Discord', discordError.message);
                }
            }
        }
    },

    async showRebootStatus(interaction) {
        const timeWindow = timeManager.checkRebootWindow();
        const today = timeManager.getTodayDateString();
        const todayStats = await mongo.getRebootHistory(today);
        
        // Get scheduler status
        const config = require('../../config/config.json');
        const isEnabled = config.scheduler.rebootScheduler?.active || false;
        
        const embed = new EmbedBuilder()
            .setColor(0x9c59b6)
            .setTitle('🔄 Reboot System Status')
            .setTimestamp();
        
        // Current time info
        embed.addFields(
            { name: 'Current Time (GMT+3)', value: timeWindow.timeString, inline: true },
            { name: 'In Reboot Window', value: timeWindow.isInWindow ? '✅ Yes' : '❌ No', inline: true },
            { name: 'Scheduler Enabled', value: isEnabled ? '✅ Enabled' : '❌ Disabled', inline: true }
        );
        
        // Today's stats
        if (todayStats) {
            embed.addFields(
                { name: 'Today\'s Status', value: todayStats.rebootCompleted ? '✅ Completed' : todayStats.rebootTriggered ? '🔄 In Progress' : '⏳ Pending', inline: true },
                { name: 'Lowest Player Count', value: todayStats.lowestPlayerCount !== null ? todayStats.lowestPlayerCount.toString() : 'Not recorded', inline: true }
            );
            
            if (todayStats.rebootCompleted) {
                embed.addFields(
                    { name: 'Success Rate', value: `${todayStats.successfulReboots}/${todayStats.totalServers} servers`, inline: true },
                    { name: 'Total Duration', value: timeManager.formatDuration(todayStats.totalDuration || 0), inline: true }
                );
            }
        } else {
            embed.addFields({ name: 'Today\'s Status', value: '⏳ No data yet', inline: true });
        }
        
        // Next window info
        if (!timeWindow.isInWindow) {
            const minutesToNext = timeManager.minutesUntilNextWindow();
            embed.addFields({ name: 'Next Window', value: `In ${Math.floor(minutesToNext / 60)}h ${minutesToNext % 60}m`, inline: true });
        }
        
        await interaction.editReply({ embeds: [embed] });
    },

    async forceReboot(interaction) {
        // Check if reboot is already in progress
        const today = timeManager.getTodayDateString();
        const todayStats = await mongo.getRebootHistory(today);
        
        if (todayStats && todayStats.rebootTriggered && !todayStats.rebootCompleted) {
            await interaction.editReply('❌ A reboot sequence is already in progress!');
            return;
        }
        
        if (todayStats && todayStats.rebootCompleted) {
            await interaction.editReply('❌ Reboot already completed today!');
            return;
        }
        
        // Store the channel ID for later webhook notification
        const channelId = interaction.channelId;
        const userId = interaction.user.id;
        const username = interaction.user.username;
        
        // Trigger manual reboot
        const rebootScheduler = require('../../schedulers/rebootScheduler');
        
        try {
            // First, respond to the interaction immediately
            const embed = new EmbedBuilder()
                .setColor(0xffa500)
                .setTitle('🚨 Manual Reboot Triggered')
                .setDescription('Reboot sequence is being started manually. Check staff channel for progress updates.')
                .addFields(
                    { name: 'Triggered By', value: username, inline: true },
                    { name: 'Time', value: timeManager.getCurrentTimeGMT3().toISOString(), inline: true }
                )
                .setTimestamp();
            
            await interaction.editReply({ embeds: [embed] });
            
            // Store the reboot info in the database for tracking
            await mongo.storeRebootRequest({
                channelId,
                userId,
                username,
                timestamp: new Date().toISOString(),
                completed: false
            });
            
            // Then trigger the reboot sequence
            await rebootScheduler.triggerRebootSequence(
                `Manual trigger by ${username} (${userId})`,
                0, // Player count not relevant for manual trigger
                rebootScheduler.runtimeConfig || rebootScheduler.defaultConfig
            );
            
            // The completion notification will be handled by the rebootScheduler's sendRebootNotification method
            
        } catch (error) {
            sessionLogger.error('ScheduleRebootCommand', 'Error forcing reboot', error.message);
            
            // Try to notify via webhook since the interaction token might have expired
            try {
                const webhook = require('../../discord/webhook');
                await webhook.sendWebhook(channelId, {
                    embeds: [
                        new EmbedBuilder()
                            .setColor(0xff0000)
                            .setTitle('❌ Reboot Sequence Failed')
                            .setDescription(`Failed to complete the reboot sequence: ${error.message}`)
                            .addFields(
                                { name: 'Triggered By', value: username, inline: true },
                                { name: 'Time', value: new Date().toISOString(), inline: true }
                            )
                            .setTimestamp()
                    ]
                });
            } catch (webhookError) {
                sessionLogger.error('ScheduleRebootCommand', 'Failed to send webhook notification', webhookError.message);
            }
            
            // Also try the original reply, but don't worry if it fails
            await safeEditReply(interaction, '❌ Failed to trigger reboot sequence.');
        }
    },

    async enableRebootScheduling(interaction) {
        // Update config
        const config = require('../../config/config.json');
        
        if (!config.scheduler.rebootScheduler) {
            config.scheduler.rebootScheduler = {
                active: true,
                interval: 300,
                maxConcurrentReboots: 4,
                rebootRetryLimit: 3,
                serverStartupTimeout: 20,
                batchingStrategy: "auto",
                maxBatchSize: 12,
                playerThreshold: 250
            };
        } else {
            config.scheduler.rebootScheduler.active = true;
        }
        
        // Write config back
        const fs = require('fs');
        const path = require('path');
        const configPath = path.join(__dirname, '../../config/config.json');
        fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
        
        const embed = new EmbedBuilder()
            .setColor(0x00ff00)
            .setTitle('✅ Reboot Scheduling Enabled')
            .setDescription('Automatic reboot scheduling is now enabled. Servers will be rebooted during optimal windows (9:00-11:00 GMT+3).')
            .setTimestamp();
        
        await interaction.editReply({ embeds: [embed] });
    },

    async disableRebootScheduling(interaction) {
        // Update config
        const config = require('../../config/config.json');
        
        if (config.scheduler.rebootScheduler) {
            config.scheduler.rebootScheduler.active = false;
        }
        
        // Write config back
        const fs = require('fs');
        const path = require('path');
        const configPath = path.join(__dirname, '../../config/config.json');
        fs.writeFileSync(configPath, JSON.stringify(config, null, 4));
        
        const embed = new EmbedBuilder()
            .setColor(0xff0000)
            .setTitle('❌ Reboot Scheduling Disabled')
            .setDescription('Automatic reboot scheduling is now disabled. Only manual reboots will be possible.')
            .setTimestamp();
        
        await interaction.editReply({ embeds: [embed] });
    },

    async showRebootHistory(interaction) {
        const days = interaction.options.getInteger('days') || 7;
        const history = await mongo.getRecentRebootHistory(days);
        
        if (history.length === 0) {
            await interaction.editReply(`No reboot history found for the last ${days} days.`);
            return;
        }
        
        const embed = new EmbedBuilder()
            .setColor(0x9c59b6)
            .setTitle(`📊 Reboot History (Last ${days} days)`)
            .setTimestamp();
        
        for (const record of history.slice(0, 10)) {
            let statusText = '';
            if (record.rebootCompleted) {
                statusText = `✅ Completed - ${record.successfulReboots}/${record.totalServers} servers`;
                if (record.totalDuration) {
                    statusText += ` in ${timeManager.formatDuration(record.totalDuration)}`;
                }
            } else if (record.rebootTriggered) {
                statusText = '🔄 In Progress';
            } else {
                statusText = '⏳ Not Triggered';
            }
            
            const triggerInfo = record.triggerReason || 'Not triggered';
            const playerCount = record.triggerPlayerCount !== undefined ? ` (${record.triggerPlayerCount} players)` : '';
            
            embed.addFields({
                name: `${record.date}`,
                value: `${statusText}\n**Trigger:** ${triggerInfo}${playerCount}`,
                inline: false
            });
        }
        
        if (history.length > 10) {
            embed.setFooter({ text: `Showing 10 of ${history.length} records` });
        }
        
        await interaction.editReply({ embeds: [embed] });
    },

    async abortReboot(interaction) {
        try {
            const rebootScheduler = require('../../schedulers/rebootScheduler');
            const success = await rebootScheduler.abortRebootSequence(
                `Manual abort by ${interaction.user.username} (${interaction.user.id})`
            );
            
            const embed = new EmbedBuilder()
                .setColor(success ? 0xffa500 : 0xff0000)
                .setTitle(success ? '🛑 Reboot Sequence Aborted' : '❌ Abort Failed')
                .setDescription(success ? 
                    'The current reboot sequence has been safely aborted.' : 
                    'Failed to abort reboot sequence or no reboot was in progress.')
                .addFields(
                    { name: 'Requested By', value: interaction.user.username, inline: true },
                    { name: 'Time', value: new Date().toISOString(), inline: true }
                )
                .setTimestamp();
            
            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('Error aborting reboot:', error.message);
            await interaction.editReply('❌ Failed to abort reboot sequence.');
        }
    },

    async emergencyCleanup(interaction) {
        try {
            const rebootScheduler = require('../../schedulers/rebootScheduler');
            const success = await rebootScheduler.emergencyCleanup();
            
            const embed = new EmbedBuilder()
                .setColor(success ? 0x00ff00 : 0xff0000)
                .setTitle(success ? '🚨 Emergency Cleanup Completed' : '❌ Cleanup Failed')
                .setDescription(success ? 
                    'Emergency cleanup has been performed. All stuck reboot states have been cleared.' : 
                    'Emergency cleanup failed. Manual intervention may be required.')
                .addFields(
                    { name: 'Requested By', value: interaction.user.username, inline: true },
                    { name: 'Time', value: new Date().toISOString(), inline: true }
                )
                .setTimestamp();
            
            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('Error during emergency cleanup:', error.message);
            await interaction.editReply('❌ Emergency cleanup failed.');
        }
    }
};