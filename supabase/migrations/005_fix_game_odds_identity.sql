-- Repair game_odds.id auto-increment for databases where the table existed without a default.

create sequence if not exists game_odds_id_seq;

select setval(
  'game_odds_id_seq',
  coalesce((select max(id) from game_odds), 0) + 1,
  false
);

alter table if exists game_odds
  alter column id set default nextval('game_odds_id_seq');

alter sequence game_odds_id_seq owned by game_odds.id;
