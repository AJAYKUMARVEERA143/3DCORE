/**
 * Client-side mesh I/O: OBJ, STL (ASCII + binary), ASCII DXF LINE/LWPOLYLINE.
 * No Three.js — returns typed mesh snapshots the editor converts to BufferGeometry.
 */
(function (root) {
    'use strict';

    function triangulateFace(idx) {
        var tris = [];
        if (idx.length < 3) return tris;
        for (var i = 1; i < idx.length - 1; i++) {
            tris.push(idx[0], idx[i], idx[i + 1]);
        }
        return tris;
    }

    function parseFaceToken(tok) {
        var parts = tok.split('/');
        var vi = parseInt(parts[0], 10);
        return vi;
    }

    function resolveIndex(i, count) {
        if (!i) return 0;
        if (i < 0) return count + i;
        return i - 1;
    }

    function parseOBJ(text) {
        var lines = String(text || '').split(/\r?\n/);
        var positions = [];
        var objects = [];
        var current = { name: 'Mesh', faces: [] };
        var i, line, parts, name;

        function flush() {
            if (!current.faces.length) return;
            var pos = [];
            var indices = [];
            var v = 0;
            for (var f = 0; f < current.faces.length; f++) {
                var face = current.faces[f];
                var mapped = [];
                for (var k = 0; k < face.length; k++) {
                    var src = face[k] * 3;
                    pos.push(positions[src], positions[src + 1], positions[src + 2]);
                    mapped.push(v++);
                }
                var tris = triangulateFace(mapped);
                for (var t = 0; t < tris.length; t++) indices.push(tris[t]);
            }
            objects.push({ name: current.name, positions: pos, indices: indices });
            current = { name: current.name, faces: [] };
        }

        for (i = 0; i < lines.length; i++) {
            line = lines[i].trim();
            if (!line || line.charAt(0) === '#') continue;
            parts = line.split(/\s+/);
            if (parts[0] === 'v' && parts.length >= 4) {
                positions.push(parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3]));
            } else if ((parts[0] === 'o' || parts[0] === 'g') && parts[1]) {
                flush();
                name = parts.slice(1).join(' ');
                current.name = name;
            } else if (parts[0] === 'f' && parts.length >= 4) {
                var faceIdx = [];
                for (var p = 1; p < parts.length; p++) {
                    var vi = parseFaceToken(parts[p]);
                    if (isNaN(vi)) continue;
                    faceIdx.push(resolveIndex(vi, positions.length / 3));
                }
                if (faceIdx.length >= 3) current.faces.push(faceIdx);
            }
        }
        flush();
        return { objects: objects };
    }

    function serializeOBJ(meshes) {
        meshes = meshes || [];
        var out = ['# 3D Core Studio OBJ'];
        var vBase = 1;
        for (var m = 0; m < meshes.length; m++) {
            var mesh = meshes[m];
            var name = (mesh.name || 'Mesh').replace(/\s+/g, '_');
            out.push('o ' + name);
            var pos = mesh.positions || [];
            var nVert = (pos.length / 3) | 0;
            var i;
            for (i = 0; i < nVert; i++) {
                out.push('v ' + pos[i * 3] + ' ' + pos[i * 3 + 1] + ' ' + pos[i * 3 + 2]);
            }
            var indices = mesh.indices;
            if (indices && indices.length) {
                for (i = 0; i + 2 < indices.length; i += 3) {
                    out.push('f ' + (indices[i] + vBase) + ' ' + (indices[i + 1] + vBase) + ' ' + (indices[i + 2] + vBase));
                }
            } else {
                for (i = 0; i + 2 < nVert; i += 3) {
                    out.push('f ' + (i + vBase) + ' ' + (i + 1 + vBase) + ' ' + (i + 2 + vBase));
                }
            }
            vBase += nVert;
        }
        return out.join('\n') + '\n';
    }

    function triangleNormal(ax, ay, az, bx, by, bz, cx, cy, cz) {
        var ux = bx - ax, uy = by - ay, uz = bz - az;
        var vx = cx - ax, vy = cy - ay, vz = cz - az;
        var nx = uy * vz - uz * vy;
        var ny = uz * vx - ux * vz;
        var nz = ux * vy - uy * vx;
        var len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        return [nx / len, ny / len, nz / len];
    }

    function eachTriangle(meshes, fn) {
        for (var m = 0; m < meshes.length; m++) {
            var pos = meshes[m].positions || [];
            var indices = meshes[m].indices;
            var emit = function (ia, ib, ic) {
                fn(
                    pos[ia * 3], pos[ia * 3 + 1], pos[ia * 3 + 2],
                    pos[ib * 3], pos[ib * 3 + 1], pos[ib * 3 + 2],
                    pos[ic * 3], pos[ic * 3 + 1], pos[ic * 3 + 2]
                );
            };
            if (indices && indices.length) {
                for (var i = 0; i + 2 < indices.length; i += 3) emit(indices[i], indices[i + 1], indices[i + 2]);
            } else {
                var nVert = (pos.length / 3) | 0;
                for (var t = 0; t + 2 < nVert; t += 3) emit(t, t + 1, t + 2);
            }
        }
    }

    function serializeSTLAscii(meshes, solidName) {
        var name = (solidName || '3DCore').replace(/\s+/g, '_');
        var lines = ['solid ' + name];
        eachTriangle(meshes || [], function (ax, ay, az, bx, by, bz, cx, cy, cz) {
            var n = triangleNormal(ax, ay, az, bx, by, bz, cx, cy, cz);
            lines.push('  facet normal ' + n[0] + ' ' + n[1] + ' ' + n[2]);
            lines.push('    outer loop');
            lines.push('      vertex ' + ax + ' ' + ay + ' ' + az);
            lines.push('      vertex ' + bx + ' ' + by + ' ' + bz);
            lines.push('      vertex ' + cx + ' ' + cy + ' ' + cz);
            lines.push('    endloop');
            lines.push('  endfacet');
        });
        lines.push('endsolid ' + name);
        return lines.join('\n') + '\n';
    }

    function isAsciiSTL(text) {
        var head = String(text || '').slice(0, 80).toLowerCase();
        return head.indexOf('solid') !== -1 && head.indexOf('\0') === -1;
    }

    function parseSTLAscii(text) {
        var positions = [];
        var re = /vertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/gi;
        var match;
        while ((match = re.exec(text))) {
            positions.push(parseFloat(match[1]), parseFloat(match[2]), parseFloat(match[3]));
        }
        return { objects: positions.length ? [{ name: 'STL', positions: positions, indices: null }] : [] };
    }

    function parseSTLBinary(buffer) {
        var view = buffer instanceof DataView ? buffer : new DataView(buffer);
        if (view.byteLength < 84) return { objects: [] };
        var count = view.getUint32(80, true);
        var need = 84 + count * 50;
        if (view.byteLength < need) count = Math.floor((view.byteLength - 84) / 50);
        var positions = [];
        var offset = 84;
        for (var i = 0; i < count; i++) {
            offset += 12;
            for (var v = 0; v < 3; v++) {
                positions.push(view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true));
                offset += 12;
            }
            offset += 2;
        }
        return { objects: positions.length ? [{ name: 'STL', positions: positions, indices: null }] : [] };
    }

    function parseSTL(input) {
        if (input == null) return { objects: [] };
        if (typeof input === 'string') return parseSTLAscii(input);
        var buf = input;
        if (buf.buffer && !buf.byteLength && buf.buffer.byteLength) buf = buf.buffer;
        if (buf instanceof ArrayBuffer) {
            var bytes = new Uint8Array(buf, 0, Math.min(80, buf.byteLength));
            var head = '';
            for (var i = 0; i < bytes.length; i++) {
                if (bytes[i] === 0) { head = ''; break; }
                head += String.fromCharCode(bytes[i]);
            }
            if (head.toLowerCase().indexOf('solid') === 0 && buf.byteLength > 84) {
                var asText = '';
                try {
                    asText = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { fatal: false }).decode(buf) : '';
                } catch (e) { asText = ''; }
                if (asText && /facet\s+normal/i.test(asText)) return parseSTLAscii(asText);
            }
            return parseSTLBinary(buf);
        }
        return parseSTLAscii(String(input));
    }

    function parseDXFPairs(text) {
        var raw = String(text || '').split(/\r?\n/);
        var pairs = [];
        for (var i = 0; i + 1 < raw.length; i += 2) {
            var code = parseInt(raw[i].trim(), 10);
            if (isNaN(code)) continue;
            pairs.push({ code: code, value: raw[i + 1] });
        }
        return pairs;
    }

    function parseDXF(text) {
        var pairs = parseDXFPairs(text);
        var lines = [];
        var polylines = [];
        var hasEntitiesSection = false;
        var i, j, p;
        for (i = 0; i < pairs.length; i++) {
            if (pairs[i].code === 2 && String(pairs[i].value).trim().toUpperCase() === 'ENTITIES') {
                hasEntitiesSection = true;
                break;
            }
        }
        var inEntities = !hasEntitiesSection;
        i = 0;
        while (i < pairs.length) {
            p = pairs[i];
            if (p.code === 0 && String(p.value).trim() === 'SECTION') {
                var sec = '';
                for (j = i + 1; j < Math.min(i + 8, pairs.length); j++) {
                    if (pairs[j].code === 2) { sec = String(pairs[j].value).trim().toUpperCase(); break; }
                }
                inEntities = sec === 'ENTITIES';
            }
            if (p.code === 0 && String(p.value).trim() === 'ENDSEC') inEntities = false;
            if (inEntities && p.code === 0) {
                var type = String(p.value).trim().toUpperCase();
                if (type === 'LINE') {
                    var x1 = 0, y1 = 0, x2 = 0, y2 = 0;
                    i++;
                    while (i < pairs.length && pairs[i].code !== 0) {
                        if (pairs[i].code === 10) x1 = parseFloat(pairs[i].value);
                        if (pairs[i].code === 20) y1 = parseFloat(pairs[i].value);
                        if (pairs[i].code === 11) x2 = parseFloat(pairs[i].value);
                        if (pairs[i].code === 21) y2 = parseFloat(pairs[i].value);
                        i++;
                    }
                    lines.push({ x1: x1, y1: y1, x2: x2, y2: y2 });
                    continue;
                }
                if (type === 'LWPOLYLINE') {
                    var pts = [];
                    var closed = false;
                    var cur = null;
                    i++;
                    while (i < pairs.length && pairs[i].code !== 0) {
                        if (pairs[i].code === 70) closed = !!(parseInt(pairs[i].value, 10) & 1);
                        if (pairs[i].code === 10) {
                            cur = { x: parseFloat(pairs[i].value), y: 0 };
                            pts.push(cur);
                        } else if (pairs[i].code === 20 && cur) {
                            cur.y = parseFloat(pairs[i].value);
                        }
                        i++;
                    }
                    if (pts.length >= 2) polylines.push({ closed: closed, points: pts });
                    continue;
                }
            }
            i++;
        }
        return { lines: lines, polylines: polylines };
    }

    var api = {
        parseOBJ: parseOBJ,
        parseOBJ: parseOBJ,
        serializeOBJ: serializeOBJ,
        parseSTL: parseSTL,
        parseSTLAscii: parseSTLAscii,
        parseSTLBinary: parseSTLBinary,
        serializeSTLAscii: serializeSTLAscii,
        serializeSTLAscii: serializeSTLAscii,
        parseDXF: parseDXF,
        isAsciiSTL: isAsciiSTL
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.FormatIO = api;
    root.FormatIO = api;
})(typeof window !== 'undefined' ? window : globalThis);
