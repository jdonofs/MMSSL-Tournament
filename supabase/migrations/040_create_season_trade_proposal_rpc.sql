create or replace function public.create_season_trade_proposal(
  p_season_id integer,
  p_created_by_team_id integer,
  p_participant_team_ids integer[],
  p_moves jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id uuid;
  v_participant_team_ids integer[];
  v_proposal_id bigint;
  v_move jsonb;
  v_roster_id integer;
  v_from_team_id integer;
  v_to_team_id integer;
  v_character_name text;
  v_active_count integer;
  v_outgoing_count integer;
  v_incoming_count integer;
  v_team_id integer;
begin
  select p.id
  into v_player_id
  from public.players as p
  where p.auth_user_id = auth.uid();

  if v_player_id is null then
    raise exception 'No player is linked to the current user.';
  end if;

  if p_season_id is null then
    raise exception 'Season id is required.';
  end if;

  if p_created_by_team_id is null then
    raise exception 'Creating team id is required.';
  end if;

  select coalesce(array_agg(distinct team_id order by team_id), '{}'::integer[])
  into v_participant_team_ids
  from unnest(coalesce(p_participant_team_ids, '{}'::integer[])) as team_id
  where team_id is not null;

  if coalesce(array_length(v_participant_team_ids, 1), 0) < 2 then
    raise exception 'At least two teams must be included in a trade proposal.';
  end if;

  if not (p_created_by_team_id = any(v_participant_team_ids)) then
    raise exception 'The proposing team must be included in the trade.';
  end if;

  if not exists (
    select 1
    from public.season_teams as st
    where st.id = p_created_by_team_id
      and st.season_id = p_season_id
      and st.player_id = v_player_id
  ) then
    raise exception 'You can only propose trades for your own season team.';
  end if;

  if exists (
    select 1
    from unnest(v_participant_team_ids) as team_id
    where not exists (
      select 1
      from public.season_teams as st
      where st.id = team_id
        and st.season_id = p_season_id
    )
  ) then
    raise exception 'Every participant team must belong to the selected season.';
  end if;

  if p_moves is null then
    raise exception 'At least one player move is required.';
  end if;

  if jsonb_typeof(p_moves) <> 'array' then
    raise exception 'Trade moves must be provided as an array.';
  end if;

  if jsonb_array_length(p_moves) = 0 then
    raise exception 'At least one player move is required.';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_moves) as move(roster_id integer, from_team_id integer, to_team_id integer)
    group by move.roster_id
    having count(*) > 1
  ) then
    raise exception 'A player cannot appear more than once in the same trade proposal.';
  end if;

  for v_team_id in select unnest(v_participant_team_ids)
  loop
    select count(*)
    into v_active_count
    from public.season_roster as sr
    where sr.season_id = p_season_id
      and sr.team_id = v_team_id
      and sr.is_active is distinct from false;

    select count(*)
    into v_outgoing_count
    from jsonb_to_recordset(p_moves) as move(roster_id integer, from_team_id integer, to_team_id integer)
    where move.from_team_id = v_team_id;

    select count(*)
    into v_incoming_count
    from jsonb_to_recordset(p_moves) as move(roster_id integer, from_team_id integer, to_team_id integer)
    where move.to_team_id = v_team_id;

    if v_active_count - v_outgoing_count + v_incoming_count <> 9 then
      raise exception 'Each team must finish the trade with 9 active players.';
    end if;
  end loop;

  insert into public.season_trade_proposals (
    season_id,
    created_by_player_id,
    created_by_team_id,
    status
  )
  values (
    p_season_id,
    v_player_id,
    p_created_by_team_id,
    'pending'
  )
  returning id into v_proposal_id;

  insert into public.season_trade_proposal_teams (
    season_id,
    proposal_id,
    team_id,
    decision_status,
    decided_at
  )
  select
    p_season_id,
    v_proposal_id,
    team_id,
    case
      when team_id = p_created_by_team_id then 'accepted'
      else 'pending'
    end,
    case
      when team_id = p_created_by_team_id then now()
      else null
    end
  from unnest(v_participant_team_ids) as team_id;

  for v_move in
    select value
    from jsonb_array_elements(p_moves)
  loop
    v_roster_id := nullif(v_move ->> 'roster_id', '')::integer;
    v_from_team_id := nullif(v_move ->> 'from_team_id', '')::integer;
    v_to_team_id := nullif(v_move ->> 'to_team_id', '')::integer;

    if v_roster_id is null or v_from_team_id is null or v_to_team_id is null then
      raise exception 'Each move must include roster_id, from_team_id, and to_team_id.';
    end if;

    if v_from_team_id = v_to_team_id then
      raise exception 'A traded player must move to a different team.';
    end if;

    if not (v_from_team_id = any(v_participant_team_ids)) or not (v_to_team_id = any(v_participant_team_ids)) then
      raise exception 'Every move must stay within the participating teams.';
    end if;

    select sr.character_name
    into v_character_name
    from public.season_roster as sr
    where sr.id = v_roster_id
      and sr.season_id = p_season_id
      and sr.team_id = v_from_team_id
      and sr.is_active is distinct from false;

    if v_character_name is null then
      raise exception 'Trade move roster entry % was not found on the expected active roster.', v_roster_id;
    end if;

    insert into public.season_trade_proposal_moves (
      season_id,
      proposal_id,
      roster_id,
      character_name,
      from_team_id,
      to_team_id
    )
    values (
      p_season_id,
      v_proposal_id,
      v_roster_id,
      v_character_name,
      v_from_team_id,
      v_to_team_id
    );
  end loop;

  return v_proposal_id;
end;
$$;

revoke all on function public.create_season_trade_proposal(integer, integer, integer[], jsonb) from public;
grant execute on function public.create_season_trade_proposal(integer, integer, integer[], jsonb) to authenticated;
