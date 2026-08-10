(function () {
    "use strict";

    // Screenly Player bridge + Settings

    var bridge = window.screenly || null;

    function readSetting(key, fallback) {
        var settings = bridge && bridge.settings;
        var value = settings ? settings[key] : undefined;
        return value === undefined || value === null || value === "" ? fallback : value;
    }
    var config = {
        threshold: String(readSetting("magnitude_threshold", "4.5")),
        timeWindow: String(readSetting("time_window", "week")),
        refreshMinutes: Math.max(1, parseFloat(readSetting("refresh_minutes", "5")) || 5),
        focus: String(readSetting("map_focus", "auto")),
    };

    var metadata = (bridge && bridge.metadata) || {};


    // USGS feed

    var validWindows = { hour: 1, day: 1, week: 1, month: 1 };
    var validLevels = { "1.0": 1, "2.5": 1, "4.5": 1, significant: 1 };
    var windowLabels = { hour: "1h", day: "24h", week: "7d", month: "30d" };

    function resolveTimeWindow() {
        return validWindows[config.timeWindow] ? config.timeWindow : "day";
    }
    function buildFeedUrl() {
        var level = validLevels[config.threshold] ? config.threshold : "4.5";
        var feedUrl = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/" + level + "_" + resolveTimeWindow() + ".geojson";
        var proxy = bridge && bridge.cors_proxy_url ? bridge.cors_proxy_url : "";
        return proxy ? proxy.replace(/\/+$/, "") + "/" + feedUrl : feedUrl;
    }


    // Formatting

    var isMiles = String(readSetting("units", "miles")) !== "km";
    function formatDistance(km) {
        return isMiles ? Math.round(km * 0.621371) + " mi" : Math.round(km) + " km";
    }

    var simplifiedDirections = { NNE: "NE", ENE: "NE", ESE: "SE", SSE: "SE", SSW: "SW", WSW: "SW", WNW: "NW", NNW: "NW" };
    function parsePlace(props) {
        var raw = (props && props.place) || "Unknown location";
        var match = /^(\d+(?:\.\d+)?)\s*km\s+([NSEW]{1,3})\s+of\s+(.+)$/i.exec(raw);
        if (!match) return { name: raw, dist: null };
        var direction = match[2].toUpperCase();
        return { name: match[3], dist: formatDistance(parseFloat(match[1])) + " " + (simplifiedDirections[direction] || direction) };
    }
    function formatRelativeTime(timestamp) {
        var seconds = Math.max(0, (Date.now() - timestamp) / 1000);
        if (seconds < 60) return Math.floor(seconds) + "s ago";
        if (seconds < 3600) return Math.floor(seconds / 60) + " min ago";
        if (seconds < 86400) return Math.floor(seconds / 3600) + " hr ago";
        return Math.floor(seconds / 86400) + " d ago";
    }


    // Maths (static/js/maths.js)

    function findScreenCoordinates() {
        return maths.parseCoordinates(metadata.coordinates) || maths.parseCoordinates(metadata.coords) || null;
    }


    // Map

    var map = null;
    var currentQuakes = null;
    var userLocation = null;

    function initMap() {
        var screenCoords = findScreenCoordinates();
        var isAutoFocus = config.focus === "auto" && !!screenCoords;
        userLocation = isAutoFocus ? screenCoords : null;
        map = render.createMap(isAutoFocus ? screenCoords : null);
    }
    function plot(quakes) {
        currentQuakes = quakes;
        render.drawQuakeDots(quakes);
        updatePoi(quakes);
    }


    // Map Label

    function scoreQuakes(quakes, labelArea) {
        var candidates = [];
        (quakes || []).forEach(function (quake) {
            var coords = quake.geometry && quake.geometry.coordinates;
            var magnitude = quake.properties.mag;
            if (!coords || magnitude === null || magnitude === undefined) return;
            var point = render.projectToScreen(coords[1], coords[0]);
            var hoursAgo = (Date.now() - quake.properties.time) / 3600000;
            var distanceKm = userLocation ? maths.calculateDistanceKm(userLocation, { lat: coords[1], lng: coords[0] }) : null;
            candidates.push({
                quake: quake, point: point,
                score: maths.calculateQuakeScore(magnitude, hoursAgo, distanceKm),
                isOnScreen: maths.isPointInsideArea(point, labelArea),
            });
        });
        candidates.sort(function (a, b) { return b.score - a.score; });
        return candidates;
    }
    function buildPoiContent(quake) {
        var props = quake.properties;
        var coords = quake.geometry.coordinates;
        var placeInfo = parsePlace(props);
        var quakeLocation = { lat: coords[1], lng: coords[0] };
        var parts = [formatRelativeTime(props.time)];
        if (userLocation) parts.push(formatDistance(maths.calculateDistanceKm(userLocation, quakeLocation)) + " " + maths.calculateCompassDirection(userLocation, quakeLocation) + " of here");
        if (coords[2] !== null && coords[2] !== undefined) parts.push(formatDistance(coords[2]) + " deep");
        return {
            ruleColor: render.pickMagnitudeColor(props.mag),
            magnitudeText: props.mag.toFixed(1),
            nameText: placeInfo.name,
            metaText: parts.join(" · "),
        };
    }
    function updatePoi(quakes) {
        if (!map) return;

        var labelArea = render.measureLabelArea();
        var candidates = scoreQuakes(quakes, labelArea);
        var visibleCandidates = candidates.filter(function (candidate) { return candidate.isOnScreen; });
        var isPinned = !visibleCandidates.length;
        var topCandidates = (isPinned ? candidates : visibleCandidates).slice(0, 6);

        if (!topCandidates.length) {
            render.hidePoi();
            return;
        }

        var featured = topCandidates[Math.floor(Date.now() / 300000) % topCandidates.length];

        render.drawPoiCard(buildPoiContent(featured.quake));

        if (isPinned) {
            render.pinPoiCard(labelArea);
            return;
        }

        render.placePoi(labelArea, featured.point, featured.quake.properties.mag);
    }


    // Rail

    function buildRailRows(quakes) {
        return quakes.slice()
            .sort(function (a, b) { return b.properties.time - a.properties.time; })
            .slice(0, 15)
            .map(function (quake) {
                var props = quake.properties;
                var placeInfo = parsePlace(props);
                var depth = quake.geometry && quake.geometry.coordinates ? quake.geometry.coordinates[2] : null;
                var parts = [formatRelativeTime(props.time)];
                if (placeInfo.dist) parts.push(placeInfo.dist);
                if (depth !== null && depth !== undefined) parts.push(formatDistance(depth) + " deep");
                return {
                    ruleColor: render.pickMagnitudeColor(props.mag),
                    magnitudeText: props.mag === null ? "–" : props.mag.toFixed(1),
                    placeText: placeInfo.name,
                    metaText: parts.join(" · "),
                };
            });
    }
    function buildStats(quakes) {
        var count = quakes.length;
        var strongest = quakes.reduce(function (best, quake) { return Math.max(best, quake.properties.mag || 0); }, 0);
        return {
            countText: String(count),
            strongestText: count ? "M" + strongest.toFixed(1) : "–",
            strongestColor: count ? render.pickMagnitudeColor(strongest) : "",
            windowText: "quakes · " + windowLabels[resolveTimeWindow()],
        };
    }


    // Boot + Refresh

    var hasSignalledReady = false;
    function markReady() {
        if (hasSignalledReady) return;
        hasSignalledReady = true;
        render.removeSplash();
        if (bridge && typeof bridge.signalReadyForRendering === "function") bridge.signalReadyForRendering();
    }
    function fetchQuakes() {
        fetch(buildFeedUrl(), { cache: "no-store" })
            .then(function (response) {
                if (!response.ok) throw new Error("HTTP " + response.status);
                return response.json();
            })
            .then(function (data) {
                var quakes = (data && data.features) || [];
                plot(quakes);
                render.drawRail(buildRailRows(quakes));
                render.drawStats(buildStats(quakes));
                render.showToast(null);
                markReady();
            })
            .catch(function (error) {
                render.showToast("USGS unreachable · retrying");
                console.warn("feed fetch failed:", error);
                markReady();
            });
    }
    function boot() {
        initMap();
        fetchQuakes();
        setInterval(fetchQuakes, config.refreshMinutes * 60 * 1000);
        setInterval(function () { if (currentQuakes) updatePoi(currentQuakes); }, 60 * 1000);
        setTimeout(markReady, 8000);
        var resizeTimer = null;
        window.addEventListener("resize", function () {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(function () {
                if (!map) return;
                render.refreshMapSize();
                if (currentQuakes) plot(currentQuakes);
            }, 300);
        });
        window.SeismicMonitor = { map: map, reload: fetchQuakes, config: config };
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})();
