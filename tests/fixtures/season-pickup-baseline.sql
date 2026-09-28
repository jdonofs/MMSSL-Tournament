-- The season tables a free-agent pickup touches, applied on top of
-- tracker-database-baseline.sql for tests/season-free-agent-pickup.test.mjs.
--
-- WHAT THIS IS NOT. season_roster, season_waivers and season_teams were created
-- outside migration history, and no DDL, RLS policy or trigger for them exists
-- in this repository or in the remote supabase_migrations table. This file is
-- reconstructed from:
--   * one row of each of season_roster, season_teams and seasons read through
--     the anon REST API on 2026-09-14 (column names only);
--   * migrations 036-038 and 054 as recorded in remote migration history
--     (season_waivers and season_roster columns);
--   * the columns SeasonRoster.jsx inserts.
-- Types, defaults, keys and nullability are assumptions. It carries no RLS, no
-- foreign keys to seasons, no season_waiver_claims and no resolve_season_waiver.
-- Passing tests against it prove the function's own logic and rollback on a
-- real PostgreSQL; they are not evidence of compatibility with production.

-- Supabase's auth.uid(): the `sub` claim PostgREST sets for each request.
create schema if not exists auth;
create or replace function auth.uid() returns uuid
language sql stable
as $$
  select nullif(coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  ), '')::uuid
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end
$$;

alter table players add column auth_user_id uuid unique;
alter table players add column is_commissioner boolean not null default false;

create table seasons (
  id serial primary key,
  name text,
  status text
);

create table season_teams (
  id serial primary key,
  season_id int not null references seasons(id),
  player_id uuid references players(id),
  team_name text,
  created_at timestamptz not null default now()
);

create table season_roster (
  id serial primary key,
  season_id int not null,
  team_id int not null,
  character_name text not null,
  acquired_via text,
  is_active boolean default true,
  created_at timestamptz not null default now(),
  round int,
  pick_number int,
  pick_in_round int
);

create table season_waivers (
  id serial primary key,
  season_id int not null,
  claiming_character text,
  source_team_id int,
  status text not null default 'active',
  denied_team_ids integer[] not null default '{}'::integer[],
  priority_order int,
  expires_at timestamptz,
  resolved_at timestamptz,
  awarded_to_team_id int,
  created_at timestamptz not null default now()
);

create table season_waiver_claims (
  id serial primary key,
  waiver_id int not null references season_waivers(id),
  season_id int not null,
  claiming_team_id int not null,
  dropping_character text,
  priority_order int,
  status text not null default 'pending',
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
