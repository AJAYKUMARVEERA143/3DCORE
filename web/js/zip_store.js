/**
 * Uncompressed ZIP (STORE). No third-party zip library — just PK headers
 * so a client pack is a real .zip a phone/desktop can open.
 */
(function (root) {
    'use strict';

    var CRC_TABLE = (function () {
        var t = new Uint32Array(256);
        for (var i = 0; i < 256; i++) {
            var c = i;
            for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            t[i] = c >>> 0;
        }
        return t;
    })();

    function crc32(bytes) {
        var c = 0xFFFFFFFF;
        for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    function toBytes(data) {
        if (data == null) return new Uint8Array(0);
        if (typeof data === 'string') {
            if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(data);
            var arr = [];
            for (var i = 0; i < data.length; i++) arr.push(data.charCodeAt(i) & 0xFF);
            return new Uint8Array(arr);
        }
        if (data instanceof ArrayBuffer) return new Uint8Array(data);
        if (data.buffer && typeof data.byteLength === 'number') {
            return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
        }
        return new Uint8Array(data);
    }

    function u16(n) { return n & 0xFFFF; }

    function writeU32(view, offset, n) { view.setUint32(offset, n >>> 0, true); }
    function writeU16(view, offset, n) { view.setUint16(offset, u16(n), true); }

    function concat(parts) {
        var total = 0, i;
        for (i = 0; i < parts.length; i++) total += parts[i].length;
        var out = new Uint8Array(total);
        var o = 0;
        for (i = 0; i < parts.length; i++) { out.set(parts[i], o); o += parts[i].length; }
        return out;
    }

    /**
     * @param {Array<{name:string, data:string|ArrayBuffer|Uint8Array}>} files
     * @returns {Uint8Array}
     */
    function buildZip(files) {
        files = files || [];
        var locals = [];
        var centrals = [];
        var offset = 0;
        var encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

        for (var f = 0; f < files.length; f++) {
            var name = String(files[f].name || 'file').replace(/\\/g, '/');
            var nameBytes = encoder ? encoder.encode(name) : toBytes(name);
            var data = toBytes(files[f].data);
            var crc = crc32(data);

            var local = new Uint8Array(30 + nameBytes.length + data.length);
            var lv = new DataView(local.buffer);
            writeU32(lv, 0, 0x04034b50);
            writeU16(lv, 4, 20);
            writeU16(lv, 6, 0);
            writeU16(lv, 8, 0);
            writeU16(lv, 10, 0);
            writeU16(lv, 12, 0);
            writeU32(lv, 14, crc);
            writeU32(lv, 18, data.length);
            writeU32(lv, 22, data.length);
            writeU16(lv, 26, nameBytes.length);
            writeU16(lv, 28, 0);
            local.set(nameBytes, 30);
            local.set(data, 30 + nameBytes.length);
            locals.push(local);

            var central = new Uint8Array(46 + nameBytes.length);
            var cv = new DataView(central.buffer);
            writeU32(cv, 0, 0x02014b50);
            writeU16(cv, 4, 20);
            writeU16(cv, 6, 20);
            writeU16(cv, 8, 0);
            writeU16(cv, 10, 0);
            writeU16(cv, 12, 0);
            writeU16(cv, 14, 0);
            writeU32(cv, 16, crc);
            writeU32(cv, 20, data.length);
            writeU32(cv, 24, data.length);
            writeU16(cv, 28, nameBytes.length);
            writeU16(cv, 30, 0);
            writeU16(cv, 32, 0);
            writeU16(cv, 34, 0);
            writeU16(cv, 36, 0);
            writeU32(cv, 38, 0);
            writeU32(cv, 42, offset);
            central.set(nameBytes, 46);
            centrals.push(central);

            offset += local.length;
        }

        var centralBlob = concat(centrals);
        var eocd = new Uint8Array(22);
        var ev = new DataView(eocd.buffer);
        writeU32(ev, 0, 0x06054b50);
        writeU16(ev, 4, 0);
        writeU16(ev, 6, 0);
        writeU16(ev, 8, files.length);
        writeU16(ev, 10, files.length);
        writeU32(ev, 12, centralBlob.length);
        writeU32(ev, 16, offset);
        writeU16(ev, 20, 0);

        return concat(locals.concat([centralBlob, eocd]));
    }

    var api = { crc32: crc32, buildZip: buildZip, toBytes: toBytes };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.ZipStore = api;
})(typeof window !== 'undefined' ? window : globalThis);
