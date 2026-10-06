import { test } from '@playwright/test'
import {
  createMockScreenlyForScreenshots,
  FIXED_SCREENSHOT_DATE,
  getScreenshotsDir,
  RESOLUTIONS,
  setupClockMock,
  setupScreenlyJsMock,
} from '@screenly/edge-apps/test/screenshots'
import path from 'path'

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000

// One nearby quake, frozen against the screenshot clock, so every resolution
// shows the same callout. The view's minimum width already frames the coast.
const MOCK_FEED = {
  features: [
    {
      properties: {
        mag: 1.6,
        place: '2 km SSW of Saratoga, CA',
        time: FIXED_SCREENSHOT_DATE.getTime() - TWO_DAYS_MS,
      },
      geometry: {
        coordinates: [-122.031679, 37.247186, 8],
      },
    },
  ],
}

const { screenlyJsContent } = createMockScreenlyForScreenshots(
  {
    coordinates: [37.3861, -122.0839],
    location: 'Silicon Valley, USA',
  },
  {
    units: 'miles',
    display_errors: 'false',
  },
)

for (const { width, height } of RESOLUTIONS) {
  test(`screenshot ${width}x${height}`, async ({ browser }) => {
    const screenshotsDir = getScreenshotsDir()

    const context = await browser.newContext({ viewport: { width, height } })
    const page = await context.newPage()

    await setupClockMock(page)
    await setupScreenlyJsMock(page, screenlyJsContent)

    await page.route('**/*all_week.geojson*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_FEED),
      })
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.waitForFunction(
      () => document.getElementById('mag')?.textContent === '1.6',
    )

    await page.screenshot({
      path: path.join(screenshotsDir, `earthquake-app-${width}x${height}.png`),
      fullPage: false,
    })

    await context.close()
  })
}
