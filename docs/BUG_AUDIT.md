# Bug audit — 2026-08-23 (second pass)

Re-read of `web/`, `server.py`, and the prototype `src/` tree. This is what was **broken or dishonest**, and what this branch **fixed**.

## How the app actually works

3D Core Studio is a **browser CAD/3D editor**. Run `python3 server.py` (or `./scripts/run.sh`) and open `http://127.0.0.1:8000`. Almost all product logic is `web/js/app.js`. `src/` and `main.py` are not the editor.

## Bugs found and fixed

| ID | Severity | What was wrong | Fix |
| --- | --- | --- | --- |
| B1 | High | Header **Snap: 3D Grid** was a dead label. Draw points and gizmo moves ignored the grid. | Real grid snap (default 1 m). Chip toggles on/off; Shift-click cycles 1 cm → 5 m. Vertex/edge/axis/tangent inference still beats the grid. Transform gizmo uses the same increment. |
| B2 | High | **Box/Circle select** only picked the closest object. Shift-click in the viewport did not add to a set. | Region select gathers every object whose origin is inside the marquee. Shift-click adds. Gizmo move translates the whole set. Duplicate/Delete operate on the set. |
| B3 | Medium | **File → New** stacked another `AmbientLight` each time (ambient is not in `sceneObjects`), so the default cube got brighter on every New Scene. | Strip leftover ambient lights when rebuilding the startup scene. |
| B4 | Medium | **Texture Paint** mode did nothing. | Mode now returns to Object Mode and opens the Materials tab, with an honest VCB message. |
| B5 | Medium | **View / Select / Object** in the viewport bar were inert labels. | Hover menus call real functions (views, frame, select all, duplicate/delete, move/rotate/scale). |
| B6 | Medium | **🌐 Global** was decorative. | Chip toggles TransformControls world/local space. |
| B7 | Medium | Prototype POSTs (`/api/snap`, `/extrude`, `/ai-generate`, `/gpu-render`, `/boolean`, `/export`) returned fake SUCCESS. | They now return **501 NOT_IMPLEMENTED** with an explanation. |
| B8 | Low | Emission slider was read in JS (`mat-emission`) but **missing from HTML**, so emission was always 0. | Added the range control (and kept Metallic). |
| B9 | Low | UI still said **Cycles path tracer**. | Relabeled to Rendered (WebGL). |
| B10 | Low | `download_datasets.py` hardcoded a Windows `d:\…` path. | Saves under repo `assets/`. |
| B11 | Low | `main.py` printed “all phases successful”. | Banner now says it is a demo; `src/README.md` states it is not the product. |

## Still open (not fake — missing product)

These are real gaps, not silent crashes. Track them; do not pretend they shipped.

1. **True DXF/DWG import** — `src/cad_parser/dxf_extruder.py` still returns four hardcoded walls.
2. **Half-edge Knife / Loop Cut** — current tools are scoped (one plane / one face / one quad).
3. **Object-mode lasso** and **edit-mode proportional editing**.
4. **BIM rooms / storeys / door-window components / schedules**.
5. **Playwright suite** described in ROADMAP is still not in git (this branch adds `tests/test_integrity.py` only).
6. **Texture-paint brush engine** — still out of scope; Materials per-face paint is the real path.

## What you actually need next (priority)

1. Keep this honesty bar: no SUCCESS from empty APIs, no Cycles claims.
2. DXF → Wall (real file parse) if civil is the audience.
3. Persistent dimension objects (Tape is one-shot).
4. Check Playwright tests into the repo when a browser is available.

## How to verify

```bash
python3 -m unittest tests.test_integrity
python3 server.py   # http://127.0.0.1:8000
```

In the UI: click the Snap chip (off/on), Shift-click to change increment, draw a line on the ground and confirm points land on meters. Shift-click two meshes and drag the gizmo — both should move. File → New twice and confirm lighting does not keep getting brighter.
