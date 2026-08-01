-- Run this in the Supabase SQL editor (bypasses RLS, unlike the anon-key
-- Node script). Mirrors the same reconstruction logic as
-- scripts/backfill_season_roster_draft_picks.mjs and src/utils/draftOrder.js's
-- normalizeSeasonDraftPicks: within each season, draft rows are ordered by
-- created_at to recover pick order, then round/pick_in_round are derived via
-- snake draft math using that season's team count. Only touches rows where
-- acquired_via = 'draft' and round is still null, so it's safe to re-run.
with team_counts as (
  select season_id, count(*) as team_count
  from season_teams
  group by season_id
),
ordered as (
  select
    id,
    season_id,
    row_number() over (partition by season_id order by created_at) as pick_number
  from season_roster
  where acquired_via = 'draft' and round is null
)
update season_roster sr
set
  pick_number = o.pick_number,
  round = ceil(o.pick_number::numeric / tc.team_count),
  pick_in_round = ((o.pick_number - 1) % tc.team_count) + 1
from ordered o
join team_counts tc on tc.season_id = o.season_id
where sr.id = o.id;
