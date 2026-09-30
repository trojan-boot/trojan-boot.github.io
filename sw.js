/*
 * Tower's service worker: the sign-in header on media requests.
 *
 * The server authenticates a stream with an Authorization header and refuses
 * a token anywhere else — verified against a live deployment, where a
 * `<video src>` without one gets 403 and a `?token=` gets the same. A media
 * element sends its own requests and offers no way to add a header to them.
 * A service worker sits between the element and the network and can: every
 * request the page makes passes through `fetch` below, and the ones for a
 * stream go out again with the header on.
 *
 * It does nothing else. No caching, no offline page. Requests that are not
 * for a stream are not touched, and a stream request that already carries a
 * header (the music player's own fetches) is passed through as it is.
 *
 * The credentials are held in memory and sent by the page — on registration,
 * whenever the session changes, and on request when this worker has been
 * restarted and forgotten them, which browsers do without notice.
 */

const STREAM_PATH = /\/api\/media\/.+\/stream(\/|$|\?)/
/** A teaser clip's own file route — same auth requirement, same range-serving. */
const TEASER_FILE_PATH = /\/api\/media\/items\/[^/]+\/teasers\/[^/]+\/file(\/|$|\?)/
/** A `<track src>` fetches this itself with no way to add a header, same as `<video>`. */
const SUBTITLE_PATH = /\/api\/media\/items\/[^/]+\/subtitles\/\d+(\/|$|\?)/

let credentials = { token: null, profileId: null }

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  // Take over open pages straight away, so the first visit's video plays
  // without a reload.
  event.waitUntil(self.clients.claim())
})

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'tower:credentials') {
    credentials = event.data.credentials || { token: null, profileId: null }
  }
})

/** Ask an open page for the credentials; give up quietly after a moment. */
async function askAPage() {
  const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  if (pages.length === 0) return
  await new Promise((resolve) => {
    const channel = new MessageChannel()
    const timer = setTimeout(resolve, 1500)
    channel.port1.onmessage = (reply) => {
      if (reply.data && reply.data.type === 'tower:credentials') {
        credentials = reply.data.credentials || credentials
      }
      clearTimeout(timer)
      resolve()
    }
    pages[0].postMessage({ type: 'tower:credentials?' }, [channel.port2])
  })
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  const path = url.pathname + url.search
  if (!STREAM_PATH.test(path) && !TEASER_FILE_PATH.test(path) && !SUBTITLE_PATH.test(path)) return
  if (request.headers.has('Authorization')) return

  event.respondWith(
    (async () => {
      if (!credentials.token) await askAPage()

      const headers = new Headers()
      // The Range header is the whole mechanism of seeking; it must survive.
      const range = request.headers.get('Range')
      if (range) headers.set('Range', range)
      headers.set('ngrok-skip-browser-warning', 'true')
      if (credentials.token) headers.set('Authorization', 'Bearer ' + credentials.token)
      if (credentials.profileId) headers.set('X-Profile-Id', credentials.profileId)

      try {
        const response = await fetch(
          new Request(request.url, {
            method: 'GET',
            headers,
            mode: 'cors',
            credentials: 'omit',
            cache: 'no-store',
          }),
        )
        return response
      } catch (cause) {
        // A rejected promise here reaches the page as a bare network error
        // with no reason attached. A 502 with the reason in it can be read
        // in devtools, and the media element fails the same way either way.
        return new Response('Tower service worker could not reach the server: ' + (cause && cause.message), {
          status: 502,
          headers: { 'Content-Type': 'text/plain' },
        })
      }
    })(),
  )
})
