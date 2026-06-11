-- Allow the player who owes a sip to confirm they've taken it.

alter table public.sip_redemptions add column if not exists taken boolean not null default false;
alter table public.sip_redemptions add column if not exists taken_at timestamptz;

drop policy if exists to_player_confirm_sip_redemptions on public.sip_redemptions;
create policy to_player_confirm_sip_redemptions on public.sip_redemptions
  for update
  using (to_player_id = public.current_player_id())
  with check (to_player_id = public.current_player_id());
