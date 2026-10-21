# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Valhalla Updater is a Minecraft modpack update automation system for the ValhallaMC Network. It manages automated updates for CurseForge, Feed The Beast (FTB), and GregTech New Horizons modpacks hosted on Pterodactyl game panels, with Discord integration for control and notifications.

## Essential Commands

### Development
```bash
npm install          # Install dependencies
npm start            # Start the application (generates config on first run)
node server.js       # Direct entry point
```

### First-Time Setup
1. Run `npm start` to auto-generate `.env`, `config/config.json`, and `config/messages.json`
2. Fill in the generated `.env` file with API keys and tokens
3. Customize `config/config.json` and `config/messages.json`
4. Ensure MongoDB `servers` collection follows the schema documented in README.md

## Architecture Overview

### Core Components

**Entry Point:** `server.js`
- Loads `errorHandler` → `initializer` → starts three concurrent services:
  1. Discord bot (with 5-retry exponential backoff)
  2. Express API server
  3. Scheduler manager (auto-loads schedulers)

**Directory Structure:**
```
discord/          # Discord bot, commands, events, webhooks
managers/         # High-level orchestration (updateManager, schedulerManager, apiManager)
modules/          # Reusable utilities and external service adapters
schedulers/       # Auto-discovered background tasks (plugin architecture)
```

### The Four Layers

1. **Discord Layer** (`discord/`)
   - User interface via slash commands (`/update`, `/restore`, `/checkForUpdates`)
   - Event handlers and webhook notifications
   - Commands auto-load from `discord/commands/`

2. **Manager Layer** (`managers/`)
   - `updateManager.js` - Core update orchestration (800+ lines)
     - `updateCF()` - CurseForge workflow
     - `updateFTB()` - Feed The Beast workflow
     - `updateGTNH()` - GregTech New Horizons workflow
     - `updateGTO()` - GregTech Odyssey workflow (GitHub releases, manual-only)
     - `restore()` - Restore from backup, per instance (prefers `./vault/[tag]/instances/[sid]/`, falls back to a legacy shared archive + `./vault/[tag]/per-server/` overlay)
   - All four update paths share the same per-instance loop, plus module-scope helpers
     `backupAllInstances()` (Phase A), `mergeAndDeployInstance()` / `deployMergedTree()` (Phase B),
     `checkDiskSpace()` and `instanceVaultPath()`. Exported as `_internals` for tests.
   - `schedulerManager.js` - Auto-discovers and starts schedulers
   - `apiManager.js` - Express REST API (Ko-fi webhook handler)

3. **Module Layer** (`modules/`)
   - **External Service Adapters** (adapter pattern):
     - `mongo.js` - MongoDB operations
     - `pterodactyl.js` - Pterodactyl panel API with retry logic
     - `curseforge.js` - CurseForge API with fallback server pack lookup
     - `modpacksch.js` - Universal manifest provider for CF/FTB
     - `gregtechnewhorizons.js` - GTNH version scraping
     - `gregtechodyssey.js` - GTO releases from GitHub (tag-based versions, exclusion list, per-server file list)
   - **Update Process:**
     - `comparator.js` - Three-way directory comparison using `dir-compare`
     - `merger.js` - Applies file changes while preserving custom modifications
     - `downloader.js` - HTTP download/upload utilities
     - `compressor.js` / `unpacker.js` - Archive handling
   - **Utilities:**
     - `perInstanceFiles.js` - Force-protect list for files that must differ between instances sharing a tag, plus `stashProtected`/`applyProtectedOverlay`/`diffInstanceManifests`
     - `initializer.js` - Config validation and generation
     - `sessionLogger.js` - Centralized logging
     - `errorHandler.js` - Global exception handling
     - `functions.js` - Common utilities

4. **Scheduler Layer** (`schedulers/`)
   - Plugin architecture: each exports `{name, defaultConfig, start()}`
   - Auto-discovered by `schedulerManager.js`
   - Key schedulers:
     - `checkForUpdates.js` - Polls APIs every 6 hours for new versions
     - `rebootScheduler.js` - Scheduled server reboots
     - `serverStatusMonitor.js` - Live Discord status embeds
     - `tabConfigUpdater.js` - Tab list configuration updates with backups

## Critical Architecture Concepts

### Three-Way Merge System

The update process compares THREE versions to preserve custom server modifications:

1. **Old Reference Pack** - Original modpack version from CurseForge/FTB
2. **Current Server Files** - Live server with admin modifications
3. **New Reference Pack** - Latest modpack version

**Why?**
- Comparing current → old identifies **custom changes** made by admins
- Comparing old → new identifies **modpack changes**
- This separates "what the admin changed" from "what the pack changed"
- Allows preservation of custom files while applying modpack updates

### Update Flow (CurseForge Example)

```
1. PREPARATION - Get manifest, extract version, alert players
2. DOWNLOAD - Download new pack + old reference pack
3. EXTRACTION - Decompress to ./[tag]/compare/{new,old}/
4. BACKUP - Shutdown server, compress & download to ./vault/[tag]/
5. COMPARISON - Three-way comparison to identify:
   - customFiles[] (admin additions)
   - editedFiles[] (admin modifications)
   - deletions[] (modpack removed files)
   - additions[] (modpack new/updated files)
   - overwrites[] (conflicts: edited files that will be replaced)
6. MERGE - Delete old files, add new files, preserve custom files
7. UPLOAD - Compress merged pack, upload to Pterodactyl
8. DEPLOYMENT - Delete old server files, decompress update, start server
9. FINALIZATION - Update MongoDB, send notifications, cleanup temp files
```

**Temporary Directories:**
- `./vault/[tag]/` - Backup storage (permanent)
- `./[tag]/downloads/` - Downloaded packs (cleaned after update)
- `./[tag]/compare/{main,old,new}/` - Comparison working directory (cleaned after)

### MongoDB Schema

Note: server docs consumed by the updater are served by the Yggdrasil API, which is backed by the `bifrost` db's `servers` collection — NOT `valhallamc.servers` (that one is a stale/legacy set; `config.json`'s `mongodb.mongoDBName` only applies to `modules/mongo.js` direct access).

**servers collection:**
```javascript
{
  tag: 'ske',                     // Server short tag (used for file paths)
  discord_role_id: '',            // Discord role ID for mentions
  name: 'FTB Skies Expert',       // Display name
  modpack_version: '1.8.1',       // Current human-readable version
  serverId: 'xyz',                // Pterodactyl server ID (last part of console URL)
  modpackID: 117,                 // CurseForge/FTB modpack ID
  fileID: 11927,                  // Current file/version ID
  newestFileID: 11927,            // Latest available version ID (set by checkForUpdates)
  platform: 'feedthebeast',       // 'curseforge' | 'feedthebeast' | 'gregtechnewhorizons' | 'gregtechodyssey'
  requiresUpdate: false           // Flag set by update checker
}
```

### Configuration Management

**`.env` (auto-generated by initializer):**
- `MONGODB_URL` - MongoDB connection string
- `PTERODACTYL_APIKEY` - Panel API token
- `DISCORD_TOKEN` - Bot token
- `CURSEFORGE_APIKEY` - API key
- `VELOCITY_METRICS_URL` - Metrics endpoint
- `KOFI_SECRET` - Donation webhook secret

**`config/config.json`:**
- `base.exitOnError` - Whether to exit on validation failure
- `discord.*` - Discord config (active, channel IDs)
- `pterodactyl.*` - Panel config (hostname, velocity ID)
- `mongodb.*` - Database config (name, collection)
- `webApi.*` - Express server config (port)
- `scheduler.*` - Per-scheduler config (auto-populated on first run)

**`config/messages.json`:**
- Tellraw command templates for in-game alerts
- Discord webhook message templates
- Supports variables: `[PACKNAME]`, `[NEWVERSION]`, `[OLDVERSION]`, `[CHANGELOGURL]`, `[PINGROLE]`

### External Service Integration

**Pterodactyl API** (`modules/pterodactyl.js`)
- All operations have 3-retry logic with 2s delay
- Key operations:
  - `sendCommand()` - Execute console commands
  - `sendPowerAction()` - start/stop/restart/kill
  - `compressFile()` / `decompressFile()` - Archive operations on server
  - `getDownloadLink()` / `getUploadLink()` - Temporary URLs for file transfer
  - `deleteFile()` - Delete files/folders

**CurseForge API** (`modules/curseforge.js`)
- Requires `x-api-key` header
- **Server pack fallback strategy:**
  1. Official API server pack field
  2. Scrape additional files endpoint with browser User-Agent
  3. Heuristic search for "server" in filename

**Feed The Beast** (`modules/modpacksch.js`)
- Uses modpacks.ch API (no auth required)
- Returns manifest with file lists and download URLs
- Filters out `clientonly: true` files

**GTNH** (`modules/gregtechnewhorizons.js`)
- Web scraping (no official API)
- Exclusion list for files that should never be updated (world data, custom configs)

**GTO** (`modules/gregtechodyssey.js`)
- GitHub releases API (unauthenticated); versions are release tags (`0.5.5`, `0.5.6-beta`)
- The rolling `nightly` tag is filtered out; old releases get pruned upstream, so updates hard-abort if the current version's tag is gone (three-way merge needs the old reference)
- Manual updates only: `checkForUpdates` skips the platform, `/update` allows it regardless of `requiresUpdate`
- Multi-instance via shared mongo tag; `perServerFiles` (gtocore.yaml difficulty, server.properties ports) are snapshotted per instance to `./vault/[tag]/per-server/[sid]/` and written back after deploy

## Safety Mechanisms

### Backup Strategy
- Automatic backup before every update to `./vault/[tag]/`
- Named with version and file ID
- Restore available via `/restore` Discord command
- Uses Pterodactyl compression (preserves permissions)

### Error Handling
- Global error handler catches uncaught exceptions
- Retry logic on Pterodactyl (3x) and Discord (5x with backoff)
- Safe defaults for failed API calls
- Update process continues even if Discord fails (degraded operation)

### Validation
- `initializer.js` validates all env vars and config on startup
- Exits process if critical config missing (when `exitOnError: true`)
- Server pack ID validation with fallback lookup
- Response structure validation for API calls

### Update Safety
- Server shutdown before destructive operations
- Progress messages keep players informed
- Overwrite detection warns about conflicts with custom files
- DANGER ZONE comments mark destructive operations in code

## Adding New Features

### Adding a New Scheduler
1. Create `schedulers/yourScheduler.js`
2. Export `{name: 'yourScheduler', defaultConfig: {...}, start: async (config) => {...}}`
3. Config will auto-appear in `config/config.json` under `scheduler.yourScheduler`
4. Use `setInterval()` in `start()` for periodic tasks
5. Access external services via `modules/mongo.js`, `modules/pterodactyl.js`, etc.

### Adding a New Discord Command
1. Create `discord/commands/yourCommand.js`
2. Export `{data: SlashCommandBuilder, execute: async (interaction) => {...}}`
3. Command auto-loads on next restart
4. Use `interaction.deferReply()` for long-running operations
5. Access managers via `require('../../managers/...')`

### Adding a New Platform Adapter
1. Create `modules/yourPlatform.js`
2. Export functions for common operations (getLatest, getManifest, etc.)
3. Add new platform case in `updateManager.js`
4. Update MongoDB schema to support new platform value
5. Follow existing adapter patterns for consistency

## Common Development Patterns

### Accessing Configuration
```javascript
const config = require('../config/config.json');
const messages = require('../config/messages.json');
```

### Logging
```javascript
const sessionLogger = require('../modules/sessionLogger');
sessionLogger.info('Message');
sessionLogger.error('Error', error);
```

### Server Data Operations
```javascript
// Server docs are served by the Yggdrasil API (backed by mongo), not modules/mongo.js.
// GET returns camelCase fields (modpackVersion, discordRoleId); PATCH takes snake_case.
const yggdrasil = require('../modules/yggdrasil');
const servers = await yggdrasil.getServers();
await yggdrasil.updateServer(tag, {modpack_version: '1.2.3'});
```

### Pterodactyl Operations
```javascript
const pterodactyl = require('../modules/pterodactyl');
await pterodactyl.shutdown(serverId);
await pterodactyl.sendCommand(serverId, 'say Hello');
const status = await pterodactyl.getStatus(serverId);
```

### Discord Notifications
```javascript
const webhook = require('../discord/webhook');
await webhook.sendEmbed(webhookUrl, {
  title: 'Title',
  description: 'Content',
  color: 0x00ff00
});
```

## File Locations Reference

**Configuration:**
- `.env` - Secrets and API keys
- `config/config.json` - Main configuration
- `config/messages.json` - Message templates

**Core Entry Points:**
- `server.js` - Application bootstrap
- `modules/initializer.js` - Config validation and generation

**Update Orchestration:**
- `managers/updateManager.js` - Main update logic (800+ lines)
- `modules/comparator.js` - Three-way file comparison
- `modules/merger.js` - File merging with custom preservation

**External Adapters:**
- `modules/mongo.js` - MongoDB client
- `modules/pterodactyl.js` - Panel API client
- `modules/curseforge.js` - CurseForge API client
- `modules/modpacksch.js` - FTB manifest provider

**Runtime Directories:**
- `./vault/[tag]/` - Backup storage (not in repo)
- `./[tag]/` - Temporary working directory (cleaned after updates)

## Important Notes

- **Multi-instance packs** (`il2`, `pri`, `mg2`, `gto` share a tag across several Pterodactyl servers): every instance is backed up, merged and deployed from its OWN files. Never reintroduce a "merge once on the primary, deploy everywhere" path — that is what gave IL2 Public and Supporter the same AdvancedBackups destination and prometheus port. There is no primary flag; instance order is just the Yggdrasil API's, so nothing may depend on `allServerIds[0]`.
- The database is addressed by **tag**, not serverId (`PATCH /servers/{tag}`), so instances of one pack cannot sit on different versions. The DB write and announcement happen once, after every instance succeeds.
- **Nothing between the last deploy and the DB write may throw** — the files are already updated there, so an abort leaves mongo claiming the old version. Progress edits go through `editProgress()` (truncates to 2000 chars, swallows Discord errors), starts through `startInstances()` (reports, never rethrows), the drift report through `safeInstanceDiff()`, scratch deletion through `safeRm()` (`rmRecursive`'s `force:true` only silences ENOENT — EACCES/EBUSY still throw). Don't call `interaction.edit`/`sendPowerAction`/`rmRecursive` directly in that window.
- **A failure after the wipe is not the same as a failure before it.** `deployMergedTree` throws `wipedError()` (sets `error.serverWiped`) once the live files are gone, and the loops collect those separately so the warning tells the operator to unpack the archive on the panel or use `/restore` — **not** to re-run, which would back up and merge from the now-empty tree.
- **`pterodactyl.deleteFile` / `decompressFile` return a boolean, `listFiles` returns `[]` on error.** `deployMergedTree` deletes the uploaded archive only after the wipe returned true, the unpack returned true, AND the merged tree's top-level names are back on the panel — the archive is the only copy of the new files until then. A no-op unpack is caught; a panel that reports success after filling its disk mid-write is not.
- **Never unit-test `updateManager`'s deploy helpers by swapping `require.cache`** — it binds `pterodactyl` at require time, so the stub does not apply and the calls hit the live panel. Inject the client as a parameter instead (`deployMergedTree` takes one; `backupAllInstances` still does not). See the note in `test/multiInstance.test.js`.
- **A truncated archive passes every exists/non-zero check.** `download()` verifies the written size against `content-length` and deletes the partial file on any failure, so a reset connection can no longer leave a half-written vault archive that the next run preserves as "the existing backup". `/restore` additionally preflights EVERY instance before shutting anything down: `unpacker.verify()` reads each candidate archive end to end, and a corrupt per-instance archive falls through to the shared one instead of being preferred for being the more specific path. `listBackups` shows the union of names across instances, so a half-finished backup phase can offer a backup only some instances have.
- The system is designed for the ValhallaMC Network infrastructure
- All schedulers can be independently enabled/disabled via config
- The three-way comparison is critical for preserving admin customizations
- Never skip backups - they're the only way to recover from failed updates
- Discord bot uses minimal intents (GatewayIntentBits.Guilds only)
- Server shutdown is required before file operations to prevent corruption
- Temporary directories under `./[tag]/` are cleaned up after successful updates
- The `requiresUpdate` flag in MongoDB is set by `checkForUpdates` scheduler
