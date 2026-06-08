-- Run this in the Supabase SQL editor to enable tournament trading.

-- Trade deadline field on tournaments
alter table public.tournaments add column if not exists trade_deadline_at timestamptz;

-- Trade proposals
create table if not exists public.tournament_trade_proposals (
  id          serial primary key,
  tournament_id text not null,
  status      text not null default 'pending',
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,
  created_by_player_id text not null
);

-- Participants (one row per player in the trade)
create table if not exists public.tournament_trade_proposal_players (
  id              serial primary key,
  proposal_id     integer not null references public.tournament_trade_proposals(id) on delete cascade,
  player_id       text not null,
  decision_status text not null default 'pending'
);

-- Moves (one row per character being swapped)
create table if not exists public.tournament_trade_proposal_moves (
  id             serial primary key,
  proposal_id    integer not null references public.tournament_trade_proposals(id) on delete cascade,
  character_id   integer,
  character_name text not null,
  from_player_id text not null,
  to_player_id   text not null
);

-- Enable realtime for all three tables
alter publication supabase_realtime add table public.tournament_trade_proposals;
alter publication supabase_realtime add table public.tournament_trade_proposal_players;
alter publication supabase_realtime add table public.tournament_trade_proposal_moves;
