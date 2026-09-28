-- Cent-rounded American-odds profit must be at least one cent.  Rounding a
-- tiny wager to $0.00 creates a ticket that can win without paying profit.

begin;
create or replace function public.reject_zero_profit_bet()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(new.wager_dollars, 0) > 0
     and coalesce(new.potential_payout_dollars, 0) < 0.01 then
    raise exception 'Wager is too small for the selected odds.';
  end if;
  return new;
end;
$$;
drop trigger if exists reject_zero_profit_bet_insert on public.bets;
create trigger reject_zero_profit_bet_insert
before insert on public.bets
for each row execute function public.reject_zero_profit_bet();
drop trigger if exists reject_zero_profit_season_bet_insert on public.season_bets;
create trigger reject_zero_profit_season_bet_insert
before insert on public.season_bets
for each row execute function public.reject_zero_profit_bet();
revoke all on function public.reject_zero_profit_bet() from public, anon, authenticated;
commit;
