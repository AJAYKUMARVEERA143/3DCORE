/**
 * Selection + falloff math for triangle-soup meshes.
 * No Three.js — app.js supplies a non-indexed position array (xyz xyz xyz per face).
 */
(function (root) {
    'use strict';

    function vertexKey(x, y, z, digits) {
        var d = digits == null ? 4 : digits;
        var f = Math.pow(10, d);
        return Math.round(x * f) + ',' + Math.round(y * f) + ',' + Math.round(z * f);
    }

    function edgeKey(a, b) {
        return a < b ? a + '|' + b : b + '|' + a;
    }

    function faceCount(positions) {
        return Math.floor((positions && positions.length ? positions.length : 0) / 9);
    }

    function buildFaceAdjacency(positions, digits) {
        var n = faceCount(positions);
        var adj = [];
        var i;
        for (i = 0; i < n; i++) adj.push([]);
        var edgeMap = {};
        var f, v, ek, list;
        for (f = 0; f < n; f++) {
            var keys = [];
            for (v = 0; v < 3; v++) {
                var o = f * 9 + v * 3;
                keys.push(vertexKey(positions[o], positions[o + 1], positions[o + 2], digits));
            }
            var edges = [[0, 1], [1, 2], [2, 0]];
            for (i = 0; i < 3; i++) {
                ek = edgeKey(keys[edges[i][0]], keys[edges[i][1]]);
                if (!edgeMap[ek]) edgeMap[ek] = [];
                edgeMap[ek].push(f);
            }
        }
        var eks = Object.keys(edgeMap);
        for (i = 0; i < eks.length; i++) {
            list = edgeMap[eks[i]];
            var a, b;
            for (a = 0; a < list.length; a++) {
                for (b = 0; b < list.length; b++) {
                    if (a === b) continue;
                    if (adj[list[a]].indexOf(list[b]) < 0) adj[list[a]].push(list[b]);
                }
            }
        }
        return adj;
    }

    function uniqueSorted(arr) {
        var seen = {};
        var out = [];
        for (var i = 0; i < arr.length; i++) {
            var v = arr[i] | 0;
            if (seen[v]) continue;
            seen[v] = true;
            out.push(v);
        }
        out.sort(function (x, y) { return x - y; });
        return out;
    }

    function growFaceSelection(selected, adj) {
        var set = {};
        var i, j, f, nbrs;
        selected = selected || [];
        for (i = 0; i < selected.length; i++) set[selected[i]] = true;
        var out = selected.slice();
        for (i = 0; i < selected.length; i++) {
            f = selected[i];
            nbrs = (adj && adj[f]) || [];
            for (j = 0; j < nbrs.length; j++) {
                if (!set[nbrs[j]]) {
                    set[nbrs[j]] = true;
                    out.push(nbrs[j]);
                }
            }
        }
        return uniqueSorted(out);
    }

    function shrinkFaceSelection(selected, adj) {
        var set = {};
        var i, j, f, nbrs, keep;
        selected = selected || [];
        for (i = 0; i < selected.length; i++) set[selected[i]] = true;
        var out = [];
        for (i = 0; i < selected.length; i++) {
            f = selected[i];
            nbrs = (adj && adj[f]) || [];
            keep = nbrs.length > 0;
            for (j = 0; j < nbrs.length; j++) {
                if (!set[nbrs[j]]) { keep = false; break; }
            }
            if (keep) out.push(f);
        }
        return uniqueSorted(out);
    }

    function selectLinkedFaces(seeds, adj) {
        var seen = {};
        var stack = (seeds || []).slice();
        var out = [];
        while (stack.length) {
            var f = stack.pop();
            if (seen[f]) continue;
            seen[f] = true;
            out.push(f);
            var nbrs = (adj && adj[f]) || [];
            for (var i = 0; i < nbrs.length; i++) {
                if (!seen[nbrs[i]]) stack.push(nbrs[i]);
            }
        }
        return uniqueSorted(out);
    }

    function falloffWeight(distance, radius, kind) {
        var d = Number(distance);
        var r = Number(radius);
        if (!(r > 0)) return d === 0 ? 1 : 0;
        if (!(d >= 0) || d >= r) return 0;
        var t = 1 - d / r;
        if (kind === 'constant') return 1;
        if (kind === 'root') return Math.sqrt(t);
        if (kind === 'linear') return t;
        if (kind === 'sphere') return t * t * (3 - 2 * t);
        return t * t;
    }

    function pointInPolygon(x, y, pts) {
        if (!pts || pts.length < 3) return false;
        var inside = false;
        var j = pts.length - 1;
        for (var i = 0; i < pts.length; i++) {
            var xi = pts[i].x, yi = pts[i].y;
            var xj = pts[j].x, yj = pts[j].y;
            var denom = (yj - yi);
            var hit = ((yi > y) !== (yj > y)) &&
                (x < (xj - xi) * (y - yi) / (denom === 0 ? 1e-12 : denom) + xi);
            if (hit) inside = !inside;
            j = i;
        }
        return inside;
    }

    var api = {
        vertexKey: vertexKey,
        faceCount: faceCount,
        buildFaceAdjacency: buildFaceAdjacency,
        growFaceSelection: growFaceSelection,
        shrinkFaceSelection: shrinkFaceSelection,
        selectLinkedFaces: selectLinkedFaces,
        falloffWeight: falloffWeight,
        pointInPolygon: pointInPolygon
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.MeshTools = api;
})(typeof window !== 'undefined' ? window : globalThis);
