-- Universal team identity per player (applies to current + future seasons/tournaments)
alter table players add column if not exists team_name text;
alter table players add column if not exists team_logo_url text;
