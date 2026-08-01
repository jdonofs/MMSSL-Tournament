-- Buddy Jump: two fielders with chemistry leap together for a catch, most
-- often to rob a would-be home run. The persisted `result` stays a normal
-- FO/LO (never a new result value) — these columns just add the extra
-- credit/context. All nullable: only plays scored as a Buddy Jump get values.
alter table plate_appearances
  add column if not exists is_buddy_jump boolean,
  add column if not exists buddy_jump_assist_position text,
  add column if not exists buddy_jump_putout_position text,
  add column if not exists is_robbed_hr boolean;
