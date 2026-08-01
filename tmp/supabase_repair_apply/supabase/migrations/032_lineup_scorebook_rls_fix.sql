-- Ensure commissioners and players with scorebook access can insert/update/delete
-- live lineup & fielding-position rows from the Scorebook "Lineups" tab.
-- (Re-applies the relevant pieces of 022_auth_realtime_security.sql in case that
-- migration was not fully applied to this database.)

create or replace function public.current_player_has_scorebook_access()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1
    from public.players p
    where p.auth_user_id = auth.uid()
      and (p.is_commissioner is true or p.scorebook_access is true)
  );
$$;

revoke all on function public.current_player_has_scorebook_access() from public;
grant execute on function public.current_player_has_scorebook_access() to authenticated;

do $$
declare
  table_name text;
  scorebook_tables text[] := array[
    'lineups',
    'game_fielders',
    'season_lineups',
    'season_game_fielders'
  ];
begin
  foreach table_name in array scorebook_tables loop
    if exists (select 1 from pg_tables where schemaname = 'public' and tablename = table_name) then
      execute format('alter table public.%I enable row level security', table_name);
      execute format('drop policy if exists scorekeeper_all on public.%I', table_name);
      execute format(
        'create policy scorekeeper_all on public.%I for all using (public.current_player_has_scorebook_access()) with check (public.current_player_has_scorebook_access())',
        table_name
      );
    end if;
  end loop;
end $$;
