# Nearest Earthquake — Screenly Edge App

Shows the single nearest earthquake to this screen and how far away it is.

Two files: `screenly.yml` and `index.html`. No stylesheet, no libraries, no
settings. Distances in kilometres. Data from the public USGS feed (all magnitudes,
past 24 hours), refreshed every 5 minutes.

Needs a player: it reads the screen's coordinates and the CORS proxy from the
injected `screenly.js` bridge, so it will not run in a plain browser.

## Deploy

```bash
screenly edge-app deploy
```
