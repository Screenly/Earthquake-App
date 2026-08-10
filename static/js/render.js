var render = (function () {
    "use strict";

    // Colours + Scale

    var magnitudeColors = null;

    function readCssVar(name) {
        return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    }
    function readColors() {
        magnitudeColors = {
            m0: readCssVar("--m0"), m1: readCssVar("--m1"), m2: readCssVar("--m2"),
            m3: readCssVar("--m3"), m4: readCssVar("--m4"), m5: readCssVar("--m5"),
        };
    }
    function pickMagnitudeColor(magnitude) {
        if (!magnitudeColors) readColors();
        if (magnitude >= 7) return magnitudeColors.m5;
        if (magnitude >= 6) return magnitudeColors.m4;
        if (magnitude >= 5) return magnitudeColors.m3;
        if (magnitude >= 4) return magnitudeColors.m2;
        if (magnitude >= 2.5) return magnitudeColors.m1;
        return magnitudeColors.m0;
    }
    function readUiScale() {
        return (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) / 16;
    }


    // Map

    var map = null, quakeLayer = null, screenMarker = null;
    var viewCenterLng = 0;
    var worldBounds = [[-56, -25], [76, 335]];
    var worldCenterLng = 155;
    var focusZoom = 4.5;

    function wrapLongitude(lng) {
        return maths.wrapLongitude(lng, viewCenterLng);
    }
    function createMap(focus) {
        map = L.map("map", {
            zoomControl: false,
            attributionControl: false,
            keyboard: false, dragging: false, scrollWheelZoom: false,
            doubleClickZoom: false, boxZoom: false, touchZoom: false,
            zoomSnap: 0.1,
            preferCanvas: true,
        });

        if (focus) {
            viewCenterLng = focus.lng;
            map.setView([focus.lat, focus.lng], focusZoom);
        } else {
            viewCenterLng = worldCenterLng;
            map.fitBounds(worldBounds);
        }

        map.createPane("base");
        map.getPane("base").style.zIndex = 210;

        drawLand();
        drawPlates();

        quakeLayer = L.layerGroup().addTo(map);

        if (focus) drawScreenMarker(focus.lat, focus.lng);
        return map;
    }
    function drawScreenMarker(lat, lng) {
        if (screenMarker) map.removeLayer(screenMarker);
        var markerSizePx = Math.round(64 * readUiScale());
        var icon = L.divIcon({
            className: "",
            html:
                '<div class="epi">' +
                '<span class="epi-ring"></span>' +
                '<span class="epi-core"></span>' +
                "</div>",
            iconSize: [markerSizePx, markerSizePx],
        });
        screenMarker = L.marker([lat, wrapLongitude(lng)], { icon: icon, interactive: false }).addTo(map);
    }
    function drawLand() {
        if (!window.__WORLD_GEO) {
            showToast("map data unavailable");
            return;
        }
        var scale = readUiScale();
        drawWorldCopies(window.__WORLD_GEO, function (copy) {
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
    }
    function drawPlates() {
        if (!window.__PLATES_GEO) return;
        var scale = readUiScale();
        drawWorldCopies(window.__PLATES_GEO, function (copy) {
            L.geoJSON(copy, {
                interactive: false,
                style: { color: "rgba(4,7,14,0.85)", weight: 2.2 * scale },
            }).addTo(map);
            L.geoJSON(copy, {
                interactive: false,
                style: { color: "rgba(255,115,85,0.55)", weight: 1.1 * scale },
            }).addTo(map);
        });
    }
    function drawWorldCopies(geoJson, draw) {
        draw(geoJson);
        if (viewCenterLng + 180 <= 180) return;
        draw(maths.shiftGeoJsonEast(geoJson));
    }
    function projectToScreen(lat, lng) {
        return map.latLngToContainerPoint([lat, wrapLongitude(lng)]);
    }
    function refreshMapSize() {
        map.invalidateSize();
    }


    // Map Pins

    function drawQuakeDots(quakes) {
        quakeLayer.clearLayers();

        var scale = readUiScale();
        var weakestFirst = quakes.slice().sort(function (a, b) {
            return (a.properties.mag || 0) - (b.properties.mag || 0);
        });

        weakestFirst.forEach(function (quake) {
            var coords = quake.geometry && quake.geometry.coordinates;
            var magnitude = quake.properties.mag;
            if (!coords || magnitude === null || magnitude === undefined) return;
            L.circleMarker([coords[1], wrapLongitude(coords[0])], {
                radius: maths.calculateDotRadius(magnitude) * scale,
                color: "rgba(8,12,22,0.85)", weight: Math.max(1, scale),
                opacity: 0.9,
                fillColor: pickMagnitudeColor(magnitude),
                fillOpacity: 0.6,
            }).addTo(quakeLayer);
        });

        quakeLayer.eachLayer(function (layer) { if (layer.bringToFront) layer.bringToFront(); });
    }


    // Map Label

    function measureLabelArea() {
        var mapSize = map.getSize();
        var rail = document.getElementById("rail");
        var margin = 22 * readUiScale();
        return {
            x0: margin, y0: margin,
            x1: mapSize.x - (rail ? rail.offsetWidth : 0) - margin,
            y1: mapSize.y - margin,
        };
    }
    function drawPoiCard(content) {
        var card = document.getElementById("poi");
        if (!card) return;
        document.getElementById("poi-rule").style.background = content.ruleColor;
        document.getElementById("poi-mag").textContent = content.magnitudeText;
        document.getElementById("poi-name").textContent = content.nameText;
        document.getElementById("poi-meta").textContent = content.metaText;
        card.style.left = "0px";
        card.style.top = "0px";
        card.hidden = false;
    }
    function placePoiCard(card, labelArea, point, offsetX, offsetY) {
        function position(cardWidth, cardHeight) {
            var spot = maths.calculateCardPosition(point, cardWidth, cardHeight, labelArea, offsetX, offsetY);
            card.style.left = spot.left + "px";
            card.style.top = spot.top + "px";
            return spot;
        }
        var cardWidth = card.offsetWidth, cardHeight = card.offsetHeight;
        var spot = position(cardWidth, cardHeight);
        if (card.offsetWidth !== cardWidth || card.offsetHeight !== cardHeight) {
            cardWidth = card.offsetWidth;
            cardHeight = card.offsetHeight;
            spot = position(cardWidth, cardHeight);
        }
        return { left: spot.left, top: spot.top, width: cardWidth, height: cardHeight };
    }
    function drawPoiLine(leaderSvg, line, scale) {
        var mapSize = map.getSize();
        leaderSvg.setAttribute("width", mapSize.x);
        leaderSvg.setAttribute("height", mapSize.y);
        leaderSvg.setAttribute("viewBox", "0 0 " + mapSize.x + " " + mapSize.y);
        var underLine = document.getElementById("poi-line-under");
        var overLine = document.getElementById("poi-line-over");
        [underLine, overLine].forEach(function (lineElement) {
            lineElement.setAttribute("x1", line.x1);
            lineElement.setAttribute("y1", line.y1);
            lineElement.setAttribute("x2", line.x2);
            lineElement.setAttribute("y2", line.y2);
            lineElement.setAttribute("stroke-linecap", "round");
        });
        underLine.setAttribute("stroke", "rgba(4,7,14,0.9)");
        underLine.setAttribute("stroke-width", 2.4 * scale);
        overLine.setAttribute("stroke", "rgba(233,237,246,0.55)");
        overLine.setAttribute("stroke-width", Math.max(1, scale));
        leaderSvg.style.display = "block";
    }
    function placePoi(labelArea, point, magnitude) {
        var card = document.getElementById("poi");
        var leaderSvg = document.getElementById("poi-line");
        if (!card || !leaderSvg) return;
        var scale = readUiScale();
        var cardRect = placePoiCard(card, labelArea, point, 46 * scale, 30 * scale);
        var dotEdgeRadius = maths.calculateDotRadius(magnitude) * scale + 3 * scale;
        var line = maths.calculateLeaderLine(cardRect, point, dotEdgeRadius);
        drawPoiLine(leaderSvg, line, scale);
    }
    function pinPoiCard(labelArea) {
        var card = document.getElementById("poi");
        var leaderSvg = document.getElementById("poi-line");
        if (!card) return;
        card.style.left = labelArea.x0 + "px";
        card.style.top = labelArea.y1 - card.offsetHeight + "px";
        if (leaderSvg) leaderSvg.style.display = "none";
    }
    function hidePoi() {
        var card = document.getElementById("poi");
        var leaderSvg = document.getElementById("poi-line");
        if (card) card.hidden = true;
        if (leaderSvg) leaderSvg.style.display = "none";
    }


    // Rail

    function drawStats(stats) {
        document.getElementById("stat-count").textContent = stats.countText;
        document.getElementById("stat-max").textContent = stats.strongestText;
        document.getElementById("max-dot").style.background = stats.strongestColor;
        document.getElementById("label-count").textContent = stats.windowText;
    }
    function drawRail(rows) {
        var list = document.getElementById("event-list");
        var emptyState = document.getElementById("empty-state");
        list.innerHTML = "";
        emptyState.hidden = !!rows.length;

        rows.forEach(function (row) {
            var item = document.createElement("li");
            item.className = "event";

            var magnitudeCell = document.createElement("div");
            magnitudeCell.className = "event-mag";
            var colorBar = document.createElement("span");
            colorBar.className = "event-rule";
            colorBar.style.background = row.ruleColor;
            var magnitudeNumber = document.createElement("span");
            magnitudeNumber.className = "event-mag-num";
            magnitudeNumber.textContent = row.magnitudeText;
            magnitudeCell.appendChild(colorBar);
            magnitudeCell.appendChild(magnitudeNumber);

            var details = document.createElement("div");
            details.className = "event-body";
            var placeLine = document.createElement("div");
            placeLine.className = "event-place";
            placeLine.textContent = row.placeText;
            var metaLine = document.createElement("div");
            metaLine.className = "event-meta";
            metaLine.textContent = row.metaText;
            details.appendChild(placeLine);
            details.appendChild(metaLine);

            item.appendChild(magnitudeCell);
            item.appendChild(details);
            list.appendChild(item);
        });
    }


    // Toast + Splash

    function showToast(message) {
        var toastElement = document.getElementById("toast");
        if (!message) { toastElement.hidden = true; return; }
        toastElement.textContent = message;
        toastElement.hidden = false;
    }
    function removeSplash() {
        var splash = document.getElementById("splash");
        if (splash) splash.remove();
    }

    return {
        pickMagnitudeColor: pickMagnitudeColor,
        createMap: createMap,
        projectToScreen: projectToScreen,
        refreshMapSize: refreshMapSize,
        drawQuakeDots: drawQuakeDots,
        measureLabelArea: measureLabelArea,
        drawPoiCard: drawPoiCard,
        placePoi: placePoi,
        pinPoiCard: pinPoiCard,
        hidePoi: hidePoi,
        drawStats: drawStats,
        drawRail: drawRail,
        showToast: showToast,
        removeSplash: removeSplash,
    };
})();
