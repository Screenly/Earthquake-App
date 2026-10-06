import { getSettingWithDefault } from '@screenly/edge-apps'
import { getNearestCity } from 'offline-geocode-city'

export interface Position {
  lat: number
  lng: number
  /** True when these coordinates came from the override setting. */
  overridden: boolean
}

/**
 * A typed "lat, lng" pair, or null when it is blank or not a real position.
 * An explicit 0,0 is kept: that is a point in the Gulf of Guinea, whereas the
 * same pair from the player means the screen has not been placed.
 */
function parseCoordinates(value: string): [number, number] | null {
  const pieces = value.split(',').map((piece) => piece.trim())
  // Number('') is 0, so a blank half would otherwise read as the equator or meridian.
  if (pieces.length !== 2 || pieces.some((piece) => piece === '')) return null
  const parts = pieces.map(Number)
  if (parts.some((part) => !Number.isFinite(part))) return null
  const latitude = parts[0]!
  const longitude = parts[1]!
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null
  return [latitude, longitude]
}

/**
 * Where the map is centred. A valid override wins; otherwise the player's own
 * coordinates. A missing or 0,0 fix means the screen has not been placed.
 */
export function resolvePosition(): Position | null {
  const override = getSettingWithDefault<string>(
    'override_coordinates',
    '',
  ).trim()
  if (override) {
    const parsed = parseCoordinates(override)
    if (parsed) return { lat: parsed[0], lng: parsed[1], overridden: true }
    console.warn(`Invalid coordinate override: "${override}"`)
  }

  const given = screenly.metadata.coordinates ?? []
  const lat = Number(given[0])
  const lng = Number(given[1])
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
  if (lat === 0 && lng === 0) return null
  return { lat, lng, overridden: false }
}

/**
 * The heading under "You are here". An override names the nearest city to
 * those coordinates, so the screen's saved location is not left on screen.
 * With no override, the heading is the screen's own location.
 */
export async function placeLabel(position: Position): Promise<string> {
  if (!position.overridden) {
    return screenly.metadata.location?.trim() || 'This screen'
  }
  try {
    const nearest = await getNearestCity(position.lat, position.lng)
    const city = nearest.cityName?.trim()
    const country = nearest.countryName?.trim()
    if (city && country && city !== country) return `${city}, ${country}`
    if (city || country) return city || country
  } catch (error) {
    console.warn('Could not name the override coordinates:', error)
  }
  return 'This screen'
}

/**
 * The locale the numbers are written in. An unrecognised code stays English.
 * Resolved here, not via getLocale(), because that helper geocodes the player
 * coordinates and pulls in a chunk this single-file app does not ship.
 */
export function resolveLocale(): string {
  const requested = getSettingWithDefault<string>('override_locale', 'en')
    .trim()
    .replaceAll('_', '-')
  if (!requested) return 'en'
  try {
    const resolved = new Intl.DateTimeFormat(requested).resolvedOptions().locale
    const wanted = requested.toLowerCase().split('-')[0]
    const got = resolved.toLowerCase().split('-')[0]
    if (wanted === got) return requested
  } catch {
    // Unrecognised locale: keep English.
  }
  console.warn(`Invalid locale override: "${requested}"`)
  return 'en'
}
