# Tracker persistence guarantees

The automatic bridge writes a local, atomic JSON journal before Supabase, and
reconciles every stage by a durable key:

- PA: `(game_id, tracker_event_key)` — the bridge's own event key, written into
  the row. `contact:<seq>` when the bat met the ball, otherwise
  `tracker-pa:<batter>:<n>`, otherwise `preview-pa:...`. This is the identity a
  plate appearance with **no contact** has, and the only one: a strikeout, a
  walk and a hit batter have no `tracker_contact_seq`.
- PA (legacy): `(game_id, tracker_contact_seq)` is still checked, so a session
  recorded before event keys existed is not duplicated by a replay.
- Pitch: `(pa_id, pitch_number_pa)`. `pitch_number_game` is a display ordinal
  counted across the whole game and is deliberately **not** part of the
  comparison: a replay into a database that already holds the pitch computes a
  higher one for the same pitch.
- Run: `(pa_id, scoring_player_id, scoring_character_id)`.

A timeout is treated as ambiguous, not as a failed write. The bridge reads the
authoritative row back before retrying. It publishes the live-state snapshot
for a tracker line only after that line's serialized required scoring work has
finished. Game completion and signal shutdown drain the PA queue, live-state
queue, capture finalization, and postgame ingestion before exiting.

Required bridge facts are the PA, every reported pitch, every reported run, and
all player/character identities needed by those rows. Missing identities or an
unreconciled write blocks later live publication and game completion. Advanced
opportunities, betting resolution, and pitching-stat recomputation are derived
work: failures are reported after the scoring facts remain durable and can be
recomputed.

Postgame ingestion validates the complete capture before its first mutation. It
never deletes an existing tracking play tree. Each raw fact is reconciled by
session/play/actor sequence, and status progresses through `ingesting`,
`raw_ingested`, then `ingested`. A model failure leaves `raw_ingested` facts in
place. Re-running resumes missing facts; an already complete identical session
is a no-op.

## What the database now enforces

Six migrations move the guarantees below from "the client is careful" to "the
database refuses". **None of them has been applied to production.** They are
tested against a real PostgreSQL — PGlite, the server compiled to WebAssembly —
against the same files that would run against Supabase. `npm run test:database`
runs all of it:

| Suite | What it establishes |
|---|---|
| `tracker-database-guarantees` | the migrations' own constraints and functions |
| `tracker-transactional-reconciliation` | the real JavaScript writer against those functions, on an unmigrated, a partially migrated and a fully migrated schema |
| `tracker-lease-fencing` | the five ownership states, that only one of them writes unleased, and that every protected mutation is refused for a superseded epoch |
| `tracker-session-replacement` | the active pointer and every official link moving together |
| `tracker-correction-workflow` | where an operator's answer goes, and that a half-written attempt is completed rather than blocked |

The client half of the fenced mutations — that the bridge takes that route at
all, and that a refusal from it stops the write rather than falling through to
an ordinary update — is `tests/tracker-fenced-mutations.test.mjs` in
`npm run test:tracker`, which drives the real bridge against a model of the
three functions.

The client suites (`npm run test:persistence`) still run against
`tests/helpers/trackerFakeSupabase.mjs`, which is the right tool for the
client's own logic. The four defects fixed in this pass all lived in the gap
between the two — a passing client suite and a passing database suite with
nothing exercising them together — which is what
`tests/helpers/pgliteSupabase.mjs` now closes.

### `20260908120000_tracker_durable_identities.sql`

`tracker_event_key` on `plate_appearances` and `season_plate_appearances`, plus
unique indexes on every natural key above and on the tracking facts:
`tracking_plays (tracking_session_id, play_ordinal)`,
`fielding_opportunities (tracking_play_id, position)`,
`movement_metrics (tracking_play_id, actor_type, actor_slot)`,
`tracking_throws (tracking_play_id, throw_sequence)`.

**A duplicate fails the migration and nothing is changed.** That is deliberate:
a duplicate here is a scoring record, and which of the two is right is a
question for a person with the game in front of them. Run
`node scripts/audit_tracker_duplicates.mjs` first — it is read-only, it names
every collision and the rows in it, and it deletes and merges nothing.

A table this deployment does not have is skipped rather than failing the
migration, because the tracking tables were created directly against Supabase
and no DDL for them is in this repository.

### `20260908121000_tracker_game_leases.sql`

A row per `(competition_type, game_id)` with an owner, an expiry and a
monotonic `epoch`. `tracker_lease_acquire` grants, renews or (only when asked)
transfers; `tracker_lease_renew` refuses rather than reacquiring, so a bridge
that lost its lease finds out; `tracker_lease_assert` raises from inside the
write functions.

**The epoch is the point.** Expiry alone is not exclusion: a bridge that was
paused past its expiry, had the lease taken, and then woke up would carry on
writing. Every change of hands bumps the epoch, every write carries the epoch
its owner thinks it holds, and a stale one is refused by the database rather
than by the owner's own good behaviour.

**Losing a lease stops writes; it does not switch fencing off.** The first
version of this collapsed two different facts into one boolean: `renew()` set
`held = false`, `writeCredentials()` then produced a null owner, and a null owner
was exactly what `tracker_lease_assert` waved through as "an unleased caller (a
backfill, a repair script)". A bridge that had been told in so many words that
another process owned the game went on writing plate appearances into it.

Ownership is now one of five named states — `held`, `lost`, `expired`,
`released`, `unavailable` — and only `unavailable` (a database with no lease
functions at all) produces a credential without an owner. Every other non-held
state **throws** at the write, including a lease that has silently run out under
a bridge whose renewal timer never fired. `tracker_lease_assert` now requires a
null owner to name why it has no lease (`p_unleased_intent`), which a repair
route states deliberately — `unleasedTrackerCredentials(reason)`, and
`--unleased-reason` on `scripts/ingest_player_tracking.mjs` — and which a losing
tracker has no way to produce.

`tracker_lease_assert` also takes the lease row `FOR UPDATE`, so an ownership
change cannot commit between the check and the write it is protecting: a
concurrent `tracker_lease_acquire` blocks until the writing transaction ends,
and every write after it carries an epoch the database refuses.

**Every protected mutation asserts the lease inside the transaction that
writes.** This used to read "all four assert the lease in-process first", and
that was a weaker claim than it sounded. `assertWritable()` reads cached state:
after a takeover a losing bridge goes on reading `held` until its next renewal,
so the guard passed and the ordinary update that followed it landed in a game
another machine owned. Even with a perfectly current view, a check and a
separate request are two moments.

`20260909120000_tracker_fenced_game_mutations.sql` gives each of them a
function of its own — see below. The in-process check stays in front of them as
the cheap, early, named refusal it always was; what it no longer does is
decide.

The bridge takes the lease before it writes anything and releases it on a clean
stop. `TRACKER_LEASE_TAKEOVER=1` is a deliberate transfer and is never the
default. On a database without these functions the bridge says out loud that
cross-machine exclusion is **not** in force and carries on with the local lock,
which is all it could ever do alone.

### `20260908122000_tracker_persist_plate_appearance.sql`

One function, therefore one transaction, for the plate appearance and its
pitches and runs. Idempotent by the same keys the client uses, so journal
replay, an ambiguous timeout and a re-run all converge. It asserts the lease
first, so a stale owner is refused before any row is touched.

This closes the gap the previous version of this document described: between
the PA insert and the runs insert, the database used to hold a plate appearance
whose runs did not exist, and anything reading the game in that window saw a
scoring record short of runs. A child that cannot be written now rolls the
plate appearance back with it.

**Reconciliation is not "reuse whatever is there".** The first version found an
existing row under the event key and inserted the incoming children against it
without looking at either, and both consequences were reproduced: an operator's
corrected strikeout kept its result and silently grew a run from a replayed
home-run payload, and a payload whose facts contradicted the row already under
that key was accepted while the caller was told the write succeeded. An existing
row is now one of three things and they are told apart:

- an **operator correction** (`correction_source = 'operator'`) is returned
  untouched, children and all, and the response says so;
- **the same facts again** is idempotent, and its children are reconciled;
- **a contradiction** is refused, naming the fields that differ. A field the
  existing row has no value for is a missing fact rather than a contradiction,
  so a session recorded before event keys existed is still backfilled instead of
  being refused.

Pitches and runs are held to the same rule: one already recorded under its
natural key with different data is a conflict, not a no-op. `pitch_number_game`
stays out of that comparison, for the reason it always has.

Game identity is checked on every row of the payload, not only on the call: a
pitch or a run carrying a different `game_id` used to be written into a game the
call had never read or leased.

The bridge uses it when it is there and falls back — genuinely, not only in
words — to the staged journal-reconciled writes when it is not. See
[what the fallback actually does](#what-the-fallback-actually-does).

### `20260908123000_tracking_session_versions.sql`

A tracking session is now `(competition_type, game_id, raw_stem, version)` with
exactly one version `is_active`. A replacement is built as a NEW version
alongside the completed one, its facts are ingested into it, and only then does
one statement move the active pointer. If anything fails first, the previous
version is still active, still complete and untouched — and it is never
deleted, so both trees survive.

`tracker_activate_session_version` refuses to activate a session whose status
is not `ingested`, which is what makes "the previous valid session survives a
failed replacement" true rather than hopeful.

**The pointer was not the only thing that had to move.** A version also gets
pointed AT, by rows the site treats as official:
`plate_appearances.tracking_session_id` and `tracking_contact_frame`, and
`runner_opportunities` / `double_play_opportunities.tracking_play_id` plus the
measured runner position, speed and the throw a runner was retired by. The
ingest used to write all of those as each play was staged — before activation,
while the replacement was unfinished — so a replacement that failed halfway left
official rows pointing into the failed version while the previous version was
still active. Those links now travel with the activation and land in the same
transaction as the pointer move: either the new version is active and everything
official points at it, or nothing moved at all.

A replacement that died is **resumed**, not re-opened: a non-active version of
the same stem carrying the same derivation is the same attempt, so a crash no
longer leaves a version per attempt behind. Re-running the activation after a
lost response returns `already_active` and re-applies the same links, because
they are derived from the candidate's own plays rather than remembered.

Recomputation runs **after** activation, for a replacement and a first ingest
alike, so the model is never fed the old version's facts or two versions of the
same play at once. One order for both paths: raw facts → `ingested` → the
official links and (for a replacement) the pointer, in one fenced transaction →
recomputation.

**The unfinished stage is written down, not inferred.** Ingesting a session is
two halves. The raw half is reconciled by natural key, so a re-run of an
interrupted one converges. The derived half — moving the pointer and recomputing
the advanced metrics — leaves no rows a later run can compare against, and that
was invisible to the retry: a replacement that activated and then failed to
recompute was `ingested`, was active, and had exactly the fact counts the input
expected, so the next run returned `alreadyComplete: true` and recomputed
nothing, permanently.

`tracking_sessions.quality.derived_stage` now records what is still owed
(`activate`, then `recompute`, then cleared) before each step is attempted. A
retry that finds matching fact counts *and* a pending stage resumes that stage
instead of declaring the ingest complete: no play is re-imported, no version is
opened, and the response says `resumedStage`. A lost activation *response* is
resumable for a specific reason — the activation moves the pointer and the
measured runner kinematics in one transaction, so a session that is `is_active`
has already applied them, and what was lost is the answer rather than the work.

Without the migration, `ingest_player_tracking.mjs` keeps its old behaviour:
refuse the replacement, preserve the completed ingest, and say which migration
would allow it.

### `20260909120000_tracker_fenced_game_mutations.sql`

Three functions, each asserting `tracker_lease_assert` as its first statement —
which takes the lease row `FOR UPDATE` and holds it for the rest of the
transaction:

| Function | What it commits together |
| --- | --- |
| `tracker_publish_live_state` | the bridge's live-feed row **and** the game row's own `live_state` |
| `tracker_apply_game_completion` | the running score, and the final score/status/winner |
| `tracker_record_unresolved_play` | the unresolved-play record, under its durable event key |

Each refuses a payload naming a different game than the call, exactly as
`tracker_persist_plate_appearance` does for a plate appearance and its children.
`tracker_record_unresolved_play` keeps the client's rules — an operator's answer
is returned untouched, an open row has its reason and evidence restated — so the
transactional path and the fallback cannot disagree about them.

The running score used to have **no** lease guard at all, not even the
in-process one, so a bridge that had lost the game went on overwriting the score
of the game its new owner was recording. It goes through
`tracker_apply_game_completion` now.

**Postgame ingestion's official links go the same way.** A first ingest used to
write `plate_appearances.tracking_session_id` and the runner/double-play
`tracking_play_id` one unfenced update per play, on the reasoning that a first
ingest has no previous version to protect. It has a *game* to protect: those
rows are shared with whatever else is writing the game. Both a first ingest and
a replacement now stage them and hand them to
`tracker_activate_session_version`, which asserts the lease and applies them in
one transaction; a first ingest's session is already the active one, so the call
comes back `already_active` and does only the link half.

Without this migration the bridge falls back to the ordinary updates, says once
which guarantee is missing and which file would add it, and carries on
recording. A stale-lease refusal is **never** read as a missing function: only
`PGRST202`/`PGRST203`/`42883` degrade, and anything else is thrown.

### Which tracking version anything reads

Superseded versions keep their facts — nothing deletes one — so
`fielding_opportunities`, `movement_metrics` and `tracking_throws` can hold
several versions of the same play at once. Every reader filters to the active
version through `src/utils/activeTrackingVersions.js`: `Stats.jsx`,
`useCharacterExtras.js` and `scripts/recompute_advanced_metrics.mjs`.

**An unknown answer is not an empty one.** That filter used to catch every
failure and return an empty exclusion set, on the reasoning that dropping data
because a query failed is the worse error. That is true of a database with no
versioning migration — there, "nothing is superseded" is the real answer — and
false of everything else: a statement timeout produced the same empty set, so a
superseded version and the active one were counted together and the duplicate
reached a character's fielding line and the models. It now returns
`{ data, error, legacy }`, which is the shape `fetchAllRows` returns, so the
"did any of these reads fail" check every consumer already had covers it:

- `Stats.jsx` throws it into the existing failed-result check, which shows the
  error banner over whatever was already rendered rather than a line built from
  two versions of the same play.
- `useCharacterExtras.js` keeps the numbers it already had.
- `scripts/recompute_advanced_metrics.mjs` **fails**, because it PERSISTS the
  models it builds; the previously computed columns are left exactly as they
  were.

Both reads are paginated (`fetchAllRows`), and the session-id filter is sent in
batches of 100. Un-paginated, PostgREST's silent 1000-row cap left the 1001st
play of a superseded version counted as an official fact.

Legacy-schema detection is narrow on purpose, the same way
`isMissingFunction()` is: only `42703`/`42P01`/`PGRST204`/`PGRST205` mean "this
schema cannot express versions". A timeout whose message happens to name a
column is an operational failure and is reported as one.

### `20260908124000_tracker_unresolved_plays.sql`

See [the correction workflow](#unresolved-plays-and-operator-corrections).

## Unresolved plays and operator corrections

When the bridge cannot determine a result it used to log a line and write
nothing, so the only record that a plate appearance had happened at all was
console text. `tracker_unresolved_plays` is a durable, visible statement that
something happened and is **not** known: the batter, the pitcher, the inning,
the pitches seen, the runners on base, and any run announced that could not be
attributed.

Nothing in it is counted in anyone's statistics, and no outcome is ever
inferred to make a total match. The acceptance recording's one unscored plate
appearance is why `runs_scored` holds 17 rows for an 18-run game; that gap is
now stated rather than merely missing.

**An empty buffer is not an unresolved play.** The parser opens one on every
matchup line, and a half-inning ends with one open for the batter who was
announced and never batted. Recording those would have filled the queue with
eight plays that never existed and hidden the one that did — the ratio in the
acceptance recordings is exactly that. A row is written only when there is
evidence a plate appearance happened: a pitch, a count that moved, contact, a
run, a putout, or the tracker's own per-batter counter naming the trip.

An operator answers one in the At-Bat editor, which writes a real plate
appearance carrying the same `tracker_event_key` and
`correction_source = 'operator'`. The bridge recognises the flag and leaves the
row exactly as it is, so a correction survives a restart and a full replay of
the game's log without being duplicated or overwritten.

**The answer is given in the play's own context, and at its own place in the
game.** The editor used to open the append page and let its normal draft effect
overwrite the selection, so an unresolved Top 5 play with two pitches and a
runner on second opened as Bottom 9, with the ninth-inning batter, the
ninth-inning pitcher, no pitches and empty bases — nothing on the page came from
the play. The correction now opens at the slot the game's own derivation puts it
in (matched on half-inning and on the out count the tracker recorded), carrying
the batter, the pitcher, the pitches and the runners the tracker saw. The result
is still never pre-filled: that is the one thing the operator is there for. If
the recorded at-bats cannot place the play at all, the page says so rather than
showing one half-inning's label over another half-inning's lineup.

The slot matters beyond display. Half-innings here are derived from the running
out count (`src/utils/trackerGameState.js`), so a fifth-inning plate appearance
recorded after the ninth moves every later at-bat's derived inning, half,
runners and outs once it carries an out.

**Saving is one transaction.** It used to be four client writes in a deliberate
order — plate appearance, pitches, runs, then mark resolved — so that a failure
left the gap visible. It did leave the gap visible, and it also left a plate
appearance holding the unresolved play's `tracker_event_key`, which the unique
index then used to refuse every retry: the only path that could close the gap
was blocked by its own first attempt.
`tracker_record_corrected_plate_appearance` inserts at the chronological slot,
renumbers what follows, writes the children and marks the play resolved in one
commit, and **completes** a half-written earlier attempt instead of colliding
with it. It refuses to write over a row the tracker owns.

## What the fallback actually does

The staged journal-reconciled writes are what happens when
`tracker_persist_plate_appearance` is absent. That was advertised and did not
work: the staged path queried `tracker_event_key`, a column that arrives in the
*same batch of migrations* as the function, so on a database with neither, every
plate appearance failed with `42703` on the first at-bat of the game.

The schema is now asked what it has, once, before it is relied on:

| Schema | What happens |
|---|---|
| Fully migrated | The transactional function; one commit per plate appearance. |
| Identities but no function | The staged writes, keyed on `tracker_event_key` exactly as the function would be. A replay reconciles. |
| Neither | The staged writes keyed on `tracker_contact_seq`. A contact at-bat still reconciles from the database alone; a **non-contact** one (a strikeout, a walk, a hit batter) has no database-visible identity on that schema and is reconciled through the local journal only. Both degradations are printed. |
| No `tracker_contact_seq` | Refused at bridge startup, before a pitch is thrown, rather than discovered on the first at-bat. |

The three fenced game mutations degrade the same way and on the same terms: a
database without `20260909120000_tracker_fenced_game_mutations.sql` gets the
ordinary updates the bridge used before, guarded only by its own cached lease
check — which is a real guarantee for a single machine and none at all across
two. It is said once per missing function, names the migration, and the log line to
grep for is `Cross-machine exclusion on THOSE writes is NOT in force`. Postgame
ingestion's official links fall back the same way when
`tracker_activate_session_version` is absent, one update per play as before.

Only a genuinely missing capability is eligible for a degraded path: a bare
`/does not exist/` match used to classify a missing column or table as a missing
function and quietly write half a game around it. A code that names a different
fault is now a real failure and is thrown. That cuts both ways here — a
**stale-lease refusal** from a fenced mutation is a refusal, not a missing
function, and is never retried through the unfenced path.

## What is still not guaranteed

- **Nothing here has run against production.** See
  `docs/tracker-real-game-validation.md` for the order: audit for duplicates,
  then apply, then confirm.
- **Two machines have never actually raced.** The lease is exercised with two
  clients against a real database inside one process, and PGlite is a single
  backend, so "two machines" is modelled as two clients taking turns and "in
  flight" means a payload built before a takeover and sent after it. What is
  established is that `tracker_lease_assert` takes the lease row `FOR UPDATE`
  (read back out of `pg_locks` inside the still-open transaction), that a
  superseded epoch is refused whenever it arrives, and that a takeover *before*
  the loser's next renewal — when its own view still reads `held` — refuses
  every protected mutation and leaves the score, the live state, the live-stats
  row and the unresolved-play table unchanged. Two genuinely concurrent
  connections serialising on that lock is still an observation nobody has made.
- **The fenced game mutations have not run against production.**
  `20260909120000_tracker_fenced_game_mutations.sql` is applied to PGlite over
  the reconstructed baseline. Until it is applied for real, the bridge takes the
  documented fallback and says so once per run.
- **The test schema is a reconstruction.** `tests/fixtures/tracker-database-baseline.sql`
  carries the columns the tracker writes, rebuilt from the code, because no DDL
  for the season and tracking tables exists in this repository. What the tests
  establish is the behaviour of the migrations' own constraints and functions,
  which depend only on those columns. A column being absent there says nothing
  about production.
