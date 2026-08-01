with t1 as (
  select id
  from public.tournaments
  where tournament_number = 1
  limit 1
), t1_games as (
  select id
  from public.games
  where tournament_id in (select id from t1)
)
select json_build_object(
  'plate_appearances', coalesce((select json_agg(pa order by pa.id) from public.plate_appearances pa where pa.game_id in (select id from t1_games)), '[]'::json),
  'pitching_stints', coalesce((select json_agg(ps order by ps.id) from public.pitching_stints ps where ps.game_id in (select id from t1_games)), '[]'::json)
) as backup;
