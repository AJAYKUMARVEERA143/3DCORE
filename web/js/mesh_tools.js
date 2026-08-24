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

    function faceNormal(positions, f) {
        var o = f * 9;
        var ax = positions[o], ay = positions[o + 1], az = positions[o + 2];
        var bx = positions[o + 3], by = positions[o + 4], bz = positions[o + 5];
        var cx = positions[o + 6], cy = positions[o + 7], cz = positions[o + 8];
        var ux = bx - ax, uy = by - ay, uz = bz - az;
        var vx = cx - ax, vy = cy - ay, vz = cz - az;
        var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        var len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        return [nx / len, ny / len, nz / len];
    }

    function selectFaceLoop(seed, adj, positions) {
        seed = seed | 0;
        adj = adj || [];
        var out = [seed];
        var seen = {};
        seen[seed] = true;
        var prev = -1;
        var cur = seed;
        var guard = 0;
        var seedN = positions ? faceNormal(positions, seed) : [0, 0, 1];
        while (guard++ < 4096) {
            var nbrs = adj[cur] || [];
            var best = -1, bestDot = 0.82;
            var i, n, d;
            for (i = 0; i < nbrs.length; i++) {
                n = nbrs[i];
                if (n === prev || seen[n]) continue;
                if (positions) {
                    var nn = faceNormal(positions, n);
                    d = nn[0] * seedN[0] + nn[1] * seedN[1] + nn[2] * seedN[2];
                    if (d < bestDot) continue;
                    bestDot = d;
                }
                best = n;
            }
            if (best < 0) break;
            seen[best] = true;
            out.push(best);
            prev = cur;
            cur = best;
            if (best === seed) break;
        }
        return uniqueSorted(out);
    }

    function boundaryEdges(positions, faces) {
        var count = {};
        var verts = {};
        var nAll = faceCount(positions);
        var list = faces && faces.length ? faces : [];
        if (!list.length) {
            for (var f0 = 0; f0 < nAll; f0++) list.push(f0);
        }
        var i, f, v, keys, ek;
        for (i = 0; i < list.length; i++) {
            f = list[i];
            keys = [];
            for (v = 0; v < 3; v++) {
                var o = f * 9 + v * 3;
                keys.push(vertexKey(positions[o], positions[o + 1], positions[o + 2]));
            }
            [[0, 1], [1, 2], [2, 0]].forEach(function (e) {
                ek = edgeKey(keys[e[0]], keys[e[1]]);
                count[ek] = (count[ek] || 0) + 1;
                if (!verts[ek]) verts[ek] = [keys[e[0]], keys[e[1]]];
            });
        }
        var out = [];
        Object.keys(count).forEach(function (k) {
            if (count[k] === 1) out.push(verts[k]);
        });
        return out;
    }

    function parseKey(k) {
        var p = String(k).split(',');
        return [parseFloat(p[0]), parseFloat(p[1]), parseFloat(p[2])];
    }

    function fillBoundaryFan(positions, faces) {
        var edges = boundaryEdges(positions, faces);
        if (edges.length < 3) return [];
        var adj = {};
        edges.forEach(function (e) {
            if (!adj[e[0]]) adj[e[0]] = [];
            if (!adj[e[1]]) adj[e[1]] = [];
            adj[e[0]].push(e[1]);
            adj[e[1]].push(e[0]);
        });
        var start = Object.keys(adj)[0];
        var loop = [start];
        var prev = null, cur = start, guard = 0;
        while (guard++ < 4096) {
            var opts = adj[cur] || [];
            var nxt = opts[0] === prev ? opts[1] : opts[0];
            if (!nxt) break;
            if (nxt === start) break;
            loop.push(nxt);
            prev = cur;
            cur = nxt;
        }
        if (loop.length < 3) return [];
        var pts = loop.map(parseKey);
        var extra = [];
        var a = pts[0], j;
        for (j = 1; j < pts.length - 1; j++) {
            extra.push(a[0], a[1], a[2], pts[j][0], pts[j][1], pts[j][2], pts[j + 1][0], pts[j + 1][1], pts[j + 1][2]);
        }
        return extra;
    }

    function applyFalloffMove(orig, seedIndex, dx, dy, dz, radius, kind) {
        var src = orig;
        var out = new Float32Array(src.length);
        out.set(src);
        var n = Math.floor(out.length / 3);
        var si = seedIndex | 0;
        if (si < 0 || si >= n) return out;
        var sx = src[si * 3], sy = src[si * 3 + 1], sz = src[si * 3 + 2];
        var i, d, w;
        for (i = 0; i < n; i++) {
            d = Math.hypot(src[i * 3] - sx, src[i * 3 + 1] - sy, src[i * 3 + 2] - sz);
            w = falloffWeight(d, radius, kind);
            out[i * 3] = src[i * 3] + dx * w;
            out[i * 3 + 1] = src[i * 3 + 1] + dy * w;
            out[i * 3 + 2] = src[i * 3 + 2] + dz * w;
        }
        return out;
    }

    var api = {
        vertexKey: vertexKey,
        faceCount: faceCount,
        buildFaceAdjacency: buildFaceAdjacency,
        growFaceSelection: growFaceSelection,
        shrinkFaceSelection: shrinkFaceSelection,
        selectLinkedFaces: selectLinkedFaces,
        selectFaceLoop: selectFaceLoop,
        boundaryEdges: boundaryEdges,
        fillBoundaryFan: fillBoundaryFan,
        fillBoundaryFan: fillBoundaryFan,
        applyFalloffMove: applyFalloffMove,
        applyFalloffMove: applyFalloffMove,
        falloffWeight: falloffWeight,
        pointInPolygon: pointInPolygon
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.MeshTools = api;
})(typeof window !== 'undefined' ? window : globalThis);
