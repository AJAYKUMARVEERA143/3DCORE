/**
 * Plan-view BIM helpers (no Three.js). Walls are XY polylines; Z is storey height.
 */
(function (root) {
    'use strict';

    function snapKey(x, y, digits) {
        var f = Math.pow(10, digits == null ? 2 : digits);
        return Math.round(x * f) + ',' + Math.round(y * f);
    }

    function polygonArea(pts) {
        if (!pts || pts.length < 3) return 0;
        var a = 0, i, j, n = pts.length;
        for (i = 0; i < n; i++) {
            j = (i + 1) % n;
            a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
        }
        return Math.abs(a) * 0.5;
    }

    function polygonCentroid(pts) {
        if (!pts || !pts.length) return { x: 0, y: 0 };
        var x = 0, y = 0, i;
        for (i = 0; i < pts.length; i++) { x += pts[i].x; y += pts[i].y; }
        return { x: x / pts.length, y: y / pts.length };
    }

    function loopsFromSegments(segments, digits) {
        var adj = {};
        (segments || []).forEach(function (s) {
            var a = snapKey(s.x1, s.y1, digits);
            var b = snapKey(s.x2, s.y2, digits);
            if (a === b) return;
            if (!adj[a]) adj[a] = [];
            if (!adj[b]) adj[b] = [];
            adj[a].push(b);
            adj[b].push(a);
        });
        var used = {};
        var loops = [];
        function mark(u, v) { used[u + '>' + v] = true; used[v + '>' + u] = true; }
        Object.keys(adj).forEach(function (start) {
            (adj[start] || []).forEach(function (first) {
                if (used[start + '>' + first]) return;
                var loopKeys = [start];
                var prev = start, cur = first;
                mark(start, first);
                var guard = 0;
                while (cur !== start && guard++ < 4096) {
                    loopKeys.push(cur);
                    var nbrs = adj[cur] || [];
                    var nxt = null, i;
                    for (i = 0; i < nbrs.length; i++) {
                        if (nbrs[i] !== prev && !used[cur + '>' + nbrs[i]]) { nxt = nbrs[i]; break; }
                    }
                    if (nxt == null) {
                        for (i = 0; i < nbrs.length; i++) {
                            if (nbrs[i] !== prev) { nxt = nbrs[i]; break; }
                        }
                    }
                    if (nxt == null) return;
                    mark(cur, nxt);
                    prev = cur;
                    cur = nxt;
                }
                if (cur === start && loopKeys.length >= 3) {
                    var pts = loopKeys.map(function (k) {
                        var p = k.split(',');
                        return { x: parseFloat(p[0]) / 100, y: parseFloat(p[1]) / 100 };
                    });
                    if (digits == null) digits = 2;
                    pts = loopKeys.map(function (k) {
                        var p = k.split(',');
                        var f = Math.pow(10, digits);
                        return { x: parseFloat(p[0]) / f, y: parseFloat(p[1]) / f };
                    });
                    loops.push(pts);
                }
            });
        });
        return loops;
    }

    function csvEscape(v) {
        var s = String(v == null ? '' : v);
        if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
        return s;
    }

    function buildScheduleCsv(rows) {
        rows = rows || [];
        if (!rows.length) return 'kind,name,qty,length_m,area_m2,notes\n';
        var keys = Object.keys(rows[0]);
        var lines = [keys.join(',')];
        rows.forEach(function (r) {
            lines.push(keys.map(function (k) { return csvEscape(r[k]); }).join(','));
        });
        return lines.join('\n') + '\n';
    }

    function serializeDXF(lines) {
        var out = ['0', 'SECTION', '2', 'HEADER', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES'];
        (lines || []).forEach(function (ln) {
            out.push('0', 'LINE', '8', ln.layer || 'WALLS',
                '10', String(ln.x1), '20', String(ln.y1), '30', '0',
                '11', String(ln.x2), '21', String(ln.y2), '31', '0');
        });
        out.push('0', 'ENDSEC', '0', 'EOF');
        return out.join('\n');
    }

    var DOOR = { width: 0.9, height: 2.1, sill: 0, depth: 0.08 };
    var WINDOW = { width: 1.2, height: 1.2, sill: 0.9, depth: 0.08 };

    var api = {
        snapKey: snapKey,
        polygonArea: polygonArea,
        polygonArea: polygonArea,
        polygonCentroid: polygonCentroid,
        polygonCentroid: polygonCentroid,
        loopsFromSegments: loopsFromSegments,
        loopsFromSegments: loopsFromSegments,
        csvEscape: csvEscape,
        buildScheduleCsv: buildScheduleCsv,
        buildScheduleCsv: buildScheduleCsv,
        serializeDXF: serializeDXF,
        DOOR: DOOR,
        WINDOW: WINDOW
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.BimKit = api;
    root.BimKit = api;
})(typeof window !== 'undefined' ? window : globalThis);
