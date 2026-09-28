-- Scorebook writes must be authorized by the database, not only hidden in the
-- React UI. All authenticated users may read game history; only commissioners
-- and players explicitly granted scorebook access may mutate game-state rows.

CREATE OR REPLACE FUNCTION public.current_player_has_scorebook_access()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.players p
    WHERE p.auth_user_id = auth.uid()
      AND (p.is_commissioner IS TRUE OR p.scorebook_access IS TRUE)
  );
$$;
REVOKE ALL ON FUNCTION public.current_player_has_scorebook_access() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_player_has_scorebook_access() TO authenticated;
DO $$
DECLARE
  table_name text;
  scorebook_tables text[] := ARRAY[
    'tournaments',
    'games',
    'team_lineups',
    'lineups',
    'plate_appearances',
    'pitching_stints',
    'pitches',
    'game_fielders',
    'runs_scored',
    'inning_scores',
    'stadium_game_log',
    'game_odds',
    'odds_calibration_log',
    'odds_engine_weights',
    'seasons',
    'season_teams',
    'season_schedule',
    'season_team_lineups',
    'season_lineups',
    'season_plate_appearances',
    'season_pitching_stints',
    'season_pitches',
    'season_game_fielders',
    'season_runs_scored',
    'season_inning_scores',
    'season_stadium_game_log',
    'season_game_odds'
  ];
BEGIN
  FOREACH table_name IN ARRAY scorebook_tables LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_tables
      WHERE schemaname = 'public' AND tablename = table_name
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);

      -- Replace earlier broad scorekeeper policies with explicit per-operation
      -- policies so this migration is the authoritative write boundary.
      EXECUTE format('DROP POLICY IF EXISTS authenticated_read ON public.%I', table_name);
      EXECUTE format('DROP POLICY IF EXISTS scorekeeper_all ON public.%I', table_name);
      EXECUTE format('DROP POLICY IF EXISTS scorekeeper_update ON public.%I', table_name);
      EXECUTE format('DROP POLICY IF EXISTS scorebook_authenticated_read ON public.%I', table_name);
      EXECUTE format('DROP POLICY IF EXISTS scorebook_scorekeeper_insert ON public.%I', table_name);
      EXECUTE format('DROP POLICY IF EXISTS scorebook_scorekeeper_update ON public.%I', table_name);
      EXECUTE format('DROP POLICY IF EXISTS scorebook_scorekeeper_delete ON public.%I', table_name);

      EXECUTE format(
        'CREATE POLICY scorebook_authenticated_read ON public.%I FOR SELECT TO authenticated USING (true)',
        table_name
      );
      EXECUTE format(
        'CREATE POLICY scorebook_scorekeeper_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (public.current_player_has_scorebook_access())',
        table_name
      );
      EXECUTE format(
        'CREATE POLICY scorebook_scorekeeper_update ON public.%I FOR UPDATE TO authenticated USING (public.current_player_has_scorebook_access()) WITH CHECK (public.current_player_has_scorebook_access())',
        table_name
      );
      EXECUTE format(
        'CREATE POLICY scorebook_scorekeeper_delete ON public.%I FOR DELETE TO authenticated USING (public.current_player_has_scorebook_access())',
        table_name
      );
    END IF;
  END LOOP;
END $$;
