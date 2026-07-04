-- Mirrors migration 052 onto season_plate_appearances, the parallel table
-- used for season (non-tournament) games. See 052 for column rationale.
alter table season_plate_appearances
  add column if not exists is_buddy_jump boolean,
  add column if not exists buddy_jump_assist_position text,
  add column if not exists buddy_jump_putout_position text,
  add column if not exists is_robbed_hr boolean;
