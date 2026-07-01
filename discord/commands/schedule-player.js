const {
    SlashCommandBuilder,
    EmbedBuilder
} = require('discord.js');
const mongo = require('../../modules/mongo');
const yggdrasil = require('../../modules/yggdrasil');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('schedule-player')
        .setDescription('Configure player-triggered commands')
        .setDefaultMemberPermissions(16)
        .addSubcommand(subcommand =>
            subcommand
                .setName('create')
                .setDescription('Create a new player trigger')
                .addStringOption(option =>
                    option.setName('player')
                        .setDescription('Player username to monitor')
                        .setRequired(true)
                        .setAutocomplete(true))
                .addStringOption(option =>
                    option.setName('servers')
                        .setDescription('Server names (comma-separated, or "all")')
                        .setRequired(true)
                        .setAutocomplete(true))
                .addStringOption(option =>
                    option.setName('commands')
                        .setDescription('Commands to execute (separated by ;)')
                        .setRequired(true))
                .addBooleanOption(option =>
                    option.setName('onetime')
                        .setDescription('Execute only once (default: true)')
                        .setRequired(false))
                .addBooleanOption(option =>
                    option.setName('onjoin')
                        .setDescription('Execute only when player joins (not every check)')
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('list')
                .setDescription('List all player triggers'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('disable')
                .setDescription('Disable a player trigger')
                .addStringOption(option =>
                    option.setName('trigger_id')
                        .setDescription('Trigger ID to disable')
                        .setRequired(true)
                        .setAutocomplete(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('delete')
                .setDescription('Delete a player trigger')
                .addStringOption(option =>
                    option.setName('trigger_id')
                        .setDescription('Trigger ID to delete')
                        .setRequired(true)
                        .setAutocomplete(true)))
        .setDMPermission(false),

    async autocomplete(interaction) {
        const focusedOption = interaction.options.getFocused(true);
        
        if (focusedOption.name === 'player') {
            // Search the full Bifrost playerbase (~49k) — triggers are usually set
            // for offline players, so online-only would miss the common case.
            const usernames = await mongo.searchPlayerUsernames(focusedOption.value, 25);
            usernames.sort((a, b) => a.localeCompare(b));
            await interaction.respond(
                usernames.map(u => ({ name: u, value: u })),
            );
        } else if (focusedOption.name === 'servers') {
            const focusedValue = focusedOption.value;
            const serverList = await yggdrasil.getServers();
            const choices = ["all"];

            for (const server of serverList) {
                if (!server.excludeFromServerList) {
                    choices.push(server.name.trim());
                }
            }

            const filtered = choices.filter(choice => choice.toLowerCase().includes(focusedValue.toLowerCase()));
            await interaction.respond(
                filtered.slice(0, 25).map(choice => ({
                    name: choice,
                    value: choice
                })),
            );
        } else if (focusedOption.name === 'trigger_id') {
            const focusedValue = focusedOption.value;
            const triggers = await mongo.getActiveScheduleJobs('player_trigger');
            const choices = [];

            for (const trigger of triggers) {
                const shortId = trigger._id.toString().substring(0, 8);
                const displayName = `${shortId}... | ${trigger.playerId} → ${trigger.serverNames.slice(0, 2).join(', ')}${trigger.serverNames.length > 2 ? '...' : ''}`;
                choices.push({
                    name: displayName,
                    value: trigger._id.toString()
                });
            }

            const filtered = choices.filter(choice => 
                choice.name.toLowerCase().includes(focusedValue.toLowerCase()) ||
                choice.value.includes(focusedValue)
            );
            
            await interaction.respond(filtered.slice(0, 25));
        }
    },

    async execute(interaction) {
        await interaction.deferReply();
        
        const subcommand = interaction.options.getSubcommand();
        
        try {
            switch (subcommand) {
                case 'create':
                    await this.createPlayerTrigger(interaction);
                    break;
                case 'list':
                    await this.listPlayerTriggers(interaction);
                    break;
                case 'disable':
                    await this.disablePlayerTrigger(interaction);
                    break;
                case 'delete':
                    await this.deletePlayerTrigger(interaction);
                    break;
                default:
                    await interaction.editReply('Unknown subcommand!');
            }
        } catch (error) {
            console.error('Error in schedule-player command:', error.message);
            await interaction.editReply('An error occurred while processing the command.');
        }
    },

    async createPlayerTrigger(interaction) {
        const playerId = interaction.options.getString('player');
        const serversInput = interaction.options.getString('servers');
        const commandsInput = interaction.options.getString('commands');
        // Default to one-time: absent (null) → true; an explicit `onetime:false` is respected.
        const oneTime = interaction.options.getBoolean('onetime') ?? true;
        const onJoin = interaction.options.getBoolean('onjoin') || false;
        
        // Parse servers
        let serverNames = [];
        if (serversInput.toLowerCase() === 'all') {
            const allServers = await yggdrasil.getServers();
            serverNames = allServers.filter(s => !s.excludeFromServerList).map(s => s.name);
        } else {
            serverNames = serversInput.split(',').map(s => s.trim());
        }
        
        // Validate servers exist (with improved matching like /execute command)
        const allServers = await yggdrasil.getServers();
        const validServers = [];
        for (const serverName of serverNames) {
            // Try exact match first, then case-insensitive, then tag match
            const server = allServers.find(s => 
                s.name.trim() === serverName.trim() ||
                s.name.trim().toLowerCase() === serverName.trim().toLowerCase() ||
                s.tag === serverName.toLowerCase()
            );
            if (server) {
                validServers.push(server.name.trim()); // Use actual server name, trimmed
            }
        }
        
        if (validServers.length === 0) {
            await interaction.editReply('❌ No valid servers found!');
            return;
        }
        
        // Parse commands
        const commands = commandsInput.split(';').map(cmd => cmd.trim()).filter(cmd => cmd.length > 0);
        
        if (commands.length === 0) {
            await interaction.editReply('❌ No valid commands provided!');
            return;
        }
        
        // Create the trigger
        const triggerData = {
            type: 'player_trigger',
            playerId: playerId,
            serverNames: validServers,
            commands: commands,
            oneTime: oneTime,
            onJoin: onJoin,
            createdBy: interaction.user.id,
            active: true,
            lastSeenServers: [] // Track where player was last seen for join detection
        };
        
        const result = await mongo.createScheduleJob(triggerData);
        
        const embed = new EmbedBuilder()
            .setColor(0x00ff00)
            .setTitle('✅ Player Trigger Created')
            .addFields(
                { name: 'Trigger ID', value: result.insertedId.toString(), inline: true },
                { name: 'Player', value: playerId, inline: true },
                { name: 'One-time', value: oneTime ? 'Yes' : 'No', inline: true },
                { name: 'On Join Only', value: onJoin ? 'Yes' : 'No', inline: true },
                { name: 'Servers', value: validServers.join(', '), inline: false },
                { name: 'Commands', value: commands.join('\n'), inline: false }
            )
            .setTimestamp();
        
        await interaction.editReply({ embeds: [embed] });
    },

    async listPlayerTriggers(interaction) {
        const triggers = await mongo.getActiveScheduleJobs('player_trigger');
        
        if (triggers.length === 0) {
            await interaction.editReply('No active player triggers found.');
            return;
        }
        
        const embed = new EmbedBuilder()
            .setColor(0x9c59b6)
            .setTitle('Active Player Triggers')
            .setTimestamp();
        
        // Discord caps a field value at 1024 chars and the whole embed at 6000.
        // NBT restore commands (shulker /give) routinely blow past 1024 on their own,
        // which threw "Received one or more errors" and broke the entire list.
        let used = 0, shown = 0;
        for (let i = 0; i < triggers.length; i++) {
            const trigger = triggers[i];
            const cmds = trigger.commands || [];
            const cmdJoined = cmds.join('; ');
            const CMD_CAP = 500;
            const cmdText = cmdJoined.length > CMD_CAP
                ? `${cmdJoined.slice(0, CMD_CAP)}… (${cmds.length} cmd${cmds.length === 1 ? '' : 's'}, ${cmdJoined.length} chars)`
                : cmdJoined;
            const name = `ID: ${trigger._id.toString().substring(0, 8)}... | Player: ${trigger.playerId}`;
            const value = `**Servers:** ${(trigger.serverNames || []).join(', ')}\n**Commands:** ${cmdText}\n**One-time:** ${trigger.oneTime ? 'Yes' : 'No'}\n**On Join:** ${trigger.onJoin ? 'Yes' : 'No'}`.slice(0, 1024);
            // stop before the 6000-char embed limit (headroom for title/footer)
            if (used + name.length + value.length > 5800) break;
            embed.addFields({ name, value, inline: false });
            used += name.length + value.length;
            shown++;
        }

        if (shown < triggers.length) {
            embed.setFooter({ text: `Showing ${shown} of ${triggers.length} triggers` });
        }
        
        await interaction.editReply({ embeds: [embed] });
    },

    async disablePlayerTrigger(interaction) {
        const triggerId = interaction.options.getString('trigger_id');
        
        try {
            const { ObjectId } = require('mongodb');
            await mongo.deactivateScheduleJob(new ObjectId(triggerId));
            
            const embed = new EmbedBuilder()
                .setColor(0xffa500)
                .setTitle('⚠️ Player Trigger Disabled')
                .setDescription(`Trigger ID: ${triggerId}`)
                .setTimestamp();
            
            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            await interaction.editReply('❌ Failed to disable trigger. Invalid ID or trigger not found.');
        }
    },

    async deletePlayerTrigger(interaction) {
        const triggerId = interaction.options.getString('trigger_id');
        
        try {
            const { ObjectId } = require('mongodb');
            await mongo.deleteScheduleJob(new ObjectId(triggerId));
            
            const embed = new EmbedBuilder()
                .setColor(0xff0000)
                .setTitle('🗑️ Player Trigger Deleted')
                .setDescription(`Trigger ID: ${triggerId}`)
                .setTimestamp();
            
            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            await interaction.editReply('❌ Failed to delete trigger. Invalid ID or trigger not found.');
        }
    }
};