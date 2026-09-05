# 3D Core Studio - Complete Server with TexVerse GLB + Dream Textures Integration
import http.server
import socketserver
import json
import os
import sys
import mimetypes
import socket
import threading
import hashlib
import base64
import struct
import uuid
import urllib.request
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# The browser client is intentionally dependency-free.  These environment
# variables let the same entry point run locally, in a container, or behind a
# platform-specific launcher without changing source code.
PORT = int(os.environ.get("PORT", "8000"))
# 0.0.0.0 (LAN-reachable) by default — required for the P2P Render Pool
# feature (see run_ws_signaling_server() below): other devices on the same
# network need to be able to open this app and its signaling relay. This is
# still only reachable from the local network (typical home router NAT),
# not the open internet. Set THREED_CORE_HOST=127.0.0.1 to restrict to this
# machine only.
HOST = os.environ.get("THREED_CORE_HOST", "0.0.0.0")
WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
ASSETS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")

# Browser client files under web/js and web/css. New modules (zip_store, mesh_tools)
# must be served without adding a one-off elif per filename.
_WEB_STATIC_PREFIXES = ("/js/", "/css/", "/icons/", "/manifest.json", "/sw.js")
_WEB_MIME = {
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".map": "application/json",
}


def safe_file_under(root, rel):
    """Resolve rel to a real file inside root. Rejects .. and absolute escapes."""
    rel = (rel or "").replace("\\", "/").lstrip("/")
    if not rel or any(part == ".." for part in rel.split("/")):
        return None
    root_abs = os.path.abspath(root)
    full = os.path.abspath(os.path.join(root_abs, rel))
    if full != root_abs and not full.startswith(root_abs + os.sep):
        return None
    if not os.path.isfile(full):
        return None
    return full


def studio_status_payload():
    glbs = scan_texverse_glbs()
    return {
        "ok": True,
        "app": "3D Core Studio",
        "renderer": "webgl-pbr",
        "renderer_label": "Browser WebGL PBR (ACES Filmic). Not Cycles.",
        "gpu_farm": False,
        "formats": {
            "import": ["glb", "gltf", "obj", "stl", "dxf-ascii"],
            "export": ["glb", "obj", "stl", "png", "webm", "zip-client-pack"],
        },
        "assets": {
            "texverse_glb": len(glbs),
            "dream_textures": len(DREAM_TEXTURE_PRESETS),
        },
        "signaling_ws_port": WS_PORT,
    }

TEXVERSE_GLB_DIR = os.path.join(ASSETS_DIR, "TexVerse", "glbs", "glbs_1k", "000-000")
DREAMTEX_DIR = os.path.join(ASSETS_DIR, "textures", "dream-textures-color-1k")
DEEPFURN_DIR = os.path.join(ASSETS_DIR, "DeepFurniture")

# -------------------------------------------------------
# Scan local GLB files from TexVerse-1K dataset
# -------------------------------------------------------
def scan_texverse_glbs():
    glbs = []
    if os.path.isdir(TEXVERSE_GLB_DIR):
        for fname in sorted(os.listdir(TEXVERSE_GLB_DIR)):
            if fname.endswith('.glb'):
                fpath = os.path.join(TEXVERSE_GLB_DIR, fname)
                size_kb = os.path.getsize(fpath) // 1024
                glbs.append({
                    "id": fname.replace('.glb', ''),
                    "filename": fname,
                    "serve_path": f"/assets/texverse/{fname}",
                    "size_kb": size_kb,
                    "source": "YiboZhang2001/TexVerse-1K (HuggingFace)",
                    "has_pbr": True,
                    "texture_res": "1024px"
                })
    return glbs

# -------------------------------------------------------
# Dream Textures color metadata (parsed from parquet info)
# -------------------------------------------------------
DREAM_TEXTURE_PRESETS = [
    {"id": "dt_concrete_01", "name": "Brutalist Concrete", "category": "Architecture", "tags": ["concrete", "rough", "grey"], "color_hex": "#7f8c8d"},
    {"id": "dt_marble_01", "name": "White Carrara Marble", "category": "Natural Stone", "tags": ["marble", "white", "veins"], "color_hex": "#ecf0f1"},
    {"id": "dt_oak_01", "name": "White Oak Hardwood", "category": "Wood", "tags": ["oak", "wood", "grain"], "color_hex": "#d4a96a"},
    {"id": "dt_walnut_01", "name": "Dark Walnut Veneer", "category": "Wood", "tags": ["walnut", "dark", "grain"], "color_hex": "#5d4037"},
    {"id": "dt_steel_01", "name": "Brushed Stainless Steel", "category": "Metal", "tags": ["steel", "metal", "brushed"], "color_hex": "#b0bec5"},
    {"id": "dt_brass_01", "name": "Polished Brass Gold", "category": "Metal", "tags": ["brass", "gold", "polished"], "color_hex": "#d4ac0d"},
    {"id": "dt_glass_01", "name": "Clear Tempered Glass", "category": "Glass", "tags": ["glass", "clear", "transparent"], "color_hex": "#aed6f1"},
    {"id": "dt_leather_01", "name": "Full-Grain Cognac Leather", "category": "Fabric", "tags": ["leather", "cognac", "premium"], "color_hex": "#a04000"},
    {"id": "dt_fabric_01", "name": "Linen Natural Weave", "category": "Fabric", "tags": ["linen", "fabric", "natural"], "color_hex": "#f5deb3"},
    {"id": "dt_terracotta_01", "name": "Terracotta Clay Tile", "category": "Tile", "tags": ["terracotta", "clay", "tile", "orange"], "color_hex": "#e07b39"},
    {"id": "dt_mosaic_01", "name": "Midnight Blue Mosaic", "category": "Tile", "tags": ["mosaic", "blue", "tile"], "color_hex": "#1a5276"},
    {"id": "dt_rubber_01", "name": "Matte Black Rubber", "category": "Polymer", "tags": ["rubber", "black", "matte"], "color_hex": "#1c2833"},
]

# -------------------------------------------------------
# AI Assistant — provider-agnostic natural-language-to-tool-call relay.
# The API key never leaves this machine except in the direct HTTPS call to
# whichever provider is configured; it's stored in a local, untracked
# config file, never echoed back to the browser once saved.
# -------------------------------------------------------
AI_CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ai_config.json")


def load_ai_config():
    if os.path.isfile(AI_CONFIG_PATH):
        try:
            with open(AI_CONFIG_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def save_ai_config(cfg):
    with open(AI_CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f)


# Tool surface the AI can invoke — deliberately a curated, validated subset
# of the app's real functions (see executeAIAction() in web/js/app.js),
# not arbitrary code execution. Grows one tool at a time as needed, same
# as the rest of this app's tool coverage.
AI_TOOLS = [
    {
        "name": "add_primitive",
        "description": "Add a new primitive mesh object to the scene.",
        "input_schema": {
            "type": "object",
            "properties": {"type": {"type": "string", "enum": ["cube", "cone", "cylinder", "uv_sphere", "ico_sphere", "torus", "plane"]}},
            "required": ["type"],
        },
    },
    {
        "name": "set_transform",
        "description": "Set the position, rotation (degrees), and/or scale of the currently selected object. Omit fields you don't want to change.",
        "input_schema": {
            "type": "object",
            "properties": {
                "position": {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 3, "description": "[x, y, z] in meters"},
                "rotation_deg": {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 3, "description": "[x, y, z] in degrees"},
                "scale": {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 3},
            },
        },
    },
    {
        "name": "apply_material",
        "description": "Apply a material to the currently selected object — either a named preset, or explicit color/roughness/metalness.",
        "input_schema": {
            "type": "object",
            "properties": {
                "preset": {"type": "string", "enum": ["wood", "concrete", "glass", "steel", "marble", "gold", "brick", "plastic"]},
                "color_hex": {"type": "string", "description": "e.g. #ff0000"},
                "roughness": {"type": "number", "minimum": 0, "maximum": 1},
                "metalness": {"type": "number", "minimum": 0, "maximum": 1},
            },
        },
    },
    {
        "name": "mesh_edit",
        "description": "Run a mesh-editing tool on the current face selection of the selected object (Edit Mode, Face select). Falls back to a whole-object approximation if nothing is face-selected.",
        "input_schema": {
            "type": "object",
            "properties": {"tool": {"type": "string", "enum": ["extrude", "extrude_normals", "extrude_individual", "inset", "bevel", "shrink_fatten", "to_sphere", "subdivide", "smooth", "randomize"]}},
            "required": ["tool"],
        },
    },
    {
        "name": "apply_modifier",
        "description": (
            "Add a real, non-destructive-style modifier to the currently selected object's modifier stack "
            "(Subdivide, Mirror, Bevel, Solidify, Array, Wireframe, Decimate, Twist, Displace, or a boolean/hollow "
            "operation). Provide only the params relevant to the chosen modifier — omitted ones use sensible defaults."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "modifier": {
                    "type": "string",
                    "enum": ["SUBSURF", "MIRROR", "BEVEL", "SOLIDIFY", "ARRAY", "WIREFRAME", "DECIMATE",
                              "SIMPLE_DEFORM_TWIST", "DISPLACE", "BOOLEAN_UNION", "BOOLEAN_INTERSECT", "BOOLEAN_DIFF", "HOLLOW"],
                },
                "levels": {"type": "integer", "minimum": 1, "maximum": 3, "description": "SUBSURF — subdivision levels"},
                "axis": {"type": "string", "enum": ["X", "Y", "Z"], "description": "MIRROR / ARRAY — axis"},
                "amount": {"type": "number", "minimum": 0.01, "maximum": 1, "description": "BEVEL — bevel amount in meters"},
                "thickness": {"type": "number", "minimum": 0.01, "maximum": 2, "description": "SOLIDIFY / HOLLOW — wall thickness in meters"},
                "count": {"type": "integer", "minimum": 2, "maximum": 20, "description": "ARRAY — number of copies"},
                "ratio": {"type": "number", "minimum": 0.05, "maximum": 1, "description": "DECIMATE — detail ratio (lower = more decimated)"},
                "angle": {"type": "number", "minimum": -360, "maximum": 360, "description": "SIMPLE_DEFORM_TWIST — total twist angle in degrees"},
                "strength": {"type": "number", "minimum": 0.01, "maximum": 2, "description": "DISPLACE — displacement strength"},
            },
            "required": ["modifier"],
        },
    },
    {
        "name": "select_object",
        "description": "Select an existing object in the scene by its outliner name.",
        "input_schema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
    },
    {"name": "delete_selected", "description": "Delete the currently selected object.", "input_schema": {"type": "object", "properties": {}}},
    {"name": "duplicate_selected", "description": "Duplicate the currently selected object.", "input_schema": {"type": "object", "properties": {}}},
    {
        "name": "set_shading_mode",
        "description": "Change the viewport shading mode.",
        "input_schema": {"type": "object", "properties": {"mode": {"type": "string", "enum": ["WIREFRAME", "SOLID", "MATERIAL", "RAYTRACE"]}}, "required": ["mode"]},
    },
    {"name": "new_scene", "description": "Reset to a new empty default scene.", "input_schema": {"type": "object", "properties": {}}},
    {
        "name": "add_light",
        "description": "Add a real light source to the scene (Point, Spot, Directional/Sun, or Area).",
        "input_schema": {
            "type": "object",
            "properties": {
                "type": {"type": "string", "enum": ["point", "spot", "directional", "area"]},
                "intensity": {"type": "number", "description": "Light intensity (defaults: 600 for point/spot/area, 3 for directional)"},
                "color_hex": {"type": "string", "description": "e.g. #ffffff"},
            },
            "required": ["type"],
        },
    },
    {
        "name": "set_time_of_day",
        "description": "Move the sun and change the sky/lighting to a given time of day (0-24 hours).",
        "input_schema": {"type": "object", "properties": {"hours": {"type": "number", "minimum": 0, "maximum": 24}}, "required": ["hours"]},
    },
    {
        "name": "add_wall",
        "description": "Switch to the wall drawing tool. The user still clicks points in the viewport.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "make_rooms",
        "description": "Create room slabs from closed wall loops already in the scene.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "add_door_component",
        "description": "Add a door mesh component (does not boolean-cut a wall).",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "export_schedule",
        "description": "Download a CSV schedule of walls, rooms, and opening components.",
        "input_schema": {"type": "object", "properties": {}},
    },
]

AI_SYSTEM_PROMPT = (
    "You are a 3D modeling assistant embedded in a browser-based CAD/3D editor. "
    "Use the provided tools to carry out the user's request against the current scene. "
    "Call one or more tools per request; keep any accompanying text to one short sentence."
)


def _openai_tools():
    return [{"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["input_schema"]}} for t in AI_TOOLS]


def call_anthropic(api_key, prompt, scene_context):
    body = {
        "model": "claude-sonnet-5",
        "max_tokens": 1024,
        "system": AI_SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": f"Current scene: {json.dumps(scene_context)}\n\nInstruction: {prompt}"}],
        "tools": AI_TOOLS,
    }
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(body).encode("utf-8"),
        headers={"x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    actions, text_parts = [], []
    for block in data.get("content", []):
        if block.get("type") == "tool_use":
            actions.append({"tool": block.get("name"), "input": block.get("input", {})})
        elif block.get("type") == "text":
            text_parts.append(block.get("text", ""))
    return actions, " ".join(text_parts).strip()


def call_openai(api_key, prompt, scene_context):
    body = {
        "model": "gpt-4o-mini",
        "messages": [
            {"role": "system", "content": AI_SYSTEM_PROMPT},
            {"role": "user", "content": f"Current scene: {json.dumps(scene_context)}\n\nInstruction: {prompt}"},
        ],
        "tools": _openai_tools(),
        "tool_choice": "auto",
    }
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    msg = data["choices"][0]["message"]
    actions = []
    for call in msg.get("tool_calls") or []:
        try:
            args = json.loads(call["function"]["arguments"])
        except Exception:
            args = {}
        actions.append({"tool": call["function"]["name"], "input": args})
    return actions, (msg.get("content") or "").strip()


# Cheapest real validation call for each provider — a bare model-list GET,
# not a chat completion, so testing a key costs nothing and doesn't spend
# tokens. A 200 means the key genuinely authenticates; anything else raises
# (HTTPError for a 401/403, etc.) and the caller reports the real reason.
def test_anthropic_key(api_key):
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/models",
        headers={"x-api-key": api_key, "anthropic-version": "2023-06-01"},
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        json.loads(resp.read().decode("utf-8"))


def test_openai_key(api_key):
    req = urllib.request.Request(
        "https://api.openai.com/v1/models",
        headers={"Authorization": f"Bearer {api_key}"},
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        json.loads(resp.read().decode("utf-8"))


class StudioHTTPRequestHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args): return

    def _send_json(self, data, status=200):
        body = json.dumps(data).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def _serve_static(self, file_path, mime_type=None):
        if not os.path.isfile(file_path):
            self.send_response(404); self.end_headers(); return
        if mime_type is None:
            mime_type, _ = mimetypes.guess_type(file_path)
            mime_type = mime_type or 'application/octet-stream'
        self.send_response(200)
        self.send_header('Content-Type', mime_type)
        self.send_header('Content-Length', str(os.path.getsize(file_path)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        with open(file_path, 'rb') as f:
            self.wfile.write(f.read())

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        path = self.path.split('?')[0]

        # Static web files
        if path in ('/', '/index.html'):
            self._serve_static(os.path.join(WEB_DIR, 'index.html'), 'text/html; charset=utf-8')
        elif path == '/cinema_render.html':
            # The isolated Cinema Render iframe document (see docs/ROADMAP.md)
            # — served explicitly since it isn't under any of the generic
            # static prefixes below (those cover /js /css /icons only).
            self._serve_static(os.path.join(WEB_DIR, 'cinema_render.html'), 'text/html; charset=utf-8')
        elif any(path.startswith(prefix) for prefix in _WEB_STATIC_PREFIXES):
            full = safe_file_under(WEB_DIR, path.lstrip('/'))
            if not full:
                self.send_response(404); self.end_headers(); return
            ext = os.path.splitext(full)[1].lower()
            self._serve_static(full, _WEB_MIME.get(ext, 'application/octet-stream'))

        elif path in ('/api/status', '/api/health'):
            self._send_json(studio_status_payload())

        # Serve TexVerse GLB files directly
        elif path.startswith('/assets/texverse/') and path.endswith('.glb'):
            fname = os.path.basename(path)
            glb_path = os.path.join(TEXVERSE_GLB_DIR, fname)
            self._serve_static(glb_path, 'model/gltf-binary')

        # API: TexVerse GLB catalog
        elif path in ('/api/texverse/catalog', '/api/texverse/list'):
            glbs = scan_texverse_glbs()
            # `items` is retained for the compact UI; `models` is the richer
            # catalog contract used by integrations.
            items = [{"id": model["id"], "name": model["filename"], "serve_path": model["serve_path"]} for model in glbs]
            self._send_json({"source": "YiboZhang2001/TexVerse-1K @ HuggingFace", "count": len(glbs), "models": glbs, "items": items})

        # API: Dream Textures catalog
        elif path == '/api/dreamtex/catalog':
            self._send_json({
                "source": "dream-textures/textures-color-1k @ HuggingFace",
                "local_path": DREAMTEX_DIR,
                "count": len(DREAM_TEXTURE_PRESETS),
                "textures": DREAM_TEXTURE_PRESETS
            })

        # API: AI Assistant settings — never echoes the key back, only whether one is set
        elif path == '/api/ai-settings':
            cfg = load_ai_config()
            self._send_json({
                "provider": cfg.get("provider", "anthropic"),
                "anthropic_configured": bool(cfg.get("anthropic_api_key")),
                "openai_configured": bool(cfg.get("openai_api_key")),
            })

        else:
            self.send_response(404); self.end_headers()

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length) if length else b'{}'
        try:
            payload = json.loads(body.decode('utf-8'))
        except Exception:
            payload = {}

        path = self.path

        if path == '/api/snap':
            self._send_json({
                "status": "NOT_IMPLEMENTED",
                "message": "Drawing snap runs in the browser (vertex/edge/axis/grid). This endpoint is a leftover prototype.",
            }, 501)

        elif path == '/api/extrude':
            self._send_json({
                "status": "NOT_IMPLEMENTED",
                "message": "Extrude/Push-Pull is a client-side mesh op. This endpoint is a leftover prototype.",
            }, 501)

        elif path == '/api/ai-generate':
            self._send_json({
                "status": "NOT_IMPLEMENTED",
                "message": "Use /api/ai-command with a configured API key. This endpoint never generated a mesh.",
            }, 501)

        elif path == '/api/gpu-render':
            self._send_json({
                "status": "NOT_IMPLEMENTED",
                "message": "There is no Cycles GPU path. Use in-browser Render Image or the LAN P2P tile pool.",
            }, 501)

        elif path == '/api/boolean':
            self._send_json({
                "status": "NOT_IMPLEMENTED",
                "message": "Booleans run in the browser CSG engine, not on this server.",
            }, 501)

        elif path == '/api/export':
            self._send_json({
                "status": "NOT_IMPLEMENTED",
                "message": "Export GLB from File ▸ Export in the client. This endpoint never wrote a file.",
            }, 501)

        elif path == '/api/dreamtex/apply':
            tex_id = payload.get('texture_id', 'dt_concrete_01')
            tex = next((t for t in DREAM_TEXTURE_PRESETS if t['id'] == tex_id), DREAM_TEXTURE_PRESETS[0])
            self._send_json({
                "status": "APPLIED",
                "texture": tex,
                "pbr_props": {
                    "roughness": 0.85 if 'concrete' in tex['tags'] else 0.3,
                    "metalness": 0.9 if 'metal' in tex['category'].lower() else 0.05,
                    "color_hex": tex['color_hex']
                }
            })

        # API: save an AI provider's API key locally (never returned to the browser again)
        elif path == '/api/ai-settings':
            provider = payload.get('provider')
            api_key = (payload.get('api_key') or '').strip()
            if provider not in ('anthropic', 'openai'):
                self._send_json({"status": "ERROR", "message": "provider must be 'anthropic' or 'openai'"}, 400)
            elif not api_key:
                self._send_json({"status": "ERROR", "message": "api_key is required"}, 400)
            else:
                cfg = load_ai_config()
                cfg['provider'] = provider
                cfg[f'{provider}_api_key'] = api_key
                save_ai_config(cfg)
                self._send_json({"status": "OK"})

        # API: validate a provider key with a real (free, tokenless) round
        # trip — either the key just typed in the settings panel, or, if
        # none was passed, whatever's already saved for that provider.
        elif path == '/api/ai-test-key':
            provider = payload.get('provider')
            if provider not in ('anthropic', 'openai'):
                self._send_json({"status": "ERROR", "message": "provider must be 'anthropic' or 'openai'"}, 400)
                return
            api_key = (payload.get('api_key') or '').strip()
            if not api_key:
                api_key = load_ai_config().get(f'{provider}_api_key')
            if not api_key:
                self._send_json({"status": "ERROR", "message": "No key to test — paste one first."}, 400)
                return
            try:
                (test_anthropic_key if provider == 'anthropic' else test_openai_key)(api_key)
                self._send_json({"status": "OK", "message": "Key is valid — connected successfully."})
            except urllib.error.HTTPError as e:
                reason = "Invalid API key (401 Unauthorized)." if e.code in (401, 403) else f"{provider} API error {e.code}."
                self._send_json({"status": "ERROR", "message": reason}, 200)
            except Exception as e:
                self._send_json({"status": "ERROR", "message": f"Could not reach {provider}: {e}"}, 200)

        # API: natural-language instruction -> real tool calls, executed client-side
        elif path == '/api/ai-command':
            prompt = (payload.get('prompt') or '').strip()
            scene_context = payload.get('scene', {})
            if not prompt:
                self._send_json({"status": "ERROR", "message": "prompt is required"}, 400)
                return
            cfg = load_ai_config()
            provider = cfg.get('provider', 'anthropic')
            api_key = cfg.get(f'{provider}_api_key')
            if not api_key:
                self._send_json({"status": "ERROR", "message": f"No API key configured for {provider}. Open AI ▸ AI Settings and add one."}, 400)
                return
            try:
                actions, text = (call_anthropic if provider == 'anthropic' else call_openai)(api_key, prompt, scene_context)
                self._send_json({"status": "OK", "actions": actions, "assistant_text": text})
            except urllib.error.HTTPError as e:
                try:
                    err_body = e.read().decode('utf-8')
                except Exception:
                    err_body = str(e)
                self._send_json({"status": "ERROR", "message": f"{provider} API error {e.code}: {err_body[:300]}"}, 502)
            except Exception as e:
                self._send_json({"status": "ERROR", "message": f"Request failed: {e}"}, 502)

        elif path == '/api/texverse/load':
            model_id = payload.get('model_id', '')
            glbs = scan_texverse_glbs()
            model = next((m for m in glbs if m['id'] == model_id), glbs[0] if glbs else None)
            if model:
                # A relative URL also works on mobile, WASM hosting, and when
                # the server is accessed through a LAN address or reverse proxy.
                self._send_json({"status": "READY", "model": model, "serve_url": model['serve_path']})
            else:
                self._send_json({"status": "NOT_FOUND"}, 404)

        else:
            self.send_response(404); self.end_headers()


# ─────────────────────────────────────────────────────────────
# P2P RENDER POOL — minimal WebSocket signaling relay, pure stdlib (no
# `websockets` package — this project stays dependency-free). It is
# strictly a rendezvous point: peers exchange only small JSON signaling
# messages here (peer IDs, WebRTC SDP offers/answers, ICE candidates) so
# they can find each other on the LAN and open a direct WebRTC
# DataChannel — the actual render-tile image data then flows genuinely
# peer-to-peer, never through this relay or this server at all.
# ─────────────────────────────────────────────────────────────
WS_PORT = int(os.environ.get("WS_PORT", str(PORT + 1)))
_WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
_ws_peers = {}  # peer_id -> socket
_ws_lock = threading.Lock()


def _ws_handshake(conn):
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = conn.recv(4096)
        if not chunk:
            return False
        data += chunk
        if len(data) > 16384:  # malformed/oversized handshake — bail rather than buffer forever
            return False
    key = None
    for line in data.decode("utf-8", errors="ignore").split("\r\n"):
        if line.lower().startswith("sec-websocket-key:"):
            key = line.split(":", 1)[1].strip()
    if not key:
        return False
    accept = base64.b64encode(hashlib.sha1((key + _WS_MAGIC).encode()).digest()).decode()
    conn.sendall(
        ("HTTP/1.1 101 Switching Protocols\r\n"
         "Upgrade: websocket\r\n"
         "Connection: Upgrade\r\n"
         f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode()
    )
    return True


def _ws_recv_frame(conn):
    hdr = conn.recv(2)
    if len(hdr) < 2:
        return None
    b1, b2 = hdr[0], hdr[1]
    opcode = b1 & 0x0F
    masked = b2 & 0x80
    length = b2 & 0x7F
    if length == 126:
        length = struct.unpack(">H", conn.recv(2))[0]
    elif length == 127:
        length = struct.unpack(">Q", conn.recv(8))[0]
    mask_key = conn.recv(4) if masked else b""
    payload = b""
    while len(payload) < length:
        chunk = conn.recv(min(65536, length - len(payload)))
        if not chunk:
            break
        payload += chunk
    if masked:
        payload = bytes(b ^ mask_key[i % 4] for i, b in enumerate(payload))
    if opcode == 0x8:  # close frame
        return None
    if opcode != 0x1:  # only text frames carry our JSON signaling messages
        return ""
    return payload.decode("utf-8", errors="ignore")


def _ws_send_frame(conn, text):
    payload = text.encode("utf-8")
    length = len(payload)
    if length <= 125:
        header = struct.pack("BB", 0x81, length)
    elif length <= 65535:
        header = struct.pack("BB", 0x81, 126) + struct.pack(">H", length)
    else:
        header = struct.pack("BB", 0x81, 127) + struct.pack(">Q", length)
    try:
        conn.sendall(header + payload)
    except OSError:
        pass


def _ws_broadcast_peer_list():
    with _ws_lock:
        ids = list(_ws_peers.keys())
        targets = list(_ws_peers.items())
    msg = json.dumps({"type": "peers", "peers": ids})
    for _, conn in targets:
        _ws_send_frame(conn, msg)


def _ws_handle_client(conn, addr):
    try:
        if not _ws_handshake(conn):
            conn.close()
            return
    except OSError:
        conn.close()
        return

    peer_id = uuid.uuid4().hex[:8]
    with _ws_lock:
        _ws_peers[peer_id] = conn
    _ws_send_frame(conn, json.dumps({"type": "welcome", "id": peer_id}))
    _ws_broadcast_peer_list()
    print(f"[P2P Pool] Peer {peer_id} connected from {addr[0]} ({len(_ws_peers)} total)")

    try:
        while True:
            msg = _ws_recv_frame(conn)
            if msg is None:
                break
            if not msg:
                continue
            try:
                data = json.loads(msg)
            except ValueError:
                continue
            target_id = data.get("to")
            if not target_id:
                continue
            with _ws_lock:
                target_conn = _ws_peers.get(target_id)
            if target_conn:
                data["from"] = peer_id
                _ws_send_frame(target_conn, json.dumps(data))
    except OSError:
        pass
    finally:
        with _ws_lock:
            _ws_peers.pop(peer_id, None)
        conn.close()
        _ws_broadcast_peer_list()
        print(f"[P2P Pool] Peer {peer_id} disconnected ({len(_ws_peers)} remaining)")


def run_ws_signaling_server():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((HOST, WS_PORT))
    srv.listen(32)
    while True:
        conn, addr = srv.accept()
        threading.Thread(target=_ws_handle_client, args=(conn, addr), daemon=True).start()


def _detect_lan_ip():
    """Best-effort LAN IP for the printed URL — doesn't actually send traffic,
    just asks the OS which local interface would be used to reach the
    internet, so the printed address is one another device on the LAN can
    actually use (a bare 0.0.0.0 bind address isn't dialable)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def run():
    socketserver.TCPServer.allow_reuse_address = True
    glbs = scan_texverse_glbs()
    lan_ip = _detect_lan_ip() if HOST == "0.0.0.0" else HOST
    threading.Thread(target=run_ws_signaling_server, daemon=True).start()
    print(f"====================================================")
    print(f" 3D CORE STUDIO  |  http://{lan_ip}:{PORT}")
    print(f"----------------------------------------------------")
    print(f" TexVerse-1K GLBs      : {len(glbs)} models ready")
    print(f" Dream Textures        : {len(DREAM_TEXTURE_PRESETS)} PBR presets")
    print(f" P2P Render Pool relay : ws://{lan_ip}:{WS_PORT}  (open this app on other LAN devices to join)")
    print(f"====================================================")
    with socketserver.ThreadingTCPServer((HOST, PORT), StudioHTTPRequestHandler) as httpd:
        httpd.serve_forever()

if __name__ == "__main__":
    run()
