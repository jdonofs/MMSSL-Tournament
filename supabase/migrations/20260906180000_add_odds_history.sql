-- Durable odds history for the betting board.
--
-- `game_odds` / `season_game_odds` are mutated in place by every reprice, so no
-- prior value of any market survives anywhere: `updated_at` is overwritten and
-- `odds_calibration_log` only records the price a *ticket* was graded at. These
-- two append-only tables give the market itself a history.
--
-- Design notes
--
-- * One row per *meaningful change*. The recorder
--   (`scripts/tracker_betting_sync.mjs`) already compares the newly priced
--   market against the stored one field by field before it writes; a snapshot
--   is appended only when that comparison says something moved.
--
-- * Duplicate suppression is structural rather than time-based. Each row names
--   the observation it followed (`previous_observation_id`), and the unique
--   index below allows at most one successor per predecessor per market. Two
--   concurrent writers that both read the same latest observation therefore
--   produce the same key and only one lands; a retry after a successful write
--   sees the newer predecessor and is suppressed by the recorder's own
--   change check. A market that legitimately returns to an earlier price later
--   has a different predecessor, so genuine history is never collapsed.
--   `coalesce(previous_observation_id, 0)` also makes "the first observation of
--   this market" unique, which is what stops a repeated first sync from
--   inserting two openers.
--
-- * `observed_at` is when this recorder saw the value. It is NOT the market's
--   opening time: markets priced before this table existed have no history at
--   all, and the first row for such a market is the first *recorded*
--   observation. Consumers must say so rather than calling it an open.
--
-- * The game context columns are the score/inning as of the observation, copied
--   from the same game row the pricing used. They describe the observation, not
--   any ticket.
--
-- Contains no account, balance or ledger information: this is public market
-- data for signed-in users. Writes are limited to the accounts that already
-- drive scoring (the tracker bridge signs in as one of them).

do $$
declare
  competition record;
  history_table text;
  odds_table text;
  games_table text;
begin
  for competition in
    select *
    from (
      values
        ('game_odds_history', 'game_odds', 'games'),
        ('season_game_odds_history', 'season_game_odds', 'season_schedule')
    ) as entries(history_table, odds_table, games_table)
  loop
    history_table := competition.history_table;
    odds_table := competition.odds_table;
    games_table := competition.games_table;

    if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = odds_table) then
      continue;
    end if;

    execute format($fmt$
      create table if not exists public.%I (
        id bigserial primary key,
        game_id int not null references public.%I(id) on delete cascade,
        game_odds_id int references public.%I(id) on delete set null,
        bet_type text not null,
        target_entity text,
        previous_observation_id bigint references public.%I(id) on delete set null,
        line numeric,
        odds_home int,
        odds_away int,
        odds_over int,
        odds_under int,
        odds_yes int,
        odds_no int,
        predicted_probability numeric(6,4),
        is_locked boolean default false,
        inning int,
        is_top_inning boolean,
        away_score int,
        home_score int,
        game_status text,
        source text not null default 'tracker_sync',
        change_key text,
        observed_at timestamptz not null default now()
      )
    $fmt$, history_table, games_table, odds_table, history_table);

    execute format(
      'create unique index if not exists %I on public.%I (game_id, bet_type, coalesce(target_entity, %L), coalesce(previous_observation_id, 0))',
      history_table || '_successor_key', history_table, ''
    );

    execute format(
      'create index if not exists %I on public.%I (game_id, bet_type, target_entity, observed_at)',
      history_table || '_market_time_idx', history_table
    );

    execute format('alter table public.%I enable row level security', history_table);

    execute format('drop policy if exists authenticated_read on public.%I', history_table);
    execute format(
      'create policy authenticated_read on public.%I for select using (auth.role() = ''authenticated'')',
      history_table
    );

    -- Only the accounts that already run scoring may append observations. The
    -- tracker bridge signs in as one of them; a plain viewer cannot manufacture
    -- history.
    execute format('drop policy if exists scorekeeper_write on public.%I', history_table);
    execute format($fmt$
      create policy scorekeeper_write on public.%I for insert
      with check (
        exists (
          select 1 from public.players p
          where p.auth_user_id = auth.uid()
            and (p.is_commissioner is true or p.scorebook_access is true)
        )
      )
    $fmt$, history_table);
  end loop;
end $$;
