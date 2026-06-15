-- Persistent, realtime-synced team lineup/fielding storage.
-- Replaces the old localStorage-only roster-lineup-*/roster-fielding-* and
-- season-lineup-*/season-fielding-* keys so that lineup edits made by a team
-- owner, scorekeeper, or commissioner are visible to everyone immediately.

create table if not exists public.team_lineups (
  id bigserial primary key,
  tournament_id int not null references public.tournaments(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  lineup_order jsonb not null default '[]'::jsonb,
  fielding_positions jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (tournament_id, player_id)
);

create table if not exists public.season_team_lineups (
  id bigserial primary key,
  season_id int not null references public.seasons(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  lineup_order jsonb not null default '[]'::jsonb,
  fielding_positions jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (season_id, player_id)
);

alter table public.team_lineups enable row level security;
alter table public.season_team_lineups enable row level security;

drop policy if exists team_lineups_select on public.team_lineups;
create policy team_lineups_select on public.team_lineups
  for select using (true);

drop policy if exists team_lineups_write on public.team_lineups;
create policy team_lineups_write on public.team_lineups
  for all using (
    public.current_player_has_scorebook_access()
    or exists (
      select 1 from public.players p
      where p.auth_user_id = auth.uid() and p.id = team_lineups.player_id
    )
  )
  with check (
    public.current_player_has_scorebook_access()
    or exists (
      select 1 from public.players p
      where p.auth_user_id = auth.uid() and p.id = team_lineups.player_id
    )
  );

drop policy if exists season_team_lineups_select on public.season_team_lineups;
create policy season_team_lineups_select on public.season_team_lineups
  for select using (true);

drop policy if exists season_team_lineups_write on public.season_team_lineups;
create policy season_team_lineups_write on public.season_team_lineups
  for all using (
    public.current_player_has_scorebook_access()
    or exists (
      select 1 from public.players p
      where p.auth_user_id = auth.uid() and p.id = season_team_lineups.player_id
    )
  )
  with check (
    public.current_player_has_scorebook_access()
    or exists (
      select 1 from public.players p
      where p.auth_user_id = auth.uid() and p.id = season_team_lineups.player_id
    )
  );

alter publication supabase_realtime add table public.team_lineups;
alter publication supabase_realtime add table public.season_team_lineups;
