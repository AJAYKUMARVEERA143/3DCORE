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


class HtmlJsContractTests(unittest.TestCase):
    def test_js_ids_exist_in_html(self):
        import re
        html = (ROOT / "web" / "index.html").read_text()
        js = (ROOT / "web" / "js" / "app.js").read_text()
        html_ids = set(re.findall(r'\bid=["\']([^"\']+)["\']', html))
        js_ids = set(re.findall(r"getElementById\(['\"]([^'\"]+)['\"]\)", js))
        missing = sorted(js_ids - html_ids)
        self.assertEqual(missing, [])


if __name__ == "__main__":
    unittest.main()
