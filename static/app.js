(function () {
  "use strict";

  var bridge = window.screenly || null;

  function setting(key, fallback) {
    try {
      var value = bridge && bridge.settings ? bridge.settings[key] : undefined;
      return value === undefined || value === null || value === "" ? fallback : value;
    } catch (e) {
      return fallback;
    }
  }

  var CONFIG = {
    threshold: String(setting("magnitude_threshold", "4.5")),
    window: String(setting("time_window", "week")),
    refreshMin: Math.max(1, parseFloat(setting("refresh_minutes", "5")) || 5),
    focus: String(setting("map_focus", "auto")),
  };

  var QUERY = {};
  try { new URLSearchParams(location.search).forEach(function (value, key) { QUERY[key] = value; }); } catch (e) {}
  if (QUERY.mag) CONFIG.threshold = String(QUERY.mag);
  if (QUERY.window) CONFIG.window = String(QUERY.window);
  if (QUERY.focus) CONFIG.focus = String(QUERY.focus);
  if (QUERY.refresh) CONFIG.refreshMin = Math.max(1, parseFloat(QUERY.refresh) || CONFIG.refreshMin);

  var META = {};
  try { META = (bridge && bridge.metadata) || {}; } catch (e) {}

  var DEBUG = String(QUERY.debug || setting("debug", "off"));
  DEBUG = DEBUG === "on" || DEBUG === "1";

  var LOG = [];
  var logEl = null;
  function logLine(message) {
    if (!DEBUG) return;
    var now = new Date();
    LOG.push(("0" + now.getMinutes()).slice(-2) + ":" + ("0" + now.getSeconds()).slice(-2) + "  " + message);
    if (LOG.length > 14) LOG.shift();
    if (!logEl && document.body) {
      logEl = document.createElement("div");
      logEl.id = "debuglog";
      document.body.appendChild(logEl);
    }
    if (logEl) logEl.textContent = LOG.join("\n");
  }
  window.addEventListener("error", function (event) {
    logLine("error: " + (event.message || event.type) + (event.filename ? "  @" + String(event.filename).split("/").pop() + ":" + event.lineno : ""));
  });
  window.addEventListener("unhandledrejection", function (event) {
    logLine("promise: " + String(event.reason && (event.reason.message || event.reason)).slice(0, 140));
  });
  ["warn", "error"].forEach(function (level) {
    var original = console[level].bind(console);
    console[level] = function () {
      logLine(level + ": " + [].slice.call(arguments).map(String).join(" ").slice(0, 140));
      original.apply(null, arguments);
    };
  });

  var VALID_WINDOWS = { hour: 1, day: 1, week: 1, month: 1 };
  var VALID_LEVELS = { "1.0": 1, "2.5": 1, "4.5": 1, significant: 1 };
  var WINDOW_SHORT = { hour: "1h", day: "24h", week: "7d", month: "30d" };

  function windowKey() {
    return VALID_WINDOWS[CONFIG.window] ? CONFIG.window : "day";
  }

  var USE_MILES = String(QUERY.units || setting("units", "miles")) !== "km";
  function fmtDist(km) {
    return USE_MILES ? Math.round(km * 0.621371) + " mi" : Math.round(km) + " km";
  }

  var SIMPLE_DIR = { NNE: "NE", ENE: "NE", ESE: "SE", SSE: "SE", SSW: "SW", WSW: "SW", WNW: "NW", NNW: "NW" };
  function parsePlace(props) {
    var raw = (props && props.place) || "Unknown location";
    var match = /^(\d+(?:\.\d+)?)\s*km\s+([NSEW]{1,3})\s+of\s+(.+)$/i.exec(raw);
    if (!match) return { name: raw, dist: null };
    var direction = match[2].toUpperCase();
    return { name: match[3], dist: fmtDist(parseFloat(match[1])) + " " + (SIMPLE_DIR[direction] || direction) };
  }

  function feedUrl() {
    var level = VALID_LEVELS[CONFIG.threshold] ? CONFIG.threshold : "4.5";
    var feed = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/" + level + "_" + windowKey() + ".geojson";
    var proxy = bridge && bridge.cors_proxy_url ? bridge.cors_proxy_url : "";
    return proxy ? proxy.replace(/\/+$/, "") + "/" + feed : feed;
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  var RAMP;
  function magColor(mag) {
    if (mag >= 7) return RAMP.m5;
    if (mag >= 6) return RAMP.m4;
    if (mag >= 5) return RAMP.m3;
    if (mag >= 4) return RAMP.m2;
    if (mag >= 2.5) return RAMP.m1;
    return RAMP.m0;
  }
  function magRadius(mag) {
    var floored = Math.max(mag, 0.5);
    return Math.min(1.6 + Math.pow(floored, 1.6) * 0.38, 16);
  }
  function uiScale() {
    return (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) / 16;
  }

  function relTime(timestamp) {
    var seconds = Math.max(0, (Date.now() - timestamp) / 1000);
    if (seconds < 60) return Math.floor(seconds) + "s ago";
    if (seconds < 3600) return Math.floor(seconds / 60) + " min ago";
    if (seconds < 86400) return Math.floor(seconds / 3600) + " hr ago";
    return Math.floor(seconds / 86400) + " d ago";
  }

  var map, quakeLayer;
  var viewCenterLng = 0;
  var WORLD_BOUNDS = [[-56, -25], [76, 335]];
  var WORLD_CENTER_LNG = 155;
  var FOCUS_ZOOM = 4.5;
  var currentQuakes = null;
  var userLocation = null;

  function distKm(from, to) {
    var toRad = Math.PI / 180;
    var deltaLat = (to.lat - from.lat) * toRad;
    var deltaLng = (to.lng - from.lng) * toRad;
    var sinLat = Math.sin(deltaLat / 2), sinLng = Math.sin(deltaLng / 2);
    var haversine = sinLat * sinLat + Math.cos(from.lat * toRad) * Math.cos(to.lat * toRad) * sinLng * sinLng;
    return 12742 * Math.asin(Math.sqrt(haversine));
  }

  function bearingWord(from, to) {
    var toRad = Math.PI / 180;
    var deltaLng = (to.lng - from.lng) * toRad;
    var east = Math.sin(deltaLng) * Math.cos(to.lat * toRad);
    var north = Math.cos(from.lat * toRad) * Math.sin(to.lat * toRad) -
      Math.sin(from.lat * toRad) * Math.cos(to.lat * toRad) * Math.cos(deltaLng);
    var degrees = (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
    return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(degrees / 45) % 8];
  }

  function normLng(lng) {
    while (lng < viewCenterLng - 180) lng += 360;
    while (lng >= viewCenterLng + 180) lng -= 360;
    return lng;
  }

  function pairFrom(raw) {
    if (!raw) return null;
    var lat, lng;
    if (Array.isArray(raw)) {
      lat = parseFloat(raw[0]);
      lng = parseFloat(raw[1]);
    } else {
      lat = parseFloat(raw.latitude !== undefined ? raw.latitude : raw.lat);
      lng = parseFloat(raw.longitude !== undefined ? raw.longitude : raw.lng);
    }
    return isFinite(lat) && isFinite(lng) ? { lat: lat, lng: lng } : null;
  }

  function knownCoords() {
    var queryLat = parseFloat(QUERY.lat), queryLng = parseFloat(QUERY.lng);
    if (isFinite(queryLat) && isFinite(queryLng)) return { lat: queryLat, lng: queryLng };
    return (
      pairFrom(META.coordinates) ||
      pairFrom(META.coords) ||
      pairFrom(META.location && META.location.coordinates) ||
      null
    );
  }

  function askBrowserForLocation() {
    if (!navigator.geolocation) return;
    try {
      navigator.geolocation.getCurrentPosition(
        function (position) { focusOn(position.coords.latitude, position.coords.longitude); },
        function () {},
        { timeout: 8000, maximumAge: 600000 }
      );
    } catch (e) {}
  }

  function initMap() {
    var screenCoords = knownCoords();
    var autoFocus = CONFIG.focus === "auto" && !!screenCoords;
    logLine(screenCoords
      ? "coords " + screenCoords.lat.toFixed(2) + "," + screenCoords.lng.toFixed(2)
      : "no coords · metadata " + JSON.stringify(META.coordinates || META.coords || null));

    map = L.map("map", {
      zoomControl: false,
      attributionControl: false,
      keyboard: false, dragging: false, scrollWheelZoom: false,
      doubleClickZoom: false, boxZoom: false, touchZoom: false,
      zoomSnap: 0.1,
      preferCanvas: true,
    });

    if (autoFocus) {
      viewCenterLng = screenCoords.lng;
      userLocation = screenCoords;
      map.setView([screenCoords.lat, screenCoords.lng], FOCUS_ZOOM);
    } else {
      viewCenterLng = WORLD_CENTER_LNG;
      map.fitBounds(WORLD_BOUNDS);
    }

    map.createPane("base");
    map.getPane("base").style.zIndex = 210;

    loadWorld(function (worldGeo) {
      var scale = uiScale();
      eachWorldCopy(worldGeo, function (copy) {
        L.geoJSON(copy, {
          pane: "base", interactive: false,
          style: {
            color: "rgba(4,7,14,0.9)", weight: 2.4 * scale,
            fillColor: "#232e47", fillOpacity: 1,
          },
        }).addTo(map);
        L.geoJSON(copy, {
          pane: "base", interactive: false,
          style: {
            color: "rgba(178,196,228,0.6)", weight: 1.1 * scale,
            fill: false,
          },
        }).addTo(map);
      });
    });
    loadPlates();

    quakeLayer = L.layerGroup().addTo(map);

    if (autoFocus) {
      addScreenDot(screenCoords.lat, screenCoords.lng);
    } else if (CONFIG.focus === "auto" && !screenCoords) {
      askBrowserForLocation();
    }
  }

  var screenMarker = null;
  function addScreenDot(lat, lng) {
    if (screenMarker) { try { map.removeLayer(screenMarker); } catch (e) {} }
    var sizePx = Math.round(64 * uiScale());
    var icon = L.divIcon({
      className: "",
      html:
        '<div class="epi">' +
        '<span class="epi-ring"></span>' +
        '<span class="epi-core"></span>' +
        "</div>",
      iconSize: [sizePx, sizePx],
    });
    screenMarker = L.marker([lat, normLng(lng)], { icon: icon, interactive: false }).addTo(map);
  }

  function focusOn(lat, lng) {
    viewCenterLng = lng;
    userLocation = { lat: lat, lng: lng };
    map.setView([lat, lng], FOCUS_ZOOM, { animate: false });
    addScreenDot(lat, lng);
    if (currentQuakes) plot(currentQuakes);
  }

  function loadPlates() {
    var source = window.__PLATES_GEO
      ? Promise.resolve(window.__PLATES_GEO)
      : fetch("static/plates.json", { cache: "no-store" }).then(function (response) { return response.json(); });
    source
      .then(function (platesGeo) {
        var scale = uiScale();
        eachWorldCopy(platesGeo, function (copy) {
          L.geoJSON(copy, {
            interactive: false,
            style: { color: "rgba(4,7,14,0.85)", weight: 2.2 * scale },
          }).addTo(map);
          L.geoJSON(copy, {
            interactive: false,
            style: { color: "rgba(255,115,85,0.55)", weight: 1.1 * scale },
          }).addTo(map);
        });
        ensureMarkersOnTop();
      })
      .catch(function () {});
  }

  function loadWorld(onLoaded) {
    if (window.__WORLD_GEO) {
      onLoaded(window.__WORLD_GEO);
      ensureMarkersOnTop();
      return;
    }
    function attempt(url, retriesLeft) {
      fetch(url, { cache: "no-store" })
        .then(function (response) {
          if (!response.ok) throw new Error("HTTP " + response.status);
          return response.json();
        })
        .then(function (worldGeo) {
          onLoaded(worldGeo);
          ensureMarkersOnTop();
        })
        .catch(function (err) {
          console.warn("map data load failed:", err);
          if (retriesLeft > 0) {
            setTimeout(function () { attempt("static/world.json", retriesLeft - 1); }, 1500);
          } else {
            toast("map data unavailable");
          }
        });
    }
    attempt("static/world.json", 1);
  }

  function ensureMarkersOnTop() {
    if (!quakeLayer) return;
    quakeLayer.eachLayer(function (layer) { if (layer.bringToFront) layer.bringToFront(); });
  }

  function eachWorldCopy(geoJson, draw) {
    draw(geoJson);
    if (viewCenterLng + 180 <= 180) return;
    function shift(coords) {
      if (typeof coords[0] === "number") return [coords[0] + 360, coords[1]];
      return coords.map(shift);
    }
    draw({
      type: "FeatureCollection",
      features: geoJson.features.map(function (feature) {
        return {
          type: "Feature", properties: {},
          geometry: { type: feature.geometry.type, coordinates: shift(feature.geometry.coordinates) },
        };
      }),
    });
  }

  function plot(quakes) {
    currentQuakes = quakes;
    quakeLayer.clearLayers();

    var scale = uiScale();
    var weakestFirst = quakes.slice().sort(function (a, b) {
      return (a.properties.mag || 0) - (b.properties.mag || 0);
    });

    weakestFirst.forEach(function (quake) {
      var coords = quake.geometry && quake.geometry.coordinates;
      var mag = quake.properties.mag;
      if (!coords || mag === null || mag === undefined) return;
      L.circleMarker([coords[1], normLng(coords[0])], {
        radius: magRadius(mag) * scale,
        color: "rgba(8,12,22,0.85)", weight: Math.max(1, scale),
        opacity: 0.9,
        fillColor: magColor(mag),
        fillOpacity: 0.6,
      }).addTo(quakeLayer);
    });

    ensureMarkersOnTop();
    updatePoi(quakes);
  }

  function poiRect() {
    var mapSize = map.getSize();
    var rail = document.getElementById("rail");
    var margin = 22 * uiScale();
    return {
      x0: margin, y0: margin,
      x1: mapSize.x - (rail ? rail.offsetWidth : 0) - margin,
      y1: mapSize.y - margin,
    };
  }

  function updatePoi(quakes) {
    var card = document.getElementById("poi");
    var svg = document.getElementById("poi-line");
    if (!map || !card || !svg) return;

    var bounds = poiRect();
    var candidates = [];
    (quakes || []).forEach(function (quake) {
      var coords = quake.geometry && quake.geometry.coordinates;
      var mag = quake.properties.mag;
      if (!coords || mag === null || mag === undefined) return;
      var point = map.latLngToContainerPoint([coords[1], normLng(coords[0])]);
      var hoursAgo = (Date.now() - quake.properties.time) / 3600000;
      var score = mag - hoursAgo / 36;
      if (userLocation) score -= distKm(userLocation, { lat: coords[1], lng: coords[0] }) / 1400;
      candidates.push({
        quake: quake, point: point, score: score,
        onScreen: point.x >= bounds.x0 && point.x <= bounds.x1 && point.y >= bounds.y0 && point.y <= bounds.y1,
      });
    });

    var visible = candidates.filter(function (candidate) { return candidate.onScreen; });
    var pinned = false;
    if (!visible.length) {
      visible = candidates;
      pinned = true;
    }
    if (!visible.length) {
      card.hidden = true;
      svg.style.display = "none";
      return;
    }

    visible.sort(function (a, b) { return b.score - a.score; });
    visible = visible.slice(0, 6);
    var featured = visible[Math.floor(Date.now() / 300000) % visible.length];

    var props = featured.quake.properties;
    var coords = featured.quake.geometry.coordinates;
    var placeInfo = parsePlace(props);
    document.getElementById("poi-rule").style.background = magColor(props.mag);
    document.getElementById("poi-mag").textContent = props.mag.toFixed(1);
    document.getElementById("poi-name").textContent = placeInfo.name;
    var quakeLocation = { lat: coords[1], lng: coords[0] };
    var parts = [relTime(props.time)];
    if (userLocation) parts.push(fmtDist(distKm(userLocation, quakeLocation)) + " " + bearingWord(userLocation, quakeLocation) + " of here");
    if (coords[2] !== null && coords[2] !== undefined) parts.push(fmtDist(coords[2]) + " deep");
    document.getElementById("poi-meta").textContent = parts.join(" · ");
    card.style.left = "0px";
    card.style.top = "0px";
    card.hidden = false;

    if (pinned) {
      card.style.left = bounds.x0 + "px";
      card.style.top = bounds.y1 - card.offsetHeight + "px";
      svg.style.display = "none";
      return;
    }

    var scale = uiScale();
    var offsetX = 46 * scale, offsetY = 30 * scale;
    var cardLeft, cardTop;
    function place(cardWidth, cardHeight) {
      cardLeft = featured.point.x + offsetX;
      cardTop = featured.point.y - offsetY - cardHeight;
      if (cardLeft + cardWidth > bounds.x1) cardLeft = featured.point.x - offsetX - cardWidth;
      if (cardTop < bounds.y0) cardTop = featured.point.y + offsetY;
      cardLeft = Math.max(bounds.x0, Math.min(cardLeft, bounds.x1 - cardWidth));
      cardTop = Math.max(bounds.y0, Math.min(cardTop, bounds.y1 - cardHeight));
      card.style.left = cardLeft + "px";
      card.style.top = cardTop + "px";
    }
    var cardWidth = card.offsetWidth, cardHeight = card.offsetHeight;
    place(cardWidth, cardHeight);
    if (card.offsetWidth !== cardWidth || card.offsetHeight !== cardHeight) {
      cardWidth = card.offsetWidth;
      cardHeight = card.offsetHeight;
      place(cardWidth, cardHeight);
    }

    var corners = [
      [cardLeft, cardTop],
      [cardLeft + cardWidth, cardTop],
      [cardLeft, cardTop + cardHeight],
      [cardLeft + cardWidth, cardTop + cardHeight],
    ];
    var nearestCorner = corners[0], nearestDistance = Infinity;
    corners.forEach(function (corner) {
      var distance = (corner[0] - featured.point.x) * (corner[0] - featured.point.x) +
        (corner[1] - featured.point.y) * (corner[1] - featured.point.y);
      if (distance < nearestDistance) { nearestDistance = distance; nearestCorner = corner; }
    });
    var angle = Math.atan2(nearestCorner[1] - featured.point.y, nearestCorner[0] - featured.point.x);
    var dotEdge = magRadius(props.mag) * scale + 3 * scale;
    var lineStartX = featured.point.x + Math.cos(angle) * dotEdge;
    var lineStartY = featured.point.y + Math.sin(angle) * dotEdge;

    var mapSize = map.getSize();
    svg.setAttribute("width", mapSize.x);
    svg.setAttribute("height", mapSize.y);
    svg.setAttribute("viewBox", "0 0 " + mapSize.x + " " + mapSize.y);
    var underLine = document.getElementById("poi-line-under");
    var overLine = document.getElementById("poi-line-over");
    [underLine, overLine].forEach(function (line) {
      line.setAttribute("x1", lineStartX);
      line.setAttribute("y1", lineStartY);
      line.setAttribute("x2", nearestCorner[0]);
      line.setAttribute("y2", nearestCorner[1]);
      line.setAttribute("stroke-linecap", "round");
    });
    underLine.setAttribute("stroke", "rgba(4,7,14,0.9)");
    underLine.setAttribute("stroke-width", 2.4 * scale);
    overLine.setAttribute("stroke", "rgba(233,237,246,0.55)");
    overLine.setAttribute("stroke-width", Math.max(1, scale));
    svg.style.display = "block";
  }

  function renderRail(quakes) {
    var list = document.getElementById("event-list");
    var empty = document.getElementById("empty-state");
    list.innerHTML = "";

    if (!quakes.length) { empty.hidden = false; return; }
    empty.hidden = true;

    var recent = quakes.slice()
      .sort(function (a, b) { return b.properties.time - a.properties.time; })
      .slice(0, 15);

    recent.forEach(function (quake) {
      var props = quake.properties;
      var placeInfo = parsePlace(props);
      var row = document.createElement("li");
      row.className = "event";

      var magCell = document.createElement("div");
      magCell.className = "event-mag";
      var colorBar = document.createElement("span");
      colorBar.className = "event-rule";
      colorBar.style.background = magColor(props.mag);
      var magNumber = document.createElement("span");
      magNumber.className = "event-mag-num";
      magNumber.textContent = props.mag === null ? "–" : props.mag.toFixed(1);
      magCell.appendChild(colorBar);
      magCell.appendChild(magNumber);

      var details = document.createElement("div");
      details.className = "event-body";
      var placeLine = document.createElement("div");
      placeLine.className = "event-place";
      placeLine.textContent = placeInfo.name;
      var metaLine = document.createElement("div");
      metaLine.className = "event-meta";
      var depth = quake.geometry && quake.geometry.coordinates ? quake.geometry.coordinates[2] : null;
      var parts = [relTime(props.time)];
      if (placeInfo.dist) parts.push(placeInfo.dist);
      if (depth !== null && depth !== undefined) parts.push(fmtDist(depth) + " deep");
      metaLine.textContent = parts.join(" · ");
      if (props.tsunami) {
        var tag = document.createElement("span");
        tag.className = "tag-tsunami";
        tag.textContent = "TSUNAMI";
        metaLine.appendChild(tag);
      }
      details.appendChild(placeLine);
      details.appendChild(metaLine);

      row.appendChild(magCell);
      row.appendChild(details);
      list.appendChild(row);
    });
  }

  function renderTsunami(quakes) {
    var banner = document.getElementById("tsunami");
    var flagged = quakes.filter(function (quake) { return quake.properties.tsunami; })
      .sort(function (a, b) { return (b.properties.mag || 0) - (a.properties.mag || 0); });
    if (!flagged.length) { banner.hidden = true; return; }
    var props = flagged[0].properties;
    document.getElementById("tsunami-text").textContent =
      "M" + (props.mag || 0).toFixed(1) + " · " + (props.place || "unknown location") + " · " + relTime(props.time) +
      (flagged.length > 1 ? "  (+" + (flagged.length - 1) + " more)" : "");
    banner.hidden = false;
  }

  function renderStats(quakes) {
    var count = quakes.length;
    var strongest = quakes.reduce(function (best, quake) { return Math.max(best, quake.properties.mag || 0); }, 0);
    document.getElementById("stat-count").textContent = count;
    document.getElementById("stat-max").textContent = count ? "M" + strongest.toFixed(1) : "–";
    document.getElementById("max-dot").style.background = count ? magColor(strongest) : "";
    document.getElementById("label-count").textContent = "quakes · " + WINDOW_SHORT[windowKey()];
    document.getElementById("label-max").textContent = "strongest";
  }

  var signalled = false;
  function markReady() {
    if (signalled) return;
    signalled = true;
    logLine("ready signalled");
    var splash = document.getElementById("splash");
    if (splash) splash.remove();
    try {
      if (bridge && typeof bridge.signalReadyForRendering === "function") bridge.signalReadyForRendering();
    } catch (e) {}
  }

  function toast(message) {
    var box = document.getElementById("toast");
    if (!message) { box.hidden = true; return; }
    box.textContent = message;
    box.hidden = false;
  }

  function load() {
    fetch(feedUrl(), { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then(function (data) {
        var quakes = (data && data.features) || [];
        logLine("feed ok · " + quakes.length + " quakes");
        plot(quakes);
        renderRail(quakes);
        renderStats(quakes);
        renderTsunami(quakes);
        toast(null);
        markReady();
      })
      .catch(function (err) {
        toast("USGS unreachable · retrying");
        console.warn("feed fetch failed:", err);
        markReady();
      });
  }

  function boot() {
    RAMP = {
      m0: cssVar("--m0"), m1: cssVar("--m1"), m2: cssVar("--m2"),
      m3: cssVar("--m3"), m4: cssVar("--m4"), m5: cssVar("--m5"),
    };
    logLine("boot · bridge " + (bridge ? "present" : "absent"));
    initMap();
    load();
    setInterval(load, CONFIG.refreshMin * 60 * 1000);
    setInterval(function () { if (currentQuakes) updatePoi(currentQuakes); }, 60 * 1000);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { if (currentQuakes) updatePoi(currentQuakes); });
    }
    setTimeout(markReady, 8000);
    var resizeTimer = null;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (!map) return;
        map.invalidateSize();
        if (currentQuakes) plot(currentQuakes);
      }, 300);
    });
    window.SeismicMonitor = { map: map, reload: load, config: CONFIG };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
