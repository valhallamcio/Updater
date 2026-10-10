const {
    SlashCommandBuilder,
    EmbedBuilder
} = require('discord.js');
const mongo = require('../../modules/mongo');
const yggdrasil = require('../../modules/yggdrasil');
const pterodactyl = require('../../modules/pterodactyl');
const serverTargets = require('../../modules/serverTargets');
const playerEvents = require('../../schedulers/playerEventScheduler');
const { sleep } = require('../../modules/functions');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('schedule-execute')
        .setDescription('Manually execute specific scheduled operations')
        .setDefaultMemberPermissions(1099511627776) // ModerateMembers, the same bar as /execute: this runs raw console lines
        .addSubcommand(subcommand =>
            subcommand
                .setName('player-trigger')
                .setDescription('Manually execute a player trigger')
                .addStringOption(option =>
                    option.setName('trigger_id')
                        .setDescription('Trigger ID to execute')
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('server')
                        .setDescription('Server to execute on (if not specified, uses trigger config)')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('server-command')
                .setDescription('Execute a command on specific servers with retry logic')
                .addStringOption(option =>
                    option.setName('servers')
                        .setDescription('Server names (comma-separated, or "all")')
                        .setRequired(true)
                        .setAutocomplete(true))
                .addStringOption(option =>
                    option.setName('command')
                        .setDescription('Command to execute')
                        .setRequired(true))
                .addIntegerOption(option =>
                    option.setName('delay')
                        .setDescription('Delay between commands in seconds (default: 1)')
                        .setRequired(false)
                        .setMinValue(0)
                        .setMaxValue(60)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('test-reboot-warnings')
                .setDescription('Test reboot warning sequence on a server (TESTING ONLY)')
                .addStringOption(option =>
                    option.setName('server')
                        .setDescription('Server name to test on')
                        .setRequired(true)
                        .setAutocomplete(true))
                .addBooleanOption(option =>
                    option.setName('confirm')
                        .setDescription('Confirm you want to run test warnings')
                        .setRequired(true)))
        .setDMPermission(false),

    async autocomplete(interaction) {
        const focusedOption = interaction.options.getFocused(true);

        if (focusedOption.name === 'servers' || focusedOption.name === 'server') {
            // A tag runs on every instance of the pack. An instance choice runs on that one only.
            const serverList = (await yggdrasil.getServers(yggdrasil.SERVER_LIST_MAX_AGE_MS))
                .filter(server => !server.excludeFromServerList);
            const extra = focusedOption.name === 'servers' ? ['all'] : [];
            await interaction.respond(serverTargets.autocompleteChoices(serverList, focusedOption.value, extra));
        }
    },

    async execute(interaction) {
        await interaction.deferReply();
        
        const subcommand = interaction.options.getSubcommand();
        
        try {
            switch (subcommand) {
                case 'player-trigger':
                    await this.executePlayerTrigger(interaction);
                    break;
                case 'server-command':
                    await this.executeServerCommand(interaction);
                    break;
                case 'test-reboot-warnings':
                    await this.testRebootWarnings(interaction);
                    break;
                default:
                    await interaction.editReply('Unknown subcommand!');
            }
        } catch (error) {
            console.error('Error in schedule-execute command:', error.message);
            await interaction.editReply('An error occurred while executing the command.');
        }
    },

    /**
     * The instances a player trigger runs on. A trigger fires at most once per tag: on a tag with
     * several instances it runs on the one the player stands on, and on none when the player is
     * on none of them. A name or a Pterodactyl id names one instance.
     * @param {object} trigger The player_trigger job.
     * @param {string|null} serverOverride The server option.
     * @param {Array} allServers Server docs from Yggdrasil.
     * @param {Function} getDetailed Returns `getPlayersDetailed()` rows by tag.
     * @returns {Promise<{servers: Array, skipped: Array<string>}>}
     */
    async playerTriggerTargets(trigger, serverOverride, allServers, getDetailed) {
        const ids = serverOverride ? [serverOverride] : playerEvents.triggerIds(trigger);
        const servers = [];
        const skipped = [];
        let detailed = null;
        for (const id of ids) {
            const found = serverTargets.resolveTargets(allServers, id);
            if (found.servers.length === 0) {
                skipped.push(`❓ ${id}: ${found.error || 'not found'}`);
                continue;
            }
            let server = found.servers.length === 1 ? found.servers[0] : null;
            if (!server) {
                detailed = detailed || await getDetailed();
                server = playerEvents.standingInstance(detailed, allServers, found.servers[0].tag, trigger.playerId);
                if (!server) {
                    skipped.push(`⏸️ ${id}: ${trigger.playerId} is not on any of its ${found.servers.length} instances`);
                    continue;
                }
            }
            if (!servers.some(s => s.serverId === server.serverId)) servers.push(server);
        }
        return { servers, skipped };
    },

    async executePlayerTrigger(interaction, deps = {}) {
        const triggerId = interaction.options.getString('trigger_id');
        const serverOverride = interaction.options.getString('server');
        const db = deps.mongo || mongo;
        const ygg = deps.yggdrasil || yggdrasil;
        const panel = deps.pterodactyl || pterodactyl;
        const pause = deps.sleep || sleep;

        try {
            // Get the trigger
            const allJobs = await db.getAllScheduleJobs();
            const trigger = allJobs.find(job => job._id.toString() === triggerId && job.type === 'player_trigger');

            if (!trigger) {
                await interaction.editReply('❌ Player trigger not found!');
                return;
            }

            if (!trigger.active) {
                await interaction.editReply('❌ This trigger is disabled!');
                return;
            }

            const allServers = await ygg.getServers();
            const { servers: serversToExecute, skipped } = await this.playerTriggerTargets(
                trigger, serverOverride, allServers, () => ygg.getPlayersDetailed());

            if (serversToExecute.length === 0) {
                await interaction.editReply(['❌ No valid servers found for execution!', ...skipped].join('\n').slice(0, 2000));
                return;
            }

            // The same claim the scheduler takes. A oneTime trigger that the scheduler or another
            // staff member already ran, or that the proxy cancelled, does not run again.
            const firedOn = serversToExecute.length === 1 ? serversToExecute[0].serverId : null;
            const claim = await db.claimScheduleJob(trigger._id, Boolean(trigger.oneTime), firedOn);
            if (claim && claim.matchedCount === 0) {
                await interaction.editReply('❌ This trigger already ran or was cancelled. Nothing was sent.');
                return;
            }

            // Execute commands
            let successCount = 0;
            let failCount = 0;
            const results = [];

            for (const server of serversToExecute) {
                try {
                    for (const command of trigger.commands) {
                        await panel.sendCommand(server.serverId, command);
                        await pause(1000); // 1 second delay between commands
                    }
                    successCount++;
                    results.push(`✅ ${server.name}: Success`);
                } catch (error) {
                    failCount++;
                    results.push(`❌ ${server.name}: Failed - ${error.message}`);
                }
            }
            results.push(...skipped);

            // Mark as executed if one-time
            if (trigger.oneTime) {
                await db.deactivateScheduleJob(trigger._id);
            }

            const embed = new EmbedBuilder()
                .setColor(failCount === 0 && skipped.length === 0 ? 0x00ff00 : 0xffa500)
                .setTitle('⚡ Player Trigger Executed')
                .addFields(
                    { name: 'Trigger ID', value: triggerId, inline: true },
                    { name: 'Player', value: trigger.playerId, inline: true },
                    { name: 'Executed By', value: interaction.user.username, inline: true },
                    { name: 'Success Rate', value: `${successCount}/${serversToExecute.length}`, inline: true },
                    { name: 'Commands', value: trigger.commands.join('\n').slice(0, 1024), inline: false },
                    { name: 'Results', value: results.slice(0, 10).join('\n').slice(0, 1024), inline: false }
                )
                .setTimestamp();

            if (results.length > 10) {
                embed.setFooter({ text: `Showing 10 of ${results.length} results` });
            }
            
            await interaction.editReply({ embeds: [embed] });
            
        } catch (error) {
            console.error('Error executing player trigger:', error.message);
            await interaction.editReply('❌ Failed to execute player trigger.');
        }
    },

    /**
     * The instances a comma-separated server list names. A tag gives every instance of the
     * pack. An instance is listed once even when two entries name it.
     * @returns {{servers: Array, unknown: Array<string>}}
     */
    serverCommandTargets(allServers, serversInput) {
        if (serversInput.toLowerCase() === 'all') {
            return { servers: allServers.filter(s => !s.excludeFromServerList), unknown: [] };
        }
        const servers = [];
        const unknown = [];
        for (const serverName of serversInput.split(',').map(s => s.trim()).filter(Boolean)) {
            const found = serverTargets.resolveTargets(allServers, serverName);
            if (found.servers.length === 0) unknown.push(`❓ ${serverName}: ${found.error || 'not found'}`);
            for (const server of found.servers) {
                if (!servers.some(s => s.serverId === server.serverId)) servers.push(server);
            }
        }
        return { servers, unknown };
    },

    async executeServerCommand(interaction, deps = {}) {
        const serversInput = interaction.options.getString('servers');
        const command = interaction.options.getString('command');
        const delay = (interaction.options.getInteger('delay') || 1) * 1000;
        const ygg = deps.yggdrasil || yggdrasil;
        const panel = deps.pterodactyl || pterodactyl;
        const pause = deps.sleep || sleep;

        // Parse servers
        const allServers = await ygg.getServers();
        const { servers: serversToExecute, unknown } = this.serverCommandTargets(allServers, serversInput);

        if (serversToExecute.length === 0) {
            await interaction.editReply(['❌ No valid servers found!', ...unknown].join('\n').slice(0, 2000));
            return;
        }

        // Execute command with progress tracking
        let successCount = 0;
        let failCount = 0;
        const results = [];
        
        const embed = new EmbedBuilder()
            .setColor(0xffa500)
            .setTitle('⚡ Executing Server Commands')
            .addFields(
                { name: 'Command', value: command, inline: false },
                { name: 'Servers', value: `${serversToExecute.length} servers`, inline: true },
                { name: 'Progress', value: '0%', inline: true },
                { name: 'Status', value: 'Starting...', inline: true }
            )
            .setTimestamp();
        
        await interaction.editReply({ embeds: [embed] });
        
        for (let i = 0; i < serversToExecute.length; i++) {
            const server = serversToExecute[i];
            
            try {
                await panel.sendCommand(server.serverId, command);
                successCount++;
                results.push(`✅ ${server.name}`);
            } catch (error) {
                failCount++;
                results.push(`❌ ${server.name}: ${error.message}`);
            }

            // Update progress every 5 servers or at the end
            if ((i + 1) % 5 === 0 || i === serversToExecute.length - 1) {
                const progress = Math.round(((i + 1) / serversToExecute.length) * 100);
                embed.data.fields[2].value = `${progress}%`;
                embed.data.fields[3].value = `${successCount} success, ${failCount} failed`;

                try {
                    await interaction.editReply({ embeds: [embed] });
                } catch (editError) {
                    // Ignore edit errors
                }
            }

            if (delay > 0 && i < serversToExecute.length - 1) {
                await pause(delay);
            }
        }
        results.push(...unknown);

        // Final result
        const finalEmbed = new EmbedBuilder()
            .setColor(failCount === 0 && unknown.length === 0 ? 0x00ff00 : 0xffa500)
            .setTitle('✅ Server Command Execution Complete')
            .addFields(
                { name: 'Command', value: command, inline: false },
                { name: 'Success Rate', value: `${successCount}/${serversToExecute.length}`, inline: true },
                { name: 'Executed By', value: interaction.user.username, inline: true },
                { name: 'Delay Between Commands', value: `${delay / 1000}s`, inline: true },
                { name: 'Results', value: results.slice(0, 20).join('\n').slice(0, 1024), inline: false }
            )
            .setTimestamp();

        if (results.length > 20) {
            finalEmbed.setFooter({ text: `Showing 20 of ${results.length} results` });
        }

        await interaction.editReply({ embeds: [finalEmbed] });
    },

    async testRebootWarnings(interaction) {
        const serverName = interaction.options.getString('server');
        const confirmed = interaction.options.getBoolean('confirm');

        if (!confirmed) {
            await interaction.editReply('❌ You must confirm to run test warnings!');
            return;
        }

        // A tag tests every instance of the pack. An instance choice tests that one only.
        const allServers = await yggdrasil.getServers();
        const { servers: targets, error } = serverTargets.resolveTargets(allServers, serverName);

        if (targets.length === 0) {
            await interaction.editReply(`❌ ${error || 'Server not found!'}`);
            return;
        }
        const label = targets.map(s => s.name).join(', ').slice(0, 1024);

        // Test warnings (shorter delays for testing)
        const testWarnings = [
            { command: 'say [TEST] REBOOT WARNING TEST - 30 SECONDS', delay: 5000 },
            { command: 'say [TEST] REBOOT WARNING TEST - 20 SECONDS', delay: 5000 },
            { command: 'say [TEST] REBOOT WARNING TEST - 10 SECONDS', delay: 5000 },
            { command: 'say [TEST] REBOOT WARNING TEST - 5 SECONDS', delay: 3000 },
            { command: 'say [TEST] REBOOT WARNING TEST COMPLETE - NO ACTUAL REBOOT', delay: 2000 }
        ];
        
        const embed = new EmbedBuilder()
            .setColor(0xffa500)
            .setTitle('🧪 Testing Reboot Warnings')
            .addFields(
                { name: 'Server', value: label, inline: true },
                { name: 'Warnings', value: testWarnings.length.toString(), inline: true },
                { name: 'Status', value: 'Starting...', inline: true }
            )
            .setTimestamp();
        
        await interaction.editReply({ embeds: [embed] });
        
        try {
            for (let i = 0; i < testWarnings.length; i++) {
                const warning = testWarnings[i];
                
                for (const target of targets) {
                    await pterodactyl.sendCommand(target.serverId, warning.command);
                }

                // Update progress
                embed.data.fields[2].value = `Warning ${i + 1}/${testWarnings.length}`;
                try {
                    await interaction.editReply({ embeds: [embed] });
                } catch (editError) {
                    // Ignore edit errors
                }
                
                if (i < testWarnings.length - 1) {
                    await sleep(warning.delay);
                }
            }
            
            // Final result
            const finalEmbed = new EmbedBuilder()
                .setColor(0x00ff00)
                .setTitle('✅ Reboot Warning Test Complete')
                .addFields(
                    { name: 'Server', value: label, inline: true },
                    { name: 'Warnings Sent', value: testWarnings.length.toString(), inline: true },
                    { name: 'Status', value: 'All warnings sent successfully', inline: true }
                )
                .setDescription('**NOTE:** This was only a test. No actual reboot was performed.')
                .setTimestamp();
            
            await interaction.editReply({ embeds: [finalEmbed] });
            
        } catch (error) {
            console.error('Error during reboot warning test:', error.message);
            await interaction.editReply('❌ Failed to complete reboot warning test.');
        }
    },

};