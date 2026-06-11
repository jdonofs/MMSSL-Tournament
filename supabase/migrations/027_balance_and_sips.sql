-- Unify tournament bets onto the same dollar-denominated wager fields as
-- season_bets, and introduce a player balance/sips economy. Every player
-- starts each tournament/season with a $100 balance (computed from the
-- existing points_ledger / season_betting_ledger rows plus the new tables
-- below); sips are a separate $10 redeemable token that can be assigned to
-- another player to force a drink, replacing the old finish_drink bet type.

alter table public.bets rename column wager_sips to wager_dollars;
alter table public.bets rename column potential_payout_sips to potential_payout_dollars;
alter table public.bets alter column wager_dollars type numeric;
alter table public.bets alter column potential_payout_dollars type numeric;

-- game_settlements previously tracked "sips" plus a finish-drink flag; the
-- finish-drink mechanic is replaced by sip_redemptions below, and settlement
-- amounts are now dollar-denominated to match the bets table.
alter table public.game_settlements rename column sips to dollars;
alter table public.game_settlements alter column dollars type numeric;
alter table public.game_settlements drop column if exists is_finish_drink;

create table if not exists public.player_sips (
  id serial primary key,
  tournament_id int references tournaments(id) on delete cascade,
  season_id int references seasons(id) on delete cascade,
  player_id uuid references players(id) on delete cascade,
  sip_count int not null default 0,
  updated_at timestamptz default now(),
  constraint player_sips_one_context check (
    (tournament_id is not null and season_id is null)
    or (tournament_id is null and season_id is not null)
  )
);

create unique index if not exists player_sips_unique_idx
  on public.player_sips (coalesce(tournament_id, -1), coalesce(season_id, -1), player_id);

create table if not exists public.sip_transactions (
  id serial primary key,
  tournament_id int references tournaments(id) on delete cascade,
  season_id int references seasons(id) on delete cascade,
  player_id uuid references players(id) on delete cascade,
  type text not null check (type in ('buy', 'sell')),
  amount_dollars numeric not null,
  created_at timestamptz default now(),
  constraint sip_transactions_one_context check (
    (tournament_id is not null and season_id is null)
    or (tournament_id is null and season_id is not null)
  )
);

create table if not exists public.sip_redemptions (
  id serial primary key,
  tournament_id int references tournaments(id) on delete cascade,
  season_id int references seasons(id) on delete cascade,
  from_player_id uuid references players(id) on delete cascade,
  to_player_id uuid references players(id) on delete cascade,
  note text,
  created_at timestamptz default now(),
  constraint sip_redemptions_one_context check (
    (tournament_id is not null and season_id is null)
    or (tournament_id is null and season_id is not null)
  )
);

create table if not exists public.balance_awards (
  id serial primary key,
  tournament_id int references tournaments(id) on delete cascade,
  season_id int references seasons(id) on delete cascade,
  player_id uuid references players(id) on delete cascade,
  amount numeric not null,
  note text,
  awarded_by uuid references players(id),
  created_at timestamptz default now(),
  constraint balance_awards_one_context check (
    (tournament_id is not null and season_id is null)
    or (tournament_id is null and season_id is not null)
  )
);

-- RLS, following the pattern in 022_auth_realtime_security.sql
alter table public.player_sips enable row level security;
alter table public.sip_transactions enable row level security;
alter table public.sip_redemptions enable row level security;
alter table public.balance_awards enable row level security;

do $$
declare
  table_name text;
  economy_tables text[] := array['player_sips', 'sip_transactions', 'sip_redemptions', 'balance_awards'];
begin
  foreach table_name in array economy_tables loop
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
  end loop;
end $$;

drop policy if exists own_player_sips_all on public.player_sips;
create policy own_player_sips_all on public.player_sips
  for all
  using (player_id = public.current_player_id())
  with check (player_id = public.current_player_id());

drop policy if exists own_sip_transactions_all on public.sip_transactions;
create policy own_sip_transactions_all on public.sip_transactions
  for all
  using (player_id = public.current_player_id())
  with check (player_id = public.current_player_id());

drop policy if exists own_sip_redemptions_all on public.sip_redemptions;
create policy own_sip_redemptions_all on public.sip_redemptions
  for all
  using (from_player_id = public.current_player_id())
  with check (from_player_id = public.current_player_id());
