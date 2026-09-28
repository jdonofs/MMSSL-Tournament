-- Lets a scorekeeper swap which team bats first (top of inning 1) before the
-- first plate appearance is recorded. Stored on the game row so it's shared
-- across every scorekeeper's device and feeds directly into batting-order
-- derivation (see deriveOffense in Scorebook.jsx) rather than being a
-- per-device display-only toggle.

do $$
declare
  table_name text;
  affected_tables text[] := array[
    'games',
    'season_schedule'
  ];
begin
  foreach table_name in array affected_tables loop
    if exists (select 1 from pg_tables where schemaname = 'public' and tablename = table_name) then
      execute format('alter table public.%I add column if not exists home_away_swapped boolean not null default false', table_name);
    end if;
  end loop;
end $$;
