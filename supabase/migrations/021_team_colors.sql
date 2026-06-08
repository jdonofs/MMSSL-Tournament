-- Primary/secondary team colors. Primary replaces the player color for
-- team name/abbreviation displays; secondary is a complementary accent.

alter table players add column if not exists team_primary_color text;
alter table players add column if not exists team_secondary_color text;
alter table season_teams add column if not exists team_primary_color text;
alter table season_teams add column if not exists team_secondary_color text;
