# Valhalla Updater

Valhalla Updater is a comprehensive Minecraft server management platform built for the [ValhallaMC Network](https://dc.valhallamc.io/). What started as a simple modpack update tool has evolved into a full-featured automation suite handling everything from modpack updates and server reboots to player statistics and real-time monitoring — all managed through Discord.

## Multi-instance packs

Several packs are served by more than one Pterodactyl instance sharing a single mongo tag —
`il2`, `pri`, `mg2` and `gto`. Those instances legitimately differ: ports, AdvancedBackups
destination, prometheus metrics port, admin-added scripts.

Updates handle this by treating each instance as its own server. The reference packs are
downloaded once, then **every instance is backed up, three-way merged and deployed from its
own files** — one instance's files never enter another's merge, so instance-specific state
survives without anyone having to enumerate it.

Update sequence for a multi-instance tag:

1. Download the old and new reference packs (once, shared by all instances).
2. Stop every instance.
3. **Phase A** — archive each instance to `vault/<tag>/instances/<serverId>/` and snapshot its
   identity files to `vault/<tag>/per-server/<serverId>/`. If any of this fails the update
   aborts and restarts every instance with their files untouched.
4. **Phase B** — for each instance in turn: unpack its own archive, apply the pack's changes,
   lay its identity files back over the result, then upload and deploy. The upload is verified
   on the panel before anything is deleted.
5. Start the instances that succeeded; leave any that failed stopped and report them.
6. Only once every instance succeeded, update the database and send the announcement — so a
   partial failure leaves `requiresUpdate` set and the whole tag can simply be re-run.
7. Report a content-hashed diff of what still differs between instances.

On top of that, `modules/perInstanceFiles.js` force-protects the files that must never be taken
from the pack itself even when the pack ships a new copy:

- `server.properties` (ports, watchdog timeout)
- `config/AdvancedBackups.properties` (backup destination and schedule — a shared path corrupts
  the incremental chain for every instance writing into it)
- `config/prometheus_exporter-server.toml` (metrics `listen_port` — a shared port means one JVM
  fails to bind)

GTO adds `config/gtocore.yaml` for its Normal/Expert difficulty split. Per-tag additions can go
under `multiInstance.protectedFiles` in `config/config.json`.

`/restore` follows the same rule: each instance goes back to its own archive where one exists,
falling back to a legacy shared archive with the per-server snapshot laid over the top.

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
| `/notice` | Author the in-game notices players see (create, broadcast, list, expire, enable, translate, show) |
| `/reply <player> <text>` | Send a player an in-game message from staff |
| `/ping` | Health check |
| `/reloadCommands` | Reload all bot commands |

## In-game notices and mail (Bifrost contract)

`/notice` and `/reply` write straight into the Bifrost proxy's collections; the proxy watches
both with change streams, so a write reaches players in about a second. Nothing here deletes:
`/notice expire` flips `enabled:false` and keeps the doc. Both commands refuse a text carrying
`<click:` or `<hover:` — staff don't author clickable MiniMessage from Discord.

**`bifrost.notices`** (one doc per notice, keyed by `id`, upserted by `/notice`):

| Field | Notes |
| --- | --- |
| `id` | `[a-z0-9][a-z0-9._-]*`, max 128. Default `<prefix>.<slug>-<base36 ts>` (prefixes: `announcement`, `broadcast`, `pinned`, `issue`, `event`, `tip`) |
| `type` | `announcement` (rotation) · `broadcast` (one-shot to everyone online) · `pinned` / `known_issue` / `event` (join card + board) · `tip` (guide card override) |
| `enabled` | `false` retires it |
| `title` | max 48 chars; required for `pinned`, `known_issue`, `event` |
| `body` | `{ en: "..." }`, max 400 chars — **except `tip`, which stores its text under `card`** |
| `targets` | `{ tags: [...], newPlayersOnly, minProto, maxProto, langs }` — versions map to protocol numbers (1.7.10=5, 1.12.2=340, 1.20.1=763, 1.21.1=767, ...) |
| `buttons` | always written as `[]` from Discord |
| `startsAt` / `expiresAt` | `Nh` / `Nd` from now; an `event` uses `endsAt` instead and **requires** it |
| `createdAt` | always set — a `broadcast` without it is dropped by the proxy |
| `updatedAt`, `updatedBy`, `note` | authorship; `updatedBy` is the Discord tag |

**`bifrost.mail`** (one doc per message, inserted by `/reply`): `to` (uuid), `toName`,
`from: { uuid: null, name }`, `kind: 'admin'`, `body` (max 500), `sentAt`, `readAt: null`,
`expiresAt` (90 days), `meta: { via: 'discord', discordId }`. The proxy delivers an unread doc
inline when the player is online, otherwise it waits in their in-game inbox (`/mail`).

A **`tip`** doc overrides the text of ONE guide card, and the guide looks that card up by its
fixed id — so `/notice create type:tip` **requires** an `id`, and it must start with `tip.`.
A generated id would match no card and the text would never be shown. Known ids:
`tip.welcome.help`, `tip.onboard.welcome`, `tip.onboard.chat`, `tip.onboard.stuck`,
`tip.crash.rejoin`, `tip.translate.offer`, `tip.translate.why`, `tip.channel_churn`,
`tip.reply`, `tip.pm_offline`, and `tip.closure.map.<tag>` (one per closed pack). An id outside
that list is a warning, not a refusal — the guide gains cards faster than the list does.

A finished pack update also posts an in-game `event` card automatically
(`modules/notices.js` → `event.update.<tag>.<yyyymmdd>`, targeted at that tag, visible 3 days),
telling players to restart their launcher. Gate it with `notices.packUpdateEvents: false` in
`config/config.json` — the call is fire-and-forget and can never fail or delay an update.

**`valhallamc.reboot_events`** (one doc per reboot countdown, written by the reboot scheduler):
the proxy renders reboot countdowns itself — boss bar / action bar per client era — and keeps a
planned restart from being relayed to players as a crash. This collection is its only source, so
a doc is written at the start of **every** countdown, at the one choke point all paths share
(`executeRebootWarningsEnhanced`): the daily batch, a staff `/reboot` and a player vote alike.

| Field | Notes |
| --- | --- |
| `type` | always `countdown` |
| `tag`, `serverId`, `serverName` | which server is going down (`serverId` is the Pterodactyl id) |
| `source` | `daily` (automated batch) · `scheduled` (a `schedule_jobs` job, i.e. staff `/reboot`) · `vote` (that job's `requestedBy` starts with `Player vote`) · `manual` / `unknown` for a caller passing its own |
| `startedAt`, `warnSeconds`, `fireAt` | the window actually used: `fireAt = startedAt + warnSeconds` |
| `requestedBy`, `reason` | only when the job carried them |
| `cancelledAt` | set by `/reboot-cancel` (and any other abort) on every still-open doc of that server |
| `completedAt` | set when the countdown reaches the stop step |
| `createdAt` | 2-day TTL index |

Writes are fire-and-forget and wrapped: a Mongo outage can never fail or delay a reboot. Turn the
relay off with `scheduler.rebootScheduler.rebootEvents: false` in `config/config.json`.

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
