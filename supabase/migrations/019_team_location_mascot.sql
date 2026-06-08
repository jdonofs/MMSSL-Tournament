-- Split team identity into a location/prefix part and a mascot/short-name part,
-- so compact lists can show just the mascot (e.g. "Cleveland Kings" -> "Kings").
-- team_name remains the stored full display name, derived as `${location} ${mascot}`.

alter table players add column if not exists team_location text;
alter table players add column if not exists team_mascot text;

alter table season_teams add column if not exists team_location text;
alter table season_teams add column if not exists team_mascot text;

-- Best-effort backfill: split existing names on the last word.
-- "Waluigi Spitballs" -> location "Waluigi", mascot "Spitballs"
-- "Goomba"            -> location null,      mascot "Goomba"
update players
set team_location = case when team_name ~ '\s' then regexp_replace(team_name, '\s+\S+$', '') else null end,
    team_mascot = regexp_replace(team_name, '^.*\s', '')
where team_name is not null
  and team_location is null
  and team_mascot is null;

update season_teams
set team_location = case when team_name ~ '\s' then regexp_replace(team_name, '\s+\S+$', '') else null end,
    team_mascot = regexp_replace(team_name, '^.*\s', '')
where team_name is not null
  and team_location is null
  and team_mascot is null;
