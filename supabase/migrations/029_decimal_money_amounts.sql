do $$
declare
  target record;
begin
  for target in
    select *
    from (
      values
        ('public', 'bets', 'wager_dollars'),
        ('public', 'bets', 'potential_payout_dollars'),
        ('public', 'season_bets', 'wager_dollars'),
        ('public', 'season_bets', 'potential_payout_dollars'),
        ('public', 'points_ledger', 'points_change'),
        ('public', 'season_betting_ledger', 'dollars_change'),
        ('public', 'game_settlements', 'dollars'),
        ('public', 'season_game_settlements', 'dollars'),
        ('public', 'sip_transactions', 'amount_dollars'),
        ('public', 'balance_awards', 'amount')
    ) as entries(table_schema, table_name, column_name)
  loop
    if exists (
      select 1
      from information_schema.columns
      where table_schema = target.table_schema
        and table_name = target.table_name
        and column_name = target.column_name
    ) then
      execute format(
        'alter table %I.%I alter column %I type numeric(12,2) using round((%I)::numeric, 2)',
        target.table_schema,
        target.table_name,
        target.column_name,
        target.column_name
      );
    end if;
  end loop;
end $$;
