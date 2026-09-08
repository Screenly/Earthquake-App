# Changelog

User-facing release notes. Technical detail — refactors, dependency bumps, API
changes — belongs in the GitHub Release for the matching tag.

## v0.0.1

The first release.

A map centred on your screen's own location, calling out the nearest earthquake
in the last seven days: how strong it was, where, how far away, in which
direction, and how long ago. Tectonic plate boundaries are drawn over the map,
which is usually why the quake sits where it does.

- Choose miles or kilometres.
- If the earthquake feed cannot be reached, the screen keeps showing the last
  reading it received rather than going blank.
- A screen with no location set says so, instead of guessing.
- Nothing moves and nothing animates. The feed refreshes every five minutes.
