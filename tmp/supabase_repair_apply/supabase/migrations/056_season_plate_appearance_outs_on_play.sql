-- See 055_plate_appearance_outs_on_play.sql — same column, season schema.
alter table season_plate_appearances
  add column if not exists outs_on_play smallint;
