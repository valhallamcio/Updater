# End reset jobs

`schedulers/endResetScheduler.js` runs `end_reset` jobs from `valhallamc.schedule_jobs`. The mod
side (Biforesting) does the reset at boot. The contract is bifrost-lib
`docs/invariants/end-reset.md`. Pure parts: `modules/endReset.js`. Verify: `modules/endResetVerify.js`.

## Flow

1. `plan` job. The `end_reset_plan` link op writes `config/biforesting/end-reset/plan.json`. VU
   reads it, stores its text and sha256 on the job, and posts the summary to the reboot notice
   channel. The mails it would send come as a file.
2. Staff read the summary. An `apply` job with that `planId` is the go.
3. `apply` checks the plan file still has the stored sha256, that no request or reboot waits,
   the unsupported list and the disk space. Then it writes `request.json` and inserts one
   `scheduled_reboot` with `instanceServerId`. Players get the normal countdown.
4. After `fireAt` the job reads `result.json` each tick. On `applied` it verifies. A pass sends
   the mails from `result.json`. A fail holds them.
5. `restore` writes `restore.json` and inserts one reboot. It needs `confirmLoss: true`.

## Job shapes

Every job needs `type: 'end_reset'`, `action` and `instanceServerId` (the 8-character panel id).
A tag is refused: tags are not unique. `requestedBy` is optional.

| action | fields |
|--|--|
| `plan` | none |
| `apply` | `planId` (from the dry run). Optional: `fireAt` (epoch ms or ISO; default now + warnWindow), `warnWindow` (1-60 min, default 15), `windowMinutes` (15-720, default 60), `ignoreUnsupported`, `sendMails` (default true), `mailDryRun` |
| `verify` | `resetId` |
| `mail` | `resetId`. Optional: `mailDryRun` (post the mails, send none) |
| `restore` | `resetId`, `confirmLoss: true`. Optional: `fireAt`, `warnWindow`, `windowMinutes` |

```js
{ type: 'end_reset', action: 'plan', instanceServerId: 'e2f5e517', requestedBy: 'alp', active: true, createdAt: new Date() }
{ type: 'end_reset', action: 'apply', instanceServerId: 'e2f5e517', planId: '01JB...', requestedBy: 'alp', active: true, createdAt: new Date() }
```

The request window is `fireAt - 5 min` to `fireAt + windowMinutes`. A crash restart long before
the planned reboot does not apply it. The job keeps its state in `phase`
(`requesting`, `awaiting_result`, `done`). A job found in `requesting` stopped between the
write and the reboot insert. It stops with a staff notice and is not written again.

Mails are `bifrost.mail` docs from `discord/commands/util/mailDoc.buildMailDoc`, kind `admin`,
`meta.via: 'end_reset'`, `meta.key: end-reset-<resetId>-<uuid>`. A re-run skips a player whose key
exists.

## Offline tool

`node scripts/end-reset.js dry-run|verify|mails --dir <server root copy>` prints the summary, the
verify checks or the mails. It writes nothing. `--dir test/fixtures/end-reset` runs it on the
fixture. `test/fixtures/end-reset/make-fixtures.js` rebuilds the fixture region files, team files
and manifest.

## Open contract questions (2026-10-20)

- The plan op result: VU reads `result.data.planId` and `result.data.planSha256` (or `sha256`).
- The done line: VU takes any log line with `[Biforesting] end reset <resetId>:`. Step lines with
  the same prefix would match too.
- A restore reuses the reset's `resetId`, which `done.json` already holds. Request rule 1 would
  ignore it. VU matches the restore result by `kind: restore` and that `resetId`.
- The claim check reads only the team files named in the plan (kept and moved teams), not every
  team file on the server.
