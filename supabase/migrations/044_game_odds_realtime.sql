-- game_odds/season_game_odds were never added to the supabase_realtime
-- publication, so BettingTab's realtime subscription on these tables never
-- fired: odds/prop changes (from pitcher swaps, lineup edits, PAs, etc.)
-- only appeared after a manual page refresh. Add them idempotently (ALTER
-- PUBLICATION ... ADD TABLE errors if the table is already a member).

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'game_odds'
  ) then
    alter publication supabase_realtime add table public.game_odds;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'season_game_odds'
  ) then
    alter publication supabase_realtime add table public.season_game_odds;
  end if;
end $$;

alter table public.game_odds replica identity full;
alter table public.season_game_odds replica identity full;
