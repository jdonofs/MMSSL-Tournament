-- tracking_sessions.status accepts every status the tracker writes.
--
-- The production check allowed recording, captured, derived, ingested,
-- quarantined and failed. The versioned ingest (20260908123000) added three
-- more that nothing ever let through:
--
--   ingesting     a replacement version while its facts are being written
--   raw_ingested  facts written, official links not yet moved
--   live          the version the bridge writes play by play during a game
--
-- so every postgame ingest failed on its first insert --
--
--   new row for relation "tracking_sessions" violates check constraint
--   "tracking_sessions_status_check"
--
-- -- and every live write would have too, once the RLS policies of
-- 20260918131000 stopped refusing them first. Season game 2766 (2026-09-18) is
-- where it surfaced. The test baseline carried no check at all, which is why
-- the database suite never saw it; it carries the production one now.

do $$
begin
  if to_regclass('public.tracking_sessions') is null then
    return;
  end if;
  alter table tracking_sessions drop constraint if exists tracking_sessions_status_check;
  alter table tracking_sessions add constraint tracking_sessions_status_check check (status in (
    'recording', 'captured', 'derived', 'ingesting', 'raw_ingested', 'ingested',
    'quarantined', 'failed', 'live'));
end
$$;
