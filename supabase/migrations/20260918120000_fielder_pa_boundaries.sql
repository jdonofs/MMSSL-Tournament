
-- A position change made mid-inning used to DELETE the row it replaced:
-- inning_from/inning_to cannot say which side of the change a play in that
-- inning fell on, so the earlier stint was simply dropped and every play in the
-- inning went to whoever moved in (game 2766: Toadette's RF catch credited to
-- Red Pianta). pa_from/pa_to bound a row by the game's pa_number. Null means the
-- row is bounded by its innings alone, which is every row written before this.
alter table public.game_fielders
  add column if not exists pa_from integer,
  add column if not exists pa_to integer;

alter table public.season_game_fielders
  add column if not exists pa_from integer,
  add column if not exists pa_to integer;

;
