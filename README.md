# Valhalla Updater

Valhalla Updater is a comprehensive Minecraft server management platform built for the [ValhallaMC Network](https://dc.valhallamc.io/). What started as a simple modpack update tool has evolved into a full-featured automation suite handling everything from modpack updates and server reboots to player statistics and real-time monitoring — all managed through Discord.

## 🚨 P0 TODO: preserve per-instance files during multi-instance updates

**Do not update a multi-instance pack such as IL2 until this is fixed or its instance-specific files have been saved manually.**

The CurseForge and FTB update paths build one merged archive from the primary instance, then deploy that same archive to every server sharing the pack tag. This overwrites settings that must remain different between instances. It previously gave both IL2 Public and IL2 Supporter the same AdvancedBackups destination, causing both JVMs to write into one manifest and incremental chain on the shared backup mount.

Known IL2 files that must be preserved independently include:

- `config/AdvancedBackups.properties` (backup path and schedule)
- `server.properties` (ports, watchdog timeout, and other instance settings)
- `ops.json`, `whitelist.json`, `banned-ips.json`, and `banned-players.json`

Required fix:

1. Maintain a per-pack allowlist of instance-specific files.
2. After stopping every instance, snapshot each instance's own copies before any destructive deployment.
3. Abort and restart the untouched instances if any required snapshot fails.
4. Deploy the common merged pack.
5. Restore each instance's own files before starting it.
6. Leave an instance stopped and report loudly if its restore fails.
7. Persist snapshots under `vault/<tag>/per-server/<serverId>/` so `/restore` also reapplies them.
8. Add tests proving two instances retain different backup paths and ports after update and restore.

GTO already implements most of this snapshot/restore pattern in `updateGTO()`. Generalize that mechanism for CurseForge and FTB rather than adding another IL2-only deployment path.

## Features

### Modpack Management

- **Automatic Updates** — Detects and applies modpack updates from CurseForge, FeedTheBeast, and GregTech New Horizons
- **Backup & Restore** — Automatically backs up server files before every update, with full restore capability
- **Two-Level File Comparison** — Detects which custom server files were overwritten during an update, so nothing slips through unnoticed

### Server Management

- **Intelligent Reboot Scheduling** — Reboots servers during configurable time windows, only when player count drops below a threshold
- **Batch Processing** — Groups servers by Pterodactyl node for efficient, staggered reboots
- **Remote Command Execution** — Run console commands on any server directly from Discord, with retry logic
- **Player-Triggered Commands** — Configure commands that execute automatically when specific players join

### Discord Integration

- **18 Slash Commands** — Full server management from Discord (see [Commands](#discord-commands) below)
- **Live Server Embeds** — Auto-updating Discord messages showing real-time server status
- **Webhook Notifications** — Update alerts, reboot progress, and error reporting pushed to Discord channels
- **Automatic Role Management** — Assigns Discord roles for each modpack server automatically

### Monitoring & Stats

- **ValhallaMC Wrapped** — Spotify Wrapped-style player statistics with playtime, activity breakdowns, and personalized summaries
- **Server Performance Metrics** — CPU, memory, and uptime stats for all servers
- **Live Player Tracking** — Real-time player counts and online player lists per server
- **Reboot History** — Detailed logs of all reboot activity with timing and outcome data

### Yggdrasil Integration

- **Real-Time Events** — WebSocket connection to ValhallaMC's Yggdrasil API for live server and player data
- **Player Event Tracking** — Monitors join/leave events across all servers in real time

### Infrastructure

- **Pterodactyl Panel Integration** — Full server control with API rate limiting and per-caller usage tracking
- **MongoDB Backend** — Persistent storage for server configs, tickets, reboot history, and live embed state
- **Modular Scheduler System** — Plug-and-play schedulers managed through a central scheduler manager
- **Advanced Logging** — Session logger with circular buffer, file rotation, multiple log levels, and memory snapshots

## Discord Commands

| Command | Description |
| --- | --- |
| `/update <server>` | Run an update sequence on a server |
| `/restore <server> <backup>` | Restore a server from a backup |
| `/checkForUpdates` | Manually check all servers for available updates |
| `/servers` | Show all servers with online status |
| `/servers-live` | Create an auto-updating server status embed |
| `/online` | Show online players across all servers |
| `/stats` | Show server performance stats |
| `/execute <server> <command>` | Execute a console command on a server |
| `/schedule-reboot` | Manage automatic reboots (status, force, enable, disable, history, abort, cleanup) |
| `/schedule-execute` | Manually execute scheduled operations or run commands across servers |
| `/schedule-player` | Configure player-triggered commands (create, list, disable, delete) |
| `/schedule-status` | View comprehensive scheduler system status |
| `/wrapped [player]` | Get your personal ValhallaMC Wrapped player stats |
| `/tickets <user>` | Show a user's solved ticket count |
| `/cake [amount]` | Drop cakes to online players |
| `/banall <players> <reason>` | Ban a list of players across servers |
| `/ping` | Health check |
| `/reloadCommands` | Reload all bot commands |

## Schedulers

| Scheduler | Description |
| --- | --- |
| **Check for Updates** | Periodically checks all modpacks for new versions on CurseForge and FTB |
| **Reboot Scheduler** | Intelligent server rebooting with time windows, player thresholds, node-aware batching, and in-game warnings |
| **Cake Drop** | Randomly drops items to players on configured servers |
| **Role Assigner** | Automatically creates and assigns Discord roles for each server |
| **Staff Permissions** | Manages Pterodactyl panel permissions for staff members |
| **Player Event Scheduler** | Tracks player join/leave events and executes player-triggered commands |

## Tech Stack

- **Runtime:** Node.js
- **Discord:** Discord.js
- **Database:** MongoDB
- **Server Panel:** Pterodactyl (REST API + WebSocket)
- **Modpack Platforms:** CurseForge API, FeedTheBeast API, GregTech New Horizons
- **Real-Time Data:** Yggdrasil API (WebSocket + REST)
- **Key Libraries:** Axios, Sharp, Archiver, ADM-ZIP, Moment.js

## Architecture

```text
├── server.js              # Entry point — launches all services concurrently
├── discord/               # Discord bot, slash commands, events, webhook
│   └── commands/          # 18 slash command implementations
├── modules/               # Core functionality (22 modules)
│   ├── curseforge.js      # CurseForge API
│   ├── modpacksch.js      # FeedTheBeast API
│   ├── pterodactyl.js     # Pterodactyl panel API
│   ├── yggdrasil.js       # Yggdrasil WebSocket & REST
│   ├── mongo.js           # MongoDB operations
│   ├── comparator.js      # File change detection
│   ├── sessionLogger.js   # Advanced logging system
│   └── ...                # Downloader, compressor, merger, etc.
├── managers/              # High-level orchestration
│   ├── updateManager.js   # Update workflow coordinator
│   └── schedulerManager.js# Scheduler lifecycle management
├── schedulers/            # 6 modular schedulers
└── config/                # Runtime configuration
```

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

---

Built for [ValhallaMC](https://dc.valhallamc.io/).
