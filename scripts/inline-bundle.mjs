/* eslint-disable no-undef -- Node build script; the shared config sets browser globals only. */
// Folds dist/css/*.css and dist/js/*.js back into dist/index.html, so the Edge
// App deploys as a single self-contained file.
//
// Why: a three-file revision (index.html plus ./js and ./css subdirectories)
// would not render — the player sat in a "downloading content" loop and the
// screenshotter returned 500 on the capture. The same app as one file renders
// fine. Measured 23 Aug 2026 against revisions 49 and 50.
//
// Inlining also drops the `type="module"` and `crossorigin` attributes Vite
// emits. The bundle is an IIFE with no top-level imports, so it does not need
// them, and without them there is no subresource fetch and no CORS for a player
// to get wrong.

import fs from 'fs'
import path from 'path'

const DIST = 'dist'
const htmlPath = path.join(DIST, 'index.html')

if (!fs.existsSync(htmlPath)) {
  console.error(`inline-bundle: ${htmlPath} not found — run the build first`)
  process.exit(1)
}

const read = (rel) => fs.readFileSync(path.join(DIST, rel), 'utf8')

// A literal </script> inside the bundle would close the tag early.
const escapeForScript = (js) => js.replace(/<\/script/gi, '<\\/script')

let html = fs.readFileSync(htmlPath, 'utf8')
const inlined = []

// Only ./-relative refs are ours. screenly.js is injected by the player at
// runtime and must stay an external tag.
html = html.replace(
  /<link\b[^>]*rel="stylesheet"[^>]*href="\.\/([^"]+)"[^>]*>/gi,
  (_match, rel) => {
    inlined.push(rel)
    return `<style>\n${read(rel)}\n</style>`
  },
)

html = html.replace(
  /<script\b[^>]*\bsrc="\.\/([^"]+)"[^>]*><\/script>/gi,
  (_match, rel) => {
    inlined.push(rel)
    return `<script>\n${escapeForScript(read(rel))}\n</script>`
  },
)

if (inlined.length === 0) {
  console.error(
    'inline-bundle: nothing to inline — did the build output change?',
  )
  process.exit(1)
}

fs.writeFileSync(htmlPath, html)

for (const dir of ['js', 'css']) {
  fs.rmSync(path.join(DIST, dir), { recursive: true, force: true })
}

const bytes = fs.statSync(htmlPath).size
console.log(
  `inline-bundle: folded ${inlined.join(', ')} into index.html (${bytes} bytes, single file)`,
)
