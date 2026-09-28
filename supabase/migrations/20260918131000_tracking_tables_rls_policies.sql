-- The tracking tables had row-level security on and no policies.
--
-- RLS with no policy refuses every row to every role but the service role, and
-- it refuses quietly on read: a select returns no rows, not an error. So the
-- bridge (signed in as a scorekeeper) was refused every live tracking write --
--
--   new row violates row-level security policy for table "tracking_sessions"
--
-- on every plate appearance of season game 2766 (2026-09-18), the same for
-- runner_opportunities and double_play_opportunities -- and the stats page,
-- reading as anon or as a signed-in player, saw an empty table where the
-- tracker's metrics would have been.
--
-- The policies are the ones the season scoring tables already carry, by the
-- same names: anyone may read, a scorekeeper may write, the commissioner may do
-- anything.

do $$
declare
  t text;
begin
  foreach t in array array[
    'tracking_sessions', 'tracking_plays', 'tracking_throws', 'movement_metrics',
    'runner_opportunities', 'double_play_opportunities', 'fielding_opportunities'
  ] loop
    if to_regclass(format('public.%I', t)) is null then
      continue;
    end if;
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
  end loop;
end
$$;
