
-- A season free-agent pickup as one transaction.
--
-- WHAT WAS WRONG. SeasonRoster.jsx made a pickup in three PostgREST requests --
-- insert the new season_roster row, deactivate the dropped row, insert the
-- season_waivers row -- and returned on the first failure with the earlier
-- writes committed. A failed drop left the team with ten active players; a
-- failed waiver insert left the swap applied with the dropped player on no
-- waiver. The nine-player check read the page's cached roster, so two tabs, or
-- two teams after the same free agent, could each pass it.
--
-- WHAT THIS DOES. Every rule the page applied is checked again here, after the
-- locks, against rows read inside the transaction, and the three writes commit
-- together or not at all. The page keeps no fallback to the three requests: a
-- database without this function gets an error naming this file.
--
-- LOCKS. pg_advisory_xact_lock, as 076 uses for scorebook appends. One key per
-- team, so two pickups by the same team run one after the other; then one key
-- per (season, character), so two teams claiming the same free agent do too.
-- The team key is always taken first and a call holds only one of each, so the
-- order cannot deadlock. The drop row is also taken `for update`, so a trade or
-- waiver award writing that row waits for this commit.
--
-- WHAT THE LOCKS DO NOT COVER. They bind only callers that take them.
-- resolve_season_waiver and accept_season_trade_proposal predate this function
-- and do not, so the active count is read again after the writes and the whole
-- pickup is refused if it is no longer nine. That narrows the window against an
-- award committing mid-pickup; it does not close it.
--
-- RETRIES. A request whose drop row is already inactive is refused, never
-- applied twice. When what it asked for is exactly what exists -- the added
-- player active on this team as a free-agent pickup, and a waiver on the dropped
-- player from this team -- it returns status 'already_applied', so a retry after
-- a lost response reads as the success it was.
--
-- SCHEMA THIS ASSUMES. season_roster, season_waivers, season_teams and
-- resolve_season_waiver were created outside migration history: their DDL and
-- RLS are in neither this repository nor supabase_migrations. The columns used
-- are the ones the page already reads and inserts against production, and the
-- waiver columns of migrations 036-038. Row ids are returned as the rows
-- themselves (to_jsonb), so nothing here assumes an id type. security definer,
-- as 040 is, so the function does not depend on those tables' policies.
--
-- Refusals carry a stable key in HINT (not_authenticated, not_team_owner,
-- stale_drop, captain_protected, roster_not_nine, not_free_agent, on_waivers,
-- roster_changed, ...) and a message written for the person making the pickup.

create or replace function public.season_free_agent_pickup(
  p_season_id bigint,
  p_team_id bigint,
  p_add_character text,
  p_drop_roster_id bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id uuid;
  v_team_player_id uuid;
  v_team_found boolean := false;
  v_drop_found boolean := false;
  v_drop_team_id bigint;
  v_drop_character text;
  v_drop_active boolean;
  v_captain text;
  v_active_count integer;
  v_added jsonb;
  v_dropped jsonb;
  v_waiver jsonb;
begin
  select p.id into v_player_id
    from public.players as p
   where p.auth_user_id = auth.uid();

  if v_player_id is null then
    raise exception using errcode = '42501', hint = 'not_authenticated',
      message = 'Sign in with a linked player account to make a pickup.';
  end if;

  if p_season_id is null or p_team_id is null or p_drop_roster_id is null
     or coalesce(p_add_character, '') = '' then
    raise exception using errcode = '22023', hint = 'invalid_request',
      message = 'A pickup needs a season, a team, a player to add and a player to drop.';
  end if;

  select true, st.player_id into v_team_found, v_team_player_id
    from public.season_teams as st
   where st.id = p_team_id
     and st.season_id = p_season_id;

  if not coalesce(v_team_found, false) then
    raise exception using errcode = 'P0001', hint = 'team_not_in_season',
      message = 'That team is not part of this season.';
  end if;

  if v_team_player_id is distinct from v_player_id then
    raise exception using errcode = '42501', hint = 'not_team_owner',
      message = 'You can only make pickups for your own season team.';
  end if;

  perform pg_advisory_xact_lock(hashtext('season_free_agent_pickup:team'), p_team_id::integer);
  perform pg_advisory_xact_lock(hashtext('season_free_agent_pickup:character'),
                                hashtext(p_season_id::text || ':' || p_add_character));

  select true, sr.team_id, sr.character_name, sr.is_active
    into v_drop_found, v_drop_team_id, v_drop_character, v_drop_active
    from public.season_roster as sr
   where sr.id = p_drop_roster_id
     and sr.season_id = p_season_id
     for update;

  if not coalesce(v_drop_found, false) or v_drop_team_id is distinct from p_team_id then
    raise exception using errcode = 'P0001', hint = 'stale_drop',
      message = 'That player is no longer on your active roster. Reload and choose again.';
  end if;

  -- is_active null has always counted as active (the page reads `!== false`).
  if v_drop_active is not distinct from false then
    if exists (
         select 1 from public.season_roster as sr
          where sr.season_id = p_season_id
            and sr.team_id = p_team_id
            and sr.character_name = p_add_character
            and sr.acquired_via = 'free_agent'
            and sr.is_active is distinct from false)
       and exists (
         select 1 from public.season_waivers as w
          where w.season_id = p_season_id
            and w.source_team_id = p_team_id
            and w.claiming_character = v_drop_character) then
      return jsonb_build_object('status', 'already_applied');
    end if;
    raise exception using errcode = 'P0001', hint = 'stale_drop',
      message = format('%s is no longer on your active roster. Reload and choose again.', v_drop_character);
  end if;

  -- The captain is the team's first drafted row, as the page has always read it.
  select sr.character_name into v_captain
    from public.season_roster as sr
   where sr.season_id = p_season_id
     and sr.team_id = p_team_id
     and sr.acquired_via = 'draft'
   order by sr.created_at, sr.id
   limit 1;

  if v_captain is not null and v_captain = v_drop_character then
    raise exception using errcode = 'P0001', hint = 'captain_protected',
      message = 'Your team captain cannot be dropped to free agency or waivers.';
  end if;

  select count(*) into v_active_count
    from public.season_roster as sr
   where sr.season_id = p_season_id
     and sr.team_id = p_team_id
     and sr.is_active is distinct from false;

  if v_active_count <> 9 then
    raise exception using errcode = 'P0001', hint = 'roster_not_nine',
      message = format('Your team must have exactly 9 active players before making a pickup; it has %s.', v_active_count);
  end if;

  if not exists (select 1 from public.characters as c where c.name = p_add_character) then
    raise exception using errcode = 'P0001', hint = 'unknown_character',
      message = format('%s is not a character in this league.', p_add_character);
  end if;

  if exists (
       select 1 from public.season_roster as sr
        where sr.season_id = p_season_id
          and sr.character_name = p_add_character
          and sr.is_active is distinct from false) then
    raise exception using errcode = 'P0001', hint = 'not_free_agent',
      message = format('%s is already on a roster.', p_add_character);
  end if;

  -- 'processing' is resolve_season_waiver's in-flight state; the page lists
  -- only 'active', and a waiver mid-award is not a free agent either.
  if exists (
       select 1 from public.season_waivers as w
        where w.season_id = p_season_id
          and w.claiming_character = p_add_character
          and w.status in ('active', 'processing')) then
    raise exception using errcode = 'P0001', hint = 'on_waivers',
      message = format('%s is on waivers. Submit a waiver claim instead.', p_add_character);
  end if;

  if exists (
       select 1 from public.season_waivers as w
        where w.season_id = p_season_id
          and w.claiming_character = v_drop_character
          and w.status in ('active', 'processing')) then
    raise exception using errcode = 'P0001', hint = 'duplicate_waiver',
      message = format('%s already has an open waiver.', v_drop_character);
  end if;

  insert into public.season_roster as sr (season_id, team_id, character_name, acquired_via, is_active)
  values (p_season_id, p_team_id, p_add_character, 'free_agent', true)
  returning to_jsonb(sr) into v_added;

  -- Deactivated, not deleted: the row is the dropped player's history.
  update public.season_roster as sr
     set is_active = false
   where sr.id = p_drop_roster_id
  returning to_jsonb(sr) into v_dropped;

  insert into public.season_waivers as w
    (season_id, claiming_character, source_team_id, status, denied_team_ids, expires_at)
  values
    (p_season_id, v_drop_character, p_team_id, 'active', '{}', now() + interval '7 days')
  returning to_jsonb(w) into v_waiver;

  select count(*) into v_active_count
    from public.season_roster as sr
   where sr.season_id = p_season_id
     and sr.team_id = p_team_id
     and sr.is_active is distinct from false;

  if v_active_count <> 9 then
    raise exception using errcode = 'P0001', hint = 'roster_changed',
      message = 'Your roster changed while this pickup was being saved, so nothing was saved. Reload and try again.';
  end if;

  return jsonb_build_object('status', 'applied', 'added', v_added, 'dropped', v_dropped, 'waiver', v_waiver);
end;
$$;

revoke all on function public.season_free_agent_pickup(bigint, bigint, text, bigint) from public;
revoke all on function public.season_free_agent_pickup(bigint, bigint, text, bigint) from anon;
grant execute on function public.season_free_agent_pickup(bigint, bigint, text, bigint) to authenticated;
;
