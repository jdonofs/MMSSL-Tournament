-- 045 could fail partway (e.g. its dedup delete used `<`/`=` on updated_at,
-- which is NULL-unsafe — a duplicate pair where either row has a null
-- updated_at would not get deleted, leaving the later ADD CONSTRAINT to
-- error and roll back the whole migration). If that constraint never
-- actually landed, every odds upsert with
-- onConflict: 'game_id,bet_type,target_entity' fails with "there is no
-- unique or exclusion constraint matching the ON CONFLICT specification",
-- silently breaking ALL pitcher-prop / odds syncs, not just the
-- not-yet-pitching team's. Redo the dedup with null-safe comparisons and
-- add the constraints idempotently.

delete from public.game_odds a
  using public.game_odds b
  where a.game_id = b.game_id
    and a.bet_type = b.bet_type
    and coalesce(a.target_entity, '') = coalesce(b.target_entity, '')
    and a.id <> b.id
    and (
      coalesce(a.updated_at, 'epoch'::timestamptz) < coalesce(b.updated_at, 'epoch'::timestamptz)
      or (
        coalesce(a.updated_at, 'epoch'::timestamptz) = coalesce(b.updated_at, 'epoch'::timestamptz)
        and a.id < b.id
      )
    );

delete from public.season_game_odds a
  using public.season_game_odds b
  where a.game_id = b.game_id
    and a.bet_type = b.bet_type
    and coalesce(a.target_entity, '') = coalesce(b.target_entity, '')
    and a.id <> b.id
    and (
      coalesce(a.updated_at, 'epoch'::timestamptz) < coalesce(b.updated_at, 'epoch'::timestamptz)
      or (
        coalesce(a.updated_at, 'epoch'::timestamptz) = coalesce(b.updated_at, 'epoch'::timestamptz)
        and a.id < b.id
      )
    );

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'game_odds_game_bet_entity_key'
  ) then
    alter table public.game_odds
      add constraint game_odds_game_bet_entity_key unique (game_id, bet_type, target_entity);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'season_game_odds_game_bet_entity_key'
  ) then
    alter table public.season_game_odds
      add constraint season_game_odds_game_bet_entity_key unique (game_id, bet_type, target_entity);
  end if;
end $$;
