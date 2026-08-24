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
        html = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
        js = (ROOT / "web" / "js" / "app.js").read_text(encoding="utf-8")
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
        js = (ROOT / "web" / "js" / "app.js").read_text(encoding="utf-8")
        self.assertIn("function applyRenderQuality", js)
        self.assertIn("function enterPresentMode", js)
        self.assertIn("function captureStillDataUrl", js)
        html = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
        self.assertIn("Present", html)
        self.assertIn("render-supersample", html)

    def test_screenshot_hooks(self):
        js = (ROOT / "web" / "js" / "app.js").read_text(encoding="utf-8")
        html = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
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
        js = (ROOT / "web" / "js" / "app.js").read_text(encoding="utf-8")
        html = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
        self.assertIn("function exportOBJ", js)
        self.assertIn("function exportSTL", js)
        self.assertIn("function enterVR", js)
        self.assertIn("function enterAR", js)
        self.assertIn("js/format_io.js", html)
        self.assertIn('id="file-import-obj"', html)
        self.assertIn("immersive-vr", js)
        self.assertNotIn("Import FBX", html)
        self.assertNotIn("Export USDZ", html)


class ClientPackTests(unittest.TestCase):
    def test_zip_store_via_node(self):
        import subprocess
        script = r"""
const Z = require('./web/js/zip_store.js');
const bytes = Z.buildZip([
  { name: 'hello.txt', data: 'hello' },
  { name: 'n.txt', data: 'n' }
]);
if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) process.exit(2);
const text = 'hello';
const enc = new TextEncoder().encode(text);
if (Z.crc32(enc) !== 0x3610a686) process.exit(3);
const zipStr = String.fromCharCode.apply(null, Array.from(bytes));
if (zipStr.indexOf('hello.txt') < 0) process.exit(4);
if (zipStr.indexOf('PK') < 0) process.exit(5);
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

    def test_pack_and_xr_hooks(self):
        js = (ROOT / "web" / "js" / "app.js").read_text(encoding="utf-8")
        html = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
        self.assertIn("function exportClientPack", js)
        self.assertIn("function onXRControllerSelect", js)
        self.assertIn("requestHitTestSource", js)
        self.assertIn("js/zip_store.js", html)
        self.assertIn("exportClientPack()", html)
        self.assertIn("PACK", js)


class ServiceRenderToolsTests(unittest.TestCase):
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

    def _get(self, path):
        import urllib.error
        import urllib.request
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}")
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def test_status_is_honest_webgl(self):
        import json
        code, body = self._get("/api/status")
        self.assertEqual(code, 200)
        payload = json.loads(body.decode())
        self.assertEqual(payload.get("renderer"), "webgl-pbr")
        self.assertFalse(payload.get("gpu_farm"))
        self.assertIn("Not Cycles", payload.get("renderer_label", ""))

    def test_js_modules_served_including_zip_and_mesh_tools(self):
        for path in ("/js/zip_store.js", "/js/mesh_tools.js", "/js/render_adapter.js", "/css/style.css"):
            code, body = self._get(path)
            self.assertEqual(code, 200, path)
            self.assertGreater(len(body), 20, path)

    def test_static_rejects_path_escape(self):
        code, _body = self._get("/js/../../server.py")
        self.assertEqual(code, 404)

    def test_mesh_tools_via_node(self):
        import subprocess
        script = r"""
const MT = require('./web/js/mesh_tools.js');
// Two-triangle quad (shared edge) + a detached triangle.
const pos = new Float32Array([
  0,0,0, 1,0,0, 1,1,0,
  0,0,0, 1,1,0, 0,1,0,
  5,0,0, 6,0,0, 5,1,0
]);
const adj = MT.buildFaceAdjacency(pos);
if (adj.length !== 3) process.exit(2);
if (adj[0].indexOf(1) < 0 || adj[1].indexOf(0) < 0) process.exit(3);
if (adj[2].length !== 0) process.exit(4);
const grown = MT.growFaceSelection([0], adj);
if (grown.indexOf(1) < 0 || grown.indexOf(2) >= 0) process.exit(5);
const linked = MT.selectLinkedFaces([0], adj);
if (linked.length !== 2) process.exit(6);
const shrunk = MT.shrinkFaceSelection([0,1], adj);
if (shrunk.length !== 2) process.exit(7); // both interior to the island
const w0 = MT.falloffWeight(0, 2, 'smooth');
const w1 = MT.falloffWeight(2, 2, 'smooth');
const w2 = MT.falloffWeight(1, 2, 'smooth');
if (w0 !== 1) process.exit(8);
if (w1 !== 0) process.exit(9);
if (!(w2 > 0 && w2 < 1)) process.exit(10);
console.log('ok');
"""
        proc = subprocess.run(["node", "-e", script], cwd=str(ROOT), capture_output=True, text=True, timeout=15)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("ok", proc.stdout)

    def test_lighting_presets_in_adapter(self):
        import subprocess
        script = r"""
const RQ = require('./web/js/render_adapter.js');
if (!RQ.LIGHTING.studio || !RQ.LIGHTING.dusk) process.exit(2);
if (RQ.clampExposure(9) !== 3) process.exit(3);
if (RQ.clampEnvIntensity(-1) !== 1) process.exit(4);
if (RQ.PRESETS.present.exposure == null) process.exit(5);
console.log('ok');
"""
        proc = subprocess.run(["node", "-e", script], cwd=str(ROOT), capture_output=True, text=True, timeout=15)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_hooks_in_app_and_html(self):
        js = (ROOT / "web" / "js" / "app.js").read_text(encoding="utf-8")
        html = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
        self.assertIn("function growFaceSelection", js)
        self.assertIn("function applyLightingPreset", js)
        self.assertIn("function setEngineExposure", js)
        self.assertIn("function toggleProportionalEdit", js)
        self.assertIn("js/mesh_tools.js", html)
        self.assertIn('id="lighting-preset-select"', html)
        self.assertIn('id="exposure-slider"', html)
        self.assertIn('id="prop-chip"', html)
        self.assertIn("GROW", js)
        self.assertNotIn("Cycles Path Tracer", html)


class LassoKnifeARTests(unittest.TestCase):
    def test_point_in_polygon_via_node(self):
        import subprocess
        script = r"""
const MT = require('./web/js/mesh_tools.js');
const square = [{x:0,y:0},{x:10,y:0},{x:10,y:10},{x:0,y:10}];
if (!MT.pointInPolygon(5, 5, square)) process.exit(2);
if (MT.pointInPolygon(20, 5, square)) process.exit(3);
if (MT.pointInPolygon(5, 5, square.slice(0, 2))) process.exit(4);
const tri = [{x:0,y:0},{x:4,y:0},{x:0,y:4}];
if (!MT.pointInPolygon(1, 1, tri)) process.exit(5);
if (MT.pointInPolygon(3, 3, tri)) process.exit(6);
console.log('ok');
"""
        proc = subprocess.run(["node", "-e", script], cwd=str(ROOT), capture_output=True, text=True, timeout=15)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("ok", proc.stdout)

    def test_hooks_in_app_and_html(self):
        js = (ROOT / "web" / "js" / "app.js").read_text(encoding="utf-8")
        html = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
        self.assertIn("function finishKnife", js)
        self.assertIn("function ensureARReticle", js)
        self.assertIn("function applyRegionFaceSelect", js)
        self.assertIn("select_lasso", js)
        self.assertIn("LASSO:", js)
        self.assertIn("_ar_reticle", js)
        self.assertIn('id="tb-select_lasso"', html)
        self.assertIn("Lasso Select", html)
        self.assertIn("Knife polyline", html)


class HonestCompleteTests(unittest.TestCase):
    def test_bim_kit_area_and_dxf(self):
        import subprocess
        script = r"""
const B = require('./web/js/bim_kit.js');
const sq = [{x:0,y:0},{x:4,y:0},{x:4,y:3},{x:0,y:3}];
if (Math.abs(B.polygonArea(sq) - 12) > 1e-9) process.exit(2);
const segs = [
  {x1:0,y1:0,x2:4,y2:0},{x1:4,y1:0,x2:4,y2:3},
  {x1:4,y1:3,x2:0,y2:3},{x1:0,y1:3,x2:0,y2:0}
];
const loops = B.loopsFromSegments(segs);
if (!loops.length) process.exit(3);
const csv = B.buildScheduleCsv([{kind:'wall',name:'W',qty:1,length_m:'2',area_m2:'5',notes:''}]);
if (csv.indexOf('wall') < 0) process.exit(4);
const dxf = B.serializeDXF([{x1:0,y1:0,x2:1,y2:0,layer:'WALLS'}]);
if (dxf.indexOf('LINE') < 0 || dxf.indexOf('EOF') < 0) process.exit(5);
console.log('ok');
"""
        proc = subprocess.run(["node", "-e", script], cwd=str(ROOT), capture_output=True, text=True, timeout=15)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("ok", proc.stdout)

    def test_mesh_falloff_and_loop(self):
        import subprocess
        script = r"""
const MT = require('./web/js/mesh_tools.js');
const pos = new Float32Array([
  0,0,0, 1,0,0, 1,1,0,
  0,0,0, 1,1,0, 0,1,0,
  1,0,0, 2,0,0, 2,1,0,
  1,0,0, 2,1,0, 1,1,0
]);
const adj = MT.buildFaceAdjacency(pos);
const loop = MT.selectFaceLoop(0, adj, pos);
if (loop.indexOf(0) < 0) process.exit(2);
const moved = MT.applyFalloffMove(pos, 0, 0, 0, 1, 10, 'smooth');
if (moved[2] <= pos[2]) process.exit(3);
const extra = MT.fillBoundaryFan(pos, [0,1]);
if (!extra || extra.length % 9 !== 0) process.exit(4);
console.log('ok');
"""
        proc = subprocess.run(["node", "-e", script], cwd=str(ROOT), capture_output=True, text=True, timeout=15)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_hooks_and_pwa(self):
        js = (ROOT / "web" / "js" / "app.js").read_text(encoding="utf-8")
        html = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
        self.assertIn("function makeRoomsFromWalls", js)
        self.assertIn("function exportPlanDXF", js)
        self.assertIn("function selectFaceLoop", js)
        self.assertIn("function addCameraObject", js)
        self.assertIn("js/bim_kit.js", html)
        self.assertIn("manifest.json", html)
        self.assertIn("exportPlanDXF()", html)
        self.assertIn("LOOPSEL", js)
        self.assertTrue((ROOT / "web" / "manifest.json").exists())
        self.assertTrue((ROOT / "web" / "sw.js").exists())
        self.assertIn("add_wall", (ROOT / "server.py").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
