-- Concurrent odds-sync calls (e.g. two pitching changes landing around the
-- same time) could both read "no existing row for this prop" and both
-- insert, producing duplicate game_odds/season_game_odds rows for the same
-- (game_id, bet_type, target_entity). Clean up any duplicates that already
-- exist (keep the most recently updated row per group) and add a unique
-- constraint so future syncs upsert onto the same row instead of inserting
-- a second copy.

delete from public.game_odds a
  using public.game_odds b
  where a.game_id = b.game_id
    and a.bet_type = b.bet_type
    and coalesce(a.target_entity, '') = coalesce(b.target_entity, '')
    and (
      a.updated_at < b.updated_at
      or (a.updated_at = b.updated_at and a.id < b.id)
    );

delete from public.season_game_odds a
  using public.season_game_odds b
  where a.game_id = b.game_id
    and a.bet_type = b.bet_type
    and coalesce(a.target_entity, '') = coalesce(b.target_entity, '')
    and (
      a.updated_at < b.updated_at
      or (a.updated_at = b.updated_at and a.id < b.id)
    );

alter table public.game_odds
  add constraint game_odds_game_bet_entity_key unique (game_id, bet_type, target_entity);

alter table public.season_game_odds
  add constraint season_game_odds_game_bet_entity_key unique (game_id, bet_type, target_entity);
