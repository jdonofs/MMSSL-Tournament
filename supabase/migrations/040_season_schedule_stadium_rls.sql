-- Allow a team's own player (the home team / stadium picker) to update the
-- stadium + day/night setup for their own season_schedule games, even if they
-- don't otherwise have scorebook_access. Previously only commissioners and
-- players with scorebook_access could write to season_schedule, so "Save
-- Setup" silently no-op'd (RLS blocked the update with 0 rows affected, no
-- error) for home-team managers without scorebook access.

create or replace function public.current_player_can_edit_game_stadium(p_game_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select true
    from public.season_schedule g
    join public.season_teams t
      on t.id = coalesce(g.stadium_picker_team_id, g.home_team_id)
    join public.players p
      on p.id = t.player_id
    where g.id = p_game_id
      and p.auth_user_id = auth.uid()
  ), false)
  or public.current_player_has_scorebook_access();
$$;

revoke all on function public.current_player_can_edit_game_stadium(bigint) from public;
grant execute on function public.current_player_can_edit_game_stadium(bigint) to authenticated;

alter table public.season_schedule enable row level security;

drop policy if exists stadium_setup_update on public.season_schedule;
create policy stadium_setup_update on public.season_schedule
  for update
  using (public.current_player_can_edit_game_stadium(id))
  with check (public.current_player_can_edit_game_stadium(id));
