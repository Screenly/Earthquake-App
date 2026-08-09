(function () {
  "use strict";

  var bridge = window.screenly || null;

  function setting(key, fallback) {
    try {
      var v = bridge && bridge.settings ? bridge.settings[key] : undefined;
      return v === undefined || v === null || v === "" ? fallback : v;
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
  try { new URLSearchParams(location.search).forEach(function (v, k) { QUERY[k] = v; }); } catch (e) {}
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
  function logLine(msg) {
    if (!DEBUG) return;
    var d = new Date();
    LOG.push(("0" + d.getMinutes()).slice(-2) + ":" + ("0" + d.getSeconds()).slice(-2) + "  " + msg);
    if (LOG.length > 14) LOG.shift();
    if (!logEl && document.body) {
      logEl = document.createElement("div");
      logEl.id = "debuglog";
      document.body.appendChild(logEl);
    }
    if (logEl) logEl.textContent = LOG.join("\n");
  }
  window.addEventListener("error", function (e) {
    logLine("error: " + (e.message || e.type) + (e.filename ? "  @" + String(e.filename).split("/").pop() + ":" + e.lineno : ""));
  });
  window.addEventListener("unhandledrejection", function (e) {
    logLine("promise: " + String(e.reason && (e.reason.message || e.reason)).slice(0, 140));
  });
  ["warn", "error"].forEach(function (level) {
    var orig = console[level].bind(console);
    console[level] = function () {
      logLine(level + ": " + [].slice.call(arguments).map(String).join(" ").slice(0, 140));
      orig.apply(null, arguments);
    };
  });

  var VALID_WINDOWS = { hour: 1, day: 1, week: 1, month: 1 };
  var VALID_LEVELS = { "1.0": 1, "2.5": 1, "4.5": 1, significant: 1 };
  var WINDOW_SHORT = { hour: "1h", day: "24h", week: "7d", month: "30d" };

  function windowKey() {
    return VALID_WINDOWS[CONFIG.window] ? CONFIG.window : "day";
  }

  var MILES = String(QUERY.units || setting("units", "miles")) !== "km";
  function fmtDist(km) {
    return MILES ? Math.round(km * 0.621371) + " mi" : Math.round(km) + " km";
  }

  var SIMPLE_DIR = { NNE: "NE", ENE: "NE", ESE: "SE", SSE: "SE", SSW: "SW", WSW: "SW", WNW: "NW", NNW: "NW" };
  function parsePlace(p) {
    var raw = (p && p.place) || "Unknown location";
    var dm = /^(\d+(?:\.\d+)?)\s*km\s+([NSEW]{1,3})\s+of\s+(.+)$/i.exec(raw);
    if (!dm) return { name: raw, dist: null };
    var dir = dm[2].toUpperCase();
    return { name: dm[3], dist: fmtDist(parseFloat(dm[1])) + " " + (SIMPLE_DIR[dir] || dir) };
  }

  function feedUrl() {
    var level = VALID_LEVELS[CONFIG.threshold] ? CONFIG.threshold : "4.5";
    var base = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/" + level + "_" + windowKey() + ".geojson";
    var proxy = bridge && bridge.cors_proxy_url ? bridge.cors_proxy_url : "";
    return proxy ? proxy.replace(/\/+$/, "") + "/" + base : base;
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  var RAMP;
  function magColor(m) {
    if (m >= 7) return RAMP.m5;
    if (m >= 6) return RAMP.m4;
    if (m >= 5) return RAMP.m3;
    if (m >= 4) return RAMP.m2;
    if (m >= 2.5) return RAMP.m1;
    return RAMP.m0;
  }
  function magRadius(m) {
    var v = Math.max(m, 0.5);
    return Math.min(1.6 + Math.pow(v, 1.6) * 0.38, 16);
  }
  function uiScale() {
    return (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) / 16;
  }

  function relTime(ts) {
    var s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return Math.floor(s) + "s ago";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " hr ago";
    return Math.floor(s / 86400) + " d ago";
  }

  var map, markerLayer;
  var viewCenterLng = 0;
  var WORLD_BOUNDS = [[-56, -25], [76, 335]];
  var WORLD_CENTER_LNG = 155;
  var FOCUS_ZOOM = 4.5;
  var lastFeatures = null;
  var userLoc = null;

  function distKm(a, b) {
    var toR = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toR;
    var dLng = (b.lng - a.lng) * toR;
    var sa = Math.sin(dLat / 2), sb = Math.sin(dLng / 2);
    var h = sa * sa + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * sb * sb;
    return 12742 * Math.asin(Math.sqrt(h));
  }

  function bearingWord(a, b) {
    var toR = Math.PI / 180;
    var dLng = (b.lng - a.lng) * toR;
    var y = Math.sin(dLng) * Math.cos(b.lat * toR);
    var x = Math.cos(a.lat * toR) * Math.sin(b.lat * toR) -
      Math.sin(a.lat * toR) * Math.cos(b.lat * toR) * Math.cos(dLng);
    var deg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];
  }

  function normLng(lng) {
    while (lng < viewCenterLng - 180) lng += 360;
    while (lng >= viewCenterLng + 180) lng -= 360;
    return lng;
  }

  function pairFrom(c) {
    if (!c) return null;
    var lat, lng;
    if (Array.isArray(c)) {
      lat = parseFloat(c[0]);
      lng = parseFloat(c[1]);
    } else {
      lat = parseFloat(c.latitude !== undefined ? c.latitude : c.lat);
      lng = parseFloat(c.longitude !== undefined ? c.longitude : c.lng);
    }
    return isFinite(lat) && isFinite(lng) ? { lat: lat, lng: lng } : null;
  }

  function knownCoords() {
    var qLat = parseFloat(QUERY.lat), qLng = parseFloat(QUERY.lng);
    if (isFinite(qLat) && isFinite(qLng)) return { lat: qLat, lng: qLng };
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
        function (pos) { focusOn(pos.coords.latitude, pos.coords.longitude); },
        function () {},
        { timeout: 8000, maximumAge: 600000 }
      );
    } catch (e) {}
  }

  function initMap() {
    var loc = knownCoords();
    var autoFocus = CONFIG.focus === "auto" && !!loc;
    logLine(loc
      ? "coords " + loc.lat.toFixed(2) + "," + loc.lng.toFixed(2)
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
      viewCenterLng = loc.lng;
      userLoc = loc;
      map.setView([loc.lat, loc.lng], FOCUS_ZOOM);
    } else {
      viewCenterLng = WORLD_CENTER_LNG;
      map.fitBounds(WORLD_BOUNDS);
    }

    map.createPane("base");
    map.getPane("base").style.zIndex = 210;

    loadWorld(function (geo) {
      var UI = uiScale();
      eachWorldCopy(geo, function (copy) {
        L.geoJSON(copy, {
          pane: "base", interactive: false,
          style: {
            color: "rgba(4,7,14,0.9)", weight: 2.4 * UI,
            fillColor: "#232e47", fillOpacity: 1,
          },
        }).addTo(map);
        L.geoJSON(copy, {
          pane: "base", interactive: false,
          style: {
            color: "rgba(178,196,228,0.6)", weight: 1.1 * UI,
            fill: false,
          },
        }).addTo(map);
      });
    });
    loadPlates();

    markerLayer = L.layerGroup().addTo(map);

    if (autoFocus) {
      addScreenDot(loc.lat, loc.lng);
    } else if (CONFIG.focus === "auto" && !loc) {
      askBrowserForLocation();
    }
  }

  var screenMarker = null;
  function addScreenDot(lat, lng) {
    if (screenMarker) { try { map.removeLayer(screenMarker); } catch (e) {} }
    var s = Math.round(64 * uiScale());
    var icon = L.divIcon({
      className: "",
      html:
        '<div class="epi">' +
        '<span class="epi-ring"></span>' +
        '<span class="epi-core"></span>' +
        "</div>",
      iconSize: [s, s],
    });
    screenMarker = L.marker([lat, normLng(lng)], { icon: icon, interactive: false }).addTo(map);
  }

  function focusOn(lat, lng) {
    viewCenterLng = lng;
    userLoc = { lat: lat, lng: lng };
    map.setView([lat, lng], FOCUS_ZOOM, { animate: false });
    addScreenDot(lat, lng);
    if (lastFeatures) plot(lastFeatures);
  }

  function loadPlates() {
    var ready = window.__PLATES_GEO
      ? Promise.resolve(window.__PLATES_GEO)
      : fetch("static/plates.json", { cache: "no-store" }).then(function (r) { return r.json(); });
    ready
      .then(function (geo) {
        var UI = uiScale();
        eachWorldCopy(geo, function (copy) {
          L.geoJSON(copy, {
            interactive: false,
            style: { color: "rgba(4,7,14,0.85)", weight: 2.2 * UI },
          }).addTo(map);
          L.geoJSON(copy, {
            interactive: false,
            style: { color: "rgba(255,115,85,0.55)", weight: 1.1 * UI },
          }).addTo(map);
        });
        ensureMarkersOnTop();
      })
      .catch(function () {});
  }

  function loadWorld(cb) {
    if (window.__WORLD_GEO) {
      cb(window.__WORLD_GEO);
      ensureMarkersOnTop();
      return;
    }
    function attempt(url, retriesLeft) {
      fetch(url, { cache: "no-store" })
        .then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        })
        .then(function (geo) {
          cb(geo);
          ensureMarkersOnTop();
        })
        .catch(function (e) {
          console.warn("map data load failed:", e);
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
    if (!markerLayer) return;
    markerLayer.eachLayer(function (l) { if (l.bringToFront) l.bringToFront(); });
  }

  function eachWorldCopy(geo, draw) {
    draw(geo);
    if (viewCenterLng + 180 <= 180) return;
    function shift(c) {
      if (typeof c[0] === "number") return [c[0] + 360, c[1]];
      return c.map(shift);
    }
    draw({
      type: "FeatureCollection",
      features: geo.features.map(function (f) {
        return {
          type: "Feature", properties: {},
          geometry: { type: f.geometry.type, coordinates: shift(f.geometry.coordinates) },
        };
      }),
    });
  }

  function plot(features) {
    lastFeatures = features;
    markerLayer.clearLayers();

    var UI = uiScale();
    var sorted = features.slice().sort(function (a, b) {
      return (a.properties.mag || 0) - (b.properties.mag || 0);
    });

    sorted.forEach(function (f) {
      var g = f.geometry && f.geometry.coordinates;
      var m = f.properties.mag;
      if (!g || m === null || m === undefined) return;
      L.circleMarker([g[1], normLng(g[0])], {
        radius: magRadius(m) * UI,
        color: "rgba(8,12,22,0.85)", weight: Math.max(1, UI),
        opacity: 0.9,
        fillColor: magColor(m),
        fillOpacity: 0.6,
      }).addTo(markerLayer);
    });

    ensureMarkersOnTop();
    updatePoi(features);
  }

  function poiRect() {
    var size = map.getSize();
    var rail = document.getElementById("rail");
    var m = 22 * uiScale();
    return {
      x0: m, y0: m,
      x1: size.x - (rail ? rail.offsetWidth : 0) - m,
      y1: size.y - m,
    };
  }

  function updatePoi(features) {
    var card = document.getElementById("poi");
    var svg = document.getElementById("poi-line");
    if (!map || !card || !svg) return;

    var r = poiRect();
    var all = [];
    (features || []).forEach(function (f) {
      var g = f.geometry && f.geometry.coordinates;
      var m = f.properties.mag;
      if (!g || m === null || m === undefined) return;
      var pt = map.latLngToContainerPoint([g[1], normLng(g[0])]);
      var hrs = (Date.now() - f.properties.time) / 3600000;
      var score = m - hrs / 36;
      if (userLoc) score -= distKm(userLoc, { lat: g[1], lng: g[0] }) / 1400;
      all.push({
        f: f, pt: pt, score: score,
        shown: pt.x >= r.x0 && pt.x <= r.x1 && pt.y >= r.y0 && pt.y <= r.y1,
      });
    });

    var cands = all.filter(function (c) { return c.shown; });
    var pinned = false;
    if (!cands.length) {
      cands = all;
      pinned = true;
    }
    if (!cands.length) {
      card.hidden = true;
      svg.style.display = "none";
      return;
    }

    cands.sort(function (a, b) { return b.score - a.score; });
    cands = cands.slice(0, 6);
    var pick = cands[Math.floor(Date.now() / 300000) % cands.length];

    var p = pick.f.properties;
    var g = pick.f.geometry.coordinates;
    var pp = parsePlace(p);
    document.getElementById("poi-rule").style.background = magColor(p.mag);
    document.getElementById("poi-mag").textContent = p.mag.toFixed(1);
    document.getElementById("poi-name").textContent = pp.name;
    var spot = { lat: g[1], lng: g[0] };
    var bits = [relTime(p.time)];
    if (userLoc) bits.push(fmtDist(distKm(userLoc, spot)) + " " + bearingWord(userLoc, spot) + " of here");
    if (g[2] !== null && g[2] !== undefined) bits.push(fmtDist(g[2]) + " deep");
    document.getElementById("poi-meta").textContent = bits.join(" · ");
    card.style.left = "0px";
    card.style.top = "0px";
    card.hidden = false;

    if (pinned) {
      card.style.left = r.x0 + "px";
      card.style.top = r.y1 - card.offsetHeight + "px";
      svg.style.display = "none";
      return;
    }

    var UI = uiScale();
    var dx = 46 * UI, dy = 30 * UI;
    var x, y;
    function place(cw, ch) {
      x = pick.pt.x + dx;
      y = pick.pt.y - dy - ch;
      if (x + cw > r.x1) x = pick.pt.x - dx - cw;
      if (y < r.y0) y = pick.pt.y + dy;
      x = Math.max(r.x0, Math.min(x, r.x1 - cw));
      y = Math.max(r.y0, Math.min(y, r.y1 - ch));
      card.style.left = x + "px";
      card.style.top = y + "px";
    }
    var cw = card.offsetWidth, ch = card.offsetHeight;
    place(cw, ch);
    if (card.offsetWidth !== cw || card.offsetHeight !== ch) {
      cw = card.offsetWidth;
      ch = card.offsetHeight;
      place(cw, ch);
    }

    var corners = [[x, y], [x + cw, y], [x, y + ch], [x + cw, y + ch]];
    var end = corners[0], bd = Infinity;
    corners.forEach(function (c) {
      var d = (c[0] - pick.pt.x) * (c[0] - pick.pt.x) + (c[1] - pick.pt.y) * (c[1] - pick.pt.y);
      if (d < bd) { bd = d; end = c; }
    });
    var ang = Math.atan2(end[1] - pick.pt.y, end[0] - pick.pt.x);
    var rim = magRadius(p.mag) * UI + 3 * UI;
    var sx = pick.pt.x + Math.cos(ang) * rim;
    var sy = pick.pt.y + Math.sin(ang) * rim;

    var size = map.getSize();
    svg.setAttribute("width", size.x);
    svg.setAttribute("height", size.y);
    svg.setAttribute("viewBox", "0 0 " + size.x + " " + size.y);
    var under = document.getElementById("poi-line-under");
    var over = document.getElementById("poi-line-over");
    [under, over].forEach(function (ln) {
      ln.setAttribute("x1", sx); ln.setAttribute("y1", sy);
      ln.setAttribute("x2", end[0]); ln.setAttribute("y2", end[1]);
      ln.setAttribute("stroke-linecap", "round");
    });
    under.setAttribute("stroke", "rgba(4,7,14,0.9)");
    under.setAttribute("stroke-width", 2.4 * UI);
    over.setAttribute("stroke", "rgba(233,237,246,0.55)");
    over.setAttribute("stroke-width", Math.max(1, UI));
    svg.style.display = "block";
  }

  function renderRail(features) {
    var list = document.getElementById("event-list");
    var empty = document.getElementById("empty-state");
    list.innerHTML = "";

    if (!features.length) { empty.hidden = false; return; }
    empty.hidden = true;

    var recent = features.slice()
      .sort(function (a, b) { return b.properties.time - a.properties.time; })
      .slice(0, 15);

    recent.forEach(function (f) {
      var p = f.properties;
      var pp = parsePlace(p);
      var li = document.createElement("li");
      li.className = "event";

      var magBox = document.createElement("div");
      magBox.className = "event-mag";
      var rule = document.createElement("span");
      rule.className = "event-rule";
      rule.style.background = magColor(p.mag);
      var num = document.createElement("span");
      num.className = "event-mag-num";
      num.textContent = p.mag === null ? "–" : p.mag.toFixed(1);
      magBox.appendChild(rule);
      magBox.appendChild(num);

      var body = document.createElement("div");
      body.className = "event-body";
      var place = document.createElement("div");
      place.className = "event-place";
      place.textContent = pp.name;
      var meta = document.createElement("div");
      meta.className = "event-meta";
      var depth = f.geometry && f.geometry.coordinates ? f.geometry.coordinates[2] : null;
      var bits = [relTime(p.time)];
      if (pp.dist) bits.push(pp.dist);
      if (depth !== null && depth !== undefined) bits.push(fmtDist(depth) + " deep");
      meta.textContent = bits.join(" · ");
      if (p.tsunami) {
        var t = document.createElement("span");
        t.className = "tag-tsunami";
        t.textContent = "TSUNAMI";
        meta.appendChild(t);
      }
      body.appendChild(place);
      body.appendChild(meta);

      li.appendChild(magBox);
      li.appendChild(body);
      list.appendChild(li);
    });
  }

  function renderTsunami(features) {
    var el = document.getElementById("tsunami");
    var flagged = features.filter(function (f) { return f.properties.tsunami; })
      .sort(function (a, b) { return (b.properties.mag || 0) - (a.properties.mag || 0); });
    if (!flagged.length) { el.hidden = true; return; }
    var p = flagged[0].properties;
    document.getElementById("tsunami-text").textContent =
      "M" + (p.mag || 0).toFixed(1) + " · " + (p.place || "unknown location") + " · " + relTime(p.time) +
      (flagged.length > 1 ? "  (+" + (flagged.length - 1) + " more)" : "");
    el.hidden = false;
  }

  function renderStats(features) {
    var count = features.length;
    var max = features.reduce(function (mx, f) { return Math.max(mx, f.properties.mag || 0); }, 0);
    document.getElementById("stat-count").textContent = count;
    document.getElementById("stat-max").textContent = count ? "M" + max.toFixed(1) : "–";
    document.getElementById("max-dot").style.background = count ? magColor(max) : "";
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

  function toast(msg) {
    var el = document.getElementById("toast");
    if (!msg) { el.hidden = true; return; }
    el.textContent = msg;
    el.hidden = false;
  }

  function load() {
    fetch(feedUrl(), { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        var features = (data && data.features) || [];
        logLine("feed ok · " + features.length + " quakes");
        plot(features);
        renderRail(features);
        renderStats(features);
        renderTsunami(features);
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
    setInterval(function () { if (lastFeatures) updatePoi(lastFeatures); }, 60 * 1000);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { if (lastFeatures) updatePoi(lastFeatures); });
    }
    setTimeout(markReady, 8000);
    var resizeTimer = null;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (!map) return;
        map.invalidateSize();
        if (lastFeatures) plot(lastFeatures);
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
