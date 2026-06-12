alter table public.game_odds
  add column if not exists prop_lambda numeric,
  add column if not exists prop_variance_multiplier numeric;

alter table public.season_game_odds
  add column if not exists prop_lambda numeric,
  add column if not exists prop_variance_multiplier numeric;
