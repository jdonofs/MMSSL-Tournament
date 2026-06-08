alter table public.players
  add column if not exists email text,
  add column if not exists auth_user_id uuid references auth.users(id) on delete set null;

create unique index if not exists players_email_lower_unique_idx
  on public.players (lower(email))
  where email is not null;

create unique index if not exists players_auth_user_id_unique_idx
  on public.players (auth_user_id)
  where auth_user_id is not null;

alter table public.games
  add column if not exists live_state jsonb not null default '{}'::jsonb;

alter table public.season_schedule
  add column if not exists live_state jsonb not null default '{}'::jsonb;

create table if not exists public.tournament_trade_proposals (
  id serial primary key,
  tournament_id text not null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_by_player_id text not null
);

create table if not exists public.tournament_trade_proposal_players (
  id serial primary key,
  proposal_id integer not null references public.tournament_trade_proposals(id) on delete cascade,
  player_id text not null,
  decision_status text not null default 'pending'
);

create table if not exists public.tournament_trade_proposal_moves (
  id serial primary key,
  proposal_id integer not null references public.tournament_trade_proposals(id) on delete cascade,
  character_id integer,
  character_name text not null,
  from_player_id text not null,
  to_player_id text not null
);

create or replace function public.current_auth_email()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select lower(nullif(auth.jwt() ->> 'email', ''));
$$;

create or replace function public.current_player_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.id
  from public.players p
  where p.auth_user_id = auth.uid()
  limit 1;
$$;

create or replace function public.current_player_is_commissioner()
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
      and p.is_commissioner is true
  );
$$;

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

create or replace function public.link_player_to_current_user()
returns public.players
language plpgsql
security definer
set search_path = public
as $$
declare
  linked_player public.players;
  auth_email text := public.current_auth_email();
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select *
  into linked_player
  from public.players
  where auth_user_id = auth.uid()
  limit 1;

  if found then
    return linked_player;
  end if;

  if auth_email is null then
    return null;
  end if;

  update public.players
  set auth_user_id = auth.uid(),
      email = coalesce(public.players.email, auth_email)
  where id = (
    select p.id
    from public.players p
    where p.auth_user_id is null
      and lower(coalesce(p.email, '')) = auth_email
    limit 1
  )
  returning *
  into linked_player;

  return linked_player;
end;
$$;

create or replace function public.create_player_for_current_user(player_name text, player_color text default '#38BDF8')
returns public.players
language plpgsql
security definer
set search_path = public
as $$
declare
  created_player public.players;
  existing_player_id uuid := public.current_player_id();
  auth_email text := public.current_auth_email();
  trimmed_name text := nullif(trim(player_name), '');
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if existing_player_id is not null then
    select *
    into created_player
    from public.players
    where id = existing_player_id;
    return created_player;
  end if;

  if trimmed_name is null then
    raise exception 'Player name is required';
  end if;

  if auth_email is not null and exists (
    select 1
    from public.players
    where lower(coalesce(email, '')) = auth_email
  ) then
    raise exception 'This email is already assigned to an existing player. Ask a commissioner to finish the link.';
  end if;

  insert into public.players (
    name,
    color,
    email,
    auth_user_id,
    is_commissioner,
    scorebook_access
  )
  values (
    trimmed_name,
    nullif(trim(player_color), ''),
    auth_email,
    auth.uid(),
    false,
    false
  )
  returning *
  into created_player;

  return created_player;
end;
$$;

create or replace function public.update_my_player_profile(
  team_location_in text,
  team_mascot_in text,
  team_abbreviation_in text,
  primary_color_in text,
  secondary_color_in text,
  logo_url_in text
)
returns public.players
language plpgsql
security definer
set search_path = public
as $$
declare
  target_player_id uuid := public.current_player_id();
  full_team_name text;
  updated_player public.players;
begin
  if target_player_id is null then
    raise exception 'Linked player required';
  end if;

  full_team_name := nullif(
    trim(
      concat_ws(
        ' ',
        nullif(trim(team_location_in), ''),
        nullif(trim(team_mascot_in), '')
      )
    ),
    ''
  );

  update public.players
  set team_name = full_team_name,
      team_location = nullif(trim(team_location_in), ''),
      team_mascot = nullif(trim(team_mascot_in), ''),
      team_abbreviation = upper(left(coalesce(nullif(trim(team_abbreviation_in), ''), ''), 5)),
      team_primary_color = nullif(trim(primary_color_in), ''),
      team_secondary_color = nullif(trim(secondary_color_in), ''),
      team_logo_url = nullif(trim(logo_url_in), '')
  where id = target_player_id
  returning *
  into updated_player;

  update public.season_teams
  set team_name = updated_player.team_name,
      team_location = updated_player.team_location,
      team_mascot = updated_player.team_mascot,
      team_abbreviation = updated_player.team_abbreviation,
      team_primary_color = updated_player.team_primary_color,
      team_secondary_color = updated_player.team_secondary_color,
      logo_url = updated_player.team_logo_url
  where player_id = target_player_id
    and season_id in (
      select s.id
      from public.seasons s
      where s.status <> 'completed'
    );

  return updated_player;
end;
$$;

revoke all on function public.current_auth_email() from public;
revoke all on function public.current_player_id() from public;
revoke all on function public.current_player_is_commissioner() from public;
revoke all on function public.current_player_has_scorebook_access() from public;
revoke all on function public.link_player_to_current_user() from public;
revoke all on function public.create_player_for_current_user(text, text) from public;
revoke all on function public.update_my_player_profile(text, text, text, text, text, text) from public;

grant execute on function public.current_auth_email() to authenticated;
grant execute on function public.current_player_id() to authenticated;
grant execute on function public.current_player_is_commissioner() to authenticated;
grant execute on function public.current_player_has_scorebook_access() to authenticated;
grant execute on function public.link_player_to_current_user() to authenticated;
grant execute on function public.create_player_for_current_user(text, text) to authenticated;
grant execute on function public.update_my_player_profile(text, text, text, text, text, text) to authenticated;

do $$
declare
  table_name text;
  protected_tables text[] := array[
    'players',
    'characters',
    'tournaments',
    'draft_picks',
    'games',
    'stadiums',
    'stadium_game_log',
    'inning_scores',
    'lineups',
    'plate_appearances',
    'pitching_stints',
    'pitches',
    'game_fielders',
    'runs_scored',
    'bets',
    'game_odds',
    'game_settlements',
    'odds_calibration_log',
    'odds_engine_weights',
    'points_ledger',
    'seasons',
    'season_teams',
    'season_roster',
    'season_auction_bids',
    'season_auction_bid_entries',
    'season_schedule',
    'season_lineups',
    'season_plate_appearances',
    'season_pitching_stints',
    'season_inning_scores',
    'season_pitches',
    'season_game_fielders',
    'season_runs_scored',
    'season_trades',
    'season_trade_players',
    'season_waivers',
    'season_waiver_claims',
    'season_bets',
    'season_betting_ledger',
    'season_game_odds',
    'season_game_settlements',
    'season_stadium_game_log',
    'season_trade_proposals',
    'season_trade_proposal_teams',
    'season_trade_proposal_moves',
    'tournament_team_logos',
    'tournament_trade_proposals',
    'tournament_trade_proposal_players',
    'tournament_trade_proposal_moves'
  ];
begin
  foreach table_name in array protected_tables loop
    if exists (select 1 from pg_tables where schemaname = 'public' and tablename = table_name) then
      execute format('alter table public.%I enable row level security', table_name);
    end if;
  end loop;
end $$;

do $$
declare
  table_name text;
  protected_tables text[] := array[
    'players',
    'characters',
    'tournaments',
    'draft_picks',
    'games',
    'stadiums',
    'stadium_game_log',
    'inning_scores',
    'lineups',
    'plate_appearances',
    'pitching_stints',
    'pitches',
    'game_fielders',
    'runs_scored',
    'bets',
    'game_odds',
    'game_settlements',
    'odds_calibration_log',
    'odds_engine_weights',
    'points_ledger',
    'seasons',
    'season_teams',
    'season_roster',
    'season_auction_bids',
    'season_auction_bid_entries',
    'season_schedule',
    'season_lineups',
    'season_plate_appearances',
    'season_pitching_stints',
    'season_inning_scores',
    'season_pitches',
    'season_game_fielders',
    'season_runs_scored',
    'season_trades',
    'season_trade_players',
    'season_waivers',
    'season_waiver_claims',
    'season_bets',
    'season_betting_ledger',
    'season_game_odds',
    'season_game_settlements',
    'season_stadium_game_log',
    'season_trade_proposals',
    'season_trade_proposal_teams',
    'season_trade_proposal_moves',
    'tournament_team_logos',
    'tournament_trade_proposals',
    'tournament_trade_proposal_players',
    'tournament_trade_proposal_moves'
  ];
begin
  foreach table_name in array protected_tables loop
    if exists (select 1 from pg_tables where schemaname = 'public' and tablename = table_name) then
      execute format('drop policy if exists authenticated_read on public.%I', table_name);
      execute format(
        'create policy authenticated_read on public.%I for select using (auth.role() = ''authenticated'')',
        table_name
      );

      execute format('drop policy if exists commissioner_all on public.%I', table_name);
      execute format(
        'create policy commissioner_all on public.%I for all using (public.current_player_is_commissioner()) with check (public.current_player_is_commissioner())',
        table_name
      );
    end if;
  end loop;
end $$;

drop policy if exists scorekeeper_update on public.games;
create policy scorekeeper_update on public.games
  for update
  using (public.current_player_has_scorebook_access())
  with check (public.current_player_has_scorebook_access());

drop policy if exists scorekeeper_update on public.season_schedule;
create policy scorekeeper_update on public.season_schedule
  for update
  using (public.current_player_has_scorebook_access())
  with check (public.current_player_has_scorebook_access());

do $$
declare
  table_name text;
  scorebook_tables text[] := array[
    'stadium_game_log',
    'inning_scores',
    'lineups',
    'plate_appearances',
    'pitching_stints',
    'pitches',
    'game_fielders',
    'runs_scored',
    'game_odds',
    'game_settlements',
    'odds_calibration_log',
    'points_ledger',
    'season_lineups',
    'season_plate_appearances',
    'season_pitching_stints',
    'season_inning_scores',
    'season_pitches',
    'season_game_fielders',
    'season_runs_scored',
    'season_game_odds',
    'season_game_settlements',
    'season_betting_ledger',
    'season_stadium_game_log'
  ];
begin
  foreach table_name in array scorebook_tables loop
    if exists (select 1 from pg_tables where schemaname = 'public' and tablename = table_name) then
      execute format('drop policy if exists scorekeeper_all on public.%I', table_name);
      execute format(
        'create policy scorekeeper_all on public.%I for all using (public.current_player_has_scorebook_access()) with check (public.current_player_has_scorebook_access())',
        table_name
      );
    end if;
  end loop;
end $$;

drop policy if exists linked_player_all on public.draft_picks;
create policy linked_player_all on public.draft_picks
  for all
  using (public.current_player_id() is not null)
  with check (public.current_player_id() is not null);

do $$
declare
  table_name text;
  linked_player_tables text[] := array[
    'season_roster',
    'season_auction_bids',
    'season_auction_bid_entries',
    'season_trades',
    'season_trade_players',
    'season_waivers',
    'season_waiver_claims',
    'season_trade_proposals',
    'season_trade_proposal_teams',
    'season_trade_proposal_moves',
    'tournament_trade_proposals',
    'tournament_trade_proposal_players',
    'tournament_trade_proposal_moves'
  ];
begin
  foreach table_name in array linked_player_tables loop
    if exists (select 1 from pg_tables where schemaname = 'public' and tablename = table_name) then
      execute format('drop policy if exists linked_player_all on public.%I', table_name);
      execute format(
        'create policy linked_player_all on public.%I for all using (public.current_player_id() is not null) with check (public.current_player_id() is not null)',
        table_name
      );
    end if;
  end loop;
end $$;

drop policy if exists own_tournament_logo_all on public.tournament_team_logos;
create policy own_tournament_logo_all on public.tournament_team_logos
  for all
  using (player_id = public.current_player_id())
  with check (player_id = public.current_player_id());

drop policy if exists own_bets_all on public.bets;
create policy own_bets_all on public.bets
  for all
  using (player_id = public.current_player_id())
  with check (player_id = public.current_player_id());

drop policy if exists own_season_bets_all on public.season_bets;
create policy own_season_bets_all on public.season_bets
  for all
  using (player_id = public.current_player_id())
  with check (player_id = public.current_player_id());

do $$
declare
  publication_table text;
  realtime_tables text[] := array[
    'players',
    'tournaments',
    'draft_picks',
    'games',
    'stadiums',
    'stadium_game_log',
    'inning_scores',
    'lineups',
    'plate_appearances',
    'pitching_stints',
    'pitches',
    'game_fielders',
    'runs_scored',
    'bets',
    'game_odds',
    'game_settlements',
    'points_ledger',
    'seasons',
    'season_teams',
    'season_roster',
    'season_schedule',
    'season_lineups',
    'season_plate_appearances',
    'season_pitching_stints',
    'season_inning_scores',
    'season_pitches',
    'season_game_fielders',
    'season_runs_scored',
    'season_trades',
    'season_trade_players',
    'season_waivers',
    'season_waiver_claims',
    'season_bets',
    'season_betting_ledger',
    'season_game_odds',
    'season_game_settlements',
    'season_stadium_game_log',
    'season_trade_proposals',
    'season_trade_proposal_teams',
    'season_trade_proposal_moves',
    'tournament_team_logos',
    'tournament_trade_proposals',
    'tournament_trade_proposal_players',
    'tournament_trade_proposal_moves'
  ];
begin
  foreach publication_table in array realtime_tables loop
    if exists (select 1 from pg_tables where schemaname = 'public' and tablename = publication_table)
       and not exists (
         select 1
         from pg_publication_tables
         where pubname = 'supabase_realtime'
           and schemaname = 'public'
           and tablename = publication_table
       ) then
      execute format('alter publication supabase_realtime add table public.%I', publication_table);
    end if;
  end loop;
end $$;
