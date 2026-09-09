// A deliberately quiet same-origin proxy for the standalone tracker console.
//
// Vite's stock proxy prints a full ECONNREFUSED stack for every failed poll.
// That turns one stale browser tab into a wall of terminal noise after a test
// session ends. This middleware returns one useful JSON 503 to the page and
// leaves the terminal alone. It never stores or forwards data anywhere except
// the localhost tracker API selected by tracker:preview.
import http from 'node:http'

const PREFIX = '/tracker-api'

function isTrackerApiRequest(requestUrl) {
  return requestUrl === PREFIX
    || requestUrl.startsWith(`${PREFIX}/`)
    || requestUrl.startsWith(`${PREFIX}?`)
}

export function createTrackerPreviewProxyMiddleware({
  host = '127.0.0.1',
  port = 4317,
  timeoutMs = 3000,
} = {}) {
  return function trackerPreviewProxy(request, response, next) {
    const requestUrl = request.url || '/'
    if (!isTrackerApiRequest(requestUrl)) {
      next()
      return
    }

    const upstreamPath = requestUrl.slice(PREFIX.length) || '/'
    const upstream = http.request({
      hostname: host,
      port,
      method: request.method,
      path: upstreamPath,
      headers: { ...request.headers, host: `${host}:${port}` },
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers)
      upstreamResponse.pipe(response)
    })

    upstream.setTimeout(timeoutMs, () => {
      const error = new Error('Tracker API request timed out')
      error.code = 'ETIMEDOUT'
      upstream.destroy(error)
    })
    upstream.on('error', (error) => {
      if (response.writableEnded) return
      if (response.headersSent) {
        response.destroy(error)
        return
      }
      response.writeHead(503, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Tracker-Database-Writes': 'disabled',
      })
      response.end(JSON.stringify({
        error: 'The local tracker API is offline. Close stale preview tabs and run npm run tracker:preview.',
        code: error.code || 'TRACKER_API_UNAVAILABLE',
      }))
    })

    request.on('aborted', () => upstream.destroy())
    request.pipe(upstream)
  }
}

export function trackerPreviewViteProxy(options = {}) {
  return {
    name: 'tracker-preview-local-api',
    configureServer(server) {
      server.middlewares.use(createTrackerPreviewProxyMiddleware(options))
    },
  }
}
