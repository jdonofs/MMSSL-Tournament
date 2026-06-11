-- Realtime DELETE events only include the full old row (needed for the
-- `tournament_id=eq.X` / `season_id=eq.X` filters used by the draft page) when
-- the table's replica identity is FULL. Without this, other clients never see
-- a commissioner's "Undo" pick removal until they refresh the page.

alter table public.draft_picks replica identity full;
alter table public.season_roster replica identity full;
