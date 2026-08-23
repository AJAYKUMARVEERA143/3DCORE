# Lightweight render engine + VR/AR — implementation plan

Date: 2026-08-23. This is a **build plan**, not a claim that VR/AR already ships.

Product constraint (same as `docs/ROADMAP.md` and `docs/AUDIT_AND_PLAN.md`): stay in the **browser Three.js client**. Do not add a second Vulkan/C++ engine, do not label WebGL as Cycles, do not invent VRAM telemetry.

---

## 1. What you asked for

| Request | Honest translation | What we will actually ship |
| --- | --- | --- |
| Next rendering engine, lightweight, ready | A **replaceable render adapter** with quality presets, not a new native renderer | `RenderAdapter` in JS: one WebGL path now, optional WebGPU later |
| GPU acceleration taggincchi, quality output | **Lower GPU cost** (heat, battery, 30–60 fps on laptops) while **stills/walkthroughs still look good** | Viewport uses a cheap ladder; Present / Export uses extra samples, not a 90 fps path tracer |
| Virtual reality | Walk the model at 1:1 in a headset | **WebXR `immersive-vr`** (Quest Browser, Chrome on compatible Android) |
| Augmented reality | Put the building on a real floor | **WebXR `immersive-ar`** on ARCore phones + **USDZ/GLB Quick Look** on iOS |

GPU cannot be “turned off” for 3D. Every Three.js frame already uses the GPU. Lower GPU here means: **cap fill-rate, shadows, post, and extra WebGL contexts** so a civil model stays editable on a mid laptop or phone, then **spend GPU only when the user asks for a presentation frame**.

---

## 2. What exists today (do not rebuild)

In `web/js/app.js`:

- `THREE.WebGLRenderer`, antialias on, `pixelRatio = min(devicePixelRatio, 2)` (already expensive on Retina)
- Shadows on by default, PCF soft, map 512 / 1024 / 2048
- SSAO + Bloom via `EffectComposer` — **off until toggled** (correct)
- Procedural IBL (`PMREMGenerator` from a 512×256 canvas sky)
- Extra WebGL contexts: ViewCube, rotating material thumbs, asset-library thumbs, P2P offscreen tile renderer
- Honest stills: resize renderer → one PNG; animation → WebM; LAN P2P **tiles** (not a GPU farm)

There is **no** WebXR session, no hit-test, no render-quality preset that turns several knobs at once.

---

## 3. Target architecture

```
Document (scene graph, meters, Z-up)
    │
    ├─ ViewportAdapter     Draft / Balanced / Present
    ├─ StillAdapter        1×–4× supersample PNG (existing resize path)
    ├─ TileAdapter         existing LAN P2P setViewOffset (optional)
    ├─ WebXRAdapter        immersive-vr | immersive-ar | inline
    └─ (later) WebGPUAdapter  same scene, optional, capability-detected
```

One scene, several **outputs**. CAD tools keep using the desktop camera unless an XR session is active. When XR starts, tools pause except: select, teleport, scale (1:1 / 1:10 / 1:50), exit.

Do **not** fork `app.js` into a second renderer. Extract a small `web/js/render_adapter.js` (quality ladder + XR session) that `app.js` calls. Three.js stays r128 until XR helpers are verified against that build; bump Three only if r128 `renderer.xr` is too old (decision in Wave A spike).

---

## 4. Quality vs GPU — the ladder

One control in the Render tab: **Quality**. It must change real flags, not a label.

| Preset | Pixel ratio | Shadows | Post | IBL | Target |
| --- | --- | --- | --- | --- | --- |
| **Draft** | `min(dpr, 1)` | off | off | flat ambient only | Edit walls on a weak GPU |
| **Balanced** (default) | `min(dpr, 1.25)` | 1024, PCF | off | procedural PMREM | Daily CAD |
| **Present** | `min(dpr, 1.5)` | 2048, PCF soft | SSAO+Bloom optional | PMREM + extra lights | Client walkthrough on desktop |
| **Export still** | 1.0 then **supersample 2× or 4×** into PNG | Present shadows | SSAO on | same | Marketing image — one frame, not 60 fps |

Extra GPU cuts (all real, all in the adapter):

1. **Dirty-flag loop** — skip `renderer.render` when camera, lights, and meshes have not changed (huge laptop win; UI still 60 Hz CSS).
2. **FPS cap** — 30 fps in Draft; pause when `document.hidden`.
3. **One shared offscreen renderer** for material + asset thumbs; ViewCube at 1× dpr.
4. **Shadow casters** — only selected + rooms-in-view; not every imported GLB.
5. **No second path tracer.** Quality stills = supersample + existing materials. P2P tiles stay for huge stills across LAN machines.

Rejected as fake or out of scope:

- Browser OIDN / “AI denoise”
- Live VRAM graphs
- Claiming WebGPU is required for VR
- Shipping `src/core/engine.cpp` as the renderer

---

## 5. Virtual reality (WebXR)

**API:** `navigator.xr.requestSession('immersive-vr', { requiredFeatures: ['local-floor'] })`.

**Three.js:** `renderer.xr.enabled = true`; `setAnimationLoop` while the session lives. Stereo cameras come from the XR device.

**Interaction v1 (walkthrough, not a full CAD headset app):**

- Teleport ray to floor / slabs (existing mesh raycast)
- Snap-turn 45°
- Thumbstick move at locked eye height (reuse Walk mode yaw/pitch math, Z-up)
- Scale presets: **1:1** (meters), **1:10**, **1:50** so a villa fits a play space
- Trigger = select object
- **Exit VR** restores the desktop camera and the normal tool loop

**Devices to test and list in Help:**

- Meta Quest Browser (primary)
- Chrome Android + headset if `immersive-vr` is reported
- Desktop Chrome: **Enter VR** disabled unless `xr.isSessionSupported('immersive-vr')` is true (no fake button)

**Not v1:** editing walls with controllers, hand tracking, Quest 3 passthrough (Wave D if the device API exists).

**Safety:** sitting/standing `local-floor`; warn if no floor reference; comfort vignette optional in Present only (costs GPU — Draft skips it).

---

## 6. Augmented reality (WebXR + honest iOS)

Two stacks, because browsers are not equal:

### A. Android (ARCore) — in-app AR

`requestSession('immersive-ar', { requiredFeatures: ['hit-test', 'dom-overlay'] })`

- Hit-test against real floor; place the **scene root** (or selected group) with a reticle
- Light estimation if available; else keep Balanced IBL dimmed
- `alpha: true` on the renderer only while AR is active
- Pinch to scale the placed model; rotate around Z

### B. iOS Safari — export, don’t fake WebXR

Safari does **not** give the same `immersive-ar` as Chrome. v1:

- **AR Quick Look**: export selected meshes to **USDZ** (preferred) or GLB and open `rel="ar"`
- If a USDZ encoder is too heavy for v1, GLB download + “Open in AR” instructions

Do not show an in-page “AR camera” that is a webcam quad with a cube glued on — that is a demo, not AR.

### C. Desktop “AR”

No. Desktop gets **VR if a headset is connected**, else a grayed button: “Connect a headset or use a phone.”

---

## 7. Delivery waves

### Wave A — Render adapter (lightweight engine)

Touch: new `web/js/render_adapter.js`, Render tab UI, `initApp` / render loop in `app.js`.

- `setQuality('draft'|'balanced'|'present')` writes pixelRatio, shadows, composer, IBL
- Dirty-flag + pause on hidden tab
- Cap extra contexts to 1× DPR
- Help copy: “Rendered = WebGL PBR, not path tracing”
- Tests: quality preset changes `renderer.shadowMap.enabled` and `getPixelRatio()`

**Done when:** switching Draft → Present measurably changes pixel ratio and shadow map size; Draft still edits a wall at interactive fps on integrated GPU (manual check).

### Wave B — WebXR VR walkthrough

- Feature-detect `immersive-vr`
- Teleport + scale presets
- Session end restores controls

**Done when:** Quest Browser enters stereo, floor-relative standing, teleport hits a slab, Exit returns to desktop tools. Unsupported browsers show a disabled control + reason.

### Wave C — AR place-on-floor

- Android `immersive-ar` + hit-test placement
- iOS Quick Look export path
- Reset placement, hide UI chrome via dom-overlay

**Done when:** a phone places the default cube on a detected plane and it stays while the camera moves (ARCore). iOS gets a file that opens in Quick Look.

### Wave D — Optional extras (only after A–C)

- WebGPU renderer **if** `navigator.gpu` and Three version allow it — same presets, fallback WebGL
- 2×/4× still supersample checkbox on Render Image (can land in A if small)
- Quest passthrough only if `immersive-ar` or a documented passthrough API works on device

---

## 8. File-level sketch (Wave A/B)

```
web/js/render_adapter.js
  createRenderAdapter({ renderer, scene, camera, composer, ... })
  adapter.setQuality(name)
  adapter.setDirty()
  adapter.tick(now)            // render or skip
  adapter.enterVR() / exitXR()
  adapter.enterAR()            // Wave C
  adapter.capabilities()       // { vr, ar, webgpu, dpr }

web/index.html
  Quality <select> + Enter VR + Enter AR (disabled until capabilities())
  iOS: Export for AR Quick Look

web/js/app.js
  renderLoop → adapter.tick
  Walk mode reused as XR locomotion helpers
```

HTTPS: WebXR **requires a secure context**. `http://127.0.0.1` counts as secure. A LAN IP (`http://192.168.x.x`) does **not** — phones on LAN need HTTPS or a tunnel. Document this in Help; optional later: mkcert in `scripts/`.

---

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| Three r128 XR API incomplete | Spike in Wave A: 20-line session on Quest; bump Three if required, keep one version |
| Z-up vs WebXR Y-up | Parent scene in an `xrRoot` rotated −90° on X; keep document Z-up |
| CAD gizmos in stereo | Hide TransformControls in XR v1 |
| Multiple WebGL contexts OOM on mobile | Draft disables thumbs/ViewCube GL, or 2D fallback |
| iOS AR expectations | Quick Look export; never a fake webcam cube |

---

## 10. Out of scope

- Native VisionOS / OpenXR C++ app
- Photogrammetry of the room
- Multiplayer VR
- Path tracing, DLSS, OIDN
- Using `src/rendering/viewport_renderer.py` or `engine.cpp`

---

## 11. Telugu summary

Ippudu unnadi WebGL editor. **Kotha Vulkan engine vaddu.**

**Lightweight engine** ante: Draft / Balanced / Present presets — pixel ratio, shadows, SSAO ni tagginchi laptop GPU heat taggali; photo kavali ante **oka still ni 2×/4×** render cheyali, 60 fps raytrace kadu.

**VR:** headset lo WebXR walk + teleport (Quest). Desktop lo headset lekapote button disable.

**AR:** Android lo floor mida model pettadam (WebXR). iPhone lo in-app AR radu — **USDZ/GLB Quick Look** export.

Mundu Wave A (presets + dirty-frame); tarvata VR; tarvata AR.
