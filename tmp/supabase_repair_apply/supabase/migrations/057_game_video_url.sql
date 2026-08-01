-- YouTube video for the full game, used to embed/seek to individual at-bats
-- on their detail pages. Nullable: most games will not have a linked video
-- until a scorekeeper sets it via the video-timestamping admin tool.
alter table games
  add column if not exists video_url text;
