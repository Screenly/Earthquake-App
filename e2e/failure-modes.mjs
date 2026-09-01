/* eslint-disable no-undef --
   This file legitimately spans two global scopes and ESLint cannot tell them
   apart: `console`/`process` belong to the Node script, while `document`,
   `window` and `localStorage` only appear inside page.evaluate() callbacks,
   whose bodies are serialised and run in the browser. */
// Exercises every branch of the approved failure-mode diagram against the BUILT
// dist/, with a stub screenly.js standing in for the player bridge.
import { chromium } from 'playwright'
import http from 'http'
import fs from 'fs'
import path from 'path'

const DIST = path.join(import.meta.dirname, '..', 'dist')
const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
}

const now = Date.now()
const FEED = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    ['2 km SSW of Saratoga, CA', 1.55, -122.0288, 37.248, 18],
    ['2 km SE of Pacifica, CA', 1.5, -122.4645, 37.6003, 90],
    ['4 km NW of Pinnacles, CA', 1.3, -121.173, 36.5607, 400],
    ['5 km NNE of Kenwood, CA', 1.31, -122.5243, 38.4528, 900],
    ['2 km N of The Geysers, CA', 2.27, -122.7595, 38.7928, 1500],
  ].map(([place, mag, lng, lat, mins]) => ({
    type: 'Feature',
    properties: { mag, place, time: now - mins * 60000 },
    geometry: { type: 'Point', coordinates: [lng, lat, 5] },
  })),
})

const STUB = (settings) => `
window.screenly = {
  metadata: {
    coordinates: window.__COORDS__ || [],
    location: "Silicon Valley, USA",
    hostname: "srly-test", screen_name: "Test", hardware: "x86", tags: []
  },
  settings: ${JSON.stringify(settings)},
  cors_proxy_url: "http://127.0.0.1:8123/cors",
  signalReadyForRendering: function () {
    window.__READY__ = (window.__READY__ || 0) + 1;
  }
};`

let settings = { units: 'miles' }

const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0]
  if (p === '/') p = '/index.html'
  if (p === '/screenly.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' })
    return res.end(STUB(settings))
  }
  const f = path.join(DIST, p)
  if (!fs.existsSync(f)) {
    res.writeHead(404)
    return res.end()
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' })
  res.end(fs.readFileSync(f))
})

const results = []
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ ok, name, actual, expected })
}

async function probe(page) {
  return page.evaluate(() => {
    const t = (id) => document.getElementById(id).textContent
    return {
      ready: window.__READY__ || 0,
      state: document.getElementById('stage').className || '(content)',
      mag: t('mag'),
      spot: t('spot'),
      distance: t('distance'),
      where: t('where'),
      cached: !!localStorage.getItem('earthquake-app:nearest'),
      cacheBytes: (localStorage.getItem('earthquake-app:nearest') || '').length,
      land: (document.getElementById('land').getAttribute('d') || '').length,
      // The overlay also puts a class on <body>, so match the modal itself.
      panic: !!document.querySelector('.panic-overlay__modal'),
      panicText: (
        document.querySelector('.panic-overlay__modal')?.textContent || ''
      ).slice(0, 400),
    }
  })
}

await new Promise((r) => server.listen(8123, r))
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM }
    : {},
)

const LOCATED = ['37.3861', '-122.0839']
async function newPage(ctx, coords = LOCATED) {
  const page = await ctx.newPage()
  await page.addInitScript((c) => {
    window.__COORDS__ = c
    window.__READY__ = 0
  }, coords)
  return page
}

// ── 1. feed OK ────────────────────────────────────────────────────────────────
{
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
  })
  const page = await newPage(ctx)
  await page.route('**/cors/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: FEED }),
  )
  await page.goto('http://127.0.0.1:8123/', { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  const s = await probe(page)
  check('1 feed OK  -> shows content', s.state, '(content)')
  check('1 feed OK  -> nearest quake drawn', s.spot, '2 km SSW of Saratoga, CA')
  check('1 feed OK  -> map painted', s.land > 400000, true)
  check('1 feed OK  -> wrote cache', s.cached, true)
  check('1 feed OK  -> signalled once', s.ready, 1)
  console.log(`   cache is ${s.cacheBytes} bytes`)

  // ── 2. feed fails, display_errors off, cache present ─────────────────────────
  const page2 = await newPage(ctx)
  await page2.route('**/cors/**', (r) => r.abort())
  await page2.goto('http://127.0.0.1:8123/', { waitUntil: 'load' })
  await page2.waitForTimeout(900)
  const s2 = await probe(page2)
  check('2 fail+cache -> shows content', s2.state, '(content)')
  check(
    '2 fail+cache -> from last reading',
    s2.spot,
    '2 km SSW of Saratoga, CA',
  )
  check('2 fail+cache -> signalled once', s2.ready, 1)
  check('2 fail+cache -> no error overlay', s2.panic, false)
  await ctx.close()
}

// ── 3. feed fails, display_errors off, no cache -> abort state ────────────────
{
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
  })
  const page = await newPage(ctx)
  await page.route('**/cors/**', (r) => r.abort())
  await page.goto('http://127.0.0.1:8123/', { waitUntil: 'load' })
  await page.waitForTimeout(900)
  const s = await probe(page)
  check('3 fail+no cache -> abort state', s.state, 'unavailable')
  check('3 fail+no cache -> says unavailable', s.where, 'Unavailable')
  check('3 fail+no cache -> still signalled once', s.ready, 1)
  await ctx.close()
}

// ── 4. feed fails, display_errors ON -> error shown, still signals ────────────
{
  settings = { units: 'miles', display_errors: 'true' }
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
  })
  const page = await newPage(ctx)
  await page.route('**/cors/**', (r) => r.abort())
  await page.goto('http://127.0.0.1:8123/', { waitUntil: 'load' })
  await page.waitForTimeout(1200)
  const s = await probe(page)
  check('4 display_errors -> error overlay shown', s.panic, true)
  check('4 display_errors -> no cache fallback', s.state, '(content)')
  check('4 display_errors -> still signalled', s.ready >= 1, true)
  await ctx.close()
  settings = { units: 'miles' }
}

// ── 5. unlocated screen ───────────────────────────────────────────────────────
{
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
  })
  const page = await newPage(ctx, [])
  let fetched = false
  await page.route('**/cors/**', (r) => {
    fetched = true
    r.abort()
  })
  await page.goto('http://127.0.0.1:8123/', { waitUntil: 'load' })
  await page.waitForTimeout(700)
  const s = await probe(page)
  check('5 unlocated -> unlocated state', s.state, 'unlocated')
  check('5 unlocated -> never fetches', fetched, false)
  check('5 unlocated -> signalled once', s.ready, 1)
  await ctx.close()
}

// ── 6. units setting ──────────────────────────────────────────────────────────
{
  settings = { units: 'km' }
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
  })
  const page = await newPage(ctx)
  await page.route('**/cors/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: FEED }),
  )
  await page.goto('http://127.0.0.1:8123/', { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  const s = await probe(page)
  check('6 units=km -> kilometres', s.distance.endsWith(' km'), true)
  await ctx.close()
  settings = { units: 'miles' }
}

// ── 7. a hanging feed must time out inside the budget ─────────────────────────
{
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
  })
  const page = await newPage(ctx)
  await page.route('**/cors/**', () => {
    /* never respond */
  })
  const started = Date.now()
  await page.goto('http://127.0.0.1:8123/', { waitUntil: 'commit' })
  await page.waitForFunction(() => (window.__READY__ || 0) > 0, null, {
    timeout: 15000,
  })
  const elapsed = Date.now() - started
  const s = await probe(page)
  check('7 hang -> signals despite no response', s.ready, 1)
  check('7 hang -> lands in abort state', s.state, 'unavailable')
  check('7 hang -> inside the 10s budget', elapsed < 10000, true)
  console.log(`   signalled after ${elapsed} ms`)
  await ctx.close()
}

// ── 8. HTTP error status is treated as a failure ──────────────────────────────
{
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
  })
  const page = await newPage(ctx)
  await page.route('**/cors/**', (r) =>
    r.fulfill({ status: 503, body: 'nope' }),
  )
  await page.goto('http://127.0.0.1:8123/', { waitUntil: 'load' })
  await page.waitForTimeout(900)
  const s = await probe(page)
  check('8 HTTP 503 -> abort state', s.state, 'unavailable')
  check('8 HTTP 503 -> signalled once', s.ready, 1)
  await ctx.close()
}

// ── 9. 200 OK that is not a feed -> narrowed, not asserted ─────────────────
{
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
  })
  const page = await newPage(ctx)
  await page.route('**/cors/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'upstream unavailable' }),
    }),
  )
  await page.goto('http://127.0.0.1:8123/', { waitUntil: 'load' })
  await page.waitForTimeout(900)
  const s = await probe(page)
  check('9 junk payload -> abort state', s.state, 'unavailable')
  check('9 junk payload -> signalled once', s.ready, 1)
  check('9 junk payload -> no error overlay', s.panic, false)
  await ctx.close()

  // Without the narrowing this reads "Cannot read properties of undefined",
  // which tells whoever turned display_errors on nothing about the feed.
  settings = { units: 'miles', display_errors: 'true' }
  const ctx2 = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
  })
  const page2 = await newPage(ctx2)
  await page2.route('**/cors/**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'upstream unavailable' }),
    }),
  )
  await page2.goto('http://127.0.0.1:8123/', { waitUntil: 'load' })
  await page2.waitForTimeout(1200)
  const s2 = await probe(page2)
  check(
    '9 junk + display_errors -> names the feed',
    s2.panicText.includes('features array'),
    true,
  )
  await ctx2.close()
  settings = { units: 'miles' }
}

await browser.close()
server.close()

console.log()
let failed = 0
for (const r of results) {
  if (!r.ok) failed++
  console.log(
    `${r.ok ? '  PASS' : '  FAIL'}  ${r.name}${r.ok ? '' : `  (got ${JSON.stringify(r.actual)}, want ${JSON.stringify(r.expected)})`}`,
  )
}
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
