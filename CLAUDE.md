# Working in this repo

## Diagnose before building

Read the relevant files and state the cause before proposing a fix. Most bugs
here are two files away from an answer; a hypothesis generated without reading
them is a guess with confident formatting.

Never say a problem is unfixable, and never blame the browser, the emulator, or
"caching" without evidence that names the mechanism. Those are unfalsifiable and
they end the investigation instead of advancing it.

## Jason's observations outrank my theory

He is watching the actual behaviour; I am reading files. If he says something is
not the cause, it is not the cause — drop the theory and look somewhere else. If
he tells me the same thing twice, I already got it wrong once.

## Smallest fix first

Fix the thing that is broken. Do not add a module, a test harness, a benchmark,
a replay tool or a design doc unless asked for one. If a fix seems to need new
scaffolding, say so and ask before building it.

## Make it work end to end, not in pieces

The failure mode in this repo is parts that are each correct and do not work
together. Before recommending a command, run that exact command. If a change has
to work in two places — the bridge and the preview, season and tournament,
Roster and SeasonRoster — wire both in the same pass or ask which one is
actually used.

## Keep it short

No preamble, no restating the request, no summary of what I am about to do. Lead
with the answer or the command. Long explanations are for when the reasoning is
the deliverable.

## Verifying

`npm run test:tracker`, `npm run test:defense`, `npm run build`, and
`python scripts/verify_player_metrics.py` are the checks. Run the ones a change
could plausibly break; do not run all four out of habit.

For anything that writes to Supabase, add `npm run test:persistence` and, for a
change to a migration or to what the database itself enforces,
`npm run test:database` -- that one applies the real migration files to a real
PostgreSQL in process (PGlite) rather than to the in-memory fake. The whole
pipeline end to end is `npm run test:acceptance`.

`node scripts/verify_speed_against_attributes.mjs` is the fifth, and it is the
one to run after touching the derivation: it checks measured speed and arm
against the run_speed and throwing_speed the characters table already holds.
Split-half agreement cannot catch a metric that measures the wrong thing
consistently, and that is exactly how fielder sprint speed came to correlate
with the game's own attribute at -0.66.

Browser testing: log in as Jason / Mossss.

## Tracker commands

| | Tracker log | 60 Hz capture | Supabase |
|---|---|---|---|
| `TRACKER_PARK=<park> npm run tracker:preview` | yes | yes | **never** |
| `TRACKER_GAME_ID=<id> npm run tracker:bridge` | yes | yes | yes |
| `npm run tracker:replay -- --session <stem>` | reconstructed | from disk | **never** |

Test games use `tracker:preview`. Loading a session into Supabase is a separate
deliberate step (`scripts/ingest_player_tracking.mjs`), never automatic.

See `docs/tracker-validation-console.md` for the data flow and what is still
unknown.
