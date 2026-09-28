-- How far each fielder actually had to reach, and whether they got there.
--
-- WHY THIS IS NOT A COLUMN ON fielding_opportunities. That table is one row per
-- fielder per play and is built around the batted ball. A catch approach is a
-- different grain and a different question:
--
--   * a fielder can open two windows on one play (107 of 1,705 fielder-plays
--     in the archive do, and four open three);
--   * 675 of 1,816 windows are a THROW being received, which is a different
--     mechanic from reaching a batted ball and would pollute a reach column;
--   * the windows that never touch the ball are the important ones. A dive that
--     comes up empty produces no fielding event at all, so it has no
--     opportunity row to hang off, and it is exactly the observation that says
--     a reach was NOT enough.
--
-- WHAT THE NUMBERS ARE FOR. The datamine workbook publishes a catch radius per
-- character per approach. A radius is only testable against a measured
-- separation, so `separation_3d_units` is the ball-to-fielder distance at the
-- closest point of the window and `relative_height_units` is how far above the
-- fielder's own feet the ball was at that moment. Chosen in 3D on purpose: a
-- ball passing overhead reaches its smallest GROUND-PLANE separation exactly
-- when it is furthest out of reach.
--
-- THE LARGEST SECURED CATCH IS A LOWER BOUND, NOT A CAPABILITY. A fielder is
-- never obliged to catch at full stretch, so the biggest separation observed
-- says only "at least this far". The failures bound it from above, and that is
-- why `outcome` keeps `missed` and `no_contact` rather than storing successes
-- alone.

create table if not exists public.tracking_catch_approaches (
  id uuid primary key default gen_random_uuid(),
  tracking_play_id uuid not null references public.tracking_plays(id) on delete cascade,
  game_id bigint,
  pa_id uuid,
  competition_type text,
  position text not null,
  fielder_character_id integer,
  fielder_player_id uuid,

  -- 1 ordinary, 2 receiving a throw, 3 dive, 5 clamber, 6 leap, 7 unresolved.
  catch_type integer,
  approach text not null,

  start_frame integer,
  end_frame integer,
  frames integer,
  closest_frame integer,
  closest_seconds double precision,

  separation_units double precision,
  separation_3d_units double precision,
  relative_height_units double precision,
  ball_height_units double precision,

  outcome text not null,
  secured boolean,
  touched boolean,
  outcome_source text,

  -- Assistance and special action. Any of these true means the window is not a
  -- measurement of the character's own mechanics.
  assisted boolean,
  assisted_at_closest boolean,
  assist_frames integer,
  buddy_jump_frames integer,
  airborne_frames integer,
  mechanics text[],

  -- The character's top-speed constant while the window was live, so a reach
  -- row can be filtered to ordinary (un-boosted) state without a second join.
  max_speed_mps double precision,

  quality jsonb,
  created_at timestamptz not null default now(),

  constraint tracking_catch_approaches_outcome_check
    check (outcome in ('secured', 'touched', 'missed', 'no_contact'))
);

create unique index if not exists tracking_catch_approaches_unique_idx
  on public.tracking_catch_approaches (tracking_play_id, position, start_frame);

create index if not exists tracking_catch_approaches_character_idx
  on public.tracking_catch_approaches (fielder_character_id, approach);

create index if not exists tracking_catch_approaches_game_idx
  on public.tracking_catch_approaches (game_id);

comment on column public.tracking_catch_approaches.separation_3d_units is
  'Ball-to-fielder distance at the closest point of the approach, in world '
  'units. The quantity a published catch radius is comparable against.';

comment on column public.tracking_catch_approaches.outcome is
  'secured = held it; touched = reached it and did not hold it; missed = an '
  'attempt that produced a fielding event without contact; no_contact = the '
  'window never reached the ball at all. Failures are kept deliberately: the '
  'largest secured catch is a lower bound on reach, and only the failures '
  'bound it from above.';

-- The same six policies, by the same names, that 20260918131000 put on every
-- other tracking table. A tracking table with RLS on and no policy refuses the
-- bridge's writes and returns an empty read to the stats page, silently.
do $$
declare t text := 'tracking_catch_approaches';
begin
  execute format('alter table public.%I enable row level security', t);

  execute format('drop policy if exists anon_read on public.%I', t);
  execute format('create policy anon_read on public.%I for select to anon using (true)', t);
  execute format('drop policy if exists scorebook_authenticated_read on public.%I', t);
  execute format('create policy scorebook_authenticated_read on public.%I '
                 'for select to authenticated using (true)', t);
  execute format('drop policy if exists scorebook_scorekeeper_insert on public.%I', t);
  execute format('create policy scorebook_scorekeeper_insert on public.%I '
                 'for insert to authenticated with check (current_player_has_scorebook_access())', t);
  execute format('drop policy if exists scorebook_scorekeeper_update on public.%I', t);
  execute format('create policy scorebook_scorekeeper_update on public.%I '
                 'for update to authenticated using (current_player_has_scorebook_access()) '
                 'with check (current_player_has_scorebook_access())', t);
  execute format('drop policy if exists scorebook_scorekeeper_delete on public.%I', t);
  execute format('create policy scorebook_scorekeeper_delete on public.%I '
                 'for delete to authenticated using (current_player_has_scorebook_access())', t);
  execute format('drop policy if exists commissioner_all on public.%I', t);
  execute format('create policy commissioner_all on public.%I '
                 'using (current_player_is_commissioner()) '
                 'with check (current_player_is_commissioner())', t);
end $$;

notify pgrst, 'reload schema';
