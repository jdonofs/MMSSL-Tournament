-- A runner can be put out on the basepaths during a play whose batter result
-- isn't itself an out (e.g. a 1B where a preceding runner is thrown out
-- stretching for an extra base) — calculateOutsForPa(result) alone can't see
-- that, since 1B/2B/3B/ROE always resolve to 0 outs regardless of what
-- happened to other runners. This column carries the actual out count for
-- the play (set from the runner-assignment count of destination==='out'
-- entries), so half-inning/pitching-outs math can prefer it over the
-- result-based guess. Null means "derive from result" (every pre-existing
-- row, and any path that doesn't populate it explicitly).
alter table plate_appearances
  add column if not exists outs_on_play smallint;
