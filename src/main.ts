import './style.css'
import {
  getSettingWithDefault,
  readEdgeAppCache,
  setupErrorHandling,
  signalReady,
  writeEdgeAppCache,
} from '@screenly/edge-apps'

import worldSvg from './world.svg?raw'

/** One earthquake, trimmed to the fields this app actually draws. */
interface Quake {
  mag: number
  place: string
  time: number
  lat: number
  lng: number
}

interface FeedFeature {
  properties: { mag: number | null; place: string; time: number }
  geometry: { coordinates: [number, number, number] }
}

const CACHE_NAMESPACE = 'earthquake-app'
const CACHE_KEY = 'nearest'

const RADIANS = Math.PI / 180
const KM_PER_DEGREE = 111

/** Where "you" sit in the view, as a fraction across and down. */
const YOU_ACROSS = 0.5
const YOU_DOWN = 0.5

// Looked up in start(), not here. This file is bundled as a classic script and
// inlined into <head>, so module scope runs before <body> exists — resolving
// these eagerly would leave them null.
let stage!: HTMLElement
let map!: HTMLElement
let world!: SVGSVGElement

/** Where the screen itself is, from the player metadata. Everything is relative to it. */
let screenLat = NaN
let screenLng = NaN

let nearestQuakes: Quake[] = []
let viewKm = 0
let west = 0
let east = 0
let north = 0
let south = 0

function say(id: string, text: string): void {
  document.getElementById(id)!.textContent = text
}

function setD(id: string, d: string): void {
  document.getElementById(id)!.setAttribute('d', d)
}

/**
 * Longitudes are wrapped into the half-turn either side of the screen, so a
 * quake just over the antimeridian reads as near rather than half a world away.
 */
function longitudeOf(quake: Quake): number {
  if (quake.lng - screenLng > 180) return quake.lng - 360
  if (quake.lng - screenLng < -180) return quake.lng + 360
  return quake.lng
}

function kmAway(quake: Quake): number {
  // Haversine: 2R·asin(√h). 12742 km is the Earth's mean diameter, the 2R.
  const earthDiameterKm = 12742
  const lat1 = screenLat * RADIANS
  const lat2 = quake.lat * RADIANS
  const dLat = lat2 - lat1
  const dLng = (longitudeOf(quake) - screenLng) * RADIANS
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2)
  return earthDiameterKm * Math.asin(Math.sqrt(h))
}

function heading(quake: Quake): string {
  const compass = [
    'N',
    'NNE',
    'NE',
    'ENE',
    'E',
    'ESE',
    'SE',
    'SSE',
    'S',
    'SSW',
    'SW',
    'WSW',
    'W',
    'WNW',
    'NW',
    'NNW',
  ]
  const lat1 = screenLat * RADIANS
  const lat2 = quake.lat * RADIANS
  const dLng = (longitudeOf(quake) - screenLng) * RADIANS
  const y = Math.sin(dLng) * Math.cos(lat2)
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  return compass[
    Math.round(((Math.atan2(y, x) / RADIANS + 360) % 360) / 22.5) % 16
  ]!
}

/** The screen's height over its width — the map window is fitted to it. */
function shape(): number {
  return map.clientHeight / map.clientWidth
}

function frame(width: number): void {
  const wide = width / KM_PER_DEGREE / Math.cos(screenLat * RADIANS)
  const high = (width / KM_PER_DEGREE) * shape()
  west = screenLng - wide * YOU_ACROSS
  east = west + wide
  north = screenLat + high * YOU_DOWN
  south = north - high
  world.setAttribute('viewBox', `${west} ${-north} ${wide} ${high}`)
}

/**
 * Wide enough to hold the quakes we kept. Only the closest is marked, but that
 * framing gives it a region to sit in rather than a featureless close-up.
 */
function widthToFitKept(quakes: Quake[]): number {
  const narrowestKm = 1500
  const widestKm = 12000
  let needed = 0
  for (const quake of quakes) {
    const up = Math.abs(quake.lat - screenLat)
    const along = Math.abs(longitudeOf(quake) - screenLng)
    needed = Math.max(
      needed,
      (along / YOU_ACROSS) * KM_PER_DEGREE * Math.cos(screenLat * RADIANS),
    )
    needed = Math.max(needed, ((up / YOU_DOWN) * KM_PER_DEGREE) / shape())
  }
  return Math.max(narrowestKm, Math.min(needed * 1.8, widestKm))
}

function inView(quake: Quake): boolean {
  const lng = longitudeOf(quake)
  return quake.lat > south && quake.lat < north && lng > west && lng < east
}

function at(element: HTMLElement, lat: number, lng: number): void {
  element.style.left = `${((lng - west) / (east - west)) * 100}%`
  element.style.top = `${((north - lat) / (north - south)) * 100}%`
}

function away(quake: Quake): string {
  const km = kmAway(quake)
  if (getSettingWithDefault<string>('units', 'miles') === 'km') {
    return `${Math.round(km)} km`
  }
  return `${Math.round(km / 1.609)} mi`
}

function ago(quake: Quake): string {
  const minutes = Math.round((Date.now() - quake.time) / 60000)
  if (minutes < 60) return `${minutes} min`
  if (minutes < 1440) return `${Math.round(minutes / 60)} hr`
  return `${Math.round(minutes / 1440)} d`
}

function degrees(value: number, positive: string, negative: string): string {
  return `${Math.abs(value).toFixed(3)}° ${value < 0 ? negative : positive}`
}

function graticule(): void {
  let step = 0.2
  for (const choice of [20, 10, 5, 2, 1, 0.5]) {
    if (choice <= (north - south) / 6) step = Math.max(step, choice)
  }
  let d = ''
  for (let lng = Math.ceil(west / step) * step; lng < east; lng += step) {
    d += `M${lng} ${-north}V${-south}`
  }
  for (let lat = Math.ceil(south / step) * step; lat < north; lat += step) {
    d += `M${west} ${-lat}H${east}`
  }
  setD('graticule', d)
}

function draw(): void {
  frame(viewKm)
  const quake = nearestQuakes.find(inView)
  if (!quake) return

  graticule()
  at(document.getElementById('you') as HTMLElement, screenLat, screenLng)
  at(
    document.getElementById('nearest') as HTMLElement,
    quake.lat,
    longitudeOf(quake),
  )
  setD(
    'reach',
    `M${screenLng} ${-screenLat}L${longitudeOf(quake)} ${-quake.lat}`,
  )

  say('mag', quake.mag.toFixed(1))
  say('spot', quake.place)
  say('distance', away(quake))
  say('direction', heading(quake))
  say('when', ago(quake))
}

function show(quakes: Quake[]): void {
  stage.className = ''
  nearestQuakes = quakes
  viewKm = widthToFitKept(quakes)
  draw()
}

/**
 * The diagram's Abort terminal. `screenly.signalAbort()` does not exist yet
 * (Phorge T10903), so until it does we say what happened and let the ready
 * signal through — an app that never signals stalls the playlist for 60s and
 * is then dropped with PlaybackReason::LoadTimeout.
 */
function abort(): void {
  stage.className = 'unavailable'
  say('lede', 'Earthquake data')
  say('where', 'Unavailable')
  say('coord', 'The USGS feed could not be reached and nothing is cached')
}

/**
 * What comes back off the wire is unknown, so it is narrowed rather than
 * asserted. This checks the envelope only — enough to tell a feed from the
 * proxy handing back an error page. Individual features are not validated;
 * anything malformed inside one falls out in nearestKept or reads as NaN.
 */
function hasFeatures(value: unknown): value is { features: FeedFeature[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { features?: unknown }).features)
  )
}

/** Nearest first, trimmed to what is drawn, capped at what the view needs. */
function nearestKept(features: FeedFeature[]): Quake[] {
  // Only the ten nearest are kept: they size the view, and the closest is drawn.
  const kept = 10
  return features
    .filter((feature) => feature.properties.mag !== null)
    .map((feature) => ({
      mag: feature.properties.mag as number,
      place: feature.properties.place,
      time: feature.properties.time,
      lat: feature.geometry.coordinates[1],
      lng: feature.geometry.coordinates[0],
    }))
    .sort((a, b) => kmAway(a) - kmAway(b))
    .slice(0, kept)
}

/**
 * The approved failure-mode algorithm, minus the credential half — this feed is
 * public, so there is nothing to authenticate.
 *
 *   fetch -> ok        : cache it, show it
 *         -> failed    : display_errors ? show the error
 *                                       : cached ? show that : abort
 */
async function load(): Promise<void> {
  // The screenshotter gives the page 10s to go quiet and then up to 10s more
  // for the ready signal. Time the feed out well inside that, so a hanging USGS
  // still leaves room to fall back to cache, draw, and signal.
  const fetchTimeoutMs = 8000
  try {
    const feedUrl = `${screenly.cors_proxy_url}/https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_week.geojson`
    const response = await fetch(feedUrl, {
      signal: AbortSignal.timeout(fetchTimeoutMs),
    })
    if (!response.ok) {
      throw new Error(
        `USGS feed returned ${response.status} ${response.statusText}`,
      )
    }
    const feed: unknown = await response.json()
    if (!hasFeatures(feed)) throw new Error('USGS feed had no features array')
    const quakes = nearestKept(feed.features)
    writeEdgeAppCache(CACHE_NAMESPACE, CACHE_KEY, quakes)
    show(quakes)
  } catch (error) {
    if (getSettingWithDefault<boolean>('display_errors', false)) throw error

    const cached = readEdgeAppCache<Quake[]>(CACHE_NAMESPACE, CACHE_KEY)
    if (cached && cached.length > 0) show(cached)
    else abort()
  }
}

/** A screen with 0,0 or no coordinates has not been placed, it is not at sea. */
function positioned(): boolean {
  if (!isFinite(screenLat) || !isFinite(screenLng)) return false
  return screenLat !== 0 || screenLng !== 0
}

async function start(): Promise<void> {
  setupErrorHandling()

  stage = document.getElementById('stage') as HTMLElement
  map = document.getElementById('map') as HTMLElement
  map.insertAdjacentHTML('afterbegin', worldSvg)
  world = document.querySelector<SVGSVGElement>('#world')!

  // The bridge hands coordinates over as strings; `+` on a string silently
  // poisons every sum downstream, so they are converted on the way in.
  const given = screenly.metadata.coordinates ?? []
  screenLat = Number(given[0])
  screenLng = Number(given[1])

  if (!positioned()) {
    stage.className = 'unlocated'
    say('lede', 'This screen')
    say('where', 'No location set')
    say('coord', 'Add one in Screenly and the map will follow')
    signalReady()
    return
  }

  say('where', screenly.metadata.location || 'This screen')
  say(
    'coord',
    `${degrees(screenLat, 'N', 'S')}, ${degrees(screenLng, 'E', 'W')}`,
  )
  window.addEventListener('resize', draw)

  await load()
  signalReady()

  const refreshMs = 300000
  setInterval(() => void load(), refreshMs)
}

document.addEventListener('DOMContentLoaded', () => void start())
