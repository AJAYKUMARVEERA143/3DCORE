# `src/` is not the editor

These Python/C++ files are **print-only prototypes**. They are not imported by `server.py` and they do not drive `web/`.

The real product is:

- `web/js/app.js` — editor
- `web/index.html` / `web/css/style.css` — UI
- `server.py` — static files, asset catalog, AI key proxy, LAN WebRTC signaling

Do not add features here expecting them to appear in the browser. Do not treat `main.py` “SUCCESS” prints as a working CAD kernel, DXF parser, or GPU farm.
