# Earthquakes Near This Screen — Screenly Edge App

A map centred on the screen's own location. The nearest earthquake is called out
— magnitude, place, distance, direction, how long ago — with a dashed line from
the screen to it. One quake, not a scatter of them: nothing else is marked.
Nothing moves and nothing animates; the feed is refetched every five minutes.

The map runs full bleed and the type sits on it in glass panels: the same paper a
shade down, blurred, with a hairline edge, so the coastlines still read through
them. A screen with no location set says exactly that instead of guessing — the
map and the readout are hidden and it asks for a location.

Two files: `screenly.yml` and `index.html`. No libraries, no build step, no web
fonts, nothing fetched but the data, one setting (miles or kilometres). Data
from the public USGS feed, all magnitudes, past 7 days.

## How the map works

The map inlined in `index.html` is a flat (equirectangular) world drawn from
public-domain Natural Earth outlines, so placing a point is arithmetic rather
than a mapping library:
longitude is a fraction across the view, latitude a fraction down. The view is a
window on it, centred on the screen and sized to hold the ten nearest quakes,
though only the closest is marked — never narrower than about 900 miles across.
It is stretched horizontally by 1/cos(latitude) so distances read correctly,
and the graticule is drawn from the same window.

Tectonic plate boundaries are drawn over it as dashed red lines, from the plate
data that was already in this repo. They are the reason the quake sits where it
does.

Every size on the page is a multiple of one unit — a hundredth of the screen's
width, or of its height scaled to 16:9, whichever is smaller — so the layout
fills the screen whatever its shape, without clipping or letterboxing. The map
window is fitted to the screen's real aspect ratio, not an assumed one.

Needs a player: the coordinates, the location name, the units setting and the
CORS proxy all come from the injected `screenly.js` bridge, so it will not run
in a plain browser. The bridge hands the coordinates over as strings — they are
converted on the way in, because `+` on a string silently poisons every sum
downstream.

The app holds the screen until it has something to say. `ready_signal: true`
in the manifest stops the player showing the page the moment it loads, and
the app calls `screenly.signalReadyForRendering()` once the first feed
request has settled — so the previous asset stays up through the fetch
instead of the screen flashing a panel of dashes. It signals whether that
fetch succeeded or failed; a player that is never told holds the playlist for
sixty seconds and then abandons the build. A screen with no location has
nothing to wait for and signals straight away.

## Deploy

```bash
screenly edge-app deploy
```
