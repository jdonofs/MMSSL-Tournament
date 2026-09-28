-- Alternate-line prices used to be accepted from the browser as long as they
-- fell inside the global American-odds bounds.  Price every alternate from
-- persisted market inputs instead, bind prop bets to the board target, and
-- hold share locks on the game/odds rows until placement commits.

begin;
alter table public.game_odds
  add column if not exists prop_current_count numeric;
alter table public.season_game_odds
  add column if not exists prop_current_count numeric;
create or replace function public._bet_american_odds_from_probability(p_probability numeric)
returns integer
language plpgsql
immutable
set search_path = public
as $$
declare
  v_fair_probability numeric;
  v_odds_multiplier numeric := (2::numeric / 1.07::numeric) - 1::numeric;
  v_vig_probability numeric;
  v_decimal_odds numeric;
  v_raw_odds numeric;
  v_integer_odds integer;
  v_abs_odds integer;
  v_rounded_abs integer;
begin
  v_fair_probability := least(greatest(coalesce(p_probability, 0), 0.002), 0.998);
  v_vig_probability := 1::numeric / (
    1::numeric + (((1::numeric / v_fair_probability) - 1::numeric) * v_odds_multiplier)
  );
  v_vig_probability := least(greatest(v_vig_probability, 0.002), 0.998);
  v_decimal_odds := least(greatest(1::numeric / v_vig_probability, 1.01), 1000);

  if v_decimal_odds >= 2 then
    v_raw_odds := (v_decimal_odds - 1::numeric) * 100::numeric;
  else
    v_raw_odds := -100::numeric / (v_decimal_odds - 1::numeric);
  end if;

  -- Math.round semantics, including negative half values.
  v_integer_odds := floor(v_raw_odds + 0.5)::integer;
  v_abs_odds := abs(v_integer_odds);
  v_rounded_abs := case
    when v_abs_odds >= 5000 then floor((v_abs_odds::numeric / 500) + 0.5)::integer * 500
    when v_abs_odds >= 1000 then floor((v_abs_odds::numeric / 100) + 0.5)::integer * 100
    when v_abs_odds >= 200 then floor((v_abs_odds::numeric / 5) + 0.5)::integer * 5
    else v_abs_odds
  end;

  v_integer_odds := case when v_integer_odds < 0 then -v_rounded_abs else v_rounded_abs end;
  return least(greatest(v_integer_odds, -10000), 99900);
end;
$$;
create or replace function public._bet_alt_pricing_context(
  p_context text,
  p_source_id integer,
  p_game_id integer,
  p_bet_type text
)
returns table (
  home_is_favorite boolean,
  margin_stddev numeric,
  total_variance numeric,
  total_scoring numeric
)
language plpgsql
stable
set search_path = public
as $$
declare
  v_home_is_favorite boolean := true;
  v_margin_stddev numeric := 2.5;
  v_stadium_id uuid;
  v_stadium_name text;
  v_is_night boolean := false;
  v_chaos numeric := 0;
  v_log_count integer := 0;
  v_avg_runs numeric := 4.9;
  v_historical_weight numeric := 0;
  v_formula_scoring numeric := 1;
  v_total_variance numeric := 1;
  v_total_scoring numeric := 1;
begin
  if p_context not in ('season', 'tournament') then
    raise exception 'Unknown betting context.';
  end if;

  if p_bet_type = 'run_line' then
    if p_context = 'season' then
      select coalesce(go.predicted_probability, 0.5) >= 0.5
      into v_home_is_favorite
      from public.season_game_odds as go
      where go.game_id = p_game_id
        and go.bet_type = 'moneyline'
      order by go.updated_at desc, go.id desc
      limit 1;

      select stddev_pop(abs(coalesce(g.home_score, 0) - coalesce(g.away_score, 0)))
      into v_margin_stddev
      from public.season_schedule as g
      where g.status = 'complete';
    else
      select coalesce(go.predicted_probability, 0.5) >= 0.5
      into v_home_is_favorite
      from public.game_odds as go
      where go.game_id = p_game_id
        and go.bet_type = 'moneyline'
      order by go.updated_at desc, go.id desc
      limit 1;

      select stddev_pop(abs(coalesce(g.team_b_runs, 0) - coalesce(g.team_a_runs, 0)))
      into v_margin_stddev
      from public.games as g
      where g.status = 'complete';
    end if;

    v_home_is_favorite := coalesce(v_home_is_favorite, true);
    v_margin_stddev := greatest(1.25, coalesce(nullif(v_margin_stddev, 0), 2.5));
  elsif p_bet_type = 'over_under' then
    if p_context = 'season' then
      select g.stadium, coalesce(g.is_night, false), coalesce(s.chaos_level, 0)
      into v_stadium_name, v_is_night, v_chaos
      from public.season_schedule as g
      left join public.stadiums as s on s.name = g.stadium
      where g.id = p_game_id
        and g.season_id = p_source_id;

      if v_stadium_name is not null then
        select count(*)::integer, coalesce(avg(coalesce(l.total_runs, 0)), 4.9)
        into v_log_count, v_avg_runs
        from public.season_stadium_game_log as l
        where l.season_id = p_source_id
          and l.stadium = v_stadium_name
          and coalesce(l.is_night, false) = v_is_night
          and l.game_id <> p_game_id;
      end if;
    else
      select g.stadium_id, s.name, coalesce(g.is_night, false), coalesce(s.chaos_level, 0)
      into v_stadium_id, v_stadium_name, v_is_night, v_chaos
      from public.games as g
      left join public.stadiums as s on s.id = g.stadium_id
      where g.id = p_game_id
        and g.tournament_id = p_source_id;

      if v_stadium_id is not null then
        select count(*)::integer, coalesce(avg(coalesce(l.total_runs, 0)), 4.9)
        into v_log_count, v_avg_runs
        from public.stadium_game_log as l
        where l.stadium_id = v_stadium_id
          and coalesce(l.is_night, false) = v_is_night
          and l.game_id <> p_game_id;
      end if;
    end if;

    v_formula_scoring := case v_stadium_name
      when 'Peach Ice Garden' then case when v_is_night then 1.12 else 1.05 end
      when 'DK Jungle' then case when v_is_night then 0.93 else 0.92 end
      when 'Wario City' then 1.22
      when 'Yoshi Park' then case when v_is_night then 1.25 else 1.15 end
      when 'Bowser Jr. Playroom' then 0.83
      when 'Daisy Cruiser' then case when v_is_night then 1.32 else 1.24 end
      when 'Luigi''s Mansion' then case when v_is_night then 1.14 else 1 end
      when 'Bowser Castle' then case when v_is_night then 1.04 else 1 end
      else 1
    end;
    v_historical_weight := case
      when v_log_count = 0 then 0
      when v_log_count <= 2 then 0.25
      when v_log_count <= 4 then 0.5
      else 0.75
    end;
    v_total_variance := 1 + (v_chaos * 0.08);
    v_total_scoring :=
      (v_formula_scoring * (1 - v_historical_weight))
      + ((v_avg_runs / 4.9) * v_historical_weight);
  end if;

  return query select
    v_home_is_favorite,
    v_margin_stddev,
    v_total_variance,
    v_total_scoring;
end;
$$;
create or replace function public._bet_authoritative_alt_price(
  p_bet_type text,
  p_chosen_side text,
  p_line numeric,
  p_board_line numeric,
  p_board_probability numeric,
  p_prop_lambda numeric,
  p_prop_variance_multiplier numeric,
  p_prop_current_count numeric,
  p_home_is_favorite boolean,
  p_margin_stddev numeric,
  p_total_variance numeric,
  p_total_scoring numeric
)
returns table (
  authoritative_odds integer,
  authoritative_probability numeric
)
language plpgsql
immutable
set search_path = public
as $$
declare
  v_primary_probability numeric;
  v_selected_probability numeric;
  v_steps numeric;
  v_step_size numeric;
  v_lambda numeric;
  v_target_total integer;
  v_settled_count integer;
  v_needed_remaining integer;
  v_cdf double precision := 0;
  v_term double precision;
  v_k integer;
  v_variance numeric;
begin
  if p_bet_type = 'run_line' then
    if p_chosen_side not in ('home', 'away') then return; end if;
    v_steps := (p_line - p_board_line) / 0.5;
    v_step_size := 0.2 / greatest(1.25, coalesce(p_margin_stddev, 2.5));
    v_primary_probability := coalesce(p_board_probability, 0.5)
      + (v_steps * v_step_size * case when coalesce(p_home_is_favorite, true) then -1 else 1 end);
    v_primary_probability := least(greatest(v_primary_probability, 0.07), 0.93);
    v_selected_probability := case when p_chosen_side = 'home'
      then v_primary_probability else 1 - v_primary_probability end;
  elsif p_bet_type = 'over_under' then
    if p_chosen_side not in ('over', 'under') then return; end if;
    v_steps := (p_line - p_board_line) / 0.5;
    v_step_size :=
      (0.045 / greatest(0.9, coalesce(p_total_variance, 1)))
      + (greatest(0, coalesce(p_total_scoring, 1) - 1) * 0.01);
    v_primary_probability := coalesce(p_board_probability, 0.5) - (v_steps * v_step_size);
    v_primary_probability := least(greatest(v_primary_probability, 0.07), 0.93);
    v_selected_probability := case when p_chosen_side = 'over'
      then v_primary_probability else 1 - v_primary_probability end;
  elsif p_bet_type in ('hr_prop', 'hit_prop', 'k_prop') then
    if p_chosen_side not in ('over', 'under') or p_prop_lambda is null then return; end if;
    v_lambda := greatest(0.01, p_prop_lambda);
    v_target_total := greatest(0, floor(coalesce(p_line, 0.5))::integer + 1);
    v_settled_count := greatest(
      0,
      floor(coalesce(
        p_prop_current_count,
        case when p_bet_type in ('hr_prop', 'hit_prop') then floor(coalesce(p_board_line, 0)) else 0 end
      ))::integer
    );
    v_needed_remaining := v_target_total - v_settled_count;

    if v_needed_remaining <= 0 then
      v_primary_probability := 0.998;
    else
      v_term := exp(-v_lambda::double precision);
      for v_k in 0..(v_needed_remaining - 1) loop
        if v_k > 0 then
          v_term := v_term * (v_lambda::double precision / v_k::double precision);
        end if;
        v_cdf := v_cdf + v_term;
      end loop;
      v_primary_probability := least(greatest(1 - v_cdf::numeric, 0.002), 0.998);
    end if;

    v_variance := coalesce(p_prop_variance_multiplier, 1);
    if v_variance > 1 then
      v_primary_probability := 0.5 + ((v_primary_probability - 0.5) / v_variance);
      v_primary_probability := least(greatest(v_primary_probability, 0.002), 0.998);
    end if;
    v_selected_probability := case when p_chosen_side = 'over'
      then v_primary_probability else 1 - v_primary_probability end;
  else
    return;
  end if;

  return query select
    public._bet_american_odds_from_probability(v_selected_probability),
    v_selected_probability;
end;
$$;
revoke all on function public._bet_american_odds_from_probability(numeric) from public, anon, authenticated;
revoke all on function public._bet_alt_pricing_context(text, integer, integer, text) from public, anon, authenticated;
revoke all on function public._bet_authoritative_alt_price(
  text, text, numeric, numeric, numeric, numeric, numeric, numeric, boolean, numeric, numeric, numeric
) from public, anon, authenticated;
create or replace function public.place_season_bets(p_season_id integer, p_bets jsonb)
returns setof public.season_bets
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id uuid;
  v_balance numeric := 100;
  v_total_wager numeric := 0;
  v_bet jsonb;
  v_game_id integer;
  v_game_odds_id integer;
  v_bet_type text;
  v_target_entity text;
  v_chosen_side text;
  v_requested_odds integer;
  v_wager numeric;
  v_line numeric;
  v_payout numeric;
  v_board public.season_game_odds%rowtype;
  v_final_odds integer;
  v_final_line numeric;
  v_final_probability numeric;
  v_home_is_favorite boolean;
  v_margin_stddev numeric;
  v_total_variance numeric;
  v_total_scoring numeric;
  v_inserted_bet public.season_bets%rowtype;
begin
  select p.id into v_player_id
  from public.players as p
  where p.auth_user_id = auth.uid();

  if v_player_id is null then raise exception 'No player is linked to the current user.'; end if;
  if p_season_id is null then raise exception 'Season id is required.'; end if;
  if p_bets is null or jsonb_typeof(p_bets) <> 'array' or jsonb_array_length(p_bets) = 0 then
    raise exception 'At least one bet is required.';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('season_bet_balance'),
    hashtext(v_player_id::text || ':' || p_season_id::text)
  );

  select
    100
    + coalesce((select sum(l.dollars_change) from public.season_betting_ledger l
                where l.season_id = p_season_id and l.player_id = v_player_id), 0)
    + coalesce((select sum(a.amount) from public.balance_awards a
                where a.season_id = p_season_id and (a.player_id is null or a.player_id = v_player_id)), 0)
    + coalesce((select sum(case when s.type = 'sell' then s.amount_dollars
                                when s.type = 'buy' then -s.amount_dollars else 0 end)
                from public.sip_transactions s
                where s.season_id = p_season_id and s.player_id = v_player_id), 0)
  into v_balance;

  for v_bet in select value from jsonb_array_elements(p_bets) loop
    v_game_id := nullif(v_bet ->> 'game_id', '')::integer;
    v_game_odds_id := nullif(v_bet ->> 'game_odds_id', '')::integer;
    v_bet_type := nullif(trim(v_bet ->> 'bet_type'), '');
    v_target_entity := nullif(trim(v_bet ->> 'target_entity'), '');
    v_chosen_side := nullif(trim(v_bet ->> 'chosen_side'), '');
    v_requested_odds := nullif(v_bet ->> 'odds', '')::integer;
    v_wager := round(nullif(v_bet ->> 'wager_dollars', '')::numeric, 2);
    v_line := nullif(v_bet ->> 'line', '')::numeric;

    if v_game_id is null or v_bet_type is null or v_chosen_side is null then
      raise exception 'Each season bet must include game_id, bet_type, and chosen_side.';
    end if;
    if v_wager is null or v_wager <= 0 or round(v_wager, 2) <> v_wager then
      raise exception 'Each season bet must have a positive wager with at most two decimal places.';
    end if;

    if v_game_odds_id is not null then
      select go.* into v_board
      from public.season_game_odds go
      join public.season_schedule g on g.id = go.game_id
      where go.id = v_game_odds_id
        and go.game_id = v_game_id
        and g.season_id = p_season_id
        and g.status in ('pending', 'scheduled', 'active', 'in_progress')
      for share of go, g;
    else
      select go.* into v_board
      from public.season_game_odds go
      join public.season_schedule g on g.id = go.game_id
      where go.game_id = v_game_id
        and go.bet_type = v_bet_type
        and ((v_target_entity is null and go.target_entity is null) or go.target_entity = v_target_entity)
        and g.season_id = p_season_id
        and g.status in ('pending', 'scheduled', 'active', 'in_progress')
      order by go.updated_at desc, go.id desc
      limit 1
      for share of go, g;
    end if;

    if not found then raise exception 'One or more selections are no longer available.'; end if;
    if v_board.is_locked then raise exception 'One or more selections are locked.'; end if;
    if v_board.bet_type <> v_bet_type then raise exception 'Selection does not match the requested market.'; end if;
    if v_target_entity is distinct from v_board.target_entity then
      raise exception 'Selection does not match the requested market target.';
    end if;

    if v_line is not distinct from v_board.line then
      v_final_odds := public._bet_board_odds_for_side(
        v_bet_type, v_chosen_side,
        v_board.odds_home, v_board.odds_away,
        v_board.odds_over, v_board.odds_under,
        v_board.odds_yes, v_board.odds_no
      );
    else
      if not public._bet_line_within_alt_bounds(v_bet_type, v_line, v_board.line) then
        raise exception 'Selected line is outside the allowed range.';
      end if;
      select * into v_home_is_favorite, v_margin_stddev, v_total_variance, v_total_scoring
      from public._bet_alt_pricing_context('season', p_season_id, v_game_id, v_bet_type);
      select p.authoritative_odds, p.authoritative_probability
      into v_final_odds, v_final_probability
      from public._bet_authoritative_alt_price(
        v_bet_type, v_chosen_side, v_line, v_board.line, v_board.predicted_probability,
        v_board.prop_lambda, v_board.prop_variance_multiplier, v_board.prop_current_count,
        v_home_is_favorite, v_margin_stddev, v_total_variance, v_total_scoring
      ) p;
    end if;

    if v_final_odds is null then raise exception 'Selected side has no live odds.'; end if;
    if v_requested_odds is distinct from v_final_odds then
      raise exception 'Selection price changed; refresh and try again.';
    end if;
    v_total_wager := v_total_wager + v_wager;
  end loop;

  if v_total_wager > v_balance then raise exception 'Insufficient balance'; end if;

  for v_bet in select value from jsonb_array_elements(p_bets) loop
    v_game_id := nullif(v_bet ->> 'game_id', '')::integer;
    v_game_odds_id := nullif(v_bet ->> 'game_odds_id', '')::integer;
    v_bet_type := nullif(trim(v_bet ->> 'bet_type'), '');
    v_target_entity := nullif(trim(v_bet ->> 'target_entity'), '');
    v_chosen_side := nullif(trim(v_bet ->> 'chosen_side'), '');
    v_wager := round(nullif(v_bet ->> 'wager_dollars', '')::numeric, 2);
    v_line := nullif(v_bet ->> 'line', '')::numeric;

    if v_game_odds_id is not null then
      select go.* into v_board from public.season_game_odds go
      where go.id = v_game_odds_id and go.game_id = v_game_id;
    else
      select go.* into v_board from public.season_game_odds go
      where go.game_id = v_game_id
        and go.bet_type = v_bet_type
        and ((v_target_entity is null and go.target_entity is null) or go.target_entity = v_target_entity)
      order by go.updated_at desc, go.id desc
      limit 1;
    end if;

    if v_line is not distinct from v_board.line then
      v_final_odds := public._bet_board_odds_for_side(
        v_bet_type, v_chosen_side,
        v_board.odds_home, v_board.odds_away,
        v_board.odds_over, v_board.odds_under,
        v_board.odds_yes, v_board.odds_no
      );
      v_final_line := v_board.line;
      v_final_probability := coalesce(
        public._bet_board_probability_for_side(v_bet_type, v_chosen_side, v_board.predicted_probability), 0.5
      );
    else
      select * into v_home_is_favorite, v_margin_stddev, v_total_variance, v_total_scoring
      from public._bet_alt_pricing_context('season', p_season_id, v_game_id, v_bet_type);
      select p.authoritative_odds, p.authoritative_probability
      into v_final_odds, v_final_probability
      from public._bet_authoritative_alt_price(
        v_bet_type, v_chosen_side, v_line, v_board.line, v_board.predicted_probability,
        v_board.prop_lambda, v_board.prop_variance_multiplier, v_board.prop_current_count,
        v_home_is_favorite, v_margin_stddev, v_total_variance, v_total_scoring
      ) p;
      v_final_line := v_line;
    end if;

    v_payout := round(case when v_final_odds > 0
      then v_wager * (v_final_odds::numeric / 100)
      else v_wager * (100::numeric / abs(v_final_odds)::numeric) end, 2);

    insert into public.season_bets (
      season_id, player_id, game_id, bet_type, target_entity, chosen_side,
      odds, predicted_probability, wager_dollars, potential_payout_dollars,
      status, line, placed_at
    ) values (
      p_season_id, v_player_id, v_game_id, v_bet_type, v_board.target_entity, v_chosen_side,
      v_final_odds, v_final_probability, v_wager, v_payout,
      'open', v_final_line, now()
    ) returning * into v_inserted_bet;

    insert into public.season_betting_ledger (
      player_id, season_id, game_id, bet_id, dollars_change, reason
    ) values (
      v_player_id, p_season_id, v_game_id, v_inserted_bet.id, -v_wager,
      format('bet_placed:%s:%s', v_bet_type, v_chosen_side)
    );

    return next v_inserted_bet;
  end loop;
  return;
end;
$$;
create or replace function public.place_tournament_bets(p_tournament_id integer, p_bets jsonb)
returns setof public.bets
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id uuid;
  v_balance numeric := 100;
  v_total_wager numeric := 0;
  v_bet jsonb;
  v_game_id integer;
  v_game_odds_id integer;
  v_bet_type text;
  v_target_entity text;
  v_chosen_side text;
  v_requested_odds integer;
  v_wager numeric;
  v_line numeric;
  v_payout numeric;
  v_board public.game_odds%rowtype;
  v_final_odds integer;
  v_final_line numeric;
  v_final_probability numeric;
  v_home_is_favorite boolean;
  v_margin_stddev numeric;
  v_total_variance numeric;
  v_total_scoring numeric;
  v_inserted_bet public.bets%rowtype;
begin
  select p.id into v_player_id from public.players p where p.auth_user_id = auth.uid();
  if v_player_id is null then raise exception 'No player is linked to the current user.'; end if;
  if p_tournament_id is null then raise exception 'Tournament id is required.'; end if;
  if p_bets is null or jsonb_typeof(p_bets) <> 'array' or jsonb_array_length(p_bets) = 0 then
    raise exception 'At least one bet is required.';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('tournament_bet_balance'),
    hashtext(v_player_id::text || ':' || p_tournament_id::text)
  );

  select
    100
    + coalesce((select sum(l.points_change) from public.points_ledger l
                where l.tournament_id = p_tournament_id and l.player_id = v_player_id), 0)
    + coalesce((select sum(a.amount) from public.balance_awards a
                where a.tournament_id = p_tournament_id and (a.player_id is null or a.player_id = v_player_id)), 0)
    + coalesce((select sum(case when s.type = 'sell' then s.amount_dollars
                                when s.type = 'buy' then -s.amount_dollars else 0 end)
                from public.sip_transactions s
                where s.tournament_id = p_tournament_id and s.player_id = v_player_id), 0)
  into v_balance;

  for v_bet in select value from jsonb_array_elements(p_bets) loop
    v_game_id := nullif(v_bet ->> 'game_id', '')::integer;
    v_game_odds_id := nullif(v_bet ->> 'game_odds_id', '')::integer;
    v_bet_type := nullif(trim(v_bet ->> 'bet_type'), '');
    v_target_entity := nullif(trim(v_bet ->> 'target_entity'), '');
    v_chosen_side := nullif(trim(v_bet ->> 'chosen_side'), '');
    v_requested_odds := nullif(v_bet ->> 'odds', '')::integer;
    v_wager := round(nullif(v_bet ->> 'wager_dollars', '')::numeric, 2);
    v_line := nullif(v_bet ->> 'line', '')::numeric;

    if v_game_id is null or v_game_odds_id is null or v_bet_type is null or v_chosen_side is null then
      raise exception 'Each tournament bet must include game_id, game_odds_id, bet_type, and chosen_side.';
    end if;
    if v_wager is null or v_wager <= 0 or round(v_wager, 2) <> v_wager then
      raise exception 'Each tournament bet must have a positive wager with at most two decimal places.';
    end if;

    select go.* into v_board
    from public.game_odds go
    join public.games g on g.id = go.game_id
    where go.id = v_game_odds_id
      and go.game_id = v_game_id
      and g.tournament_id = p_tournament_id
      and g.status in ('pending', 'scheduled', 'active', 'in_progress')
    for share of go, g;

    if not found then raise exception 'One or more selections are no longer available.'; end if;
    if v_board.is_locked then raise exception 'One or more selections are locked.'; end if;
    if v_board.bet_type <> v_bet_type then raise exception 'Selection does not match the requested market.'; end if;
    if v_target_entity is distinct from v_board.target_entity then
      raise exception 'Selection does not match the requested market target.';
    end if;

    if v_line is not distinct from v_board.line then
      v_final_odds := public._bet_board_odds_for_side(
        v_bet_type, v_chosen_side,
        v_board.odds_home, v_board.odds_away,
        v_board.odds_over, v_board.odds_under,
        v_board.odds_yes, v_board.odds_no
      );
    else
      if not public._bet_line_within_alt_bounds(v_bet_type, v_line, v_board.line) then
        raise exception 'Selected line is outside the allowed range.';
      end if;
      select * into v_home_is_favorite, v_margin_stddev, v_total_variance, v_total_scoring
      from public._bet_alt_pricing_context('tournament', p_tournament_id, v_game_id, v_bet_type);
      select p.authoritative_odds, p.authoritative_probability
      into v_final_odds, v_final_probability
      from public._bet_authoritative_alt_price(
        v_bet_type, v_chosen_side, v_line, v_board.line, v_board.predicted_probability,
        v_board.prop_lambda, v_board.prop_variance_multiplier, v_board.prop_current_count,
        v_home_is_favorite, v_margin_stddev, v_total_variance, v_total_scoring
      ) p;
    end if;

    if v_final_odds is null then raise exception 'Selected side has no live odds.'; end if;
    if v_requested_odds is distinct from v_final_odds then
      raise exception 'Selection price changed; refresh and try again.';
    end if;
    v_total_wager := v_total_wager + v_wager;
  end loop;

  if v_total_wager > v_balance then raise exception 'Insufficient balance'; end if;

  for v_bet in select value from jsonb_array_elements(p_bets) loop
    v_game_id := nullif(v_bet ->> 'game_id', '')::integer;
    v_game_odds_id := nullif(v_bet ->> 'game_odds_id', '')::integer;
    v_bet_type := nullif(trim(v_bet ->> 'bet_type'), '');
    v_chosen_side := nullif(trim(v_bet ->> 'chosen_side'), '');
    v_wager := round(nullif(v_bet ->> 'wager_dollars', '')::numeric, 2);
    v_line := nullif(v_bet ->> 'line', '')::numeric;

    select go.* into v_board from public.game_odds go
    where go.id = v_game_odds_id and go.game_id = v_game_id;

    if v_line is not distinct from v_board.line then
      v_final_odds := public._bet_board_odds_for_side(
        v_bet_type, v_chosen_side,
        v_board.odds_home, v_board.odds_away,
        v_board.odds_over, v_board.odds_under,
        v_board.odds_yes, v_board.odds_no
      );
      v_final_line := v_board.line;
      v_final_probability := coalesce(
        public._bet_board_probability_for_side(v_bet_type, v_chosen_side, v_board.predicted_probability), 0.5
      );
    else
      select * into v_home_is_favorite, v_margin_stddev, v_total_variance, v_total_scoring
      from public._bet_alt_pricing_context('tournament', p_tournament_id, v_game_id, v_bet_type);
      select p.authoritative_odds, p.authoritative_probability
      into v_final_odds, v_final_probability
      from public._bet_authoritative_alt_price(
        v_bet_type, v_chosen_side, v_line, v_board.line, v_board.predicted_probability,
        v_board.prop_lambda, v_board.prop_variance_multiplier, v_board.prop_current_count,
        v_home_is_favorite, v_margin_stddev, v_total_variance, v_total_scoring
      ) p;
      v_final_line := v_line;
    end if;

    v_payout := round(case when v_final_odds > 0
      then v_wager * (v_final_odds::numeric / 100)
      else v_wager * (100::numeric / abs(v_final_odds)::numeric) end, 2);

    insert into public.bets (
      game_id, player_id, game_odds_id, bet_type, target_entity, chosen_side,
      odds, predicted_probability, wager_type, wager_dollars,
      potential_payout_dollars, line, status, placed_at
    ) values (
      v_game_id, v_player_id, v_game_odds_id, v_bet_type, v_board.target_entity, v_chosen_side,
      v_final_odds, v_final_probability, 'dollars', v_wager,
      v_payout, v_final_line, 'open', now()
    ) returning * into v_inserted_bet;

    insert into public.points_ledger (
      player_id, tournament_id, game_id, bet_id, points_change, reason
    ) values (
      v_player_id, p_tournament_id, v_game_id, v_inserted_bet.id, -v_wager,
      format('bet_placed:%s:%s', v_bet_type, v_chosen_side)
    );

    return next v_inserted_bet;
  end loop;
  return;
end;
$$;
commit;
