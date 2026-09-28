# Folder cleanup audit — 2026-09-15

**Handoff to Opus.** Most space is valuable capture evidence. Start with generated build/cache files; do not clear `tmp/`, tracker folders, or ignored data wholesale. This audit made no project changes other than this report.

## Authorized bounded execution — 2026-09-15

This section records the subsequent authorized pass; the original inventory and future-batch suggestions below remain historical. This pass is limited to five executable aliases, inaccurate `.gitignore` comments, and this report. The user's instruction to retain any actively used or unverifiable alias supersedes the earlier suggestion to redirect overrides. No launch configuration is changed.

### Original executable inventory and recovery

All paths below are relative to `C:\Users\jdono\Sluggers`. Each file was resolved inside that workspace, with the workspace, executable directory and each file checked for reparse points. None was a reparse point. Git status showed no changes to any of these six tracked files; their index flags were ordinary `H` entries.

| Original path | Original bytes | Disposition |
|---|---:|---|
| `sluggers-stat-tracker-advanced-stats-dev/sluggers-stat-tracker-advanced-stats-v14.exe` | 9,925,305 | Retain as exact recovery source |
| `sluggers-stat-tracker-advanced-stats-dev/sluggers-stat-tracker-advanced-stats-v15.exe` | 9,925,305 | Removed; verified unused |
| `sluggers-stat-tracker-advanced-stats-dev/sluggers-stat-tracker-advanced-stats-v16.exe` | 9,925,305 | Removed; verified unused |
| `sluggers-stat-tracker-advanced-stats-dev/sluggers-stat-tracker-advanced-stats-v17.exe` | 9,925,305 | Removed; verified unused |
| `sluggers-stat-tracker-advanced-stats-dev/sluggers-stat-tracker-advanced-stats-v18.exe` | 9,925,305 | Removed; verified unused |
| `sluggers-stat-tracker-advanced-stats-dev/sluggers-stat-tracker-advanced-stats-v19.exe` | 9,925,305 | Removed; verified unused |

Fresh complete SHA-256 for **each of all six files**: `06971cd179aec3402d063a5e603d7ccdebcdbb7c7c85d2d8ed42fabfbea9c91f`. Equal size and hash establish that copying v14 under any original alias restores the exact original bytes.

Exact recovery instructions: in PowerShell, use the following to restore the five missing names. It refuses to overwrite an existing alias or use a reparse-point source/directory, and verifies each restored copy. These instructions are documented for recovery, not executed during cleanup.

```powershell
$ErrorActionPreference = 'Stop'
$recoveryRoot = 'C:\Users\jdono\Sluggers'
$recoveryDir = 'C:\Users\jdono\Sluggers\sluggers-stat-tracker-advanced-stats-dev'
$recoverySource = Join-Path $recoveryDir 'sluggers-stat-tracker-advanced-stats-v14.exe'
$expectedHash = '06971cd179aec3402d063a5e603d7ccdebcdbb7c7c85d2d8ed42fabfbea9c91f'
foreach ($checkPath in @($recoveryRoot, $recoveryDir, $recoverySource)) {
    if ((Get-Item -LiteralPath $checkPath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Reparse point rejected: $checkPath"
    }
}
if ((Get-FileHash -LiteralPath $recoverySource -Algorithm SHA256).Hash -ne $expectedHash) {
    throw 'Recovery source hash mismatch'
}
foreach ($version in 15..19) {
    $destination = Join-Path $recoveryDir "sluggers-stat-tracker-advanced-stats-v$version.exe"
    if (Test-Path -LiteralPath $destination) { throw "Already exists: $destination" }
    Copy-Item -LiteralPath $recoverySource -Destination $destination
    if ((Get-Item -LiteralPath $destination).Length -ne 9925305 -or
        (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $expectedHash) {
        throw "Recovery verification failed: $destination"
    }
}
```

### Checks and scope

- Read `CLAUDE.md`, this audit, launcher orchestration documentation, launcher source and the selected test harnesses. No applicable `AGENTS.md` or additional `CLAUDE.md` was found.
- Searched current workspace text, including ignored/untracked text and capture metadata, for v15–v19 names and `TRACKER_EXE_PATH`; excluded binary payloads, dependencies and Git internals. Candidate names occurred only in this audit. Other override references were the two live launcher sources, a fake-executable test helper and a historical bridge backup. No workspace launch scripts, shortcut files or IDE launch configuration selected a candidate; `.vscode/` and `.github/` were absent.
- `TRACKER_EXE_PATH` was absent from process, user and machine environment settings and all three root `.env*` files. Only presence/matching-alias information was printed, never secrets or complete environment contents.
- The initial sandboxed CIM process query returned access denied. The same read-only query succeeded outside the sandbox: 237 processes inspected, with no tracker, Dolphin, launcher or candidate running. The only matching command was the inspection PowerShell process itself. Process paths and sanitized alias/override matches were inspected without printing full command lines.
- Inspected 218 shortcuts across user/common Desktop, user/common Start Menu and pinned taskbar locations: no Sluggers/tracker launch references. No shortcuts or launch settings were changed.
- Confirmed both current defaults are dev `sluggers-stat-tracker-advanced-stats-v28.exe`; bridge fallback order remains Windows `sluggers-stat-tracker-live-v2.exe`, `sluggers-stat-tracker-live.exe`, `sluggers-stat-tracker.exe`.
- Verified consumers: `scripts/probe_stadium_objects.py:380` reads the `--analyze` input, including documented `dk_objects.jsonl`; `scripts/extract_batted_balls.mjs:97` recursively discovers logs and reads them; `scripts/projection_error.mjs:24` recursively reads dev tracker logs, including `output/`. Corrected the two inaccurate `.gitignore` probe/log comment blocks to identify consumers and warn that ignored observations may be unique and are not disposable. Also corrected the binary comment's claim that historical aliases must remain in the working directory. All ignore patterns and unrelated comments/edits are preserved.
- Before removal, `node --test tests/tracker-preview-launcher.test.mjs tests/mss-autogame-launcher.test.mjs` passed **56/56**, exit 0. Side-effect review confirmed guarded imports, fake child processes and an in-memory database; test files are confined to disposable OS temp directories, and preview checks use temporary loopback listeners. No live bridge, emulator, ingestion, repair or database-writing command ran. No broad suites, builds or new tests/tooling were added.
- Pre-existing failure, from the original audit only: archive verification had failed with 5,686 log flights versus 5,687 archive flights and 0.487952-unit first-touch disagreement. It was not rerun or attributed to this cleanup. The selected launcher baseline had no failures.

### Execution outcome

- **Removed exactly v15, v16, v17, v18 and v19:** five files, **49,626,525 actual logical file bytes (47.33 MiB)** removed from the working directory. This counts the deleted executable bytes, not filesystem allocation or net savings after report/comment growth. No candidate alias needed retention; v14 remains the recovery source. The inventory and recovery instructions were recorded here before removal.
- Immediately before deletion, Git status was rechecked for all six files, all six full SHA-256 hashes/sizes were rechecked, and each working blob was independently compared with its HEAD blob. All matched. Each absolute target was validated within the workspace and rejected if a directory or reparse point; removal used only `Remove-Item -LiteralPath` on the five verified files.
- **Post-change validation:** the same two existing launcher test files passed **56/56**, exit 0. Static extraction from launcher source confirmed that all four bridge default/fallback paths and the preview default exist. v14, v26, v27, v28 and all three Windows fallbacks exist; v14 still has the recorded full SHA-256. No cleanup-caused failure or recovery copy was necessary.
- Repeated the workspace reference scan after removal: v15–v19 names appear only in this audit, including its recovery instructions. No operational reference points to a removed file.
- Preservation verification compared hashes for **1,835 other tracked/untracked regular files**, excluding only the five authorized aliases, `.gitignore` and this report: unchanged. Git status gained exactly the five unstaged deletions and lost no pre-existing status entry. The `.gitignore` non-comment patterns are identical to their pre-pass values; `git diff --check -- .gitignore` passed (only Git's LF/CRLF conversion notice).
- **Git history was not reduced or rewritten.** HEAD remains `c170fadca49ca6ef3676c72d4fa092c7e59283f9`; the Git index hash is unchanged and nothing is staged. No commit, push, deployment, live-data modification, pruning or history operation occurred. This report remains the pre-existing untracked file, now extended.
- Kept all distinct builds, fallback runtimes, templates and output folders. `dist/`, caches, workspace `tmp/`, research/capture data, tests, dependencies, nested repositories and all other files were left untouched. The only text edits are the three inaccurate `.gitignore` comment blocks described above and this execution record. Stop here; no other cleanup batch was performed.

## State and scope

- Read root `CLAUDE.md`; no `AGENTS.md` or additional project `CLAUDE.md` found in the workspace/ancestor instruction search. Inventory included hidden and ignored files and skipped reparse points; none were found.
- Parent HEAD: `c170fad` (2026-09-09). **89 modified tracked files, 184 untracked files plus one untracked nested repository; nothing staged.** Tracked diff: 11,833 insertions / 3,293 deletions. Status remained unchanged through inspection before this report was created.
- Protect all existing changes, particularly `.gitignore`, `package.json`, capture sidecars, `data/flight_archive.jsonl.gz`, tracker scripts, UI changes, tests, `docs/prompts/`, and untracked `supabase/migrations/20260914120000_season_free_agent_pickup.sql`. Never use blanket clean/reset or stage unrelated changes.
- `public-tracker-release/.git` is an independent repository, **not a submodule**. Its HEAD is `a5bd79c` (2026-09-14); its working tree is clean: 40 tracked files / 537,884 bytes, 2,310 ignored files / 49,304,712 bytes. Parent Git cannot restore this repository's ignored files. Preserve both histories.
- Parent working files: 1,657 tracked / 539,567,711 bytes; 184 untracked / 65,982,143 bytes; 15,715 ignored / 6,701,552,416 bytes. These totals exclude Git internals and the nested repository.
- Secrets/configuration were excluded from report content. Retain `.env`, `.env.tracker-bridge`, `.env.example`, `.claude/`, Supabase linkage/configuration, manifests and lockfiles. Checked local environment files for an executable override without reporting values; none contained `TRACKER_EXE_PATH`.

## Where the space goes

Sizes are logical file bytes, including ignored files, not filesystem allocation. Rows overlap only where noted.

| Path | Bytes / files | Significance |
|---|---:|---|
| Entire workspace | 8,279,757,583 / 27,952 | 7.71 GiB before this report |
| `data/player_tracking/` | 4,953,138,828 / 511 | Largest source; raw games, memory snapshots, sidecars |
| `data/calibration/` | 1,176,558,530 / 20 | Mostly unique probe evidence |
| `.git/` | 922,367,157 / 7,971 | History/objects; separate from working-file clutter |
| `sluggers-stat-tracker-advanced-stats-dev/` | 744,770,264 / 240 | Runtime binaries, recordings and workbooks |
| `node_modules/` | 194,431,780 / 14,795 | Installed dependencies, ignored |
| `tmp/` | 95,262,896 / 806 | Mixed evidence and scratch; 580 files / 49,330,556 bytes are tracked |
| `public-tracker-release/` | 50,288,156 / 2,425 | Independent release source, environment, packaging |
| `dist/` | 44,235,036 / 318 | Generated website output |
| `public/` | 41,701,456 / 236 | Assets copied into website output |
| `sluggers-stat-tracker-windows/` | 30,000,187 / 25 | Live bridge fallbacks and historical outputs |
| `scripts/`; `docs/`; `tests/` | 8,584,490 / 157; 1,927,040 / 40; 1,370,350 / 110 | Small beside captures; scripts include 5.10 MB fence evidence |

**Deployment:** `package.json` builds with Vite. `vite.config.js` explicitly builds both `index.html` and `tracker-preview.html`; keep both. Installed Vite defaults copy all `public/` into `dist/` (confirmed in `node_modules/vite/dist/node/chunks/dep-Dq2t6Dq0.js`, `prepareOutDir`). All **236 public files / 41,701,456 bytes** have SHA-256-identical counterparts in `dist/`. `public/stadiums/` contributes 27,529,345 bytes and `public/audio/` 8,397,137. Removing local build output saves disk, not deployed payload. `vercel.json` supplies the SPA rewrite; remote deployment settings were not inspected. Nested release CI separately packages binaries and publishes a generated GitHub Pages page.

## Candidate decisions

Git: **T** tracked and unchanged; **M** modified; **U** untracked; **I** ignored; **N** status belongs to nested repository. “Retain” means there is no proven replacement; preserve the original, especially material Git cannot recover.

### Generated material

| Exact path | Bytes / Git | Classification, evidence and recovery |
|---|---:|---|
| `dist/` | 44,235,036 / I | **SAFE CLEANUP**, when no preview process needs it. Vite build destination; retained source, public files and lockfile recreate it with `npm run build`. Keep current source changes; rebuilding need not reproduce an older bundle byte-for-byte. |
| `scripts/__pycache__/`; `tests/__pycache__/` | 806,330; 16,207 / I | **SAFE CLEANUP**. Every cached module has a corresponding retained `.py` source; normal Python imports regenerate these. No sourceless module found. |
| `public-tracker-release/build/` | 15,383,999 / N:I | **SAFE CLEANUP**. PyInstaller analysis, archives and intermediate executable; `build.py:clean()` deliberately removes this directory before rebuilding from the retained spec/source/locked environment. Do not remove the adjacent release source or environment. |
| `public-tracker-release/__pycache__/`; `MemoryHandling/__pycache__/`; `advanced_tracking/__pycache__/`; `advanced_tracking/engine/__pycache__/`; `tests/__pycache__/` (all under `public-tracker-release/`) | 149,579; 69,877; 64,910; 206,298; 49,883 / N:I | **SAFE CLEANUP**. All have corresponding source modules. Regenerated by Python. |
| `public-tracker-release/.ruff_cache/` | 2,722 / N:I | **SAFE CLEANUP**. Linter cache; regenerated on linting, no runtime source. |
| `tmp/tracker-acceptance/pipeline-rows.json` | 7,893,068 / I | **SAFE CLEANUP with ordering requirement**. Written by `tests/tracker-acceptance.test.mjs:106–115`; read by `tests/tracker-acceptance-browser.mjs:17`. Recreate with `npm run test:acceptance` before browser acceptance. Preserve recordings and expectations below; do not remove the browser test's input and then run it alone. |
| `node_modules/`; `public-tracker-release/.venv/` | 194,431,780; 11,960,461 / I; N:I | **KEEP** for ongoing work. Reinstallable dependencies, but deleting creates setup/network costs rather than source cleanup. Keep `package-lock.json`, `uv.lock`, manifests and requirements files. |
| `public-tracker-release/dist/`; `public-tracker-release/sluggers-stat-tracker-windows-preview.zip` | 10,805,468; 10,611,515 / N:I | **KEEP** release/runtime artifacts pending release-lifecycle confirmation. Every file inside the ZIP hashes identically to its counterpart in nested `dist/`; the ZIP can recover those exact three files. Separate extracted runtime and distribution locations can be intentional. `build.py`, spec and release workflow consume/create `dist/`. |

### Captures, tracker runtimes and research

| Exact path | Bytes / Git | Classification, evidence and recovery |
|---|---:|---|
| `data/player_tracking/` | 4,953,138,828 / T,M,U,I | **KEEP** all session families. Includes 50 `.bin` captures (4,135,683,892 bytes), 79 `.zlib` snapshots (640,571,492), annotations and two `.annotations.jsonl.bak` files (2,765,406). `player_tracking_io.py`, replay/derive/ingest scripts consume paired paths; `search_memory_probe.py` reads probe indexes, named dumps and calibration; metric verification discovers sessions by glob. Backups are not hash duplicates of current annotations. Replaying a game is not recovery of the same observations. |
| `data/calibration/` | 1,176,558,530 / T,M,U,I | **KEEP**. `dk_objects.jsonl` alone is 1,153,318,359 bytes, ignored; `probe_stadium_objects.py:43` explicitly reads it in `--analyze` mode. Retain `dk_mem1.jsonl`, `dk_motion.jsonl`, `dk_objects2.jsonl`, `dk_objects_victims.jsonl`, `dk_stun.jsonl`, and U `peach_motion.jsonl` (2,119,917). Findings in prose cannot replace raw memory observations. Retain model inputs, splits, evaluations, gate evidence and modified `next-game.json`; calibration tooling discovers/reads them. |
| `scripts/fence_samples/` | 5,101,258 / I | **KEEP** all 32 files. `derive_fence_geometry.py:102` and `fit_infield_scale.py:76–78` discover park/session CSVs by glob. Geometry parameters omit raw measurement scatter and provenance. |
| `sluggers-stat-tracker-advanced-stats-dev/preview-sessions/`; `sluggers-stat-tracker-advanced-stats-dev/preview-session.log` | 296,909,069; 3,951,238 / I | **KEEP**. Written by preview/bridge; recursively consumed by flight extraction and projection analysis; two logs are acceptance fixtures. Archive verification failed (below). No lossless recovery from derived flights. |
| `sluggers-stat-tracker-advanced-stats-dev/output/` | 136,305,172 / T,U,I | **KEEP** 50 logs (135,637,191 bytes) and 50 workbooks (667,981). Bridge watches `*.xlsx` in the selected executable's output directory (`live_tracker_bridge.mjs:241,3486`); research recursively reads `.log`. Seventeen workbooks are untracked. Workbook totals are independent test oracles, not substitutes for logs. |
| `sluggers-stat-tracker-windows/` | 30,000,187 / T | **KEEP**. Bridge fallback order explicitly names `sluggers-stat-tracker-live-v2.exe`, `sluggers-stat-tracker-live.exe`, then `sluggers-stat-tracker.exe` (`live_tracker_bridge.mjs:229–241`). It launches with the executable directory as working directory. Local template, branding and output layout matter. |
| `sluggers-stat-tracker-advanced-stats-dev/sluggers-stat-tracker-advanced-stats-v28.exe` | 9,930,118 / I | **KEEP** current default for bridge and standalone preview. Do not mistake ignored for optional. Keep v26/v27 (9,929,801 / 9,929,934 bytes, I) and other distinct historical builds until rollback/build provenance is established. |
| `public-tracker-release/` source and `.git/` | See inventory / parent U, nested clean | **KEEP** independent public tracker. Source implements offline advanced Excel export with isolated worker; README explicitly excludes stadium-specific measurements. Its engine is not interchangeable with the site's current derivation. Nested commits `fc0fabf`, `1d9f80d`, `2f79ba9`, `a5bd79c` explain workbook, worker and packaging roles. |
| `data/flight_archive.jsonl.gz` | 9,863,585 / M | **KEEP**, plus raw inputs. Flight retention deliberately trims caught/unknown samples after 3 seconds, drops foul samples, and excludes pitch/lineup/runner information (`flight_archive.mjs:1–25,50–58`). |

**Critical verification, actually run read-only:** `node scripts/distill_flights.mjs --verify` exited 1: 5,686 log flights versus 5,687 archive flights; both had 686 scorable keys, but worst first-touch disagreement was **0.487952 units**, exceeding the 0.0001 tolerance. Even a pass would establish only projection equivalence, not preservation of all log information. Ignore comments claiming these dumps/logs are “read by nothing” are contradicted by consumers; correct those comments in a later authorized edit without discarding the current `.gitignore` changes.

### Hash-proven duplication and possible consolidation

SHA-256 was calculated for equal-size working files outside dependency trees/Git internals, including ignored/untracked candidates. Similar names were not treated as identity.

| Exact candidates and destination | Evidence | Decision and required preservation |
|---|---|---|
| `sluggers-stat-tracker-advanced-stats-dev/sluggers-stat-tracker-advanced-stats-v15.exe`, `-v16.exe`, `-v17.exe`, `-v18.exe`, `-v19.exe` (same full prefix); retain `sluggers-stat-tracker-advanced-stats-v14.exe` in that directory | All six T files are 9,925,305 bytes; SHA-256 `06971cd179aec3402d063a5e603d7ccdebcdbb7c7c85d2d8ed42fabfbea9c91f`. Introduced in `33fd939`. `scripts/verify_tracker_build.py:3–9` independently documents the failed rebuilds. | **CONSOLIDATE**, saves 49,626,525 bytes (47.33 MiB). No literal consumers of v15–v19 found, including ignored/untracked text and capture metadata. Preserve the version-to-hash equivalence in this report; current v28 and fallbacks stay. Before execution, inspect active processes/local launch configurations for dynamic `TRACKER_EXE_PATH`; redirect any such aliases to v14. Copying retained v14 back under any removed name restores identical bytes. Git history also preserves them. |
| `sluggers-stat-tracker-advanced-stats-dev/sluggers-stat-tracker-live-v2.exe`, `sluggers-stat-tracker-live.exe`, `sluggers-stat-tracker.exe`; equivalent files in `sluggers-stat-tracker-windows/` | Respectively 9,912,947; 9,912,554; 9,911,946 bytes. SHA-256 prefixes `afaca6fecbba`, `b2af012839f9`, `90a9951fb714`; each pair compared in full. | **UNCERTAIN**, retain. The Windows copies are active fallback paths. Although dev copies could save 29,737,447 bytes, redirecting a manually selected executable also changes working directory and default output destination. Destination would be Windows copies, but overrides/output behavior must first be preserved. |
| `ball_shortlist.dmw`, `ball_shortlist2.dmw`, `ball_shortlist3.dmw` | Each T, 1,389 bytes; SHA-256 `f68a1410ecb29d28f193fe93ef1dd5dbb0718e35eb96bae8dcd1341f91147eed`; `828931b`. | **UNCERTAIN**, retain. Canonical destination could be `ball_shortlist.dmw`, but an external memory-watch GUI may remember each filename. Saving 2,778 bytes does not justify breaking an uninspected tool session. |

Other exact duplicates intentionally retained: both runtime templates (17,581 bytes each) and branding (460 each) require their local paths; public release template differs (17,735). All 20 Windows output files have identical counterparts in dev/output, but output-folder discovery/recovery roles remain. The two dev workbooks `Monsters vs Monkeys - 2026-08-28 09-20-43.xlsx` and `Monsters vs Monkeys - 2026-08-28 09-20-43_529915.xlsx` are identical (12,867 bytes), but preserve game/export provenance. Nested `advanced_tracking/engine/mss_character_ids.json` equals `scripts/mss_character_ids.json` (1,551 bytes); each separately packaged consumer needs a local file. No exact source-test duplicates were found.

### Scratch, root files, docs and tests

| Exact path or bounded family | Bytes / Git | Decision and evidence/recovery |
|---|---:|---|
| `tmp/race-qa/`; `tmp/tracker-preview-cleanup/`; `tmp/tracker-console-ux-20260905/`; `tmp/tracker-reliability-20260905/` | 42,171,062; 11,099,861; 9,909,011; 13,054,369 / T and/or I | **UNCERTAIN**, retain. Scratch includes 198 screenshots / 63,863,224 bytes overall, but these folders also contain generators, state-specific captures, fresh derivations and repros. Reliability report cites corrected strict-JSON output versus historical NaNs. Hashing found 11,718,953 redundant bytes across 26 tmp-only groups; identical pixels do not establish identical timing/provenance. No bulk screenshot deletion. |
| `tmp/qa/`; `tmp/launcher-hardening-20260905/`; `tmp/acceptance-20260906/`; `tmp/review3-ingest-fixture/`; `tmp/review4-ingest-fixture/` | 162,211; 440,665; 14,181; 1,044; 1,162 / T and/or I | **KEEP** operational/reproduction evidence. `tmp/qa/run.mjs` dynamically loads step scripts; launcher docs reference CLI/fake-child scenarios, including paths with spaces. Ignored review scripts consume local fixtures. Do not run these live QA scripts during cleanup. |
| `tmp/*.sql`, `tmp/supabase_repair_apply/`, `tmp/supabase_stats_backup_pre_repair.json`, `tmp/tournament1_pre_stable_patch_backup.json`, `tmp/workbook_restore_check.json`, `tmp/Mario Super Sluggers Tournament.fixed.xlsx` | SQL across tmp: 432,608; repair folder: 148,166; named JSONs: 707,986 / 680,976 / 614,674; workbook: 857,808 / predominantly T | **KEEP** recovery material. `docs/betting-field-source-map.md` cites the repair migration tree. `stats_repair_patch.sql` exactly equals nested `071_tournament1_plate_appearance_repair.sql` (110,181 bytes), but ad hoc patch versus applied-migration ledger are distinct roles. Other repair SQL duplicates likewise lack established retirement lifecycle. |
| `tmp/big-d-voice-lines-extract/`; `tmp/dolphin-memory-engine-2026.06.25-source.zip`; `tmp/dme-source-2026.06.25/`; remaining `tmp/` | 2,387,448; 300,304; 940,250; remainder / T or I | **UNCERTAIN**, retain. Audio source/extraction, third-party investigation source, logs and one-off repros have not been proven recoverable or superseded. No live-data-writing script was run. |
| `ball_candidates_a.cs.csv`, `ball_candidates_b.csv`, `ball_coordinates_stable.dmw`, `ball_pointer_test.dmw`, `ball_shortlist*.dmw`, `boot2_watchlist.dmw`, `boot2_y_candidates.dmw` | 83,764 total / T | **KEEP** unique memory-search/reference material, with shortlist alias uncertainty above. CSVs contain address candidates; DMWs contain structured watch definitions. No automatic consumer found; interactive Dolphin memory tooling does not need a source import. |
| `tournament1_dump.json`; `supabase-schema.sql`; `supabase-rls-fix.sql` | 251,264; 11,054; 1,022 / T | **KEEP** recovery/reference. Dump contains Settings, Lineups, Bracket, Data, Tourney Summary; import tools accept workbook JSON by CLI argument. Schema is read by `download_character_images.py:12,145` and cited by docs. RLS repair's lifecycle is unestablished. Initial history `4a08c47`; schema later changed in `828931b`. |
| `lineup.json` | 4,498 / I | **KEEP** current configuration/export. Re-export would depend on changing live state; ignored/generated status alone is insufficient. |
| `verify_banner.mjs`; `verify_link.mjs`; `peach_page.png`; `tests/_debug_ui.mjs` | 760; 893; 99,677; 2,041 / T | **KEEP** small diagnostic tools/evidence. Root scripts exercise career banner and character navigation; `verify_link.mjs` produces the screenshot. Debug UI uses real betting fixture plugin and prints card/ticket/chart state. Do not run credentialed browser checks in this pass. Existing betting UI tests assert net profit, ticket grouping and chart interaction, but do not replace every root career-page check. |
| `bridge_stdout.log`; `bridge_stderr.log`; `debug.log` | 661; 0; 6,762 / T,T,I | **UNCERTAIN**, retain. Small historic diagnostics; insufficient producer/lifecycle evidence to justify a separate batch. |
| `public/auto-team/` | 927,319 / 18 T files + 2 I configs | **UNCERTAIN deployment clutter; KEEP source**. Entire extracted upstream project ships through Vite, including 873,765-byte `uv.lock` and IDE metadata. Site automation now runs `scripts/mss_autoteam.py`/`mss_input.py`; no literal site/download consumer of this public path found. Upstream `main.py` still reads/writes relative `teams.json`/`options.json`, and its build copies them. Potential later destination: `tools/MSS-AutoTeam/`, preserving the whole tree, ignored configs, attribution and lockfile. Resolve direct/public URL consumers and launch working directories before moving; external links were not observable. No deletion based on absence of imports. |
| `docs/`, `QA_TASKLIST.md`, `scripts/`, `tests/` excluding classified caches | See inventory; QA 9,465 / T,M,U | **KEEP**. `docs/overhaul-plan/` (66,943 bytes) carries feature requirements; `docs/player-tracking-qa/` (41,152) records measured cases; seven `docs/betting-experience/` images (1,512,486) are referenced by the handoff and generated by `tests/browser/captureBettingScreenshots.mjs`. New `docs/prompts/` corresponds to unfinished/current work. Backfills, migration tools, raw-capture analysis and regressions remain useful even when absent from package scripts. No plan/test consolidation proposed. |

**Coverage to preserve:** `tests/defensive-efficiency.test.mjs` distinguishes fieldable balls, reached-on-error, strikeouts, walks and HR; advanced-defense tests cover separate opportunity/persistence behavior. Character identity tests cover name normalization and absent-roster handling. Modified/untracked auth and editor suites cover overlapping requests, logout/unmount, same-user refresh, colliding competition IDs, save identity and transactional corrections. Keep fake-database unit tests **and** PGlite migration tests **and** recorded-game acceptance; they exercise different boundaries. Some useful suites are not in the named package scripts, which is not evidence for removal.

Acceptance fixture paths requiring special protection (`tests/helpers/trackerAcceptanceWorld.mjs:44–91`):

- `sluggers-stat-tracker-advanced-stats-dev/preview-sessions/preview-2026-09-04_13-10-49.log` and `preview-2026-09-04_11-21-37.log` (same directory, both ignored).
- All sidecars/captures for `data/player_tracking/luigis_mansion-20260904T171123Z` and `data/player_tracking/peach_ice_garden-20260904T152214Z`.
- `sluggers-stat-tracker-advanced-stats-dev/output/Knights vs Spitballs - 2026-09-04 13-33-40.xlsx` and `Fireballs vs DK Wilds - 2026-09-04 11-47-26.xlsx` (same directory); `tests/fixtures/tracker-acceptance-expected.json`.

## Small execution batches for Opus

These are future actions, not permission to execute cleanup in this audit. Recheck status, hashes and process use first; preserve existing uncommitted work. On Windows resolve each target inside this workspace, reject reparse points, and use literal paths. Stop if a target has changed since this inventory.

1. **Safest first batch: `dist/`, `scripts/__pycache__/`, `tests/__pycache__/` only.** Reclaims **45,057,573 bytes (42.97 MiB)** across 346 ignored files. Retain all inputs and dependencies; when an authorized cleanup proceeds, regenerate the website with existing `npm run build`. Bytecode recreates on import. Rebuilding consumes the reclaimed build space again; this is housekeeping, not permanent source-size reduction.
2. **Nested build intermediates/caches only:** `public-tracker-release/build/`, the five listed nested bytecode directories, `.ruff_cache/`: 15,927,268 bytes (15.19 MiB). Keep `.venv/`, `dist/`, ZIP, source and `.git/`. Existing nested validation is `uv run python -m unittest discover -s tests -v`; recovery build is `python build.py` from the nested root (it cleans build outputs and may install dependencies).
3. **Historical executable consolidation:** remove only the five v15–v19 aliases after the stated override/process checks; retain v14, current v28 and fallback runtimes. Recovery: copy retained v14 to the original names. Existing relevant checks: `npm run test:tracker`, then `npm run test:acceptance` if any path selection is updated. No real game or bridge ingestion is required for this batch. Deleting tracked binaries changes the working tree; it does not remove their bytes from Git history.
4. **Optional generated acceptance output:** delete only `tmp/tracker-acceptance/pipeline-rows.json` when not under review; regenerate with `npm run test:acceptance`, then `npm run test:acceptance-browser` in that order. Savings are temporary. Retain all fixture inputs and unique scratch evidence.

Other existing validations for a later, separately justified change: `npm run test:defense`, `python scripts/verify_player_metrics.py`, `npm run test:persistence`, `npm run test:database`, `npm run test:betting-ui`; `node scripts/verify_speed_against_attributes.mjs` only if metric derivation changes. Build/test/recovery commands in these batches were **read from the project, not executed here**: the user required a read-only pass, overriding the local preference to run every proposed command. Only the explicitly read-only archive verification above was executed; no build, repair, ingestion, migration, live browser action, dependency installation or database write occurred.

## Limits and retained uncertainties

This is static consumer tracing plus inventory, hashes and targeted history, not exhaustive semantic equivalence or a successful build certification. Searches included ignored/untracked text, dynamic CLI paths, recursive log/session discovery, subprocess working directories, fixtures, package scripts, Vite defaults and nested release rules. Large raw captures were inventoried; not every frame, screenshot or workbook cell was interpreted. No-reference results were never sufficient for deletion. External shortcuts, Dolphin GUI sessions, direct download links, remote deployment settings and remote backup availability remain unverified.

Git reports 7,918 loose objects (~875 MiB) and one ~4.27 MiB pack. Compression may reduce `.git/` independently, but no object reachability/backup audit was done; **KEEP history**, with no pruning or rewrite in this plan. Root histories (`828931b`, `02ade50`, `a0c3357`, `4a08c47`) establish provenance, not expiration. Never assume a parent Git commit protects the ignored captures or nested release tree. The largest apparent savings are deliberately excluded because losing those inputs would undermine recovery, research and realistic regression coverage.

## Focused historical QA artifact assessment — 2026-09-15

This follow-up inspected only the four previously unresolved QA trees. Status and inventory are exact: `tmp/tracker-preview-cleanup/` is 54 ignored files / 11,099,861 bytes; `tmp/tracker-console-ux-20260905/` is 40 ignored files / 9,909,011 bytes; `tmp/tracker-reliability-20260905/` is 16 ignored files / 13,054,369 bytes; and `tmp/race-qa/` is 214 tracked, unchanged files / 42,171,062 bytes. A workspace-wide search including ignored and untracked text found no package script, maintained test, import, glob discovery, or other workspace consumer of these directories. The only references are their own generators/reproducers, this report, and `docs/tracker-reliability-review-2026-09-05.md`. Historical scripts were read but not run; several target real local sessions and Supabase data.

**Keep the unique evidence and reproducers.** The preview tree's retained `before-*`/`after-final-*` pair proves the layout change at 1366×768 and 1920×1080; `after-final-warning-*`, `after-missing-*`, and `after-long-name-*` are distinct application states, and `verify-static.json`/`verify-live.json` record selection, page/rail scroll, disclosure, annotation, overflow, and live-update results. The console tree's baseline, four real-session desktop/mobile/diagram/header sets, and seven full/header failure-state pairs differ by session, viewport, completeness, warning state, or failure mode. `tests/tracker-console-ui.test.mjs` asserts the state/model contract (including feed states at 553–584 and malformed/partial inputs at 1026), but does not replace `verify.mjs`'s real-browser checks across seven recordings: selection stability, warning jumps, 14 focus targets, accessible names, SVG alternatives, render cost, and zero horizontal overflow. Likewise, `tests/tracker-annotations.test.mjs:173–208` replaces the server-side annotation persistence assertion, but not the preview scripts' browser controls, pinned-selection/scroll behavior, or visual states. No repro script is therefore classified as superseded by a maintained test.

The reliability tree's five fresh `.plays.jsonl` files and four `.live.jsonl` files are unique dated evidence behind the documented 398-play live/postgame parity result and the strict-JSON fix; none matches its currently retained canonical derivative. Keep both small repro scripts: `replay-recorded-log.mjs` exercises saved-log joins/finalization, while `scan-archive-integrity.mjs` records the 106-file/8,153-record archive scan; no maintained test traverses that actual archive. In `race-qa`, keep all scripts, storage-state inputs, timelines, mutation/request logs, text snapshots, and non-identical screenshots. They capture actual slow-3G, multi-context, and real-database behavior (including unfinished or anomalous save/undo/pitcher-transition sequences) that fake/PGlite tests do not reproduce. Recently modified scorebook, betting, auth, and editor code makes those artifacts evidence, not an obsolete fixture set.

**Superseded but excluded from the execution batch:** the 18 ignored `after-{1366,1920}*`, `after-draft-{1366,1920}*`, and `after-warning-{1366,1920}*` files in `tmp/tracker-preview-cleanup/` (3,982,151 bytes) are intermediate captures of the same PA, viewport, and application states retained as `after-final-*` and `after-final-warning-*`; inspection found only implementation-stage layout changes. They have no Git object and current code cannot reproduce their exact pixels, so do not remove them unless that known irrecoverability is explicitly accepted. The ignored zero-byte `build-final.log` is also unused, but deleting it saves nothing. Cropped console headers/diagrams are derivable in principle, but retaining them avoids a new crop manifest for only 282,247 bytes. No archive hierarchy or new fixture framework is warranted.

### Recommended single execution batch (future authorization only)

Remove exactly **40 files / 11,836,953 bytes (11.29 MiB)**: 35 tracked screenshot aliases proven identical by full SHA-256, plus five ignored pitch streams proven byte-identical to retained canonical data. The timing/request JSON remains, and this mapping preserves every removed screenshot's scenario provenance. No references require updates.

| Retain exact replacement | Remove exact-byte aliases (all `tmp/race-qa/artifacts/`, tracked and unchanged) |
|---|---|
| `bet-resolve-2211.png` | `bet-resolve-3219.png` |
| `bet-resolve-4186.png` | `bet-resolve-5773.png` |
| `roster-race-admin-0.png` | `roster-race-admin-60.png`; `roster-race-admin-150.png`; `roster-race-admin-299.png` |
| `roster-persisted-tournament.png` | `roster-race-tournament-20.png`; `roster-race-tournament-60.png`; `roster-race-tournament-150.png`; `roster-race-tournament-299.png` |
| `roster-persisted-season.png` | `roster-race-season-20.png`; `roster-race-season-60.png`; `roster-race-season-150.png`; `roster-race-season-299.png` |
| `half-transition-spectator-65.png` | `half-transition-spectator-110.png`; `half-transition-spectator-175.png` |
| `close-mid-save-spectator-241.png` | `pitcher-sub-save-spectator-2229.png`; `pitcher-sub-save-spectator-2610.png` |
| `roster-race-scorebook-0.png` | `roster-race-scorebook-20.png`; `roster-race-scorebook-60.png`; `roster-race-scorebook-150.png`; `roster-race-scorebook-299.png` |
| `half-transition-spectator-15.png` | `half-transition-spectator-35.png` |
| `close-mid-save-spectator-1083.png` | `close-mid-save-spectator-1433.png` |
| `pitcher-sub-save-spectator-424.png` | `pitcher-sub-spectator-1189.png` |
| `half-transition-spectator-before.png` | `half-transition-spectator-0.png` |
| `half-transition-editor-65.png` | `half-transition-editor-110.png`; `half-transition-editor-175.png` |
| `draft-stale-aidan-3655.png` | `draft-stale-aidan-3873.png`; `draft-stale-aidan-4136.png` |
| `dashboard-jason.png` | `map-_schedule.png`; `map-_tournaments.png` |
| `draft-stale-jason-1606.png` | `draft-stale-jason-3655.png` |
| `draft-stale-aidan-519.png` | `draft-stale-aidan-1206.png` |
| `draft-race-aidan-62.png` | `draft-stale-aidan-174.png` |
| `half-transition-editor-0.png` | `half-transition-editor-15.png` |

The five additional candidates below are ignored; each retained file is tracked and unchanged at `c170fadca49ca6ef3676c72d4fa092c7e59283f9`.

| Remove ignored candidate | Bytes | Retained byte-identical replacement |
|---|---:|---|
| `tmp/tracker-reliability-20260905/bowser_castle-20260905T005948Z.pitches.jsonl` | 50,638 | `data/player_tracking/bowser_castle-20260905T005948Z.pitches.jsonl` |
| `tmp/tracker-reliability-20260905/bowser_jr_playroom-20260828T155225Z.pitches.jsonl` | 64,598 | `data/player_tracking/bowser_jr_playroom-20260828T155225Z.pitches.jsonl` |
| `tmp/tracker-reliability-20260905/dk_jungle-20260904T161731Z.pitches.jsonl` | 54,360 | `data/player_tracking/dk_jungle-20260904T161731Z.pitches.jsonl` |
| `tmp/tracker-reliability-20260905/mario_stadium-20260904T000419Z.pitches.jsonl` | 46,849 | `data/player_tracking/mario_stadium-20260904T000419Z.pitches.jsonl` |
| `tmp/tracker-reliability-20260905/yoshi_park-20260831T140742Z.pitches.jsonl` | 51,822 | `data/player_tracking/yoshi_park-20260831T140742Z.pitches.jsonl` |

**Recovery and validation (proposal-time):** all 214 `race-qa` working files currently hash to their known `HEAD` blobs (latest introducing commit `02ade50cd391980a189e5c398921a3489d4b9b21`), so any removed screenshot can be restored byte-for-byte with `git restore --source=c170fadca49ca6ef3676c72d4fa092c7e59283f9 -- <exact-path>`. A working-tree `Copy-Item` was initially proposed for an ignored pitch copy, subject to an equality recheck. The execution audit below supersedes that pitch-stream proposal: copying a future canonical working file is not a fixed Git-object recovery guarantee, and the five candidates were retained after their raw commit blobs failed exact-byte verification. Before and after execution, re-run full SHA-256 on every mapped pair, confirm the 40 paths and 11,836,953-byte total, repeat the ignored/untracked reference search, and inspect `git diff -- tmp/race-qa`. No application test is relevant because this batch changes no executable input; do not run the historical live-data scripts. This is stronger than deleting merely old or visually similar material and is the recommended small batch for supervising review.

### Execution result — 2026-09-15

This section records the completed action and supersedes the “future authorization only” wording for this batch. The authorized batch was re-enumerated without wildcards as exactly 35 tracked screenshot aliases plus five ignored pitch streams, still totaling **40 files / 11,836,953 bytes**. Every candidate matched its working-tree replacement by complete SHA-256 and size. Consumer tracing included exact names, ignored and untracked text, the retained result files, and dynamic filename construction. No retained result refers to a screenshot alias. The race scripts construct these names only as screenshot outputs; they do not read them. `scan-archive-integrity.mjs` reads `data/player_tracking`, while `replay-recorded-log.mjs` derives `.pitches.jsonl` from a caller-supplied capture stem. Neither requires the ignored tmp copies.

The 35 PNG candidates were tracked-clean before removal, matched the raw blob at exact recovery commit `c170fadca49ca6ef3676c72d4fa092c7e59283f9`, and passed workspace-boundary and no-reparse-point checks. They were removed with individual literal PowerShell paths. **Actual removal: 35 files / 11,568,686 bytes (11.03 MiB).** The five pitch candidates were **retained** (268,267 bytes): although each matches its canonical working file, `core.autocrlf=true` means the fixed-commit blobs contain LF while the candidates contain CRLF. The raw CRLF blob IDs are not present in the object database, so these five fail the explicit requirement that a fixed commit contain the candidate’s exact bytes. No backup tree was created and no weaker recovery claim was substituted.

| Removed screenshot candidate | Retained replacement | Bytes | Complete SHA-256 (both files and recovery blob) |
|---|---|---:|---|
| `tmp/race-qa/artifacts/bet-resolve-3219.png` | `tmp/race-qa/artifacts/bet-resolve-2211.png` | 1,376,290 | `0e281b53336648432a021ca5b670a9d8990cfb0b36b84fc656506c3471ebd116` |
| `tmp/race-qa/artifacts/bet-resolve-5773.png` | `tmp/race-qa/artifacts/bet-resolve-4186.png` | 1,373,535 | `65d982f5d94ee45bd6b465f5e7714e69cbc378bcc97ccce187de842ba4a53c3d` |
| `tmp/race-qa/artifacts/roster-race-admin-60.png` | `tmp/race-qa/artifacts/roster-race-admin-0.png` | 559,538 | `0d501711a0d9055ef2894d495a67daefbbec021229cd93280820c8bd1b36e9bb` |
| `tmp/race-qa/artifacts/roster-race-admin-150.png` | `tmp/race-qa/artifacts/roster-race-admin-0.png` | 559,538 | `0d501711a0d9055ef2894d495a67daefbbec021229cd93280820c8bd1b36e9bb` |
| `tmp/race-qa/artifacts/roster-race-admin-299.png` | `tmp/race-qa/artifacts/roster-race-admin-0.png` | 559,538 | `0d501711a0d9055ef2894d495a67daefbbec021229cd93280820c8bd1b36e9bb` |
| `tmp/race-qa/artifacts/roster-race-tournament-20.png` | `tmp/race-qa/artifacts/roster-persisted-tournament.png` | 337,549 | `7349b7a63da562c65fcda6aae0c8fc370b2b78092fbf2e8aca58404a712f8b7d` |
| `tmp/race-qa/artifacts/roster-race-tournament-60.png` | `tmp/race-qa/artifacts/roster-persisted-tournament.png` | 337,549 | `7349b7a63da562c65fcda6aae0c8fc370b2b78092fbf2e8aca58404a712f8b7d` |
| `tmp/race-qa/artifacts/roster-race-tournament-150.png` | `tmp/race-qa/artifacts/roster-persisted-tournament.png` | 337,549 | `7349b7a63da562c65fcda6aae0c8fc370b2b78092fbf2e8aca58404a712f8b7d` |
| `tmp/race-qa/artifacts/roster-race-tournament-299.png` | `tmp/race-qa/artifacts/roster-persisted-tournament.png` | 337,549 | `7349b7a63da562c65fcda6aae0c8fc370b2b78092fbf2e8aca58404a712f8b7d` |
| `tmp/race-qa/artifacts/roster-race-season-20.png` | `tmp/race-qa/artifacts/roster-persisted-season.png` | 305,050 | `5440ea46d34fb384c0e053f6774c220b4578c7a4c831c97e7d36493c11ef64d0` |
| `tmp/race-qa/artifacts/roster-race-season-60.png` | `tmp/race-qa/artifacts/roster-persisted-season.png` | 305,050 | `5440ea46d34fb384c0e053f6774c220b4578c7a4c831c97e7d36493c11ef64d0` |
| `tmp/race-qa/artifacts/roster-race-season-150.png` | `tmp/race-qa/artifacts/roster-persisted-season.png` | 305,050 | `5440ea46d34fb384c0e053f6774c220b4578c7a4c831c97e7d36493c11ef64d0` |
| `tmp/race-qa/artifacts/roster-race-season-299.png` | `tmp/race-qa/artifacts/roster-persisted-season.png` | 305,050 | `5440ea46d34fb384c0e053f6774c220b4578c7a4c831c97e7d36493c11ef64d0` |
| `tmp/race-qa/artifacts/half-transition-spectator-110.png` | `tmp/race-qa/artifacts/half-transition-spectator-65.png` | 327,472 | `75cf505421a9c37395bdb4354d78262a50e41b2824789f204927461765e613bd` |
| `tmp/race-qa/artifacts/half-transition-spectator-175.png` | `tmp/race-qa/artifacts/half-transition-spectator-65.png` | 327,472 | `75cf505421a9c37395bdb4354d78262a50e41b2824789f204927461765e613bd` |
| `tmp/race-qa/artifacts/pitcher-sub-save-spectator-2229.png` | `tmp/race-qa/artifacts/close-mid-save-spectator-241.png` | 324,095 | `4f060362c4752933e7255254c4a5980cf0585f74a3256740df38fa39854021ae` |
| `tmp/race-qa/artifacts/pitcher-sub-save-spectator-2610.png` | `tmp/race-qa/artifacts/close-mid-save-spectator-241.png` | 324,095 | `4f060362c4752933e7255254c4a5980cf0585f74a3256740df38fa39854021ae` |
| `tmp/race-qa/artifacts/roster-race-scorebook-20.png` | `tmp/race-qa/artifacts/roster-race-scorebook-0.png` | 146,486 | `351423f41851eb0960dd957fb5d068f4cc60d44ab0d28b0ad712f7b671931326` |
| `tmp/race-qa/artifacts/roster-race-scorebook-60.png` | `tmp/race-qa/artifacts/roster-race-scorebook-0.png` | 146,486 | `351423f41851eb0960dd957fb5d068f4cc60d44ab0d28b0ad712f7b671931326` |
| `tmp/race-qa/artifacts/roster-race-scorebook-150.png` | `tmp/race-qa/artifacts/roster-race-scorebook-0.png` | 146,486 | `351423f41851eb0960dd957fb5d068f4cc60d44ab0d28b0ad712f7b671931326` |
| `tmp/race-qa/artifacts/roster-race-scorebook-299.png` | `tmp/race-qa/artifacts/roster-race-scorebook-0.png` | 146,486 | `351423f41851eb0960dd957fb5d068f4cc60d44ab0d28b0ad712f7b671931326` |
| `tmp/race-qa/artifacts/half-transition-spectator-35.png` | `tmp/race-qa/artifacts/half-transition-spectator-15.png` | 331,223 | `a7b51436a61e665de8da2b5f10238ed5a037fe95b1a727a9ea76cf0265b4759e` |
| `tmp/race-qa/artifacts/close-mid-save-spectator-1433.png` | `tmp/race-qa/artifacts/close-mid-save-spectator-1083.png` | 324,684 | `9dd9547355477048f39c78fc44e802236ea15bea916c5168cecf2e9523c99ac9` |
| `tmp/race-qa/artifacts/pitcher-sub-spectator-1189.png` | `tmp/race-qa/artifacts/pitcher-sub-save-spectator-424.png` | 324,255 | `d46df4e67d18b7b3be752d8c33c1ffcf74766dd33c096f8a773ab816665d1c76` |
| `tmp/race-qa/artifacts/half-transition-spectator-0.png` | `tmp/race-qa/artifacts/half-transition-spectator-before.png` | 323,189 | `468ae22aa6984232ed7e7c19d58aa520a349e69ac2154c29811105f95241cd8c` |
| `tmp/race-qa/artifacts/half-transition-editor-110.png` | `tmp/race-qa/artifacts/half-transition-editor-65.png` | 146,670 | `846b100cb1be8a4014ad435e22b873365305efcb3c8bb5a8ed34cc50e222a68d` |
| `tmp/race-qa/artifacts/half-transition-editor-175.png` | `tmp/race-qa/artifacts/half-transition-editor-65.png` | 146,670 | `846b100cb1be8a4014ad435e22b873365305efcb3c8bb5a8ed34cc50e222a68d` |
| `tmp/race-qa/artifacts/draft-stale-aidan-3873.png` | `tmp/race-qa/artifacts/draft-stale-aidan-3655.png` | 145,913 | `d8039ce83442fb040b4d6b1164b1636e207153a7593f36e814e184f1702212d0` |
| `tmp/race-qa/artifacts/draft-stale-aidan-4136.png` | `tmp/race-qa/artifacts/draft-stale-aidan-3655.png` | 145,913 | `d8039ce83442fb040b4d6b1164b1636e207153a7593f36e814e184f1702212d0` |
| `tmp/race-qa/artifacts/map-_schedule.png` | `tmp/race-qa/artifacts/dashboard-jason.png` | 112,927 | `1cc38fdea351d1da8fb6b3a1c693c15b9a30a89d13f90bd1e5e88c963e95fb00` |
| `tmp/race-qa/artifacts/map-_tournaments.png` | `tmp/race-qa/artifacts/dashboard-jason.png` | 112,927 | `1cc38fdea351d1da8fb6b3a1c693c15b9a30a89d13f90bd1e5e88c963e95fb00` |
| `tmp/race-qa/artifacts/draft-stale-jason-3655.png` | `tmp/race-qa/artifacts/draft-stale-jason-1606.png` | 166,197 | `d87447afa6f19514a543ad8b083fd371644d00bde23157984306bd400470ed12` |
| `tmp/race-qa/artifacts/draft-stale-aidan-1206.png` | `tmp/race-qa/artifacts/draft-stale-aidan-519.png` | 152,375 | `b295a41c9314d87cc204b948260eeb024ce0a2d3009608be756ddf822777471b` |
| `tmp/race-qa/artifacts/draft-stale-aidan-174.png` | `tmp/race-qa/artifacts/draft-race-aidan-62.png` | 151,613 | `21aa0a28912efa0bba68f9d57b625a150dc96a57e11ae5ed465c8d24feb4f8c5` |
| `tmp/race-qa/artifacts/half-transition-editor-15.png` | `tmp/race-qa/artifacts/half-transition-editor-0.png` | 96,217 | `640948b5d850a4168f3b355465e3c2032b3379e668438aeefc833db83067dec0` |

The five retained exceptions preserve their original-to-canonical mappings below. “Commit blob” means the raw bytes stored at commit `c170fadca49ca6ef3676c72d4fa092c7e59283f9` and the listed canonical source path; it intentionally differs from the CRLF candidate and therefore is not a compliant byte-preserving recovery source.

| Retained ignored candidate | Canonical working path / fixed-commit source path | Candidate bytes | Candidate and working-canonical SHA-256 | Commit-blob bytes | Commit-blob SHA-256 |
|---|---|---:|---|---:|---|
| `tmp/tracker-reliability-20260905/bowser_castle-20260905T005948Z.pitches.jsonl` | `data/player_tracking/bowser_castle-20260905T005948Z.pitches.jsonl` | 50,638 | `d49f8b3989e9120a120e5af7389fa7479e7b87175aa8dca6605e045af42a398b` | 50,527 | `fbcb3dcea14e19f2a9596d847729296064db42b7eb427d69002131697d570ef5` |
| `tmp/tracker-reliability-20260905/bowser_jr_playroom-20260828T155225Z.pitches.jsonl` | `data/player_tracking/bowser_jr_playroom-20260828T155225Z.pitches.jsonl` | 64,598 | `208a9b3a89a844564fa9516541d850f03231a05e3c594d0e7b1df0742111bcc4` | 64,456 | `48567fce716b1e9076a57e854e64c0eeb76e21e4c66dfd99f48f16c6ebc8bf6d` |
| `tmp/tracker-reliability-20260905/dk_jungle-20260904T161731Z.pitches.jsonl` | `data/player_tracking/dk_jungle-20260904T161731Z.pitches.jsonl` | 54,360 | `5faad62445f7839959e749ee92f2fee8b98e5c6ecd3bd6d4b44cd5c8d4febda2` | 54,241 | `ee2f4786069e542504974861bc09d14a89502e4041459264e918b139b7c90505` |
| `tmp/tracker-reliability-20260905/mario_stadium-20260904T000419Z.pitches.jsonl` | `data/player_tracking/mario_stadium-20260904T000419Z.pitches.jsonl` | 46,849 | `905165c08173bcf6dd91432740a694e8fb15865ec039fe9e3db4649c3e8bdcd5` | 46,747 | `e2874c6a55f82000050dc777c2f27a09892ebc3972e55bcabb5bc01cf4f88a66` |
| `tmp/tracker-reliability-20260905/yoshi_park-20260831T140742Z.pitches.jsonl` | `data/player_tracking/yoshi_park-20260831T140742Z.pitches.jsonl` | 51,822 | `bcc85f2447d6d145a4dc2cc72ddcddada1bf48a57387c9126a01a870ab53dc00` | 51,707 | `89e8a7897dc2a12d6182ae9f26c2dc31c3328c25f9f40105ea8107a86ae22541` |

Byte-preserving screenshot recovery uses the fixed commit, never the future replacement file, and refuses to overwrite an existing destination. Supply a path and its expected hash from the removed-screenshot table:

```powershell
$recoveryCommit = 'c170fadca49ca6ef3676c72d4fa092c7e59283f9'
$destination = 'tmp/race-qa/artifacts/<exact-removed-name>.png'
$expectedSha256 = '<complete-sha256-from-table>'
if (Test-Path -LiteralPath $destination) { throw "Refusing to overwrite: $destination" }
git restore --source=$recoveryCommit --worktree -- $destination
if ($LASTEXITCODE -ne 0) { throw "Git recovery failed: $destination" }
$actualSha256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualSha256 -ne $expectedSha256) { throw "Recovered hash mismatch: $destination" }
```

Post-removal verification found exactly the 35 approved deletion statuses under `tmp/race-qa`, no other changed path there, and no staged/index change. All retained replacements were rehashed against their pre-removal SHA-256 values. The commit blobs were rehashed directly in memory against the recorded screenshot hashes, without restoring over project files. The protected status inventory remains 91 modified tracked files, five earlier executable deletions, and 186 untracked entries; the earlier executable cleanup and all other work were preserved. A repeated exact-name/reference search outside this report found no broken consumer. Dynamic race-script references remain output generation, and all scripts, unique screenshots, annotations, timing/request logs, and other evidence remain present. No application or historical script was run because inspection found no executable dependency.
