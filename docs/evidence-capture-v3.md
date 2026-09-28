# Comprehensive evidence capture — capture schema v3

Prepared 2026-09-28 for one scripted evidence-expansion session. Nothing here
writes to Supabase, activates a classifier, or publishes UVA.

**Capability ready ≠ positive example obtained.** "Captured" below means the
bytes are recorded every frame and read back; it does not mean anything in them
has been identified. Five signals remain unobserved as labels (pitch charge,
pitch aim, shake effort, fielder selection, independent batter timing); the
session records the raw memory and input they must come from.

## 1. Evidence-gap matrix

Capture: **C** captured before this change, **N** new in v3, **—** nothing to
capture. Derivation: what turns bytes into a value today. Validation: against
what independent evidence.

| Signal | Raw source | Capture | Derivation | Validation | Remaining risk |
|---|---|---|---|---|---|
| Frame seq / game timer / wall clock | frame record `timer`, `elapsed`; header `clock.started_epoch_s`; `game_timer_mirror` 0x900DFCFC | C / N | extractor stamps `seq,timer,elapsed_s` on every record | synthetic run | — |
| Missed frames, longest hole, pauses | frame timer gaps; elapsed stalls | N (`frame_timing`, gap list) | extractor `frame_gap`, `clock_stall` | synthetic, 3 archived games | — |
| Replay / cut-in intervals | `in_replay` via pointer 0x80794C5C+0x13561B; cut-in counter 0x900D4F24; `game_state` | N / C | extractor `replay_interval`; counter raw | pointer resolved in fake only | pointer read once; slot recorded per frame so a move is detectable |
| Count, outs, score, runs/outs this pitch | state block | C | deriver + extractor context | existing | — |
| Batter, pitcher, runners, fielders, order | actor structs, batter id/index | C | deriver | existing | — |
| Park, day/night | stadium + day/night bytes; `match_setup` | C / N | header | existing | — |
| **Port → team** | `player_type` 0x811F76B0/B1 + team batting byte 0x900D5C22/23 | **N** | extractor `side_ports` (memory only) | fake; team byte on 3 real games | first live read pending |
| **Remote / player → port** | session metadata + `map-remotes` button proof | **N** | header, never inferred | `map-remotes` pending | operator step |
| Rosters, ownership, substitutions | `team_globals` (rosters 0x8131B4B9/B9B7 × 0x8E) + actor char ids | N raw | char ids derived; roster bytes not yet | — | no substitutions planned |
| Schema, regions, exe identity | `capture_schema`, `executable_identity` | N | — | synthetic | — |
| KPAD buttons, edges, accel, pointer, device/error | `wiimote_1..4_input` (0x538 each) | C ports 1–2 / N ports 3–4 | extractor `button_edge`, `controller_state` | 3 real games: A/B/1/2/+ presses on both ports | — |
| Raw 16-sample WPAD ring | port +0x110, stride 0x38 | C | first sample decoded | swing audit layout | ring write index unknown |
| Nunchuk | KPAD ex_status +0x60 | C (in struct) | not decoded | dev_type 0 (no Nunchuk) everywhere | unused |
| Game-side processed input / buffers / cooldowns | `input_globals_pre/post` 0x80784000–0x80787800; 0x81317BB0 | **N** | none | none | discovery only |
| Offer / slap / charge / bunt | swing, bunt, charge counters | C | deriver (production) | 59/59 slap/charge | — |
| Star swing | star_swing byte + batting meter spend | C | deriver | captain swings only | non-captain & borrowed-captain spend untested |
| Charge duration / release-to-swing | charge counter | C | deriver | 34/34 | not independent of the detector |
| **Independent batter timing / contact quality** | unknown | N raw (discovery regions + memory copies) | none | none | **unobserved** |
| Bat / batter animation | batter actor struct (offense class) | C raw | none | — | fields unnamed |
| Contact, EV, launch, spray, plate XYZ, zone | ball + deriver | C | deriver | existing (zone: 141 calls) | shadow band |
| Pitcher raw input, pre-release | pitching port KPAD | C / N side | extractor `pitch_window.inputs_by_port` (−180..0 frames) | fake + 3 real games | — |
| **Pitch type request (normal/changeup)** | unknown; ball decel suggestive | N raw | none | changeup decel 6/6 within pitcher | **unobserved as input** |
| **Pitch charge start / duration / release** | not in the state block (56,959-channel sweep) | N raw + memory copies at every press and release | none | none | **unobserved** |
| **Pitch aim target** | fielding-throw aim addresses are not it | N raw + memory copies | none | plate_x sign 3/3 | **unobserved** |
| Release, trajectory, plate crossing | pitch counter + ball | C | deriver | existing | — |
| Star pitch | fielding meter spend across release | C | deriver | 9/9, 0/32 false | one pitcher, one cost |
| Both meters, every change | 0x900D4E24 / 0x900D4E26 | C (since 09-25) | extractor `star_meter_change` (before/after/delta/role) | 52 changes on a real game | preview-and-revert jumps are kept raw |
| Borrowed-captain cost (100) | header star costs + meter | C | — | never observed | lineup carries 6 borrowed captains |
| Runner path, speed, bases, close play | offense actors, fielder +0x246 | C | deriver | existing | — |
| **Shake onset / duration / intensity** | batting-port accelerometer (raw) | C raw | none | none | **unobserved as label**; speed stays `inferred_from_speed` |
| Which port moves the runners | port → team (above) | N | extractor | pending live | — |
| **Selected fielder / selection change** | unknown | N raw + memory copies at presses | none | none | **unobserved** |
| Dive / jump / Buddy request edges | fielding-port KPAD edges | C | extractor `button_edge` (unlabelled) | button→action mapping uncalibrated | needs this session's labels |
| Dive / jump / Buddy activation, hit/miss | catch_type, airborne, buddy flags | C | deriver | validated | — |
| Attempts with no animation | edge without activation | C raw | not classified | planned `miss_dive` / `miss_jump` halves | — |
| Throw target, aim error, Laser Beam | 0x900D951A, 0x900D6E60/6EB0, 0x900D9AF5 | C | deriver | 35/37, 18/18 | — |
| Hazards | stadium regions at every park | C | deriver | per park | Mario Stadium has none |
| RNG / deterministic state | unknown | N raw (discovery regions + copies) | none | none | **unobserved** |

## 2. Capture schema v3

The frame record is unchanged since MSSTRK02, so every capture ever recorded
reads through `player_tracking_io.Session`. Version is declared in the header:

| Version | What the header declares |
|---|---|
| 1 | MSSTRK01, state block only (no longer written) |
| 2 | MSSTRK02, `extra_regions`; no `capture_schema` block (everything before 2026-09-28) |
| 3 | MSSTRK02 plus `capture_schema`, `executable_identity`, `controller_sides_at_start`, `clock`, `frame_timing`, `capture_complete`, `progress` |

`--evidence-profile standard` (default) records exactly what v2 recorded and
now writes the v3 header. `--evidence-profile comprehensive` appends the
regions below after every standard region, so every older region keeps its
frame offset, and refuses to start without `--session-metadata`.

### Regions (Mario Stadium, comprehensive) — 113,068 bytes read per frame

| Frame offset | Region | Address | Bytes | Status |
|---:|---|---|---:|---|
| 0 | state_block | 0x900D4E00 | 28,480 | named (unchanged) |
| 28,480 | wiimote_1_input | 0x80784CD8 | 1,336 | KPAD layout |
| 29,816 | wiimote_2_input | 0x80785210 | 1,336 | KPAD layout |
| 31,152 | yoshi_train_position | 0x811F84DC | 12 | park-gated meaning |
| 31,164 | barrel_components | 0x92AE57C0 | 384 | park-gated |
| 31,548 | barrel_transform | 0x92AF5400 | 512 | park-gated |
| 32,060 | freezie_objects | 0x92A3E000 | 8,192 | park-gated |
| 40,252 | input_globals_pre | 0x80784000 | 3,288 | discovery |
| 43,540 | wiimote_3_input | 0x80785748 | 1,336 | KPAD layout (expected idle) |
| 44,876 | wiimote_4_input | 0x80785C80 | 1,336 | KPAD layout (expected idle) |
| 46,212 | input_globals_post | 0x807861B8 | 5,704 | discovery |
| 51,916 | game_globals | 0x80794000 | 5,120 | rules, replay pointer, ball pointer |
| 57,036 | match_setup | 0x811F7600 | 512 | stadium, day/night, branding, player_type |
| 57,548 | team_globals | 0x81317800 | 18,432 | rosters + input copy |
| 75,980 | state_extension_low | 0x900D0000 | 19,968 | discovery |
| 95,948 | state_extension_high | 0x900DBD40 | 17,088 | discovery (through the game timer) |
| 113,036 | replay_state | pointer-resolved | 32 | in_replay |

Wario City / Daisy Cruiser add `stadium_props` (≤128 KB) before the comprehensive
regions exactly as today. `region_overlaps` in the header must be `[]`; the
collector warns if a dynamically located stadium region ever collides.

Named fields: `capture_evidence_schema.EVIDENCE_FIELDS`, `KPAD_FIELDS`,
`RAW_SAMPLE_FIELDS`, each tagged with where its name came from (public tracker,
public KPAD SDK layout, or this repo). `field_offset()` refuses a field that
straddles two regions.

### Session metadata (`sluggers-evidence-session-metadata` v1)

`ports["1".."4"]` → `player`, `remote_label` (both required, labels distinct),
`nunchuk`, optional `expected_capture_side` (away = bats in the top half).
`control_changes[]` restates who holds a port from a given half-inning.
`remote_mapping_evidence` is written by `map-remotes`. The file's content and
SHA-256 go into the header. A placeholder label is rejected. The declared side
is **compared** with the game's `player_type` bytes and both are kept; neither
overwrites the other.

### Derived evidence stream (`<stem>.evidence.jsonl`, `sluggers-input-evidence` v1)

`python scripts/extract_input_evidence.py <stem>` writes raw events only:
`session`, `side_ports`, `button_edge`, `controller_state`, `star_meter_change`,
`swing_onset`, `pitch_window`, `frame_gap`, `clock_stall`, `replay_interval`,
`summary`. No labels and no outcomes: a pitch window holds only what was
knowable before release. Anything a capture did not record is `unobserved` in
`session.availability` and `null` in the records.

### Other changes in this pass

- XOR delta computed with numpy (byte-identical; measured 2.18 ms → 0.03 ms at
  40 KB, and 6.13 ms → 0.08 ms at the comprehensive 113 KB).
- zlib sync-flush every 2 s and an fsync + header checkpoint every 10 s, so a
  killed collector loses at most ~2 s. Header writes are atomic.
- `SnapshotBuilder.state()` bounded by the state block instead of the whole
  frame, so a state field above the block can never read an appended region.
- Comprehensive profile takes whole-memory copies (`memory_probe.py`) at every
  pitch release, button press and accelerometer spike: ≥90 frames apart, 2,000
  per session max; pitch releases always.

## 3. Storage and cadence

| | Value | Basis |
|---|---:|---|
| Bytes read per frame | 113,068 | layout above |
| Read + encode, synthetic | 59.97 fps, 0 missed of 1,021 | real collector vs fake Dolphin |
| Encode cost (XOR + zlib) | 1.12 ms mean, 1.51 ms p99 | 600 real frames + pessimistic churn |
| On disk, today's format | 1.9–2.1 KB/frame | 3 scripted Mario captures |
| On disk, comprehensive | ~2.5–3.5 KB/frame expected, 7.6 KB/frame pessimistic | churn from Yoshi full-memory copies |
| 9-inning session (~45 min, ~160k frames) | ~0.4–0.6 GB `.bin`, ≤1.3 GB pessimistic | |
| Memory copies | 28 MB first, then ~0.8–3 MB each; ≤2,000 | Yoshi probe copies |
| Total worst plausible | ~7 GB | free: 596 GB |

Thresholds: missed frames ≤ 0.5 %, longest hole ≤ 30 frames. The collector
prints rate and missed count every 2 s; a menu measurement is a floor, so the
first minute of the game gives the real bytes/frame.

## 4. Output paths and recovery

Written to `data/player_tracking/<park>-<UTC>`: `.json` (header),
`.bin` (frames), `.pitches.jsonl`, `.live.jsonl`, `.probe/` (memory copies),
then postgame `.calibration.json`, `.plays.jsonl`, and on request
`.evidence.jsonl`. The preview's own manifest and stop file are
`data/player_tracking/preview-<start>.manifest.json` / `.stop`.

- **Normal stop:** let the game end, then Ctrl-C the preview once. The backend
  flushes the capture and runs calibration + derivation.
- **Collector died mid-game:** the `.bin` is readable up to the last 2-second
  flush and the header says `capture_complete: false` with a `progress`
  checkpoint. The preview relaunches the collector within 5 s into a new stem;
  keep both.
- **Rebuild everything from raw:**
  `python scripts/calibrate_player_tracking.py <stem>`,
  `python scripts/derive_player_metrics.py <stem>`,
  `python scripts/extract_input_evidence.py <stem>`.
- **Verify any capture:** `python scripts/evidence_preflight.py offline <stem>`.

Nothing in this path writes to Supabase. `scripts/ingest_player_tracking.mjs` is
never run automatically by the preview.

## 5. Preflight report (2026-09-28)

`python scripts/evidence_preflight.py report` — results in
`data/calibration/evidence-preflight-report-v1.json`.

| Gate | Status | Evidence |
|---|---|---|
| Collector starts, v3 header, metadata recorded, sides agree | pass | synthetic |
| Both controller structs change independently | pass (synthetic, 3 real archived games) / **pending live** | `map-remotes` |
| Both star meters change independently | pass (synthetic; real: 17 away / 35 home changes) | |
| Raw button + motion with frame timestamps | pass | synthetic + archived |
| Ball / actor / count / meters synchronized on one clock | pass | pitch windows = release frame |
| Old captures read and derive unchanged | pass | 3 archived v2 captures fully read; v3 re-frame derives byte-identical plays/pitches |
| Cadence and missed frames | pass (fake) / **pending live** | |
| Crash preserves partial evidence | pass | killed collector: 485 frames recovered |
| Expanded regions readable, meters readable, disk | **pending live** | `live` |
| Player / remote / port mapping configured | **pending** | `map-remotes` |

## 6. A finding about the September 25 captures

In all three scripted Mario captures the **top-half batter is on port 2**:
the port-2 accelerometer peaks 2–4 frames after the swing animation starts on
29 of 31 top-half pitches, while port 1 peaks at the release frame (the
pitcher). `audit_swing_gesture_calibration.py` assumed `PORT_BY_HALF = {0: 1,
1: 2}` from the plan, so its raw-motion features were computed from the
**pitcher's** remote. The production slap/charge detector is unaffected (it
reads the game's charge counter). The 70.0 % / 75.9 % raw-motion result is
therefore not evidence about the batter's motion either way; it was not re-run
here. New captures carry the port→team mapping from memory.

## 7. Verification

| Command | Result |
|---|---|
| `python -m unittest tests/evidence_capture_test.py` | 39 passed |
| `node --test tests/tracker-preview-launcher.test.mjs` | 16 passed |
| `npm run test:tracker` | 602 passed |
| `python scripts/verify_player_metrics.py` | all checks passed |
| `npm run test:acceptance` | 41/43; the 2 failures are pre-existing ingest pitch-join warnings on `.pitches.jsonl` files rewritten 09-25 (ingest untouched here) |
| `python scripts/evidence_preflight.py synthetic` | 16/16 checks |
| `python scripts/evidence_preflight.py offline <3 archived stems>` | all frames read |
| v3 re-frame of `mario_stadium-20260925T165659Z` with random appended bytes | calibration, 27 plays, 41 pitches byte-identical |
