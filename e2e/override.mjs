/* eslint-disable no-undef --
   This file spans two global scopes: `console`/`process` belong to Node, while
   `document` and `window` only appear inside page.evaluate() and
   addInitScript() callbacks, which run in the browser. */
// A screen with no device fix can still be placed by override_coordinates, and
// override_locale changes the decimal mark. Runs against the built dist/.
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

const FEED = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        mag: 1.55,
        place: '2 km SSW of Saratoga, CA',
        time: Date.now() - 18 * 60000,
      },
      geometry: { type: 'Point', coordinates: [-122.0288, 37.248, 5] },
    },
  ],
})

const stub = (settings) => `
window.screenly = {
  metadata: {
    coordinates: window.__COORDS__ || [],
    location: "Silicon Valley, USA",
    hostname: "srly-test", screen_name: "Test", hardware: "x86", tags: []
  },
  settings: ${JSON.stringify(settings)},
  cors_proxy_url: "http://127.0.0.1:8124/cors",
  signalReadyForRendering: function () { window.__READY__ = (window.__READY__ || 0) + 1; }
};`

let settings = {}

const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0]
  if (p === '/') p = '/index.html'
  if (p === '/screenly.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' })
    return res.end(stub(settings))
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

await new Promise((r) => server.listen(8124, r))
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM }
    : {},
)

async function open(coords) {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
  })
  const page = await context.newPage()
  await page.addInitScript((c) => {
    window.__COORDS__ = c
    window.__READY__ = 0
  }, coords)
  return { context, page }
}

async function read(page) {
  return page.evaluate(() => ({
    state: document.getElementById('stage').className || '(content)',
    coord: document.getElementById('coord').textContent,
    where: document.getElementById('where').textContent,
  }))
}

{
  settings = {
    units: 'miles',
    override_coordinates: '51.5074,-0.1278',
    override_locale: 'de',
  }
  const { context, page } = await open([])
  await page.route('**/cors/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: FEED,
    }),
  )
  await page.goto('http://127.0.0.1:8124/', { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  const view = await read(page)
  check('override -> shows content without a device fix', view.state, '(content)')
  check(
    'override -> German decimals on the typed position',
    view.coord,
    '51,507° N, 0,128° W',
  )
  check('override -> names the typed position', view.where, 'Totteridge, United Kingdom')
  await context.close()
}

{
  settings = { units: 'miles', override_coordinates: 'nope' }
  const { context, page } = await open([])
  let fetched = false
  await page.route('**/cors/**', (route) => {
    fetched = true
    route.abort()
  })
  await page.goto('http://127.0.0.1:8124/', { waitUntil: 'load' })
  await page.waitForTimeout(700)
  const view = await read(page)
  check('bad override + no fix -> unlocated', view.state, 'unlocated')
  check('bad override + no fix -> never fetches', fetched, false)
  await context.close()
}

await browser.close()
server.close()

let failed = 0
for (const result of results) {
  if (!result.ok) failed++
  const detail = result.ok
    ? ''
    : `  (got ${JSON.stringify(result.actual)}, want ${JSON.stringify(result.expected)})`
  console.log(`${result.ok ? '  PASS' : '  FAIL'}  ${result.name}${detail}`)
}
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
