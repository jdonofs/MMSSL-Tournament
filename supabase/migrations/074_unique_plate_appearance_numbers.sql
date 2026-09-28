-- A plate appearance number is the game-local sequence key used by the
-- scorebook. Without a database constraint, two scorekeepers can save the same
-- next PA concurrently and both inserts succeed.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM plate_appearances
    GROUP BY game_id, pa_number
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot add plate_appearances game/PA uniqueness: duplicate rows exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM season_plate_appearances
    GROUP BY game_id, pa_number
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot add season_plate_appearances game/PA uniqueness: duplicate rows exist';
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS plate_appearances_game_pa_number_uidx
  ON plate_appearances (game_id, pa_number);
CREATE UNIQUE INDEX IF NOT EXISTS season_plate_appearances_game_pa_number_uidx
  ON season_plate_appearances (game_id, pa_number);
