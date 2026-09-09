-- Odds rows identify the pricing model that produced them. The application
-- writes this field for both tournament and season markets, so keep the two
-- schemas in lockstep.

alter table if exists public.game_odds
  add column if not exists model_version text;

alter table if exists public.season_game_odds
  add column if not exists model_version text;

-- Make the new columns visible immediately to PostgREST clients after this
-- migration is applied.
notify pgrst, 'reload schema';
