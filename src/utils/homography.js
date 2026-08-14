// Exact mapping between the game's flat ground plane and a stadium image.
//
// The old approach interpolated a radial scale between three tapped reference
// points, which quietly assumed the image was a scaled top-down view. It is
// not -- the stadium art is rendered in perspective, so a foot near home plate
// covers a different number of pixels than a foot at the wall, and no single
// per-angle scale can express that.
//
// A homography can. Any plane viewed through a pinhole camera maps to the
// image by a 3x3 projective transform, so for ground-level positions this is
// not an approximation that happens to be close -- it is the exact
// relationship, with eight parameters to pin down. Four known points determine
// it; more than four let the fit average out the error in clicking them.
//
// Points go in as world units (see parkGeometry.js) and come out as
// percentages of image width/height, which is what the markers are positioned
// with.

// Solve A x = b for a small dense system by Gaussian elimination with partial
// pivoting. Sized for the 8x8 normal equations below, not for general use.
function solveLinearSystem(matrix, vector) {
  const n = vector.length
  const a = matrix.map((row, i) => [...row, vector[i]])

  for (let col = 0; col < n; col += 1) {
    let pivot = col
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row
    }
    // A singular system means the points were degenerate -- three of them
    // collinear, or two clicked on the same spot. There is no transform to
    // return, and inventing one would silently misplace every marker.
    if (Math.abs(a[pivot][col]) < 1e-12) return null
    if (pivot !== col) {
      const swap = a[pivot]
      a[pivot] = a[col]
      a[col] = swap
    }
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue
      const factor = a[row][col] / a[col][col]
      if (factor === 0) continue
      for (let k = col; k <= n; k += 1) a[row][k] -= factor * a[col][k]
    }
  }
  return a.map((row, i) => row[n] / a[i][i])
}

/**
 * Fit a homography from world (x, z) to image (xPercent, yPercent).
 *
 * correspondences: [{ world: {x, z}, image: {x, y} }, ...], at least 4, with
 * no three of the world points collinear.
 *
 * Returns { matrix, residuals, rmsPercent } or null if the points were
 * degenerate. Residuals are how far each input point lands from where the
 * fitted transform puts it, in percentage points -- the honest read on whether
 * the clicking was good enough.
 */
export function fitHomography(correspondences) {
  const points = (correspondences || []).filter((c) => (
    Number.isFinite(c?.world?.x) && Number.isFinite(c?.world?.z)
    && Number.isFinite(c?.image?.x) && Number.isFinite(c?.image?.y)
  ))
  if (points.length < 4) return null

  // Direct linear transform with h33 fixed to 1. The alternative (smallest
  // singular vector of the 2Nx9 design matrix) avoids that gauge choice, but
  // h33 only vanishes when the image plane passes through the camera centre,
  // which cannot happen for a stadium being looked at.
  const rows = []
  const targets = []
  for (const { world, image } of points) {
    const { x: X, z: Z } = world
    const { x: u, y: v } = image
    rows.push([X, Z, 1, 0, 0, 0, -u * X, -u * Z])
    targets.push(u)
    rows.push([0, 0, 0, X, Z, 1, -v * X, -v * Z])
    targets.push(v)
  }

  // Least squares via the normal equations: 8x8 regardless of how many points
  // were clicked, so extra points cost nothing and only improve the answer.
  const normal = Array.from({ length: 8 }, () => new Array(8).fill(0))
  const rhs = new Array(8).fill(0)
  for (let r = 0; r < rows.length; r += 1) {
    for (let i = 0; i < 8; i += 1) {
      rhs[i] += rows[r][i] * targets[r]
      for (let j = 0; j < 8; j += 1) normal[i][j] += rows[r][i] * rows[r][j]
    }
  }

  const solution = solveLinearSystem(normal, rhs)
  if (!solution || solution.some((value) => !Number.isFinite(value))) return null
  const matrix = [...solution, 1]

  const residuals = points.map(({ world, image }) => {
    const projected = applyHomography(matrix, world.x, world.z)
    if (!projected) return Number.POSITIVE_INFINITY
    return Math.hypot(projected.x - image.x, projected.y - image.y)
  })
  const rmsPercent = Math.sqrt(
    residuals.reduce((sum, r) => sum + (r * r), 0) / residuals.length,
  )
  return { matrix, residuals, rmsPercent }
}

/** World (x, z) -> image percentages, or null if the point maps behind the camera. */
export function applyHomography(matrix, x, z) {
  if (!matrix || matrix.length !== 9) return null
  const [a, b, c, d, e, f, g, h, i] = matrix
  const X = Number(x)
  const Z = Number(z)
  if (!Number.isFinite(X) || !Number.isFinite(Z)) return null
  const w = (g * X) + (h * Z) + i
  // w <= 0 is a point on or behind the camera plane; there is no image
  // position for it, and dividing anyway would place it somewhere plausible
  // but wrong, mirrored through the vanishing point.
  if (!Number.isFinite(w) || Math.abs(w) < 1e-9) return null
  return {
    x: ((a * X) + (b * Z) + c) / w,
    y: ((d * X) + (e * Z) + f) / w,
  }
}

// --- height ----------------------------------------------------------------
//
// The homography above maps the GROUND. Anything above it — a ball in the
// stands, or off the top of the wall — is drawn at the ground point beneath
// itself, which in a perspective view sits nearer and lower than where the
// object actually appears. Both of the first two home runs measured here ended
// well up (30.6 ft into the seats, 15.6 ft off the wall) and both markers read
// short by exactly that effect.
//
// The correction is not a fudge. Writing the camera as columns [p1 p2 p3 p4],
// a world point (X, h, Z) projects to p1·X + p2·h + p3·Z + p4, which is the
// ground projection plus h·p2. So an elevated point is the ground point plus
// height times ONE fixed vector — and that vector is the vertical vanishing
// point. Three more numbers per park describe every height exactly.

/**
 * Fit the vertical vanishing point from points whose height is known.
 *
 * correspondences: [{ world: {x, z, height}, image: {x, y} }, ...]. Two are
 * enough. The natural source is a wall: click its base and the top directly
 * above, since the base gives the ground position and the wall's height is
 * known from a ball that struck its top.
 */
export function fitVerticalVanishing(matrix, correspondences, { allowVanishing = false } = {}) {
  const points = (correspondences || []).filter((c) => (
    Number.isFinite(c?.world?.x) && Number.isFinite(c?.world?.z)
    && Number.isFinite(c?.world?.height) && c.world.height > 0
    && Number.isFinite(c?.image?.x) && Number.isFinite(c?.image?.y)
  ))
  if (!matrix || points.length < 2) return null

  // vw is the weakest of the three parameters and the hardest to observe: it
  // only shows up as a difference in how tall the same object looks at
  // different DEPTHS, so calibration points bunched at one distance leave it
  // essentially free. Left unconstrained on such points it absorbs their noise
  // and produces a model that fits the clicks yet stops behaving like
  // perspective elsewhere — walls coming out the same height near and far, or
  // taller far away than near.
  //
  // Dropping it (vw = 0) puts the vertical vanishing point at infinity. Height
  // still foreshortens correctly with distance, because the ground term's own
  // depth denominator does that; only the second-order part is given up. Two
  // parameters from four-plus equations is well conditioned, so this is the
  // default and the full solve is opt-in for calibrations with real depth
  // spread behind them.
  const width = allowVanishing ? 3 : 2
  const [a, b, c, d, e, f, g, h, i] = matrix
  const rows = []
  const targets = []
  for (const { world, image } of points) {
    const { x: X, z: Z, height } = world
    const gx = (a * X) + (b * Z) + c
    const gy = (d * X) + (e * Z) + f
    const gw = (g * X) + (h * Z) + i
    // (gx + H·vx) / (gw + H·vw) = u  ->  H·vx - u·H·vw = u·gw - gx
    rows.push(allowVanishing ? [height, 0, -image.x * height] : [height, 0])
    targets.push((image.x * gw) - gx)
    rows.push(allowVanishing ? [0, height, -image.y * height] : [0, height])
    targets.push((image.y * gw) - gy)
  }

  const normal = Array.from({ length: width }, () => new Array(width).fill(0))
  const rhs = new Array(width).fill(0)
  for (let r = 0; r < rows.length; r += 1) {
    for (let m = 0; m < width; m += 1) {
      rhs[m] += rows[r][m] * targets[r]
      for (let n = 0; n < width; n += 1) normal[m][n] += rows[r][m] * rows[r][n]
    }
  }
  const partial = solveLinearSystem(normal, rhs)
  if (!partial || partial.some((value) => !Number.isFinite(value))) return null
  const solved = allowVanishing ? partial : [...partial, 0]

  const residuals = points.map(({ world, image }) => {
    const projected = applyHomographyWithHeight(matrix, solved, world.x, world.z, world.height)
    return projected ? Math.hypot(projected.x - image.x, projected.y - image.y) : Number.POSITIVE_INFINITY
  })
  return {
    vertical: solved,
    residuals,
    rmsPercent: Math.sqrt(residuals.reduce((sum, r) => sum + (r * r), 0) / residuals.length),
  }
}

/**
 * World (x, z) at height h -> image percentages.
 *
 * With height 0, or with no vertical vector fitted, this is exactly the ground
 * mapping — so a park that has never been height-calibrated still draws every
 * ground-level hit correctly rather than not at all.
 */
export function applyHomographyWithHeight(matrix, vertical, x, z, height) {
  if (!matrix || matrix.length !== 9) return null
  const h = Number(height)
  if (!vertical || vertical.length !== 3 || !Number.isFinite(h) || h === 0) {
    return applyHomography(matrix, x, z)
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

/** Image percentages -> world (x, z), for converting an existing manual tap. */
export function invertHomography(matrix, imageX, imageY) {
  if (!matrix || matrix.length !== 9) return null
  const [a, b, c, d, e, f, g, h, i] = matrix
  const u = Number(imageX)
  const v = Number(imageY)
  if (!Number.isFinite(u) || !Number.isFinite(v)) return null
  // Rearranged from the forward map: two linear equations in X and Z once the
  // projective divide is cleared.
  const solved = solveLinearSystem(
    [[a - (g * u), b - (h * u)], [d - (g * v), e - (h * v)]],
    [(i * u) - c, (i * v) - f],
  )
  if (!solved || solved.some((value) => !Number.isFinite(value))) return null
  return { x: solved[0], z: solved[1] }
}
