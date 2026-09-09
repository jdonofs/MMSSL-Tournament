-- A database-backed lease on a tracker game.
--
-- WHAT THE LOCAL LOCK CANNOT DO. `mss-tracker-<type>-<id>.lock` in the system
-- temp directory keeps two bridges on ONE machine off the same game, and that
-- is all it can ever do: a second laptop signed into the same Supabase project
-- sees no lock file and writes the same plate appearances into the same game.
-- docs/tracker-persistence-reliability.md lists this as the missing guarantee.
--
-- THE FENCING TOKEN IS THE POINT. Expiry alone is not exclusion: a bridge that
-- was paused past its expiry, had the lease taken from it, and then woke up
-- would carry on writing believing it still owned the game. Every ownership
-- change bumps `epoch`, every writer passes the epoch it thinks it holds, and
-- a write from a stale owner is refused by the database rather than by the
-- owner's own good behaviour.
--
-- Ids are not foreign keys: `game_id` addresses a row in `games` OR in
-- `season_schedule`, which number their rows independently -- so the pair
-- (competition_type, game_id) is the identity and neither table can carry the
-- reference.

create extension if not exists pgcrypto;

create table if not exists tracker_game_leases (
  id uuid primary key default gen_random_uuid(),
  competition_type text not null check (competition_type in ('tournament', 'season')),
  game_id bigint not null,
  owner_id text not null,
  owner_host text,
  owner_pid integer,
  owner_label text,
  -- Monotonic per (competition_type, game_id). Never reused, never reset.
  epoch bigint not null default 1,
  acquired_at timestamptz not null default now(),
  renewed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  released_at timestamptz,
  constraint tracker_game_leases_identity unique (competition_type, game_id)
);

create index if not exists tracker_game_leases_expiry_idx
  on tracker_game_leases (expires_at);

alter table tracker_game_leases disable row level security;

-- Acquire, renew, or take over. One function, because "may I have this" and
-- "I still have this" differ only in whether the caller is already the owner,
-- and splitting them meant two places that could disagree about expiry.
--
-- p_takeover is a DELIBERATE transfer: an operator moving a game to another
-- machine while the first bridge is still alive. It is never the default,
-- because the ordinary reason a lease is held is that a game is being played.
create or replace function tracker_lease_acquire(
  p_competition_type text,
  p_game_id bigint,
  p_owner_id text,
  p_ttl_seconds integer default 90,
  p_owner_host text default null,
  p_owner_pid integer default null,
  p_owner_label text default null,
  p_takeover boolean default false
) returns jsonb
language plpgsql
as $fn$
declare
  current_lease tracker_game_leases;
  next_epoch bigint;
  result tracker_game_leases;
begin
  if p_owner_id is null or length(trim(p_owner_id)) = 0 then
    raise exception 'a lease owner id is required';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds <= 0 then
    raise exception 'a lease needs a positive ttl';
  end if;

  -- FOR UPDATE, so two bridges asking at the same instant are serialized by
  -- the database instead of both reading "free" and both writing.
  select * into current_lease from tracker_game_leases
   where competition_type = p_competition_type and game_id = p_game_id
   for update;

  if current_lease.id is null then
    insert into tracker_game_leases (
      competition_type, game_id, owner_id, owner_host, owner_pid, owner_label,
      epoch, expires_at
    ) values (
      p_competition_type, p_game_id, p_owner_id, p_owner_host, p_owner_pid, p_owner_label,
      1, now() + make_interval(secs => p_ttl_seconds)
    ) returning * into result;
    return jsonb_build_object('granted', true, 'reason', 'acquired',
                              'lease', to_jsonb(result));
  end if;

  if current_lease.owner_id = p_owner_id and current_lease.released_at is null then
    update tracker_game_leases
       set renewed_at = now(),
           expires_at = now() + make_interval(secs => p_ttl_seconds),
           owner_host = coalesce(p_owner_host, owner_host),
           owner_pid = coalesce(p_owner_pid, owner_pid),
           owner_label = coalesce(p_owner_label, owner_label)
     where id = current_lease.id
     returning * into result;
    return jsonb_build_object('granted', true, 'reason', 'renewed',
                              'lease', to_jsonb(result));
  end if;

  if current_lease.released_at is null
     and current_lease.expires_at > now()
     and not coalesce(p_takeover, false) then
    return jsonb_build_object(
      'granted', false,
      'reason', 'held',
      'lease', to_jsonb(current_lease));
  end if;

  -- Every change of hands is a new epoch, so anything still holding the old
  -- one is now provably stale.
  next_epoch := current_lease.epoch + 1;
  update tracker_game_leases
     set owner_id = p_owner_id,
         owner_host = p_owner_host,
         owner_pid = p_owner_pid,
         owner_label = p_owner_label,
         epoch = next_epoch,
         acquired_at = now(),
         renewed_at = now(),
         expires_at = now() + make_interval(secs => p_ttl_seconds),
         released_at = null
   where id = current_lease.id
   returning * into result;
  return jsonb_build_object(
    'granted', true,
    'reason', case when coalesce(p_takeover, false) and current_lease.expires_at > now()
                   then 'taken_over' else 'reclaimed_expired' end,
    'previous_owner', current_lease.owner_id,
    'lease', to_jsonb(result));
end
$fn$;

-- Renewal is not acquisition: it refuses rather than taking the game back, so
-- a bridge that lost its lease learns that it lost it.
create or replace function tracker_lease_renew(
  p_competition_type text,
  p_game_id bigint,
  p_owner_id text,
  p_epoch bigint,
  p_ttl_seconds integer default 90
) returns jsonb
language plpgsql
as $fn$
declare
  result tracker_game_leases;
begin
  update tracker_game_leases
     set renewed_at = now(),
         expires_at = now() + make_interval(secs => p_ttl_seconds)
   where competition_type = p_competition_type
     and game_id = p_game_id
     and owner_id = p_owner_id
     and epoch = p_epoch
     and released_at is null
   returning * into result;
  if result.id is null then
    return jsonb_build_object('granted', false, 'reason', 'not_the_owner',
                              'lease', (select to_jsonb(l) from tracker_game_leases l
                                         where l.competition_type = p_competition_type
                                           and l.game_id = p_game_id));
  end if;
  return jsonb_build_object('granted', true, 'reason', 'renewed', 'lease', to_jsonb(result));
end
$fn$;

create or replace function tracker_lease_release(
  p_competition_type text,
  p_game_id bigint,
  p_owner_id text,
  p_epoch bigint
) returns jsonb
language plpgsql
as $fn$
declare
  result tracker_game_leases;
begin
  update tracker_game_leases
     set released_at = now(),
         expires_at = least(expires_at, now())
   where competition_type = p_competition_type
     and game_id = p_game_id
     and owner_id = p_owner_id
     and epoch = p_epoch
     and released_at is null
   returning * into result;
  return jsonb_build_object('released', result.id is not null,
                            'lease', to_jsonb(result));
end
$fn$;

-- Raises rather than returns: it is called from inside the write functions,
-- where "false" would have to be checked by every caller and one that forgot
-- would write anyway.
--
-- A NULL OWNER IS NOT A FREE PASS ANY MORE. It used to `return` -- "an unleased
-- caller (a backfill, a repair script) is allowed" -- and that one line turned
-- losing a lease into DISABLING fencing: a bridge whose renewal was refused set
-- held = false, its writeCredentials() then produced a null owner, and a null
-- owner arrived here indistinguishable from a repair script. The caller now has
-- to NAME its reason for writing without a lease (p_unleased_intent), which a
-- repair route states deliberately and a losing tracker has no way to produce.
--
-- THE ROW IS LOCKED, NOT MERELY READ. Without `for update` this check and the
-- write that follows it were two separate reads of a row another transaction
-- could take between them: tracker_lease_acquire's own `for update` had nothing
-- to wait on, so a takeover could commit between the assert and the insert and
-- the write would land under an epoch that was already stale. Locking here
-- holds the lease row for the rest of the writing transaction, so a concurrent
-- takeover blocks until that write commits or rolls back, and every write after
-- it carries an epoch the database refuses.
drop function if exists tracker_lease_assert(text, bigint, text, bigint);
create or replace function tracker_lease_assert(
  p_competition_type text,
  p_game_id bigint,
  p_owner_id text,
  p_epoch bigint,
  p_unleased_intent text default null
) returns void
language plpgsql
as $fn$
declare
  current_lease tracker_game_leases;
begin
  select * into current_lease from tracker_game_leases
   where competition_type = p_competition_type and game_id = p_game_id
   for update;

  if p_owner_id is null then
    if p_unleased_intent is null or length(trim(p_unleased_intent)) = 0 then
      raise exception 'unleased tracker write refused for % game %: a caller with no lease '
                      'has to name why (repair, backfill, a database with no lease '
                      'functions). A tracker that lost its lease is not one of those.',
        p_competition_type, p_game_id
        using errcode = 'check_violation';
    end if;
    -- Stated and allowed. Deliberately still logged into the row's history by
    -- the caller's own logs rather than silently permitted.
    return;
  end if;

  if current_lease.id is null then
    raise exception 'no tracker lease exists for % game %', p_competition_type, p_game_id
      using errcode = 'check_violation';
  end if;
  if current_lease.owner_id is distinct from p_owner_id
     or current_lease.epoch is distinct from p_epoch
     or current_lease.released_at is not null then
    raise exception 'stale tracker lease: % epoch % is not the owner of % game % (owner % epoch %)',
      p_owner_id, p_epoch, p_competition_type, p_game_id,
      current_lease.owner_id, current_lease.epoch
      using errcode = 'check_violation';
  end if;
  -- An expired lease is refused even when nobody else has taken it. The point
  -- of a lease is that its holder keeps proving it is alive.
  if current_lease.expires_at <= now() then
    raise exception 'expired tracker lease: % held % game % until %',
      p_owner_id, p_competition_type, p_game_id, current_lease.expires_at
      using errcode = 'check_violation';
  end if;
end
$fn$;
