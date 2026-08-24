# 3D Core — how the product works (one flow, best outputs)

Date: 2026-08-23.

You asked: *I don’t know how you implement it, but the app should be a lightweight world-class 3D modeler, a rendering engine that runs on GPU / web / any platform, open a project, take realistic images / videos / VR / AR, show them in Presentation mode, and import/export every app’s formats. I don’t know the step flow. I want the best output.*

This document is that **flow**. Implementation detail lives in `docs/RENDER_XR_PLAN.md` and `docs/AUDIT_AND_PLAN.md`. Here we answer: **what the user does, in order, and what file comes out.**

---

## 1. One idea

**One project file. One scene. Many outputs.**

```
  Draw / model  →  look (viewport)  →  Present  →  Export
                         │
                         ├─ PNG / JPEG  (still)
                         ├─ WebM / MP4  (camera path video)
                         ├─ GLB / OBJ / STL / USDZ  (other apps + AR)
                         ├─ VR headset walk
                         └─ Phone AR on the floor
```

The **modeler** is always the same lightweight browser app (no install).  
The **renderer** is not a second product — it is the same scene, with a **Quality** switch:

- **Draft** while you edit (low GPU heat)
- **Present** while you show a client
- **Export still / video** when you need the best picture (extra samples, one job, not 60 fps ray tracing)

That is how a small team beats Blender+V-Ray+Unity for *this* job: **civil / interiors / products in a browser**, not a Hollywood film pipeline.

---

## 2. What “world lightweight new technology” means here

| Phrase | What it is | What it is not |
| --- | --- | --- |
| Lightweight | One tab, Python stdlib server, no npm, phone/tablet/desktop | A 2 GB native DCC with plugins |
| New technology | WebGL2 now, WebGPU when the browser is ready, WebXR for VR/AR | A secret C++ engine in `src/` |
| Any platform | **Same `web/` bundle** in Chrome/Edge/Safari/Quest Browser; later optional PWA / Tauri wrapper | Three separate Windows/Mac/Android codebases |
| GPU | Browser GPU for the viewport + stills; LAN P2P tiles for huge stills | A fake “128 GPU cloud” |
| Realistic | PBR materials + IBL + shadows + optional SSAO; 2×/4× stills | Cycles / V-Ray path tracing in v1 |

If we claim “all formats, film-quality path tracing, native Vision Pro, AutoCAD DWG kernel” on day one, the app becomes a lie. The **best output** is: every button does a real file, every mode has a quality preset, every format we list actually round-trips.

---

## 3. User flow (this is the only flow that matters)

Think of seven rooms. The user walks them in order. Tools can loop back.

### Step 0 — Open

1. Start `./scripts/run.sh` → browser `http://127.0.0.1:8000`
2. **File → New** or **Open Project** (`.3dcore.json`) or **Quick Load**
3. Units: m / cm / mm / ft / in (already in the app)

### Step 1 — Get geometry in (Import)

User either **draws** (SketchUp tools) or **imports**:

| Now (real) | Next | Later (hard; only if we can parse for real) |
| --- | --- | --- |
| `.3dcore.json` project | `.obj` + `.mtl` | `.skp` SketchUp |
| `.glb` / `.gltf` | `.stl` (3D print) | `.dwg` / `.dxf` (real CAD, not four fake walls) |
| | `.fbx` via a documented converter **or** skip until a WASM decoder exists | `.ifc` BIM |
| | `.usdz` for AR | `.step` / `.iges` (OCCT WASM) |

**Rule:** File menu only lists formats that **read bytes from the user’s file**. No “Import DXF” that ignores the file.

### Step 2 — Model (lightweight CAD)

Same as today: draw, push/pull, mesh edit, sculpt, walls/openings, materials, lights.  
Quality = **Draft** so the GPU stays cool.

### Step 3 — Look (viewport)

Shading: Wire / Solid / Material / Rendered (WebGL PBR).  
This is **preview**, not the final poster.

### Step 4 — Present (new first-class mode)

**Present** is not “Rendered sphere with a Cycles name.” It is a **mode**:

1. Hide modeling chrome (toolbars, outliner) — one **Exit Present**
2. Fullscreen
3. Quality automatically **Present** (better shadows / IBL; SSAO optional)
4. **Slides** = saved cameras (name, lens, time of day)
5. Play: next/prev slide, optional fly-along a camera path
6. From Present: **Enter VR** (if headset) or **View in AR** (phone QR / file)
7. From Present: **Export pack** (see Step 5)

Keyboard: `F5` enter Present, `Esc` exit (if not drawing).

### Step 5 — Take outputs (the “best files”)

One **Output** panel. Each row is a real download.

| Output | File | How (honest) | “Best” setting |
| --- | --- | --- | --- |
| Still | `.png` (optional `.jpg`) | Resize renderer, 1 frame; 2×/4× supersample | Present + 4× + 1920×1080 or 4K |
| Turntable / animation | `.webm` now; `.mp4` if the browser encodes it | Existing keyframes + `MediaRecorder` | Present, 24 fps, locked camera path |
| Other 3D apps | `.glb` (universal) | `GLTFExporter` | Always |
| Mesh / print | `.obj`, `.stl` | Client exporters | High-poly after modifiers applied |
| iPhone AR | `.usdz` | Export + Quick Look | Selected group, meters |
| Android AR | WebXR session **or** `.glb` | Place on floor | Hit-test |
| Headset VR | No file — session | WebXR walk | 1:1 / 1:10 / 1:50 |
| Share project | `.3dcore.json` | JSON scene | Full undo-safe document |
| Client pack | `.zip` | Project + 3 PNGs + GLB + WebM | “Send to client” button |

**Best still** is not a new engine. It is: Present lighting + supersample + correct exposure.  
**Best video** is a camera path in Present, not a fake “raytraced movie.”  
**Best VR/AR** is WebXR / Quick Look, not a webcam cube.

### Step 6 — Send to other applications

| They use | We give them |
| --- | --- |
| Blender, D5, Twinmotion, Unity, Unreal | **GLB** (first) |
| 3D print / CNC | **STL** |
| Illustrator / CAD 2D | **DXF out** (later: flattened plan) |
| Revit / ArchiCAD | **IFC** (later) or GLB as mesh |
| iPhone client | USDZ + PNG |
| PowerPoint | PNG 4K + WebM |

We will **never** list FBX/DWG/SKP in the menu until a real encoder/decoder is wired and tested on a sample file.

---

## 4. Rendering engine — one adapter, three jobs

```
                    ┌──────────────┐
                    │  Scene graph │  meters, Z-up, PBR
                    └──────┬───────┘
           ┌───────────────┼───────────────┐
           ▼               ▼               ▼
     Viewport GPU     Still / Video      XR device
     Draft/Balanced   2× 4× PNG/WebM     Quest / phone
     30–60 fps        one job            72–90 fps stereo
```

- **Web** = the engine (WebGL2; WebGPU optional later).
- **GPU** = the user’s GPU (and optional LAN friends via existing P2P tiles).
- **Any platform** = that same web bundle in a browser; optional later: PWA install, Tauri .exe that only wraps Chromium — **no second renderer**.

Details of Draft/Present/XR: `docs/RENDER_XR_PLAN.md`.

---

## 5. Presentation mode — product spec (Wave P)

Ship this **before** exotic formats. Clients remember the show, not the file extension.

Must have:

- `Present` workspace tab (next to Layout)
- Saved views list (add from current camera)
- Play / pause / next; fullscreen
- Quality lock to Present while playing
- Export current slide as PNG
- Export all slides as PNG sequence
- “Open in VR” / “AR file” from the same bar
- No gizmos, no grid (optional overlay: north arrow, scale bar, project name)

Nice to have after:

- Simple fade between slides
- Section plane still works in Present
- Password-free “review link” if we ever host (not required for local-first)

---

## 6. Build order (so the flow actually exists)

Do **not** start ten formats at once. Order is the product:

| Wave | What the user gains | Why this order |
| --- | --- | --- |
| **P0** | Honesty: no fake SUCCESS APIs, no Cycles name | Trust |
| **P1** | Quality ladder + dirty-frame GPU cut | Lightweight feels real |
| **P2** | **Present mode** + camera slides + F5 | The show |
| **P3** | Best stills (2×/4×) + video from slide path | Images & videos |
| **P4** | Import/export: OBJ, STL; keep GLB as hub | Other apps |
| **P5** | WebXR VR walkthrough | VR |
| **P6** | ARCore + USDZ | AR |
| **P7** | Real DXF in → walls; IFC/USD later if WASM is real | CAD interoperability |

Each wave ships a **file or a mode** the user can click. No wave is “research only.”

---

## 7. What we already have vs what we add

| Already in the app | Add next |
| --- | --- |
| Draw, mesh, sculpt, BIM walls | Knife / loop cut / lasso / proportional edit |
| GLB, OBJ, STL, ASCII DXF walls, `.3dcore.json` | IFC / USD / DWG only if a real WASM decoder exists |
| PNG still + WebM + screenshot + **client ZIP pack** | Optional USDZ if an encoder is wired |
| Lights, IBL, SSAO, P2P tiles | Path tracing (out of scope) |
| Present mode + quality ladder | Review-link hosting (not required locally) |
| WebXR VR + trigger teleport; AR hit-test place or GLB | Hit-test reticle polish |

Implementation status (2026-08-24): Waves **P1–P5**, honest **P6/P7**, plus **client ZIP pack**, **VR teleport**, and **AR plane hit-test place** ship in the browser client (`web/js/format_io.js`, `web/js/zip_store.js`, `web/js/render_adapter.js`). No FBX/SKP/USDZ buttons. `src/` demos stay isolated.

---

## 8. Telugu summary

**Okka project, okka scene, chaala outputs.**

1. Open / Import (ippudu GLB + own JSON; tarvata OBJ/STL/DXF nijamga)
2. Model cheyandi (Draft — GPU heat takkuva)
3. **Present** — fullscreen, camera slides, client ki chupinche mode
4. Output teesukondi:
   - best **photo** = Present + 4× PNG
   - best **video** = camera path WebM
   - **Blender/Unity** = GLB
   - **VR** = headset lo walk
   - **AR** = Android floor / iPhone USDZ
5. Inka anni formats menu lo pettamu — decode cheyyaledu ante button **undadu**

World-class lightweight ante: **install ledhu, button nijam, output file open avuthundi.** Fake path tracer / 128 GPU / DWG magic **vaddu**.

Implementation status (2026-08-24): Wave **P1 quality ladder** + **P2 Present** + **P3 stills/WebM** + **P4 OBJ/STL** + **P5 WebXR VR (teleport)** + **AR (hit-test place or GLB)** + **ASCII DXF walls** + **client ZIP pack** ship in the browser client. USDZ, DWG, SKP, IFC, and path tracing are still out of scope.
