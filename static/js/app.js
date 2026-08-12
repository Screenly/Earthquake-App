(function () {
    "use strict";


    // ---------------------------------------------------------------
    // Settings
    // ---------------------------------------------------------------

    // On a player, `window.screenly` exists and holds the settings and the
    // screen's own details. In a plain browser it doesn't, so everything
    // falls back to defaults and the app still runs.
    var bridge = window.screenly || {};
    var settings = bridge.settings || {};
    var metadata = bridge.metadata || {};

    // Every setting in screenly.yml is type: string, so an unset one arrives
    // as "". Empty strings are falsy, so it drops to the default on its own.
    function readSetting(key, fallback) {
        return settings[key] || fallback;
    }

    var config = {
        threshold: readSetting("magnitude_threshold", "4.5"),
        timeWindow: readSetting("time_window", "week"),
        refreshMinutes: Math.max(1, parseFloat(readSetting("refresh_minutes", "5")) || 5),
        focus: readSetting("map_focus", "auto"),
        useMiles: readSetting("units", "miles") !== "km",
    };


    // ---------------------------------------------------------------
    // The USGS feed
    // ---------------------------------------------------------------

    var ALLOWED_MAGNITUDES = ["1.0", "2.5", "4.5", "significant"];
    var ALLOWED_WINDOWS = ["hour", "day", "week", "month"];

    function feedUrl() {
        var magnitude = ALLOWED_MAGNITUDES.indexOf(config.threshold) === -1 ? "4.5" : config.threshold;
        var url = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/" + magnitude + "_" + windowName() + ".geojson";
        var proxy = bridge.cors_proxy_url || "";
        return proxy ? proxy.replace(/\/+$/, "") + "/" + url : url;
    }

    function windowName() {
        return ALLOWED_WINDOWS.indexOf(config.timeWindow) === -1 ? "day" : config.timeWindow;
    }


    // ---------------------------------------------------------------
    // Reading one quake
    // ---------------------------------------------------------------
    //
    // USGS returns GeoJSON. Every quake SHOULD look like this:
    //
    //   { properties: { mag: 5.3, place: "88 km SSW of Whitehorse", time: ... },
    //     geometry:   { coordinates: [longitude, latitude, depth in km] } }

    function magnitudeOf(quake) {
        var magnitude = quake.properties.mag;
        return typeof magnitude === "number" ? magnitude : null; // quake magnitude
    }

    function locationOf(quake) {
        var coordinates = quake.geometry && quake.geometry.coordinates;
        if (!coordinates) return null;
        return { lng: coordinates[0], lat: coordinates[1], depthKm: coordinates[2] }; // quake coords and depth 
    }

    function timeOf(quake) {
        return quake.properties.time; // quake timestamp
    }

    function isUsable(quake) {
        return magnitudeOf(quake) !== null && locationOf(quake) !== null; // has magnitude and coordinates
    }


    // ---------------------------------------------------------------
    // Text formatting
    // ---------------------------------------------------------------

    function formatDistance(km) {
        if (km === null || km === undefined) return null;
        return config.useMiles ? Math.round(km * 0.621371) + " mi" : Math.round(km) + " km";
    }

    function formatAge(time) {
        var seconds = Math.max(0, (Date.now() - time) / 1000);
        if (seconds < 60) return Math.floor(seconds) + "s ago";
        if (seconds < 3600) return Math.floor(seconds / 60) + " min ago";
        if (seconds < 86400) return Math.floor(seconds / 3600) + " hr ago";
        return Math.floor(seconds / 86400) + " d ago";
    }

    // USGS writes places as "88 km SSW of Whitehorse, Canada". We split that
    // into the offset ("55 mi SW") and the place name ("Whitehorse, Canada"),
    // so the two can go on different lines. Some places have no offset at
    // all - "Fiji region" - and those come back with offset: null.
    var PLACE_PATTERN = /^(\d+(?:\.\d+)?)\s*km\s+([NSEW]{1,3})\s+of\s+(.+)$/i;
    var SHORT_COMPASS = {
        NNE: "NE", ENE: "NE", ESE: "SE", SSE: "SE",
        SSW: "SW", WSW: "SW", WNW: "NW", NNW: "NW",
    };

    function describePlace(quake) {
        var place = quake.properties.place || "Unknown location";
        var parts = PLACE_PATTERN.exec(place);
        if (!parts) return { name: place, offset: null };

        var compass = parts[2].toUpperCase();
        return {
            name: parts[3],
            offset: formatDistance(parseFloat(parts[1])) + " " + (SHORT_COMPASS[compass] || compass),
        };
    }

    // The line under a place name: "31 min ago . 60 mi SW . 33 mi deep".
    function describeDetails(quake) {
        var place = describePlace(quake);
        var details = [formatAge(timeOf(quake))];

        if (place.offset) details.push(place.offset);

        var depth = formatDistance(locationOf(quake).depthKm);
        if (depth) details.push(depth + " deep");

        return details.join(" · ");
    }

    function formatMagnitude(quake) {
        var magnitude = magnitudeOf(quake);
        return magnitude === null ? "–" : magnitude.toFixed(1);
    }

    // Bigger quakes get a lighter, hotter colour.
    function pickMagnitudeColor(magnitude) {
        if (magnitude >= 7) return "#fff3c4";
        if (magnitude >= 6) return "#ffd166";
        if (magnitude >= 5) return "#ffab3d";
        if (magnitude >= 4) return "#f28136";
        if (magnitude >= 2.5) return "#d95f2b";
        return "#b8442a";
    }


    // ---------------------------------------------------------------
    // The map
    // ---------------------------------------------------------------

    var map = null;
    var quakeDots = null;
    var quakeLabel = null;

    // Where the map is pointed. null means show the whole world.
    var WORLD_BOUNDS = [[-60, -180], [78, 180]];
    var mapCenter = null;

    var scale = 1;

    function screenLocation() {
        var coordinates = metadata.coordinates;
        if (!coordinates) return null;

        var lat = parseFloat(Array.isArray(coordinates) ? coordinates[0] : coordinates.latitude);
        var lng = parseFloat(Array.isArray(coordinates) ? coordinates[1] : coordinates.longitude);
        return isFinite(lat) && isFinite(lng) ? { lat: lat, lng: lng } : null;
    }

    // Point the map. Called at startup and again on resize, because a resized
    // window needs a new zoom to fit, not just a new canvas size.
    function fitView() {
        if (mapCenter) map.setView([mapCenter.lat, mapCenter.lng], 4.5);
        else map.fitBounds(WORLD_BOUNDS);
    }

    function createMap() {
        // "auto" centres on wherever this screen is, if the player told us.
        mapCenter = config.focus === "auto" ? screenLocation() : null;

        map = L.map("map", {
            zoomControl: false, // Nobody touches/should have a keyboard or mouse going on a signage screen so turn off every interaction
            attributionControl: false, // ^
            dragging: false, // ^
            keyboard: false, // ^
            scrollWheelZoom: false, // ^
            doubleClickZoom: false, // ^
            boxZoom: false, // ^
            touchZoom: false, // ^
            zoomSnap: 0.1,
            preferCanvas: true,
        });

        fitView();

        drawLand();
        drawPlates();
        if (mapCenter) markScreenLocation(mapCenter);

        quakeDots = L.layerGroup().addTo(map);
    }

    // The country outlines are bundled with the app (static/data/world.js) so
    // the map works with no internet. Each country is drawn twice: a thick
    // dark line first, then a thin pale one on top. That gives the coastline
    // a dark edge so it stays readable against both land and sea.
    function drawLand() {
        if (!window.__WORLD_GEO) {
            showMessage("map data unavailable");
            return;
        }

        L.geoJSON(window.__WORLD_GEO, {
            interactive: false,
            style: { color: "rgba(4,7,14,0.9)", weight: 2.4 * scale, fillColor: "#232e47", fillOpacity: 1 },
        }).addTo(map);

        L.geoJSON(window.__WORLD_GEO, {
            interactive: false,
            style: { color: "rgba(178,196,228,0.6)", weight: 1.1 * scale, fill: false },
        }).addTo(map);
    }

    // The tectonic plate boundaries (static/data/plates.js) - the edges of the
    // slabs the Earth's crust is broken into. Quakes happen where those edges
    // grind together, so the dots end up tracing these lines. Drawn on top of
    // the land, dark line then orange, same reason as the coastlines.
    function drawPlates() {
        if (!window.__PLATES_GEO) return;

        L.geoJSON(window.__PLATES_GEO, {
            interactive: false,
            style: { color: "rgba(4,7,14,0.85)", weight: 2.2 * scale },
        }).addTo(map);

        L.geoJSON(window.__PLATES_GEO, {
            interactive: false,
            style: { color: "rgba(255,115,85,0.55)", weight: 1.1 * scale },
        }).addTo(map);
    }

    function markScreenLocation(center) {
        var size = Math.round(64 * scale);
        L.marker([center.lat, center.lng], {
            interactive: false,
            icon: L.divIcon({
                className: "",
                html: '<div class="epi"><span class="epi-ring"></span><span class="epi-core"></span></div>',
                iconSize: [size, size],
            }),
        }).addTo(map);
    }

    // Dot size grows faster than magnitude does, so a M7 looks properly
    // bigger than a M5 rather than slightly bigger. Capped so the largest quakes don't make dots that are bigger than the screen.
    function dotRadius(magnitude) {
        return Math.min(1.6 + Math.pow(Math.max(magnitude, 0.5), 1.6) * 0.38, 16) * scale;
    }

    function drawQuakeDots(quakes) {
        quakeDots.clearLayers();

        // Weakest first, so the big dots end up drawn on top of the small ones.
        quakes.slice()
            .sort(function (a, b) { return magnitudeOf(a) - magnitudeOf(b); })
            .forEach(function (quake) {
                var place = locationOf(quake);
                L.circleMarker([place.lat, place.lng], {
                    radius: dotRadius(magnitudeOf(quake)),
                    color: "rgba(8,12,22,0.85)",
                    weight: Math.max(1, scale),
                    opacity: 0.9,
                    fillColor: pickMagnitudeColor(magnitudeOf(quake)),
                    fillOpacity: 0.6,
                }).addTo(quakeDots);
            });
    }


    // ---------------------------------------------------------------
    // The label on the map
    // ---------------------------------------------------------------
    //
    // One quake gets named on the map. It's a Leaflet tooltip pinned to the
    // quake's position, so Leaflet works out where to put it and we don't.

    var HIGHLIGHT_COUNT = 6;
    var highlightNumber = 0;

    // Strongest wins, but a quake loses a point every day and a half, so a
    // fresh M5 beats a week-old M6.
    function notability(quake) {
        var daysAgo = (Date.now() - timeOf(quake)) / 86400000;
        return magnitudeOf(quake) - daysAgo / 1.5;
    }

    // Only quakes currently on screen can be labelled - a label pointing off
    // the edge of the map is no use. If none are on screen there's no label,
    // and the rail still lists everything.
    function onScreen(quakes) {
        var view = map.getBounds();
        return quakes.filter(function (quake) {
            var place = locationOf(quake);
            return view.contains([place.lat, place.lng]);
        });
    }

    // Rotate through the most notable few rather than always naming the same
    // one. highlightNumber ticks up on a timer.
    function pickHighlight(quakes) {
        var best = onScreen(quakes)
            .sort(function (a, b) { return notability(b) - notability(a); })
            .slice(0, HIGHLIGHT_COUNT);

        if (!best.length) return null;
        return best[highlightNumber % best.length];
    }

    function labelContent(quake) {
        var box = document.createElement("div");
        box.className = "label-head";

        var stripe = document.createElement("span");
        stripe.className = "label-rule";
        stripe.style.background = pickMagnitudeColor(magnitudeOf(quake));

        var magnitude = document.createElement("span");
        magnitude.className = "label-mag";
        magnitude.textContent = formatMagnitude(quake);

        var name = document.createElement("span");
        name.className = "label-name";
        name.textContent = describePlace(quake).name;

        var details = document.createElement("div");
        details.className = "label-meta";
        details.textContent = describeDetails(quake);

        box.appendChild(stripe);
        box.appendChild(magnitude);
        box.appendChild(name);

        var wrapper = document.createElement("div");
        wrapper.appendChild(box);
        wrapper.appendChild(details);
        return wrapper;
    }

    function drawQuakeLabel(quakes) {
        if (quakeLabel) {
            map.removeLayer(quakeLabel);
            quakeLabel = null;
        }

        var quake = pickHighlight(quakes);
        if (!quake) return;

        var place = locationOf(quake);
        quakeLabel = L.tooltip({
            permanent: true,
            interactive: false,
            direction: "top",
            offset: [0, -dotRadius(magnitudeOf(quake)) - 4 * scale],
            className: "quake-label",
        })
            .setLatLng([place.lat, place.lng])
            .setContent(labelContent(quake))
            .addTo(map);
    }


    // ---------------------------------------------------------------
    // The side rail
    // ---------------------------------------------------------------

    var RAIL_LENGTH = 15;

    function drawStats(quakes) {
        var strongest = quakes.reduce(function (best, quake) {
            return Math.max(best, magnitudeOf(quake));
        }, 0);

        document.getElementById("stat-count").textContent = String(quakes.length);
        document.getElementById("stat-max").textContent = quakes.length ? "M" + strongest.toFixed(1) : "–";
        document.getElementById("max-dot").style.background = quakes.length ? pickMagnitudeColor(strongest) : "";
        document.getElementById("label-count").textContent = "quakes · " + windowName();
    }

    function railRow(quake) {
        var row = document.createElement("li");
        row.className = "event";
        row.innerHTML =
            '<div class="event-mag">' +
            '<span class="event-rule"></span><span class="event-mag-num"></span>' +
            "</div>" +
            '<div class="event-body">' +
            '<div class="event-place"></div><div class="event-meta"></div>' +
            "</div>";

        row.querySelector(".event-rule").style.background = pickMagnitudeColor(magnitudeOf(quake));
        row.querySelector(".event-mag-num").textContent = formatMagnitude(quake);
        row.querySelector(".event-place").textContent = describePlace(quake).name;
        row.querySelector(".event-meta").textContent = describeDetails(quake);
        return row;
    }

    function drawRail(quakes) {
        var newest = quakes.slice()
            .sort(function (a, b) { return timeOf(b) - timeOf(a); })
            .slice(0, RAIL_LENGTH);

        var list = document.getElementById("event-list");
        list.innerHTML = "";
        newest.forEach(function (quake) { list.appendChild(railRow(quake)); });

        document.getElementById("empty-state").hidden = newest.length > 0;
    }


    // ---------------------------------------------------------------
    // Messages and the loading screen
    // ---------------------------------------------------------------

    function showMessage(text) {
        var message = document.getElementById("toast");
        message.textContent = text || "";
        message.hidden = !text;
    }

    var loadingScreenGone = false;

    function hideLoadingScreen() {
        if (loadingScreenGone) return;
        loadingScreenGone = true;

        var splash = document.getElementById("splash");
        if (splash) splash.remove();

        // Tells the player the app has something worth showing.
        if (typeof bridge.signalReadyForRendering === "function") {
            bridge.signalReadyForRendering();
        }
    }


    // ---------------------------------------------------------------
    // Fetching and drawing
    // ---------------------------------------------------------------

    var quakes = [];

    function draw() {
        drawQuakeDots(quakes);
        drawQuakeLabel(quakes);
        drawRail(quakes);
        drawStats(quakes);
    }

    function refresh() {
        fetch(feedUrl(), { cache: "no-store" })
            .then(function (response) {
                if (!response.ok) throw new Error("HTTP " + response.status);
                return response.json();
            })
            .then(function (feed) {
                quakes = ((feed && feed.features) || []).filter(isUsable);
                draw();
                showMessage(null);
                hideLoadingScreen();
            })
            .catch(function (error) {
                console.warn("could not load the USGS feed:", error);
                showMessage("USGS unreachable · retrying");
                // Draw whatever we already have. On the very first try that's
                // nothing, which shows the "no events" message; on a later
                // failure the last good data stays on screen.
                draw();
                hideLoadingScreen();
            });
    }


    // ---------------------------------------------------------------
    // Start
    // ---------------------------------------------------------------

    function start() {
        scale = (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) / 16;

        createMap();
        refresh();

        // New data from USGS.
        setInterval(refresh, config.refreshMinutes * 60 * 1000);

        // Move the label on to the next quake, and re-run the "x min ago" text.
        setInterval(function () {
            highlightNumber++;
            if (quakes.length) draw();
        }, 5 * 60 * 1000);

        // If USGS never answers, don't sit on the loading screen forever.
        setTimeout(hideLoadingScreen, 8000);

        window.addEventListener("resize", function () {
            map.invalidateSize();
            fitView();
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start);
    } else {
        start();
    }
})();
