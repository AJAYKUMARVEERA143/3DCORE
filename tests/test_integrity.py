#!/usr/bin/env python3
"""Regression checks for honesty + snap math (no browser required)."""
import json
import math
import os
import sys
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server  # noqa: E402


def snap_scalar(n, size):
    if not size:
        return n
    return round(n / size) * size


class SnapMathTests(unittest.TestCase):
    def test_1m_grid(self):
        self.assertEqual(snap_scalar(1.4, 1), 1)
        self.assertEqual(snap_scalar(1.6, 1), 2)
        self.assertEqual(snap_scalar(-0.6, 1), -1)

    def test_10cm_grid(self):
        self.assertAlmostEqual(snap_scalar(0.24, 0.1), 0.2)
        self.assertAlmostEqual(snap_scalar(0.26, 0.1), 0.3)


class StubApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.StudioHTTPRequestHandler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.httpd.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def _post(self, path):
        import urllib.error
        import urllib.request
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=b"{}",
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.status, json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            body = e.read().decode()
            try:
                payload = json.loads(body)
            except Exception:
                payload = {"raw": body}
            return e.code, payload

    def test_prototype_posts_are_501(self):
        for path in (
            "/api/snap",
            "/api/extrude",
            "/api/ai-generate",
            "/api/gpu-render",
            "/api/boolean",
            "/api/export",
        ):
            code, payload = self._post(path)
            self.assertEqual(code, 501, path)
            self.assertEqual(payload.get("status"), "NOT_IMPLEMENTED", path)

    def test_index_served(self):
        import urllib.request
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/", timeout=5) as resp:
            html = resp.read().decode("utf-8", errors="replace")
        self.assertIn("3D Core Studio", html)
        self.assertNotIn("Cycles Path Tracer", html)
        self.assertIn("js/render_adapter.js", html)
        self.assertIn('id="quality-select"', html)
        self.assertIn('id="present-bar"', html)


class HtmlJsContractTests(unittest.TestCase):
    def test_js_ids_exist_in_html(self):
        import re
        html = (ROOT / "web" / "index.html").read_text()
        js = (ROOT / "web" / "js" / "app.js").read_text()
        html_ids = set(re.findall(r'\bid=["\']([^"\']+)["\']', html))
        js_ids = set(re.findall(r"getElementById\(['\"]([^'\"]+)['\"]\)", js))
        missing = sorted(js_ids - html_ids)
        self.assertEqual(missing, [])


class RenderQualityTests(unittest.TestCase):
    def test_adapter_math_via_node(self):
        import subprocess
        script = r"""
const RQ = require('./web/js/render_adapter.js');
if (RQ.clampPixelRatio(2, 1) !== 1) process.exit(2);
if (RQ.clampPixelRatio(2, 1.5) !== 1.5) process.exit(3);
if (RQ.PRESETS.draft.shadows !== false) process.exit(4);
if (RQ.PRESETS.present.shadowSize !== 2048) process.exit(5);
const sz = RQ.downsampleSize(1920, 1080, 2, 8192);
if (sz.renderW !== 3840 || sz.outW !== 1920) process.exit(6);
const skip = RQ.shouldRenderFrame({ documentHidden: true, dirty: true, nowMs: 100, lastDrawMs: 0, fpsCap: 60 });
if (skip !== false) process.exit(7);
const draw = RQ.shouldRenderFrame({ documentHidden: false, dirty: true, nowMs: 100, lastDrawMs: 0, fpsCap: 30 });
if (draw !== true) process.exit(8);
const idle = RQ.shouldRenderFrame({ documentHidden: false, dirty: false, cameraMoved: false, nowMs: 100, lastDrawMs: 0, fpsCap: 60 });
if (idle !== false) process.exit(9);
console.log('ok');
"""
        proc = subprocess.run(
            ["node", "-e", script],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("ok", proc.stdout)

    def test_present_hooks_in_app(self):
        js = (ROOT / "web" / "js" / "app.js").read_text()
        self.assertIn("function applyRenderQuality", js)
        self.assertIn("function enterPresentMode", js)
        self.assertIn("function captureStillDataUrl", js)
        html = (ROOT / "web" / "index.html").read_text()
        self.assertIn("Present", html)
        self.assertIn("render-supersample", html)

    def test_screenshot_hooks(self):
        js = (ROOT / "web" / "js" / "app.js").read_text()
        html = (ROOT / "web" / "index.html").read_text()
        self.assertIn("function takeViewportScreenshot", js)
        self.assertIn("case 'F10'", js)
        self.assertIn('id="screenshot-flash"', html)
        self.assertIn("takeViewportScreenshot()", html)


class FormatIOTests(unittest.TestCase):
    def test_obj_stl_dxf_roundtrip_via_node(self):
        import subprocess
        script = r"""
const IO = require('./web/js/format_io.js');
const obj = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';
const parsed = IO.parseOBJ(obj);
if (!parsed.objects.length) process.exit(2);
if (parsed.objects[0].positions.length !== 9) process.exit(3);
const outObj = IO.serializeOBJ(parsed.objects);
const reparsed = IO.parseOBJ(outObj);
if (reparsed.objects[0].indices.length !== 3) process.exit(4);
const stl = IO.serializeSTLAscii(parsed.objects, 'Tri');
if (!/facet normal/.test(stl)) process.exit(5);
const fromStl = IO.parseSTL(stl);
if (fromStl.objects[0].positions.length !== 9) process.exit(6);
const dxf = [
  '0','SECTION','2','ENTITIES',
  '0','LINE','10','0','20','0','11','2','21','0',
  '0','LWPOLYLINE','70','1','10','0','20','0','10','1','20','0','10','1','20','1',
  '0','ENDSEC','0','EOF'
].join('\n');
const cad = IO.parseDXF(dxf);
if (cad.lines.length !== 1) process.exit(7);
if (Math.abs(cad.lines[0].x2 - 2) > 1e-9) process.exit(8);
if (cad.polylines.length !== 1 || cad.polylines[0].points.length !== 3) process.exit(9);
if (!cad.polylines[0].closed) process.exit(10);
console.log('ok');
"""
        proc = subprocess.run(
            ["node", "-e", script],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("ok", proc.stdout)

    def test_io_xr_hooks_in_app(self):
        js = (ROOT / "web" / "js" / "app.js").read_text()
        html = (ROOT / "web" / "index.html").read_text()
        self.assertIn("function exportOBJ", js)
        self.assertIn("function exportSTL", js)
        self.assertIn("function enterVR", js)
        self.assertIn("function enterAR", js)
        self.assertIn("js/format_io.js", html)
        self.assertIn('id="file-import-obj"', html)
        self.assertIn("immersive-vr", js)
        self.assertNotIn("Import FBX", html)
        self.assertNotIn("Export USDZ", html)


if __name__ == "__main__":
    unittest.main()
