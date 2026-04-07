const {
    SlashCommandBuilder,
    EmbedBuilder
} = require('discord.js');
const mongo = require('../../modules/mongo');
const yggdrasil = require('../../modules/yggdrasil');
const pterodactyl = require('../../modules/pterodactyl');
const { sleep } = require('../../modules/functions');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('schedule-execute')
        .setDescription('Manually execute specific scheduled operations')
        .setDefaultMemberPermissions(16)
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
            const focusedValue = focusedOption.value;
            const serverList = await yggdrasil.getServers();
            const choices = focusedOption.name === 'servers' ? ["all"] : [];

            for (const server of serverList) {
                if (!server.excludeFromServerList) {
                    // Trim and ensure server name doesn't exceed Discord's 25-character limit
                    let serverName = server.name.trim();
                    if (serverName.length > 20) {
                        serverName = serverName.substring(0, 20) + "..."; // 20 + 3 = 23 chars (safely under 25)
                    }
                    choices.push(serverName);
                }
            }

            const filtered = choices.filter(choice => choice.toLowerCase().includes(focusedValue.toLowerCase()));
            // Discord has a maximum of 25 autocomplete choices - already limited but adding comment for clarity
            await interaction.respond(
                filtered.slice(0, 25).map(choice => ({
                    name: choice,
                    value: choice
                })),
            );
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

    async executePlayerTrigger(interaction) {
        const triggerId = interaction.options.getString('trigger_id');
        const serverOverride = interaction.options.getString('server');
        
        try {
            // Get the trigger
            const { ObjectId } = require('mongodb');
            const allJobs = await mongo.getAllScheduleJobs();
            const trigger = allJobs.find(job => job._id.toString() === triggerId && job.type === 'player_trigger');
            
            if (!trigger) {
                await interaction.editReply('❌ Player trigger not found!');
                return;
            }
            
            if (!trigger.active) {
                await interaction.editReply('❌ This trigger is disabled!');
                return;
            }
            
            // Determine servers to execute on
            let serverNames = trigger.serverNames;
            if (serverOverride) {
                serverNames = [serverOverride];
            }
            
            // Get server data
            const allServers = await yggdrasil.getServers();
            const serversToExecute = [];
            
            for (const serverName of serverNames) {
                let server = allServers.find(s => 
                    s.name.trim() === serverName.trim() ||
                    s.name.trim().toLowerCase() === serverName.trim().toLowerCase() ||
                    s.tag === serverName.toLowerCase()
                );
                
                // If not found and name ends with "...", try matching by prefix (for truncated names)
                if (!server && serverName.endsWith('...')) {
                    const prefix = serverName.substring(0, serverName.length - 3);
                    server = allServers.find(s =>
                        s.name.trim().startsWith(prefix) ||
                        (s.tag && s.tag.toLowerCase().startsWith(prefix.toLowerCase()))
                    );
                }
                
                if (server) {
                    serversToExecute.push(server);
                }
            }
            
            if (serversToExecute.length === 0) {
                await interaction.editReply('❌ No valid servers found for execution!');
                return;
            }
            
            // Execute commands
            let successCount = 0;
            let failCount = 0;
            const results = [];
            
            for (const server of serversToExecute) {
                try {
                    for (const command of trigger.commands) {
                        await pterodactyl.sendCommand(server.serverId, command);
                        await sleep(1000); // 1 second delay between commands
                    }
                    successCount++;
                    results.push(`✅ ${server.name}: Success`);
                } catch (error) {
                    failCount++;
                    results.push(`❌ ${server.name}: Failed - ${error.message}`);
                }
            }
            
            // Mark as executed if one-time
            if (trigger.oneTime) {
                await mongo.deactivateScheduleJob(new ObjectId(triggerId));
            }
            
            const embed = new EmbedBuilder()
                .setColor(failCount === 0 ? 0x00ff00 : 0xffa500)
                .setTitle('⚡ Player Trigger Executed')
                .addFields(
                    { name: 'Trigger ID', value: triggerId, inline: true },
                    { name: 'Player', value: trigger.playerId, inline: true },
                    { name: 'Executed By', value: interaction.user.username, inline: true },
                    { name: 'Success Rate', value: `${successCount}/${serversToExecute.length}`, inline: true },
                    { name: 'Commands', value: trigger.commands.join('\n'), inline: false },
                    { name: 'Results', value: results.slice(0, 10).join('\n'), inline: false }
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

    async executeServerCommand(interaction) {
        const serversInput = interaction.options.getString('servers');
        const command = interaction.options.getString('command');
        const delay = (interaction.options.getInteger('delay') || 1) * 1000;
        
        // Parse servers
        const allServers = await yggdrasil.getServers();
        let serversToExecute = [];
        
        if (serversInput.toLowerCase() === 'all') {
            serversToExecute = allServers.filter(s => !s.excludeFromServerList);
        } else {
            const serverNames = serversInput.split(',').map(s => s.trim());
            for (const serverName of serverNames) {
                let server = allServers.find(s => 
                    s.name.trim() === serverName.trim() ||
                    s.name.trim().toLowerCase() === serverName.trim().toLowerCase() ||
                    s.tag === serverName.toLowerCase()
                );
                
                // If not found and name ends with "...", try matching by prefix (for truncated names)
                if (!server && serverName.endsWith('...')) {
                    const prefix = serverName.substring(0, serverName.length - 3);
                    server = allServers.find(s =>
                        s.name.trim().startsWith(prefix) ||
                        (s.tag && s.tag.toLowerCase().startsWith(prefix.toLowerCase()))
                    );
                }
                
                if (server) {
                    serversToExecute.push(server);
                }
            }
        }
        
        if (serversToExecute.length === 0) {
            await interaction.editReply('❌ No valid servers found!');
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
                await pterodactyl.sendCommand(server.serverId, command);
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
                await sleep(delay);
            }
        }
        
        // Final result
        const finalEmbed = new EmbedBuilder()
            .setColor(failCount === 0 ? 0x00ff00 : 0xffa500)
            .setTitle('✅ Server Command Execution Complete')
            .addFields(
                { name: 'Command', value: command, inline: false },
                { name: 'Success Rate', value: `${successCount}/${serversToExecute.length}`, inline: true },
                { name: 'Executed By', value: interaction.user.username, inline: true },
                { name: 'Delay Between Commands', value: `${delay / 1000}s`, inline: true },
                { name: 'Results', value: results.slice(0, 20).join('\n'), inline: false }
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
        
        // Find the server
        const allServers = await yggdrasil.getServers();
        let server = allServers.find(s => 
            s.name.trim() === serverName.trim() ||
            s.name.trim().toLowerCase() === serverName.trim().toLowerCase() ||
            s.tag === serverName.toLowerCase()
        );
        
        // If not found and name ends with "...", try matching by prefix (for truncated names)
        if (!server && serverName.endsWith('...')) {
            const prefix = serverName.substring(0, serverName.length - 3);
            server = allServers.find(s =>
                s.name.trim().startsWith(prefix) ||
                (s.tag && s.tag.toLowerCase().startsWith(prefix.toLowerCase()))
            );
        }
        
        if (!server) {
            await interaction.editReply('❌ Server not found!');
            return;
        }
        
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
                { name: 'Server', value: server.name, inline: true },
                { name: 'Warnings', value: testWarnings.length.toString(), inline: true },
                { name: 'Status', value: 'Starting...', inline: true }
            )
            .setTimestamp();
        
        await interaction.editReply({ embeds: [embed] });
        
        try {
            for (let i = 0; i < testWarnings.length; i++) {
                const warning = testWarnings[i];
                
                await pterodactyl.sendCommand(server.serverId, warning.command);
                
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
                    { name: 'Server', value: server.name, inline: true },
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