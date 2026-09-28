-- Season drafts already run through the same turn-based/snake draft flow as
-- tournament drafts (see src/utils/draftOrder.js), but the pick order was
-- discarded at insert time. These columns let season_roster carry the same
-- round/pick_number/pick_in_round shape as draft_picks so draft value can be
-- computed for season drafts too. All nullable: waiver/free-agent adds and
-- pre-existing rows (until backfilled) have no pick data.
alter table season_roster
  add column if not exists round int,
  add column if not exists pick_number int,
  add column if not exists pick_in_round int;
