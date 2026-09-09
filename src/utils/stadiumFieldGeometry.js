// Stadium-image geometry shared by the React editor and the Node tracker.
// Keeping one copy prevents live tracker dots and manual taps from using
// different home plates or wall scales.
//
// For parks with measured world geometry, LF/CF/RF distances come from the
// fence coordinates in parkGeometry.js after converting their origin-relative
// samples to distance from home plate at exactly -45/0/+45 degrees. Parks not
// yet measured retain their old timing-derived references, rescaled from the
// superseded 90ft/26.84u convention to exactly 1 metre/unit.
export const STADIUM_FIELD_GEOMETRY = {
  mario_stadium: {
    homePlate: { x: 50.0, y: 92.9 },
    wallRefs: [{ x: 18.0, y: 44.2, dist: 257.8 }, { x: 50.6, y: 21.7, dist: 317.2 }, { x: 82.8, y: 44.6, dist: 259.0 }],
  },
  // Regenerated 2026-08-20 for the current 1260x899 artwork, from the measured
  // fence through PARK_IMAGE_HOMOGRAPHY rather than by eye. The superseded refs
  // were timing-derived AND placed on a 952x789 shot, so they were wrong twice
  // over; mapped forward they sat 3.3-4.5% high, which is what picking the TOP
  // of Yoshi's tall LF/RF walls instead of the wall base looks like.
  yoshi_park: {
    homePlate: { x: 49.9, y: 93.4 },
    wallRefs: [{ x: 17.0, y: 48.9, dist: 252.7 }, { x: 50.9, y: 24.7, dist: 321.6 }, { x: 83.4, y: 49.8, dist: 253.2 }],
  },
  wario_city: {
    homePlate: { x: 50.1, y: 94.1 },
    wallRefs: [{ x: 15.8, y: 41.8, dist: 285.7 }, { x: 51.4, y: 28.3, dist: 290.6 }, { x: 86.9, y: 43.2, dist: 282.8 }],
  },
  dk_jungle: {
    homePlate: { x: 50.2, y: 92.6 },
    wallRefs: [{ x: 15.4, y: 40.8, dist: 268.1 }, { x: 50.1, y: 19.2, dist: 316.0 }, { x: 83.9, y: 39.4, dist: 269.1 }],
  },
  bowser_castle: {
    homePlate: { x: 49.6, y: 92.8 },
    wallRefs: [{ x: 13.8, y: 44.7, dist: 269.8 }, { x: 49.2, y: 24.2, dist: 322.7 }, { x: 84.4, y: 43.8, dist: 270.2 }],
  },
  // Measured 2026-08-19. The superseded timing refs were 262 / 328 / 264 ft
  // (256.3 / 320.9 / 258.3 rescaled); they are kept here in writing because
  // parkGeometry.js now uses them as the one independent check on whether the
  // Bowser Jr. statue is the fence at dead centre. CF here is the stored chord
  // -- it becomes 321.3 if tracked hits show balls clearing the statue.
  bowser_jr_playroom: {
    homePlate: { x: 49.8, y: 92.6 },
    wallRefs: [{ x: 13.3, y: 44.2, dist: 256.2 }, { x: 50.3, y: 20.8, dist: 317.3 }, { x: 86.0, y: 44.3, dist: 256.7 }],
  },
  daisy_cruiser: {
    homePlate: { x: 50.3, y: 93.9 },
    wallRefs: [{ x: 24.7, y: 62.5, dist: 227.6 }, { x: 50.3, y: 37.9, dist: 319.1 }, { x: 75.3, y: 61.7, dist: 228.0 }],
  },
  peach_ice_garden: {
    homePlate: { x: 50.0, y: 93.0 },
    wallRefs: [{ x: 13.3, y: 41.6, dist: 306.6 }, { x: 50.9, y: 18.0, dist: 389.6 }, { x: 86.6, y: 42.9, dist: 307.2 }],
  },
  luigis_mansion: {
    homePlate: { x: 49.9, y: 90.4 },
    wallRefs: [{ x: 13.6, y: 47.8, dist: 276.6 }, { x: 49.7, y: 27.4, dist: 338.5 }, { x: 85.8, y: 48.9, dist: 277.8 }],
  },
  generic_field: {
    homePlate: { x: 49.9, y: 90.4 },
    wallRefs: [{ x: 9.4, y: 52.3, dist: 266.2 }, { x: 50.6, y: 22.1, dist: 325.7 }, { x: 90.4, y: 52.2, dist: 266.8 }],
  },
}
