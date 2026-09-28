-- `tracking_catch_approaches.pa_id` was declared uuid. It is a plate
-- appearance id, and those are integers.
--
-- 20260920130000 created the table beside `tracking_plays`, whose own id IS a
-- uuid, and took the wrong neighbour for `pa_id`. Every other tracking table
-- -- tracking_plays, movement_metrics, fielding_opportunities, tracking_throws,
-- runner_opportunities, double_play_opportunities -- declares `pa_id bigint`,
-- because plate_appearances.id and season_plate_appearances.id are integer.
--
-- The defect could only show on a session whose plays actually JOIN a plate
-- appearance. Three of the seven tracked games have had their plate
-- appearances deleted, so their pa_id is null on every row and the type never
-- came up; the four that still have theirs failed the whole ingest with
--
--   invalid input syntax for type uuid: "3315"
--
-- There is no uuid-to-integer conversion to write, because a uuid plate
-- appearance id never existed to store. The guard below states that as a
-- precondition rather than assuming it: if any row somehow holds a value, this
-- migration stops instead of discarding it.

do $$
declare populated bigint;
begin
  select count(*) into populated
  from public.tracking_catch_approaches where pa_id is not null;

  if populated > 0 then
    raise exception
      'tracking_catch_approaches has % row(s) with a non-null uuid pa_id; '
      'they have to be mapped to integer plate appearance ids by hand before '
      'this migration can run', populated;
  end if;

  alter table public.tracking_catch_approaches
    alter column pa_id type bigint using null::bigint;
end $$;

comment on column public.tracking_catch_approaches.pa_id is
  'The plate appearance this reach belongs to, in the same integer id space as '
  'tracking_plays.pa_id. Null when the play joined no plate appearance.';

notify pgrst, 'reload schema';
