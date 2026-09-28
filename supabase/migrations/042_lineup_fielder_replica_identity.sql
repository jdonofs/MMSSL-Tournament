-- Realtime DELETE events only include the full old row (needed for the
-- `game_id=eq.X` filters the Scorebook subscribes with) when the table's
-- replica identity is FULL. Without this, when a scorekeeper saves the
-- Lineups tab (which deletes/replaces game_fielders rows, and the auto-seed
-- also deletes/replaces lineups rows), other connected clients never receive
-- the DELETE event and keep showing the stale lineup/fielding rows.
-- Same fix as 033_draft_picks_replica_identity.sql, applied to the
-- lineup/fielding-position tables.

do $$
declare
  table_name text;
  affected_tables text[] := array[
    'lineups',
    'game_fielders',
    'season_lineups',
    'season_game_fielders'
  ];
begin
  foreach table_name in array affected_tables loop
    if exists (select 1 from pg_tables where schemaname = 'public' and tablename = table_name) then
      execute format('alter table public.%I replica identity full', table_name);

      -- Make sure realtime is actually broadcasting changes for this table —
      -- without this, no postgres_changes events fire at all on this DB.
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = table_name
      ) then
        execute format('alter publication supabase_realtime add table public.%I', table_name);
      end if;
    end if;
  end loop;
end $$;
