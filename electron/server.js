// electron/server.js — Node port of server.py's real endpoints, for the
// Electron desktop build. Every route here mirrors server.py's exact JSON
// shapes and paths (see docs/ROADMAP.md's Electron packaging entry for the
// file/line citations this was audited against) so web/js/app.js's existing
// fetch('/api/...') calls work completely unchanged — no client-side code
// was touched to make this work.
//
// Scope match with server.py: static file serving, the AI API-key proxy
// (/api/ai-settings, /api/ai-test-key, /api/ai-command), the TexVerse/
// Dream Textures local asset catalog, and the LAN WebSocket signaling relay
// for the P2P render pool. The 6 endpoints server.py answers with an honest
// 501 NOT_IMPLEMENTED (/api/snap, /api/extrude, /api/ai-generate,
// /api/gpu-render, /api/boolean, /api/export) are reproduced too, for exact
// parity, even though the audit confirmed app.js never calls them.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const WEB_MIME = {
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.map': 'application/json',
};
const WEB_STATIC_PREFIXES = ['/js/', '/css/', '/icons/', '/manifest.json', '/sw.js'];

const DREAM_TEXTURE_PRESETS = [
    { id: 'dt_concrete_01', name: 'Brutalist Concrete', category: 'Architecture', tags: ['concrete', 'rough', 'grey'], color_hex: '#7f8c8d' },
    { id: 'dt_marble_01', name: 'White Carrara Marble', category: 'Natural Stone', tags: ['marble', 'white', 'veins'], color_hex: '#ecf0f1' },
    { id: 'dt_oak_01', name: 'White Oak Hardwood', category: 'Wood', tags: ['oak', 'wood', 'grain'], color_hex: '#d4a96a' },
    { id: 'dt_walnut_01', name: 'Dark Walnut Veneer', category: 'Wood', tags: ['walnut', 'dark', 'grain'], color_hex: '#5d4037' },
    { id: 'dt_steel_01', name: 'Brushed Stainless Steel', category: 'Metal', tags: ['steel', 'metal', 'brushed'], color_hex: '#b0bec5' },
    { id: 'dt_brass_01', name: 'Polished Brass Gold', category: 'Metal', tags: ['brass', 'gold', 'polished'], color_hex: '#d4ac0d' },
    { id: 'dt_glass_01', name: 'Clear Tempered Glass', category: 'Glass', tags: ['glass', 'clear', 'transparent'], color_hex: '#aed6f1' },
    { id: 'dt_leather_01', name: 'Full-Grain Cognac Leather', category: 'Fabric', tags: ['leather', 'cognac', 'premium'], color_hex: '#a04000' },
    { id: 'dt_fabric_01', name: 'Linen Natural Weave', category: 'Fabric', tags: ['linen', 'fabric', 'natural'], color_hex: '#f5deb3' },
    { id: 'dt_terracotta_01', name: 'Terracotta Clay Tile', category: 'Tile', tags: ['terracotta', 'clay', 'tile', 'orange'], color_hex: '#e07b39' },
    { id: 'dt_mosaic_01', name: 'Midnight Blue Mosaic', category: 'Tile', tags: ['mosaic', 'blue', 'tile'], color_hex: '#1a5276' },
    { id: 'dt_rubber_01', name: 'Matte Black Rubber', category: 'Polymer', tags: ['rubber', 'black', 'matte'], color_hex: '#1c2833' },
];

const AI_SYSTEM_PROMPT =
    'You are a 3D modeling assistant embedded in a browser-based CAD/3D editor. ' +
    "Use the provided tools to carry out the user's request against the current scene. " +
    'Call one or more tools per request; keep any accompanying text to one short sentence.';

// Same curated tool surface as server.py's AI_TOOLS — the AI can only ever
// call one of these, matching executeAIAction()'s real dispatch table in
// web/js/app.js, never arbitrary code.
const AI_TOOLS = [
    { name: 'add_primitive', description: 'Add a new primitive mesh object to the scene.', input_schema: { type: 'object', properties: { type: { type: 'string', enum: ['cube', 'cone', 'cylinder', 'uv_sphere', 'ico_sphere', 'torus', 'plane'] } }, required: ['type'] } },
    { name: 'set_transform', description: "Set the position, rotation (degrees), and/or scale of the currently selected object. Omit fields you don't want to change.", input_schema: { type: 'object', properties: { position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '[x, y, z] in meters' }, rotation_deg: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '[x, y, z] in degrees' }, scale: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 } } } },
    { name: 'apply_material', description: 'Apply a material to the currently selected object — either a named preset, or explicit color/roughness/metalness.', input_schema: { type: 'object', properties: { preset: { type: 'string', enum: ['wood', 'concrete', 'glass', 'steel', 'marble', 'gold', 'brick', 'plastic'] }, color_hex: { type: 'string', description: 'e.g. #ff0000' }, roughness: { type: 'number', minimum: 0, maximum: 1 }, metalness: { type: 'number', minimum: 0, maximum: 1 } } } },
    { name: 'mesh_edit', description: 'Run a mesh-editing tool on the current face selection of the selected object (Edit Mode, Face select). Falls back to a whole-object approximation if nothing is face-selected.', input_schema: { type: 'object', properties: { tool: { type: 'string', enum: ['extrude', 'extrude_normals', 'extrude_individual', 'inset', 'bevel', 'shrink_fatten', 'to_sphere', 'subdivide', 'smooth', 'randomize'] } }, required: ['tool'] } },
    { name: 'apply_modifier', description: "Add a real, non-destructive-style modifier to the currently selected object's modifier stack (Subdivide, Mirror, Bevel, Solidify, Array, Wireframe, Decimate, Twist, Displace, or a boolean/hollow operation). Provide only the params relevant to the chosen modifier — omitted ones use sensible defaults.", input_schema: { type: 'object', properties: { modifier: { type: 'string', enum: ['SUBSURF', 'MIRROR', 'BEVEL', 'SOLIDIFY', 'ARRAY', 'WIREFRAME', 'DECIMATE', 'SIMPLE_DEFORM_TWIST', 'DISPLACE', 'BOOLEAN_UNION', 'BOOLEAN_INTERSECT', 'BOOLEAN_DIFF', 'HOLLOW'] }, levels: { type: 'integer', minimum: 1, maximum: 3, description: 'SUBSURF — subdivision levels' }, axis: { type: 'string', enum: ['X', 'Y', 'Z'], description: 'MIRROR / ARRAY — axis' }, amount: { type: 'number', minimum: 0.01, maximum: 1, description: 'BEVEL — bevel amount in meters' }, thickness: { type: 'number', minimum: 0.01, maximum: 2, description: 'SOLIDIFY / HOLLOW — wall thickness in meters' }, count: { type: 'integer', minimum: 2, maximum: 20, description: 'ARRAY — number of copies' }, ratio: { type: 'number', minimum: 0.05, maximum: 1, description: 'DECIMATE — detail ratio (lower = more decimated)' }, angle: { type: 'number', minimum: -360, maximum: 360, description: 'SIMPLE_DEFORM_TWIST — total twist angle in degrees' }, strength: { type: 'number', minimum: 0.01, maximum: 2, description: 'DISPLACE — displacement strength' } }, required: ['modifier'] } },
    { name: 'select_object', description: 'Select an existing object in the scene by its outliner name.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
    { name: 'delete_selected', description: 'Delete the currently selected object.', input_schema: { type: 'object', properties: {} } },
    { name: 'duplicate_selected', description: 'Duplicate the currently selected object.', input_schema: { type: 'object', properties: {} } },
    { name: 'set_shading_mode', description: 'Change the viewport shading mode.', input_schema: { type: 'object', properties: { mode: { type: 'string', enum: ['WIREFRAME', 'SOLID', 'MATERIAL', 'RAYTRACE'] } }, required: ['mode'] } },
    { name: 'new_scene', description: 'Reset to a new empty default scene.', input_schema: { type: 'object', properties: {} } },
    { name: 'add_light', description: 'Add a real light source to the scene (Point, Spot, Directional/Sun, or Area).', input_schema: { type: 'object', properties: { type: { type: 'string', enum: ['point', 'spot', 'directional', 'area'] }, intensity: { type: 'number', description: 'Light intensity (defaults: 600 for point/spot/area, 3 for directional)' }, color_hex: { type: 'string', description: 'e.g. #ffffff' } }, required: ['type'] } },
    { name: 'set_time_of_day', description: 'Move the sun and change the sky/lighting to a given time of day (0-24 hours).', input_schema: { type: 'object', properties: { hours: { type: 'number', minimum: 0, maximum: 24 } }, required: ['hours'] } },
    { name: 'add_wall', description: 'Switch to the wall drawing tool. The user still clicks points in the viewport.', input_schema: { type: 'object', properties: {} } },
    { name: 'make_rooms', description: 'Create room slabs from closed wall loops already in the scene.', input_schema: { type: 'object', properties: {} } },
    { name: 'add_door_component', description: 'Add a door mesh component (does not boolean-cut a wall).', input_schema: { type: 'object', properties: {} } },
    { name: 'export_schedule', description: 'Download a CSV schedule of walls, rooms, and opening components.', input_schema: { type: 'object', properties: {} } },
];

function openaiTools() {
    return AI_TOOLS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
}

function loadAiConfig(aiConfigPath) {
    try {
        return JSON.parse(fs.readFileSync(aiConfigPath, 'utf-8'));
    } catch (err) {
        return {};
    }
}
function saveAiConfig(aiConfigPath, cfg) {
    fs.writeFileSync(aiConfigPath, JSON.stringify(cfg), 'utf-8');
}

async function callAnthropic(apiKey, prompt, sceneContext) {
    const body = {
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        system: AI_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Current scene: ${JSON.stringify(sceneContext)}\n\nInstruction: ${prompt}` }],
        tools: AI_TOOLS,
    };
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) { const err = new Error(`Anthropic API error ${res.status}`); err.status = res.status; err.body = data; throw err; }
    const actions = [], textParts = [];
    for (const block of data.content || []) {
        if (block.type === 'tool_use') actions.push({ tool: block.name, input: block.input || {} });
        else if (block.type === 'text') textParts.push(block.text || '');
    }
    return { actions, text: textParts.join(' ').trim() };
}

async function callOpenAI(apiKey, prompt, sceneContext) {
    const body = {
        model: 'gpt-4o-mini',
        messages: [
            { role: 'system', content: AI_SYSTEM_PROMPT },
            { role: 'user', content: `Current scene: ${JSON.stringify(sceneContext)}\n\nInstruction: ${prompt}` },
        ],
        tools: openaiTools(),
        tool_choice: 'auto',
    };
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) { const err = new Error(`OpenAI API error ${res.status}`); err.status = res.status; err.body = data; throw err; }
    const msg = data.choices[0].message;
    const actions = (msg.tool_calls || []).map(call => {
        let args = {};
        try { args = JSON.parse(call.function.arguments); } catch (err) { /* leave {} */ }
        return { tool: call.function.name, input: args };
    });
    return { actions, text: (msg.content || '').trim() };
}

// Cheapest real validation call for each provider — a bare model-list GET,
// same as server.py's test_anthropic_key/test_openai_key: costs nothing,
// spends no tokens, and a non-200 genuinely means the key doesn't work.
async function testAnthropicKey(apiKey) {
    const res = await fetch('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } });
    if (!res.ok) { const err = new Error('invalid'); err.status = res.status; throw err; }
}
async function testOpenAIKey(apiKey) {
    const res = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) { const err = new Error('invalid'); err.status = res.status; throw err; }
}

function scanTexverseGlbs(texverseDir) {
    const glbs = [];
    if (fs.existsSync(texverseDir) && fs.statSync(texverseDir).isDirectory()) {
        for (const fname of fs.readdirSync(texverseDir).sort()) {
            if (!fname.endsWith('.glb')) continue;
            const fpath = path.join(texverseDir, fname);
            const sizeKb = Math.floor(fs.statSync(fpath).size / 1024);
            glbs.push({
                id: fname.replace('.glb', ''),
                filename: fname,
                serve_path: `/assets/texverse/${fname}`,
                size_kb: sizeKb,
                source: 'YiboZhang2001/TexVerse-1K (HuggingFace)',
                has_pbr: true,
                texture_res: '1024px',
            });
        }
    }
    return glbs;
}

// Resolves rel to a real file inside root; rejects .. and absolute escapes
// — the same guard as server.py's safe_file_under().
function safeFileUnder(root, rel) {
    rel = (rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel || rel.split('/').some(part => part === '..')) return null;
    const rootAbs = path.resolve(root);
    const full = path.resolve(rootAbs, rel);
    if (full !== rootAbs && !full.startsWith(rootAbs + path.sep)) return null;
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
    return full;
}

function sendJson(res, data, status) {
    const body = JSON.stringify(data);
    res.writeHead(status || 200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
}

function serveStatic(res, filePath, mimeType) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) { res.writeHead(404); res.end(); return; }
    const buf = fs.readFileSync(filePath);
    res.writeHead(200, {
        'Content-Type': mimeType || 'application/octet-stream',
        'Content-Length': buf.length,
        'Access-Control-Allow-Origin': '*',
    });
    res.end(buf);
}

/**
 * Starts the local HTTP server (static files + /api/*) and the LAN
 * WebSocket signaling relay, mirroring server.py exactly.
 * @param {{webDir:string, assetsDir:string, aiConfigPath:string, port:number, wsPort:number, host:string}} opts
 */
function startServers(opts) {
    const { webDir, assetsDir, aiConfigPath, port, wsPort, host } = opts;
    const texverseDir = path.join(assetsDir, 'TexVerse', 'glbs', 'glbs_1k', '000-000');

    const statusPayload = () => {
        const glbs = scanTexverseGlbs(texverseDir);
        return {
            ok: true,
            app: '3D Core Studio',
            renderer: 'webgl-pbr',
            renderer_label: 'Browser WebGL PBR (ACES Filmic). Not Cycles.',
            gpu_farm: false,
            formats: {
                import: ['glb', 'gltf', 'obj', 'stl', 'dxf-ascii'],
                export: ['glb', 'obj', 'stl', 'png', 'webm', 'zip-client-pack'],
            },
            assets: { texverse_glb: glbs.length, dream_textures: DREAM_TEXTURE_PRESETS.length },
            signaling_ws_port: wsPort,
        };
    };

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const p = url.pathname;

        if (req.method === 'OPTIONS') {
            res.writeHead(200, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
            });
            res.end();
            return;
        }

        if (req.method === 'GET') {
            if (p === '/' || p === '/index.html') {
                serveStatic(res, path.join(webDir, 'index.html'), 'text/html; charset=utf-8');
            } else if (WEB_STATIC_PREFIXES.some(prefix => p.startsWith(prefix))) {
                const full = safeFileUnder(webDir, p);
                if (!full) { res.writeHead(404); res.end(); return; }
                serveStatic(res, full, WEB_MIME[path.extname(full).toLowerCase()] || 'application/octet-stream');
            } else if (p === '/api/status' || p === '/api/health') {
                sendJson(res, statusPayload());
            } else if (p.startsWith('/assets/texverse/') && p.endsWith('.glb')) {
                serveStatic(res, path.join(texverseDir, path.basename(p)), 'model/gltf-binary');
            } else if (p === '/api/texverse/catalog' || p === '/api/texverse/list') {
                const glbs = scanTexverseGlbs(texverseDir);
                const items = glbs.map(m => ({ id: m.id, name: m.filename, serve_path: m.serve_path }));
                sendJson(res, { source: 'YiboZhang2001/TexVerse-1K @ HuggingFace', count: glbs.length, models: glbs, items });
            } else if (p === '/api/dreamtex/catalog') {
                sendJson(res, {
                    source: 'dream-textures/textures-color-1k @ HuggingFace',
                    local_path: path.join(assetsDir, 'textures', 'dream-textures-color-1k'),
                    count: DREAM_TEXTURE_PRESETS.length,
                    textures: DREAM_TEXTURE_PRESETS,
                });
            } else if (p === '/api/ai-settings') {
                const cfg = loadAiConfig(aiConfigPath);
                sendJson(res, {
                    provider: cfg.provider || 'anthropic',
                    anthropic_configured: !!cfg.anthropic_api_key,
                    openai_configured: !!cfg.openai_api_key,
                });
            } else {
                res.writeHead(404); res.end();
            }
            return;
        }

        if (req.method === 'POST') {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            let payload = {};
            try { payload = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}'); } catch (err) { payload = {}; }

            const stub = (message) => sendJson(res, { status: 'NOT_IMPLEMENTED', message }, 501);

            if (p === '/api/snap') return stub('Drawing snap runs in the browser (vertex/edge/axis/grid). This endpoint is a leftover prototype.');
            if (p === '/api/extrude') return stub('Extrude/Push-Pull is a client-side mesh op. This endpoint is a leftover prototype.');
            if (p === '/api/ai-generate') return stub('Use /api/ai-command with a configured API key. This endpoint never generated a mesh.');
            if (p === '/api/gpu-render') return stub('There is no Cycles GPU path. Use in-browser Render Image or the LAN P2P tile pool.');
            if (p === '/api/boolean') return stub('Booleans run in the browser CSG engine, not on this server.');
            if (p === '/api/export') return stub('Export GLB from File ▸ Export in the client. This endpoint never wrote a file.');

            if (p === '/api/dreamtex/apply') {
                const texId = payload.texture_id || 'dt_concrete_01';
                const tex = DREAM_TEXTURE_PRESETS.find(t => t.id === texId) || DREAM_TEXTURE_PRESETS[0];
                sendJson(res, {
                    status: 'APPLIED',
                    texture: tex,
                    pbr_props: {
                        roughness: tex.tags.includes('concrete') ? 0.85 : 0.3,
                        metalness: tex.category.toLowerCase().includes('metal') ? 0.9 : 0.05,
                        color_hex: tex.color_hex,
                    },
                });
                return;
            }

            if (p === '/api/ai-settings') {
                const provider = payload.provider;
                const apiKey = (payload.api_key || '').trim();
                if (provider !== 'anthropic' && provider !== 'openai') { sendJson(res, { status: 'ERROR', message: "provider must be 'anthropic' or 'openai'" }, 400); return; }
                if (!apiKey) { sendJson(res, { status: 'ERROR', message: 'api_key is required' }, 400); return; }
                const cfg = loadAiConfig(aiConfigPath);
                cfg.provider = provider;
                cfg[`${provider}_api_key`] = apiKey;
                saveAiConfig(aiConfigPath, cfg);
                sendJson(res, { status: 'OK' });
                return;
            }

            if (p === '/api/ai-test-key') {
                const provider = payload.provider;
                if (provider !== 'anthropic' && provider !== 'openai') { sendJson(res, { status: 'ERROR', message: "provider must be 'anthropic' or 'openai'" }, 400); return; }
                let apiKey = (payload.api_key || '').trim();
                if (!apiKey) apiKey = loadAiConfig(aiConfigPath)[`${provider}_api_key`];
                if (!apiKey) { sendJson(res, { status: 'ERROR', message: 'No key to test — paste one first.' }, 400); return; }
                try {
                    await (provider === 'anthropic' ? testAnthropicKey : testOpenAIKey)(apiKey);
                    sendJson(res, { status: 'OK', message: 'Key is valid — connected successfully.' });
                } catch (err) {
                    const reason = (err.status === 401 || err.status === 403) ? 'Invalid API key (401 Unauthorized).' : `${provider} API error ${err.status || ''}.`;
                    sendJson(res, { status: 'ERROR', message: err.status ? reason : `Could not reach ${provider}: ${err.message}` });
                }
                return;
            }

            if (p === '/api/ai-command') {
                const prompt = (payload.prompt || '').trim();
                const sceneContext = payload.scene || {};
                if (!prompt) { sendJson(res, { status: 'ERROR', message: 'prompt is required' }, 400); return; }
                const cfg = loadAiConfig(aiConfigPath);
                const provider = cfg.provider || 'anthropic';
                const apiKey = cfg[`${provider}_api_key`];
                if (!apiKey) { sendJson(res, { status: 'ERROR', message: `No API key configured for ${provider}. Open AI ▸ AI Settings and add one.` }, 400); return; }
                try {
                    const { actions, text } = await (provider === 'anthropic' ? callAnthropic : callOpenAI)(apiKey, prompt, sceneContext);
                    sendJson(res, { status: 'OK', actions, assistant_text: text });
                } catch (err) {
                    const bodyStr = err.body ? JSON.stringify(err.body).slice(0, 300) : String(err.message);
                    sendJson(res, { status: 'ERROR', message: err.status ? `${provider} API error ${err.status}: ${bodyStr}` : `Request failed: ${err.message}` }, 502);
                }
                return;
            }

            if (p === '/api/texverse/load') {
                const glbs = scanTexverseGlbs(texverseDir);
                const model = glbs.find(m => m.id === payload.model_id) || glbs[0] || null;
                if (model) sendJson(res, { status: 'READY', model, serve_url: model.serve_path });
                else sendJson(res, { status: 'NOT_FOUND' }, 404);
                return;
            }

            res.writeHead(404); res.end();
            return;
        }

        res.writeHead(404); res.end();
    });

    server.listen(port, host);

    // LAN WebSocket signaling relay for the P2P render pool — same protocol
    // as server.py's hand-rolled RFC6455 implementation, but via the real
    // `ws` package instead of hand-rolling frames again: welcome the new
    // peer with its id, broadcast the peer-id list on join/leave, and relay
    // any message carrying a `to` field to that one target peer with `from`
    // stamped. Actual render-tile pixel data still flows peer-to-peer over
    // WebRTC DataChannel, never through this relay.
    const wss = new WebSocketServer({ port: wsPort, host });
    const peers = new Map(); // id -> ws
    const broadcastPeerList = () => {
        const msg = JSON.stringify({ type: 'peers', peers: [...peers.keys()] });
        for (const ws of peers.values()) ws.send(msg);
    };
    wss.on('connection', ws => {
        const id = require('crypto').randomBytes(4).toString('hex');
        peers.set(id, ws);
        ws.send(JSON.stringify({ type: 'welcome', id }));
        broadcastPeerList();
        ws.on('message', raw => {
            let data;
            try { data = JSON.parse(raw.toString()); } catch (err) { return; }
            if (!data.to) return;
            const target = peers.get(data.to);
            if (target) { data.from = id; target.send(JSON.stringify(data)); }
        });
        ws.on('close', () => { peers.delete(id); broadcastPeerList(); });
    });

    return { httpServer: server, wsServer: wss };
}

module.exports = { startServers };
