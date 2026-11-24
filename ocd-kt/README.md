# ocd-kt: the opencode unit daemon (Kotlin)

A typed service that keeps N opencode "units" (one session per checklist item) generating, detects stalls, rotates exhausted sessions, and rotates provider keys.
Replaces `daemon-ts/` (the TypeScript daemon, kept in this repo for reference and as the rollback).

## Layers (each calls only the one below)

| File | Layer | Job |
|---|---|---|
| `Api.kt` | L5 | HTTP API (`/status /journal /nudge /kick /rotate /review /events /digest /health`) + file adapters (`nudge-inbox/`, `queue-drop.txt`, `keeper.kick/sweep/rotate`) + compat mirrors (`keeper-units.json`, `keeper-queue.json`, `watchdog-status.json`) |
| `Sched.kt` | L3 | which item next, slot filling, queue top-up (policy stays in `tools/nextitems.py` + `tools/mkeasy.py`) |
| `Runner.kt` | L2 | unit state machine: reconcile, stall detection, stop-then-send, rotation, retirement, done gate, events |
| `Pool.kt`, `Kilo.kt` | L1 | Kilo key pool: real probe per key, rotation, audit; account store + opencode credential activation |
| `Store.kt`, `OpenCode.kt`, `Core.kt` | L0 | SQLite state (same schema as the TS daemon's `ocd.db`), typed opencode REST/SSE client, config + domain types (`Session`, `Message`, sealed `OcEvent` / `BusEvent`) |

## Behaviour (what changed against the TypeScript daemon)

* The **session is the truth**: generating = `time.busy > time.idle` (`session.outcome` is stale between turns). Reconcile every 30 s; sessions archived or gone outside the daemon are dropped.
* **Stall** = no model activity events (retries and failures do not count) and no progress-file write for `STALL_S`. Kick = interrupt, wait until stopped, then send. 3 kicks rotate.
* **Rotate** = fresh session, same progress file, continuation prompt. Triggers: context estimate above `CTX_MAX`, 6 sends without progress, 6 failed executions in a row, 3 stalls. After `MAX_ROT` rotations in 6 h the unit is retired (session archived, item requeues).
* Sends are rate-limited per unit (`MIN_GAP_S`), failures back off exponentially, and every interruption is stop-then-send (a message to a generating session only queues).
* `/status`: `running` = slots in use, `generating` = really generating; per unit `actIdleS`, `ctxK`, `rotations`, `consFail`.

## Build and run

```powershell
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-17.0.21.10002-hotspot"
./gradlew installDist
$env:SHADOW = "1"; $env:OCD_PORT = "4778"; build\install\ocd\bin\ocd.bat   # observe-only
```

Settings (environment): `OCD_DIR`, `OCD_REPO`, `OCD_PORT` (4777), `MAXRUN` (4), `TOPUP` (3), `STALL_S` (240), `MIN_GAP_S` (20), `CTX_MAX` (150000), `MAX_ROT` (3), `SHADOW`.

## Cutover from the TypeScript daemon

1. Run it in shadow mode (above) next to the live daemon and compare `/status` on 4777 and 4778.
2. Stop the TS supervisor (`daemon-ts/ocd-run.sh`, a bash process) and its daemon (the pid in `ocd.lock`).
3. Start `bash ocd-kt/ocd-run.sh`. It adopts the live units from `ocd.db` and `keeper-units.json`.
4. Rollback = stop it and start `daemon-ts/ocd-run.sh` again; both use the same `ocd.db`.

Wire format of the opencode service (recorded from `@opencode/client` 2.3.0): REST under `/api` with Basic auth (`opencode:<password>` from `~/.local/state/opencode/service.json`), SSE on `/api/event`.
