// The localhost HTTP face of a tracker preview session.
//
// Two processes serve this exact API and the browser page cannot tell them
// apart by shape, only by what the snapshot says about itself:
//   - scripts/tracker_at_bat_preview.mjs — read-only, writes nothing anywhere.
//   - scripts/live_tracker_bridge.mjs    — the same at-bat view over a session
//     that IS writing plate appearances into Supabase.
//
// Keeping one implementation is the point. The preview page is the tool used
// to find tracker bugs, so it has to show the live-bridge session in exactly
// the detail it shows a dry run; two servers that drifted apart would mean the
// bug hunt happens on a page that isn't the one running during real games.
import http from 'node:http'
import {
  setTrackerPreviewStadiumOverride,
  trackerPreviewPlayEvidence,
  trackerPreviewSnapshot,
} from './tracker_preview_state.mjs'
import {
  ANNOTATION_CATEGORIES,
  annotationPathFor,
  appendTrackerAnnotation,
  buildTrackerAnnotation,
  readTrackerAnnotations,
} from './tracker_annotations.mjs'

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

function readJsonBody(request, response, limit = 4096) {
  return new Promise((resolve) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > limit) request.destroy()
    })
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'))
      } catch {
        response.writeHead(400, JSON_HEADERS)
        response.end(JSON.stringify({ error: 'Body must be JSON' }))
        resolve(null)
      }
    })
  })
}

// onStadiumChange runs after a manual stadium pick so the caller can record it
// (the standalone preview writes a TRACKER_STADIUM marker into its session log,
// which is the only place a flight's park is ever recorded).
//
// onCalibrationRecord receives the log line built from the finished record.
// The calibration is a local diagnostic and never touches statistics or
// Supabase, in either process.
export function createTrackerPreviewServer({
  state,
  port = 4317,
  host = '127.0.0.1',
  onStadiumChange = () => {},
  onCalibrationRecord = () => {},
  // Where "Something is wrong" writes. A function rather than a path because
  // the capture it belongs beside is not known until the collector starts, and
  // an annotation written to the wrong session is an annotation nobody finds.
  annotationPath = () => annotationPathFor(state.playerTracking?.capture?.stem),
  onAnnotation = () => {},
  onShutdown = null,
} = {}) {
  const server = http.createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Tracker-Database-Writes', state.writesEnabled ? 'enabled' : 'disabled')
    const requestUrl = new URL(request.url || '/', `http://${host}:${port}`)
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      })
      response.end()
      return
    }

    // The page is the control surface for test sessions, including shutdown.
    // Respond before starting the potentially minutes-long capture flush and
    // postgame derivation so the button never looks like another network bug.
    if (requestUrl.pathname === '/shutdown' && request.method === 'POST') {
      if (typeof onShutdown !== 'function') {
        response.writeHead(405, JSON_HEADERS)
        response.end(JSON.stringify({ error: 'This tracker service cannot be stopped from the preview' }))
        return
      }
      if (state.writesEnabled) {
        const allowedOrigins = new Set(['https://msl-tournament.vercel.app',
          'http://localhost:5173', 'http://127.0.0.1:5173'])
        if (request.headers.origin && !allowedOrigins.has(request.headers.origin)) {
          response.writeHead(403, JSON_HEADERS)
          response.end(JSON.stringify({ error: 'This site cannot stop the live tracker' }))
          return
        }
        const parsed = await readJsonBody(request, response)
        if (!parsed) return
        if (String(parsed.gameId) !== String(state.gameContext?.game_id)
          || parsed.table !== state.gameContext?.games_table) {
          response.writeHead(409, JSON_HEADERS)
          response.end(JSON.stringify({ error: 'The tracker is recording a different game' }))
          return
        }
      }
      response.writeHead(202, JSON_HEADERS)
      response.end(JSON.stringify({ accepted: true, message: 'Saving and ending this tracker session' }))
      setImmediate(() => {
        Promise.resolve(onShutdown()).catch((error) => {
          console.error('[tracker-preview] shutdown failed:', error.message)
        })
      })
      return
    }

    // Choosing the stadium by hand is the only way to check field placement in
    // a session where the tracker never prints a "A vs. B @ Stadium" line,
    // which is most of them. Read-only with respect to Supabase in both
    // processes: this only changes which geometry the projection uses.
    if (requestUrl.pathname === '/stadium' && request.method === 'POST') {
      const parsed = await readJsonBody(request, response)
      if (!parsed) return
      const stadiumKey = parsed.stadium_key
      if (!setTrackerPreviewStadiumOverride(state, stadiumKey)) {
        response.writeHead(400, JSON_HEADERS)
        response.end(JSON.stringify({ error: `Unknown stadium key: ${stadiumKey}` }))
        return
      }
      try {
        await onStadiumChange(state.stadiumKey)
      } catch (error) {
        // A collector launch problem used to reject this async request without
        // a response, which Firefox reports only as "NetworkError". Keep the
        // chosen geometry and return the real failure so the page can explain
        // what needs attention.
        response.writeHead(500, JSON_HEADERS)
        response.end(JSON.stringify({
          error: `Stadium selected, but the collector could not react: ${error.message}`,
          stadium_key: state.stadiumKey,
        }))
        return
      }
      response.writeHead(200, JSON_HEADERS)
      response.end(JSON.stringify(trackerPreviewSnapshot(state, {
        selectedPaNumber: requestUrl.searchParams.get('at_bat'),
      })))
      return
    }

    // A replay is not required to calibrate raised-object contacts. Immediately
    // after seeing the impact, the operator can click that landmark on the park
    // artwork in the preview. Resolve the PA server-side so the browser only
    // supplies the image click; the measured world coordinates always come
    // from the tracker state that produced the at-bat.
    if (requestUrl.pathname === '/landing-calibration' && request.method === 'POST') {
      const parsed = await readJsonBody(request, response)
      if (!parsed) return
      const imageX = Number(parsed.image_x)
      const imageY = Number(parsed.image_y)
      if (!Number.isFinite(imageX) || !Number.isFinite(imageY)
        || imageX < 0 || imageX > 100 || imageY < 0 || imageY > 100) {
        response.writeHead(400, JSON_HEADERS)
        response.end(JSON.stringify({ error: 'image_x and image_y must be percentages from 0 to 100' }))
        return
      }

      const requestedPaNumber = requestUrl.searchParams.get('at_bat')
      const snapshot = trackerPreviewSnapshot(state, { selectedPaNumber: requestedPaNumber })
      const pa = snapshot.display_at_bat
      const raw = pa?.advanced_batted_ball_raw
      if (requestedPaNumber != null && Number(requestedPaNumber) !== Number(pa?.pa_number)) {
        response.writeHead(404, JSON_HEADERS)
        response.end(JSON.stringify({ error: `At-bat ${requestedPaNumber} is no longer available` }))
        return
      }
      // Calibrate the point the spray chart is actually plotting. For an
      // ordinary landing this equals the raw endpoint. For fair_fielded balls
      // it can instead be the trajectory's first Thwomp/ground impact; raw.x/y/z
      // are the later pickup and pairing a replay click with those coordinates
      // teaches the image calibration the wrong physical point.
      const world = { x: pa?.hit_world_x, y: pa?.hit_world_y, z: pa?.hit_world_z }
      // A ball whose position was PROJECTED rather than measured is marked too,
      // but it is a different kind of evidence and is kept in a different
      // record. The image calibration fit treats the world point as truth and
      // solves for the vertical; feeding it a computed landing would teach it
      // the projection's error instead. So projected balls are written as
      // TRACKER_PROJECTION_CALIBRATION, which fit_park_vertical.mjs does not
      // read -- it greps TRACKER_IMAGE_CALIBRATION and only that.
      //
      // What these records are FOR: inverting the clicked image point back
      // through the park's homography gives where the ball really came down, so
      // the projection's error can be read in feet rather than guessed at. That
      // is the only way to tell a bad carry projection from a bad ground
      // mapping, since both move the marker the same direction on screen.
      const isProjected = Boolean(pa?.hit_position_estimated)
        || !Number.isFinite(Number(world.y))
      const needed = isProjected ? [world.x, world.z] : [world.x, world.y, world.z]
      if (!needed.every((value) => Number.isFinite(Number(value)))) {
        response.writeHead(409, JSON_HEADERS)
        response.end(JSON.stringify({ error: 'This at-bat has no plotted position to calibrate' }))
        return
      }
      const stadiumKey = pa?.hit_stadium_key || snapshot.stadium_key
      if (!stadiumKey) {
        response.writeHead(409, JSON_HEADERS)
        response.end(JSON.stringify({ error: 'Pick the stadium before recording a calibration click' }))
        return
      }

      const record = {
        version: 1,
        stadium_key: stadiumKey,
        pa_number: pa.pa_number,
        batter: pa.batter_name || '',
        contact_seq: raw?.contactSeq ?? null,
        endpoint_seq: raw?.endpointSeq ?? null,
        x: Number(world.x),
        y: isProjected ? 0 : Number(world.y),
        z: Number(world.z),
        position_source: isProjected
          ? (pa.preview_projection?.distance_source || 'projected')
          : ((
            Number(world.x) !== Number(raw?.x)
            || Number(world.y) !== Number(raw?.y)
            || Number(world.z) !== Number(raw?.z)
          ) ? 'trajectory_first_impact' : 'endpoint'),
        image_x: Math.round(imageX * 10) / 10,
        image_y: Math.round(imageY * 10) / 10,
        automatic_image_x: pa.hit_x ?? null,
        automatic_image_y: pa.hit_y ?? null,
      }
      if (isProjected) {
        record.projected = true
        record.projected_distance_ft = pa.hit_distance_ft ?? null
        record.result = pa.result ?? null
      }
      const fields = Object.entries(record)
        .map(([key, value]) => `${key}=${value == null ? 'none' : String(value).replaceAll('|', '/')}`)
        .join('|')
      const line = `${isProjected ? 'TRACKER_PROJECTION_CALIBRATION' : 'TRACKER_IMAGE_CALIBRATION'}] ${fields}`
      onCalibrationRecord(line, record)
      response.writeHead(201, JSON_HEADERS)
      response.end(JSON.stringify(record))
      return
    }

    // The heavy evidence behind one 60 Hz play: every fielder's route, every
    // runner's splits, the throw chain, and the postgame restatement when one
    // exists. Deliberately NOT in /state -- an operator opens this for a play
    // they are questioning, which is a handful of times an inning, not sixty
    // times a minute.
    if (requestUrl.pathname === '/play') {
      const contactTimer = requestUrl.searchParams.get('contact_timer')
      const evidence = trackerPreviewPlayEvidence(state, contactTimer)
      if (!evidence) {
        response.writeHead(404, JSON_HEADERS)
        response.end(JSON.stringify({
          error: `No player-tracking play with contact_timer ${contactTimer}`,
        }))
        return
      }
      response.writeHead(200, JSON_HEADERS)
      response.end(JSON.stringify(evidence))
      return
    }

    // "Something is wrong." Appends one JSON line beside the capture and does
    // nothing else -- no statistic, no plate appearance, and no Supabase row is
    // touched by this path, in either process.
    if (requestUrl.pathname === '/annotations' && request.method === 'POST') {
      const parsed = await readJsonBody(request, response, 16384)
      if (!parsed) return
      const snapshot = trackerPreviewSnapshot(state, {
        selectedPaNumber: parsed.pa_number ?? requestUrl.searchParams.get('at_bat'),
      })
      if (parsed.pa_number != null
        && Number(parsed.pa_number) !== Number(snapshot.display_at_bat?.pa_number)) {
        response.writeHead(404, JSON_HEADERS)
        response.end(JSON.stringify({ error: `At-bat ${parsed.pa_number} is no longer available` }))
        return
      }
      const playContactTimer = parsed.play_contact_timer
        ?? snapshot.display_play?.contact_timer
        ?? null
      const playEvidence = playContactTimer == null
        ? null
        : trackerPreviewPlayEvidence(state, playContactTimer)
      const built = buildTrackerAnnotation({
        snapshot,
        categories: parsed.categories,
        note: parsed.note,
        clauseId: parsed.clause_id ?? null,
        playContactTimer,
        playEvidence,
      })
      if (built.error) {
        response.writeHead(400, JSON_HEADERS)
        response.end(JSON.stringify({ error: built.error, categories: ANNOTATION_CATEGORIES }))
        return
      }
      let filePath
      try {
        filePath = annotationPath()
        appendTrackerAnnotation(filePath, built.record)
      } catch (error) {
        response.writeHead(500, JSON_HEADERS)
        response.end(JSON.stringify({ error: `Could not write the annotation: ${error.message}` }))
        return
      }
      onAnnotation(built.record, filePath)
      response.writeHead(201, JSON_HEADERS)
      response.end(JSON.stringify({
        saved: true,
        path: filePath,
        pa_number: built.record.pa_number,
        categories: built.record.categories,
        clause_id: built.record.clause?.id ?? null,
        recorded_at: built.record.recorded_at,
      }))
      return
    }

    if (requestUrl.pathname === '/annotations') {
      const filePath = annotationPath()
      const records = readTrackerAnnotations(filePath)
      response.writeHead(200, JSON_HEADERS)
      response.end(JSON.stringify({
        path: filePath,
        count: records.length,
        categories: ANNOTATION_CATEGORIES,
        // Only what the page needs to show "you flagged this"; the full
        // records stay on disk where the investigation happens.
        annotations: records.map((record) => ({
          recorded_at: record.recorded_at,
          pa_number: record.pa_number,
          categories: record.categories,
          note: record.note,
          clause_id: record.clause?.id ?? null,
          clause_text: record.clause?.text ?? null,
          summary: record.narrative?.summary ?? null,
        })),
      }))
      return
    }

    if (requestUrl.pathname === '/pitch-diagnostics') {
      const snapshot = trackerPreviewSnapshot(state)
      const diagnostics = snapshot.session_pitch_diagnostics
      if (!diagnostics?.at_bat_count) {
        response.writeHead(404, JSON_HEADERS)
        response.end(JSON.stringify({ error: 'No at-bat is available yet' }))
        return
      }
      response.writeHead(200, {
        ...JSON_HEADERS,
        'Content-Disposition': 'attachment; filename="pitch-diagnostics-session.json"',
      })
      response.end(JSON.stringify(diagnostics, null, 2))
      return
    }

    if (requestUrl.pathname !== '/state') {
      response.writeHead(404, JSON_HEADERS)
      response.end(JSON.stringify({
        error: 'Use GET /state (optionally ?at_bat=N), GET /play?contact_timer=N, '
          + 'GET|POST /annotations, GET /pitch-diagnostics, POST /stadium, '
          + 'POST /landing-calibration, or POST /shutdown',
      }))
      return
    }
    // ?at_bat=N pages back to an earlier at-bat in this session. Only the
    // requested one is serialized, so paging through a long session costs the
    // same per poll as watching the live at-bat does.
    response.writeHead(200, JSON_HEADERS)
    response.end(JSON.stringify(trackerPreviewSnapshot(state, {
      selectedPaNumber: requestUrl.searchParams.get('at_bat'),
    })))
  })

  return server
}
