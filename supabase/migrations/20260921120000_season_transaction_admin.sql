-- Commissioner-only repair for an accidental season free-agent pickup.
--
-- Free-agent pickups have no standalone transaction row. Their history is the
-- newly inserted season_roster row and the season_waivers row created for the
-- drop. Reversing therefore restores the old roster row and deletes those two
-- history rows (plus any claims) in the same database transaction.

create or replace function public.admin_reverse_season_free_agent_pickup(
  p_season_id bigint,
  p_added_roster_id bigint,
  p_waiver_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_commissioner boolean := false;
  v_added_found boolean := false;
  v_added_team_id bigint;
  v_added_character text;
  v_added_via text;
  v_added_active boolean;
  v_added_created_at timestamptz;
  v_waiver_found boolean := false;
  v_waiver_team_id bigint;
  v_dropped_character text;
  v_waiver_status text;
  v_waiver_created_at timestamptz;
  v_dropped_roster_id bigint;
  v_active_count integer;
  v_trade_reference_count integer := 0;
begin
  select coalesce(p.is_commissioner, false)
    into v_is_commissioner
    from public.players as p
   where p.auth_user_id = auth.uid();

  if not coalesce(v_is_commissioner, false) then
    raise exception using errcode = '42501', hint = 'commissioner_required',
      message = 'Only a commissioner can reverse a season transaction.';
  end if;

  if p_season_id is null or p_added_roster_id is null or p_waiver_id is null then
    raise exception using errcode = '22023', hint = 'invalid_request',
      message = 'Choose a complete free-agent transaction to reverse.';
  end if;

  select true, sr.team_id, sr.character_name, sr.acquired_via, sr.is_active, sr.created_at
    into v_added_found, v_added_team_id, v_added_character, v_added_via, v_added_active, v_added_created_at
    from public.season_roster as sr
   where sr.id = p_added_roster_id
     and sr.season_id = p_season_id
   for update;

  if not coalesce(v_added_found, false) or v_added_via is distinct from 'free_agent' then
    raise exception using errcode = 'P0001', hint = 'not_free_agent_pickup',
      message = 'That free-agent pickup no longer exists.';
  end if;

  perform pg_advisory_xact_lock(hashtext('season_transaction_admin:team'), v_added_team_id::integer);

  select true, w.source_team_id, w.claiming_character, w.status, w.created_at
    into v_waiver_found, v_waiver_team_id, v_dropped_character, v_waiver_status, v_waiver_created_at
    from public.season_waivers as w
   where w.id = p_waiver_id
     and w.season_id = p_season_id
   for update;

  if not coalesce(v_waiver_found, false)
     or v_waiver_team_id is distinct from v_added_team_id
     or abs(extract(epoch from (v_waiver_created_at - v_added_created_at))) > 300 then
    raise exception using errcode = 'P0001', hint = 'transaction_mismatch',
      message = 'The pickup and drop records do not belong to the same transaction.';
  end if;

  if v_added_active is not distinct from false then
    raise exception using errcode = 'P0001', hint = 'pickup_moved',
      message = format('%s has moved again since this pickup, so it cannot be reversed automatically.', v_added_character);
  end if;

  if v_waiver_status is distinct from 'active' then
    raise exception using errcode = 'P0001', hint = 'waiver_resolved',
      message = format('%s has already moved through waivers, so this pickup cannot be reversed automatically.', v_dropped_character);
  end if;

  select sr.id
    into v_dropped_roster_id
    from public.season_roster as sr
   where sr.season_id = p_season_id
     and sr.team_id = v_added_team_id
     and sr.character_name = v_dropped_character
     and sr.is_active is not distinct from false
     and sr.created_at <= v_waiver_created_at
   order by sr.created_at desc, sr.id desc
   limit 1
   for update;

  if v_dropped_roster_id is null then
    raise exception using errcode = 'P0001', hint = 'original_roster_row_missing',
      message = format('The original inactive roster row for %s could not be found.', v_dropped_character);
  end if;

  if exists (
       select 1 from public.season_roster as sr
        where sr.season_id = p_season_id
          and sr.character_name = v_dropped_character
          and sr.is_active is distinct from false) then
    raise exception using errcode = 'P0001', hint = 'dropped_player_moved',
      message = format('%s is already active on a roster, so the pickup cannot be reversed.', v_dropped_character);
  end if;

  -- A pending or historical trade move can hold a foreign key to this roster
  -- row. Refuse with a useful message instead of relying on a delete failure.
  if to_regclass('public.season_trade_proposal_moves') is not null then
    execute 'select count(*) from public.season_trade_proposal_moves where roster_id = $1'
      into v_trade_reference_count using p_added_roster_id;
  end if;
  if v_trade_reference_count > 0 then
    raise exception using errcode = 'P0001', hint = 'pickup_used_in_trade',
      message = format('%s is referenced by a trade and cannot be removed automatically.', v_added_character);
  end if;

  select count(*) into v_active_count
    from public.season_roster as sr
   where sr.season_id = p_season_id
     and sr.team_id = v_added_team_id
     and sr.is_active is distinct from false;

  if v_active_count <> 9 then
    raise exception using errcode = 'P0001', hint = 'roster_changed',
      message = format('The team has %s active players instead of 9. Repair the roster before reversing history.', v_active_count);
  end if;

  if to_regclass('public.season_waiver_claims') is not null then
    execute 'delete from public.season_waiver_claims where waiver_id = $1' using p_waiver_id;
  end if;

  delete from public.season_waivers where id = p_waiver_id;
  delete from public.season_roster where id = p_added_roster_id;
  update public.season_roster set is_active = true where id = v_dropped_roster_id;

  select count(*) into v_active_count
    from public.season_roster as sr
   where sr.season_id = p_season_id
     and sr.team_id = v_added_team_id
     and sr.is_active is distinct from false;

  if v_active_count <> 9 then
    raise exception using errcode = 'P0001', hint = 'roster_changed',
      message = 'The reversal did not leave exactly 9 active players, so nothing was changed.';
  end if;

  return jsonb_build_object(
    'status', 'reversed',
    'team_id', v_added_team_id,
    'removed_character', v_added_character,
    'restored_character', v_dropped_character
  );
end;
$$;
revoke all on function public.admin_reverse_season_free_agent_pickup(bigint, bigint, bigint) from public;
revoke all on function public.admin_reverse_season_free_agent_pickup(bigint, bigint, bigint) from anon;
grant execute on function public.admin_reverse_season_free_agent_pickup(bigint, bigint, bigint) to authenticated;
