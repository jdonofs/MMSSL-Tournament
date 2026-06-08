-- Short team abbreviation (e.g. "CLE") for compact scoreboard displays.

alter table players add column if not exists team_abbreviation text;
alter table season_teams add column if not exists team_abbreviation text;
