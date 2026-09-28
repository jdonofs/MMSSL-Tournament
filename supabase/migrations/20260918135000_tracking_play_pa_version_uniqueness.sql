-- A replacement tracking session must stage its plays beside the active live
-- version before tracker_activate_session_replacement moves official PA links.
-- The legacy game-wide unique index on pa_id prevents that safe staging.
-- Keep one play per PA within each version instead.
drop index if exists public.tracking_plays_pa_unique_idx;

create unique index if not exists tracking_plays_session_pa_unique_idx
  on public.tracking_plays (tracking_session_id, pa_id)
  where pa_id is not null;

create index if not exists tracking_plays_game_pa_idx
  on public.tracking_plays (competition_type, game_id, pa_id)
  where pa_id is not null;
