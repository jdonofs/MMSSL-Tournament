-- Serialize game-local PA appends with undo. The unique index from migration
-- 074 prevents duplicate numbers, but by itself cannot prevent this race:
-- client A deletes PA 1 while stale client B successfully inserts PA 2.

CREATE OR REPLACE FUNCTION public.enforce_scorebook_pa_append_sequence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  latest_pa_number integer;
BEGIN
  -- The table name keeps tournament and season locks independent while the
  -- game id provides a narrow lock for only the game being scored.
  PERFORM pg_advisory_xact_lock(hashtext(TG_TABLE_NAME), NEW.game_id::integer);

  EXECUTE format(
    'SELECT COALESCE(MAX(pa_number), 0) FROM public.%I WHERE game_id = $1',
    TG_TABLE_NAME
  ) INTO latest_pa_number USING NEW.game_id;

  IF NEW.pa_number <> latest_pa_number + 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'stale plate appearance sequence',
      DETAIL = format(
        'Game %s expected PA %s but received PA %s',
        NEW.game_id,
        latest_pa_number + 1,
        NEW.pa_number
      );
  END IF;

  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS plate_appearances_append_sequence ON public.plate_appearances;
CREATE TRIGGER plate_appearances_append_sequence
BEFORE INSERT ON public.plate_appearances
FOR EACH ROW EXECUTE FUNCTION public.enforce_scorebook_pa_append_sequence();
DROP TRIGGER IF EXISTS season_plate_appearances_append_sequence ON public.season_plate_appearances;
CREATE TRIGGER season_plate_appearances_append_sequence
BEFORE INSERT ON public.season_plate_appearances
FOR EACH ROW EXECUTE FUNCTION public.enforce_scorebook_pa_append_sequence();
CREATE OR REPLACE FUNCTION public.undo_latest_tournament_pa(
  p_game_id integer,
  p_pa_id bigint
)
RETURNS bigint
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  target_pa_number integer;
  latest_pa_number integer;
BEGIN
  IF NOT public.current_player_has_scorebook_access() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'scorebook write access required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('plate_appearances'), p_game_id);

  SELECT pa_number INTO target_pa_number
  FROM public.plate_appearances
  WHERE id = p_pa_id AND game_id = p_game_id;

  SELECT COALESCE(MAX(pa_number), 0) INTO latest_pa_number
  FROM public.plate_appearances
  WHERE game_id = p_game_id;

  IF target_pa_number IS NULL OR target_pa_number <> latest_pa_number THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'plate appearance changed before undo',
      DETAIL = format('Game %s latest PA is %s', p_game_id, latest_pa_number);
  END IF;

  DELETE FROM public.pitches WHERE pa_id = p_pa_id AND game_id = p_game_id;
  DELETE FROM public.runs_scored WHERE pa_id = p_pa_id AND game_id = p_game_id;
  DELETE FROM public.plate_appearances WHERE id = p_pa_id AND game_id = p_game_id;
  RETURN p_pa_id;
END;
$$;
CREATE OR REPLACE FUNCTION public.undo_latest_season_pa(
  p_game_id integer,
  p_pa_id bigint
)
RETURNS bigint
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  target_pa_number integer;
  latest_pa_number integer;
BEGIN
  IF NOT public.current_player_has_scorebook_access() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'scorebook write access required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('season_plate_appearances'), p_game_id);

  SELECT pa_number INTO target_pa_number
  FROM public.season_plate_appearances
  WHERE id = p_pa_id AND game_id = p_game_id;

  SELECT COALESCE(MAX(pa_number), 0) INTO latest_pa_number
  FROM public.season_plate_appearances
  WHERE game_id = p_game_id;

  IF target_pa_number IS NULL OR target_pa_number <> latest_pa_number THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'plate appearance changed before undo',
      DETAIL = format('Game %s latest PA is %s', p_game_id, latest_pa_number);
  END IF;

  DELETE FROM public.season_pitches WHERE pa_id = p_pa_id AND game_id = p_game_id;
  DELETE FROM public.season_runs_scored WHERE pa_id = p_pa_id AND game_id = p_game_id;
  DELETE FROM public.season_plate_appearances WHERE id = p_pa_id AND game_id = p_game_id;
  RETURN p_pa_id;
END;
$$;
REVOKE ALL ON FUNCTION public.undo_latest_tournament_pa(integer, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.undo_latest_season_pa(integer, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.undo_latest_tournament_pa(integer, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.undo_latest_season_pa(integer, bigint) TO authenticated;
