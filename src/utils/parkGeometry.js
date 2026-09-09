// Measured park geometry, in the game's own world units.
//
// This is the authoritative source for where things actually are. Every number
// here was measured out of the running game rather than tapped on a screenshot
// (see scripts/collect_fence_samples.py and scripts/derive_fence_geometry.py):
// a character carrying the ball was driven head-on into the wall at ~40 angles
// per park, which stops at a repeatable spot, and the ball's own coordinates
// were read directly from memory.
//
// Coordinates share the game's frame: home plate near the origin, -Z toward
// centre field, +X toward first base. Spray angle is measured from
// straightaway centre, negative toward third base.
//
// World coordinates are metres: 1 game unit = 1 metre. Feet are only a display
// conversion applied at the edge. Raw coordinate measurements therefore stay
// unchanged when a UI switches between metric and imperial labels.

// Measured infield: Mario Stadium's fitted base path is 26.840u and Luigi's is
// 26.991u, both clustering around an intended 27m. Mario's held-out rubber is
// 17.979u, clustering around 18m. Independently, a scale-free fit to tracked
// ball flights recovers gravity near 9.81u/s^2. The older 90ft/base-path scale
// was an assumption, and run-timing references calibrated from a declared
// 90-foot base path could not independently validate it.
export const BASE_PATH_UNITS = 26.84
export const METERS_PER_UNIT = 1
export const FEET_PER_METER = 3.280839895013123
export const FEET_PER_UNIT = METERS_PER_UNIT * FEET_PER_METER
export const BASE_PATH_METERS = BASE_PATH_UNITS * METERS_PER_UNIT
export const BASE_PATH_FEET = BASE_PATH_UNITS * FEET_PER_UNIT

// The world origin is not exactly home plate. Two independent measurements
// agree it sits about 0.7 units beyond it: pitches cross the plate near
// (+0.2, -0.9), and the infield fit puts the plate at (-0.067, -0.714).
// Distances measured from the origin instead of from here run long by that
// much, which is small but free to correct.
export const HOME_PLATE = { x: -0.067, z: -0.714 }

// Held out of the diamond fit, so this remains a measurement rather than a
// regulation dimension synthesized through the selected display scale.
export const RUBBER_DISTANCE_UNITS = 17.979

// Presses read one body radius short of the padding, since a character cannot
// stand inside the wall. Measured from a batted ball that bounced off the wall
// at +37.5deg: the ball reached 0.17u beyond the press line, keeping 92% of
// its pace off the padding. It is a property of the character rather than the
// park, so the same correction applies everywhere -- already folded into the
// fence arrays below.
export const BODY_RADIUS_UNITS = 0.17

// Raw samples are [angleFromWorldOriginDeg, radiusFromWorldOriginUnits]. That
// is the coordinate convention emitted by derive_fence_geometry.py and keeps
// the measured source values intact. Consumers must use the plate-relative
// PARK_FENCES derived below; treating these origin radii as plate radii made
// every fence about 0.45u too deep and moved the foul-pole angles off +/-45deg.
export const PARK_FENCE_SAMPLES_FROM_ORIGIN = {
  mario_stadium: [
    [-44.69, 79.08], [-44.43, 79.53], [-42.54, 80.01], [-36.79, 82.17],
    [-33.51, 83.84], [-28.68, 86.96], [-24.03, 90.82], [-19.94, 95.05],
    [-18.43, 96.42], [-13.32, 95.68], [-9.78, 95.61], [-5.72, 95.98],
    [-2.14, 96.72], [1.69, 97.95], [4.75, 99.27], [6.33, 100.08],
    [6.58, 99.94], [6.76, 99.86], [9.77, 98.60], [12.63, 97.68],
    [16.40, 96.86], [18.71, 96.57], [18.76, 96.57], [18.79, 96.53],
    [19.08, 96.30], [21.16, 94.80], [23.98, 93.02], [27.63, 91.13],
    [30.56, 89.94], [31.28, 89.68], [31.57, 89.49], [32.33, 88.70],
    [34.60, 86.54], [36.93, 84.56], [39.84, 82.40], [42.42, 80.74],
    [44.62, 79.40],
  ],
  // 72 presses over four sessions. Two at the left-field pole stopped 44 and
  // 59 ft short of their neighbours 0.2 degrees away -- something stood between
  // the fielder and the padding -- and are excluded; a wall cannot notch that
  // deep across a fifth of a degree and come back. Presses within 0.4 degrees
  // of each other are repeats of one spot rather than curve detail, so they are
  // merged by median, which is what pulls the 2.4 ft press-to-press spread down
  // in the stored curve.
  //
  // From home plate on the canonical metre scale: 276.6 / 338.5 / 277.8 ft at
  // LF/CF/RF. Older 282/351/287 timing labels assumed 90-foot base paths and
  // are not an independent scale check.
  luigis_mansion: [
    [-44.99, 84.35], [-44.60, 85.02], [-43.83, 86.09], [-43.51, 86.49],
    [-42.89, 87.54], [-42.18, 88.66], [-41.72, 89.53], [-41.07, 90.23],
    [-40.67, 90.81], [-39.56, 90.97], [-38.15, 91.65], [-37.65, 91.87],
    [-35.21, 93.36], [-33.81, 94.26], [-32.77, 94.98], [-30.20, 96.36],
    [-29.79, 96.51], [-27.13, 97.66], [-24.73, 98.90], [-22.24, 100.41],
    [-19.48, 101.39], [-16.64, 102.42], [-14.37, 103.43], [-12.97, 104.16],
    [-12.13, 104.64], [-11.41, 104.63], [-9.80, 104.65], [-7.39, 104.84],
    [-5.05, 104.70], [-3.20, 104.02], [-0.71, 103.86], [2.42, 103.93],
    [4.39, 104.33], [6.87, 104.90], [9.46, 104.66], [12.00, 104.63],
    [14.21, 103.50], [16.68, 102.39], [18.96, 101.55], [20.67, 101.04],
    [21.71, 100.76], [23.78, 99.44], [24.82, 98.84], [25.69, 98.36],
    [28.13, 97.19], [31.03, 96.04], [32.02, 95.51], [34.18, 93.99],
    [35.97, 92.87], [37.86, 91.73], [39.91, 90.84], [41.70, 89.45],
    [42.72, 87.79], [43.78, 86.14], [44.47, 85.12],
  ],
  // 62 presses in ONE session, largest gap 2.8 degrees. The best-corroborated
  // park so far. From home plate it is 227.6 / 319.1 / 228.0 ft at LF/CF/RF.
  //
  // This fence is a POLYGON, not a curve, and that is why the density above is
  // required rather than thorough. Converted to Cartesian it resolves into flat
  // segments, each fitted by its presses to about 0.0-0.5 ft rms:
  //
  //   |angle| 30-45   straight HULL SIDES at |x| = 49.2u
  //   |angle| 19-28   transverse shelf at z = 90.1u
  //   |angle| 15-19   a step out to z = 91.4u
  //   |angle| 0-10    transverse at z = 98.1-99.4u
  //
  // joined by short angled runs. Nine consecutive presses fit the starboard
  // hull to 0.16 ft rms, which is a straight line measured to a fifth of a foot.
  //
  // Read as radius-vs-angle this LOOKS scalloped -- crests at -27.8/-9.6/+9.9/
  // +26.4, with notches at -19.1/0/+17.7 -- and it is
  // tempting to call it a wavy railing. It is not. r(theta) has a local maximum
  // at every vertex of a convex polygon and a local minimum at the perpendicular
  // foot of every edge, and each "notch" here sits mid-segment on a verified
  // flat run. Do not model this as a wave.
  //
  // What that means for sampling: linear interpolation in (angle, radius) between
  // two vertices does not reproduce the straight edge between them, it bows
  // INWARD, so presses along an edge are what keep the bow small and presses ON
  // the vertices are what keep the corners sharp. 5-degree binning, or any pass
  // spaced wider than ~4 degrees, cuts the corners and returns a smooth arc that
  // does not exist. Hence raw press angles here, merging only within 0.5 degrees.
  //
  // The shape is real, not noise. Reflecting the curve about centre field agrees
  // with itself to 0.36 ft median (4.8 ft worst, at the fast-turning poles) --
  // left and right field are independent sets of presses, so their agreement
  // measures both the structure and the method.
  //
  // The segments also predict where the wall HEIGHT changes, which is observable
  // in game: the three depth terraces are different deck
  // levels, so a single WALL_HEIGHT_UNITS cannot describe this park. Use the
  // segment boundaries above as the places to expect a height step.
  //
  // Repeatability here finally clears the 1.5 ft gate, which no park had met:
  // 3.5 ft median raw, but 0.05 ft median / 1.21 ft worst once the fence's own
  // slope is removed. Every "bad" pair sits between -33 and +33 degrees where
  // the wall moves 2.3-2.6 u/deg, so the 1.5-degree repeat window spans up to
  // 10 ft of genuine curve. Judge press precision against the local slope.
  //
  // One caveat, and it is why no landmark pass was run. The foul-pole angle
  // test is INCONCLUSIVE here: converted plate-relative, the end presses sit at
  // -45.48 and +45.30 rather than Luigi's -45.02/+45.02. Both overshoot
  // symmetrically and the radius is still falling 1.8 u/deg at the last press,
  // so there is no pole stop in the data -- the presses simply continued into
  // foul ground along the hull, which on this park is possible. The alternative
  // (Daisy's plate sitting 0.68u further out than HOME_PLATE) cannot be ruled
  // out from presses alone, but it would have to sit essentially ON the world
  // origin, unlike both measured parks. Left as-is because the reference
  // distances and the mirror symmetry both check out, and a ~2 ft origin
  // convention is already absorbed by the homography -- see the note above.
  daisy_cruiser: [
    [-45.10, 68.95], [-44.27, 70.64], [-42.75, 72.65], [-39.97, 76.76],
    [-37.42, 81.12], [-35.21, 85.50], [-32.94, 90.46], [-30.89, 95.45],
    [-30.34, 96.92], [-29.96, 97.92], [-27.83, 101.24], [-27.06, 101.23],
    [-26.50, 100.72], [-25.67, 99.99], [-24.90, 99.34], [-23.55, 98.27],
    [-22.43, 97.43], [-21.04, 96.46], [-19.12, 95.35], [-17.17, 95.55],
    [-15.59, 96.21], [-13.72, 98.08], [-11.39, 99.83], [-9.55, 101.27],
    [-8.99, 101.11], [-8.24, 100.41], [-5.82, 98.81], [-3.34, 98.29],
    [-1.04, 97.98], [0.90, 97.96], [3.44, 98.29], [6.10, 98.85],
    [7.89, 99.95], [9.87, 101.48], [11.67, 99.83], [13.49, 98.30],
    [15.24, 96.22], [17.66, 95.98], [20.09, 96.95], [22.04, 98.39],
    [24.12, 100.16], [26.40, 101.79], [27.93, 100.20], [29.65, 97.52],
    [31.33, 94.32], [31.87, 92.97], [32.92, 90.48], [34.11, 87.83],
    [35.67, 84.54], [37.61, 80.78], [39.18, 78.05], [41.73, 74.09],
    [44.26, 70.69], [44.84, 69.18],
  ],
  // 54 presses in one session spanning -45.0 to +45.1 degrees. The deepest park
  // in the game by a wide margin: about 390 ft to centre, against Luigi's 339
  // and Daisy's 319.
  //
  // THESE POINTS ARE GENERATED FROM A FITTED MODEL, NOT COPIED FROM PRESSES.
  // Every other park above stores raw press angles. This one does not, and the
  // reason is that the shape turned out to be exactly describable:
  //
  //   Peach Ice Garden's outfield wall is a REGULAR 24-GON -- 15.00 degrees of
  //   central angle per side -- centred at (0.011, -50.050), i.e. about 50
  //   units BEYOND the origin toward centre field, with a wall circumradius of
  //   69.42u and a vertex sitting essentially dead centre.
  //
  // That is not a shape someone talked themselves into. Fitting a regular N-gon
  // for every even N from 16 to 40 gives 0.8-1.4 ft rms at every value except
  // N=24, which drops to 0.12 ft -- a sharp isolated minimum, seven times better
  // than its neighbours, not a plateau that a flexible model would produce. 47
  // of the 54 presses sit on it within 0.56 ft, most within 0.15 ft.
  //
  // Storing the model beats storing the presses here because the model is more
  // accurate than the measurements it came from: 0.12 ft rms is finer than any
  // single press repeats. It also lets the sample points be PLACED rather than
  // inherited, which is what defeats the failure Daisy's comment warns about --
  // linear interpolation in (angle, radius) bows inward between vertices and
  // rounds off corners. Every one of the 9 visible vertices is an entry here,
  // as are both corner transitions and both foul-line ends, with 2 interior
  // points per span. Max interpolation error against the continuous model is
  // 0.25 ft. Do not thin this array: dropping to vertices alone costs 1.46 ft.
  //
  // THE CORNERS ARE REAL AND ARE THE WEAK PART. Past |spray| 43.24 the polygon
  // is cut by a straight side wall at |x| = 65.72u (220 ft off the centre line),
  // running down to each foul pole. The cut is not subtle -- an uncut 24-gon
  // puts the poles at 318.6 and 318.7 ft, while the presses and the reference
  // distances both say ~314. But only 7 presses fall in the corner and they fit
  // to 1.30 ft rms, against 0.12 ft on the polygon, so this is the one part of
  // the park measured no better than the other three parks overall. Two adjacent
  // right-field presses 0.2 degrees apart (+43.84 and +43.86) differ by 5.4 ft,
  // which is either the exact corner or a press into the foul pole itself.
  // More presses between |spray| 42 and 46 would settle it; nothing else here
  // needs another session.
  //
  // Corroboration, all independent of the fit:
  //   poles/centre   315.2 / 400.6 / 315.5 ft against reference 314 / 402 / 313
  //                  (+0.38%, -0.35%, +0.81%)
  //   mirror symmetry  0.08 ft median reflecting the presses about centre --
  //                    left and right field are disjoint press sets
  //   press precision  ~0.12 ft on the polygon. An earlier read of "1.8 ft near
  //                    the poles" was wrong: that band's scatter was the corner
  //                    being fitted as if it were noise.
  //
  // Two conventions worth stating because they were CHOSEN, not measured. The
  // radii are origin-relative like every array above -- see the long note there,
  // and do not fix it here alone. And the ends sit at exactly -45.000/+45.000
  // PLATE-relative by construction, because this park's geometry was built on
  // the assumption that foul lines sit at 45 degrees. Unlike Luigi's, where
  // +/-45 came out as a result and was evidence,
  // here it is an input and proves nothing. The presses themselves ran to
  // -45.27 and +45.47 plate-relative, continuing past the poles into foul
  // ground along the side walls.
  peach_ice_garden: [
    [-44.72, 94.00], [-44.23, 94.84], [-43.73, 95.70], [-43.24, 96.49],
    [-40.62, 98.63], [-37.99, 101.09], [-35.37, 103.89], [-32.36, 105.75],
    [-29.36, 107.98], [-26.36, 110.61], [-23.41, 111.90], [-20.46, 113.52],
    [-17.50, 115.50], [-14.58, 116.17], [-11.66, 117.16], [-8.74, 118.47],
    [-5.83, 118.50], [-2.92, 118.83], [-0.02, 119.47], [2.89, 118.84],
    [5.80, 118.51], [8.71, 118.49], [11.63, 117.18], [14.55, 116.19],
    [17.47, 115.52], [20.42, 113.55], [23.37, 111.93], [26.33, 110.65],
    [29.33, 108.02], [32.33, 105.80], [35.33, 103.95], [37.97, 101.13],
    [40.60, 98.67], [43.24, 96.52], [43.71, 95.73], [44.19, 94.90],
    [44.66, 94.10],
  ],
  // 79 presses in one session, three dropped: two at -27 degrees that stopped
  // 23 and 32 ft short of neighbours a tenth of a degree away, and one at
  // -11.14 reading 18 ft LONG between two presses 0.5 degrees either side --
  // that session had an errant throw, and a ball at rest past the padding
  // presses exactly like a fielder does. Those three alone produced the 32 ft
  // "worst repeatability" in the raw derive output; without them it is 1.6 ft.
  //
  // Bowser Castle is a POLYGON, and an irregular one. Fitted in Cartesian --
  // r(theta) peaks at every vertex and dips at each edge's perpendicular foot,
  // so in radius-vs-angle this park looks scalloped and is easy to misread. The
  // giveaway is a local MINIMUM at dead centre (99.08u at 0deg) between maxima
  // at +/-10deg: a flat wall square to centre field, not a bowl.
  //
  // Four edges per side, with outward normals at 0.00 / 21.94 / 44.78 / 67.59
  // degrees -- consecutive normals turn by 21.9-24.3, near enough to 22.5 that
  // the edge directions are a 16-gon's, but the apothems (99.08 / 98.51 / 90.58
  // / 76.25) fit no circle, and the centre edge is 35.4u long against 20.1u for
  // the three flanks. It is NOT a regular 16-gon; a regular-N-gon scan over
  // N=8..48 was flat at 0.91-0.96u rms with no isolated minimum, which is what
  // a model that fits nothing in particular looks like. Constraining the
  // normals to exact 22.5 multiples is also wrong: flank 1 sits 0.56deg off,
  // which tilts a 20u edge by 0.33 ft against a 0.04 ft fit.
  //
  // Fitted jointly as min(edges) over both folded halves at once, so which
  // press belongs to which edge is an OUTPUT -- 0.144 ft rms, 0.86 ft worst
  // over 76 presses. That beats the input presses' own precision (mirror
  // symmetry: 0.54 ft median), so the MODEL is stored rather than the presses,
  // generated with a point at every vertex.
  //
  // Corroboration, all independent of the fit. The radii themselves are
  // measurements and do not change with display units. Converted correctly
  // from HOME_PLATE they read 269.8 / 322.7 / 270.2 ft at LF/CF/RF.
  //   left vs right  fitted folded, then checked unfolded: bias -0.11 ft left
  //                  against -0.09 ft right, so the fold hid no one-sided error
  //   vs presses     0.18 ft rms, 0.74 ft worst over the 70 presses in range
  //   interpolation  0.24 ft worst against the continuous model, at 27 points
  //
  // A fifth edge exists at each pole -- a side wall, outward normal 91.9deg,
  // which is the flat face running out along the foul line. It is deliberately
  // NOT stored: it begins at the vertex at +/-44.73 origin-relative, which is
  // plate-relative +/-45.1, so the entire wall lies in foul ground. Only six
  // presses spanning 0.6deg touched it and its normal is poorly constrained by
  // them; none of that reaches a fair ball.
  //
  // Ends sit at exactly -45.000/+45.000 PLATE-relative by construction, as at
  // Peach, so like Peach they are an input and prove nothing about the frame.
  // The two crossings are NOT mirror images in stored (origin-relative) angle
  // -- -44.68 against +44.62 -- because HOME_PLATE.x is not zero. Radii are
  // origin-relative like every array above; see the long note there.
  //
  // No landmark pass was run. It was not needed: the presses span -45.0 to
  // +45.4 with the reference distances landing inside 0.6% at three angles, and
  // a frame error would rotate the two poles the same way rather than leaving
  // them symmetric. Wall height and stands are unmeasured for this park.
  bowser_castle: [
    [-44.68, 82.78], [-41.80, 84.69], [-38.91, 86.92], [-36.02, 89.50],
    [-33.13, 92.48], [-29.30, 93.99], [-25.46, 95.98], [-21.63, 98.51],
    [-17.79, 98.77], [-13.96, 99.47], [-10.12, 100.64], [-6.75, 99.77],
    [-3.37, 99.25], [0.00, 99.08], [3.37, 99.25], [6.75, 99.77],
    [10.12, 100.64], [13.96, 99.47], [17.79, 98.77], [21.63, 98.51],
    [25.46, 95.98], [29.30, 93.99], [33.13, 92.48], [36.00, 89.52],
    [38.87, 86.95], [41.75, 84.73], [44.62, 82.82],
  ],
  // 65 presses in one session, largest gap 3.2 degrees. Two more were recorded
  // and dropped: they are the first two holds chronologically, 22 seconds
  // before the run starts at the left-field pole, and they read 74.2u at
  // +23.4deg while real presses 0.6deg away read 92.7u. That is the fielder
  // walking to the pole, not a wall.
  //
  // The first MEASURED park that is a genuine CURVE. Cartesian DP segmentation
  // never settles -- 10, 12, 13, 14 segments as the penalty falls, normals
  // turning steadily with no stable vertex count -- which is what a smooth
  // shape looks like under a model built for polygons. Compare Bowser Castle,
  // where the same routine locked onto 7 segments and stayed there. Do not read
  // its radius-vs-angle profile the way the polygon parks above are read.
  //
  // One segment does survive every penalty: 17 presses from -7.1 to +7.5deg fit
  // a straight line at 0.081 ft rms. A circle of R~97 sags 2.6 ft across that
  // chord, so dead centre is genuinely flat.
  //
  // Fitted jointly as min(ellipse, chord) over all 65 presses at once, so the
  // transition angle is an OUTPUT:
  //
  //   ellipse  centre (0, -44.350), semi-axes A 56.578u across / B 54.293u deep
  //   chord    depth 97.391u, normal +0.00deg, corners at +/-7.07
  //
  // 0.283 ft rms, 0.71 ft worst. The superellipse exponent scan is the evidence
  // that this is a real ellipse rather than a flexible curve fitting anything:
  // n=1.8 gives 0.517 ft, n=2.0 gives 0.283 ft, n=2.2 gives 0.608 ft -- a sharp
  // isolated minimum exactly at 2. For scale, a plain circle plus the same
  // chord reaches only 0.462 ft and a circle alone 1.314 ft.
  //
  // 0.283 ft beats the presses' own precision, so the MODEL is stored rather
  // than the presses, with a point anchored on each corner.
  //
  // Corroboration, all independent of the fit:
  //   left vs right  0.04 ft median, 0.46 ft worst, +0.01 ft mean signed over
  //                  37 comparable angles -- the cleanest of any park measured
  //   vs presses     0.283 ft rms, 0.71 ft worst over 65 presses
  //   interpolation  0.10 ft worst against the continuous model, at 32 points
  // From HOME_PLATE it reads 256.2 / 317.2 / 256.7 ft at LF/CF/RF.
  //
  // THE CENTRE BAND IS CONFIRMED, by tracked hits on 2026-08-19. Two batted
  // balls struck the wall low enough to measure it, and they settle which of
  // the two candidate curves is real:
  //
  //   -15.53deg  y 1.45u  apex r 96.247   model 96.203   +0.044u
  //    +5.98deg  y 1.36u  apex r 98.099   chord 97.923   +0.176u
  //                                     ellipse 98.282   -0.183u
  //
  // The first sits where both candidates agree, so it calibrates the method:
  // a bouncing ball overshoots the stored surface by a fraction of one frame's
  // travel, because collision resolves on the frame that crosses it. At 9.2u/s
  // closing and 16.8ms frames that frame is 0.155u, and the overshoot was
  // 0.044u -- 28% of it.
  //
  // The second is inside the chord band, closing at 22.1u/s over 17.6ms, so one
  // frame is 0.39u. Against the chord it overshot 0.176u, 45% of a frame --
  // the same behaviour. Against the ellipse it would have had to REBOUND FROM
  // 0.183u SHORT of the surface, off nothing at all. Overshoot is expected and
  // undershoot is impossible, so the asymmetry decides it: the flat chord is
  // the wall. CF is 317.2 ft, not 321.3.
  //
  // What the chord is, physically: the wall carries a section across dead
  // centre that the Bowser Jr. statue stands on and behind. A ball that landed
  // on the wall top at +1.8deg came to rest at r 99.6-100.2, then rebounded off
  // the statue at r 100.15 -- the chin, confirmed visually. So the statue face
  // is BEHIND the wall face, and the 4.5 ft the chord cuts inside the ellipse
  // is the wall itself, not an object intruding onto the field.
  //
  // WALL HEIGHT VARIES, measured from balls that BOUNCED off its top deck.
  // These are bounces rather than rests, so the height is the y minimum of the
  // bounce less the 0.25u ball radius, the same correction a ball at rest needs:
  //
  //   +1.76deg   bounce y 8.71u -> deck 8.46u (27.8 ft)   at r 99.65
  //  -29.86deg   bounce y 6.37u -> deck 6.13u (20.1 ft)   at r 96.29
  //  +32.12deg   bounce y 6.27u -> deck 6.02u (19.8 ft)   at r 97.50
  //
  // The two flanks agree to 0.11u across 62 degrees of separation, and centre
  // stands 2.4u (7.7 ft) higher. Each bounce point sits 2.3-9.3u PAST the fence
  // face, so the top is a wide deck rather than a railing -- which is why balls
  // bounce along it instead of dropping back into play. Frame overshoot makes
  // each figure a slight underestimate. For scale, WALL_HEIGHT_UNITS is 4.645u
  // (15.2 ft): no part of this park's wall is near the Mario default, and
  // nothing here may assume it.
  //
  // Ends sit at exactly -45.000/+45.000 PLATE-relative by construction, as at
  // Peach and Bowser Castle, so they are an input and prove nothing about the
  // frame. Presses ran to +/-45.1 origin-relative, barely past the foul line,
  // so no side wall was traced and none is stored.
  //
  // No landmark pass was run; the mirror symmetry above is stronger evidence
  // than one would have provided. Every press sits at y = 0.00, so the wall
  // meets flat ground all the way round and the varying wall heights visible in
  // game are entirely above press level -- which rules out the calibrator's
  // wall base/top path for the vertical, since it assumes one WALL_HEIGHT_UNITS
  // per pair. This park needs ballVerticalFit from tracked landings.
  bowser_jr_playroom: [
    [-44.67, 78.63], [-41.77, 81.10], [-38.88, 83.41], [-35.99, 85.57],
    [-33.10, 87.57], [-30.21, 89.41], [-27.31, 91.10], [-24.42, 92.61],
    [-21.53, 93.95], [-18.64, 95.13], [-15.75, 96.13], [-12.85, 96.97],
    [-9.96, 97.64], [-7.07, 98.14], [-4.24, 97.66], [-1.41, 97.42],
    [1.41, 97.42], [4.24, 97.66], [7.07, 98.14], [9.96, 97.64],
    [12.84, 96.98], [15.73, 96.14], [18.62, 95.13], [21.50, 93.96],
    [24.39, 92.62], [27.28, 91.11], [30.16, 89.44], [33.05, 87.61],
    [35.94, 85.61], [38.82, 83.46], [41.71, 81.15], [44.60, 78.69],
  ],

  // 104 presses in one pass, -45.09 to +44.93, 2.1 deg largest gap, merged
  // within 0.5 deg to 81 points. Two further presses were dropped as the
  // walk into position before the pass started: they sit 20 seconds before
  // press 3 and one of them (-33.69) reads 2.5u short, the classic
  // fielder-blocked signature. Against a local line through their neighbours
  // NO press in the kept set exceeds 4 ft of residual, so nothing else was
  // obstructed.
  //
  // Repeatability: 1.59 ft median raw, 0.42 ft median / 3.16 ft worst once
  // the fence's own slope is removed. Every bad corrected pair sits on the
  // shoulders at +/-7 and -14 where the linear correction over-reports near a
  // vertex, exactly as at Peach.
  //
  // THIS PARK HAS NO ANALYTIC SHAPE MODEL, and that is a finding rather than a
  // gap. A circle fits at 4.58 ft rms and an ellipse at 4.52 ft -- both far too
  // coarse -- and exact DP segmentation in Cartesian never locks: it returns
  // 25 / 21 / 18 short segments at penalties 0.05 / 0.15 / 0.40 with no stable
  // count anywhere. A model that fits anything equally well is not evidence,
  // so the presses themselves are stored. Do not "tidy" this into an arc.
  //
  // Centre field is a three-part structure, not a curve:
  //   - a FLAT PANEL across dead centre, x -3.04..+3.42 (6.5u, 21 ft), six
  //     presses all reading z = -95.61 to within 0.01u;
  //   - a POCKET either side of it, deepest at x = -12.47 (100.37u) and
  //     x = +12.62 (100.18u), agreeing to 0.19u across 14 degrees.
  // The panel sits 4u (13 ft) CLOSER to home than the pockets. That mirror
  // agreement is the main evidence the assembly is designed geometry and not
  // an object left in front of the wall. 5-degree binning destroys all of it;
  // the panel and both pockets fall inside one bin.
  //
  // MIRROR SYMMETRY IS NOT AVAILABLE AS A VALIDATION HERE, unlike every other
  // measured park. It reads 1.20 ft median but 12.2 ft worst around +/-15,
  // because LEFT FIELD IS ELEVATED AND RIGHT FIELD IS NOT: 15 of 41 left
  // presses stand at y > 0.5, peaking 2.84u (9.3 ft) near -26 and 2.79u
  // (9.2 ft) near -14, while all 63 right-side presses read y = 0.00 exactly.
  // The asymmetry is real terrain. A landmark pass is therefore the only way
  // left to cross-check this side if one is ever wanted.
  //
  // What that elevation means downstream: THE FENCE BASE IS NOT AT FIELD LEVEL
  // between about -9 and -30, so "cleared the wall" is a per-angle question
  // here in a way it is not at Bowser Jr's, where every press sat at y = 0.00
  // and the varying heights were entirely above press level. Nothing may
  // assume WALL_HEIGHT_UNITS, and the calibrator's wall base/top path is
  // unusable. This park needs ballVerticalFit plus a PARK_STANDS_DECKS profile
  // measured from tracked bounces, and the ground profile above is the datum
  // those heights must be taken from on the left.
  //
  // Both ends overshoot plate-relative +/-45 symmetrically (-45.41 / +45.38),
  // so the presses continued into foul ground and no pole stop is in the data.
  // Symmetric overshoot rules out a lateral frame error, which would rotate
  // both the same way. From HOME_PLATE the curve reads 267.1 / 311.9 / 268.8 ft
  // at LF / dead CF / RF, and 327.5 ft at the deepest pocket. The legacy
  // timing-derived references (274 / 323 / 275) were produced under the
  // superseded 90ft base-path convention; rescaled by 3.280839895/3.3532 they
  // become 268.1 / 316.0 / 269.1, so LF and RF agree to 0.4% and 0.1%. CF
  // cannot agree with any single number, because the wall genuinely runs
  // 311.9 ft at the panel and 327.5 ft in the pockets.
  //
  // Stored with the same 0.17u body-radius offset as every other measured
  // park. Interpolation error of this array against all 104 raw presses is
  // 0.000 ft median, 0.889 ft max.
  dk_jungle: [
    [-45.09, 81.97], [-44.16, 82.67], [-42.22, 84.15], [-40.31, 84.59],
    [-38.22, 85.22], [-36.72, 86.17], [-34.48, 85.93], [-31.91, 86.72],
    [-29.94, 88.36], [-27.91, 89.84], [-25.99, 91.53], [-23.95, 92.49],
    [-22.56, 92.85], [-21.44, 92.80], [-19.96, 92.79], [-18.23, 92.84],
    [-16.25, 93.58], [-15.55, 94.21], [-14.40, 95.55], [-13.75, 96.62],
    [-12.73, 96.79], [-11.37, 96.84], [-10.71, 96.99], [-9.19, 97.87],
    [-7.63, 100.04], [-7.14, 100.54], [-6.43, 100.43], [-5.70, 99.28],
    [-5.14, 98.43], [-3.71, 97.15], [-2.85, 96.49], [-1.82, 95.83],
    [-0.74, 95.79], [0.17, 95.78], [1.32, 95.81], [2.04, 95.91],
    [2.98, 96.58], [3.97, 97.34], [5.03, 98.24], [6.08, 99.83],
    [7.40, 100.33], [8.03, 99.71], [8.71, 98.63], [9.83, 97.56],
    [11.62, 96.92], [13.18, 97.27], [13.95, 97.81], [14.79, 98.05],
    [15.88, 97.68], [16.58, 96.80], [17.32, 95.65], [18.05, 94.63],
    [18.77, 94.21], [19.91, 93.82], [20.90, 93.51], [21.49, 93.34],
    [22.22, 93.14], [23.16, 92.92], [23.92, 92.98], [24.92, 93.11],
    [26.21, 93.30], [26.79, 93.11], [27.60, 92.71], [28.60, 91.84],
    [29.34, 90.57], [30.33, 88.55], [31.15, 87.25], [32.00, 86.66],
    [33.69, 85.93], [35.10, 86.00], [36.58, 86.65], [37.06, 86.61],
    [38.07, 86.33], [39.10, 85.81], [40.07, 85.34], [41.09, 84.88],
    [42.23, 84.39], [42.74, 84.02], [43.34, 83.46], [44.20, 82.66],
    [44.93, 82.38],
  ],

  // Wario City, from one press session on 2026-08-19: 79 presses spanning
  // -45.0 to +45.1 origin-relative, largest gap 2.8deg, one press dropped (a
  // ball left at rest at +25.68 reading 102 ft short over 194 samples, with
  // 2.4u of vertical wander no press has).
  //
  // Every press reads y = 0.00, so the ground at the fence is flat and mirror
  // symmetry is available as a validation here -- unlike DK Jungle. It is the
  // cleanest of any park measured: 0.04 ft median and 0.42 ft worst between
  // the two halves, which is finer than a single press repeats.
  //
  // THE SHAPE IS AN IRREGULAR POLYGON, NINE EDGES PER HALF. A regular N-gon
  // was scanned from N=12 to 48 and the residual is flat at 0.29-0.35 ft with
  // no isolated minimum -- so, unlike Peach, that model is not evidence of
  // anything and was rejected. A best-fit circle over the outfield reads
  // 0.72 ft rms against the polygon's 0.18 ft, a 4x gap; four of the nine
  // edges fit their presses to 0.00 ft, which is what a flat collision plane
  // does and an arc cannot. Each edge keeps its own normal, as at Bowser
  // Castle: the outfield turns by 10.5/7.2/7.2/7.9/9.3deg, not a constant.
  //
  // DEAD CENTRE IS A RECESSED ALCOVE, and it is the defining feature of the
  // park. A flat face 5.2u wide sits at 289.5 ft, then two flared side walls
  // run back out to the main wall at 308.5 ft by +/-7.7deg -- a notch 19 ft
  // deep. Centre field is therefore SHORTER than the gaps on either side of
  // it, which no other measured park does. It is real geometry rather than
  // something standing in front of the padding: it is mirror symmetric to
  // 0.42 ft, its faces are straight to 0.00-0.20 ft rms, and the presses
  // trace a continuous path down into it and back out.
  //
  // Fitted folded, so which press belongs to which edge is an OUTPUT, then
  // stored as the MODEL with a point at every vertex rather than as the
  // presses -- 0.16 ft rms, 0.72 ft worst over all 78.
  //   left vs right  checked unfolded: bias +0.00 ft left, -0.00 ft right, so
  //                  the fold hid no one-sided error
  //   interpolation  0.15 ft worst against the continuous model, at 37 points
  //   reference      282.8 LF / 293.2 LF gap / 287.2 CF / 293.5 RF gap /
  //                  283.1 RF ft, converted from HOME_PLATE
  //
  // Ends sit at exactly -45.000/+45.000 PLATE-relative by construction, as at
  // Peach and Bowser Castle, so they are an input and prove nothing about the
  // frame. The two crossings are NOT mirror images in stored (origin-relative)
  // angle -- -44.70 against +44.64 -- because HOME_PLATE.x is not zero. The
  // presses ran past both, to -44.99 and +45.07.
  //
  // No landmark pass was run; the mirror symmetry above is a stronger check
  // than one would have been, since a lateral frame error rotates both poles
  // the same way rather than leaving them symmetric to 0.04 ft. WALL HEIGHT IS
  // UNMEASURED, and it matters more here than elsewhere: whether a fly ball to
  // dead centre clears the 289.5 ft alcove face, or drops into the recess, or
  // reaches the 308.5 ft wall behind it, is a height question this array
  // cannot answer. Measure it before trusting a centre-field home run call.
  // INVISIBLE BARRIER BEYOND THE WALL, measured 2026-08-19 from 11 marker
  // corrections whose balls stopped dead out there. It sits at radius
  // 97.95u +/- 0.5 (321 ft) from the world origin, and the radius holds to
  // under 1u across 44 degrees of angle -- so it is a circular ARC centred on
  // the origin, not a flat plane, running ~17 ft outside the fence at every
  // angle it covers. It is invisible in game and from the usual camera a strike
  // on it looks like a hit on the WARIO tower lettering far behind.
  //
  // It has GAPS. Balls at h~21u flew through to 104-107u at -17.5/-18.2/-22.1
  // and to 100.5-104.2 at +18.0/+22.2, while everything from -16 to +15 was
  // stopped -- two near-symmetric openings around |angle| 17-23. Strikes were
  // seen from -29.4 to +14.6, so the arc resumes outside the gaps.
  //
  // NOT stored in the array below, deliberately: this is not the fence, no
  // home run is decided by it, and PARK_FENCES is the boundary of the park.
  // Its consequence is on DISTANCE -- a ball stopped here is truncated at
  // 321 ft and its recorded carry reads short, the same way DK Jungle's canopy
  // truncates flights. Sampled from corrections only; the angular extent and
  // the exact gap edges are not surveyed.
  wario_city: [
    [-44.70, 86.75], [-43.33, 86.82], [-40.83, 87.08], [-38.33, 87.50],
    [-35.83, 88.10], [-33.33, 88.87], [-30.83, 89.84], [-27.66, 90.49],
    [-24.50, 91.42], [-21.66, 91.88], [-18.82, 92.56], [-16.12, 92.87],
    [-13.42, 93.39], [-10.57, 93.59], [-7.72, 94.02], [-5.55, 93.84],
    [-4.42, 90.69], [-1.69, 88.28], [0.00, 88.24], [1.69, 88.28],
    [4.42, 90.69], [5.55, 93.84], [7.72, 94.02], [10.57, 93.59],
    [13.42, 93.39], [16.12, 92.87], [18.82, 92.56], [21.66, 91.88],
    [24.50, 91.42], [27.66, 90.49], [30.83, 89.84], [33.33, 88.87],
    [35.83, 88.10], [38.33, 87.50], [40.83, 87.08], [43.33, 86.82],
    [44.64, 86.75],
  ],
  // YOSHI PARK, measured 2026-08-20 from 89 presses spanning -45.0 to +45.1,
  // of which 82 survived outlier removal. An 11-EDGE CONVEX POLYGON, mirror
  // symmetric about centre field, with a flat face in dead centre.
  //
  // Six distinct edges per half (one shared centre face), outward normals at
  // 0.00 / 15.25 / 30.45 / 45.45 / 60.41 / 74.85 degrees and apothems 98.75 /
  // 97.21 / 92.73 / 85.78 / 76.60 / 67.00. Consecutive normals turn by
  // 15.25 / 15.20 / 15.00 / 14.95 / 14.45, which looks like a 24-gon and is
  // NOT one: a joint regular-N-gon fit over N=16..40 bottomed at N=24 with
  // only 0.472 ft rms against 0.507 for N=23 -- a flat scan, so the regular
  // model carries no information, exactly as at Wario City. Letting each edge
  // keep its own normal and apothem fits 10x better.
  //
  // Fitted as a ray-cast POLYLINE through vertices, not as min(half-planes).
  // The edges here are convex so both agree, but the polyline is what the
  // shape actually is. The model is stored rather than the presses: it beats
  // the presses' own precision, so generating points lets one sit on every
  // vertex, which is what stops linear interpolation bowing in across a face.
  //
  // Mirror symmetry was ENFORCED, and costs nothing: 0.066 ft rms / 0.328 ft
  // worst symmetric against 0.049 / 0.209 with all 22 parameters free, for
  // half the parameters. It is a legitimate constraint HERE because press y
  // read 0.00 at every one of the 82 presses -- the ground along the fence is
  // dead flat, unlike DK Jungle, where non-zero y voided the same check.
  //
  // The one place the free fit looked asymmetric was the pole edges, whose
  // apothems differed by 2.88 ft. That is a short-lever artifact and not a
  // real difference: the left edge rests on 4 presses over 5 degrees against
  // 11 on the right, and as RADIUS -- the thing that matters -- the left edge
  // and the mirrored right edge agree to 0.05-0.48 ft across the pressed span.
  //
  // Corroboration, all independent of the fit:
  //   vs presses     0.129 ft rms, 0.626 ft worst over the 82 survivors
  //   left vs right  bias +0.008 ft left against -0.004 ft right
  //   interpolation  0.120 ft worst against the continuous model, 43 points
  //   plain mirror   0.02 ft median, 0.37 ft worst over 81 reflected pairs
  //
  // The POLES ARE SNAPPED to a mean of 253.0 ft, by request, moving the two
  // outermost edges out together by 0.245 ft. That is the only hand-set number
  // in this array; the fit alone put them at 252.5 / 253.0 and read 0.066 ft
  // rms, so the snap is what costs the 0.129 above. It is well under press
  // noise either way.
  //
  // The LF/RF SPLIT THAT REMAINS IS NOT ERROR AND MUST NOT BE TUNED AWAY.
  // 252.76 against 253.25 is HOME_PLATE.x = -0.067u (0.22 ft) seen at 45
  // degrees, not a lopsided fence: the model is exactly mirror symmetric, and
  // setting the plate to x=0 makes both poles read 252.718 identically. Making
  // the two ends numerically equal would require an ASYMMETRIC fence, which
  // bakes the plate offset into the geometry -- and it costs the under-sampled
  // left pole edge 0.05 -> 0.49 ft rms to do it. Every measured park has this
  // split; see the note on bowser_castle.
  //
  // From HOME_PLATE the curve reads 252.8 LF / 303.7 LF gap / 321.6 CF /
  // 304.0 RF gap / 253.2 RF ft. Centre field is a FLAT FACE, so radius has a
  // local MINIMUM at 0.00 (98.75u) and peaks at the vertices either side
  // (99.03u at +/-4.27) -- that is the polygon, not a bad press.
  //
  // Seven presses were dropped, every one reading SHORT (-11 to -148 ft) and
  // every one bracketed by a good press within a degree at nearly the same
  // angle, which is what rules out a recess and leaves a ball that stopped
  // before the wall. The session had trains hitting the runner and throws
  // being made, and both leave a ball at rest that presses exactly like a
  // fielder does. No press read LONG.
  //
  // Ends sit at exactly -45.000/+45.000 PLATE-relative by construction, so
  // like Peach and Bowser Castle they are an input and prove nothing about the
  // frame. The two crossings are not mirror images in stored origin-relative
  // angle -- -44.66 against +44.59 -- because HOME_PLATE.x is not zero.
  //
  // No landmark pass was run. Wall height and stands are unmeasured; the
  // homography and vertical are still to do.
  yoshi_park: [
    [-44.66, 77.59], [-42.33, 79.55], [-39.99, 81.74], [-37.92, 82.91],
    [-35.84, 84.23], [-33.77, 85.70], [-31.70, 87.34], [-29.62, 89.17],
    [-27.59, 90.13], [-25.55, 91.23], [-23.52, 92.48], [-21.49, 93.88],
    [-19.32, 94.51], [-17.15, 95.29], [-14.99, 96.21], [-12.82, 97.30],
    [-10.68, 97.52], [-8.54, 97.88], [-6.40, 98.38], [-4.27, 99.03],
    [-2.13, 98.82], [0.00, 98.75], [2.13, 98.82], [4.27, 99.03],
    [6.40, 98.38], [8.54, 97.88], [10.68, 97.52], [12.82, 97.30],
    [14.99, 96.21], [17.15, 95.29], [19.32, 94.51], [21.49, 93.88],
    [23.52, 92.48], [25.55, 91.23], [27.59, 90.13], [29.62, 89.17],
    [31.70, 87.34], [33.77, 85.70], [35.84, 84.23], [37.92, 82.91],
    [39.99, 81.74], [42.29, 79.58], [44.59, 77.65],
  ],
}

function originFenceToPlate(fence) {
  return fence.map(([originAngleDeg, originRadius]) => {
    const radians = (originAngleDeg * Math.PI) / 180
    const x = originRadius * Math.sin(radians)
    const z = -(originRadius * Math.cos(radians))
    const dx = x - HOME_PLATE.x
    const dz = z - HOME_PLATE.z
    return [
      (Math.atan2(dx, -dz) * 180) / Math.PI,
      Math.sqrt((dx * dx) + (dz * dz)),
    ]
  }).sort((left, right) => left[0] - right[0])
}

// Canonical [sprayAngleFromHomeDeg, distanceFromHomeUnits] geometry. Every
// downstream distance, fence test, and vector drawing uses this representation.
export const PARK_FENCES = Object.fromEntries(
  Object.entries(PARK_FENCE_SAMPLES_FROM_ORIGIN)
    .map(([parkKey, fence]) => [parkKey, originFenceToPlate(fence)]),
)

export const MEASURED_PARK_KEYS = Object.keys(PARK_FENCES)

export function hasMeasuredGeometry(parkKey) {
  return Object.hasOwn(PARK_FENCES, parkKey)
}

// Exact world -> stadium-artwork mapping, one 3x3 projective transform per
// park, produced by public/calibrate-homography.html.
//
// A ballfield is a plane and the artwork is a perspective view of it, so a
// projective transform is the right planar model. The fitted values are still
// limited by the precision of the landmark clicks; they are calibrations, not
// a claim that the raster artwork itself is metrically exact.
//
// Each matrix is fitted from EIGHT landmarks: the five infield positions, plus
// both foul poles and dead centre taken from the measured fence. The outfield
// three are not optional. The infield alone spans about 38 units while the
// fence sits at 80-100, so an infield-only fit extrapolates a projective
// transform far past its calibration region -- sub-pixel clicking error near
// home fans out into tens of feet at the wall, and the projected wall visibly
// drifts off the painted one while the diamond still looks perfect.
//
// The fence source was originally (and incorrectly) read as plate-relative
// polar data even though derive_fence_geometry.py writes origin-relative data.
// These matrices were re-expressed against the corrected outfield landmarks
// while preserving the eight original clicked landmark projections; the RMS
// movement at those clicks is 0.02-0.07 image percent. That keeps the artwork
// calibration and PARK_FENCES in one coordinate frame instead of retaining a
// hidden HOME_PLATE offset. Per-park independent checks and vertical limits are
// documented below and in tests/park-geometry.test.mjs.
export const PARK_IMAGE_HOMOGRAPHY = {
  mario_stadium: [
    0.73095405525, -0.26059433127, 50.200194026,
    0.0043314855275, 0.58856805661, 93.657087572,
    -0.00007530022891, -0.0051758129671, 1.000000000,
  ],
  luigis_mansion: [
    0.72676207803, -0.1695636868, 49.959042437,
    0.01378908359, 0.48449351199, 90.97499231,
    0.00023154865031, -0.0034817888941, 1.000000000,
  ],
  // Checked the same way as the two above -- projecting the measured fence to
  // the hand-tapped wallRefs, which took no part in this fit. Wall TOP: 0.61% at
  // centre, 1.18% and 1.41% at the poles, comparable to Luigi's 0.4%/0.6-1.2%.
  //
  // Note the pattern, because it is diagnostic rather than noise: at centre the
  // projected TOP beats the projected base (0.61% vs 1.79%), which is expected
  // since the refs were tapped on the wall's top edge. At the poles the top is
  // slightly WORSE than the base (1.18/1.41 vs 1.07/1.07), which is the assumed
  // WALL_HEIGHT_UNITS being wrong out there -- this park's deck is terraced and
  // its wall height genuinely varies. The ground mapping is unaffected.
  daisy_cruiser: [
    0.58735288063, -0.16471463227, 50.241705719,
    -0.0026327214531, 0.42712682095, 94.422640511,
    0.000067467725453, -0.0033062622838, 1.000000000,
  ],
  // Checked as far as this park currently allows, which is not as far as the
  // others. With no PARK_IMAGE_VERTICAL fitted yet, the fence can only be
  // projected at GROUND level, so the usual wall-top comparison is unavailable.
  //
  // What the ground projection does show is all good. It is symmetric to within
  // a third of an image percent (-44deg -> x=14.2 against +44deg -> x=85.5,
  // either side of 50), the infield lands square and centred (1B at 62.3, 3B at
  // 37.8, 2B at 50.2), and home plate inverts to within 1.25 ft of HOME_PLATE.
  //
  // Against the three hand-tapped wallRefs the projected fence base sits 2.5%
  // (centre) to 4.0% (poles) INSIDE them. Do not read that as error yet. Those
  // refs are known to sit on the wall's TOP edge -- that is what the eye picks
  // when clicking "the wall" on a screenshot, and it is exactly the offset the
  // other parks show before their vertical is applied. Whether Peach's wall
  // accounts for all of it is untestable until a vertical exists.
  peach_ice_garden: [
    0.71851752967, -0.22374395067, 50.122484535,
    0.020102983657, 0.54661370113, 94.036895268,
    0.00031094285492, -0.0043715952385, 1.000000000,
  ],
  // Checks available here, all passed. The projected fence is symmetric at
  // every angle tested (+/-44 -> 15.7/82.0, +/-10 -> 40.2/57.8) with the two
  // sides landing at matching heights to 0.3%, and the infield projects square
  // and centred (1B 62.1, 3B 36.7, 2B 49.4, rubber 49.5, home 49.6).
  //
  // Note the park's projected centreline is 49.4-49.0 rather than 50.0, and it
  // is consistent across the infield AND the outfield at every angle. That is
  // the artwork's own centre not sitting at half the image width, not a lateral
  // frame error -- a frame error would grow with distance instead of holding
  // steady, and would not put home plate and centre field on the same offset.
  bowser_castle: [
    0.74331266278, -0.21076705208, 49.693379104,
    0.014083482292, 0.54754516376, 93.565512555,
    0.00026918594653, -0.00442486117, 1.000000000,
  ],
  // Checks available without a vertical, all passed. The projection is
  // symmetric about the artwork centre at every angle tested (+/-10 -> 41.1/
  // 59.2, +/-20 -> 32.4/67.8, +/-30 -> 24.7/75.4, +/-44 -> 16.4/83.5, all
  // midpoints 49.98-50.11) with the two sides landing at matching heights to
  // 0.13-0.38 image percent. The infield projects square and centred (3B 36.5,
  // 1B 63.3, 2B 50.0, rubber 49.9, home 49.9), and inverting the hand-tapped
  // home plate returns a world point 0.66 ft from HOME_PLATE.
  //
  // No PARK_IMAGE_VERTICAL yet -- only wall BASES were marked, since this
  // park's wall height varies and no single height is known to assume. So the
  // fence can only be projected at ground level and the usual wall-top
  // comparison is unavailable, as at Peach.
  //
  // Against the three hand-tapped wallRefs the projected base sits 5.1-6.2
  // image percent below them, against 2.5-4.0 at Peach. Those refs are on the
  // wall's TOP edge -- that is what the eye picks when clicking "the wall" --
  // so the gap is wall height, and a gap half again larger than any other
  // park's is the first quantitative sign that these walls really are as tall
  // as they look. It is not a calibration to lean on: the image-percent
  // offset also varies with the projection's local scale.
  bowser_jr_playroom: [
    0.7703807766, -0.2259420064, 49.89991817,
    0.007642788433, 0.5579080752, 93.10964795,
    0.00005132521301, -0.004453289416, 1.000000000,
  ],
  // Fitted against the artwork replaced 2026-08-19 (1410x975 -> 1096x978,
  // framed wider so home runs landing beyond the wall are on the picture). The
  // matrix maps world to image PERCENT, so it is tied to that framing: replace
  // the art again and this must be re-fitted. The fence is not -- it is stored
  // in world units.
  wario_city: [
    0.7219596739, -0.1818638027, 49.98576836,
    0.01443761913, 0.5199917191, 96.14168857,
    -0.00005363815010, -0.003209919271, 1.000000000,
  ],

  // Lateral centring is among the best of the calibrated set. Projecting the
  // fence at +/-10/20/30/40/44 puts the midpoint at 49.81-50.06, and holding
  // the radius equal on both sides (which isolates the calibration from this
  // park's genuinely asymmetric fence) gives 49.82-49.95 -- tighter than
  // Luigi's 49.26-49.60 or Bowser Castle's 48.73-49.05. The infield projects
  // square and centred: 3B 37.4, 1B 62.8, 2B 50.0, rubber 50.1, home 50.2.
  //
  // The one number that stands out, and it is left in deliberately rather than
  // tuned away. At EQUAL radius the two sides disagree in HEIGHT by
  // 0.27/0.53/0.78/1.02/1.11 image percent at +/-10/20/30/40/44 -- monotonic in
  // angle and about double every other park (mario 0.69, daisy 0.65, peach
  // 0.59, bowser_jr 0.52, luigi 0.27, bowser_castle 0.20 at the widest angle).
  // Since the radius is equal on both sides this is not the fence asymmetry;
  // it is a real depth tilt in the fit.
  //
  // The likely cause is specific to this park and worth checking before anyone
  // re-clicks it: a homography maps the GROUND PLANE, and DK Jungle's left
  // field ground is NOT at field level -- presses there stand up to 2.84u
  // (9.3 ft) high, see the PARK_FENCES comment. Any landmark clicked along the
  // left-side wall base sits on raised terrain and violates the plane being
  // fitted, which would tilt depth exactly this way. A re-fit that either
  // avoids left-field ground points or takes them at true field level should
  // roughly halve this. Until then the projection is good enough for ground
  // hits -- 1.1% of image width at the poles -- and the residual table cannot
  // help, since it only pins exact matches within 0.05u.
  //
  // No PARK_IMAGE_VERTICAL, by decision rather than by omission. This park's
  // wall height changes substantially around the field, so the calibrator's
  // wall base/top path is unusable: verticalFit feeds WALL_HEIGHT_UNITS in as
  // the assumed height of EVERY clicked pair, and no single height is true
  // here. The vertical must come from ballVerticalFit on tracked landings,
  // which assumes no wall height at all. Ground-level hits draw correctly
  // meanwhile; only elevated endpoints fall back to their ground position.
  dk_jungle: [
    0.7275203773, -0.2297645954, 50.24039401,
    -0.01293024793, 0.6133233704, 93.17484467,
    -0.00003189945279, -0.004694826737, 1.000000000,
  ],
  // YOSHI PARK, calibrated 2026-08-20 against the current stadium image
  // (1260x899). The artwork was replaced twice that day -- 952x789, then a
  // too-wide 1486x899, then this crop of it -- and each swap needed a fresh
  // fit. Projects the measured 11-edge fence onto the painted wall cleanly
  // around the whole arc.
  //
  // The image swap invalidated every other image-percent number for this park
  // at once -- aspectRatio, homePlate, wallRefs and the nine fielder positions
  // in FieldPlayBuilder -- because they are all fractions OF THE IMAGE. They
  // were regenerated together; do not change the artwork without redoing all
  // of them.
  //
  // No PARK_IMAGE_VERTICAL yet, and the calibrator's "click 2 more wall
  // base+top pair(s)" prompt MUST NOT be answered here. That path feeds
  // WALL_HEIGHT_UNITS in as the assumed height of every clicked pair, and this
  // park has no single wall height to assume: left and right field carry tall
  // walls, and the walls through the rest of the outfield MOVE UP AND DOWN
  // during play. Use ballVerticalFit on tracked landings instead -- it assumes
  // no wall height at all -- via a preview session and fit_park_vertical.mjs.
  // Ground-level hits draw correctly meanwhile.
  yoshi_park: [
    0.7669151770, -0.2319034868, 49.89174024,
    0.02243159862, 0.5962006732, 94.13263117,
    0.0002345121951, -0.004350133698, 1.000000000,
  ],
}

// Outfield wall height, in units. Measured from a batted ball that clipped the
// very top of the wall and left the park: its tracked endpoint sat at 4.645
// units, and our independently measured fence put the wall 1.5 ft inside that
// point. Used to calibrate the vertical below, since it gives a feature whose
// height AND ground position are both known.
// Two things are now known to be wrong with it, and it is still left alone.
//
// It is a BALL-CENTRE height, not a surface height. Every ball at rest in a
// Luigi's Mansion session read y = 0.25 exactly -- fourteen of them, no scatter
// -- so a tracked y sits one ball radius above whatever it touched. As a surface
// height this value is 4.645 - 0.25 = 4.395u (14.7 ft).
//
// And it is not park-independent. Luigi's Mansion measures 21.4 units-in-feet
// (6.37u), half again Mario's, from THREE balls that struck the top of its wall
// and deflected upward:
//
//   -43.75 deg   +0.51u behind the fence   21.08 ft
//   -28.58 deg   -0.02u                    21.45 ft
//   +42.02 deg   +1.71u                    21.61 ft
//
// Spread 0.53 ft across 86 degrees of outfield, from three different batters
// with nothing shared between the measurements, so that wall is one constant
// height rather than a profile. The middle one landed on the fence radius to
// within 0.02u -- the cleanest geometry available, and the reason this is
// trusted over Mario's single ball.
//
// A crest hit must be taken at the fence radius (|behind| < 2u). Contacts
// further back are a separate structure 4-11u behind the wall standing 25-29 ft,
// and reading those as wall height inflates it: one at +2.43u bounds 24.9 ft,
// which is the backdrop, not the wall. Note also that a ball landing on a PEAKED
// top bounces up AND back, so "still travelling outward after contact" wrongly
// rejects the best measurements -- the vertical reversal plus the radius is what
// identifies a crest. Luigi's wall does drop near the poles (11-16 ft inside the
// last few degrees), which is the one place a single height fails.
//
// Left alone because PARK_IMAGE_VERTICAL was fitted against this exact number:
// verticalFit in calibrate-homography.html feeds it in as the assumed height of
// every clicked wall base/top pair, so the constant and those vectors are only
// correct together -- the same pairing trap as PARK_FENCES and the homography
// above. Changing it here silently invalidates both parks' height models. The
// way out is the tracked-ball fit, which assumes no wall height at all; once a
// park's vertical comes from balls, its wall height can be READ OFF the artwork
// instead of fed into it.
export const WALL_HEIGHT_UNITS = 4.645

// The vertical vanishing point per park, as a homogeneous 3-vector.
//
// PARK_IMAGE_HOMOGRAPHY maps the GROUND. A ball in the stands or off the top of
// the wall is not on the ground, and drawing it at the ground point beneath
// itself puts the marker nearer and lower than where the ball actually appears
// — which is exactly how this was noticed. An elevated point is the ground
// projection plus height times this one vector, so three numbers cover every
// height exactly.
//
// A park without an entry here still draws every ground-level hit correctly;
// only elevated endpoints fall back to their ground position.
export const PARK_IMAGE_VERTICAL = {
  // Third component is 0 by construction: the vanishing term is only
  // observable as a difference in apparent height between near and far, so
  // calibration points along one wall cannot see it, and left free it absorbs
  // their noise instead. Dropping it keeps height foreshortening correct via
  // the ground term's own depth denominator.
  mario_stadium: [0.1157609077, -0.7927953185, 0.000000000],
  // Fitted from two wall base/top pairs rather than from tracked balls, and
  // accepted on the evidence that matters: hits land where they should on the
  // artwork across a full session, checked against balls whose positions were
  // measured independently.
  //
  // Worth recording WHY it came out usable, because the method looks like it
  // should not have. verticalFit assumes WALL_HEIGHT_UNITS (4.645u, a Mario
  // Stadium number) as the height of every clicked pair, and Luigi's wall is
  // really 6.37u -- half again as tall. But both pairs were clicked AT THE FOUL
  // POLES, and that is the one place Luigi's wall drops: measured crests inside
  // the last few degrees run 11-16 ft, and the +46.2 deg one is 16.05 ft against
  // the assumed 15.58. So the assumption was accurate to half a foot exactly
  // where it was applied. Luck, but explicable luck.
  //
  // The remaining weakness is real but has not bitten: both pairs sit ~84u out,
  // so depth spread is near zero and the fit pins the vertical's DIRECTION while
  // barely constraining how it grows with distance. If elevated balls ever read
  // wrong in this park -- particularly deep to centre, furthest from where this
  // was calibrated -- refit from tracked balls, which assume no wall height at
  // all. Wall and backdrop STRIKES are the points to use here, not landings:
  // every Luigi's home run comes down at field level and the calibrator filters
  // y > 0.5, so landings offer nothing.
  luigis_mansion: [-0.02474917451, -0.5887312846, 0.000000000],
  // Fitted without assuming another park's wall height. Three independent
  // ordinary-wall top contacts now measure Bowser Castle's surface at
  // 8.664136u, 8.800592u and 8.747704u from +34.2 through -32.6 degrees
  // (0.45 ft total spread). Their 8.737477u mean supplies the real height for
  // the three existing LF/CF/RF wall-top artwork references. A full homogeneous
  // vertical column is needed here: it keeps the lateral perspective shift of
  // the thick curved wall instead of treating height as a y-only screen offset.
  // The fit reproduces those independently tapped refs to 0.85 image-percent
  // RMS / 1.11 worst. Raised pillars require no special constant: their larger
  // measured ball y naturally moves them farther along this same 3D vector.
  bowser_castle: [-0.22600854758, -0.79528459622, -0.0053528636262],
  // PROVISIONAL, and the only version confirmed against live play. Two attempts
  // to improve it made placement worse and were reverted; the reason is recorded
  // below because the trap is easy to fall into again.
  //
  // The homography cannot supply a vertical on its own. Decomposing each
  // calibrated park's ground homography as a pinhole camera and solving for the
  // focal length that reproduces its stored vertical gives 1745 / 1650 / 1340 px
  // for Mario / Luigi's / Bowser Castle -- no agreement, and none reproduces its
  // own vertical closer than 0.09. The artwork is not a true perspective render,
  // so K*r2 is not recoverable and clicks really are required.
  //
  // This value comes from the CF wallRef alone: a hand tap on the wall's top edge
  // at dead centre (50.30, 20.80) against the fence face projecting to
  // (50.12, 27.03), with that edge's height taken as 8.46u from a ball bouncing
  // there. One point, one assumed height -- but live play across a full session
  // put the marks where the balls visibly were, with only a small sideways error
  // near the poles.
  //
  // DO NOT anchor a refit on the LF and RF wallRefs. They are labelled "LF foul
  // pole" and "RF foul pole" in the pre-2026-08 FieldPlayBuilder source, not wall
  // tops: a tap somewhere up a tall vertical pole, at a height nobody recorded.
  // Treating them as the 6.07u wall deck -- which is what six measured bounces
  // give for the deck itself -- makes the implied vy too steep by about half
  // again, because the real tap height is larger than the assumed one. That
  // produced [-0.7357, -1.6840, -0.013493] and then [0, -1.0869, 0], which threw
  // statue-height balls tens of feet past the structures they visibly hit. The
  // apparent corroboration those fits showed was circular: the target lift was
  // itself derived from a verbal estimate of the previous version's error.
  //
  // The second failure mode is separate and also worth avoiding: letting vw float
  // when every anchor sits at one height. Fitted at h ~ 6u and extrapolated to
  // h ~ 19u, the vw term had no data and roughly doubled the lift.
  //
  // The way out is not another derivation. It is a ballVerticalFit with clicks on
  // tracked balls at two well-separated heights -- a deck bounce near 6u and a
  // statue contact near 19u -- which pins vx, vy and vw together against measured
  // positions instead of against assumptions about what a hand tap was aimed at.
  bowser_jr_playroom: [0.0216, -0.7365, 0.000000000],

  // Reproduce with: node scripts/fit_park_vertical.mjs --park dk_jungle
  //
  // Fitted from the TRACKER_IMAGE_CALIBRATION corrections logged during the
  // 2026-08-19 preview sessions -- each one a ball whose world x/y/z the game
  // reported and whose true spot on the artwork was marked by hand. That is
  // ballVerticalFit's input exactly, already clicked, so no calibrator pass was
  // needed and nothing here assumes WALL_HEIGHT_UNITS. Heights run 4.38 to
  // 25.22u, which is the spread that constrains how the vertical GROWS and not
  // merely its direction.
  //
  // This park is the clearest demonstration of why the vector matters at all.
  // Against those same clicks the marker was landing a median 10.51 image
  // percent away (max 16.79) with no vertical, because an elevated ball falls
  // through to the ground point beneath itself. With this vector that drops to
  // 1.44 median / 2.61 max, and leave-one-out -- fit without each point, then
  // predict it -- gives 1.95 / 3.10. The held-out number tracking the in-sample
  // one is what says eight points against two free parameters is not
  // overfitted.
  //
  // vw is deliberately 0 even though ballVerticalFit permits the full solve.
  // The vanishing term is observable solely as a difference in apparent height
  // between NEAR and FAR, and these balls span 21.9u of depth -- far too narrow
  // to see it. Left free it would absorb click noise instead. Re-run the script
  // once corrections exist across a wider depth range and it will solve vw
  // automatically.
  //
  // Worth flagging: at -0.944 the height term is the largest of any park (the
  // others run -0.59 to -0.80). Some of that may be the fit absorbing the
  // depth tilt recorded on this park's homography above, which disagrees left
  // to right by 1.11 image percent at the poles. The residuals say it is doing
  // its job regardless -- they are the best of any park measured this way,
  // ahead of Bowser Jr's 2.42 -- but if that homography is ever re-clicked
  // against true field-level ground points, refit this from the same
  // corrections rather than keeping it.
  dk_jungle: [-0.0660567270, -0.9311717148, 0.000000000],

  // Reproduce with:
  //   node scripts/fit_park_vertical.mjs --park wario_city --max-height 25
  //
  // Fitted from 9 of the 15 logged marker corrections, heights 3.12-21.13u.
  // 3.47 median marker error without a vertical, 1.74 with, and leave-one-out
  // at 1.75 says that generalises rather than fits the noise.
  //
  // THE EXCLUDED CORRECTIONS ARE NOT NOISE, NOT BAD CLICKS, AND NOT BAD
  // COORDINATES. They are balls stopped by Wario City's INVISIBLE BARRIER, and
  // the ceiling exists because of them. From the camera those balls appear to
  // strike the WARIO lettering on the tower, so they were marked against the
  // lettering -- but the lettering is distant backdrop and the ball had really
  // banged into a barrier only ~17 ft past the fence. The world coordinate is
  // right; the CLICK was placed against the wrong visual reference, and since
  // the lettering is large the clicks scatter: two balls 5 ft apart in world
  // space were marked 19.3 image percent apart, about 65 ft. One world point
  // cannot map to two image points, so no vertical can satisfy them, and
  // including them dragged the fit to 7.81 median -- worse, at the low heights
  // where nearly every real ball lives, than having no vertical at all.
  //
  // These are RECOVERABLE. Re-marking those balls at the barrier rather than at
  // the lettering would turn them into the high-altitude data this fit most
  // lacks, and the ceiling could then be raised. Until then the cap stands.
  // See the barrier geometry note on PARK_FENCE_SAMPLES_FROM_ORIGIN.wario_city.
  //
  // The cost is that this vector is fitted at h <= 21u and extrapolated above
  // it, so tower-height balls stay approximate. Everything that lands, clears
  // the wall, or strikes it sits inside the fitted range. Depth spread is only
  // 11.7u so vw is held at 0, as at Luigi's -- if elevated balls ever read
  // wrong deep to centre, that is the term with no data behind it.
  wario_city: [-0.0438198043, -0.7955323779, 0.000000000],
  // YOSHI PARK, fitted 2026-08-20 from 20 tracked-ball corrections (11 left,
  // 9 right), heights 2.83-17.13u, depth spread 27.4u. This is the ballVerticalFit path, not the
  // calibrator's wall base/top path -- that one feeds WALL_HEIGHT_UNITS in as
  // the assumed height of every pair, and this park has tall tunnels at both
  // poles, a shorter wall between them, and walls that MOVE, so no single
  // assumed height is true even at one angle.
  //
  //   no vertical  5.88 image percent median / 10.69 max
  //   this fit     1.61 / 3.52
  //   held out     1.80 / 3.98  (leave-one-out)
  //
  // THIS PARK IS AT THE LIMIT OF A SINGLE VERTICAL VECTOR, and it is the first
  // one to show it. Split the corrections by side and each half fits ITSELF
  // beautifully -- 0.67 image percent median on the left, 0.80 on the right --
  // but they want OPPOSITE horizontal terms: vx = -0.229 fitted on the left,
  // +0.120 on the right, against vy terms that agree closely (-0.719 / -0.759).
  // Each half's vector scores 2.2-3.1 on the other half.
  //
  // That is a real perspective effect, not noise. A vertical line left of the
  // camera axis leans one way in the image and one right of it leans the other,
  // converging on a vertical vanishing point; a CONSTANT vx applies the same
  // lateral shift everywhere and cannot represent both. Yoshi exposes it
  // because it is the first park with tall structures at BOTH poles, so there
  // are high balls either side of centre. Wario's tower, DK's canopy and Bowser
  // Jr's wall each sat on one side, where a constant vx absorbs the lean fine.
  //
  // The stored vector is therefore the JOINT fit, and it is kept balanced on
  // purpose -- 1.57 left against 1.78 right -- rather than chosen for lowest
  // median, since a side-biased fit reads well on its own half and 2-3 on the
  // other. Fixing this properly means a real vertical vanishing point in
  // applyHomographyWithHeight, which would change every park's projection and
  // is not something to do from one park's data.
  //
  // More corrections will not move this much: the ceiling is the model, not the
  // data. Points added to either side pull vx toward that side, which is what
  // the 16 -> 19 -> 20 point refits each did.
  //
  // ONLY POST-SWAP CORRECTIONS WERE USED, and the difference is not marginal.
  // Yoshi's artwork was replaced twice on 2026-08-20 and the homography refitted
  // each time, which invalidates every earlier click: a correction is a point in
  // IMAGE percent, so it means a different world ray once the picture changes.
  // Including the three surviving pre-swap clicks moved the horizontal term from
  // -0.067 to -0.316 and took held-out max from 3.68 to 17.36. One of them was a
  // ball 38.3u up, far above the fitted range and against a vertical structure
  // where a ground-plane map has no well-defined answer at all.
  //
  // vw is held at 0: 27.4u of depth spread is well under the 60u the fitter
  // wants before the vanishing term is observable rather than noise-absorbing.
  //
  // This is what was making balls near the tall tunnels read short. With no
  // vertical, an elevated endpoint falls back to the ground point beneath the
  // ball, which in a perspective view sits nearer and lower than where the ball
  // actually appears -- and the error scales with height, so it was worst
  // exactly at the tallest structure in the park.
  yoshi_park: [-0.0547826973, -0.7449821045, 0.000000000],
}

// Local screen-space residuals measured from the 2026-08-19 Playroom run.
// Each entry is [worldX, worldY, worldZ, imageDeltaX, imageDeltaY]. The target
// pixel was clicked on the replay frame while the world point came from the
// tracked ball. Four fair_fielded entries use their trajectory's FIRST impact,
// not the later pickup (see trackerTrajectoryFirstImpact).
//
// A single projective camera plus one vertical vector cannot reproduce this
// particular raster everywhere: Bowser Jr., the stars, presents and Thwomps
// overlap at several unrelated depths and the artwork is not a true pinhole
// render. These are exact empirical tie-points only. They MUST NOT be blended
// by world-space proximity: DK and Birdo struck different visible surfaces
// only 1.3 world units apart, but those surfaces are nearly five image-percent
// apart vertically. An unrecognized contact therefore uses the global camera
// rather than borrowing a correction from the wrong overlapping object.
export const PARK_IMAGE_LOCAL_RESIDUALS = {
  bowser_jr_playroom: [
    [-24.0559635, 20.8819447, -97.6799316, -1.1, -1.7],
    [56.4382439, 18.4180012, -80.1491776, 2.1, 0.2],
    [-17.0123901, 12.5991964, -98.559494, -2.4, -3.9],
    [-19.2800465, 12.898428, -96.1775284, -1.5, -5.8],
    [-9.70315742, 12.9713068, -103.197731, -0.8, -7.9],
    [69.7323532, 0.25, -76.3782883, -3.3, -6.2],
    [-24.069006, 24.8677731, -101.064301, -1.6, -1.6],
    [-49.6016464, 8.42070007, -71.0370331, -1.2512131481, 0.8047051532],
    [-27.2636604, 20.9068508, -99.895195, -0.6, -0.7],
    [53.4591942, 10.3005123, -62.7939568, 1.2358878812, 1.109342985],
    [-14.020853, 12.0881119, -102.19429, -0.9, -4.4],
    [-16.1051903, 12.3343697, -96.8930054, 0.005144682, -0.1608480977],
    [17.7643642, 12.6274815, -98.2412949, 1.0, -2.1],
    [-60.4309349, 19.0661736, -72.258812, -1.3, -2.4],
    [-35.334362, 22.790308, -97.4076843, -2.3, -1.4],
    [3.74084926, 0.25, -109.495651, 2.1, 3.3],
    [-69.4440994, 0.25, -60.6801758, 1.1, -10.2],
    [-43.5228729, 15.472167, -81.9412155, -2.3454272315, 2.2263944995],
    [-65.1811371, 0.25, -90.4589386, 2.1, -3.8],
    [-27.1414948, 20.6816978, -95.7169647, -1.8, -1.2],
    [-27.5464058, 20.96521, -98.0988998, -1.5, -0.3],
    // This raised impact is measured directly now; it no longer receives the
    // broad ground-landing visibility push.
    [53.4743958, 6.34289837, -83.1447296, 0.1707309012, -2.3244760776],
    [27.1587772, 20.7743988, -97.5125198, 2.9, -5.5],
    // Follow-up marks from the 11:58 Playroom session. The first two are the
    // left-field Thwomp contacts that disproved height-only deck clearance.
    [-56.0879364, 6.38419437, -72.3675079, 0.4316346407, -0.0806378723],
    [-52.680088, 6.42286682, -83.7811661, 0.6873234554, -1.2893578003],
    [67.2359772, 0.25, -86.8098831, -3.7913464392, -4.9935890834],
    [34.3271141, 0.25, -115.906555, 1.4589551597, -2.8892222172],
    [34.3128777, 21.8620186, -97.4208145, 1.2665613811, -0.0644686522],
    [-31.8031425, 12.4757471, -91.4117508, -1.5592633575, -0.4515036377],
    // Boomerang Bro.'s rear blue-wall FIRST impact. Its emitted endpoint was a
    // second bounce 74 frames later near the Thwomps and must not calibrate it.
    [-50.8995361, 18.1217976, -87.865448, -2.5742954273, -0.0575437625],
    // DK's measured wall-top rebound, kept distinct from Birdo's nearby but
    // visually separate raised-object contact.
    [-16.2222824, 12.5062609, -97.5733032, -1.2538063914, 0.3368044492],
    // Exact marks around the two treasure chests and their rear blue-wall
    // openings. These deliberately remain isolated from the LF Thwomps.
    [-41.6679306, 23.9301376, -88.3078384, -4.1095164657, -3.3173398155],
    [-39.6038399, 25.8843918, -91.9564209, -3.5353465312, -2.8433494709],
    [-42.7874718, 0.25, -111.736595, 1.1964009218, -5.708344956],
    [-42.3134537, 25.9399357, -89.7069168, -2.9889061557, -1.2133013183],
    [31.3421078, 0.25, -122.650551, 3.5536993300, -6.4821803126],
  ],
}

const LOCAL_IMAGE_RESIDUAL_EXACT_UNITS = 0.05

function applyLocalImageResidual(parkKey, x, z, height, spot) {
  const controls = PARK_IMAGE_LOCAL_RESIDUALS[parkKey]
  const X = Number(x)
  const Y = Number(height)
  const Z = Number(z)
  if (!spot || !controls || !Number.isFinite(X) || !Number.isFinite(Y) || !Number.isFinite(Z)) {
    return spot
  }

  const nearby = controls.map(([cx, cy, cz, dx, dy]) => {
    const distanceSquared = ((X - cx) ** 2)
      + ((Z - cz) ** 2)
      + ((Y - cy) ** 2)
    return { distanceSquared, dx, dy }
  }).sort((left, right) => left.distanceSquared - right.distanceSquared)

  const nearest = nearby[0]
  if (!nearest) return spot
  if (nearest.distanceSquared <= LOCAL_IMAGE_RESIDUAL_EXACT_UNITS ** 2) {
    return { x: spot.x + nearest.dx, y: spot.y + nearest.dy }
  }
  return spot
}

// Daisy deliberately has no active vertical vector. Its candidate height fit
// assumed Mario's wall height even though its wall is terraced, so falling back
// to the verified ground mapping is safer than presenting that magnitude as
// 1:1. Bowser formerly lived in the same category: its old candidate looked
// roughly twice as large because its actual ordinary wall is roughly twice
// Mario's assumed height. The direct measurements below remove that assumption
// and are the basis of Bowser's now-active fit above.
//
// Bowser now has four direct surface-height measurements from 2026-08-18. The
// three ordinary-wall values agree; the raised pillar remains separate:
//
//   ordinary wall, +34.216deg, 4.317u behind fence:
//     ball centre y=8.914136 -> surface 8.664136u (28.43 ft)
//   ordinary wall, -9.402deg, 2.838u behind fence:
//     ball centre y=9.050592 -> surface 8.800592u (28.87 ft)
//   ordinary wall, -32.647deg, 3.687u behind fence:
//     ball centre y=8.997704 -> surface 8.747704u (28.70 ft)
//   raised pillar, -27.816deg, 3.433u behind fence:
//     ball centre y=11.881341 -> surface 11.631341u (38.16 ft)
//
// All four contacts have an observed upward rebound. The three ordinary-wall
// measurements supply the active vertical fit; the pillar's different height
// proves it cannot be collapsed into that surface constant.

// Minimum distance past the fence at which a ground-level landing becomes
// visible beyond the wall silhouette on each park's artwork.
//
// This is deliberately separate from the measured fence and world position.
// Bowser Castle's wall occupies a thick strip of the overhead screenshot: the
// planar homography correctly projects a shallow lava landing behind that wall,
// but the projected pixel is hidden by the stone artwork. Sampling the image at
// nine bearings from -40 to +40 degrees puts the first consistently visible
// beyond-wall surface about 20 units past the measured fence.
//
// Bowser Jr. Playroom uses the same clearance for true ground landings and
// flight estimates. Measured raised impacts do not use it: follow-up replay
// clicks proved that Thwomp contacts can share the rear deck's exact height,
// making any height-only attempt to choose between those structures ambiguous.
// Along eight bearings from -36 through +36deg, fence + 25u remains on the
// green wall/deck artwork while fence + 28u reaches visible blue beyond it.
//
// We preserve the real landing coordinates and use these clearances only when
// choosing a visible pixel. Callers keep every measured object impact at its
// calibrated contact instead of applying this broad ground-landing rule.
export const PARK_IMAGE_LANDING_CLEARANCE_UNITS = {
  bowser_castle: 20,
  bowser_jr_playroom: 28,
}

// Where a ball that clears the wall comes down, by spray angle.
//
// A ball landing beyond the fence does not land on the ground -- it lands on
// the seating deck, and a marker drawn at the ground point beneath it reads
// short in a perspective view. For a TRACKED ball this does not matter, since
// its height is measured. It matters for a projected one, which has no height
// at all and would otherwise be drawn as though the stands were the field.
//
// Measured from 34 tracked landings that cleared the wall. Height turns out to
// depend on ANGLE, not on how far past the wall the ball came down -- against
// distance past the wall the relationship is nothing (R^2 0.06), but split by
// angle two decks appear:
//
//   |angle| 0-19    n=19   mean 3.430u (11.25 ft)   sd ~1.08 ft
//   |angle| 19-50   n=15   mean 6.591u (21.62 ft)   sd ~6.36 ft
//
// The lower deck is tight enough to rely on. The upper is not -- 6.5 ft of
// scatter says there is more than one surface out there -- so treat a corner
// estimate as rougher than a centre one.
//
// Two dead-centre landings at about 55 and 60 ft are excluded: at ~0 degrees and far
// above everything else, they are a different structure entirely (scoreboard or
// batter's eye), not the seating.
// luigis_mansion is deliberately ABSENT, and that absence is a measurement, not
// a gap. Fourteen home runs tracked to a real landing there came down at
// y = 0.25 units EVERY time -- zero scatter, across angles -39 to +21 and 11 to
// 19 units past the fence. 0.25u is the ball at rest (its centre one radius
// above the surface, confirmed by every resting ball in the session), so the
// ground behind that wall is at field level. There is no deck to model, and no
// entry here is exactly right: standsHeightUnits returns null and the caller
// falls back to 0.
//
// Do not "complete" this table by adding a Luigi's entry. Mario's angle-banded
// model does not generalise -- Mario is the only park in this game with seating
// behind the outfield wall, and its own comment records that height there
// depended on ANGLE and not on distance past the wall. A park whose ground
// simply continues at field level needs no model, and a park with a slope would
// need distance rather than angle, which is why standsHeightUnits already takes
// distanceUnits.
export const PARK_STANDS_DECKS = {
  // Not stands -- this park's wall carries a wide flat top deck, and that is the
  // surface a ball clearing the fence comes down on. Measured from six balls that
  // bounced off it between |angle| 28 and 32: 6.02, 6.03, 6.04, 6.05, 6.05,
  // 6.12u, taking each bounce's y minimum less the 0.25u ball radius. A seventh
  // at -4.54deg, landing within 0.06u of the fence face, reads 6.06u, so the
  // front edge is the same height at centre.
  //
  // One band deliberately, because centre is NOT resolved. Bounces there run
  // 6.06 / 7.03 / 8.46 / 12.68u before the statue's own contacts at 17-25u take
  // over, and separating a landing on the top deck from a deflection off the wall
  // FACE needs the radius to be checked for reversal case by case -- a face hit
  // sends the ball back inward, a deck landing carries it onward. Until that is
  // done, a taller centre band would be a guess. The known extras are the statue
  // plinth at 8.46u around +1.8deg and something at 12.68u near -11deg.
  bowser_jr_playroom: [
    { withinAngle: 90, heightUnits: 6.06 },
  ],
  mario_stadium: [
    // Preserve the measured raw heights; their old 11.5/22.1ft labels were
    // produced with the superseded 90ft/base-path conversion.
    { withinAngle: 19, heightUnits: 3.4295598234522244 },
    { withinAngle: 90, heightUnits: 6.590719312895145 },
  ],
}

/**
 * Expected landing height for a ball that cleared the wall, in units.
 *
 * Null when the park has no measured deck profile, or when the ball did not
 * clear -- inside the wall it lands on the field, and the answer is zero.
 */
export function standsHeightUnits(parkKey, angleDeg, distanceUnits) {
  const decks = PARK_STANDS_DECKS[parkKey]
  const angle = Number(angleDeg)
  const fence = fenceRadiusAt(parkKey, angle)
  if (!decks || !Number.isFinite(angle) || fence == null) return null
  if (!(Number(distanceUnits) > fence)) return null
  for (const deck of decks) {
    if (Math.abs(angle) < deck.withinAngle) return deck.heightUnits
  }
  return decks[decks.length - 1].heightUnits
}

export function hasImageCalibration(parkKey) {
  return Object.hasOwn(PARK_IMAGE_HOMOGRAPHY, parkKey)
}

export function hasHeightCalibration(parkKey) {
  return Object.hasOwn(PARK_IMAGE_VERTICAL, parkKey)
}

// Raw camera-model projection, before a park's independently observed local
// artwork residuals are applied.
function rawWorldToImagePercentAtHeight(parkKey, x, z, height) {
  const matrix = PARK_IMAGE_HOMOGRAPHY[parkKey]
  const vertical = PARK_IMAGE_VERTICAL[parkKey]
  const h = Number(height)
  if (!matrix || !vertical || !Number.isFinite(h) || h === 0) {
    return worldToImagePercent(parkKey, x, z)
  }
  const [a, b, c, d, e, f, g, hh, i] = matrix
  const [vx, vy, vw] = vertical
  const X = Number(x)
  const Z = Number(z)
  if (!Number.isFinite(X) || !Number.isFinite(Z)) return null
  const w = (g * X) + (hh * Z) + i + (h * vw)
  if (!Number.isFinite(w) || Math.abs(w) < 1e-9) return null
  return {
    x: ((a * X) + (b * Z) + c + (h * vx)) / w,
    y: ((d * X) + (e * Z) + f + (h * vy)) / w,
  }
}

// World position AND height -> percentage across the park's artwork. Height 0,
// or a park with no vertical fitted, falls through to the ground mapping.
export function worldToImagePercentAtHeight(parkKey, x, z, height) {
  const spot = rawWorldToImagePercentAtHeight(parkKey, x, z, height)
  return applyLocalImageResidual(parkKey, x, z, Number(height) || 0, spot)
}

// World position -> percentage across the park's artwork. Null when the park
// has not been calibrated, or when the point maps behind the camera -- callers
// must treat that as "cannot be drawn" rather than substituting a guess.
export function worldToImagePercent(parkKey, x, z) {
  const matrix = PARK_IMAGE_HOMOGRAPHY[parkKey]
  if (!matrix) return null
  const [a, b, c, d, e, f, g, h, i] = matrix
  const X = Number(x)
  const Z = Number(z)
  if (!Number.isFinite(X) || !Number.isFinite(Z)) return null
  const w = (g * X) + (h * Z) + i
  if (!Number.isFinite(w) || Math.abs(w) < 1e-9) return null
  return {
    x: ((a * X) + (b * Z) + c) / w,
    y: ((d * X) + (e * Z) + f) / w,
  }
}

// Fence distance at one spray angle, interpolated between measured points.
// Beyond the measured span the nearest measurement is held rather than
// extrapolated: past the foul poles there is no fence to describe, and a
// linear run-out would invent one.
export function fenceRadiusAt(parkKey, angleDeg) {
  const fence = PARK_FENCES[parkKey]
  const angle = Number(angleDeg)
  if (!fence || !fence.length || !Number.isFinite(angle)) return null
  if (angle <= fence[0][0]) return fence[0][1]
  if (angle >= fence[fence.length - 1][0]) return fence[fence.length - 1][1]
  for (let i = 0; i < fence.length - 1; i += 1) {
    const [a0, r0] = fence[i]
    const [a1, r1] = fence[i + 1]
    if (angle < a0 || angle > a1) continue
    if (a1 === a0) return r0
    return r0 + ((angle - a0) / (a1 - a0)) * (r1 - r0)
  }
  return null
}

export function fenceDistanceFeet(parkKey, angleDeg) {
  const radius = fenceRadiusAt(parkKey, angleDeg)
  return radius == null ? null : radius * FEET_PER_UNIT
}

// World position -> spray angle and distance from home plate.
export function worldToPolar(x, z) {
  const dx = Number(x) - HOME_PLATE.x
  const dz = Number(z) - HOME_PLATE.z
  if (!Number.isFinite(dx) || !Number.isFinite(dz)) return null
  return {
    angleDeg: (Math.atan2(dx, -dz) * 180) / Math.PI,
    distanceUnits: Math.sqrt((dx * dx) + (dz * dz)),
  }
}

// The foul lines run at 45 degrees either side of straightaway centre.
export const FOUL_LINE_ANGLE_DEG = 45

// Pull an ESTIMATED position back inside the foul lines.
//
// Only ever apply this to an estimate. A tracked coordinate is where the ball
// actually was, and balls genuinely do end up foul -- a foul pop-up caught for
// an out belongs in foul ground and must stay there.
//
// An estimate is different. A ball that leaves tracked play is positioned by
// extrapolation, or failing that from its LAUNCH spray angle, and a ball hit
// hard down the line commonly leaves the bat at more than 45 degrees and hooks
// fair. Nothing in either estimate knows about the foul lines, so a home run
// -- fair by definition -- gets drawn in foul territory. Clamping the angle
// keeps the one thing the result already told us.
export function clampToFairTerritory(x, z) {
  const polar = worldToPolar(x, z)
  if (!polar) return null
  if (Math.abs(polar.angleDeg) <= FOUL_LINE_ANGLE_DEG) return { x: Number(x), z: Number(z) }
  const clamped = Math.sign(polar.angleDeg) * FOUL_LINE_ANGLE_DEG
  return polarToWorld(clamped, polar.distanceUnits)
}

export function polarToWorld(angleDeg, distanceUnits) {
  const radians = (Number(angleDeg) * Math.PI) / 180
  const distance = Number(distanceUnits)
  if (!Number.isFinite(radians) || !Number.isFinite(distance)) return null
  return {
    x: HOME_PLATE.x + (distance * Math.sin(radians)),
    z: HOME_PLATE.z - (distance * Math.cos(radians)),
  }
}

// World landing -> a visible marker on the stadium artwork.
//
// A low landing just behind a tall wall can be geometrically valid while its
// image projection lies underneath the wall's painted silhouette. Parks with a
// calibrated clearance move only that display point to the first visible part
// of the same bearing. The stored x/y/z, distance and angle remain untouched.
export function worldLandingToImagePercentAtHeight(parkKey, x, z, height = 0) {
  const clearance = PARK_IMAGE_LANDING_CLEARANCE_UNITS[parkKey]
  const polar = worldToPolar(x, z)
  const fence = polar ? fenceRadiusAt(parkKey, polar.angleDeg) : null
  if (
    Number.isFinite(clearance)
    && clearance > 0
    && polar
    && Math.abs(polar.angleDeg) <= FOUL_LINE_ANGLE_DEG
    && fence != null
    && polar.distanceUnits > fence
    && polar.distanceUnits < fence + clearance
  ) {
    const visible = polarToWorld(polar.angleDeg, fence + clearance)
    if (visible) {
      // Keep the calibration keyed to the measured world contact even though
      // the display-only wall clearance projects a farther point on its ray.
      const spot = rawWorldToImagePercentAtHeight(parkKey, visible.x, visible.z, height)
      return applyLocalImageResidual(parkKey, x, z, Number(height) || 0, spot)
    }
  }
  return worldToImagePercentAtHeight(parkKey, x, z, height)
}

// The measured diamond, drawn from the fitted infield rather than from the
// individual base holds: the fit already averaged out the centring error in
// those, so it is the better estimate of where the bases actually are.
export function infieldCorners() {
  const half = BASE_PATH_UNITS / Math.sqrt(2)
  return {
    home: { x: HOME_PLATE.x, z: HOME_PLATE.z },
    first: { x: HOME_PLATE.x + half, z: HOME_PLATE.z - half },
    second: { x: HOME_PLATE.x, z: HOME_PLATE.z - (BASE_PATH_UNITS * Math.sqrt(2)) },
    third: { x: HOME_PLATE.x - half, z: HOME_PLATE.z - half },
    rubber: { x: HOME_PLATE.x, z: HOME_PLATE.z - RUBBER_DISTANCE_UNITS },
  }
}

// How far out the drawing needs to reach for a park, so every park can be
// rendered at TRUE SCALE against a shared extent -- which is what makes
// comparing two parks on one chart mean anything.
export function parkMaxRadius(parkKey) {
  const fence = PARK_FENCES[parkKey]
  if (!fence || !fence.length) return null
  return fence.reduce((max, [, radius]) => Math.max(max, radius), 0)
}

export function allParksMaxRadius() {
  return MEASURED_PARK_KEYS.reduce(
    (max, key) => Math.max(max, parkMaxRadius(key) || 0),
    0,
  )
}
