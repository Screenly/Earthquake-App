var maths = (function () {
    "use strict";

    function calculateDistanceKm(from, to) {
        var toRadians = Math.PI / 180;
        var deltaLat = (to.lat - from.lat) * toRadians;
        var deltaLng = (to.lng - from.lng) * toRadians;
        var sinLat = Math.sin(deltaLat / 2), sinLng = Math.sin(deltaLng / 2);
        var haversine = sinLat * sinLat + Math.cos(from.lat * toRadians) * Math.cos(to.lat * toRadians) * sinLng * sinLng;
        return 12742 * Math.asin(Math.sqrt(haversine));
    }
    function calculateCompassDirection(from, to) {
        var toRadians = Math.PI / 180;
        var deltaLng = (to.lng - from.lng) * toRadians;
        var east = Math.sin(deltaLng) * Math.cos(to.lat * toRadians);
        var north = Math.cos(from.lat * toRadians) * Math.sin(to.lat * toRadians) -
            Math.sin(from.lat * toRadians) * Math.cos(to.lat * toRadians) * Math.cos(deltaLng);
        var degrees = (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
        return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(degrees / 45) % 8];
    }
    function wrapLongitude(lng, centerLng) {
        while (lng < centerLng - 180) lng += 360;
        while (lng >= centerLng + 180) lng -= 360;
        return lng;
    }
    function parseCoordinates(raw) {
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
    function calculateDotRadius(magnitude) {
        var clampedMagnitude = Math.max(magnitude, 0.5);
        return Math.min(1.6 + Math.pow(clampedMagnitude, 1.6) * 0.38, 16);
    }
    function calculateQuakeScore(magnitude, hoursAgo, distanceKm) {
        var score = magnitude - hoursAgo / 36;
        if (distanceKm === null || distanceKm === undefined) return score;
        return score - distanceKm / 1400;
    }
    function isPointInsideArea(point, area) {
        return point.x >= area.x0 && point.x <= area.x1 && point.y >= area.y0 && point.y <= area.y1;
    }
    function calculateCardPosition(point, cardWidth, cardHeight, area, offsetX, offsetY) {
        var left = point.x + offsetX;
        var top = point.y - offsetY - cardHeight;
        if (left + cardWidth > area.x1) left = point.x - offsetX - cardWidth;
        if (top < area.y0) top = point.y + offsetY;
        left = Math.max(area.x0, Math.min(left, area.x1 - cardWidth));
        top = Math.max(area.y0, Math.min(top, area.y1 - cardHeight));
        return { left: left, top: top };
    }
    function calculateLeaderLine(cardRect, point, dotEdgeRadius) {
        var corners = [
            [cardRect.left, cardRect.top],
            [cardRect.left + cardRect.width, cardRect.top],
            [cardRect.left, cardRect.top + cardRect.height],
            [cardRect.left + cardRect.width, cardRect.top + cardRect.height],
        ];
        var nearestCorner = corners[0], nearestDistance = Infinity;
        corners.forEach(function (corner) {
            var distance = (corner[0] - point.x) * (corner[0] - point.x) +
                (corner[1] - point.y) * (corner[1] - point.y);
            if (distance < nearestDistance) { nearestDistance = distance; nearestCorner = corner; }
        });
        var angle = Math.atan2(nearestCorner[1] - point.y, nearestCorner[0] - point.x);
        return {
            x1: point.x + Math.cos(angle) * dotEdgeRadius,
            y1: point.y + Math.sin(angle) * dotEdgeRadius,
            x2: nearestCorner[0],
            y2: nearestCorner[1],
        };
    }
    function shiftGeoJsonEast(geoJson) {
        function shift(coords) {
            if (typeof coords[0] === "number") return [coords[0] + 360, coords[1]];
            return coords.map(shift);
        }
        return {
            type: "FeatureCollection",
            features: geoJson.features.map(function (feature) {
                return {
                    type: "Feature", properties: {},
                    geometry: { type: feature.geometry.type, coordinates: shift(feature.geometry.coordinates) },
                };
            }),
        };
    }

    return {
        calculateDistanceKm: calculateDistanceKm,
        calculateCompassDirection: calculateCompassDirection,
        wrapLongitude: wrapLongitude,
        parseCoordinates: parseCoordinates,
        calculateDotRadius: calculateDotRadius,
        calculateQuakeScore: calculateQuakeScore,
        isPointInsideArea: isPointInsideArea,
        calculateCardPosition: calculateCardPosition,
        calculateLeaderLine: calculateLeaderLine,
        shiftGeoJsonEast: shiftGeoJsonEast,
    };
})();
