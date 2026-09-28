-- Persist the batter-input evidence emitted by the 60 Hz player tracker.
--
-- `swing_mode` is deliberately allowed to be ordinary_unknown.  Existing
-- swing animation counters establish swing/take/bunt but do not establish
-- slap versus charge; new captures retain both Wii Remote motion structs so a
-- labelled calibration can fill slap/charge later without replaying games.
--
-- `pitch_zone = shadow` is also deliberate.  The called-ball and called-strike
-- samples overlap at the character-sensitive edge, so those pitches are not
-- forced into a chase/no-chase answer.

alter table if exists public.pitches
  add column if not exists swing_offer text,
  add column if not exists swing_mode text,
  add column if not exists swing_mode_source text,
  add column if not exists swing_charge_frames integer,
  add column if not exists swing_charge_release_timing_frames integer,
  add column if not exists plate_x_units double precision,
  add column if not exists plate_y_units double precision,
  add column if not exists plate_z_units double precision,
  add column if not exists pitch_zone text,
  add column if not exists pitch_zone_source text,
  add column if not exists is_chase boolean;

alter table if exists public.season_pitches
  add column if not exists swing_offer text,
  add column if not exists swing_mode text,
  add column if not exists swing_mode_source text,
  add column if not exists swing_charge_frames integer,
  add column if not exists swing_charge_release_timing_frames integer,
  add column if not exists plate_x_units double precision,
  add column if not exists plate_y_units double precision,
  add column if not exists plate_z_units double precision,
  add column if not exists pitch_zone text,
  add column if not exists pitch_zone_source text,
  add column if not exists is_chase boolean;

comment on column public.pitches.swing_mode is
  'Observed batter input: slap, charge, bunt, star, ordinary_unknown, or none.';
comment on column public.pitches.pitch_zone is
  'Conservative plate-location class: in, out, shadow, or unknown.';
comment on column public.pitches.is_chase is
  'True only for an ordinary swing at a pitch confidently outside the zone; null in the shadow/unknown band.';
comment on column public.season_pitches.swing_mode is
  'Observed batter input: slap, charge, bunt, star, ordinary_unknown, or none.';
comment on column public.season_pitches.pitch_zone is
  'Conservative plate-location class: in, out, shadow, or unknown.';
comment on column public.season_pitches.is_chase is
  'True only for an ordinary swing at a pitch confidently outside the zone; null in the shadow/unknown band.';
