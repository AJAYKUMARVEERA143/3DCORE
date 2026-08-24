/**
 * Viewport quality ladder + still-export sizing.
 * No Three.js required — app.js applies these numbers to the live renderer.
 */
(function (root) {
    'use strict';

    var PRESETS = {
        draft:    { id: 'draft',    pixelRatioCap: 1,    shadows: false, shadowSize: 512,  shadowType: 'basic',   post: false, ibl: false, fps: 30, exposure: 1.0,  envIntensity: 0.6 },
        balanced: { id: 'balanced', pixelRatioCap: 1.25, shadows: true,  shadowSize: 1024, shadowType: 'pcf',     post: false, ibl: true,  fps: 60, exposure: 1.0,  envIntensity: 1.0 },
        present:  { id: 'present',  pixelRatioCap: 1.5,  shadows: true,  shadowSize: 2048, shadowType: 'pcfsoft', post: true,  ibl: true,  fps: 60, exposure: 1.15, envIntensity: 1.2 }
    };

    /** WebGL sun/IBL looks — not Cycles worlds. hours drive setTimeOfDay. */
    var LIGHTING = {
        studio:   { id: 'studio',   label: 'Studio noon', hours: 12,    exposure: 1.0,  envIntensity: 1.0,  sunIntensityScale: 1.0,  ibl: true },
        overcast: { id: 'overcast', label: 'Overcast',    hours: 13,    exposure: 0.9,  envIntensity: 1.45, sunIntensityScale: 0.28, ibl: true },
        dusk:     { id: 'dusk',     label: 'Dusk',        hours: 18.25, exposure: 0.75, envIntensity: 0.55, sunIntensityScale: 0.5,  ibl: true },
        night:    { id: 'night',    label: 'Night',       hours: 22,    exposure: 0.55, envIntensity: 0.3,  sunIntensityScale: 1.0,  ibl: true }
    };
    LIGHTING.overcast = LIGHTING.overcast || LIGHTING.overcast;

    function clampExposure(v) {
        var n = Number(v);
        if (!(n > 0)) n = 1;
        if (n < 0.1) n = 0.1;
        if (n > 3) n = 3;
        return n;
    }

    function clampEnvIntensity(v) {
        var n = Number(v);
        if (!(n >= 0)) n = 1;
        if (n > 4) n = 4;
        return n;
    }

    function clampPixelRatio(devicePixelRatio, cap) {
        var dpr = (devicePixelRatio > 0) ? devicePixelRatio : 1;
        var limit = (cap > 0) ? cap : 1;
        return Math.min(dpr, limit);
    }

    function shadowMapConstant(THREE, kind) {
        if (!THREE) return null;
        if (kind === 'basic') return THREE.BasicShadowMap;
        if (kind === 'pcf') return THREE.PCFShadowMap;
        return THREE.PCFSoftShadowMap;
    }

    function cameraChanged(prev, next, epsilon) {
        var eps = epsilon == null ? 1e-6 : epsilon;
        if (!prev || !next) return true;
        if (prev.length !== next.length) return true;
        for (var i = 0; i < prev.length; i++) {
            if (Math.abs(prev[i] - next[i]) > eps) return true;
        }
        return false;
    }

    function shouldRenderFrame(opts) {
        opts = opts || {};
        var hidden = !!opts.documentHidden;
        var dirty = !!opts.dirty;
        var cameraMoved = !!opts.cameraMoved;
        var animationPlaying = !!opts.animationPlaying;
        var walkMoving = !!opts.walkMoving;
        var presentPlaying = !!opts.presentPlaying;
        var fpsCap = opts.fpsCap > 0 ? opts.fpsCap : 60;
        var lastDrawMs = opts.lastDrawMs || 0;
        var nowMs = opts.nowMs || 0;
        if (hidden && !animationPlaying && !presentPlaying) return false;
        var busy = animationPlaying || walkMoving || presentPlaying || cameraMoved || dirty;
        if (!busy) return false;
        var minDt = 1000 / fpsCap;
        return (nowMs - lastDrawMs) >= (minDt - 0.75);
    }

    function downsampleSize(outW, outH, supersample, maxDim) {
        var w = Math.max(1, outW | 0);
        var h = Math.max(1, outH | 0);
        var ss = supersample | 0;
        if (ss < 1) ss = 1;
        if (ss > 4) ss = 4;
        var max = maxDim > 0 ? maxDim : 8192;
        var rw = w * ss;
        var rh = h * ss;
        if (rw > max || rh > max) {
            var scale = max / Math.max(rw, rh);
            rw = Math.max(1, Math.floor(rw * scale));
            rh = Math.max(1, Math.floor(rh * scale));
        }
        return { renderW: rw, renderH: rh, outW: w, outH: h, supersample: ss };
    }

    var api = {
        PRESETS: PRESETS,
        LIGHTING: LIGHTING,
        clampPixelRatio: clampPixelRatio,
        clampExposure: clampExposure,
        clampEnvIntensity: clampEnvIntensity,
        shadowMapConstant: shadowMapConstant,
        shouldRenderFrame: shouldRenderFrame,
        downsampleSize: downsampleSize,
        cameraChanged: cameraChanged
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.RenderQuality = api;
})(typeof window !== 'undefined' ? window : globalThis);
