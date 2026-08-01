-- Seconds offset into the parent game's video (games.video_url) marking
-- where this at-bat starts/ends, for the at-bat detail page's video player.
-- Nullable: set later by scorekeepers via the video-timestamping admin
-- tool, not at score-entry time.
alter table plate_appearances
  add column if not exists video_timestamp_start_sec numeric(7,2),
  add column if not exists video_timestamp_end_sec numeric(7,2);
