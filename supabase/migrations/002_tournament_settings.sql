-- Tournament settings schema extension
-- Run this in the Supabase SQL editor

-- Restore is_commissioner if previously dropped
alter table if exists players
  add column if not exists is_commissioner boolean default false;

-- Tournament settings columns
alter table if exists tournaments
  add column if not exists innings int default 3;

alter table if exists tournaments
  add column if not exists mercy_rule boolean default true;


alter table if exists tournaments
  add column if not exists bracket_format text default 'double'
    check (bracket_format in ('single', 'double', 'round_robin'));

alter table if exists tournaments
  add column if not exists player_ids uuid[] default '{}';

alter table if exists tournaments
  add column if not exists seeding jsonb default '[]';

alter table if exists tournaments
  add column if not exists draft_order jsonb default '[]';

alter table if exists tournaments
  add column if not exists archived boolean default false;

-- Game extension columns
alter table if exists games
  add column if not exists is_extra_innings boolean default false;

alter table if exists games
  add column if not exists final_inning int;
