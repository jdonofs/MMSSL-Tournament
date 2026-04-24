alter table if exists players disable row level security;
alter table if exists characters disable row level security;
alter table if exists tournaments disable row level security;
alter table if exists draft_picks disable row level security;
alter table if exists games disable row level security;
alter table if exists inning_scores disable row level security;
alter table if exists lineups disable row level security;
alter table if exists plate_appearances disable row level security;
alter table if exists pitching_stints disable row level security;
alter table if exists bets disable row level security;
alter table if exists points_ledger disable row level security;

alter table if exists players drop column if exists pin_hash;
alter table if exists players drop column if exists is_commissioner;

insert into players (name, color)
values
  ('Aidan', '#3B82F6'),
  ('Donovan', '#F97316'),
  ('Jason', '#22C55E'),
  ('Justin', '#EF4444'),
  ('May', '#A855F7'),
  ('Nick', '#EC4899')
on conflict (name) do nothing;
