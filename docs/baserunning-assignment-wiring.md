# Baserunning assignment wiring

Manual scorebook entry, the at-bat editor, and the live tracker now save runner
identities, starting bases, and destinations in `runner_assignments`. Walks,
strikeouts, and home runs include every participant. Manual out assignments also
retain the attempted base when it was selected before marking the runner out.

The tracker matches collector characters using canonical names or explicitly
identified tracker IDs, keeping database IDs separate from game IDs. A fully
joined play or the next base snapshot can fill a previously unresolved assignment.
Those delayed writes only update null assignments, preserving saved corrections.
Incomplete or ambiguous measurements remain unresolved.

Saved assignments refresh `runner_opportunities` for both season and tournament
games. Edits replace changed opportunities; undo, deletion, and redo remove or
restore the corresponding rows. An unchanged refresh preserves fitted values;
changed outcomes clear their old model values. Failed writes and missing out
context preserve existing evidence rather than deleting it.

Extra-base opportunities require complete assignments and an identified runner.
Third-out holds and runners doubled off on catches are excluded. A retired runner
counts as a failed extra-base attempt only when the attempted target is known.
Unmodeled opportunities show no baserunning run value until model recomputation.

This change collects inputs for player and character baserunning value; it does
not implement full WAR or invent movements for historical games. No database
backfill was run as part of this change. Restart a running tracker bridge to load
the updated code.

Validation: 396 tracker tests, 64 scorebook tests, 31 defense tests, and the Vite
production build pass. Coverage includes identity mismatches, stale runner slots,
truncated measurements, third outs, out targets, assignment round trips, scoped
opportunity updates, model invalidation, and failed writes. Database persistence
is exercised with a test double; a connected game remains the live acceptance
check.
