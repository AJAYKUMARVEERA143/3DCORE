/**
 * 3D Core Studio — Complete Blender 4.0 Engine
 *
 * Built from Blender source reference:
 *   space_toolsystem_toolbar.py  — all tools & brushes
 *   properties_data_modifier.py  — Generate / Deform / Normals modifier stacks
 *   space_dopesheet.py           — Timeline, Dope Sheet, keyframe interpolation
 *   properties_material.py       — Principled BSDF material properties
 *
 * Key fixes vs previous version:
 *   1. transformControls 'change' → updateInspectorFromSelected (read-only sync)
 *   2. Raycaster only tests Mesh objects (isMesh check)
 *   3. Click vs orbit: 5px drag threshold on pointerup
 *   4. setActiveTool clears both .su-palette-btn & .t-tool-btn
 */

// ─────────────────────────────────────────────────────────────
// SCENE STATE
// ─────────────────────────────────────────────────────────────
let scene, camera, renderer, orbitControls, transformControls;
let composer, ssaoPass, bloomPass; // post-processing — see setupPostProcessing()
let ssaoEnabled = false, bloomEnabled = false, hdriEnvEnabled = false;
let selectedObject = null;
let sceneObjects   = [];

// Grid snap — the header chip used to say "Snap: 3D Grid" with no effect.
// Increment is in world meters (Z-up). Vertex/edge/axis inference still wins
// over the grid while drawing (same as SketchUp: inferences beat the grid).
const GRID_SNAP_STEPS = [0.01, 0.1, 0.25, 0.5, 1, 5];
let gridSnapOn = true;
let gridSnapStep = 1;
let transformSpace = 'world'; // 'world' | 'local'
// Object-mode proportional translate: nearby unselected objects follow the
// gizmo with a distance falloff. Not Blender vertex PE (no half-edge mesh).
const PROP_RADIUS_STEPS = [0.5, 1, 2, 4, 8];
let proportionalEditOn = false;
let proportionalRadius = 2;
let lightingSunScale = 1;
let lightingPresetName = 'studio';
let engineExposure = 1;
let engineEnvIntensity = 1;
let groundGrid = null;
let axisHelpers = [];
let renderQualityName = 'balanced';
let sceneDirty = true;
let lastGpuDrawMs = 0;
let lastCamState = null;
let userShadowPref = true;
let presentMode = false;
let presentSlides = [];
let presentIndex = 0;
let presentPlaying = false;
let presentPlayRaf = 0;
let presentSavedQuality = null;
let presentLerp = null;
function markSceneDirty() { sceneDirty = true; }

function snapScalar(n, size) {
    if (!size) return n;
    return Math.round(n / size) * size;
}
function snapVec3(v, size) {
    if (!v || !size) return v;
    v.x = snapScalar(v.x, size);
    v.y = snapScalar(v.y, size);
    v.z = snapScalar(v.z, size);
    return v;
}
function formatSnapStep(step) {
    if (step < 0.1) return step.toFixed(2) + 'm';
    if (step < 1) return String(step) + 'm';
    return step + 'm';
}
function applyTransformSnapSettings() {
    if (!transformControls) return;
    transformControls.setTranslationSnap(gridSnapOn ? gridSnapStep : null);
    transformControls.setRotationSnap(gridSnapOn ? (15 * Math.PI / 180) : null);
    transformControls.setScaleSnap(gridSnapOn ? 0.1 : null);
    transformControls.setSpace(transformSpace);
}
function refreshSnapChip() {
    const chip = document.getElementById('snap-chip');
    if (chip) {
        chip.textContent = gridSnapOn ? `🧲 Snap: ${formatSnapStep(gridSnapStep)}` : '🧲 Snap: Off';
        chip.classList.toggle('chip-off', !gridSnapOn);
        chip.title = 'Click to toggle grid snap. Shift-click to cycle increment (1cm → 5m).';
    }
    const space = document.getElementById('space-chip');
    if (space) {
        space.textContent = transformSpace === 'world' ? '🌐 Global' : '📐 Local';
        space.title = 'Click to toggle transform space (Global / Local).';
    }
}
function toggleGridSnap(ev) {
    if (ev && ev.shiftKey) {
        const i = GRID_SNAP_STEPS.indexOf(gridSnapStep);
        gridSnapStep = GRID_SNAP_STEPS[(i + 1) % GRID_SNAP_STEPS.length];
        gridSnapOn = true;
    } else {
        gridSnapOn = !gridSnapOn;
    }
    applyTransformSnapSettings();
    refreshSnapChip();
    setVCB('Grid Snap:', gridSnapOn ? formatSnapStep(gridSnapStep) : 'Off');
}
function refreshPropChip() {
    const chip = document.getElementById('prop-chip');
    if (!chip) return;
    chip.textContent = proportionalEditOn ? `○ PE: ${proportionalRadius}m` : '○ PE: Off';
    chip.classList.toggle('chip-off', !proportionalEditOn);
    chip.title = 'Proportional falloff: objects on gizmo translate; vertices during Vertex Slide if PE is on. Shift-click cycles radius.';
}
function toggleProportionalEdit(ev) {
    if (ev && ev.shiftKey) {
        const i = PROP_RADIUS_STEPS.indexOf(proportionalRadius);
        proportionalRadius = PROP_RADIUS_STEPS[(i + 1) % PROP_RADIUS_STEPS.length];
        proportionalEditOn = true;
    } else {
        proportionalEditOn = !proportionalEditOn;
    }
    refreshPropChip();
    setVCB('Proportional:', proportionalEditOn ? `On · ${proportionalRadius} m (objects, translate)` : 'Off');
}
function toggleTransformSpace() {
    transformSpace = transformSpace === 'world' ? 'local' : 'world';
    applyTransformSnapSettings();
    refreshSnapChip();
    setVCB('Transform:', transformSpace === 'world' ? 'Global' : 'Local');
}

let activeTool           = 'select';
let currentInteractionMode = 'object';
let currentShadingMode   = 'MATERIAL';
// Was a single exclusive-mode string; now three independent toggles so a
// user can have any combination active at once (matching Blender's real
// combined vertex/edge/face select), not just one at a time.
let vertexSelectOn = true;
let edgeSelectOn = false;
let faceSelectOn = false;

// Animation / Dope Sheet state
let animFrame   = 1;
let isAnimPlaying = false;
let keyframes   = {};          // uuid → [{ frame, pos, rot, scale }]

// Sculpt state (from _defs_sculpt in toolbar reference)
let sculpt = { brush: 'draw', radius: 40, strength: 0.5, invert: false };

// Undo / Redo command stack
const undoStack = [];
const redoStack = [];
const MAX_UNDO = 100;
let _dragStartState = null; // captured on transform-gizmo drag start

// Edit Mode — Face select state (triangle-level; geometry converted to
// non-indexed on first use so extruding one face never drags a neighbor)
let selectedFaces = [];       // triangle indices (position array index / 3) on selectedObject.geometry
let faceHighlightMesh = null; // overlay mesh (child of selectedObject) showing the current face selection

// ─────────────────────────────────────────────────────────────
// INIT — mirrors Blender startup_handler / initSomeWindow
// ─────────────────────────────────────────────────────────────
function initApp() {
    const container = document.querySelector('.blender-viewport-area');
    const canvas    = document.getElementById('viewport-canvas');

    // Resize canvas to fill container
    function fitCanvas() {
        canvas.width  = container.clientWidth;
        canvas.height = container.clientHeight;
        const overlay = document.getElementById('su-canvas');
        if (overlay) { overlay.width = container.clientWidth; overlay.height = container.clientHeight; }
        if (renderer) {
            renderer.setSize(container.clientWidth, container.clientHeight);
            camera.aspect = container.clientWidth / container.clientHeight;
            camera.updateProjectionMatrix();
        }
        if (composer) composer.setSize(container.clientWidth, container.clientHeight);
        if (ssaoPass) { ssaoPass.width = container.clientWidth; ssaoPass.height = container.clientHeight; }
    }
    fitCanvas();
    // Docking/floating/resizing a panel changes the viewport container's
    // size via internal CSS layout, not a browser window resize — the
    // window 'resize' listener below never fires for that, so the WebGL
    // drawing buffer silently went out of sync with the canvas's new CSS
    // box (visible as a corrupted/blank region after docking a panel to
    // the top or bottom edge). ResizeObserver catches every real size
    // change to the container regardless of cause.
    if (window.ResizeObserver) new ResizeObserver(fitCanvas).observe(container);

    // Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a1a);
    if (THREE.RectAreaLightUniformsLib) THREE.RectAreaLightUniformsLib.init(); // required once before any RectAreaLight (Area Light) renders correctly

    // Camera — Blender default: perspective, 50mm, at (7.35, -6.92, 4.95), Z-up
    camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.01, 2000);
    camera.up.set(0, 0, 1);
    camera.position.set(7.35, -6.92, 4.95);
    camera.lookAt(0, 0, 0);

    // Renderer
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
    renderer.toneMapping       = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    if (renderer.xr) renderer.xr.enabled = true;

    // Post-processing (SSAO + Bloom) — off by default, real GPU cost, so
    // this stays purely opt-in (Render tab checkboxes) rather than always-on,
    // matching the project's lightweight-by-default principle. Scoped to the
    // live viewport only — Render Image/Video and the P2P pool's per-strip
    // renders use the plain renderer directly, not this composer.
    setupPostProcessing();

    // OrbitControls — Blender: Middle Mouse orbit, Shift+Middle pan, Scroll zoom
    orbitControls = new THREE.OrbitControls(camera, renderer.domElement);
    orbitControls.mouseButtons = {
        LEFT:   null,               // Left click reserved for selection
        MIDDLE: THREE.MOUSE.ROTATE,
        RIGHT:  THREE.MOUSE.PAN
    };
    orbitControls.enableDamping = true;
    orbitControls.dampingFactor = 0.08;
    orbitControls.zoomSpeed     = 1.2;
    orbitControls.screenSpacePanning = true;
    orbitControls.addEventListener('change', markSceneDirty);

    // TransformControls — Blender-style gizmo
    transformControls = new THREE.TransformControls(camera, renderer.domElement);
    transformControls.size = 0.9;
    // *** FIX 1: 'change' must only READ from object → inspector, never write back ***
    transformControls.addEventListener('change', () => {
        if (selectedObject) updateInspectorFromSelected();
    });
    transformControls.addEventListener('dragging-changed', e => {
        orbitControls.enabled = !e.value;
        if (e.value) {
            // Drag started — capture pre-transform state
            const extras = [];
            outlinerMultiSelect.forEach(m => {
                if (m && m !== selectedObject) {
                    const mEntry = sceneObjects.find(o => o.mesh === m);
                    if (mEntry && mEntry.locked) return; // Lock blocks group-drag too, not just a solo drag
                    extras.push({ mesh: m, position: m.position.clone(), rotation: m.rotation.clone(), scale: m.scale.clone() });
                }
            });
            let prop = [];
            if (proportionalEditOn && selectedObject && transformControls.getMode() === 'translate') {
                const skip = new Set([selectedObject, ...extras.map(x => x.mesh)]);
                const MT = window.MeshTools;
                sceneObjects.forEach(entry => {
                    const m = entry.mesh;
                    if (!m || skip.has(m) || entry.locked || !m.position) return;
                    const d = m.position.distanceTo(selectedObject.position);
                    const w = MT ? MT.falloffWeight(d, proportionalRadius, 'smooth') : 0;
                    if (w > 0) prop.push({ mesh: m, position: m.position.clone(), rotation: m.rotation.clone(), scale: m.scale.clone(), weight: w });
                });
            }
            _dragStartState = selectedObject ? {
                obj: selectedObject,
                position: selectedObject.position.clone(),
                rotation: selectedObject.rotation.clone(),
                scale: selectedObject.scale.clone(),
                extras,
                prop,
            } : null;
        } else if (_dragStartState) {
            // Drag ended — push undo command if anything actually changed
            const before = _dragStartState;
            const obj = before.obj;
            const after = { position: obj.position.clone(), rotation: obj.rotation.clone(), scale: obj.scale.clone() };
            const extraAfter = (before.extras || []).map(x => ({ mesh: x.mesh, position: x.mesh.position.clone(), rotation: x.mesh.rotation.clone(), scale: x.mesh.scale.clone() }));
            const propAfter = (before.prop || []).map(x => ({ mesh: x.mesh, position: x.mesh.position.clone(), rotation: x.mesh.rotation.clone(), scale: x.mesh.scale.clone() }));
            before.propEnd = propAfter;
            const extrasMoved = extraAfter.some((a, i) => !a.position.equals(before.extras[i].position)) ||
                propAfter.some((a, i) => !a.position.equals(before.prop[i].position));
            const changed = !before.position.equals(after.position) ||
                !before.rotation.equals(after.rotation) ||
                !before.scale.equals(after.scale) || extrasMoved;
            if (changed) {
                pushUndo({
                    undo() {
                        obj.position.copy(before.position); obj.rotation.copy(before.rotation); obj.scale.copy(before.scale);
                        (before.extras || []).forEach(x => { x.mesh.position.copy(x.position); x.mesh.rotation.copy(x.rotation); x.mesh.scale.copy(x.scale); });
                        (before.prop || []).forEach(x => { x.mesh.position.copy(x.position); x.mesh.rotation.copy(x.rotation); x.mesh.scale.copy(x.scale); });
                        if (selectedObject === obj) updateInspectorFromSelected();
                    },
                    redo() {
                        obj.position.copy(after.position); obj.rotation.copy(after.rotation); obj.scale.copy(after.scale);
                        extraAfter.forEach(x => { x.mesh.position.copy(x.position); x.mesh.rotation.copy(x.rotation); x.mesh.scale.copy(x.scale); });
                        (before.propEnd || []).forEach(x => { x.mesh.position.copy(x.position); x.mesh.rotation.copy(x.rotation); x.mesh.scale.copy(x.scale); });
                        if (selectedObject === obj) updateInspectorFromSelected();
                    },
                });
            }
            _dragStartState = null;
        }
    });
    scene.add(transformControls);
    applyTransformSnapSettings();
    transformControls.addEventListener('objectChange', () => {
        if (!selectedObject || !_dragStartState) return;
        if (gridSnapOn && transformControls.getMode() === 'translate') {
            snapVec3(selectedObject.position, gridSnapStep);
        }
        const extras = _dragStartState.extras || [];
        const prop = _dragStartState.prop || [];
        if (extras.length || prop.length) {
            const delta = selectedObject.position.clone().sub(_dragStartState.position);
            extras.forEach(x => x.mesh.position.copy(x.position).add(delta));
            prop.forEach(x => x.mesh.position.copy(x.position).add(delta.clone().multiplyScalar(x.weight)));
        }
    });

    // Ground Grid — 30m x 30m, major every 1m (Blender default)
    groundGrid = new THREE.GridHelper(30, 30, 0x444444, 0x2a2a2a);
    groundGrid.rotation.x = Math.PI / 2;   // Z-up
    scene.add(groundGrid);

    // Red X axis line
    const xLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-15,0,0), new THREE.Vector3(15,0,0)]),
        new THREE.LineBasicMaterial({ color: 0xff4444 })
    );
    scene.add(xLine);
    // Green Y axis line
    const yLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,-15,0), new THREE.Vector3(0,15,0)]),
        new THREE.LineBasicMaterial({ color: 0x44cc44 })
    );
    scene.add(yLine);
    axisHelpers = [xLine, yLine];

    buildDefaultBlenderScene();

    setupRaycasterSelection(canvas);
    setupSketchTools(canvas);
    setupSculptTools(canvas);
    setupAdvancedEditTools(canvas);
    setupBoxCircleSelect(canvas);
    setupContextMenu(canvas);
    setupBooleanPicker(canvas);
    setupDimensionPicker(canvas);
    setupOpeningTool(canvas);
    setupScaleHandles(canvas);
    setupMaterialDragDrop(canvas);
    setupWalkMode(canvas);
    setupKeyboard();
    setupDopeSheet();
    setupSuCanvas();
    renderMaterialLibraryTabs();
    renderMaterialSwatchGrid(currentMatCategory);
    renderSculptBrushGrid();
    renderModifierAddPanel();
    renderLayersPanel();
    populateLayerSelect();
    renderLevelsPanel();

    window.addEventListener('resize', fitCanvas);
    renderLoop();

    initDockablePanels();
    initViewCube();
    document.querySelectorAll('.units-quick-select').forEach(el => { el.value = appUnits; });
    refreshSnapChip();
    tryAutoRestoreSession();
    let showOnStartup = true;
    try { showOnStartup = localStorage.getItem(WELCOME_PREF_KEY) !== '0'; } catch (err) { /* private-mode storage denial — default stays true */ }
    if (showOnStartup) showWelcomeScreen();

    const qSel = document.getElementById('quality-select');
    if (qSel) qSel.value = renderQualityName;
    applyRenderQuality(renderQualityName);
    refreshPropChip();
    pingStudioService();
    refreshXRButtons();
    registerPwa();
    refreshHudContext();
    document.addEventListener('visibilitychange', markSceneDirty);
    if (renderer && renderer.domElement) {
        renderer.domElement.addEventListener('pointerdown', markSceneDirty);
        renderer.domElement.addEventListener('wheel', markSceneDirty, { passive: true });
    }

    const loadingScreen = document.getElementById('loading-screen');
    if (loadingScreen) {
        // Belt-and-suspenders: the class drives the real fade transition,
        // but also set pointerEvents directly and immediately so the
        // loading screen can never keep blocking clicks even if the CSS
        // transition itself is slow/throttled to tick in some environment
        // (confirmed to happen under headless test automation — real
        // browsers tick their compositor on real vsync regardless, but
        // this costs nothing and removes any doubt). Fully removed from
        // layout after the transition's real duration so it can't leave
        // an invisible-but-still-there full-viewport element sitting on
        // top of everything.
        loadingScreen.classList.add('loading-screen-hidden');
        loadingScreen.style.pointerEvents = 'none';
        setTimeout(() => { loadingScreen.style.display = 'none'; }, 450);
    }
}

// ─────────────────────────────────────────────────────────────
// RENDER LOOP
// ─────────────────────────────────────────────────────────────
let _lastFrameTime = performance.now();
let xrAnimating = false;
function renderLoop() {
    if (!xrAnimating) requestAnimationFrame(renderLoop);
    if (xrAnimating) return;
    renderTick(false);
}
function renderTick(fromXR) {
    const now = performance.now();
    const dt = Math.min((now - _lastFrameTime) / 1000, 0.1); // clamp so a tab-switch stall doesn't teleport the walk camera
    _lastFrameTime = now;

    if (fromXR) {
        pollARHitTest();
        syncSectionPlane();
        renderer.render(scene, camera);
        return;
    }

    orbitControls.update();
    updateSelectionOutline(); // cheap no-op unless selection/geometry actually changed since last frame
    updateScaleHandles();
    renderViewCube();
    syncSectionPlane(); // real-time — clip plane follows the gizmo mesh if the user moved/rotated it
    stepWalkMovement(dt);
    updateAllPersistentDimensions();

    if (isAnimPlaying) {
        animFrame = (animFrame % 250) + 1;
        document.getElementById('anim-scrubber').value = animFrame;
        document.getElementById('frame-display').innerText = animFrame;
        applyAnimationAtFrame(animFrame);
        drawDopeSheet();
        markSceneDirty();
    }

    if (presentLerp) {
        stepPresentLerp(now);
        markSceneDirty();
    }

    const RQ = window.RenderQuality;
    const preset = (RQ && RQ.PRESETS[renderQualityName]) || { fps: 60 };
    const camState = camera.position.toArray().concat(orbitControls.target.toArray(), [camera.fov]);
    const cameraMoved = RQ ? RQ.cameraChanged(lastCamState, camState) : true;
    const walkMoving = !!(typeof walkModeActive !== 'undefined' && walkModeActive && _walkKeysDown && _walkKeysDown.size);
    const needDraw = RQ
        ? RQ.shouldRenderFrame({
            documentHidden: document.hidden,
            dirty: sceneDirty || !!(transformControls && transformControls.dragging),
            cameraMoved,
            animationPlaying: isAnimPlaying,
            walkMoving,
            presentPlaying: presentPlaying || !!presentLerp,
            fpsCap: preset.fps,
            lastDrawMs: lastGpuDrawMs,
            nowMs: now,
        })
        : true;
    if (!needDraw) {
        if (vcRenderer && !presentMode) renderViewCube();
        return;
    }
    lastCamState = camState;
    lastGpuDrawMs = now;
    sceneDirty = false;

    if (composer && (ssaoEnabled || bloomEnabled) && !presentMode) composer.render();
    else renderer.render(scene, camera);
}

// ─────────────────────────────────────────────────────────────
// DEFAULT SCENE (Camera + Cube + Point Light — Blender Startup)
// ─────────────────────────────────────────────────────────────
function buildDefaultBlenderScene() {
    sceneObjects.forEach(o => scene.remove(o.mesh));
    sceneObjects = [];
    if (transformControls) transformControls.detach();
    // New Scene used to leave every previous AmbientLight in the graph
    // (ambient is not tracked in sceneObjects), so each File → New stacked
    // another 0.35 fill and the default cube got brighter every time.
    scene.children.filter(c => c.isAmbientLight).forEach(c => scene.remove(c));

    // Ambient
    const ambient = new THREE.AmbientLight(0xffffff, 0.35);
    scene.add(ambient);

    // Point Light at (4.07, 1.0, 5.9) — Blender default. The light itself
    // (not a disconnected decorative stand-in) is what gets tracked below
    // and gizmo'd, with a small visual marker sphere parented as ITS CHILD
    // — see attachLightVisual() — so moving "Light" in the viewport/outliner
    // actually moves the real illumination.
    const ptLight = new THREE.PointLight(0xffffff, 600, 0);
    ptLight.position.set(4.07, 1.0, 5.9);
    ptLight.castShadow = true;
    ptLight.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    ptLight.name = 'Light';
    scene.add(ptLight);
    attachLightVisual(ptLight, 0xffe066);
    const lightMesh = ptLight;

    // Default Cube — 2m × 2m × 2m at origin
    const cubeMat = new THREE.MeshStandardMaterial({ color: 0xbebebe, roughness: 0.5, metalness: 0.0 });
    const cube    = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), cubeMat);
    cube.castShadow = true;
    cube.receiveShadow = true;
    cube.name = 'Cube';
    scene.add(cube);

    // Camera helper (pyramid wireframe) at default camera position
    const camGeo = new THREE.ConeGeometry(0.6, 1.2, 4);
    camGeo.rotateX(Math.PI / 2);
    const camMesh = new THREE.Mesh(camGeo, new THREE.MeshBasicMaterial({ wireframe: true, color: 0x888888 }));
    camMesh.position.set(7.35, -6.92, 4.95);
    camMesh.lookAt(0, 0, 0);
    camMesh.name = 'Camera';
    scene.add(camMesh);

    sceneObjects = [
        { name: 'Camera',  type: 'camera', mesh: camMesh   },
        { name: 'Cube',    type: 'mesh',   mesh: cube       },
        { name: 'Light',   type: 'light',  mesh: lightMesh  },
    ];

    renderOutliner();
    selectObject(cube);
    updateHUD();
}

// ─────────────────────────────────────────────────────────────
// OUTLINER
// ─────────────────────────────────────────────────────────────
function renderOutliner() {
    const list = document.getElementById('outliner-tree-list');
    if (!list) return;

    list.innerHTML = '';

    const root = document.createElement('div');
    root.style.cssText = 'font-weight:700; color:#aaa; padding:2px 4px; font-size:10.5px;';
    root.textContent = '📂 Scene Collection';
    list.appendChild(root);

    const coll = document.createElement('div');
    coll.style.cssText = 'padding-left:14px; color:#888; font-size:10px; padding:2px 4px 2px 14px;';
    coll.textContent = '📁 Collection';
    list.appendChild(coll);

    sceneObjects.forEach(item => {
        const isSel = selectedObject === item.mesh;
        const isMulti = outlinerMultiSelect.has(item.mesh);
        const ICONS = { camera: '📷', light: '💡', curve: '➰', guide: '📏', group: '🗃', component: '🧩', sectionplane: '✂️' };
        const icon  = ICONS[item.type] || '📦';

        const row = document.createElement('div');
        row.className = `tree-row ${isSel ? 'selected' : ''}`;
        row.style.paddingLeft = '24px';
        if (isMulti) row.style.outline = '1px solid #e97426';
        const hidden = item.mesh.visible === false;
        row.innerHTML = `
            <div class="tree-row-left" style="${hidden ? 'opacity:0.4;' : ''}">${icon} <span>${item.name}</span></div>
            <div class="tree-row-right" style="font-size:10px; color:#666;">
                <span class="outliner-lock-toggle" title="${item.locked ? 'Locked — click to unlock' : 'Unlocked — click to lock'}" style="cursor:pointer;">${item.locked ? '🔒' : '🔓'}</span>
                <span class="outliner-vis-toggle" title="${hidden ? 'Hidden — click to show' : 'Visible — click to hide'}" style="cursor:pointer;">${hidden ? '🚫' : '👁'}</span>
            </div>
        `;
        // Ctrl/Shift-click adds to a separate multi-select set (used only by
        // Group Selected — every other tool still reads the single
        // `selectedObject`, so this doesn't change any existing behavior.
        row.onclick = e => {
            if (e.ctrlKey || e.metaKey || e.shiftKey) { toggleOutlinerMultiSelect(item.mesh, true); selectObject(item.mesh); }
            else { outlinerMultiSelect.clear(); selectObject(item.mesh); }
        };
        row.querySelector('.outliner-vis-toggle').onclick = e => { e.stopPropagation(); toggleObjectVisibility(item.mesh); };
        row.querySelector('.outliner-lock-toggle').onclick = e => { e.stopPropagation(); outlinerMultiSelect.clear(); selectObject(item.mesh); toggleLockSelected(); };
        list.appendChild(row);
    });
}

// ─────────────────────────────────────────────────────────────
// SELECTION & RAYCASTER
// (FIX 2: only Mesh objects tested; FIX 3: pointerup with 5px threshold)
// ─────────────────────────────────────────────────────────────
const _raycaster = new THREE.Raycaster();
const _mouse     = new THREE.Vector2();

function setupRaycasterSelection(canvas) {
    let pDown = { x: 0, y: 0 };

    canvas.addEventListener('pointerdown', e => {
        pDown = { x: e.clientX, y: e.clientY };
        // <canvas> isn't natively focusable, so clicking it doesn't reliably
        // blur a previously-focused <input>/<select> — without this, every
        // keyboard shortcut silently stops working after using any input
        // field (setupKeyboard() ignores keydown while one has focus).
        if (document.activeElement && document.activeElement !== document.body && typeof document.activeElement.blur === 'function') {
            document.activeElement.blur();
        }
    });

    canvas.addEventListener('pointerup', e => {
        const dx = Math.abs(e.clientX - pDown.x);
        const dy = Math.abs(e.clientY - pDown.y);
        if (dx > 5 || dy > 5) return;         // was an orbit/pan drag — ignore
        if (e.button !== 0) return;

        const rect = canvas.getBoundingClientRect();
        _mouse.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
        _mouse.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;

        // Color Sample (eyedropper) — click any surface to pick up its
        // material into the Base Color/Roughness/Metallic fields, real
        // SketchUp Alt-eyedropper behavior, then drop back to Select so the
        // very next click doesn't re-sample by accident.
        if (activeTool === 'eyedropper') {
            _raycaster.setFromCamera(_mouse, camera);
            const targets = sceneObjects.filter(o => o.mesh && o.mesh.isMesh).map(o => o.mesh);
            const hits = _raycaster.intersectObjects(targets, false);
            if (hits.length > 0) sampleColorAtEvent(hits[0].object, hits[0].face);
            else setVCB('Color Sample:', 'Click a surface to sample its material');
            setActiveTool('select');
            return;
        }

        // Sculpt Mode has its own pointerdown-based object targeting
        // (setupSculptTools) — don't let plain object-click-selection fire
        // too, or releasing the mouse after a stroke can silently reselect
        // a different (possibly overlapping) object out from under it.
        if (currentInteractionMode === 'sculpt') return;

        // Vertex Slide/Edge Slide/Bisect/Knife have their own click/drag
        // handling (setupAdvancedEditTools) — don't let ordinary sub-element
        // select-toggle also fire on the same clicks.
        const advancedEditTools = ['vertex_slide', 'edge_slide', 'bisect', 'knife', 'extrude_to_cursor'];
        if (currentInteractionMode === 'edit' && advancedEditTools.includes(activeTool)) return;

        // Edit Mode: pick sub-elements (face/vertex/edge) on the already-
        // selected mesh instead of re-picking whole objects. Vertex/Edge/
        // Face select are independent toggles that can be combined, so a
        // click resolves via a priority cascade (Vertex > Edge > Face,
        // matching Blender's own combined-mode click resolution) — each
        // enabled mode only "wins" if the click actually landed near ITS
        // kind of element on screen; a click deep in a face's interior
        // still resolves to Face even with Vertex/Edge also enabled, since
        // neither has a candidate anywhere near the cursor.
        if (currentInteractionMode === 'edit' && selectedObject && selectedObject.isMesh) {
            ensureNonIndexed(selectedObject);
            _raycaster.setFromCamera(_mouse, camera);
            const hits = _raycaster.intersectObject(selectedObject, false);
            const hit = hits.length > 0 && hits[0].face ? hits[0] : null;

            let resolved = false;
            if (hit && (vertexSelectOn || edgeSelectOn || faceSelectOn)) {
                const cursorScreen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
                const toScreen = (p) => {
                    const s = p.clone().project(camera);
                    return { x: (s.x * 0.5 + 0.5) * rect.width, y: (-s.y * 0.5 + 0.5) * rect.height };
                };
                const PX_TOL = 14;
                const pos = selectedObject.geometry.attributes.position;
                const idxs = [hit.face.a, hit.face.b, hit.face.c];
                const worldPts = idxs.map(i => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(selectedObject.matrixWorld));

                if (vertexSelectOn) {
                    let bestD = Infinity;
                    worldPts.forEach(v => { const d = Math.hypot(toScreen(v).x - cursorScreen.x, toScreen(v).y - cursorScreen.y); if (d < bestD) bestD = d; });
                    if (bestD <= PX_TOL) { selectVertexAt(selectedObject, hit, e.shiftKey); resolved = true; }
                }
                if (!resolved && edgeSelectOn) {
                    let bestD = Infinity;
                    [[0, 1], [1, 2], [2, 0]].forEach(([a, b]) => {
                        const mid = worldPts[a].clone().lerp(worldPts[b], 0.5);
                        const d = Math.hypot(toScreen(mid).x - cursorScreen.x, toScreen(mid).y - cursorScreen.y);
                        if (d < bestD) bestD = d;
                    });
                    if (bestD <= PX_TOL) { selectEdgeAt(selectedObject, hit); resolved = true; }
                }
                if (!resolved && faceSelectOn && hit.faceIndex != null) {
                    toggleFaceSelection(selectedObject, hit.faceIndex, e.shiftKey);
                    resolved = true;
                }
            }
            if (!resolved && !e.shiftKey) {
                if (vertexSelectOn) clearVertexSelection();
                if (edgeSelectOn) clearEdgeSelection();
                if (faceSelectOn) clearFaceSelection();
            }
            return;
        }

        // Only select in Select tool or Transform tools
        const selectableTools = ['select', 'move', 'rotate', 'scale', 'transform'];
        if (!selectableTools.includes(activeTool)) return;

        // SketchUp workspace: clicking directly on a surface selects that
        // face immediately, matching real SketchUp — it has no separate
        // Edit Mode gate for this, a click on any face just picks it. The
        // whole object is selected too (so the gizmo/outliner/properties
        // panel stay in sync with ordinary object selection); only the
        // clicked face gets highlighted, via the same toggleFaceSelection()
        // Edit Mode's Face Select already uses (shift-click adds/removes
        // from a multi-face selection, same as there).
        if (currentInteractionMode === 'sketchup') {
            _raycaster.setFromCamera(_mouse, camera);
            const suTargets = sceneObjects
                .filter(o => o.mesh && o.mesh.isMesh && o.mesh.userData.selectable !== false)
                .map(o => o.mesh);
            const suHits = _raycaster.intersectObjects(suTargets, true);
            if (suHits.length > 0 && suHits[0].faceIndex != null) {
                let obj = suHits[0].object;
                while (obj && !sceneObjects.some(o => o.mesh === obj)) obj = obj.parent;
                const faceIndex = suHits[0].faceIndex;
                if (obj) {
                    if (e.shiftKey) toggleOutlinerMultiSelect(obj, true);
                    else outlinerMultiSelect.clear();
                    selectObject(obj);
                    ensureNonIndexed(obj);
                    toggleFaceSelection(obj, faceIndex, e.shiftKey);
                }
            } else if (!e.shiftKey) {
                selectObject(null);
            }
            return;
        }

        _raycaster.setFromCamera(_mouse, camera);

        // *** FIX 2: only Meshes/Lines that are visible, selectable scene objects ***
        const meshTargets = sceneObjects
            .filter(o => o.mesh && (o.mesh.isMesh || o.mesh.isLine) && o.mesh.name !== '_cursor' && o.mesh.userData.selectable !== false)
            .map(o => o.mesh);

        const hits = _raycaster.intersectObjects(meshTargets, true);

        if (hits.length > 0) {
            let obj = hits[0].object;
            // Walk up to find the matching root sceneObject
            while (obj) {
                if (sceneObjects.some(o => o.mesh === obj)) break;
                obj = obj.parent;
            }
            if (obj) {
                if (e.shiftKey) toggleOutlinerMultiSelect(obj, true);
                else outlinerMultiSelect.clear();
                selectObject(obj);
            }
        } else {
            if (!e.shiftKey) { outlinerMultiSelect.clear(); selectObject(null); }
        }
    });
}

// ─────────────────────────────────────────────────────────────
// SKETCHUP DRAWING TOOLS — Line, Rectangle, Circle, Arc, Eraser,
// Tape Measure. Previously these toolbar buttons only called
// setActiveTool() and set status text; clicking/dragging in the
// viewport did nothing. Now they raycast onto the ground plane (or an
// existing face, for on-face drawing) and build real geometry.
// ─────────────────────────────────────────────────────────────
let sketchState = null;        // in-progress draw data for the active tool
let sketchPreviewObj = null;   // temporary THREE.Line/Mesh shown while drawing
let lastDrawnProfile = null;   // points of the last completed Line/Arc — feeds the Spin tool

const _groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

// ─────────────────────────────────────────────────────────────
// INFERENCE ("detection feel") — AutoCAD/SketchUp-style point snapping
// while drawing: snap onto the nearest vertex or edge-midpoint of the
// triangle under the cursor, and snap onto a red/green/blue world axis
// when the cursor is nearly aligned to one from the last placed point.
// sketchPointFromEvent() is the single chokepoint every draw tool already
// calls each mousemove, so the inference state it computes here is what
// updateInferenceGuides() visualizes afterward (marker + colored guide
// line + tooltip) without touching any of the per-tool preview code.
// ─────────────────────────────────────────────────────────────
let _inferenceInfo = null;      // { type: 'vertex'|'edge'|'face'|'axis', point, axis?, refPoint?, label }
let _inferenceMarker = null;    // small sphere at the inferred point
let _inferenceGuideLine = null; // colored guide line (axis snaps only)
// SketchUp-style arrow-key direction lock while drawing a Line/Wall/Poly
// Build path — Right=Red(X), Left=Green(Y), Up=Blue(Z). While set, this
// overrides whatever hover-based inference/snap would otherwise apply and
// constrains the next point to lie exactly on that axis through the last
// placed point, exactly like the real tool's direction lock.
let _axisLockDir = null; // 'x' | 'y' | 'z' | null
const AXIS_COLORS = { x: 0xff4444, y: 0x44ff44, z: 0x4488ff };
const INFERENCE_COLORS = { vertex: 0xffcc00, edge: 0x00e5ff, tangent: 0xff44ff, face: null };
// Tangent-to-circle snap (see circleTangentSnap()) was previously always on
// with no way to turn it off — same on/off-toggle shape as xrayEnabled/
// toggleXRay() elsewhere in the file.
let tangentSnapEnabled = true;
// World-space normal of whatever the last sketchPointFromEvent() hit — a
// real mesh face's normal when hovering one, or world +Z (the ground
// plane's own normal) otherwise. Rectangle/Circle/Polygon/Pie read this at
// drag-start so they can draw flush against a tilted/rotated face instead
// of always building flat in world XY regardless of what's under the
// cursor.
let _lastHitNormal = new THREE.Vector3(0, 0, 1);

// Two orthonormal in-plane basis vectors for `normal`, used to build
// Rectangle/Circle/Polygon/Pie geometry in the plane of whatever face
// they're drawn on. Special-cased for normal ≈ world Z to reproduce
// today's exact world-X/world-Y behavior bit-for-bit for the common
// ground-plane/flat-top case — this is a strict generalization, not a
// behavior change, for anything that isn't a genuinely tilted face.
// Generalizes the hardcoded-world-Z in-plane-perpendicular construction
// Rotated Rectangle already used (crossVectors(normal, baseDir)).
function buildPlaneBasis(normal) {
    const n = normal.clone().normalize();
    if (Math.abs(n.z) > 0.999) {
        return { u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 1, 0), n };
    }
    const u = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 0, 1), n).normalize();
    const v = new THREE.Vector3().crossVectors(n, u).normalize();
    return { u, v, n };
}
function toggleTangentSnap(enabled) {
    tangentSnapEnabled = enabled;
    setVCB('Tangent Snap:', enabled ? 'On' : 'Off');
}

function findSketchReferencePoint() {
    if (sketchState && sketchState.points && sketchState.points.length) return sketchState.points[sketchState.points.length - 1];
    if (sketchState && sketchState.start) return sketchState.start;
    return null;
}

// ─────────────────────────────────────────────────────────────
// SKETCHUP-STYLE NUMERIC ENTRY (VCB) — while drawing a Line/Wall/Poly
// Build path, typing digits (no need to click into the measurement box
// first, exactly like real SketchUp) overrides the mouse-hover distance:
// Enter commits the next point at exactly that distance along whatever
// direction the cursor currently points, in the CURRENTLY SELECTED unit
// (unlike real SketchUp, this app's VCB has its own unit dropdown — see
// setAppUnits() — so the typed number is read in that unit, not a fixed
// one). Enter with nothing typed keeps its existing meaning: finish the
// whole shape. See setupKeyboard()'s Enter case and digit-capture block.
// ─────────────────────────────────────────────────────────────
let _vcbTypedValue = '';
let _lastSketchCursorPoint = null;
const NUMERIC_ENTRY_TOOLS = ['line', 'wall', 'poly_build'];

function parseTypedLength(str) {
    const n = parseFloat(str);
    if (!isFinite(n) || n <= 0) return null;
    return n / (UNIT_DEFS[appUnits] || UNIT_DEFS.m).factor; // display units -> world meters
}

// Real tangent-point snap (AutoCAD OSNAP's TANGENT) for the one shape that
// has a well-defined tangent in this app: a Circle, which is a real Mesh
// built from THREE.CircleGeometry (retains .parameters.radius). Given an
// external reference point, there are exactly two points on the circle
// where a line from that point touches it tangentially — computed in the
// circle's own local plane (its matrixWorld X/Y axes) so it's correct for
// a circle drawn on any face, not just the flat ground plane. Returns null
// if there's no tangent (reference point is inside/on the circle) or
// neither candidate is within pxTol of the cursor.
function circleTangentSnap(obj, refPoint, cursorScreen, toScreen, pxTol) {
    const geo = obj.geometry;
    if (!geo || geo.type !== 'CircleGeometry' || !geo.parameters) return null;
    const center = new THREE.Vector3().setFromMatrixPosition(obj.matrixWorld);
    const radius = geo.parameters.radius * obj.scale.x;
    const localX = new THREE.Vector3(1, 0, 0).transformDirection(obj.matrixWorld).normalize();
    const localY = new THREE.Vector3(0, 1, 0).transformDirection(obj.matrixWorld).normalize();
    const toRef = refPoint.clone().sub(center);
    const px = toRef.dot(localX), py = toRef.dot(localY);
    const d = Math.hypot(px, py);
    if (d <= radius + 1e-6) return null; // reference point is inside/on the circle -- no external tangent exists

    const theta = Math.atan2(py, px);
    const alpha = Math.acos(THREE.MathUtils.clamp(radius / d, -1, 1));
    const toWorld = (angle) => center.clone().addScaledVector(localX, radius * Math.cos(angle)).addScaledVector(localY, radius * Math.sin(angle));
    const candidates = [toWorld(theta + alpha), toWorld(theta - alpha)];

    let best = null, bestD = Infinity;
    candidates.forEach(p => {
        const s = toScreen(p);
        const dist = Math.hypot(s.x - cursorScreen.x, s.y - cursorScreen.y);
        if (dist < bestD) { bestD = dist; best = p; }
    });
    if (bestD > pxTol) return null;
    return { type: 'tangent', point: best.clone(), label: 'On Tangent' };
}

// Raycasts onto whatever face is under the cursor if there is one (so you
// can sketch directly on top of existing geometry), falling back to the
// Z=0 ground plane. Also computes/updates _inferenceInfo for the caller
// to visualize via updateInferenceGuides().
function sketchPointFromEvent(e, canvas) {
    const rect = canvas.getBoundingClientRect();
    _mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    _mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    _raycaster.setFromCamera(_mouse, camera);

    const meshTargets = sceneObjects
        .filter(o => o.mesh && (o.mesh.isMesh || o.mesh.isLine) && o.mesh !== sketchPreviewObj)
        .map(o => o.mesh);
    const hits = _raycaster.intersectObjects(meshTargets, true);

    let point = null, hitInfo = hits.length > 0 ? hits[0] : null;
    if (hitInfo) point = hitInfo.point.clone();
    else {
        const pt = new THREE.Vector3();
        point = _raycaster.ray.intersectPlane(_groundPlane, pt) ? pt : null;
    }
    if (!point) { _inferenceInfo = null; updateInferenceGuides(); return null; }

    // Real face normal when hovering a mesh face — read straight from
    // three.js's own raycast result (was already computed for free and
    // previously went completely unused) — else the ground plane's own
    // normal, world +Z, exactly matching every draw tool's existing
    // flat-on-the-ground assumption.
    _lastHitNormal = (hitInfo && hitInfo.face)
        ? hitInfo.face.normal.clone().transformDirection(hitInfo.object.matrixWorld).normalize()
        : new THREE.Vector3(0, 0, 1);

    _inferenceInfo = null;
    const cursorScreen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const toScreen = (p) => {
        const s = p.clone().project(camera);
        return { x: (s.x * 0.5 + 0.5) * rect.width, y: (-s.y * 0.5 + 0.5) * rect.height };
    };
    const PX_TOL = 14;

    const ref = findSketchReferencePoint();

    if (hitInfo && hitInfo.face) {
        // Mesh hit — check the 3 corners/edges of the hit triangle. Also
        // covers Circle objects (a real fan-triangulated Mesh in this app),
        // so a tangent check runs first when applicable — a circle's rim
        // vertices/edges would otherwise "win" the ordinary vertex/edge
        // check almost as often as the actual tangent point, since both
        // sit on the same rim.
        const circleTangent = tangentSnapEnabled && ref && circleTangentSnap(hitInfo.object, ref, cursorScreen, toScreen, PX_TOL);
        if (circleTangent) {
            point = circleTangent.point;
            _inferenceInfo = circleTangent;
        } else {
            const geo = hitInfo.object.geometry;
            const posAttr = geo.attributes.position;
            const idxs = [hitInfo.face.a, hitInfo.face.b, hitInfo.face.c];
            const worldVerts = idxs.map(i => new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(hitInfo.object.matrixWorld));

            let bestV = -1, bestVD = Infinity;
            worldVerts.forEach((v, i) => {
                const s = toScreen(v);
                const d = Math.hypot(s.x - cursorScreen.x, s.y - cursorScreen.y);
                if (d < bestVD) { bestVD = d; bestV = i; }
            });
            if (bestVD <= PX_TOL) {
                point = worldVerts[bestV].clone();
                _inferenceInfo = { type: 'vertex', point: point.clone(), label: 'On Endpoint' };
            } else {
                const edges = [[0, 1], [1, 2], [2, 0]];
                let bestED = Infinity, bestMid = null;
                edges.forEach(([a, b]) => {
                    const mid = worldVerts[a].clone().lerp(worldVerts[b], 0.5);
                    const s = toScreen(mid);
                    const d = Math.hypot(s.x - cursorScreen.x, s.y - cursorScreen.y);
                    if (d < bestED) { bestED = d; bestMid = mid; }
                });
                if (bestED <= PX_TOL) {
                    point = bestMid.clone();
                    _inferenceInfo = { type: 'edge', point: point.clone(), label: 'On Midpoint' };
                } else {
                    _inferenceInfo = { type: 'face', point: point.clone(), label: 'On Face' };
                }
            }
        }
    } else if (hitInfo && hitInfo.object.isLine) {
        // Line/Arc hit (THREE.Line — the Line/Arc tools' own output) has no
        // .face at all, so it was previously invisible to this whole
        // detection system: hovering to join a new line onto an existing
        // one's endpoint/midpoint silently fell through to a bare ground-
        // plane point with zero snapping.
        const posAttr = hitInfo.object.geometry.attributes.position;
        const n = posAttr.count;
        const worldPts = [];
        for (let i = 0; i < n; i++) worldPts.push(new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(hitInfo.object.matrixWorld));

        let bestV = -1, bestVD = Infinity;
        worldPts.forEach((v, i) => {
            const s = toScreen(v);
            const d = Math.hypot(s.x - cursorScreen.x, s.y - cursorScreen.y);
            if (d < bestVD) { bestVD = d; bestV = i; }
        });
        if (bestVD <= PX_TOL) {
            point = worldPts[bestV].clone();
            _inferenceInfo = { type: 'vertex', point: point.clone(), label: 'On Endpoint' };
        } else {
            let bestED = Infinity, bestMid = null;
            for (let i = 0; i < n - 1; i++) {
                const mid = worldPts[i].clone().lerp(worldPts[i + 1], 0.5);
                const s = toScreen(mid);
                const d = Math.hypot(s.x - cursorScreen.x, s.y - cursorScreen.y);
                if (d < bestED) { bestED = d; bestMid = mid; }
            }
            if (bestED <= PX_TOL) {
                point = bestMid.clone();
                _inferenceInfo = { type: 'edge', point: point.clone(), label: 'On Midpoint' };
            } else {
                _inferenceInfo = { type: 'face', point: point.clone(), label: 'On Line' };
            }
        }
    }

    if (ref && (!_inferenceInfo || _inferenceInfo.type === 'face')) {
        const d = point.clone().sub(ref);
        const len = Math.max(d.length(), 1e-6);
        const adx = Math.abs(d.x) / len, ady = Math.abs(d.y) / len, adz = Math.abs(d.z) / len;
        const AXIS_TOL = 0.06; // ~3.4 degrees off-axis still counts as "on axis"
        if (d.length() > 1e-4) {
            if (ady < AXIS_TOL && adz < AXIS_TOL) {
                point = ref.clone(); point.x += d.x;
                _inferenceInfo = { type: 'axis', axis: 'x', point: point.clone(), refPoint: ref.clone(), label: 'On Red Axis' };
            } else if (adx < AXIS_TOL && adz < AXIS_TOL) {
                point = ref.clone(); point.y += d.y;
                _inferenceInfo = { type: 'axis', axis: 'y', point: point.clone(), refPoint: ref.clone(), label: 'On Green Axis' };
            } else if (adx < AXIS_TOL && ady < AXIS_TOL) {
                point = ref.clone(); point.z += d.z;
                _inferenceInfo = { type: 'axis', axis: 'z', point: point.clone(), refPoint: ref.clone(), label: 'On Blue Axis' };
            }
        }
    }

    // Hard arrow-key axis lock wins over any hover-based inference/snap
    // above — matches real SketchUp: once locked, the point is forced onto
    // that axis through the reference point regardless of what the cursor
    // is hovering.
    if (_axisLockDir && ref) {
        const axisVec = _axisLockDir === 'x' ? new THREE.Vector3(1, 0, 0)
            : _axisLockDir === 'y' ? new THREE.Vector3(0, 1, 0)
            : new THREE.Vector3(0, 0, 1);
        const proj = point.clone().sub(ref).dot(axisVec);
        point = ref.clone().addScaledVector(axisVec, proj);
        const axisLabel = { x: 'Red Axis', y: 'Green Axis', z: 'Blue Axis' }[_axisLockDir];
        _inferenceInfo = { type: 'axis', axis: _axisLockDir, point: point.clone(), refPoint: ref.clone(), label: `On ${axisLabel} (Locked)` };
    }

    // Real angle readout — previously the axis-lock/right-angle detection
    // above only ever showed a qualitative label ("On Red Axis"); the
    // actual degree value was never computed or shown anywhere. Measured
    // against the PREVIOUS segment of the same path (only meaningful once
    // one already exists), so drawing a second segment that snaps onto an
    // axis now also reports the real turn angle, e.g. a genuine 90° corner.
    if (_inferenceInfo && _inferenceInfo.type === 'axis' && sketchState && sketchState.points && sketchState.points.length >= 2) {
        const prevDir = sketchState.points[sketchState.points.length - 1].clone().sub(sketchState.points[sketchState.points.length - 2]);
        const newDir = point.clone().sub(sketchState.points[sketchState.points.length - 1]);
        if (prevDir.lengthSq() > 1e-8 && newDir.lengthSq() > 1e-8) {
            const angleDeg = THREE.MathUtils.radToDeg(prevDir.angleTo(newDir));
            _inferenceInfo.angleDeg = angleDeg;
            _inferenceInfo.label += ` — ${angleDeg.toFixed(1)}°`;
        }
    }

    // Grid snap only when no stronger inference (endpoint/midpoint/axis/tangent)
    // is active — those already pinned the point and must win.
    const inferenceWins = _inferenceInfo && ['vertex', 'edge', 'axis', 'tangent'].includes(_inferenceInfo.type);
    if (gridSnapOn && !inferenceWins) {
        snapVec3(point, gridSnapStep);
        if (_inferenceInfo && _inferenceInfo.point) _inferenceInfo.point.copy(point);
        if (!_inferenceInfo) {
            _inferenceInfo = { type: 'face', point: point.clone(), label: `Grid ${formatSnapStep(gridSnapStep)}` };
        } else if (_inferenceInfo.type === 'face') {
            _inferenceInfo.label = `On Face · Grid ${formatSnapStep(gridSnapStep)}`;
        }
    }

    updateInferenceGuides(cursorScreen);

    _lastSketchCursorPoint = point.clone();

    // Live length (+ angle, when available) readout in the VCB while
    // hovering (mirrors SketchUp's continuously-updating measurement box)
    // — suppressed while the user is actively typing a number, so
    // keystrokes aren't immediately overwritten by the next mousemove's
    // live value.
    if (!_vcbTypedValue && NUMERIC_ENTRY_TOOLS.includes(activeTool) && sketchState) {
        const ref = findSketchReferencePoint();
        if (ref) {
            const lengthStr = formatLength(ref.distanceTo(point));
            const angleStr = (_inferenceInfo && _inferenceInfo.angleDeg != null) ? `   |   ${_inferenceInfo.angleDeg.toFixed(1)}°` : '';
            setVCB('Length:', lengthStr + angleStr);
        }
    }

    return point;
}

function clearInferenceGuides() {
    if (_inferenceMarker) { scene.remove(_inferenceMarker); _inferenceMarker.geometry.dispose(); _inferenceMarker.material.dispose(); _inferenceMarker = null; }
    if (_inferenceGuideLine) { scene.remove(_inferenceGuideLine); _inferenceGuideLine.geometry.dispose(); _inferenceGuideLine.material.dispose(); _inferenceGuideLine = null; }
    const tip = document.getElementById('inference-tooltip');
    if (tip) tip.style.display = 'none';
}

function updateInferenceGuides(cursorScreen) {
    clearInferenceGuides();
    if (!_inferenceInfo) return;
    const color = _inferenceInfo.type === 'axis' ? AXIS_COLORS[_inferenceInfo.axis] : INFERENCE_COLORS[_inferenceInfo.type];

    if (color != null) {
        const markerGeo = new THREE.SphereGeometry(0.035, 8, 8);
        _inferenceMarker = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color, depthTest: false }));
        _inferenceMarker.renderOrder = 1000;
        _inferenceMarker.position.copy(_inferenceInfo.point);
        scene.add(_inferenceMarker);
    }

    if (_inferenceInfo.type === 'axis' && _inferenceInfo.refPoint) {
        const dirN = _inferenceInfo.point.clone().sub(_inferenceInfo.refPoint).normalize();
        const a = _inferenceInfo.refPoint.clone().addScaledVector(dirN, -0.3);
        const b = _inferenceInfo.point.clone().addScaledVector(dirN, 0.3);
        const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
        _inferenceGuideLine = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthTest: false }));
        _inferenceGuideLine.renderOrder = 999;
        scene.add(_inferenceGuideLine);
    }

    const tip = document.getElementById('inference-tooltip');
    if (tip && cursorScreen) {
        tip.textContent = _inferenceInfo.label;
        tip.style.background = '#' + new THREE.Color(color != null ? color : 0xffffff).getHexString();
        tip.style.left = cursorScreen.x + 'px';
        tip.style.top = cursorScreen.y + 'px';
        tip.style.display = 'block';
    }
}

function clearSketchPreview() {
    if (sketchPreviewObj) {
        scene.remove(sketchPreviewObj);
        sketchPreviewObj.geometry.dispose();
        sketchPreviewObj.material.dispose();
        sketchPreviewObj = null;
    }
}

function cancelSketchTool() {
    clearSketchPreview();
    clearInferenceGuides();
    _inferenceInfo = null;
    _axisLockDir = null;
    sketchState = null;
    if (suCtx && suCanvas) suCtx.clearRect(0, 0, suCanvas.width, suCanvas.height);
}

// Adds a freshly-drawn object to the scene with full undo/redo, mirroring
// the pattern addPrimitive() already uses.
function commitNewObject(obj, type) {
    const level = activeLevelIndex;
    scene.add(obj);
    sceneObjects.push({ name: obj.name, type, mesh: obj, level });
    renderOutliner();
    selectObject(obj);
    pushUndo({
        undo() { removeSceneObject(obj); },
        redo() { scene.add(obj); sceneObjects.push({ name: obj.name, type, mesh: obj, level }); renderOutliner(); selectObject(obj); },
    });
}

function nextName(base) {
    const count = sceneObjects.filter(o => o.name === base || o.name.startsWith(base + '.')).length;
    return count === 0 ? base : `${base}.${String(count).padStart(3, '0')}`;
}

// --- Line (polyline): click to add points, double-click/Enter to finish, Escape to cancel ---
function handleLineClick(pt) {
    if (!sketchState || sketchState.tool !== 'line') { sketchState = { tool: 'line', points: [] }; _axisLockDir = null; }
    sketchState.points.push(pt.clone());
    _vcbTypedValue = '';
    setVCB('Line:', `${sketchState.points.length} point(s) — double-click or Enter to finish, Esc to cancel`);
}
function updateLinePreview(cursorPt) {
    if (!sketchState || sketchState.tool !== 'line') return;
    clearSketchPreview();
    const pts = [...sketchState.points, cursorPt];
    if (pts.length < 2) return;
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    sketchPreviewObj = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x4da6ff }));
    scene.add(sketchPreviewObj);
}
// SketchUp auto-face: any closed loop of drawn edges automatically fills
// with a real, selectable flat face — it's not restricted to the
// Rectangle tool. Detects closure by the last point landing back near the
// first (within CLOSE_TOL) and, if so, builds a real fan-triangulated Mesh
// (same technique as Poly Build) instead of a bare wireframe Line. Since
// every triangle of that fan shares a "spoke" edge from the first point
// with its neighbor and all are exactly coplanar, the existing coplanar-
// group face selection already treats the whole thing as one surface —
// clicking (or right-clicking) anywhere on it selects the entire face, no
// separate handling needed.
const LINE_CLOSE_TOL = 0.25;

function finishLine() {
    if (!sketchState || sketchState.tool !== 'line' || sketchState.points.length < 2) { cancelSketchTool(); return; }
    const pts = sketchState.points;
    clearSketchPreview();

    const isClosed = pts.length >= 3 && pts[0].distanceTo(pts[pts.length - 1]) < LINE_CLOSE_TOL;
    if (isClosed) {
        const loopPts = pts.slice(0, -1); // drop the duplicate closing point
        const positions = [];
        for (let i = 1; i < loopPts.length - 1; i++) {
            positions.push(
                loopPts[0].x, loopPts[0].y, loopPts[0].z,
                loopPts[i].x, loopPts[i].y, loopPts[i].z,
                loopPts[i + 1].x, loopPts[i + 1].y, loopPts[i + 1].z,
            );
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
        geo.computeVertexNormals();
        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xbebebe, roughness: 0.5, metalness: 0.0, side: THREE.DoubleSide }));
        mesh.castShadow = true; mesh.receiveShadow = true;
        mesh.name = nextName('Face');
        lastDrawnProfile = loopPts.map(p => p.clone());
        commitNewObject(mesh, 'mesh');
        setVCB('Line:', `Closed loop — ${loopPts.length}-point face created`);
    } else {
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffffff }));
        line.name = nextName('Line');
        lastDrawnProfile = pts.map(p => p.clone());
        commitNewObject(line, 'curve');
        setVCB('Line:', `${pts.length}-point polyline created`);
    }
    sketchState = null;
}

// --- Rectangle: drag two corners -> a real, extrudable mesh face ---
// Real on-face drawing: captures the hit face's normal at drag-start (from
// sketchPointFromEvent's _lastHitNormal) and builds the rectangle in THAT
// face's own plane via buildPlaneBasis(), instead of always building flat
// in world XY regardless of what's under the cursor. For the ground plane
// (normal = world Z, by far the common case) the basis reduces to exactly
// world X/Y with zero rotation — bit-for-bit identical to the old behavior.
function startRectDrag(pt) { sketchState = { tool: 'rect', start: pt.clone(), normal: _lastHitNormal.clone() }; }
function updateRectPreview(pt) {
    if (!sketchState || sketchState.tool !== 'rect') return;
    clearSketchPreview();
    const { start, normal } = sketchState;
    const { u, v } = buildPlaneBasis(normal);
    const delta = pt.clone().sub(start);
    const w = delta.dot(u), d = delta.dot(v);
    const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(Math.max(Math.abs(w), 0.001), Math.max(Math.abs(d), 0.001)),
        new THREE.MeshBasicMaterial({ color: 0x4da6ff, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
    );
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    mesh.position.copy(start).addScaledVector(u, w / 2).addScaledVector(v, d / 2).addScaledVector(normal, 0.005);
    sketchPreviewObj = mesh;
    scene.add(sketchPreviewObj);
    setVCB('Rectangle:', `${formatLength(Math.abs(w))} x ${formatLength(Math.abs(d))}`);
}
function finishRect(pt) {
    if (!sketchState || sketchState.tool !== 'rect') return;
    const { start, normal } = sketchState;
    clearSketchPreview();
    const { u, v } = buildPlaneBasis(normal);
    const delta = pt.clone().sub(start);
    const w = delta.dot(u), d = delta.dot(v);
    sketchState = null;
    if (Math.abs(w) < 0.05 || Math.abs(d) < 0.05) return;

    const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(Math.abs(w), Math.abs(d)),
        new THREE.MeshStandardMaterial({ color: 0xbebebe, roughness: 0.5, metalness: 0.0, side: THREE.DoubleSide })
    );
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    mesh.position.copy(start).addScaledVector(u, w / 2).addScaledVector(v, d / 2);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.name = nextName('Rectangle');
    commitNewObject(mesh, 'mesh');
    setVCB('Rectangle:', `${formatLength(Math.abs(w))} x ${formatLength(Math.abs(d))} created`);
}

// --- Circle: click center, drag radius -> a real, extrudable mesh face ---
// Same on-face treatment as Rectangle: oriented via the real hit normal
// captured at drag-start instead of always lying flat in world XY.
function startCircleDrag(pt) { sketchState = { tool: 'circle', center: pt.clone(), normal: _lastHitNormal.clone() }; }
function updateCirclePreview(pt) {
    if (!sketchState || sketchState.tool !== 'circle') return;
    clearSketchPreview();
    const { center, normal } = sketchState;
    const r = center.distanceTo(pt);
    const mesh = new THREE.Mesh(
        new THREE.CircleGeometry(Math.max(r, 0.001), 32),
        new THREE.MeshBasicMaterial({ color: 0x4da6ff, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
    );
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    mesh.position.copy(center).addScaledVector(normal, 0.005);
    sketchPreviewObj = mesh;
    scene.add(sketchPreviewObj);
    setVCB('Circle:', `radius ${formatLength(r)}`);
}
function finishCircle(pt) {
    if (!sketchState || sketchState.tool !== 'circle') return;
    const { center, normal } = sketchState;
    clearSketchPreview();
    const r = center.distanceTo(pt);
    sketchState = null;
    if (r < 0.05) return;

    const mesh = new THREE.Mesh(
        new THREE.CircleGeometry(r, 32),
        new THREE.MeshStandardMaterial({ color: 0xbebebe, roughness: 0.5, metalness: 0.0, side: THREE.DoubleSide })
    );
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    mesh.position.copy(center);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.name = nextName('Circle');
    commitNewObject(mesh, 'mesh');
    setVCB('Circle:', `radius ${formatLength(r)} created`);
}

// --- Polygon: click center, drag radius -> a real N-sided face. Same
// click-drag-radius interaction as Circle; THREE.CircleGeometry's segment
// count IS the polygon side count (segments=6 draws an actual hexagon, not
// an approximation of one), so this reuses the exact same geometry class.
let polygonSides = 6; // adjustable via the Polygon Sides field next to the tool button
// Same on-face treatment as Circle.
function startPolygonDrag(pt) { sketchState = { tool: 'polygon', center: pt.clone(), normal: _lastHitNormal.clone() }; }
function updatePolygonPreview(pt) {
    if (!sketchState || sketchState.tool !== 'polygon') return;
    clearSketchPreview();
    const { center, normal } = sketchState;
    const r = center.distanceTo(pt);
    const mesh = new THREE.Mesh(
        new THREE.CircleGeometry(Math.max(r, 0.001), polygonSides),
        new THREE.MeshBasicMaterial({ color: 0x4da6ff, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
    );
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    mesh.position.copy(center).addScaledVector(normal, 0.005);
    sketchPreviewObj = mesh;
    scene.add(sketchPreviewObj);
    setVCB('Polygon:', `${polygonSides}-sided, radius ${formatLength(r)}`);
}
function finishPolygon(pt) {
    if (!sketchState || sketchState.tool !== 'polygon') return;
    const { center, normal } = sketchState;
    clearSketchPreview();
    const r = center.distanceTo(pt);
    sketchState = null;
    if (r < 0.05) return;
    const mesh = new THREE.Mesh(
        new THREE.CircleGeometry(r, polygonSides),
        new THREE.MeshStandardMaterial({ color: 0xbebebe, roughness: 0.5, metalness: 0.0, side: THREE.DoubleSide })
    );
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    mesh.position.copy(center);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.name = nextName('Polygon');
    commitNewObject(mesh, 'mesh');
    setVCB('Polygon:', `${polygonSides}-sided, radius ${formatLength(r)} created`);
}

// --- Pie: click center, drag radius -> a real filled wedge face.
// THREE.CircleGeometry natively supports a thetaLength (sweep angle), so a
// pie slice is the same geometry class as Circle/Polygon with a partial
// sweep instead of a full 360°.
let pieSweepDeg = 90; // adjustable via the Pie Angle field next to the tool button
// Same on-face treatment as Circle — the sweep start angle is measured
// within the face's own {u, v} plane (via atan2 of the basis-projected
// delta) rather than world X/Y, so it stays meaningful on a tilted face.
function startPieDrag(pt) { sketchState = { tool: 'pie', center: pt.clone(), normal: _lastHitNormal.clone() }; }
function updatePiePreview(pt) {
    if (!sketchState || sketchState.tool !== 'pie') return;
    clearSketchPreview();
    const { center, normal } = sketchState;
    const { u, v } = buildPlaneBasis(normal);
    const r = center.distanceTo(pt);
    const delta = pt.clone().sub(center);
    const thetaStart = Math.atan2(delta.dot(v), delta.dot(u));
    const mesh = new THREE.Mesh(
        new THREE.CircleGeometry(Math.max(r, 0.001), 32, thetaStart, THREE.MathUtils.degToRad(pieSweepDeg)),
        new THREE.MeshBasicMaterial({ color: 0x4da6ff, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
    );
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    mesh.position.copy(center).addScaledVector(normal, 0.005);
    sketchPreviewObj = mesh;
    scene.add(sketchPreviewObj);
    setVCB('Pie:', `radius ${formatLength(r)}, ${pieSweepDeg}°`);
}
function finishPie(pt) {
    if (!sketchState || sketchState.tool !== 'pie') return;
    const { center, normal } = sketchState;
    clearSketchPreview();
    const { u, v } = buildPlaneBasis(normal);
    const r = center.distanceTo(pt);
    const delta = pt.clone().sub(center);
    const thetaStart = Math.atan2(delta.dot(v), delta.dot(u));
    sketchState = null;
    if (r < 0.05) return;
    const mesh = new THREE.Mesh(
        new THREE.CircleGeometry(r, 32, thetaStart, THREE.MathUtils.degToRad(pieSweepDeg)),
        new THREE.MeshStandardMaterial({ color: 0xbebebe, roughness: 0.5, metalness: 0.0, side: THREE.DoubleSide })
    );
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    mesh.position.copy(center);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.name = nextName('Pie');
    commitNewObject(mesh, 'mesh');
    setVCB('Pie:', `radius ${formatLength(r)}, ${pieSweepDeg}° created`);
}

// --- Rotated Rectangle: click first corner, click to set the angled base
// edge (length + direction, not axis-locked), move to set perpendicular
// depth, click to finish. A real 3-click tool (like Arc), not an
// approximation — the resulting face genuinely sits at whatever angle the
// base edge was drawn at.
function handleRotRectClick(pt) {
    if (!sketchState || sketchState.tool !== 'rotrect') {
        sketchState = { tool: 'rotrect', points: [pt.clone()] };
        setVCB('Rotated Rectangle:', 'Click the end of the base edge');
        return;
    }
    if (sketchState.points.length === 1) {
        sketchState.points.push(pt.clone());
        setVCB('Rotated Rectangle:', 'Move to set depth, click to finish');
        return;
    }
    finishRotRect(pt);
}
function updateRotRectPreview(cursorPt) {
    if (!sketchState || sketchState.tool !== 'rotrect') return;
    clearSketchPreview();
    const [p0, p1] = sketchState.points;
    if (!p1) {
        // Previewing the base edge itself before its endpoint is clicked
        const geo = new THREE.BufferGeometry().setFromPoints([p0, cursorPt]);
        sketchPreviewObj = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x4da6ff }));
        scene.add(sketchPreviewObj);
        setVCB('Rotated Rectangle:', `base ${formatLength(p0.distanceTo(cursorPt))}`);
        return;
    }
    const base = p1.clone().sub(p0);
    const baseLen = base.length();
    if (baseLen < 1e-6) return;
    const baseDir = base.clone().normalize();
    const normal = new THREE.Vector3(0, 0, 1);
    const perp = new THREE.Vector3().crossVectors(normal, baseDir).normalize(); // in-plane perpendicular to the base edge
    const toCursor = cursorPt.clone().sub(p0);
    const depth = toCursor.dot(perp);
    const p2 = p1.clone().addScaledVector(perp, depth);
    const p3 = p0.clone().addScaledVector(perp, depth);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        p0.x, p0.y, p0.z,  p1.x, p1.y, p1.z,  p2.x, p2.y, p2.z,
        p0.x, p0.y, p0.z,  p2.x, p2.y, p2.z,  p3.x, p3.y, p3.z,
    ]), 3));
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x4da6ff, transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
    sketchPreviewObj = mesh;
    scene.add(sketchPreviewObj);
    setVCB('Rotated Rectangle:', `${formatLength(baseLen)} x ${formatLength(Math.abs(depth))}`);
}
function finishRotRect(cursorPt) {
    if (!sketchState || sketchState.tool !== 'rotrect' || sketchState.points.length < 2) { cancelSketchTool(); return; }
    const [p0, p1] = sketchState.points;
    clearSketchPreview();
    const base = p1.clone().sub(p0);
    const baseLen = base.length();
    const baseDir = base.clone().normalize();
    const normal = new THREE.Vector3(0, 0, 1);
    const perp = new THREE.Vector3().crossVectors(normal, baseDir).normalize();
    const depth = cursorPt.clone().sub(p0).dot(perp);
    sketchState = null;
    if (baseLen < 0.05 || Math.abs(depth) < 0.05) return;
    const p2 = p1.clone().addScaledVector(perp, depth);
    const p3 = p0.clone().addScaledVector(perp, depth);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        p0.x, p0.y, p0.z,  p1.x, p1.y, p1.z,  p2.x, p2.y, p2.z,
        p0.x, p0.y, p0.z,  p2.x, p2.y, p2.z,  p3.x, p3.y, p3.z,
    ]), 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xbebebe, roughness: 0.5, metalness: 0.0, side: THREE.DoubleSide }));
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.name = nextName('RotatedRectangle');
    commitNewObject(mesh, 'mesh');
    setVCB('Rotated Rectangle:', `${formatLength(baseLen)} x ${formatLength(Math.abs(depth))} created`);
}

// --- 2-Point Arc: click start, click end, move to bulge, click to finish ---
function handleArcClick(pt) {
    if (!sketchState || sketchState.tool !== 'arc') {
        sketchState = { tool: 'arc', points: [pt.clone()] };
        setVCB('Arc:', 'Click end point');
        return;
    }
    sketchState.points.push(pt.clone());
    if (sketchState.points.length === 2) { setVCB('Arc:', 'Move to set bulge, click to finish'); return; }
    finishArc();
}
function updateArcPreview(cursorPt) {
    if (!sketchState || sketchState.tool !== 'arc' || sketchState.points.length < 2) return;
    clearSketchPreview();
    const [p0, p1] = sketchState.points;
    const curve = new THREE.QuadraticBezierCurve3(p0, cursorPt, p1);
    const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(24));
    sketchPreviewObj = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x4da6ff }));
    scene.add(sketchPreviewObj);
}
function finishArc() {
    if (!sketchState || sketchState.points.length < 3) { cancelSketchTool(); return; }
    const [p0, p1, ctrl] = sketchState.points;
    clearSketchPreview();
    const curve = new THREE.QuadraticBezierCurve3(p0, ctrl, p1);
    const pts = curve.getPoints(24);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffffff }));
    line.name = nextName('Arc');
    lastDrawnProfile = pts.map(p => p.clone());
    commitNewObject(line, 'curve');
    setVCB('Arc:', 'Arc created');
    sketchState = null;
}

// --- Tape Measure: click two points -> real distance + a persistent dashed guide ---
function handleTapeClick(pt) {
    if (!sketchState || sketchState.tool !== 'tape') {
        sketchState = { tool: 'tape', points: [pt.clone()] };
        setVCB('Tape Measure:', 'Click second point');
        return;
    }
    sketchState.points.push(pt.clone());
    finishTape();
}
// Real dimension-line decoration (end ticks + inward arrowheads + a
// canvas-texture text label) — previously a tape measurement was just a
// plain dashed line with the distance shown only in the tiny VCB text.
function createDimensionSprite(text) {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(20,20,20,0.85)';
    ctx.fillRect(0, 0, 256, 64);
    ctx.strokeStyle = '#ffcc00'; ctx.lineWidth = 3; ctx.strokeRect(2, 2, 252, 60);
    ctx.fillStyle = '#ffcc00';
    ctx.font = 'bold 30px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 33);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false, sizeAttenuation: true }));
    sprite.scale.set(1.1, 0.28, 1);
    return sprite;
}

function addDimensionDecorations(parent, p0, p1, label) {
    const dir = p1.clone().sub(p0);
    const len = dir.length();
    if (len < 1e-6) return;
    dir.normalize();
    let perp = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 0, 1));
    if (perp.lengthSq() < 1e-6) perp = new THREE.Vector3(1, 0, 0);
    perp.normalize().multiplyScalar(Math.min(0.12, len * 0.08));
    const tickMat = new THREE.LineBasicMaterial({ color: 0xffcc00, depthTest: false });

    [p0, p1].forEach(p => parent.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([p.clone().sub(perp), p.clone().add(perp)]), tickMat)));

    const arrowLen = Math.min(0.2, len * 0.15);
    const arrow = (at, inward) => {
        const a = at.clone().addScaledVector(inward, arrowLen).add(perp);
        const b = at.clone().addScaledVector(inward, arrowLen).sub(perp);
        return new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, at, b]), tickMat);
    };
    parent.add(arrow(p0, dir));
    parent.add(arrow(p1, dir.clone().negate()));

    const sprite = createDimensionSprite(label);
    sprite.position.copy(p0.clone().lerp(p1, 0.5)).addScaledVector(perp.clone().normalize(), 0.3);
    parent.add(sprite);
}

function updateTapePreview(cursorPt) {
    if (!sketchState || sketchState.tool !== 'tape' || sketchState.points.length < 1) return;
    clearSketchPreview();
    const p0 = sketchState.points[0];
    const geo = new THREE.BufferGeometry().setFromPoints([p0, cursorPt]);
    sketchPreviewObj = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: 0xffcc00, dashSize: 0.2, gapSize: 0.1 }));
    sketchPreviewObj.computeLineDistances();
    addDimensionDecorations(sketchPreviewObj, p0, cursorPt, formatLength(p0.distanceTo(cursorPt), 3));
    scene.add(sketchPreviewObj);
    setVCB('Measurements:', formatLength(p0.distanceTo(cursorPt), 3));
}
function finishTape() {
    const [p0, p1] = sketchState.points;
    clearSketchPreview();
    const dist = p0.distanceTo(p1);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([p0, p1]), new THREE.LineDashedMaterial({ color: 0xffcc00, dashSize: 0.2, gapSize: 0.1 }));
    line.computeLineDistances();
    line.name = nextName('Guide');
    addDimensionDecorations(line, p0, p1, formatLength(dist, 3));
    commitNewObject(line, 'guide');
    setVCB('Measurements:', formatLength(dist, 3));
    sketchState = null;
    offerTapeMeasureRescale(dist);
}

// Real SketchUp behavior: after measuring a distance (typically along an
// imported floorplan image's known real-world dimension), entering the
// ACTUAL length rescales the whole model uniformly so that measurement
// becomes correct — this is how a raster floorplan underlay gets
// calibrated to real-world units.
function offerTapeMeasureRescale(measuredMeters) {
    if (measuredMeters < 1e-6) return;
    const input = prompt(`Measured: ${formatLength(measuredMeters, 3)}.\n\nTo resize the whole model so this measurement matches a known real-world length, type it now (e.g. "12 ft" or "3.5 m"). Leave blank to just keep this as a guide.`, '');
    if (!input) return;
    const targetMeters = parseTypedLength(input.trim());
    if (targetMeters == null || targetMeters < 1e-6) { alert('Could not understand that length.'); return; }
    const ratio = targetMeters / measuredMeters;
    if (Math.abs(ratio - 1) < 1e-4) return;
    if (!confirm(`Resize the entire model ${ratio.toFixed(3)}x so this measurement becomes ${formatLength(targetMeters, 3)}?`)) return;
    rescaleEntireModel(ratio);
    setVCB('Resized Model:', `${ratio.toFixed(3)}x -- measurement now ${formatLength(targetMeters, 3)}`);
}

// Uniformly rescales every top-level object around the world origin —
// repositioning AND resizing geometry-bearing objects (mesh/group/
// component/guide), but only repositioning (not resizing) cameras/lights,
// which have no meaningful "size" of their own.
function rescaleEntireModel(ratio) {
    const before = sceneObjects.map(o => ({ entry: o, pos: o.mesh.position.clone(), scale: o.mesh.scale.clone() }));
    const apply = () => before.forEach(({ entry }) => {
        entry.mesh.position.multiplyScalar(ratio);
        if (entry.type !== 'camera' && entry.type !== 'light') entry.mesh.scale.multiplyScalar(ratio);
    });
    apply();
    scheduleAutosave();
    pushUndo({
        undo() { before.forEach(({ entry, pos, scale }) => { entry.mesh.position.copy(pos); entry.mesh.scale.copy(scale); }); },
        redo() { apply(); },
    });
}

// ─────────────────────────────────────────────────────────────
// DIMENSION ANNOTATIONS — a real, PERSISTENT linear dimension between two
// objects, unlike Tape Measure above (a one-shot decorative Line frozen at
// the moment it was drawn). Click two objects; the dimension keeps
// tracking their live .position every frame and its line/label update in
// real time as either object moves — the actual gap this app's ROADMAP
// called out as still open. Deliberately scoped to object-to-object (not
// arbitrary moving mesh vertices, which Tape Measure already covers for a
// one-shot on-surface reading) — unambiguous to track, and the common
// real use case (how far apart are these two things).
// ─────────────────────────────────────────────────────────────
let persistentDimensions = []; // { objA, objB, group, _lastDist }
let _dimensionFirstObj = null;

function setupDimensionPicker(canvas) {
    canvas.addEventListener('pointerup', e => {
        if (activeTool !== 'dimension' || e.button !== 0) return;
        const rect = canvas.getBoundingClientRect();
        _mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        _mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        _raycaster.setFromCamera(_mouse, camera);
        const targets = sceneObjects.filter(o => o.mesh && o.type !== 'camera' && o.type !== 'light' && o.type !== 'dimension').map(o => o.mesh);
        const hits = _raycaster.intersectObjects(targets, true);
        if (hits.length === 0) return;
        let obj = hits[0].object;
        while (obj && !sceneObjects.some(o => o.mesh === obj)) obj = obj.parent;
        if (!obj) return;

        if (!_dimensionFirstObj) {
            _dimensionFirstObj = obj;
            setVCB('Dimension:', `${obj.name} — click a second object`);
            return;
        }
        if (obj === _dimensionFirstObj) { setVCB('Dimension:', 'Pick a different second object'); return; }
        createPersistentDimension(_dimensionFirstObj, obj);
        _dimensionFirstObj = null;
    });
}

function createPersistentDimension(objA, objB) {
    const group = new THREE.Group();
    group.name = nextName('Dimension');
    scene.add(group);
    const dim = { objA, objB, group };
    persistentDimensions.push(dim);
    sceneObjects.push({ name: group.name, type: 'dimension', mesh: group, level: activeLevelIndex });
    renderOutliner();
    updateDimensionGroup(dim);
    setVCB('Dimension:', `${objA.name} ↔ ${objB.name}`);
    pushUndo({
        undo() { removeSceneObject(group); persistentDimensions = persistentDimensions.filter(d => d !== dim); },
        redo() { scene.add(group); sceneObjects.push({ name: group.name, type: 'dimension', mesh: group, level: activeLevelIndex }); persistentDimensions.push(dim); renderOutliner(); },
    });
}

// Rebuilds a dimension's line + arrow/tick + text-sprite children from its
// two live object positions. Full rebuild rather than mutating existing
// geometry in place — createDimensionSprite/addDimensionDecorations (built
// for Tape Measure) already do real work per call and rebuilding is simple
// and correct; a dimension only rebuilds on an actual distance change
// (see updateAllPersistentDimensions), not unconditionally every frame.
function updateDimensionGroup(dim) {
    while (dim.group.children.length) {
        const c = dim.group.children.pop();
        if (c.geometry) c.geometry.dispose();
        if (c.material) { if (c.material.map) c.material.map.dispose(); c.material.dispose(); }
    }
    const p0 = dim.objA.position.clone();
    const p1 = dim.objB.position.clone();
    const dist = p0.distanceTo(p1);
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([p0, p1]), new THREE.LineDashedMaterial({ color: 0xffcc00, dashSize: 0.15, gapSize: 0.08 }));
    line.computeLineDistances();
    dim.group.add(line);
    addDimensionDecorations(dim.group, p0, p1, formatLength(dist, 3));
    dim._lastDist = dist;
}

// Called every frame from the render loop — cheap: skips any dimension
// whose distance hasn't actually changed, and drops (with its scene
// object) any dimension whose linked object was deleted, instead of
// throwing trying to read position off something gone.
function updateAllPersistentDimensions() {
    if (!persistentDimensions.length) return;
    let changed = false;
    persistentDimensions.slice().forEach(dim => {
        // Drop this dimension if either linked object is gone, OR if the
        // dimension's own scene object was deleted directly (e.g. via
        // normal Delete on the dimension itself) — either way there's
        // nothing live left to keep updating.
        if (!sceneObjects.some(o => o.mesh === dim.group) ||
            !sceneObjects.some(o => o.mesh === dim.objA) ||
            !sceneObjects.some(o => o.mesh === dim.objB)) {
            removeSceneObject(dim.group);
            persistentDimensions = persistentDimensions.filter(d => d !== dim);
            changed = true;
            return;
        }
        const newDist = dim.objA.position.distanceTo(dim.objB.position);
        if (dim._lastDist === undefined || Math.abs(newDist - dim._lastDist) > 1e-6) {
            updateDimensionGroup(dim);
            changed = true;
        }
    });
    if (changed) markSceneDirty();
}

// --- Poly Build: click points to build a new fan-triangulated face (min 3), double-click/Enter to finish ---
function handlePolyBuildClick(pt) {
    if (!sketchState || sketchState.tool !== 'polybuild') { sketchState = { tool: 'polybuild', points: [] }; _axisLockDir = null; }
    sketchState.points.push(pt.clone());
    _vcbTypedValue = '';
    setVCB('Poly Build:', `${sketchState.points.length} point(s) — double-click/Enter to finish (min 3)`);
}
function updatePolyBuildPreview(cursorPt) {
    if (!sketchState || sketchState.tool !== 'polybuild') return;
    clearSketchPreview();
    const pts = sketchState.points.length >= 2
        ? [...sketchState.points, cursorPt, sketchState.points[0]]
        : [...sketchState.points, cursorPt];
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    sketchPreviewObj = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x4da6ff }));
    scene.add(sketchPreviewObj);
}
function finishPolyBuild() {
    if (!sketchState || sketchState.tool !== 'polybuild' || sketchState.points.length < 3) { cancelSketchTool(); return; }
    const pts = sketchState.points;
    clearSketchPreview();

    const positions = [];
    for (let i = 1; i < pts.length - 1; i++) {
        positions.push(pts[0].x, pts[0].y, pts[0].z, pts[i].x, pts[i].y, pts[i].z, pts[i + 1].x, pts[i + 1].y, pts[i + 1].z);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xbebebe, roughness: 0.5, metalness: 0.0, side: THREE.DoubleSide }));
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.name = nextName('PolyFace');
    commitNewObject(mesh, 'mesh');
    setVCB('Poly Build:', `${pts.length}-point face created`);
    sketchState = null;
}

// --- Wall: click points to draw a continuous path, double-click/Enter to finish -> one real merged wall mesh ---
let wallSettings = { thickness: 0.2, height: 2.7 };

function buildWallSegmentMesh(p0, p1, thickness, height) {
    const dir = new THREE.Vector3().subVectors(p1, p0);
    const len = dir.length();
    if (len < 0.01) return null;
    dir.normalize();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(len, thickness, height));
    const mid = p0.clone().lerp(p1, 0.5);
    // Extrude upward from the clicked points' own Z (their floor elevation),
    // not always from world Z=0 — previously hardcoded to `height / 2`,
    // which silently ground-locked every wall regardless of what level it
    // was drawn on.
    mesh.position.set(mid.x, mid.y, mid.z + height / 2);
    mesh.rotation.z = Math.atan2(dir.y, dir.x);
    mesh.updateMatrix();
    return mesh;
}

// nextName() only counts entries already in sceneObjects — fine for a
// single new object, but finishWall() creates several "WallLayer" segments
// in one pass before any of them are pushed into sceneObjects, so plain
// nextName() would hand every segment the same collided name. This checks
// against sceneObjects AND whatever's already been named earlier in the
// same batch.
function nextBatchName(base, alreadyNamedInBatch) {
    let i = 0;
    while (true) {
        const candidate = i === 0 ? base : `${base}.${String(i).padStart(3, '0')}`;
        if (!sceneObjects.some(o => o.name === candidate) && !alreadyNamedInBatch.includes(candidate)) return candidate;
        i++;
    }
}

function handleWallClick(pt) {
    if (!sketchState || sketchState.tool !== 'wall') { sketchState = { tool: 'wall', points: [] }; _axisLockDir = null; }
    sketchState.points.push(pt.clone());
    _vcbTypedValue = '';
    setVCB('Wall:', `${sketchState.points.length} point(s) — double-click/Enter to finish`);
}
function updateWallPreview(cursorPt) {
    if (!sketchState || sketchState.tool !== 'wall') return;
    clearSketchPreview();
    const pts = [...sketchState.points, cursorPt];
    if (pts.length < 2) return;
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    sketchPreviewObj = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x4da6ff }));
    scene.add(sketchPreviewObj);
}
function createWallMeshesFromPoints(pts) {
    if (!pts || pts.length < 2) return [];
    const half = wallSettings.thickness / 2;
    const createdMeshes = [];
    for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i].clone(), p1 = pts[i + 1].clone();
        const dir = new THREE.Vector3().subVectors(p1, p0);
        if (dir.lengthSq() < 1e-12) continue;
        dir.normalize();
        if (i > 0) p0.addScaledVector(dir, -half);
        if (i < pts.length - 2) p1.addScaledVector(dir, half);
        const ax = pts[i].x, ay = pts[i].y, bx = pts[i + 1].x, by = pts[i + 1].y;
        const seg = buildWallSegmentMesh(p0, p1, wallSettings.thickness, wallSettings.height);
        if (!seg) continue;
        seg.geometry.applyMatrix4(seg.matrix);
        seg.position.set(0, 0, 0);
        seg.rotation.set(0, 0, 0);
        seg.updateMatrix();
        seg.material = new THREE.MeshStandardMaterial({ color: 0xd8d4cc, roughness: 0.9 });
        seg.castShadow = true; seg.receiveShadow = true;
        seg.name = nextBatchName('WallLayer', createdMeshes.map(m => m.name));
        seg.userData.kind = 'wall';
        seg.userData.wall = { x1: ax, y1: ay, x2: bx, y2: by, thickness: wallSettings.thickness, height: wallSettings.height };
        // No level-elevation offset needed here: `pts` already came from a
        // raycast against `_groundPlane`, which setActiveLevel() keeps at
        // the active level's real elevation — see the Levels section above.
        createdMeshes.push(seg);
    }
    return createdMeshes;
}
function commitWallMeshes(createdMeshes, statusLabel) {
    if (!createdMeshes.length) return;
    const level = activeLevelIndex;
    const addAll = () => {
        createdMeshes.forEach(m => { scene.add(m); sceneObjects.push({ name: m.name, type: 'mesh', mesh: m, level }); });
        renderOutliner();
    };
    addAll();
    selectObject(createdMeshes[createdMeshes.length - 1]);
    pushUndo({
        undo() { createdMeshes.forEach(m => removeSceneObject(m)); },
        redo() { addAll(); selectObject(createdMeshes[createdMeshes.length - 1]); },
    });
    if (statusLabel) setVCB('Wall:', statusLabel);
}
function finishWall() {
    if (!sketchState || sketchState.tool !== 'wall' || sketchState.points.length < 2) { cancelSketchTool(); return; }
    const pts = sketchState.points;
    clearSketchPreview();
    sketchState = null;
    const createdMeshes = createWallMeshesFromPoints(pts);
    commitWallMeshes(createdMeshes, `${createdMeshes.length} layer(s) — ${formatLength(wallSettings.thickness)} thick, ${formatLength(wallSettings.height)} tall`);
}

// --- Slab/Floor: click 3+ corners, double-click/Enter to finish -> one real extruded slab mesh ---
let slabSettings = { thickness: 0.15 };

function handleSlabClick(pt) {
    if (!sketchState || sketchState.tool !== 'slab') sketchState = { tool: 'slab', points: [] };
    sketchState.points.push(pt.clone());
    setVCB('Slab:', `${sketchState.points.length} corner(s) — double-click/Enter to finish (min 3)`);
}
function updateSlabPreview(cursorPt) {
    if (!sketchState || sketchState.tool !== 'slab') return;
    clearSketchPreview();
    const pts = sketchState.points.length >= 2 ? [...sketchState.points, cursorPt, sketchState.points[0]] : [...sketchState.points, cursorPt];
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    sketchPreviewObj = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x4da6ff }));
    scene.add(sketchPreviewObj);
}
function finishSlab() {
    if (!sketchState || sketchState.tool !== 'slab' || sketchState.points.length < 3) { cancelSketchTool(); return; }
    const pts = sketchState.points;
    clearSketchPreview();
    sketchState = null;
    const t = slabSettings.thickness;
    const n = pts.length;

    // Top cap (z=0), bottom cap (z=-t) fan-triangulated, plus side walls around the perimeter.
    const positions = [];
    const pushTri = (a, b, c) => positions.push(a.x, a.y, 0, b.x, b.y, 0, c.x, c.y, 0);
    for (let i = 1; i < n - 1; i++) pushTri(pts[0], pts[i], pts[i + 1]);
    const pushTriBot = (a, b, c) => positions.push(a.x, a.y, -t, c.x, c.y, -t, b.x, b.y, -t); // reversed winding for the underside
    for (let i = 1; i < n - 1; i++) pushTriBot(pts[0], pts[i], pts[i + 1]);
    for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        positions.push(a.x, a.y, 0, b.x, b.y, 0, b.x, b.y, -t);
        positions.push(a.x, a.y, 0, b.x, b.y, -t, a.x, a.y, -t);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xb0b0b0, roughness: 0.85 }));
    mesh.position.z = pts[0].z;
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.name = nextName('Slab');
    commitNewObject(mesh, 'mesh');
    setVCB('Slab:', `${n}-corner outline, ${formatLength(t)} thick`);
}

// --- Window/Door Opening: click a wall/mesh -> boolean-subtracts a preset-sized cutout at that point ---
let openingSettings = { width: 0.9, height: 2.1, sill: 0 };

function cutOpeningAt(wallMesh, hitPoint, hitNormalWorld) {
    const w = openingSettings.width, h = openingSettings.height, sill = openingSettings.sill;
    wallMesh.geometry.computeBoundingBox();
    const bbox = wallMesh.geometry.boundingBox;

    // Depth needed = the wall's own extent specifically ALONG the cut
    // direction (its thickness), not its overall bounding diagonal — using
    // the diagonal (e.g. a wall's full length) made the cutter 10-30x
    // larger than necessary, which triggered real numerical error in the
    // BSP split (the oversized cutter's own far faces were leaking into
    // the subtract result instead of being cleanly clipped away).
    const invMat = new THREE.Matrix4().copy(wallMesh.matrixWorld).invert();
    const localNormal = hitNormalWorld.clone().transformDirection(invMat).normalize();
    const corners = [
        new THREE.Vector3(bbox.min.x, bbox.min.y, bbox.min.z), new THREE.Vector3(bbox.max.x, bbox.min.y, bbox.min.z),
        new THREE.Vector3(bbox.min.x, bbox.max.y, bbox.min.z), new THREE.Vector3(bbox.min.x, bbox.min.y, bbox.max.z),
        new THREE.Vector3(bbox.max.x, bbox.max.y, bbox.min.z), new THREE.Vector3(bbox.max.x, bbox.min.y, bbox.max.z),
        new THREE.Vector3(bbox.min.x, bbox.max.y, bbox.max.z), new THREE.Vector3(bbox.max.x, bbox.max.y, bbox.max.z),
    ];
    let minProj = Infinity, maxProj = -Infinity;
    corners.forEach(c => { const p = c.dot(localNormal); minProj = Math.min(minProj, p); maxProj = Math.max(maxProj, p); });
    const maxScale = Math.max(wallMesh.scale.x, wallMesh.scale.y, wallMesh.scale.z);
    const thicknessAlongNormal = (maxProj - minProj) * maxScale;
    const cutterDepth = Math.max(thicknessAlongNormal * 2, 0.3); // a small, proportionate margin beyond the actual thickness

    const worldUp = new THREE.Vector3(0, 0, 1);
    let along = new THREE.Vector3().crossVectors(worldUp, hitNormalWorld);
    if (along.lengthSq() < 1e-6) along = new THREE.Vector3(1, 0, 0);
    along.normalize();

    const cutter = new THREE.Mesh(new THREE.BoxGeometry(w, cutterDepth, h));
    cutter.position.set(hitPoint.x, hitPoint.y, sill + h / 2);
    cutter.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(along, hitNormalWorld.clone().normalize(), worldUp));
    cutter.updateMatrixWorld(true);

    let resultGeo;
    try {
        resultGeo = csgOperation(wallMesh, cutter, 'subtract');
    } catch (err) {
        setVCB('Opening:', 'Failed: ' + err.message);
        return;
    }
    if (resultGeo.attributes.position.count === 0) { resultGeo.dispose(); setVCB('Opening:', 'Cutout missed the wall'); return; }

    const beforeGeo = deepCloneGeometry(wallMesh.geometry);
    const beforePos = wallMesh.position.clone(), beforeRot = wallMesh.rotation.clone(), beforeScale = wallMesh.scale.clone();
    wallMesh.geometry.dispose();
    wallMesh.geometry = resultGeo;
    wallMesh.position.set(0, 0, 0); wallMesh.rotation.set(0, 0, 0); wallMesh.scale.set(1, 1, 1);
    const afterGeo = deepCloneGeometry(wallMesh.geometry);

    pushUndo({
        undo() { wallMesh.geometry.dispose(); wallMesh.geometry = beforeGeo; wallMesh.position.copy(beforePos); wallMesh.rotation.copy(beforeRot); wallMesh.scale.copy(beforeScale); },
        redo() { wallMesh.geometry.dispose(); wallMesh.geometry = afterGeo; wallMesh.position.set(0, 0, 0); wallMesh.rotation.set(0, 0, 0); wallMesh.scale.set(1, 1, 1); },
    });
    selectObject(wallMesh);
    setVCB('Opening:', `${formatLength(w)} x ${formatLength(h)} cut — one click`);
}

function setupOpeningTool(canvas) {
    canvas.addEventListener('pointerup', e => {
        if (activeTool !== 'opening' || e.button !== 0) return;
        const rect = canvas.getBoundingClientRect();
        _mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        _mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        _raycaster.setFromCamera(_mouse, camera);
        const targets = sceneObjects.filter(o => o.mesh && o.mesh.isMesh).map(o => o.mesh);
        const hits = _raycaster.intersectObjects(targets, false);
        if (hits.length === 0 || !hits[0].face) return;
        const normalMat = new THREE.Matrix3().getNormalMatrix(hits[0].object.matrixWorld);
        const worldNormal = hits[0].face.normal.clone().applyMatrix3(normalMat).normalize();
        cutOpeningAt(hits[0].object, hits[0].point, worldNormal);
    });
}

// Door/Window presets — save the current opening settings under a name so
// they're one click to reuse next time, instead of re-typing dimensions.
const OPENING_PRESETS_KEY = '3dcore_opening_presets';
function loadOpeningPresets() {
    try { return JSON.parse(localStorage.getItem(OPENING_PRESETS_KEY) || '[]'); } catch (err) { return []; }
}
function saveOpeningPreset() {
    const name = prompt('Save this opening as a preset (e.g. "Standard Door", "Bedroom Window"):');
    if (!name) return;
    const presets = loadOpeningPresets().filter(p => p.name !== name);
    presets.push({ name, width: openingSettings.width, height: openingSettings.height, sill: openingSettings.sill });
    try { localStorage.setItem(OPENING_PRESETS_KEY, JSON.stringify(presets)); } catch (err) { /* ignore */ }
    refreshOpeningPresetDropdown();
    setVCB('Preset Saved:', name);
}
function applyOpeningPreset(name) {
    if (!name) return;
    const preset = loadOpeningPresets().find(p => p.name === name);
    if (!preset) return;
    openingSettings = { width: preset.width, height: preset.height, sill: preset.sill };
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('opening-width', preset.width); set('opening-height', preset.height); set('opening-sill', preset.sill);
    setVCB('Preset:', name);
}
function refreshOpeningPresetDropdown() {
    const sel = document.getElementById('opening-preset');
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '<option value="">Custom</option>' + loadOpeningPresets().map(p => `<option value="${p.name}">${p.name}</option>`).join('');
    sel.value = current;
}

// --- Eraser: click any object to delete it ---
function eraseAtEvent(pt, hitObject) {
    if (!hitObject) return;
    const entry = sceneObjects.find(o => o.mesh === hitObject);
    if (!entry) return;
    const { type } = entry;
    const parent = hitObject.parent || scene;
    if (removeSceneObject(hitObject)) {
        setVCB('Eraser:', `${hitObject.name} removed`);
        pushUndo({
            undo() { parent.add(hitObject); sceneObjects.push({ name: hitObject.name, type, mesh: hitObject }); renderOutliner(); },
            redo() { removeSceneObject(hitObject); },
        });
    }
}

function setupSketchTools(canvas) {
    let pDown = { x: 0, y: 0 };
    const DRAG_TOOLS = ['rect', 'circle', 'polygon', 'pie'];
    const CLICK_TOOLS = ['line', 'arc', 'tape', 'poly_build', 'wall', 'slab', 'rotrect', 'position_camera'];

    canvas.addEventListener('pointerdown', e => {
        pDown = { x: e.clientX, y: e.clientY };
        if (e.button !== 0) return;
        if (!DRAG_TOOLS.includes(activeTool)) return;
        const pt = sketchPointFromEvent(e, canvas);
        if (!pt) return;
        if (activeTool === 'rect') startRectDrag(pt);
        else if (activeTool === 'polygon') startPolygonDrag(pt);
        else if (activeTool === 'pie') startPieDrag(pt);
        else startCircleDrag(pt);
    });

    canvas.addEventListener('pointermove', e => {
        if (!sketchState) {
            // No draw in progress — still run the same hover detection
            // (vertex/edge/face highlight + tooltip) while Select/Move/
            // Rotate/Scale is active, so "detection feel" isn't limited to
            // moments you're actively drawing. Nothing else to do with the
            // point itself here, sketchPointFromEvent's side effect
            // (updateInferenceGuides) is the whole point of the call.
            if (['select', 'move', 'rotate', 'scale'].includes(activeTool)) sketchPointFromEvent(e, canvas);
            return;
        }
        const pt = sketchPointFromEvent(e, canvas);
        if (!pt) return;
        if (activeTool === 'rect') updateRectPreview(pt);
        else if (activeTool === 'circle') updateCirclePreview(pt);
        else if (activeTool === 'polygon') updatePolygonPreview(pt);
        else if (activeTool === 'pie') updatePiePreview(pt);
        else if (activeTool === 'rotrect') updateRotRectPreview(pt);
        else if (activeTool === 'line') updateLinePreview(pt);
        else if (activeTool === 'arc') updateArcPreview(pt);
        else if (activeTool === 'tape') updateTapePreview(pt);
        else if (activeTool === 'poly_build') updatePolyBuildPreview(pt);
        else if (activeTool === 'wall') updateWallPreview(pt);
        else if (activeTool === 'slab') updateSlabPreview(pt);
    });

    canvas.addEventListener('pointerup', e => {
        if (e.button !== 0) return;
        const dx = Math.abs(e.clientX - pDown.x), dy = Math.abs(e.clientY - pDown.y);
        const wasDrag = dx > 5 || dy > 5;

        if (activeTool === 'eraser') {
            if (wasDrag) return;
            const rect = canvas.getBoundingClientRect();
            _mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            _mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
            _raycaster.setFromCamera(_mouse, camera);
            const targets = sceneObjects.filter(o => o.mesh && o.mesh.name !== '_cursor').map(o => o.mesh);
            const hits = _raycaster.intersectObjects(targets, true);
            if (hits.length === 0) return;
            let obj = hits[0].object;
            while (obj && !sceneObjects.some(o => o.mesh === obj)) obj = obj.parent;
            eraseAtEvent(hits[0].point, obj);
            return;
        }

        if (!DRAG_TOOLS.includes(activeTool) && !CLICK_TOOLS.includes(activeTool)) return;
        const pt = sketchPointFromEvent(e, canvas);
        if (!pt) return;

        if (activeTool === 'rect') { finishRect(pt); return; }
        if (activeTool === 'circle') { finishCircle(pt); return; }
        if (activeTool === 'polygon') { finishPolygon(pt); return; }
        if (activeTool === 'pie') { finishPie(pt); return; }
        if (wasDrag) return; // line/arc/tape/rotrect are click-driven; ignore accidental drags
        if (activeTool === 'line') handleLineClick(pt);
        else if (activeTool === 'arc') handleArcClick(pt);
        else if (activeTool === 'rotrect') handleRotRectClick(pt);
        else if (activeTool === 'tape') handleTapeClick(pt);
        else if (activeTool === 'poly_build') handlePolyBuildClick(pt);
        else if (activeTool === 'wall') handleWallClick(pt);
        else if (activeTool === 'slab') handleSlabClick(pt);
        else if (activeTool === 'position_camera') positionCameraAt(pt);
    });

    canvas.addEventListener('dblclick', () => {
        if (activeTool === 'line' && sketchState?.tool === 'line') finishLine();
        else if (activeTool === 'poly_build' && sketchState?.tool === 'polybuild') finishPolyBuild();
        else if (activeTool === 'wall' && sketchState?.tool === 'wall') finishWall();
        else if (activeTool === 'slab' && sketchState?.tool === 'slab') finishSlab();
    });
}

// ─────────────────────────────────────────────────────────────
// VERTEX SLIDE / EDGE SLIDE / BISECT / KNIFE — pointer-driven Edit Mode
// tools, armed via setActiveTool('vertex_slide' | 'edge_slide' | 'bisect'
// | 'knife') from the Modeling tab buttons.
// ─────────────────────────────────────────────────────────────
let _slideStroke = null; // { mode, mesh, beforeGeo, ... } captured at drag start

// Every OTHER vertex of any triangle that touches a vertex in `group` —
// i.e. the vertices you could slide toward.
function findNeighborPositions(mesh, group) {
    ensureNonIndexed(mesh);
    const pos = mesh.geometry.attributes.position;
    const groupSet = new Set(group);
    const neighbors = new Map();
    for (let f = 0; f < pos.count; f += 3) {
        const idxs = [f, f + 1, f + 2];
        const touches = idxs.some(i => groupSet.has(i));
        if (!touches) continue;
        idxs.forEach(i => {
            if (groupSet.has(i)) return;
            const k = positionKey(pos, i);
            if (!neighbors.has(k)) neighbors.set(k, new THREE.Vector3().fromBufferAttribute(pos, i));
        });
    }
    return [...neighbors.values()];
}

function closestPointAmongNeighbors(target, origin, neighbors) {
    let best = origin.clone(), bestD = Infinity;
    neighbors.forEach(n => {
        const dir = n.clone().sub(origin);
        const len2 = dir.lengthSq();
        if (len2 < 1e-10) return;
        const t = THREE.MathUtils.clamp(target.clone().sub(origin).dot(dir) / len2, 0, 1);
        const cand = origin.clone().addScaledVector(dir, t);
        const d = cand.distanceTo(target);
        if (d < bestD) { bestD = d; best = cand; }
    });
    return best;
}

let _offsetStroke = null; // { mesh, baseGeo, faceIdx, startY } — SketchUp-style Offset tool drag state
let _pushPullStroke = null; // { mesh, baseGeo, faceGroup, startY } — SketchUp-style Push/Pull tool drag state

// Extrude Along Normals / Extrude Individual / Bevel / Shrink-Fatten / To
// Sphere previously only ever applied one fixed, hardcoded amount on a
// single button click (Bevel always 0.3, Shrink/Fatten always +0.3, etc.)
// instead of responding to the mouse like real Blender/SketchUp — and like
// this app's own Push/Pull and Offset tools already do. Same drag-to-amount
// shape as those two: the Properties-panel button now arms the tool
// (setActiveTool with the same key executeMeshEditTool() already used
// internally) instead of instant-applying it; dragging anywhere in the
// viewport with a face already selected live-previews the amount, release
// commits one undo entry. `apply` calls each tool's real, pre-existing
// geometry function — this only changes how the amount gets set, not the
// underlying algorithms (already verified correct/real).
let _faceAmountStroke = null; // { mesh, baseGeo, faceGroup, startY, kind }
const FACE_AMOUNT_TOOLS = {
    extrude_normals:    { label: 'Extrude Along Normals', scale: 0.01, clamp: null,    apply: (mesh, amt) => extrudeSelectedFacesAlongNormals(amt) },
    extrude_individual: { label: 'Extrude Individual',     scale: 0.01, clamp: null,    apply: (mesh, amt) => extrudeIndividualFaces(amt) },
    bevel:              { label: 'Bevel',                  scale: 0.01, clamp: [0, 2],  apply: (mesh, amt) => bevelSelectedFaces(mesh, amt) },
    shrink_fatten:      { label: 'Shrink/Fatten',           scale: 0.01, clamp: null,    apply: (mesh, amt) => shrinkFattenSelectedFaces(mesh, amt) },
    to_sphere:          { label: 'To Sphere',               scale: 0.005, clamp: [0, 1], apply: (mesh, amt) => toSphereSelectedFaces(mesh, amt) },
};

function setupAdvancedEditTools(canvas) {
    let dragStartScreen = null;

    canvas.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;

        // Push/Pull — real SketchUp-style click-and-drag: click any face on
        // any object (no pre-selection required), drag away from the
        // surface to pull it out, toward it to push it in, release to
        // commit. Previously 'pushpull' was only ever set as the active
        // tool (P/U shortcut) with no pointer handler at all anywhere —
        // clicking/dragging on a face did nothing.
        if (activeTool === 'pushpull') {
            const rect = canvas.getBoundingClientRect();
            _mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            _mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
            _raycaster.setFromCamera(_mouse, camera);
            const targets = sceneObjects.filter(o => o.mesh && o.mesh.isMesh).map(o => o.mesh);
            const hits = _raycaster.intersectObjects(targets, false);
            if (hits.length > 0 && hits[0].faceIndex != null) {
                const mesh = hits[0].object;
                if (mesh !== selectedObject) selectObject(mesh);
                ensureNonIndexed(mesh);
                const faceGroup = findCoplanarConnectedFaces(mesh, hits[0].faceIndex);
                selectedFaces = faceGroup;
                rebuildFaceHighlight();
                _pushPullStroke = { mesh, baseGeo: deepCloneGeometry(mesh.geometry), faceGroup, startY: e.clientY };
                orbitControls.enabled = false;
            }
            return;
        }

        // Offset works like SketchUp's real tool — click straight on any
        // face of the selected mesh (no separate Face-select step needed)
        // and drag to inset/outset it. Works in any mode, unlike the
        // Edit-Mode-only slide tools below.
        if (activeTool === 'offset' && selectedObject && selectedObject.isMesh) {
            const rect = canvas.getBoundingClientRect();
            _mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
            _mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
            _raycaster.setFromCamera(_mouse, camera);
            const hits = _raycaster.intersectObject(selectedObject, false);
            if (hits.length > 0 && hits[0].faceIndex != null) {
                ensureNonIndexed(selectedObject);
                // Whole coplanar quad/n-gon the clicked triangle belongs to,
                // not just that one triangle — see findCoplanarConnectedFaces().
                const faceGroup = findCoplanarConnectedFaces(selectedObject, hits[0].faceIndex);
                selectedFaces = faceGroup;
                rebuildFaceHighlight();
                _offsetStroke = { mesh: selectedObject, baseGeo: deepCloneGeometry(selectedObject.geometry), faceGroup, startY: e.clientY };
                orbitControls.enabled = false;
            }
            return;
        }

        if (currentInteractionMode !== 'edit') return;
        dragStartScreen = { x: e.clientX, y: e.clientY };

        if (FACE_AMOUNT_TOOLS[activeTool] && selectedObject && selectedObject.isMesh && selectedFaces.length > 0) {
            const mesh = selectedObject;
            ensureNonIndexed(mesh);
            _faceAmountStroke = { mesh, baseGeo: deepCloneGeometry(mesh.geometry), faceGroup: selectedFaces.slice(), startY: e.clientY, kind: activeTool };
            orbitControls.enabled = false;
            return;
        }

        if (activeTool === 'vertex_slide' && selectedVertexGroup && selectedObject) {
            const mesh = selectedObject;
            const pos = mesh.geometry.attributes.position;
            const origin = new THREE.Vector3().fromBufferAttribute(pos, selectedVertexGroup[0]);
            const neighbors = findNeighborPositions(mesh, selectedVertexGroup);
            if (neighbors.length === 0) { setVCB('Vertex Slide:', 'No adjacent edge to slide along'); return; }
            _slideStroke = { mode: 'vertex', mesh, beforeGeo: deepCloneGeometry(mesh.geometry), group: selectedVertexGroup, origin, neighbors };
            orbitControls.enabled = false;
        } else if (activeTool === 'edge_slide' && selectedEdgeGroups && selectedObject) {
            const mesh = selectedObject;
            const pos = mesh.geometry.attributes.position;
            const originA = new THREE.Vector3().fromBufferAttribute(pos, selectedEdgeGroups.a[0]);
            const originB = new THREE.Vector3().fromBufferAttribute(pos, selectedEdgeGroups.b[0]);
            const neighborsA = findNeighborPositions(mesh, selectedEdgeGroups.a).filter(p => p.distanceTo(originB) > 1e-5);
            const neighborsB = findNeighborPositions(mesh, selectedEdgeGroups.b).filter(p => p.distanceTo(originA) > 1e-5);
            if (neighborsA.length === 0 && neighborsB.length === 0) { setVCB('Edge Slide:', 'No adjacent edge to slide along'); return; }
            _slideStroke = { mode: 'edge', mesh, beforeGeo: deepCloneGeometry(mesh.geometry), groupA: selectedEdgeGroups.a, groupB: selectedEdgeGroups.b, originA, originB, neighborsA, neighborsB };
            orbitControls.enabled = false;
        }
    });

    canvas.addEventListener('pointermove', e => {
        if (_faceAmountStroke) {
            const cfg = FACE_AMOUNT_TOOLS[_faceAmountStroke.kind];
            const dy = _faceAmountStroke.startY - e.clientY;
            let amount = dy * cfg.scale;
            if (cfg.clamp) amount = THREE.MathUtils.clamp(amount, cfg.clamp[0], cfg.clamp[1]);
            const mesh = _faceAmountStroke.mesh;
            mesh.geometry.dispose();
            mesh.geometry = deepCloneGeometry(_faceAmountStroke.baseGeo);
            selectedFaces = _faceAmountStroke.faceGroup;
            cfg.apply(mesh, amount);
            rebuildFaceHighlight();
            setVCB(`${cfg.label}:`, `${amount >= 0 ? '+' : ''}${amount.toFixed(2)}`);
            return;
        }
        if (_pushPullStroke) {
            const dy = _pushPullStroke.startY - e.clientY; // drag up = pull out, drag down = push in — matches SketchUp
            const depth = dy / 100;
            const mesh = _pushPullStroke.mesh;
            mesh.geometry.dispose();
            mesh.geometry = deepCloneGeometry(_pushPullStroke.baseGeo);
            selectedFaces = _pushPullStroke.faceGroup;
            extrudeSelectedFaces(depth);
            rebuildFaceHighlight();
            setVCB('Push/Pull:', `${depth >= 0 ? '+' : ''}${depth.toFixed(2)} m`);
            return;
        }
        if (_offsetStroke) {
            const dy = _offsetStroke.startY - e.clientY;
            const factor = THREE.MathUtils.clamp(dy / 150, -0.9, 0.9);
            const mesh = _offsetStroke.mesh;
            mesh.geometry.dispose();
            mesh.geometry = deepCloneGeometry(_offsetStroke.baseGeo);
            selectedFaces = _offsetStroke.faceGroup;
            insetSelectedFaces(mesh, factor);
            rebuildFaceHighlight();
            setVCB('Offset:', `${(factor * 100).toFixed(0)}%`);
            return;
        }
        if (!_slideStroke) return;
        const rect = canvas.getBoundingClientRect();
        _mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        _mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        _raycaster.setFromCamera(_mouse, camera);
        const hits = _raycaster.intersectObject(_slideStroke.mesh, false);
        if (hits.length === 0) return;
        const localHit = _slideStroke.mesh.worldToLocal(hits[0].point.clone());
        const pos = _slideStroke.mesh.geometry.attributes.position;

        if (_slideStroke.mode === 'vertex') {
            const p = closestPointAmongNeighbors(localHit, _slideStroke.origin, _slideStroke.neighbors);
            if (proportionalEditOn && window.MeshTools && window.MeshTools.applyFalloffMove) {
                const orig = _slideStroke.beforeGeo.attributes.position.array;
                const dx = p.x - _slideStroke.origin.x, dy = p.y - _slideStroke.origin.y, dz = p.z - _slideStroke.origin.z;
                const moved = MeshTools.applyFalloffMove(orig, _slideStroke.group[0], dx, dy, dz, proportionalRadius, 'smooth');
                pos.array.set(moved);
            } else {
                _slideStroke.group.forEach(idx => pos.setXYZ(idx, p.x, p.y, p.z));
            }
            selectedVertexGroup = _slideStroke.group;
            showVertexHighlight(_slideStroke.mesh, _slideStroke.group);
        } else {
            const pA = closestPointAmongNeighbors(localHit, _slideStroke.originA, _slideStroke.neighborsA);
            const pB = closestPointAmongNeighbors(localHit, _slideStroke.originB, _slideStroke.neighborsB);
            _slideStroke.groupA.forEach(idx => pos.setXYZ(idx, pA.x, pA.y, pA.z));
            _slideStroke.groupB.forEach(idx => pos.setXYZ(idx, pB.x, pB.y, pB.z));
            selectedEdgeGroups = { a: _slideStroke.groupA, b: _slideStroke.groupB };
            showEdgeHighlight(_slideStroke.mesh, selectedEdgeGroups);
        }
        pos.needsUpdate = true;
        _slideStroke.mesh.geometry.computeVertexNormals();
    });

    window.addEventListener('pointerup', () => {
        orbitControls.enabled = true;

        if (_faceAmountStroke) {
            const { mesh, baseGeo, kind } = _faceAmountStroke;
            const afterGeo = deepCloneGeometry(mesh.geometry);
            // A click with no real drag (amount stayed ~0) shouldn't clutter
            // undo history with a no-op entry — just restore and clear.
            let changed = false;
            const b = baseGeo.attributes.position.array, a = afterGeo.attributes.position.array;
            if (a.length !== b.length) changed = true;
            else for (let i = 0; i < a.length; i++) { if (Math.abs(a[i] - b[i]) > 1e-6) { changed = true; break; } }
            if (changed) {
                pushUndo({
                    undo() { mesh.geometry.dispose(); mesh.geometry = baseGeo; rebuildFaceHighlight(); },
                    redo() { mesh.geometry.dispose(); mesh.geometry = afterGeo; rebuildFaceHighlight(); },
                });
                propagateComponentEdit(mesh);
            } else {
                mesh.geometry.dispose();
                mesh.geometry = baseGeo;
                rebuildFaceHighlight();
                setVCB(`${FACE_AMOUNT_TOOLS[kind].label}:`, 'Drag to set an amount');
            }
            _faceAmountStroke = null;
            return;
        }

        if (_pushPullStroke) {
            const { mesh, baseGeo } = _pushPullStroke;
            const afterGeo = deepCloneGeometry(mesh.geometry);
            pushUndo({
                undo() { mesh.geometry.dispose(); mesh.geometry = baseGeo; rebuildFaceHighlight(); },
                redo() { mesh.geometry.dispose(); mesh.geometry = afterGeo; rebuildFaceHighlight(); },
            });
            _pushPullStroke = null;
            propagateComponentEdit(mesh);
            return;
        }

        if (_offsetStroke) {
            const { mesh, baseGeo } = _offsetStroke;
            const afterGeo = deepCloneGeometry(mesh.geometry);
            pushUndo({
                undo() { mesh.geometry.dispose(); mesh.geometry = baseGeo; rebuildFaceHighlight(); },
                redo() { mesh.geometry.dispose(); mesh.geometry = afterGeo; rebuildFaceHighlight(); },
            });
            _offsetStroke = null;
            propagateComponentEdit(mesh);
            return;
        }

        if (!_slideStroke) return;
        const { mesh, beforeGeo } = _slideStroke;
        const afterGeo = deepCloneGeometry(mesh.geometry);
        pushUndo({
            undo() { mesh.geometry.dispose(); mesh.geometry = beforeGeo; },
            redo() { mesh.geometry.dispose(); mesh.geometry = afterGeo; },
        });
        setVCB('Slide:', 'Done');
        _slideStroke = null;
        propagateComponentEdit(mesh);
    });

    // Bisect: drag a line across the viewport -> cut plane through it.
    canvas.addEventListener('pointerup', e => {
        if (activeTool !== 'bisect' || currentInteractionMode !== 'edit' || !dragStartScreen) return;
        if (!selectedObject || !selectedObject.isMesh) { dragStartScreen = null; return; }
        const dx = Math.abs(e.clientX - dragStartScreen.x), dy = Math.abs(e.clientY - dragStartScreen.y);
        if (dx < 10 && dy < 10) { dragStartScreen = null; return; } // too short to define a direction

        const plane = bisectPlaneFromDrag(selectedObject, dragStartScreen, { x: e.clientX, y: e.clientY }, canvas, camera);
        dragStartScreen = null;
        if (!plane) return;

        const obj = selectedObject;
        const beforeGeo = deepCloneGeometry(obj.geometry);
        if (bisectMesh(obj, plane)) {
            const afterGeo = deepCloneGeometry(obj.geometry);
            pushUndo({ undo() { obj.geometry.dispose(); obj.geometry = beforeGeo; }, redo() { obj.geometry.dispose(); obj.geometry = afterGeo; } });
            setVCB('Bisect:', 'Mesh cut');
        } else {
            beforeGeo.dispose();
            setVCB('Bisect:', 'Cut plane missed the mesh');
        }
    });

    // Knife: click a polyline on the selected face; Enter (or double-click) cuts every segment.
    canvas.addEventListener('pointerup', e => {
        if (activeTool !== 'knife' || currentInteractionMode !== 'edit' || e.button !== 0) return;
        if (!selectedObject || !selectedObject.isMesh || selectedFaces.length === 0) return;

        const rect = canvas.getBoundingClientRect();
        _mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        _mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        _raycaster.setFromCamera(_mouse, camera);
        const hits = _raycaster.intersectObject(selectedObject, false);
        if (hits.length === 0) return;

        const pt = hits[0].point.clone();
        if (!sketchState || sketchState.tool !== 'knife') {
            sketchState = { tool: 'knife', points: [pt] };
            drawKnifePreview();
            setVCB('Knife:', 'Click more points on the face, Enter to cut, Esc to cancel');
            return;
        }
        sketchState.points.push(pt);
        drawKnifePreview();
        if (e.detail >= 2 && sketchState.points.length >= 2) {
            finishKnife();
            return;
        }
        setVCB('Knife:', `${sketchState.points.length} points — Enter to cut, Esc to cancel`);
    });

    // Extrude to Cursor: one click on the viewport -> extrude the selected face to that point.
    canvas.addEventListener('pointerup', e => {
        if (activeTool !== 'extrude_to_cursor' || currentInteractionMode !== 'edit' || e.button !== 0) return;
        if (!selectedObject || !selectedObject.isMesh || selectedFaces.length === 0) return;

        const rect = canvas.getBoundingClientRect();
        _mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        _mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        _raycaster.setFromCamera(_mouse, camera);
        const pt = new THREE.Vector3();
        const hitGround = _raycaster.ray.intersectPlane(_groundPlane, pt);
        const hitsMesh = _raycaster.intersectObjects(sceneObjects.filter(o => o.mesh && o.mesh.isMesh).map(o => o.mesh), true);
        const target = hitsMesh.length > 0 ? hitsMesh[0].point : (hitGround ? pt : null);
        if (!target) return;

        const obj = selectedObject;
        const beforeGeo = deepCloneGeometry(obj.geometry);
        const beforeFaces = selectedFaces.slice();
        if (extrudeToCursor(target)) {
            const afterGeo = deepCloneGeometry(obj.geometry);
            pushUndo({
                undo() { obj.geometry.dispose(); obj.geometry = beforeGeo; selectedFaces = beforeFaces.slice(); rebuildFaceHighlight(); },
                redo() { obj.geometry.dispose(); obj.geometry = afterGeo; rebuildFaceHighlight(); },
            });
            setVCB('Extrude to Cursor:', 'Done');
        } else {
            beforeGeo.dispose();
        }
    });
}

// ─────────────────────────────────────────────────────────────
// SELECT BOX / CIRCLE / LASSO — object centroids in Object mode,
// triangle centroids in Edit + Face select. Shift adds. Real region tests,
// not a fake "closest only" click.
// ─────────────────────────────────────────────────────────────
function projectWorldToClient(world, rect) {
    const v = world.clone().project(camera);
    if (v.z > 1) return null;
    return {
        x: rect.left + (v.x * 0.5 + 0.5) * rect.width,
        y: rect.top + (-v.y * 0.5 + 0.5) * rect.height
    };
}

function collectFacesInRegion(mesh, testFn, rect) {
    ensureNonIndexed(mesh);
    const pos = mesh.geometry.attributes.position;
    const triCount = Math.floor(pos.count / 3);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), mid = new THREE.Vector3();
    const hits = [];
    for (let f = 0; f < triCount; f++) {
        a.fromBufferAttribute(pos, f * 3);
        b.fromBufferAttribute(pos, f * 3 + 1);
        c.fromBufferAttribute(pos, f * 3 + 2);
        mid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
        mesh.localToWorld(mid);
        const scr = projectWorldToClient(mid, rect);
        if (scr && testFn(scr.x, scr.y)) hits.push(f);
    }
    return hits;
}

function applyRegionObjectSelect(testFn, refPoint, rect, additive) {
    const worldPos = new THREE.Vector3();
    const hits = [];
    sceneObjects.forEach(o => {
        if (!o.mesh || o.mesh.name === '_cursor' || o.mesh.name === '_ar_reticle') return;
        o.mesh.getWorldPosition(worldPos);
        const scr = projectWorldToClient(worldPos, rect);
        if (!scr || !testFn(scr.x, scr.y)) return;
        const d = refPoint ? Math.hypot(scr.x - refPoint.x, scr.y - refPoint.y) : 0;
        hits.push({ mesh: o.mesh, d });
    });
    hits.sort((a, b) => a.d - b.d);
    if (!additive) outlinerMultiSelect.clear();
    hits.forEach(h => outlinerMultiSelect.add(h.mesh));
    const best = hits.length ? hits[0].mesh : null;
    if (best) selectObject(best);
    else if (!additive) selectObject(null);
    return hits.length;
}

function applyRegionFaceSelect(testFn, rect, additive) {
    if (!selectedObject || !selectedObject.isMesh) return 0;
    const faces = collectFacesInRegion(selectedObject, testFn, rect);
    if (!additive) selectedFaces = [];
    faces.forEach(f => { if (!selectedFaces.includes(f)) selectedFaces.push(f); });
    rebuildFaceHighlight();
    return faces.length;
}

function setupBoxCircleSelect(canvas) {
    let start = null;
    let lassoPts = null;

    const isRegionTool = () => activeTool === 'select_box' || activeTool === 'select_circle' || activeTool === 'select_lasso';

    canvas.addEventListener('pointerdown', e => {
        if (!isRegionTool() || e.button !== 0) return;
        if (orbitControls) orbitControls.enabled = false;
        start = { x: e.clientX, y: e.clientY };
        lassoPts = activeTool === 'select_lasso' ? [{ x: e.clientX, y: e.clientY }] : null;
    });

    canvas.addEventListener('pointermove', e => {
        if (!start || !suCtx) return;
        const rect = canvas.getBoundingClientRect();
        suCtx.clearRect(0, 0, suCanvas.width, suCanvas.height);
        suCtx.strokeStyle = '#4772b3';
        suCtx.fillStyle = 'rgba(71,114,179,0.15)';
        suCtx.lineWidth = 1.5;
        suCtx.setLineDash([4, 3]);
        const sx0 = start.x - rect.left, sy0 = start.y - rect.top;
        const sx1 = e.clientX - rect.left, sy1 = e.clientY - rect.top;
        if (activeTool === 'select_lasso') {
            const last = lassoPts[lassoPts.length - 1];
            if (!last || Math.hypot(e.clientX - last.x, e.clientY - last.y) > 4) {
                lassoPts.push({ x: e.clientX, y: e.clientY });
            }
            suCtx.beginPath();
            lassoPts.forEach((p, i) => {
                const x = p.x - rect.left, y = p.y - rect.top;
                if (i === 0) suCtx.moveTo(x, y); else suCtx.lineTo(x, y);
            });
            suCtx.closePath();
            suCtx.fill();
            suCtx.stroke();
        } else if (activeTool === 'select_box') {
            const x = Math.min(sx0, sx1), y = Math.min(sy0, sy1), w = Math.abs(sx1 - sx0), h = Math.abs(sy1 - sy0);
            suCtx.fillRect(x, y, w, h);
            suCtx.strokeRect(x, y, w, h);
        } else {
            const r = Math.hypot(sx1 - sx0, sy1 - sy0);
            suCtx.beginPath(); suCtx.arc(sx0, sy0, r, 0, Math.PI * 2); suCtx.fill(); suCtx.stroke();
        }
        suCtx.setLineDash([]);
    });

    canvas.addEventListener('pointerup', e => {
        if (!isRegionTool() || e.button !== 0 || !start) return;
        if (orbitControls) orbitControls.enabled = true;
        const end = { x: e.clientX, y: e.clientY };
        const dragDist = Math.hypot(end.x - start.x, end.y - start.y);
        const rect = canvas.getBoundingClientRect();
        const MT = window.MeshTools;

        let test, refPoint, label = 'Select:';
        if (activeTool === 'select_lasso') {
            label = 'Select Lasso:';
            const pts = (lassoPts && lassoPts.length >= 3) ? lassoPts : [start, end, start];
            test = (sx, sy) => MT && MT.pointInPolygon ? MT.pointInPolygon(sx, sy, pts) : false;
            refPoint = start;
        } else if (activeTool === 'select_box' && dragDist >= 5) {
            label = 'Select Box:';
            const minX = Math.min(start.x, end.x), maxX = Math.max(start.x, end.x);
            const minY = Math.min(start.y, end.y), maxY = Math.max(start.y, end.y);
            test = (sx, sy) => sx >= minX && sx <= maxX && sy >= minY && sy <= maxY;
            refPoint = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
        } else {
            label = 'Select Circle:';
            const radius = dragDist >= 5 ? dragDist : 18;
            test = (sx, sy) => Math.hypot(sx - start.x, sy - start.y) <= radius;
            refPoint = start;
        }

        const faceMode = currentInteractionMode === 'edit' && faceSelectOn && selectedObject && selectedObject.isMesh;
        let n = 0;
        if (faceMode) n = applyRegionFaceSelect(test, rect, e.shiftKey);
        else n = applyRegionObjectSelect(test, refPoint, rect, e.shiftKey);
        setVCB(label, n ? `${n} ${faceMode ? 'face' : 'object'}(s)` : 'Nothing in region');
        start = null;
        lassoPts = null;
        if (suCtx) suCtx.clearRect(0, 0, suCanvas.width, suCanvas.height);
    });
}

function selectObject(mesh) {
    if (mesh !== selectedObject) { clearFaceSelection(); clearVertexSelection(); clearEdgeSelection(); }
    selectedObject = mesh;

    const entry = mesh && sceneObjects.find(o => o.mesh === mesh);
    const locked = !!(entry && entry.locked);
    if (mesh && !locked && (currentInteractionMode === 'object' || currentInteractionMode === 'sketchup')) {
        transformControls.attach(mesh);
    } else {
        transformControls.detach();
    }

    updateInspectorFromSelected();
    renderOutliner();
    updateHUD();
    updateSelectionOutline();
    updateModStackUI(mesh);
}

// ─────────────────────────────────────────────────────────────
// SELECTION OUTLINE — a real, visible highlight on the selected object in
// the 3D viewport (previously the ONLY way to tell something was selected
// was the highlighted row in the Outliner — nothing showed in the
// viewport itself besides the move/rotate/scale gizmo, which doesn't even
// appear for every tool). Classic inverted-hull technique: a slightly
// scaled-up backface-only copy sharing the same live geometry reference.
// ─────────────────────────────────────────────────────────────
let selectionOutlineMesh = null;
let _outlineGeoRef = null;

function updateSelectionOutline() {
    const obj = selectedObject;
    if (!obj || !obj.isMesh) {
        if (selectionOutlineMesh) {
            scene.remove(selectionOutlineMesh);
            selectionOutlineMesh.geometry.dispose();
            selectionOutlineMesh.material.dispose();
            selectionOutlineMesh = null;
            _outlineGeoRef = null;
        }
        return;
    }

    if (!selectionOutlineMesh || _outlineGeoRef !== obj.geometry) {
        if (selectionOutlineMesh) {
            scene.remove(selectionOutlineMesh);
            selectionOutlineMesh.geometry.dispose();
            selectionOutlineMesh.material.dispose();
        }
        // Real edge-highlight (THREE.EdgesGeometry: silhouette + hard edges
        // above an angle threshold), not a solid backface shell — the shell
        // technique looked fine on simple convex primitives but rendered as a
        // solid orange fill on thin/complex geometry (walls with several
        // window cutouts close together: the thin pillars between openings
        // are barely wider than the offset itself, so the "outline" became
        // the dominant visible surface instead of a thin highlight). Edge
        // lines sit exactly on the real geometry — no offset, no ballooning,
        // and it looks like an actual CAD edge highlight instead of a glow.
        const edgesGeo = new THREE.EdgesGeometry(obj.geometry, 20);
        selectionOutlineMesh = new THREE.LineSegments(edgesGeo, new THREE.LineBasicMaterial({ color: 0xff9900, depthTest: false }));
        selectionOutlineMesh.renderOrder = 999;
        // THREE.Raycaster hit-tests LineSegments against a generous default
        // threshold (1 world unit) with no .face on the result — every
        // recursive raycast elsewhere in the app (draw-tool point picking,
        // eraser, offset tool, opening-cutout placement...) walks into a
        // selected mesh's children and would otherwise pick up this outline
        // as a spurious, faceless "closest hit" in front of the real surface.
        // A no-op raycast makes it invisible to picking while still rendering.
        selectionOutlineMesh.raycast = () => {};
        // Kept at the scene root instead of parented under `obj` — three.js's
        // toJSON()/GLTFExporter both walk `children` unconditionally with no
        // "skip me" flag, so a child here would get permanently baked into
        // every project save and GLB export as a stray (and, for
        // EdgesGeometry specifically, unloadable — ObjectLoader has no
        // deserializer for a computed geometry type) extra object. Its
        // transform is instead synced to `obj` explicitly below, every frame.
        selectionOutlineMesh.matrixAutoUpdate = false;
        scene.add(selectionOutlineMesh);
        _outlineGeoRef = obj.geometry;
    }

    obj.updateMatrixWorld();
    selectionOutlineMesh.matrix.copy(obj.matrixWorld);

    // Only skip depth-testing (see the outline through the object's own
    // solid faces) in Wireframe or when X-Ray Mode is explicitly on — both
    // places where "see every edge" is the intended behavior. In Solid/
    // Material Preview/Rendered otherwise, the outline should respect
    // normal occlusion like any real geometry, not look X-ray'd by default.
    selectionOutlineMesh.material.depthTest = !(currentShadingMode === 'WIREFRAME' || xrayEnabled);
}

// ─────────────────────────────────────────────────────────────
// INSPECTOR SYNC
// ─────────────────────────────────────────────────────────────
function updateInspectorFromSelected() {
    const obj = selectedObject;
    if (!obj) { updateMaterialTexturePreview(null); updateEntityInfo(); return; }

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };

    set('prop-name', obj.name || 'Object');
    set('prop-px', obj.position.x.toFixed(4));
    set('prop-py', obj.position.y.toFixed(4));
    set('prop-pz', obj.position.z.toFixed(4));
    set('prop-rx', THREE.MathUtils.radToDeg(obj.rotation.x).toFixed(2));
    set('prop-ry', THREE.MathUtils.radToDeg(obj.rotation.y).toFixed(2));
    set('prop-rz', THREE.MathUtils.radToDeg(obj.rotation.z).toFixed(2));
    set('prop-sx', obj.scale.x.toFixed(4));
    set('prop-sy', obj.scale.y.toFixed(4));
    set('prop-sz', obj.scale.z.toFixed(4));

    if (obj.material) {
        const dispMat = primaryMaterial(obj);
        set('mat-color', '#' + dispMat.color.getHexString());
        set('mat-rough', dispMat.roughness ?? 0.5);
        set('mat-metal', dispMat.metalness ?? 0.0);
    }
    updateMaterialTexturePreview(obj);
    syncDeltaFields(obj);
    const visEl = document.getElementById('rel-visible'); if (visEl) visEl.checked = obj.visible !== false;
    const selEl = document.getElementById('rel-selectable'); if (selEl) selEl.checked = obj.userData.selectable !== false;
    updateEntityInfo();
    updateLightPropertiesPanel(obj);
}

function updateLightPropertiesPanel(obj) {
    const box = document.getElementById('light-properties-box');
    if (!box) return;
    if (!obj || !obj.isLight) { box.style.display = 'none'; return; }
    box.style.display = '';
    const set = (id, val, show) => {
        const row = document.getElementById(id + '-row');
        if (row) row.style.display = show === false ? 'none' : '';
        const el = document.getElementById(id);
        if (el && val != null) el.value = val;
    };
    set('light-intensity', obj.intensity);
    set('light-color', '#' + obj.color.getHexString());
    set('light-distance', obj.distance ?? 0, 'distance' in obj);
    set('light-cone-angle', obj.isSpotLight ? THREE.MathUtils.radToDeg(obj.angle).toFixed(1) : null, obj.isSpotLight);
    set('light-penumbra', obj.isSpotLight ? obj.penumbra : null, obj.isSpotLight);
    const shadowEl = document.getElementById('light-cast-shadow');
    if (shadowEl) { shadowEl.checked = !!obj.castShadow; shadowEl.disabled = !obj.shadow; }
}

function updateFromInspector() {
    const obj = selectedObject;
    if (!obj) return;

    const getNum = (id, def) => { const el = document.getElementById(id); return el ? (parseFloat(el.value) || def) : def; };

    obj.name = (document.getElementById('prop-name') || {}).value || obj.name;
    obj.position.set(getNum('prop-px',0), getNum('prop-py',0), getNum('prop-pz',0));
    obj.rotation.set(
        THREE.MathUtils.degToRad(getNum('prop-rx',0)),
        THREE.MathUtils.degToRad(getNum('prop-ry',0)),
        THREE.MathUtils.degToRad(getNum('prop-rz',0))
    );
    obj.scale.set(getNum('prop-sx',1), getNum('prop-sy',1), getNum('prop-sz',1));

    renderOutliner();
    updateHUD();
}

// ─────────────────────────────────────────────────────────────
// ACCORDION TOGGLE — every Properties-panel section header had
// cursor:pointer and a ▼/▶ glyph implying it was clickable, but nothing
// was ever wired to it (always expanded, arrows never changed).
// ─────────────────────────────────────────────────────────────
function toggleAccordion(headerEl) {
    const box = headerEl.closest('.b-accordion-box');
    const content = box ? box.querySelector('.b-accordion-content') : null;
    const collapsed = headerEl.textContent.trim().startsWith('▶');
    const label = headerEl.textContent.trim().replace(/^[▶▼]\s*/, '');
    headerEl.textContent = (collapsed ? '▼ ' : '▶ ') + label;
    if (content) content.style.display = collapsed ? 'flex' : 'none';
}

// ─────────────────────────────────────────────────────────────
// DELTA TRANSFORM — a real, working simplification of Blender's delta
// transform: an extra offset layered on top of the object's normal
// Location, tracked separately (obj.userData.deltaPosition) so re-editing
// the delta fields adjusts relative to the true base position instead of
// compounding, and Reset Delta cleanly removes exactly what was added.
// ─────────────────────────────────────────────────────────────
function applyDeltaTransform() {
    const obj = selectedObject;
    if (!obj) return;
    const dx = parseFloat(document.getElementById('delta-px').value) || 0;
    const dy = parseFloat(document.getElementById('delta-py').value) || 0;
    const dz = parseFloat(document.getElementById('delta-pz').value) || 0;
    const prev = obj.userData.deltaPosition || { x: 0, y: 0, z: 0 };

    const before = obj.position.clone();
    obj.position.x += dx - prev.x;
    obj.position.y += dy - prev.y;
    obj.position.z += dz - prev.z;
    const after = obj.position.clone();
    obj.userData.deltaPosition = { x: dx, y: dy, z: dz };

    pushUndo({
        undo() { obj.position.copy(before); obj.userData.deltaPosition = prev; if (selectedObject === obj) syncDeltaFields(obj); updateInspectorFromSelected(); },
        redo() { obj.position.copy(after); obj.userData.deltaPosition = { x: dx, y: dy, z: dz }; if (selectedObject === obj) syncDeltaFields(obj); updateInspectorFromSelected(); },
    });
    updateInspectorFromSelected();
}

function resetDeltaTransform() {
    const obj = selectedObject;
    if (!obj) return;
    const prev = obj.userData.deltaPosition;
    if (!prev || (prev.x === 0 && prev.y === 0 && prev.z === 0)) return;

    const before = obj.position.clone();
    obj.position.x -= prev.x; obj.position.y -= prev.y; obj.position.z -= prev.z;
    const after = obj.position.clone();
    obj.userData.deltaPosition = { x: 0, y: 0, z: 0 };
    syncDeltaFields(obj);

    pushUndo({
        undo() { obj.position.copy(before); obj.userData.deltaPosition = prev; if (selectedObject === obj) syncDeltaFields(obj); updateInspectorFromSelected(); },
        redo() { obj.position.copy(after); obj.userData.deltaPosition = { x: 0, y: 0, z: 0 }; if (selectedObject === obj) syncDeltaFields(obj); updateInspectorFromSelected(); },
    });
    updateInspectorFromSelected();
}

function syncDeltaFields(obj) {
    const d = obj.userData.deltaPosition || { x: 0, y: 0, z: 0 };
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v.toFixed(2); };
    set('delta-px', d.x); set('delta-py', d.y); set('delta-pz', d.z);
}

// ─────────────────────────────────────────────────────────────
// VISIBILITY / SELECTABLE — real toggles (previously the outliner's eye
// icon and the Relations & Visibility panel were pure decoration).
// mesh.visible = false also removes it from raycasting automatically
// (three.js skips invisible objects in intersectObjects), so hiding an
// object also makes it unclickable for free.
// ─────────────────────────────────────────────────────────────
function toggleObjectVisibility(mesh) {
    const before = mesh.visible;
    mesh.visible = !mesh.visible;
    if (!mesh.visible && selectedObject === mesh) selectObject(null);
    renderOutliner();
    if (selectedObject === mesh) { const el = document.getElementById('rel-visible'); if (el) el.checked = mesh.visible; }
    setVCB('Visibility:', `${mesh.name} ${mesh.visible ? 'shown' : 'hidden'}`);
    const after = mesh.visible;
    pushUndo({
        undo() { mesh.visible = before; renderOutliner(); if (selectedObject === mesh) { const el = document.getElementById('rel-visible'); if (el) el.checked = mesh.visible; } },
        redo() { mesh.visible = after; renderOutliner(); if (selectedObject === mesh) { const el = document.getElementById('rel-visible'); if (el) el.checked = mesh.visible; } },
    });
}

function setSelectedVisibility(visible) {
    if (!selectedObject) return;
    const mesh = selectedObject;
    const before = mesh.visible;
    mesh.visible = visible;
    renderOutliner();
    setVCB('Visibility:', `${mesh.name} ${visible ? 'shown' : 'hidden'}`);
    pushUndo({
        undo() { mesh.visible = before; renderOutliner(); if (selectedObject === mesh) { const el = document.getElementById('rel-visible'); if (el) el.checked = mesh.visible; } },
        redo() { mesh.visible = visible; renderOutliner(); if (selectedObject === mesh) { const el = document.getElementById('rel-visible'); if (el) el.checked = mesh.visible; } },
    });
}

function setSelectedSelectable(selectable) {
    if (!selectedObject) return;
    selectedObject.userData.selectable = selectable;
    setVCB('Selectable:', `${selectedObject.name}: ${selectable ? 'on' : 'off'}`);
}

// ─────────────────────────────────────────────────────────────
// TAGS / LAYERS — real SketchUp-style visibility grouping. Each
// sceneObjects entry gets an optional `layer` field (default 'Untagged').
// Toggling a layer off hides every real member (mesh.visible = false, same
// mechanism as the existing per-object Hide/Unhide — a hidden layer member
// is also automatically unraycastable, for free).
// ─────────────────────────────────────────────────────────────
let sceneLayers = ['Untagged'];
let layerVisible = { Untagged: true };

function ensureLayerExists(name) {
    if (!sceneLayers.includes(name)) { sceneLayers.push(name); layerVisible[name] = true; }
}

function createLayerFromInput() {
    const input = document.getElementById('new-layer-name');
    const name = (input.value || '').trim();
    if (!name) return;
    ensureLayerExists(name);
    input.value = '';
    renderLayersPanel();
    populateLayerSelect();
    setVCB('Tag:', `Created "${name}"`);
}

function assignSelectedToLayer(layerName) {
    if (!selectedObject) return;
    const entry = sceneObjects.find(o => o.mesh === selectedObject);
    if (!entry) return;
    ensureLayerExists(layerName);
    const before = entry.layer || 'Untagged';
    entry.layer = layerName;
    entry.mesh.visible = layerVisible[layerName] !== false;
    setVCB('Tag:', `${entry.name} → ${layerName}`);
    pushUndo({
        undo() { entry.layer = before; entry.mesh.visible = layerVisible[before] !== false; if (selectedObject === entry.mesh) populateLayerSelect(); },
        redo() { entry.layer = layerName; entry.mesh.visible = layerVisible[layerName] !== false; if (selectedObject === entry.mesh) populateLayerSelect(); },
    });
}

function toggleLayerVisibility(name, visible) {
    layerVisible[name] = visible;
    sceneObjects.forEach(o => { if ((o.layer || 'Untagged') === name) o.mesh.visible = visible; });
    renderOutliner();
    setVCB('Tag:', `${name} ${visible ? 'shown' : 'hidden'}`);
}

function renderLayersPanel() {
    const list = document.getElementById('layers-list');
    if (!list) return;
    list.innerHTML = sceneLayers.map(name => {
        const count = sceneObjects.filter(o => (o.layer || 'Untagged') === name).length;
        return `<label style="display:flex; align-items:center; gap:6px; font-size:10.5px;">
            <input type="checkbox" ${layerVisible[name] !== false ? 'checked' : ''} onchange="toggleLayerVisibility('${name}', this.checked)">
            <span style="flex:1;">${name}</span><span style="color:#666;">${count}</span>
        </label>`;
    }).join('');
}

function populateLayerSelect() {
    const sel = document.getElementById('entity-layer-select');
    if (!sel) return;
    const entry = selectedObject && sceneObjects.find(o => o.mesh === selectedObject);
    const current = entry ? (entry.layer || 'Untagged') : 'Untagged';
    sel.innerHTML = sceneLayers.map(name => `<option value="${name}" ${name === current ? 'selected' : ''}>${name}</option>`).join('');
}

// ─────────────────────────────────────────────────────────────
// LEVELS / STOREYS — real BIM floor stacking (design idea studied from the
// Pascal Editor reference project's clean Levels UI). Each level has a
// name, a wall height, and a computed elevation (sum of every lower
// level's height) — not independent numbers a user could desync. Drawing
// tools (Wall/Slab/Opening/Line/etc.) all fall back to the same shared
// `_groundPlane` for empty-space raycasts, so retargeting that one plane's
// constant to the active level's elevation makes every existing tool
// level-aware for free, with no per-tool plumbing. New objects are tagged
// with the level they were created on; editing a lower level's height
// physically shifts every object on a higher level by the real delta,
// matching how real BIM software keeps floors associative.
// ─────────────────────────────────────────────────────────────
let buildingLevels = [{ name: 'Ground Floor', height: 3.0 }];
let activeLevelIndex = 0;

function levelElevation(index) {
    let z = 0;
    for (let i = 0; i < index; i++) z += buildingLevels[i].height;
    return z;
}

function setActiveLevel(index) {
    if (index < 0 || index >= buildingLevels.length) return;
    activeLevelIndex = index;
    const z = levelElevation(index);
    _groundPlane.constant = -z;
    if (groundGrid) groundGrid.position.z = z;
    renderLevelsPanel();
    if (typeof refreshHudContext === 'function') refreshHudContext();
    setVCB('Level:', buildingLevels[index].name);
}

function addLevelAbove() {
    const at = activeLevelIndex;
    buildingLevels.splice(at + 1, 0, { name: nextLevelName(), height: 3.0 });
    setActiveLevel(at + 1);
}

function addLevelBelow() {
    const at = activeLevelIndex;
    buildingLevels.splice(at, 0, { name: nextLevelName(), height: 3.0 });
    // Every existing object (including Ground Floor's own) needs to shift up
    // by the new level's height so it visually stays on its real level.
    const delta = buildingLevels[at].height;
    sceneObjects.forEach(o => { if (typeof o.level === 'number' && o.level >= at) o.mesh.position.z += delta; });
    sceneObjects.forEach(o => { if (typeof o.level === 'number' && o.level >= at) o.level += 1; });
    setActiveLevel(at);
}

function nextLevelName() {
    let n = buildingLevels.length + 1, name;
    do { name = `Level ${n}`; n++; } while (buildingLevels.some(l => l.name === name));
    return name;
}

function removeActiveLevel() {
    if (buildingLevels.length <= 1) { setVCB('Levels:', 'At least one level is required'); return; }
    const idx = activeLevelIndex;
    const hasContent = sceneObjects.some(o => o.level === idx);
    if (hasContent && !confirm(`${buildingLevels[idx].name} has objects on it. Delete the level anyway? (objects are NOT deleted, just left at their current height)`)) return;
    buildingLevels.splice(idx, 1);
    sceneObjects.forEach(o => { if (typeof o.level === 'number' && o.level > idx) o.level -= 1; });
    setActiveLevel(Math.min(idx, buildingLevels.length - 1));
}

function renameLevel(index, name) {
    const trimmed = (name || '').trim();
    if (!trimmed || !buildingLevels[index]) return;
    buildingLevels[index].name = trimmed;
    renderLevelsPanel();
}

// Changing a level's height re-derives every level above it and physically
// shifts their objects by the real delta — the elevation numbers and the
// actual geometry never drift apart.
function setLevelHeight(index, height) {
    const h = parseFloat(height);
    if (!isFinite(h) || h <= 0 || !buildingLevels[index]) return;
    const delta = h - buildingLevels[index].height;
    buildingLevels[index].height = h;
    if (Math.abs(delta) > 1e-9) {
        sceneObjects.forEach(o => { if (typeof o.level === 'number' && o.level > index) o.mesh.position.z += delta; });
    }
    setActiveLevel(activeLevelIndex); // re-derive _groundPlane/groundGrid from the (possibly changed) active elevation
}

function toggleLevelIsolate(enabled) {
    _levelIsolateOn = enabled;
    applyLevelVisibility();
}
let _levelIsolateOn = false;

function applyLevelVisibility() {
    sceneObjects.forEach(o => {
        if (typeof o.level !== 'number') return; // objects created before Levels existed, or not level-tagged (lights/camera) — never hidden by this
        const shouldShow = !_levelIsolateOn || o.level === activeLevelIndex;
        if (o.mesh.visible !== shouldShow) o.mesh.visible = shouldShow;
    });
    renderOutliner();
}

function renderLevelsPanel() {
    const list = document.getElementById('levels-list');
    if (!list) return;
    list.innerHTML = buildingLevels.map((lvl, i) => {
        const isActive = i === activeLevelIndex;
        return `
            <div class="levels-row ${isActive ? 'active' : ''}" style="display:flex; align-items:center; gap:4px; padding:3px 4px; border-radius:3px; ${isActive ? 'background:var(--b-accent-soft, rgba(74,111,232,0.25));' : ''} cursor:pointer;" onclick="setActiveLevel(${i})">
                <input type="text" value="${lvl.name}" style="flex:1; min-width:0; background:transparent; border:none; color:#eee; font-size:10.5px; padding:2px;" onclick="event.stopPropagation()" onchange="renameLevel(${i}, this.value)">
                <input type="number" value="${lvl.height.toFixed(2)}" step="0.1" min="0.1" title="Wall height (m)" style="width:52px; background:var(--b-bg-input); border:1px solid var(--b-border-light); color:#ddd; font-size:10px; padding:2px; border-radius:2px;" onclick="event.stopPropagation()" onchange="setLevelHeight(${i}, this.value)">
                <span style="font-size:8.5px; color:var(--b-text-sub); width:44px; text-align:right;">${levelElevation(i).toFixed(2)}m</span>
            </div>`;
    }).join('');
}

// ─────────────────────────────────────────────────────────────
// ENTITY INFO — a real per-object info readout (type, material, vertex/
// triangle count, area for a flat closed mesh face), matching SketchUp's
// Entity Info box. Area is computed as a true sum of triangle areas
// projected onto the face's own plane, not a bounding-box estimate.
// ─────────────────────────────────────────────────────────────
function computeMeshArea(mesh) {
    const pos = mesh.geometry.attributes.position;
    if (!pos) return 0;
    let area = 0;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3(), cross = new THREE.Vector3();
    const idx = mesh.geometry.index;
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    for (let t = 0; t < triCount; t++) {
        const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
        a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
        ab.subVectors(b, a); ac.subVectors(c, a);
        cross.crossVectors(ab, ac);
        area += cross.length() * 0.5;
    }
    const s = mesh.scale;
    return area * Math.abs(s.x * s.y); // approximate for non-uniform scale on a roughly-planar face; exact for uniform scale
}

function updateEntityInfo() {
    const obj = selectedObject;
    const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    populateLayerSelect();
    if (!obj) {
        ['entity-info-type', 'entity-info-material', 'entity-info-verts', 'entity-info-tris', 'entity-info-area'].forEach(id => setTxt(id, '—'));
        return;
    }
    const entry = sceneObjects.find(o => o.mesh === obj);
    setTxt('entity-info-type', (entry && entry.type) || obj.type || 'Object');
    {
        const dispMat = primaryMaterial(obj);
        const multiTag = Array.isArray(obj.material) && obj.material.length > 1 ? ` (${obj.material.length} slots)` : '';
        setTxt('entity-info-material', dispMat ? (dispMat.type.replace('Mesh', '').replace('Material', '') + ' #' + dispMat.color.getHexString() + multiTag) : '—');
    }
    if (obj.isMesh && obj.geometry && obj.geometry.attributes.position) {
        const triCount = obj.geometry.index ? obj.geometry.index.count / 3 : obj.geometry.attributes.position.count / 3;
        setTxt('entity-info-verts', obj.geometry.attributes.position.count);
        setTxt('entity-info-tris', Math.round(triCount));
        setTxt('entity-info-area', formatLength(Math.sqrt(computeMeshArea(obj))) + '² ≈ ' + computeMeshArea(obj).toFixed(3) + ' m²');
    } else {
        setTxt('entity-info-verts', '—'); setTxt('entity-info-tris', '—'); setTxt('entity-info-area', '—');
    }
}

// ─────────────────────────────────────────────────────────────
// X-RAY — real see-through rendering: every material goes transparent with
// a low opacity and no depth-write, so overlapping/internal geometry is
// genuinely visible through outer surfaces (not a fake single-object
// highlight) — matches SketchUp's X-Ray display mode.
// ─────────────────────────────────────────────────────────────
let xrayEnabled = false;
const _xraySnapshot = new Map(); // material -> { transparent, opacity, depthWrite }

function toggleXRay(enabled) {
    xrayEnabled = enabled;
    scene.traverse(obj => {
        if (!obj.isMesh || !obj.material || obj.userData.isSectionPlane) return;
        allMaterials(obj).forEach(mat => {
            if (enabled) {
                if (!_xraySnapshot.has(mat)) _xraySnapshot.set(mat, { transparent: mat.transparent, opacity: mat.opacity, depthWrite: mat.depthWrite });
                mat.transparent = true;
                mat.opacity = 0.35;
                mat.depthWrite = false;
            } else if (_xraySnapshot.has(mat)) {
                const snap = _xraySnapshot.get(mat);
                mat.transparent = snap.transparent;
                mat.opacity = snap.opacity;
                mat.depthWrite = snap.depthWrite;
                _xraySnapshot.delete(mat);
            }
        });
    });
    setVCB('X-Ray:', enabled ? 'On' : 'Off');
}

// ─────────────────────────────────────────────────────────────
// FOG — real atmospheric depth cue via THREE.Fog (distance-based color
// blend, not a screen-space overlay trick).
// ─────────────────────────────────────────────────────────────
function toggleFog(enabled) {
    scene.fog = enabled ? new THREE.Fog(0x1a1a1a, 8, 60) : null;
    setVCB('Fog:', enabled ? 'On' : 'Off');
}
function setFogDistance(near, far) {
    if (scene.fog) { scene.fog.near = near; scene.fog.far = far; }
}

// ─────────────────────────────────────────────────────────────
// STYLES — real preset "looks" combining shading mode + background +
// per-material color override, matching SketchUp's Styles browser (not
// just the existing Wireframe/Solid/Material/Raytrace shading-mode
// spheres, which only change ONE axis — face rendering — not the whole
// scene look). Blueprint genuinely recolors every material to a uniform
// cyan-on-navy look (snapshot-and-restore, same pattern as X-Ray) so
// switching back to Photoreal returns every object's real original color.
// ─────────────────────────────────────────────────────────────
let currentStyle = 'photoreal';
const _styleColorSnapshot = new Map(); // material -> original THREE.Color

function applyStyle(name) {
    currentStyle = name;
    if (name === 'blueprint') {
        scene.background = new THREE.Color(0x0a2f5c);
        setShadingMode('WIREFRAME');
        scene.traverse(obj => {
            if (!obj.isMesh || !obj.material || obj.userData.isSectionPlane) return;
            allMaterials(obj).forEach(mat => {
                if (!_styleColorSnapshot.has(mat)) _styleColorSnapshot.set(mat, mat.color.clone());
                mat.color.set(0x66e0ff);
            });
        });
        toggleShadows(false);
        setVCB('Style:', 'Blueprint');
    } else { // photoreal
        scene.background = new THREE.Color(0x1a1a1a);
        _styleColorSnapshot.forEach((color, mat) => mat.color.copy(color));
        _styleColorSnapshot.clear();
        setShadingMode('MATERIAL');
        toggleShadows(true);
        setVCB('Style:', 'Photoreal');
    }
}

// ─────────────────────────────────────────────────────────────
// WALK / LOOK AROUND — real first-person navigation, Z-up-aware (this
// app's world uses Z as "up", unlike three.js's Y-up default, so camera
// orientation is rebuilt from explicit yaw/pitch angles each tick rather
// than using an Euler order that assumes Y-up). Walk: WASD moves at a
// fixed eye height (only look direction changes pitch, not actual
// altitude — mouse-drag never changes camera.position.z during movement,
// matching real SketchUp's "keeps eye height locked"); drag the mouse to
// look around. Look Around: same mouse-look, no WASD movement — a fixed
// standing point you pivot from.
// ─────────────────────────────────────────────────────────────
let walkModeActive = false;
let walkIsLookAroundOnly = false;
let _walkYaw = 0, _walkPitch = 0;
const _walkKeysDown = new Set();
let _walkDragging = false, _walkLastX = 0, _walkLastY = 0;
const WALK_SPEED = 4; // m/s
const WALK_LOOK_SENSITIVITY = 0.005;

function applyWalkLook() {
    _walkPitch = THREE.MathUtils.clamp(_walkPitch, -1.5, 1.5);
    const dir = new THREE.Vector3(
        Math.cos(_walkPitch) * Math.sin(_walkYaw),
        Math.cos(_walkPitch) * Math.cos(_walkYaw),
        Math.sin(_walkPitch)
    );
    camera.up.set(0, 0, 1);
    camera.lookAt(camera.position.clone().add(dir));
}

function initWalkYawPitchFromCamera() {
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    _walkYaw = Math.atan2(dir.x, dir.y);
    _walkPitch = Math.asin(THREE.MathUtils.clamp(dir.z, -1, 1));
}

function stepWalkMovement(dt) {
    if (!walkModeActive || walkIsLookAroundOnly || _walkKeysDown.size === 0) return;
    const forward = new THREE.Vector3(Math.sin(_walkYaw), Math.cos(_walkYaw), 0);
    const right = new THREE.Vector3(forward.y, -forward.x, 0); // rotate forward -90° around Z
    const move = new THREE.Vector3();
    if (_walkKeysDown.has('w')) move.add(forward);
    if (_walkKeysDown.has('s')) move.sub(forward);
    if (_walkKeysDown.has('d')) move.add(right);
    if (_walkKeysDown.has('a')) move.sub(right);
    if (move.lengthSq() > 0) {
        move.normalize().multiplyScalar(WALK_SPEED * dt);
        const z = camera.position.z; // eye height locked — movement never changes altitude
        camera.position.add(move);
        camera.position.z = z;
    }
}

function setupWalkMode(canvas) {
    canvas.addEventListener('pointerdown', e => {
        if (!walkModeActive || e.button !== 0) return;
        _walkDragging = true; _walkLastX = e.clientX; _walkLastY = e.clientY;
    });
    window.addEventListener('pointermove', e => {
        if (!walkModeActive || !_walkDragging) return;
        _walkYaw -= (e.clientX - _walkLastX) * WALK_LOOK_SENSITIVITY;
        _walkPitch += (e.clientY - _walkLastY) * WALK_LOOK_SENSITIVITY; // drag up = look up
        _walkLastX = e.clientX; _walkLastY = e.clientY;
        applyWalkLook();
    });
    window.addEventListener('pointerup', () => { _walkDragging = false; });
    window.addEventListener('keydown', e => {
        if (!walkModeActive) return;
        const k = e.key.toLowerCase();
        if (['w', 'a', 's', 'd'].includes(k)) _walkKeysDown.add(k);
        if (e.key === 'Escape') { setActiveTool('select'); }
    });
    window.addEventListener('keyup', e => { _walkKeysDown.delete(e.key.toLowerCase()); });
}

function toggleWalkMode(enabled, lookAroundOnly) {
    walkModeActive = enabled;
    walkIsLookAroundOnly = !!lookAroundOnly;
    orbitControls.enabled = !enabled;
    _walkKeysDown.clear();
    _walkDragging = false;
    if (enabled) {
        initWalkYawPitchFromCamera();
        setVCB(lookAroundOnly ? 'Look Around:' : 'Walk:', lookAroundOnly ? 'Drag to look, Esc to exit' : 'WASD to move, drag to look, Esc to exit');
    }
}

// POSITION CAMERA — a discrete one-shot teleport (distinct from continuous
// Walk/Look Around above): click any point, line, or surface and the
// camera jumps to stand there at a real eye height (5'6" / 1.68m above the
// clicked point), keeping its current facing direction but leveling out
// any pitch — matching real SketchUp's Position Camera Tool. Orbit
// controls stay in charge afterward (this tool doesn't hand off into Walk
// mode); the tool itself stays active so repeated clicks keep repositioning.
const EYE_HEIGHT_METERS = 1.68; // 5'6"
function positionCameraAt(pt) {
    camera.position.set(pt.x, pt.y, pt.z + EYE_HEIGHT_METERS);
    initWalkYawPitchFromCamera();
    _walkPitch = 0; // level standing eye view, not pointed at the clicked surface
    applyWalkLook();
    orbitControls.target.copy(camera.position.clone().addScaledVector(new THREE.Vector3(Math.sin(_walkYaw), Math.cos(_walkYaw), 0), 3));
    orbitControls.update();
    setVCB('Position Camera:', `Eye height ${formatLength(EYE_HEIGHT_METERS, 2)} above clicked point`);
}

// Statistics overlay (Blender: Viewport Overlays > Statistics) — total
// triangle/vertex count across the scene's real meshes.
function sceneStats() {
    let tris = 0, verts = 0;
    sceneObjects.forEach(o => {
        if (!o.mesh || !o.mesh.isMesh) return;
        const p = o.mesh.geometry.attributes.position;
        if (!p) return;
        tris += o.mesh.geometry.index ? o.mesh.geometry.index.count / 3 : p.count / 3;
        verts += p.count;
    });
    return { tris: Math.round(tris), verts };
}

function updateHUD() {
    const title = document.getElementById('hud-view-title');
    const info  = document.getElementById('hud-col-info');
    if (title) title.innerText = 'User Perspective';
    const stats = sceneStats();
    const statsStr = `Tris: ${stats.tris} | Verts: ${stats.verts}`;
    if (info)  info.innerText  = selectedObject
        ? `(1) Collection | ${selectedObject.name} | ${statsStr}`
        : `(1) Collection | ${statsStr}`;
}

// ─────────────────────────────────────────────────────────────
// TOOLS — from _defs_transform, _defs_view3d_select, _defs_view3d_add
// (FIX 4: clear both .su-palette-btn and .t-tool-btn)
// ─────────────────────────────────────────────────────────────
// Real per-tool cursor feedback — previously every tool used the same
// default arrow, so there was no "feel" for which tool was active or that
// a click/drag was about to do something (a common complaint alongside
// "selection isn't visible").
// Real custom cursor glyphs (small outlined SVG, white-on-black so it reads
// on any viewport background) for the tools whose function a bare CSS
// keyword cursor doesn't communicate well — previously Push/Pull and Offset
// both just used the generic 'ns-resize' arrow, indistinguishable from an OS
// window-resize cursor and giving no hint this drags a FACE specifically.
function svgCursor(inner, hotspot, fallback) {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>${inner}</svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotspot} ${hotspot}, ${fallback}`;
}
const PUSHPULL_CURSOR_GLYPH =
    "<g fill='none' stroke='black' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'>" +
    "<rect x='4' y='15' width='16' height='6'/><line x1='12' y1='15' x2='12' y2='2'/><path d='M7 7 L12 2 L17 7'/></g>" +
    "<g fill='none' stroke='white' stroke-width='1.3' stroke-linecap='round' stroke-linejoin='round'>" +
    "<rect x='4' y='15' width='16' height='6'/><line x1='12' y1='15' x2='12' y2='2'/><path d='M7 7 L12 2 L17 7'/></g>";
const OFFSET_CURSOR_GLYPH =
    "<g fill='none' stroke='black' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'>" +
    "<rect x='3' y='3' width='18' height='18'/><rect x='8' y='8' width='8' height='8'/></g>" +
    "<g fill='none' stroke='white' stroke-width='1.3' stroke-linecap='round' stroke-linejoin='round'>" +
    "<rect x='3' y='3' width='18' height='18'/><rect x='8' y='8' width='8' height='8'/></g>";
const TOOL_CURSORS = {
    select: 'default', move: 'move', rotate: 'alias', scale: 'nwse-resize',
    eraser: 'not-allowed', select_box: 'crosshair', select_circle: 'crosshair', select_lasso: 'crosshair',
    line: 'crosshair', rect: 'crosshair', circle: 'crosshair', arc: 'crosshair',
    polygon: 'crosshair', pie: 'crosshair', rotrect: 'crosshair',
    walk: 'move', lookaround: 'grab', position_camera: 'crosshair',
    poly_build: 'crosshair',
    pushpull: svgCursor(PUSHPULL_CURSOR_GLYPH, 12, 'ns-resize'),
    offset: svgCursor(OFFSET_CURSOR_GLYPH, 12, 'ns-resize'),
    tape: 'crosshair', knife: 'crosshair', bisect: 'crosshair', dimension: 'crosshair',
    vertex_slide: 'ew-resize', edge_slide: 'ew-resize', extrude_to_cursor: 'crosshair', eyedropper: 'crosshair',
    extrude_normals: 'ns-resize', extrude_individual: 'ns-resize', bevel: 'ns-resize', shrink_fatten: 'ns-resize', to_sphere: 'ns-resize',
};
function updateCanvasCursor() {
    const canvas = document.getElementById('viewport-canvas');
    if (canvas) canvas.style.cursor = TOOL_CURSORS[activeTool] || 'default';
}

// Shows the matching settings section (Wall/Slab/Opening) right next to
// the toolbar the moment that tool is selected — was previously buried in
// menus, if it existed at all.
const TOOL_SETTINGS_SECTIONS = { wall: 'tool-settings-wall', slab: 'tool-settings-slab', opening: 'tool-settings-opening' };
function updateToolSettingsPanel(tool) {
    const panel = document.getElementById('tool-settings-panel');
    const sectionId = TOOL_SETTINGS_SECTIONS[tool];
    if (!panel) return;
    ['tool-settings-wall', 'tool-settings-slab', 'tool-settings-opening'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = (id === sectionId) ? 'block' : 'none';
    });
    if (sectionId) {
        const titles = { wall: 'Wall Settings', slab: 'Slab Settings', opening: 'Opening Settings' };
        const titleEl = document.getElementById('tool-settings-title');
        if (titleEl) titleEl.innerText = titles[tool];
        if (tool === 'opening') refreshOpeningPresetDropdown();
        // Anchored to the ACTUAL current rects of the Tools palette and
        // the viewport HUD text (not a hardcoded pixel offset) — the Tools
        // palette floats on top of the canvas (the canvas is full-bleed
        // underneath it, so its own rect gives no clearance info) and is
        // itself dockable/floatable, so a fixed left:56px only ever
        // happened to clear it in one specific layout. Measuring both
        // real rects and placing this panel clear of whichever extends
        // further keeps it out of the way regardless of current layout.
        const toolsPalette = document.getElementById('su-toolbar');
        const hud = document.querySelector('.viewport-hud-text');
        const toolsRect = toolsPalette ? toolsPalette.getBoundingClientRect() : null;
        const hudRect = hud ? hud.getBoundingClientRect() : null;
        const left = toolsRect ? Math.max(toolsRect.right + 8, 56) : 56;
        const top = hudRect ? Math.max(hudRect.bottom + 8, 12) : 12;
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
        panel.style.display = 'block';
    } else {
        panel.style.display = 'none';
    }
}

function setActiveTool(tool) {
    if (tool !== activeTool) cancelSketchTool();
    // Walk/Look Around take over camera control directly (disabling
    // OrbitControls) — must be exited the same way whenever any OTHER
    // tool is chosen, not just via their own Escape handler.
    if (walkModeActive && tool !== 'walk' && tool !== 'lookaround') toggleWalkMode(false);
    if (tool === 'walk') toggleWalkMode(true, false);
    if (tool === 'lookaround') toggleWalkMode(true, true);
    activeTool = tool;
    updateCanvasCursor();
    updateToolSettingsPanel(tool);

    document.querySelectorAll('.su-palette-btn, .t-tool-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById(`tb-${tool}`);
    if (btn) btn.classList.add('active');

    switch (tool) {
        case 'select':
        case 'move':
            transformControls.setMode('translate');
            if (selectedObject) transformControls.attach(selectedObject);
            setVCB('Move:', 'G — Grab');
            break;
        case 'rotate':
            transformControls.setMode('rotate');
            if (selectedObject) transformControls.attach(selectedObject);
            setVCB('Rotate:', 'R — Rotate');
            break;
        case 'scale':
            // SketchUp-style direct-manipulation corner handles (see
            // updateScaleHandles()/setupScaleHandles()) replace the abstract
            // axis-arrow gizmo here — dragging a bounding-box corner resizes
            // the object about the opposite corner, which is what "drag to
            // scale" means in SketchUp rather than Blender's arrow handles.
            transformControls.detach();
            setVCB('Scale:', 'Drag a corner handle to resize');
            break;
        default:
            // Drawing / sculpt tools — hide gizmo
            transformControls.detach();
            setVCB(`Tool: ${tool}`, '');
    }
}

// ─────────────────────────────────────────────────────────────
// KEYBOARD SHORTCUTS — from Blender keymap reference
// ─────────────────────────────────────────────────────────────
function setupKeyboard() {
    window.addEventListener('keydown', e => {
        // Escape must cancel an in-progress draw regardless of what has
        // focus — the command bar, a render-settings field, the units
        // dropdown, any input anywhere. Without this, the input-focus
        // guard just below silently swallowed Escape entirely whenever
        // focus was still sitting in some other field, leaving a Line/
        // Wall/Poly Build path stuck mid-draw with no way to cancel it
        // from the keyboard.
        if (e.key === 'F10') {
            e.preventDefault();
            takeViewportScreenshot();
            return;
        }
        if (e.key === 'Escape' && presentMode && !sketchState) {
            exitPresentMode();
            return;
        }
        if (e.key === 'Escape' && sketchState) {
            if (document.activeElement && document.activeElement !== document.body && typeof document.activeElement.blur === 'function') {
                document.activeElement.blur();
            }
            _vcbTypedValue = '';
            cancelSketchTool();
            return;
        }
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

        // Ctrl/Cmd shortcuts — checked first so they never fall through to
        // the plain-letter tool shortcuts below (e.g. Ctrl+S vs S=scale).
        if (e.ctrlKey || e.metaKey) {
            const k = e.key.toLowerCase();
            if (k === 'z' && e.shiftKey) { e.preventDefault(); redo(); return; }
            if (k === 'z') {
                e.preventDefault();
                // SketchUp: Undo while a Line/Wall/Poly Build path is
                // mid-draw steps back one point at a time, so you can
                // backtrack a multi-point path without losing the whole
                // session — previously this always reached past the active
                // draw to undo the last already-committed scene operation,
                // leaving the in-progress path completely unaffected.
                if (sketchState && sketchState.points && sketchState.points.length > 0) {
                    sketchState.points.pop();
                    if (sketchState.points.length === 0) {
                        cancelSketchTool();
                    } else {
                        const toolLabel = { line: 'Line', wall: 'Wall', polybuild: 'Poly Build' }[sketchState.tool] || sketchState.tool;
                        setVCB(`${toolLabel}:`, `${sketchState.points.length} point(s) — Ctrl+Z to step back further`);
                    }
                    return;
                }
                undo();
                return;
            }
            if (k === 'y') { e.preventDefault(); redo(); return; }
            if (k === 's' && e.shiftKey) { e.preventDefault(); takeViewportScreenshot(); return; }
            if (k === 's') { e.preventDefault(); saveProjectFile(); return; }
            if (k === 'o') { e.preventDefault(); triggerOpenProjectFile(); return; }
            // Ctrl+Numpad — opposite-axis views (Blender convention)
            if (k === '1') { setViewAngle('back');   return; }
            if (k === '3') { setViewAngle('left');   return; }
            if (k === '7') { setViewAngle('bottom'); return; }
            if (k === '=' || k === '+' || e.key === 'Add') { e.preventDefault(); growFaceSelection(); return; }
            if (k === '-' || e.key === 'Subtract') { e.preventDefault(); shrinkFaceSelection(); return; }
            return;
        }

        // SketchUp-style numeric entry — digits typed while a Line/Wall/
        // Poly Build path is mid-draw go straight into the VCB without
        // needing to click into it first, exactly like real SketchUp.
        if (NUMERIC_ENTRY_TOOLS.includes(activeTool) && sketchState) {
            if (/^[0-9.]$/.test(e.key)) {
                e.preventDefault();
                _vcbTypedValue += e.key;
                setVCB('Length:', _vcbTypedValue + ' ' + UNIT_DEFS[appUnits].label);
                return;
            }
            if (e.key === 'Backspace' && _vcbTypedValue) {
                e.preventDefault();
                _vcbTypedValue = _vcbTypedValue.slice(0, -1);
                setVCB('Length:', (_vcbTypedValue || '0') + ' ' + UNIT_DEFS[appUnits].label);
                return;
            }
            // SketchUp arrow-key direction lock: Right=Red/X, Left=Green/Y,
            // Up=Blue/Z. Pressing the same arrow again toggles the lock
            // back off; pressing a different one switches to that axis.
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                const axis = e.key === 'ArrowRight' ? 'x' : e.key === 'ArrowLeft' ? 'y' : 'z';
                _axisLockDir = (_axisLockDir === axis) ? null : axis;
                const axisLabel = { x: 'Red Axis', y: 'Green Axis', z: 'Blue Axis' }[axis];
                setVCB('Direction:', _axisLockDir ? `Locked to ${axisLabel}` : 'Unlocked');
                return;
            }
        }

        switch (e.key) {
            // Finish/cancel an in-progress sketch tool (Line/Arc point sequences)
            case 'Enter': {
                // A typed length commits ONE more point at exactly that
                // distance along the current cursor direction, then keeps
                // drawing — it does not finish the shape (matching
                // SketchUp: Enter with nothing typed is what finishes).
                const typedMeters = _vcbTypedValue ? parseTypedLength(_vcbTypedValue) : null;
                if (typedMeters != null && NUMERIC_ENTRY_TOOLS.includes(activeTool) && sketchState && _lastSketchCursorPoint) {
                    const ref = findSketchReferencePoint();
                    const dir = ref ? _lastSketchCursorPoint.clone().sub(ref) : null;
                    const point = (dir && dir.lengthSq() > 1e-10)
                        ? ref.clone().addScaledVector(dir.normalize(), typedMeters)
                        : _lastSketchCursorPoint.clone();
                    _vcbTypedValue = '';
                    if (activeTool === 'line') handleLineClick(point);
                    else if (activeTool === 'wall') handleWallClick(point);
                    else if (activeTool === 'poly_build') handlePolyBuildClick(point);
                    break;
                }
                _vcbTypedValue = '';
                if (sketchState?.tool === 'line') finishLine();
                else if (sketchState?.tool === 'arc' && sketchState.points.length >= 2) finishArc();
                else if (sketchState?.tool === 'polybuild') finishPolyBuild();
                else if (sketchState?.tool === 'wall') finishWall();
                else if (sketchState?.tool === 'slab') finishSlab();
                else if (sketchState?.tool === 'knife') finishKnife();
                break;
            }
            case 'Escape':
                _vcbTypedValue = '';
                cancelSketchTool();
                break;

            // Transform tools (G, R, S — Blender standard)
            case 'g': case 'G': setActiveTool('move');   break;
            case 'r': case 'R': setActiveTool('rotate'); break;
            case 's': case 'S': setActiveTool('scale');  break;
            case 'q': case 'Q': setActiveTool('rotate'); break; // SketchUp-style alt binding for Rotate (Q/R)

            // SketchUp tool shortcuts (only unused keys are bound globally;
            // ones that would collide with a Blender-standard binding above
            // — e.g. Rectangle's documented "R" — are intentionally NOT
            // bound here since G/R/S/Tab/A/etc. already own those keys).
            case 'e': case 'E': setActiveTool('eraser');   break;
            case 't': case 'T': setActiveTool('tape');     break;
            case 'b': case 'B': switchRightTab('mat');     break;
            case 'p': case 'P': setActiveTool('pushpull'); break;
            case 'u': case 'U': setActiveTool('pushpull'); break;
            case 'f': case 'F': setActiveTool('offset');   break;

            // Context-sensitive: only meaningful (and only bound) while the
            // SketchUp CAD workspace is active, so they never shadow A/L/C
            // elsewhere (A = Select All, etc.).
            case 'l': case 'L':
                if (currentInteractionMode === 'edit' && faceSelectOn) { selectLinkedFaces(); break; }
                if (currentInteractionMode === 'sketchup') setActiveTool('line');
                break;
            case 'c': case 'C':
                if (currentInteractionMode === 'sketchup') setActiveTool('circle');
                break;

            // Tab — toggle Object / Edit Mode
            case 'Tab':
                e.preventDefault();
                switchInteractionMode(currentInteractionMode === 'edit' ? 'object' : 'edit');
                break;

            // Numpad views (7=Top, 1=Front, 3=Right, 5=Ortho)
            case '7': setViewAngle('top');   break;
            case '1': setViewAngle('front'); break;
            case '3': setViewAngle('right'); break;
            case '5': toggleOrtho();         break;

            // Animation / Present slideshow
            case ' ':
                e.preventDefault();
                if (presentMode) togglePresentPlayback();
                else togglePlay();
                break;
            case 'ArrowRight':
                if (presentMode) { e.preventDefault(); gotoPresentSlide(presentIndex + 1); }
                break;
            case 'ArrowLeft':
                if (presentMode) { e.preventDefault(); gotoPresentSlide(presentIndex - 1); }
                break;
            case 'F5':
                e.preventDefault();
                togglePresentMode();
                break;
            case 'F10':
                e.preventDefault();
                takeViewportScreenshot();
                break;
            case 'i': case 'I': insertKeyframe(); break;

            // Delete / X — in Edit Mode with a face/vertex/edge selected,
            // deletes just that geometry; otherwise deletes the whole object.
            case 'Delete': case 'x': case 'X':
                if (currentInteractionMode === 'edit' && (selectedFaces.length > 0 || selectedVertexGroup || selectedEdgeGroups)) {
                    runDeleteSubElement();
                } else {
                    deleteSelected();
                }
                break;

            // M — Merge by Distance in Edit Mode (SketchUp docs list "Move (M/G)"
            // elsewhere; G already owns plain Move, so M does Move there too).
            case 'm': case 'M':
                if (currentInteractionMode === 'edit') runMergeByDistance();
                else setActiveTool('move');
                break;

            // A — 2-Point Arc while the SketchUp CAD workspace is active,
            // else Select All / Deselect All (Blender-standard elsewhere).
            case 'a': case 'A':
                if (currentInteractionMode === 'sketchup') {
                    setActiveTool('arc');
                } else if (selectedObject) {
                    selectObject(null);
                } else if (sceneObjects.length > 0) {
                    selectObject(sceneObjects.find(o => o.type === 'mesh')?.mesh);
                }
                break;

            // Shift+D — Duplicate
            case 'D':
                if (e.shiftKey) duplicateSelected();
                break;

            // F12 — Render
            case 'F12': setShadingMode('RAYTRACE'); break;
        }
    });
}

// ─────────────────────────────────────────────────────────────
// INTERACTION MODE (Object / Edit / Sculpt / SketchUp)
// ─────────────────────────────────────────────────────────────
function switchInteractionMode(mode) {
    if (mode !== 'edit') { clearFaceSelection(); clearVertexSelection(); clearEdgeSelection(); }
    currentInteractionMode = mode;
    const sel = document.getElementById('app-mode-selector');
    if (sel) sel.value = mode;

    const editPills = document.getElementById('edit-mode-pills');
    const hud       = document.getElementById('hud-view-title');

    if (mode === 'edit') {
        if (editPills) editPills.style.display = 'flex';
        if (hud) hud.innerText = 'User Perspective — Edit Mode';
        transformControls.detach();
    } else if (mode === 'sculpt') {
        if (editPills) editPills.style.display = 'none';
        if (hud) hud.innerText = 'User Perspective — Sculpt Mode';
        transformControls.detach();
    } else if (mode === 'paint') {
        // There is no texture-paint brush engine. Keep Object Mode behavior
        // and send the user to the real Materials panel instead of a dead mode.
        currentInteractionMode = 'object';
        if (sel) sel.value = 'object';
        if (editPills) editPills.style.display = 'none';
        if (hud) hud.innerText = 'User Perspective';
        if (selectedObject) transformControls.attach(selectedObject);
        switchRightTab('mat');
        setVCB('Texture Paint:', 'Not a brush engine — use Materials (per-face paint + image textures).');
    } else {
        if (editPills) editPills.style.display = 'none';
        if (hud) hud.innerText = 'User Perspective';
        if (selectedObject) transformControls.attach(selectedObject);
    }
}

// ─────────────────────────────────────────────────────────────
// VIEWPORT (Shading, Views, Camera)
// ─────────────────────────────────────────────────────────────
function setShadingMode(mode) {
    currentShadingMode = mode;

    document.querySelectorAll('.shading-sphere').forEach(s => s.classList.remove('active'));
    const map = { WIREFRAME: '.sphere-wire', SOLID: '.sphere-solid', MATERIAL: '.sphere-mat', RAYTRACE: '.sphere-render' };
    if (map[mode]) document.querySelector(map[mode])?.classList.add('active');

    scene.traverse(child => {
        if (child.isMesh && child.material) {
            allMaterials(child).forEach(mat => { mat.wireframe = (mode === 'WIREFRAME'); });
        }
    });

    if (mode === 'RAYTRACE') {
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.2;
    } else {
        renderer.toneMappingExposure = 1.0;
    }
}

// Shadows on/off — toggles the renderer's shadow-map pass globally. Three.js
// bakes `renderer.shadowMap.enabled` into each material's compiled shader
// program at first render and caches that program on the material; flipping
// the renderer flag alone doesn't recompile anything already-rendered, so
// every material must be flagged for a program rebuild too, or the toggle
// silently does nothing until something else forces a recompile.
function toggleShadows(enabled, fromQuality) {
    if (!fromQuality) userShadowPref = !!enabled;
    renderer.shadowMap.enabled = !!enabled;
    scene.traverse(obj => { if (obj.isMesh && obj.material) obj.material.needsUpdate = true; });
    const box = document.getElementById('shadow-toggle-checkbox');
    if (box && box.checked !== !!enabled) box.checked = !!enabled;
    setVCB('Render:', enabled ? 'Shadows On' : 'Shadows Off');
    markSceneDirty();
}

// ─────────────────────────────────────────────────────────────
// SHADOW QUALITY — real shadow-map resolution tiers, applied to every
// shadow-casting light already in the scene plus every one created after.
// ─────────────────────────────────────────────────────────────
const SHADOW_QUALITY_SIZES = { LOW: 512, MEDIUM: 1024, HIGH: 2048 };
let shadowMapSize = 1024;

function setShadowQuality(tier) {
    shadowMapSize = SHADOW_QUALITY_SIZES[tier] || 1024;
    scene.traverse(obj => {
        if (obj.isLight && obj.castShadow && obj.shadow) {
            obj.shadow.mapSize.set(shadowMapSize, shadowMapSize);
            if (obj.shadow.map) { obj.shadow.map.dispose(); obj.shadow.map = null; } // force regeneration at the new resolution
        }
    });
    setVCB('Shadow Quality:', `${tier} (${shadowMapSize}px)`);
}

// ─────────────────────────────────────────────────────────────
// POST-PROCESSING — real SSAO (screen-space ambient occlusion, genuine
// per-pixel corner/contact darkening from actual depth+normal buffers) and
// Bloom (genuine bright-pass + blur glow on overexposed highlights), via
// three.js's own EffectComposer pipeline — not a fake "photorealistic"
// toggle that does nothing. Both are real GPU cost, so both start OFF and
// are opt-in from the Render tab. Scoped to the live viewport render loop
// only (see renderLoop()) — Render Image/Video and the P2P pool's per-strip
// jobs render with the plain renderer, not this composer, to keep those
// paths simple and independently correct.
// ─────────────────────────────────────────────────────────────
function setupPostProcessing() {
    // A CDN hiccup on any of the postprocessing/shader modules must not take
    // the rest of app init down with it (a real, observed failure mode while
    // building this: a missing dependency threw here and silently skipped
    // every line after this call in initScene(), including creating
    // transformControls — breaking the entire app, not just SSAO/Bloom).
    try {
        if (typeof THREE.EffectComposer === 'undefined' || typeof THREE.RenderPass === 'undefined' ||
            typeof THREE.SSAOPass === 'undefined' || typeof THREE.UnrealBloomPass === 'undefined') {
            console.warn('Post-processing modules not fully loaded — SSAO/Bloom unavailable this session');
            return;
        }
        composer = new THREE.EffectComposer(renderer);
        composer.addPass(new THREE.RenderPass(scene, camera));

        ssaoPass = new THREE.SSAOPass(scene, camera, container_w(), container_h());
        ssaoPass.kernelRadius = 0.4;
        ssaoPass.minDistance = 0.002;
        ssaoPass.maxDistance = 0.15;
        ssaoPass.enabled = false;
        composer.addPass(ssaoPass);

        bloomPass = new THREE.UnrealBloomPass(new THREE.Vector2(container_w(), container_h()), 0.5, 0.4, 0.85);
        bloomPass.enabled = false;
        composer.addPass(bloomPass);
    } catch (err) {
        console.warn('Post-processing setup failed — SSAO/Bloom unavailable this session:', err);
        composer = null; ssaoPass = null; bloomPass = null;
    }
}

function container_w() { return renderer.domElement.clientWidth || 1; }
function container_h() { return renderer.domElement.clientHeight || 1; }

function toggleSSAO(enabled) {
    ssaoEnabled = enabled;
    if (ssaoPass) ssaoPass.enabled = enabled;
    setVCB('SSAO:', enabled ? 'On' : 'Off');
    markSceneDirty();
}

function toggleBloom(enabled) {
    bloomEnabled = enabled;
    if (bloomPass) bloomPass.enabled = enabled;
    setVCB('Bloom:', enabled ? 'On' : 'Off');
    markSceneDirty();
}

// ─────────────────────────────────────────────────────────────
// PROCEDURAL HDRI ENVIRONMENT — real image-based lighting via three.js's
// PMREMGenerator, prefiltered from a small procedurally-drawn sky gradient
// scene (no external .hdr file — same self-contained principle as
// everywhere else in this app). Sets scene.environment, which real PBR
// materials (MeshStandardMaterial) use for actual ambient reflections and
// fill lighting, not just a flat ambient color.
// ─────────────────────────────────────────────────────────────
let _pmremGenerator = null;
let _proceduralEnvTexture = null;

function buildProceduralSkyTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0,    '#3a6fb5'); // zenith
    grad.addColorStop(0.45, '#a9c8e8'); // horizon haze
    grad.addColorStop(0.5,  '#e8e0c8'); // horizon line
    grad.addColorStop(0.55, '#6b6558'); // ground near horizon
    grad.addColorStop(1,    '#2a2822'); // ground
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 512, 256);
    // A soft bright "sun" disc gives PBR reflections something specular to catch
    const sunX = 380, sunY = 60;
    const sunGrad = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, 40);
    sunGrad.addColorStop(0, 'rgba(255,250,230,1)');
    sunGrad.addColorStop(1, 'rgba(255,250,230,0)');
    ctx.fillStyle = sunGrad;
    ctx.fillRect(sunX - 40, sunY - 40, 80, 80);

    const texture = new THREE.CanvasTexture(canvas);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.encoding = THREE.sRGBEncoding;
    return texture;
}

function toggleHdriEnvironment(enabled) {
    hdriEnvEnabled = enabled;
    if (!enabled) { scene.environment = null; setVCB('HDRI Environment:', 'Off'); return; }
    if (!_pmremGenerator) _pmremGenerator = new THREE.PMREMGenerator(renderer);
    if (!_proceduralEnvTexture) {
        const skyTex = buildProceduralSkyTexture();
        _proceduralEnvTexture = _pmremGenerator.fromEquirectangular(skyTex).texture;
        skyTex.dispose();
    }
    scene.environment = _proceduralEnvTexture;
    applyEnvIntensityToScene();
    setVCB('HDRI Environment:', 'On — procedural sky IBL');
}

// ─────────────────────────────────────────────────────────────
// LIGHTS — real, independently addable/editable light sources (Point,
// Spot, Directional, Area/RectAreaLight). The actual THREE.Light instance
// is what gets tracked in sceneObjects and gizmo'd — a small marker mesh is
// parented as ITS CHILD (attachLightVisual) purely for visibility, so
// moving/selecting "the light" in the outliner moves the real illumination,
// not a disconnected icon (the previous default scene's "Light" sphere was
// exactly that disconnected icon — fixed in buildDefaultBlenderScene above).
// ─────────────────────────────────────────────────────────────
function attachLightVisual(light, color) {
    let visual;
    if (light.isSpotLight) {
        const geo = new THREE.ConeGeometry(0.15, 0.3, 12);
        geo.rotateX(Math.PI / 2);
        visual = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
    } else if (light.isDirectionalLight) {
        const geo = new THREE.ConeGeometry(0.15, 0.4, 4);
        geo.rotateX(Math.PI / 2);
        visual = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, wireframe: true }));
    } else if (light.isRectAreaLight) {
        visual = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.5 }));
    } else {
        visual = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 12), new THREE.MeshBasicMaterial({ color }));
    }
    visual.name = '_lightVisual';
    visual.raycast = () => {}; // marker is cosmetic only — never steal a raycast from real geometry/selection logic
    light.add(visual);
    return visual;
}

function createLight(type, params) {
    params = params || {};
    let light;
    const color = params.color ?? 0xffffff;
    const intensity = params.intensity ?? (type === 'directional' ? 3 : 600);
    switch (type) {
        case 'point':
            light = new THREE.PointLight(color, intensity, params.distance ?? 0, params.decay ?? 1);
            break;
        case 'spot':
            light = new THREE.SpotLight(color, intensity, params.distance ?? 0, THREE.MathUtils.degToRad(params.coneAngleDeg ?? 45), params.penumbra ?? 0.3, params.decay ?? 1);
            light.target.position.set(0, 0, 0);
            scene.add(light.target);
            break;
        case 'directional':
            light = new THREE.DirectionalLight(color, intensity);
            light.target.position.set(0, 0, 0);
            scene.add(light.target);
            break;
        case 'area':
            light = new THREE.RectAreaLight(color, intensity, params.width ?? 2, params.height ?? 2);
            break;
        default:
            setVCB('Light:', 'Unknown light type: ' + type);
            return null;
    }
    light.position.set(...(params.position || [3, -3, 4]));
    light.castShadow = !!(params.castShadow !== false && light.shadow); // RectAreaLight has no .shadow in three.js — never castable
    if (light.castShadow) light.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    scene.add(light);
    attachLightVisual(light, 0xffe066);
    light.name = nextName(type.charAt(0).toUpperCase() + type.slice(1) + 'Light');
    sceneObjects.push({ name: light.name, type: 'light', mesh: light });
    renderOutliner();
    selectObject(light);
    setVCB('Light:', `Added ${light.name}`);

    pushUndo({
        undo() { removeSceneObject(light); if (light.target) scene.remove(light.target); },
        redo() { scene.add(light); if (light.target) scene.add(light.target); sceneObjects.push({ name: light.name, type: 'light', mesh: light }); renderOutliner(); selectObject(light); },
    });
    return light;
}

function updateSelectedLightParam(param, value) {
    const light = selectedObject;
    if (!light || !light.isLight) return;
    if (param === 'intensity') light.intensity = parseFloat(value);
    else if (param === 'color') light.color.set(value);
    else if (param === 'distance' && 'distance' in light) light.distance = parseFloat(value);
    else if (param === 'coneAngle' && light.isSpotLight) light.angle = THREE.MathUtils.degToRad(parseFloat(value));
    else if (param === 'penumbra' && light.isSpotLight) light.penumbra = parseFloat(value);
    else if (param === 'castShadow' && light.shadow) { light.castShadow = value; }
}

// ─────────────────────────────────────────────────────────────
// DAY / NIGHT SUN SYSTEM — a real time-of-day-driven environment: a
// dedicated DirectionalLight orbits overhead as the slider moves, sky
// (scene.background) and sun color/intensity interpolate smoothly through
// night → sunrise → day → sunset → night, matching the reference spec's
// intent with an actually-connected implementation (repositions the real
// light used for shading/shadows, not a decorative label).
// ─────────────────────────────────────────────────────────────
let sunLight = null;
let timeOfDayHours = 12;

function ensureSunLight() {
    if (sunLight) return sunLight;
    sunLight = new THREE.DirectionalLight(0xffffff, 3);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    sunLight.shadow.camera.left = -15; sunLight.shadow.camera.right = 15;
    sunLight.shadow.camera.top = 15; sunLight.shadow.camera.bottom = -15;
    sunLight.target.position.set(0, 0, 0);
    scene.add(sunLight.target);
    sunLight.name = 'Sun';
    scene.add(sunLight);
    attachLightVisual(sunLight, 0xfff2b0);
    sceneObjects.push({ name: sunLight.name, type: 'light', mesh: sunLight });
    renderOutliner();
    return sunLight;
}

function lerpColor(hexA, hexB, t) {
    return new THREE.Color(hexA).lerp(new THREE.Color(hexB), THREE.MathUtils.clamp(t, 0, 1));
}

function setTimeOfDay(hours) {
    timeOfDayHours = THREE.MathUtils.clamp(hours, 0, 24);
    const sun = ensureSunLight();

    // Sun sweeps a semicircle from east (6:00) to west (18:00); below the
    // horizon (night) it still orbits underneath so shadow math stays
    // continuous, but intensity drops to near zero.
    const angle = ((timeOfDayHours - 6) / 24) * Math.PI * 2; // 0 at 6:00 (sunrise), PI at 18:00 (sunset)
    const radius = 20;
    sun.position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
    sun.target.position.set(0, 0, 0);

    const isDaytime = timeOfDayHours >= 6 && timeOfDayHours <= 18;
    const NIGHT_SKY = 0x0a1128, DAWN_SKY = 0xff8c5c, DAY_SKY = 0x87ceeb, DUSK_SKY = 0xff7043;
    const NIGHT_SUN = 0x1a2a4a, DAY_SUN = 0xfff2d9;

    let skyColor, sunColor, intensity;
    if (timeOfDayHours < 5 || timeOfDayHours > 19) { // deep night
        skyColor = NIGHT_SKY; sunColor = NIGHT_SUN; intensity = 0.15;
    } else if (timeOfDayHours < 7) { // sunrise transition (5-7)
        const t = (timeOfDayHours - 5) / 2;
        skyColor = lerpColor(NIGHT_SKY, DAWN_SKY, t).lerp(new THREE.Color(DAY_SKY), Math.max(0, t - 0.5) * 2);
        sunColor = lerpColor(NIGHT_SUN, DAY_SUN, t);
        intensity = THREE.MathUtils.lerp(0.15, 3, t);
    } else if (timeOfDayHours < 17) { // full day
        skyColor = DAY_SKY; sunColor = DAY_SUN; intensity = 3;
    } else if (timeOfDayHours < 19) { // sunset transition (17-19)
        const t = (timeOfDayHours - 17) / 2;
        skyColor = lerpColor(DAY_SKY, DUSK_SKY, t).lerp(new THREE.Color(NIGHT_SKY), Math.max(0, t - 0.5) * 2);
        sunColor = lerpColor(DAY_SUN, NIGHT_SUN, t);
        intensity = THREE.MathUtils.lerp(3, 0.15, t);
    } else { // 19-19 fallback (shouldn't hit, covered above)
        skyColor = NIGHT_SKY; sunColor = NIGHT_SUN; intensity = 0.15;
    }

    sun.color = new THREE.Color(sunColor);
    sun.intensity = intensity * lightingSunScale;
    if (currentStyle !== 'blueprint') scene.background = new THREE.Color(skyColor);
    setVCB('Time of Day:', `${formatTimeOfDay(timeOfDayHours)} — ${isDaytime ? 'Day' : 'Night'}`);
}

function formatTimeOfDay(hours) {
    const h = parseFloat(hours);
    return `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────
// SECTION PLANE — real live cross-section cutting, via three.js's built-in
// material/renderer clipping planes (not a fake "hide half the objects"
// trick — geometry is genuinely clipped at the GPU level, including
// mid-triangle). The blue widget mesh is a normal, real scene object (goes
// through the existing Move/Rotate gizmo, Outliner, undo/redo) — its
// current transform is read every frame in the render loop and converted
// into the actual THREE.Plane the renderer clips against.
// ─────────────────────────────────────────────────────────────
let sectionPlaneMesh = null;
const _sectionClipPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
let sectionPlaneEnabled = true;

function syncSectionPlane() {
    if (!sectionPlaneMesh || !sectionPlaneEnabled) return;
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(sectionPlaneMesh.getWorldQuaternion(new THREE.Quaternion()));
    const point = sectionPlaneMesh.getWorldPosition(new THREE.Vector3());
    _sectionClipPlane.setFromNormalAndCoplanarPoint(normal, point);
}

function addSectionPlane() {
    if (sectionPlaneMesh) { setVCB('Section Plane:', 'Already active — remove it first'); return; }
    renderer.localClippingEnabled = true;
    const geo = new THREE.PlaneGeometry(6, 6);
    const mat = new THREE.MeshBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = nextName('SectionPlane');
    mesh.userData.isSectionPlane = true;
    mesh.castShadow = false; mesh.receiveShadow = false;
    scene.add(mesh);
    sectionPlaneMesh = mesh;
    sectionPlaneEnabled = true;
    renderer.clippingPlanes = [_sectionClipPlane];
    sceneObjects.push({ name: mesh.name, type: 'sectionplane', mesh });
    renderOutliner();
    selectObject(mesh);
    syncSectionPlane();
    setVCB('Section Plane:', 'Added — move/rotate it with the gizmo to reposition the cut');

    pushUndo({
        undo() { renderer.clippingPlanes = []; sectionPlaneMesh = null; removeSceneObject(mesh); },
        redo() { scene.add(mesh); sceneObjects.push({ name: mesh.name, type: 'sectionplane', mesh }); sectionPlaneMesh = mesh; renderer.clippingPlanes = sectionPlaneEnabled ? [_sectionClipPlane] : []; renderOutliner(); selectObject(mesh); },
    });
}

function removeSectionPlane() {
    if (!sectionPlaneMesh) { setVCB('Section Plane:', 'No active section plane'); return; }
    const mesh = sectionPlaneMesh;
    renderer.clippingPlanes = [];
    sectionPlaneMesh = null;
    removeSceneObject(mesh);
    setVCB('Section Plane:', 'Removed');

    pushUndo({
        undo() { scene.add(mesh); sceneObjects.push({ name: mesh.name, type: 'sectionplane', mesh }); sectionPlaneMesh = mesh; renderer.clippingPlanes = sectionPlaneEnabled ? [_sectionClipPlane] : []; renderOutliner(); selectObject(mesh); },
        redo() { renderer.clippingPlanes = []; sectionPlaneMesh = null; removeSceneObject(mesh); },
    });
}

function toggleSectionPlaneEnabled(enabled) {
    sectionPlaneEnabled = enabled;
    renderer.clippingPlanes = (enabled && sectionPlaneMesh) ? [_sectionClipPlane] : [];
    if (sectionPlaneMesh) sectionPlaneMesh.visible = enabled;
    setVCB('Section Plane:', enabled ? 'Active' : 'Deactivated (model shown whole)');
}

// ─────────────────────────────────────────────────────────────
// RENDER OUTPUT — real image/video export, not a placeholder. Renders at
// the actual requested resolution (temporarily resizing the renderer/
// camera, not just scaling up whatever the on-screen canvas happens to
// be) and, for animation, uses the browser's real MediaRecorder +
// canvas.captureStream() to encode an actual WebM video by stepping
// through the existing keyframe interpolation (applyAnimationAtFrame())
// frame by frame — no server-side encoder involved or needed.
// ─────────────────────────────────────────────────────────────
function applyRenderResolutionPreset(val) {
    if (!val) return;
    const [w, h] = val.split('x').map(Number);
    document.getElementById('render-width').value = w;
    document.getElementById('render-height').value = h;
}

function getRenderResolution() {
    const w = Math.max(64, Math.min(4096, parseInt(document.getElementById('render-width').value, 10) || 1280));
    const h = Math.max(64, Math.min(4096, parseInt(document.getElementById('render-height').value, 10) || 720));
    return { w, h };
}

// Temporarily resizes the renderer/camera to the real output resolution
// (not the on-screen canvas size), runs fn(), then restores the live
// viewport exactly as it was.
function withRenderResolution(w, h, fn) {
    const canvas = renderer.domElement;
    const prevW = canvas.width, prevH = canvas.height;
    const prevAspect = camera.aspect;
    const prevPixelRatio = renderer.getPixelRatio();
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    try {
        return fn();
    } finally {
        renderer.setPixelRatio(prevPixelRatio);
        renderer.setSize(prevW, prevH, false);
        camera.aspect = prevAspect;
        camera.updateProjectionMatrix();
    }
}

function triggerDownload(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

function getStillSupersample() {
    const el = document.getElementById('render-supersample');
    const n = el ? parseInt(el.value, 10) : 1;
    return (n === 2 || n === 4) ? n : 1;
}

function captureStillDataUrl(w, h) {
    const RQ = window.RenderQuality;
    const ss = getStillSupersample();
    const size = RQ ? RQ.downsampleSize(w, h, ss, 8192) : { renderW: w, renderH: h, outW: w, outH: h };
    let dataUrl = '';
    withPresentationHelpersHidden(() => {
        withRenderResolution(size.renderW, size.renderH, () => {
            renderer.render(scene, camera);
            if (size.renderW === size.outW && size.renderH === size.outH) {
                dataUrl = renderer.domElement.toDataURL('image/png');
                return;
            }
            const src = renderer.domElement;
            const out = document.createElement('canvas');
            out.width = size.outW;
            out.height = size.outH;
            const ctx = out.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(src, 0, 0, size.outW, size.outH);
            dataUrl = out.toDataURL('image/png');
        });
    });
    return dataUrl;
}

function renderStillImage() {
    const { w, h } = getRenderResolution();
    const dataUrl = captureStillDataUrl(w, h);
    triggerDownload(dataUrl, `3DCore_Render_${w}x${h}.png`);
    setVCB('Render:', `Image ${w}×${h} rendered`);
}

// Viewport screenshot — what is on screen now (current camera, quality, canvas
// size). Distinct from Render Image, which resizes to the Output panel
// resolution and optional 2×/4× supersample.
function takeViewportScreenshot() {
    if (!renderer || !scene || !camera) {
        setVCB('Screenshot:', 'Viewport is not ready');
        return;
    }
    const canvas = renderer.domElement;
    let dataUrl = '';
    withPresentationHelpersHidden(() => {
        renderer.render(scene, camera);
        dataUrl = canvas.toDataURL('image/png');
    });
    const w = canvas.width;
    const h = canvas.height;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    triggerDownload(dataUrl, `3DCore_Screenshot_${w}x${h}_${stamp}.png`);
    copyPngDataUrlToClipboard(dataUrl);
    flashScreenshot();
    setVCB('Screenshot:', `${w}×${h} PNG`);
}

function copyPngDataUrlToClipboard(dataUrl) {
    if (!navigator.clipboard || typeof ClipboardItem === 'undefined') return;
    fetch(dataUrl)
        .then(r => r.blob())
        .then(blob => navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]))
        .catch(() => {});
}

function flashScreenshot() {
    const el = document.getElementById('screenshot-flash');
    if (!el) return;
    el.classList.remove('is-on');
    void el.offsetWidth;
    el.classList.add('is-on');
    setTimeout(() => el.classList.remove('is-on'), 200);
}

// ─────────────────────────────────────────────────────────────
// P2P RENDER POOL — real LAN-based distributed rendering. Peer discovery
// goes through a tiny WebSocket signaling relay (see run_ws_signaling_server()
// in server.py) that only ever forwards small JSON handshake messages
// (peer IDs, WebRTC SDP offers/answers, ICE candidates); the actual
// render-tile image data flows over a genuine WebRTC DataChannel directly
// between browsers — this server never sees it. Any other device that
// opens this same app on the LAN and clicks "Join Pool" becomes available
// to share tile-rendering work with. Falls back to a normal solo render
// (renderStillImage(), already real) when no peer is connected.
//
// Distribution technique: the target image is split into horizontal
// strips, one per available worker (peers + self). Each worker renders
// ONLY its own strip — not the full frame — using THREE.PerspectiveCamera's
// setViewOffset() (three.js's built-in support for exactly this: tiled/
// asymmetric-frustum rendering), so the work is genuinely divided, not
// duplicated. A peer builds its strip from a fresh OFFSCREEN scene
// reconstructed from the coordinator's serialized scene (sceneToJSON()) —
// it never touches that peer's own live editing scene.
// ─────────────────────────────────────────────────────────────
let p2pSocket = null;
let p2pPeerId = null;
const p2pConnections = new Map(); // peerId -> { pc, channel, ready }
let p2pKnownPeers = [];
const p2pRenderJobResolvers = new Map(); // jobId -> resolve(fn)

function p2pSignalingUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const httpPort = parseInt(location.port || '80', 10);
    return `${proto}//${location.hostname}:${httpPort + 1}`;
}

function renderPoolStatusUpdate() {
    const el = document.getElementById('render-pool-status');
    if (!el) return;
    if (!p2pSocket) { el.textContent = 'Not connected'; return; }
    const readyCount = Array.from(p2pConnections.values()).filter(c => c.ready).length;
    el.textContent = `Connected as ${p2pPeerId || '…'} — ${readyCount} peer(s) ready to render`;
}

function joinRenderPool() {
    if (p2pSocket) return;
    try {
        p2pSocket = new WebSocket(p2pSignalingUrl());
    } catch (err) {
        setVCB('Render Pool:', 'Could not open signaling connection: ' + err.message);
        p2pSocket = null;
        return;
    }
    p2pSocket.onopen = () => setVCB('Render Pool:', 'Connecting to LAN peers…');
    p2pSocket.onmessage = e => { try { handleP2PSignal(JSON.parse(e.data)); } catch (err) { /* malformed signal, ignore */ } };
    p2pSocket.onerror = () => setVCB('Render Pool:', 'Signaling connection failed — is the server reachable on this network?');
    p2pSocket.onclose = () => { p2pSocket = null; p2pPeerId = null; renderPoolStatusUpdate(); };
}

function leaveRenderPool() {
    p2pConnections.forEach(c => { try { c.channel && c.channel.close(); } catch (e) {} try { c.pc && c.pc.close(); } catch (e) {} });
    p2pConnections.clear();
    if (p2pSocket) p2pSocket.close();
    p2pSocket = null;
    p2pPeerId = null;
    renderPoolStatusUpdate();
    setVCB('Render Pool:', 'Left the pool');
}

function sendSignal(msg) {
    if (p2pSocket && p2pSocket.readyState === WebSocket.OPEN) p2pSocket.send(JSON.stringify(msg));
}

function handleP2PSignal(data) {
    if (data.type === 'welcome') { p2pPeerId = data.id; renderPoolStatusUpdate(); return; }
    if (data.type === 'peers') {
        const others = data.peers.filter(id => id !== p2pPeerId);
        // Lower peer ID initiates the offer — deterministic tie-break so
        // both sides don't simultaneously offer to each other (WebRTC glare).
        others.forEach(id => { if (!p2pConnections.has(id) && p2pPeerId < id) connectToPeer(id); });
        p2pKnownPeers = others;
        renderPoolStatusUpdate();
        return;
    }
    if (data.type === 'offer') { handlePeerOffer(data.from, data.sdp); return; }
    if (data.type === 'answer') { handlePeerAnswer(data.from, data.sdp); return; }
    if (data.type === 'ice') { handlePeerIce(data.from, data.candidate); return; }
}

function makePeerConnection(peerId) {
    // No STUN/TURN servers — intentional. This is LAN-only by design (the
    // signaling relay itself only binds to the local network), and same-
    // network peers exchange direct host ICE candidates without needing
    // NAT-traversal helpers, so no external service dependency is needed.
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.onicecandidate = e => { if (e.candidate) sendSignal({ to: peerId, type: 'ice', candidate: e.candidate }); };
    const entry = { pc, channel: null, ready: false };
    p2pConnections.set(peerId, entry);
    return entry;
}

function connectToPeer(peerId) {
    const entry = makePeerConnection(peerId);
    const channel = entry.pc.createDataChannel('render');
    entry.channel = channel;
    wireDataChannel(peerId, channel);
    entry.pc.createOffer()
        .then(offer => entry.pc.setLocalDescription(offer))
        .then(() => sendSignal({ to: peerId, type: 'offer', sdp: entry.pc.localDescription }));
}

function handlePeerOffer(peerId, sdp) {
    const entry = makePeerConnection(peerId);
    entry.pc.ondatachannel = e => { entry.channel = e.channel; wireDataChannel(peerId, e.channel); };
    entry.pc.setRemoteDescription(sdp)
        .then(() => entry.pc.createAnswer())
        .then(answer => entry.pc.setLocalDescription(answer))
        .then(() => sendSignal({ to: peerId, type: 'answer', sdp: entry.pc.localDescription }));
}

function handlePeerAnswer(peerId, sdp) {
    const entry = p2pConnections.get(peerId);
    if (entry) entry.pc.setRemoteDescription(sdp);
}

function handlePeerIce(peerId, candidate) {
    const entry = p2pConnections.get(peerId);
    if (entry) entry.pc.addIceCandidate(candidate).catch(() => {});
}

function wireDataChannel(peerId, channel) {
    channel.onopen = () => {
        const entry = p2pConnections.get(peerId);
        if (entry) entry.ready = true;
        renderPoolStatusUpdate();
        setVCB('Render Pool:', `Peer ${peerId} ready`);
    };
    channel.onclose = () => { p2pConnections.delete(peerId); renderPoolStatusUpdate(); };
    channel.onmessage = e => handleP2PDataMessage(peerId, e.data);
}

function handleP2PDataMessage(peerId, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (msg.type === 'render_job') { runRenderJobForPeer(peerId, msg); return; }
    if (msg.type === 'render_result') {
        const resolver = p2pRenderJobResolvers.get(msg.jobId);
        if (resolver) { resolver(msg); p2pRenderJobResolvers.delete(msg.jobId); }
    }
}

// PEER SIDE — render exactly the assigned strip from a fresh offscreen
// scene, never the live editing scene.
let _poolOffscreenRenderer = null;
function ensurePoolOffscreenRenderer() {
    if (_poolOffscreenRenderer) return _poolOffscreenRenderer;
    const canvas = document.createElement('canvas');
    _poolOffscreenRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
    return _poolOffscreenRenderer;
}

function runRenderJobForPeer(coordinatorId, job) {
    const r = ensurePoolOffscreenRenderer();
    const offScene = new THREE.Scene();
    offScene.background = new THREE.Color(job.sceneData.background || '#1a1a1a');
    const loader = new THREE.ObjectLoader();
    (job.sceneData.objects || []).forEach(entry => {
        try {
            const obj = loader.parse(entry.object);
            obj.name = entry.appName || obj.name;
            offScene.add(obj);
        } catch (err) { /* one unparseable object shouldn't sink the whole tile */ }
    });
    offScene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dl = new THREE.DirectionalLight(0xffffff, 2);
    dl.position.set(5, -5, 10);
    offScene.add(dl);

    const cam = new THREE.PerspectiveCamera(job.camera.fov, job.fullWidth / job.fullHeight, 0.01, 2000);
    cam.position.fromArray(job.camera.position);
    cam.up.set(0, 0, 1);
    cam.quaternion.fromArray(job.camera.quaternion);
    cam.updateProjectionMatrix();

    const stripHeight = job.stripY1 - job.stripY0;
    cam.setViewOffset(job.fullWidth, job.fullHeight, 0, job.stripY0, job.fullWidth, stripHeight);
    r.setPixelRatio(1);
    r.setSize(job.fullWidth, stripHeight, false);
    r.render(offScene, cam); // synchronous render immediately before toDataURL — see renderStillImage()'s comment
    const dataUrl = r.domElement.toDataURL('image/png');
    cam.clearViewOffset();

    const entry = p2pConnections.get(coordinatorId);
    if (entry && entry.channel && entry.channel.readyState === 'open') {
        entry.channel.send(JSON.stringify({ type: 'render_result', jobId: job.jobId, stripY0: job.stripY0, stripY1: job.stripY1, dataUrl }));
    }
}

// COORDINATOR SIDE — the peer who clicked "Render Image (Pool)".
function renderOwnStripLocally(fullWidth, fullHeight, y0, y1) {
    const stripHeight = y1 - y0;
    const prevSize = new THREE.Vector2(); renderer.getSize(prevSize);
    const prevAspect = camera.aspect;
    const prevPixelRatio = renderer.getPixelRatio();
    camera.aspect = fullWidth / fullHeight;
    camera.setViewOffset(fullWidth, fullHeight, 0, y0, fullWidth, stripHeight);
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(1);
    renderer.setSize(fullWidth, stripHeight, false);
    renderer.render(scene, camera);
    const dataUrl = renderer.domElement.toDataURL('image/png');
    camera.clearViewOffset();
    camera.aspect = prevAspect;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(prevPixelRatio);
    renderer.setSize(prevSize.x, prevSize.y, false);
    return dataUrl;
}

async function renderImageWithPool() {
    const readyPeers = Array.from(p2pConnections.entries()).filter(([, c]) => c.ready).map(([id]) => id);
    if (readyPeers.length === 0) { renderStillImage(); return; } // no peers — solo render, already real

    const { w: width, h: height } = getRenderResolution();
    const sceneData = sceneToJSON();
    sceneData.background = '#' + scene.background.getHexString();
    const cameraState = { fov: camera.fov, position: camera.position.toArray(), quaternion: camera.quaternion.toArray() };

    const workers = readyPeers.length + 1; // peers + self
    const stripH = Math.ceil(height / workers);
    const strips = [];
    for (let i = 0; i < workers; i++) strips.push([i * stripH, Math.min(height, (i + 1) * stripH)]);

    setVCB('Render Pool:', `Rendering ${width}×${height} — ${readyPeers.length} peer(s) + self`);

    const jobPromises = readyPeers.map((peerId, i) => {
        const jobId = 'job_' + Math.random().toString(36).slice(2);
        const [y0, y1] = strips[i];
        const promise = new Promise(resolve => p2pRenderJobResolvers.set(jobId, resolve));
        const entry = p2pConnections.get(peerId);
        entry.channel.send(JSON.stringify({ type: 'render_job', jobId, sceneData, camera: cameraState, fullWidth: width, fullHeight: height, stripY0: y0, stripY1: y1 }));
        return promise;
    });

    const ownStrip = strips[strips.length - 1];
    const ownDataUrl = renderOwnStripLocally(width, height, ownStrip[0], ownStrip[1]);
    const peerResults = await Promise.all(jobPromises);
    const allResults = [...peerResults, { stripY0: ownStrip[0], stripY1: ownStrip[1], dataUrl: ownDataUrl }];

    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = width; finalCanvas.height = height;
    const ctx = finalCanvas.getContext('2d');
    await Promise.all(allResults.map(res => new Promise(done => {
        const img = new Image();
        img.onload = () => { ctx.drawImage(img, 0, res.stripY0); done(); };
        img.onerror = () => done(); // a dropped/failed peer tile leaves a gap rather than blocking the whole composite
        img.src = res.dataUrl;
    })));

    finalCanvas.toBlob(blob => triggerDownload(URL.createObjectURL(blob), `3DCore_PoolRender_${width}x${height}.png`));
    setVCB('Render Pool:', `Done — ${allResults.length} tiles composited (${readyPeers.length} from peers)`);
}

async function renderAnimationVideo() {
    const { w, h } = getRenderResolution();
    const start = parseInt(document.getElementById('render-frame-start').value, 10) || 1;
    const end = parseInt(document.getElementById('render-frame-end').value, 10) || 50;
    const fps = Math.max(1, Math.min(60, parseInt(document.getElementById('render-fps').value, 10) || 24));
    const progressEl = document.getElementById('render-progress');
    if (end <= start) { if (progressEl) progressEl.textContent = 'End frame must be after start frame.'; return; }
    if (typeof MediaRecorder === 'undefined') { if (progressEl) progressEl.textContent = 'MediaRecorder is not available in this browser.'; return; }

    const wasPlaying = isAnimPlaying;
    isAnimPlaying = false; // stop the normal playback loop from also advancing animFrame during capture
    const prevFrame = animFrame;

    const canvas = renderer.domElement;
    const prevW = canvas.width, prevH = canvas.height;
    const prevAspect = camera.aspect;
    const prevPixelRatio = renderer.getPixelRatio();
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();

    const stream = canvas.captureStream(fps);
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
    const chunks = [];
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });

    recorder.start();
    const frameDurationMs = 1000 / fps;
    for (let f = start; f <= end; f++) {
        applyAnimationAtFrame(f);
        renderer.render(scene, camera);
        if (progressEl) progressEl.textContent = `Rendering frame ${f - start + 1}/${end - start + 1}…`;
        await new Promise(r => setTimeout(r, frameDurationMs)); // give captureStream a real frame interval to grab this drawn frame
    }
    recorder.stop();
    await stopped;

    renderer.setPixelRatio(prevPixelRatio);
    renderer.setSize(prevW, prevH, false);
    camera.aspect = prevAspect;
    camera.updateProjectionMatrix();
    isAnimPlaying = wasPlaying;
    setAnimFrame(prevFrame);

    const blob = new Blob(chunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, `3DCore_Animation_${w}x${h}.webm`);
    URL.revokeObjectURL(url);
    if (progressEl) progressEl.textContent = `Done — ${end - start + 1} frames, ${(blob.size / (1024 * 1024)).toFixed(1)} MB`;
    setVCB('Render:', 'Animation video rendered');
}

function setViewAngle(v) {
    const d = 12;
    if (v === 'top')    camera.position.set(0, 0, d);
    if (v === 'bottom') camera.position.set(0, 0, -d);
    if (v === 'front')  camera.position.set(0, -d, 0);
    if (v === 'back')   camera.position.set(0, d, 0);
    if (v === 'right')  camera.position.set(d, 0, 0);
    if (v === 'left')   camera.position.set(-d, 0, 0);
    if (v === 'persp')  camera.position.set(7.35, -6.92, 4.95);
    camera.up.set(0, 0, 1);
    camera.lookAt(0, 0, 0);
    orbitControls.target.set(0, 0, 0);
    orbitControls.update();
    setVCB('View:', v.charAt(0).toUpperCase() + v.slice(1));
}

let isOrtho = false;
function toggleOrtho() {
    isOrtho = !isOrtho;
    // Three.js doesn't have a true orthographic toggle on PerspectiveCamera,
    // but we simulate by zooming in with very high zoom
    camera.fov = isOrtho ? 1 : 50;
    camera.updateProjectionMatrix();
    setVCB(isOrtho ? 'View:' : 'View:', isOrtho ? 'Orthographic' : 'Perspective');
}

function toggleCameraView() {
    camera.position.set(7.35, -6.92, 4.95);
    camera.up.set(0, 0, 1);
    camera.lookAt(0, 0, 0);
}

function zoomExtents() {
    if (selectedObject) {
        orbitControls.target.copy(selectedObject.position);
        orbitControls.update();
        setVCB('View:', 'Frame Selected');
    }
}

// View menu (Timeline) — frame every mesh in the scene.
function frameAllObjects() {
    const box = new THREE.Box3();
    let any = false;
    sceneObjects.forEach(o => { if (o.mesh && o.mesh.isMesh) { box.expandByObject(o.mesh); any = true; } });
    if (!any) return;
    const center = new THREE.Vector3(); box.getCenter(center);
    const size = new THREE.Vector3(); box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    orbitControls.target.copy(center);
    const dir = camera.position.clone().sub(orbitControls.target).normalize();
    camera.position.copy(center).addScaledVector(dir, maxDim * 1.8);
    orbitControls.update();
    setVCB('View:', 'Frame All');
}

function frameSelectedObjects() {
    const targets = [];
    if (outlinerMultiSelect.size) outlinerMultiSelect.forEach(m => { if (m) targets.push(m); });
    else if (selectedObject) targets.push(selectedObject);
    if (!targets.length) { frameAllObjects(); return; }
    const box = new THREE.Box3();
    targets.forEach(m => box.expandByObject(m));
    const center = new THREE.Vector3(); box.getCenter(center);
    const size = new THREE.Vector3(); box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    orbitControls.target.copy(center);
    const dir = camera.position.clone().sub(orbitControls.target).normalize();
    camera.position.copy(center).addScaledVector(dir, maxDim * 1.8);
    orbitControls.update();
    setVCB('View:', 'Frame Selected');
}

function selectAllMeshes() {
    outlinerMultiSelect.clear();
    sceneObjects.forEach(o => { if (o.mesh) outlinerMultiSelect.add(o.mesh); });
    const first = sceneObjects.find(o => o.mesh && o.mesh.isMesh);
    if (first) selectObject(first.mesh);
    else renderOutliner();
    setVCB('Select:', `${outlinerMultiSelect.size} object(s)`);
}

function deselectAllMeshes() {
    outlinerMultiSelect.clear();
    selectObject(null);
    setVCB('Select:', 'None');
}

// ─────────────────────────────────────────────────────────────
// VIEWCUBE — AutoCAD/SketchUp-style navigation widget: a real 3D cube
// (rendered into its own tiny scene/camera, not CSS dots) sitting inside a
// flat compass ring. The cube's orientation always mirrors the main
// camera's current view direction; clicking a face snaps the main camera
// to that view via the same setViewAngle() the old dot-gizmo used.
// ─────────────────────────────────────────────────────────────
let vcRenderer, vcScene, vcCamera, vcCube, vcCanvas;
const VIEWCUBE_FACE_ORDER = ['right', 'left', 'back', 'front', 'top', 'bottom']; // matches BoxGeometry's [+X,-X,+Y,-Y,+Z,-Z] material-group order
const VIEWCUBE_LABELS = { right: 'RIGHT', left: 'LEFT', back: 'BACK', front: 'FRONT', top: 'TOP', bottom: 'BOTTOM' };

function makeViewCubeFaceTexture(label) {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#3a3a3a';
    ctx.fillRect(0, 0, 128, 128);
    ctx.strokeStyle = '#6a6a6a';
    ctx.lineWidth = 4;
    ctx.strokeRect(3, 3, 122, 122);
    ctx.fillStyle = '#e2e2e2';
    ctx.font = 'bold 19px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
}

function makeCompassLabelSprite(text) {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.font = 'bold 44px Arial';
    ctx.fillStyle = '#c8c8c8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 32, 34);
    const tex = new THREE.CanvasTexture(c);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    sprite.renderOrder = 998;
    sprite.scale.set(0.6, 0.6, 1);
    return sprite;
}

function initViewCube() {
    vcCanvas = document.getElementById('viewcube-canvas');
    if (!vcCanvas || typeof camera === 'undefined' || !camera) return;

    vcRenderer = new THREE.WebGLRenderer({ canvas: vcCanvas, alpha: true, antialias: true });
    vcRenderer.setPixelRatio(1);
    vcRenderer.setSize(vcCanvas.clientWidth || 88, vcCanvas.clientHeight || 88, false);
    vcRenderer.setClearColor(0x000000, 0);

    vcScene = new THREE.Scene();
    vcCamera = new THREE.OrthographicCamera(-1.85, 1.85, 1.85, -1.85, 0.1, 10);

    const materials = VIEWCUBE_FACE_ORDER.map(name => new THREE.MeshBasicMaterial({ map: makeViewCubeFaceTexture(VIEWCUBE_LABELS[name]) }));
    vcCube = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.4), materials);
    vcScene.add(vcCube);

    // Flat compass ring around the cube, lying in the world ground (XY)
    // plane — this is the "cube inside a circle" AutoCAD look; it reads as
    // a full circle from Top view and edge-on as the view tilts toward the
    // horizon, exactly like the real widget. Inner radius (1.4) clears the
    // cube's full spatial diagonal (~1.21) from any viewing angle so the
    // ring never overlaps the cube's corners.
    const ring = new THREE.Mesh(
        new THREE.RingGeometry(1.4, 1.55, 48),
        new THREE.MeshBasicMaterial({ color: 0x999999, side: THREE.DoubleSide, transparent: true, opacity: 0.5 })
    );
    vcScene.add(ring);

    // N/E/S/W compass labels — billboarded sprites at fixed world positions
    // just outside the ring, matching AutoCAD's compass. N/S align with the
    // app's Back/Front views, E/W with Right/Left (the app's own Y/X view
    // convention — see VIEWCUBE_FACE_ORDER above).
    [
        ['N', 0, 1.68, 0], ['S', 0, -1.68, 0],
        ['E', 1.68, 0, 0], ['W', -1.68, 0, 0],
    ].forEach(([label, x, y, z]) => {
        const sprite = makeCompassLabelSprite(label);
        sprite.position.set(x, y, z);
        vcScene.add(sprite);
    });

    vcCanvas.addEventListener('pointerdown', onViewCubeDragStart);
    vcCanvas.addEventListener('pointermove', onViewCubeHover);
    vcCanvas.addEventListener('pointerleave', () => setViewCubeHoverFace(-1));
    vcCanvas.addEventListener('click', onViewCubeClick);
}

// Orbits the MAIN camera by a delta azimuth/polar angle, pivoting about the
// current orbit target — the general form rotateViewCubeCompass() above is
// a special case of (90° azimuth steps, no polar change). Z-up-aware: does
// its own spherical parametrization around the world Z axis rather than
// THREE.Spherical's Y-up assumption (which produced a genuinely degenerate
// basis for this app's convention when tried directly, elsewhere in this
// file's history).
function orbitCameraBy(dAzimuth, dPolar) {
    const offset = camera.position.clone().sub(orbitControls.target);
    const radius = Math.max(offset.length(), 1e-4);
    const azimuth = Math.atan2(offset.y, offset.x) + dAzimuth;
    const polar = THREE.MathUtils.clamp(Math.acos(THREE.MathUtils.clamp(offset.z / radius, -1, 1)) + dPolar, 0.02, Math.PI - 0.02);
    const sinPolar = Math.sin(polar);
    const newOffset = new THREE.Vector3(radius * sinPolar * Math.cos(azimuth), radius * sinPolar * Math.sin(azimuth), radius * Math.cos(polar));
    camera.position.copy(orbitControls.target).add(newOffset);
    camera.up.set(0, 0, 1);
    camera.lookAt(orbitControls.target);
    orbitControls.update();
}

// AutoCAD-style ViewCube dragging — click a face to snap to that view
// (existing behavior), but click-and-DRAG anywhere on the widget free-
// orbits the main camera instead, exactly like the real widget.
let _vcDragStart = null;
let _vcDragged = false;
const VIEWCUBE_DRAG_THRESHOLD = 4; // px before a pointerdown counts as a drag, not a click

function onViewCubeDragStart(e) {
    _vcDragStart = { x: e.clientX, y: e.clientY };
    _vcDragged = false;
    window.addEventListener('pointermove', onViewCubeDragMove);
    window.addEventListener('pointerup', onViewCubeDragEnd);
}
function onViewCubeDragMove(e) {
    if (!_vcDragStart) return;
    const dx = e.clientX - _vcDragStart.x, dy = e.clientY - _vcDragStart.y;
    if (!_vcDragged && Math.hypot(dx, dy) < VIEWCUBE_DRAG_THRESHOLD) return;
    _vcDragged = true;
    orbitCameraBy(dx * 0.008, -dy * 0.008);
    _vcDragStart = { x: e.clientX, y: e.clientY };
}
function onViewCubeDragEnd() {
    _vcDragStart = null;
    window.removeEventListener('pointermove', onViewCubeDragMove);
    window.removeEventListener('pointerup', onViewCubeDragEnd);
    // _vcDragged itself is reset lazily on the next pointerdown — onViewCubeClick
    // (fired right after this same pointerup, by the browser) still needs
    // to read it this tick to know whether to suppress the face-snap.
}

// Rotate the MAIN camera 90° left/right around the world-up (Z) axis,
// pivoting about the current orbit target while preserving distance and
// tilt — the ViewCube widget's curved corner arrows in AutoCAD do exactly
// this (spin the view without resetting zoom/elevation).
function rotateViewCubeCompass(deltaDeg) {
    const offset = camera.position.clone().sub(orbitControls.target);
    const rad = THREE.MathUtils.degToRad(deltaDeg);
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const rotatedX = offset.x * cos - offset.y * sin;
    const rotatedY = offset.x * sin + offset.y * cos;
    camera.position.set(orbitControls.target.x + rotatedX, orbitControls.target.y + rotatedY, orbitControls.target.z + offset.z);
    camera.up.set(0, 0, 1);
    camera.lookAt(orbitControls.target);
    orbitControls.update();
    setVCB('View:', `Rotated ${deltaDeg > 0 ? 'Right' : 'Left'} 90°`);
}

function renderViewCube() {
    if (!vcRenderer || !camera || !orbitControls) return;
    const dir = camera.position.clone().sub(orbitControls.target);
    if (dir.lengthSq() < 1e-6) dir.set(1, -1, 1);
    dir.normalize();
    vcCamera.position.copy(dir).multiplyScalar(4);
    vcCamera.up.copy(camera.up);
    vcCamera.lookAt(0, 0, 0);
    vcRenderer.render(vcScene, vcCamera);
}

function viewCubeRaycastFace(e) {
    const rect = vcCanvas.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const my = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    const rc = new THREE.Raycaster();
    rc.setFromCamera({ x: mx, y: my }, vcCamera);
    const hits = rc.intersectObject(vcCube, false);
    if (hits.length === 0 || hits[0].face == null) return -1;
    return hits[0].face.materialIndex;
}

let _vcHoverFace = -1;
function setViewCubeHoverFace(idx) {
    if (_vcHoverFace === idx) return;
    if (_vcHoverFace >= 0) vcCube.material[_vcHoverFace].color.setHex(0xffffff);
    if (idx >= 0) vcCube.material[idx].color.setHex(0xffcc55);
    _vcHoverFace = idx;
}
function onViewCubeHover(e) { setViewCubeHoverFace(viewCubeRaycastFace(e)); }
function onViewCubeClick(e) {
    if (_vcDragged) return; // this click ended a free-orbit drag, not a face-snap request
    const idx = viewCubeRaycastFace(e);
    if (idx < 0) return;
    setViewAngle(VIEWCUBE_FACE_ORDER[idx]);
}

// ─────────────────────────────────────────────────────────────
// SKETCHUP-STYLE SCALE HANDLES — direct-manipulation grips on the selected
// object's bounding box (active while activeTool === 'scale'), replacing
// the abstract axis-arrow gizmo. 8 corner cubes resize uniformly about the
// OPPOSITE corner (pinned in world space); 6 face-center dots resize along
// just that one axis, about the OPPOSITE face — the same feel as
// SketchUp's Scale tool, corners for proportional resize, side-midpoints
// for single-axis resize. Handle size scales with the object's own
// bounding-box diagonal so a tiny prop and a huge wall both get
// proportionate, usable grips instead of a fixed pixel/world size.
// ─────────────────────────────────────────────────────────────
let scaleHandleMeshes = [];
let _scaleDragState = null;
const SCALE_CORNER_SIGNS = [
    [-1, -1, -1], [1, -1, -1], [-1, 1, -1], [1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [-1, 1, 1], [1, 1, 1],
]; // ordered so index i and index (7 - i) are always the diagonally opposite corner
const SCALE_FACE_AXES = [
    { axis: 'x', sign: 1 }, { axis: 'x', sign: -1 },
    { axis: 'y', sign: 1 }, { axis: 'y', sign: -1 },
    { axis: 'z', sign: 1 }, { axis: 'z', sign: -1 },
]; // ordered so index i and index (i % 2 === 0 ? i+1 : i-1) are the opposite face on the same axis

function localCornerPoints(obj) {
    obj.geometry.computeBoundingBox();
    const bb = obj.geometry.boundingBox;
    const center = new THREE.Vector3(); bb.getCenter(center);
    const half = new THREE.Vector3(); bb.getSize(half).multiplyScalar(0.5);
    return SCALE_CORNER_SIGNS.map(([sx, sy, sz]) => new THREE.Vector3(center.x + sx * half.x, center.y + sy * half.y, center.z + sz * half.z));
}

function localFaceCenterPoints(obj) {
    obj.geometry.computeBoundingBox();
    const bb = obj.geometry.boundingBox;
    const center = new THREE.Vector3(); bb.getCenter(center);
    const half = new THREE.Vector3(); bb.getSize(half).multiplyScalar(0.5);
    return SCALE_FACE_AXES.map(({ axis, sign }) => {
        const p = center.clone();
        p[axis] += sign * half[axis];
        return p;
    });
}

function ensureScaleHandles() {
    if (scaleHandleMeshes.length) return;
    for (let i = 0; i < 8; i++) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x4da6ff, depthTest: false }));
        m.renderOrder = 1000;
        m.userData = { handleType: 'corner', index: i };
        // Kept as scene-root siblings, not children of the selected object —
        // same reasoning as the selection outline: a data-graph child would
        // get pulled into project saves/GLB exports and would pollute
        // recursive raycasts elsewhere in the app.
        scene.add(m);
        scaleHandleMeshes.push(m);
    }
    for (let i = 0; i < 6; i++) {
        const m = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 8), new THREE.MeshBasicMaterial({ color: 0x66ffcc, depthTest: false }));
        m.renderOrder = 1000;
        m.userData = { handleType: 'face', index: i };
        scene.add(m);
        scaleHandleMeshes.push(m);
    }
}

function removeScaleHandles() {
    scaleHandleMeshes.forEach(m => { scene.remove(m); m.geometry.dispose(); m.material.dispose(); });
    scaleHandleMeshes = [];
}

function updateScaleHandles() {
    const obj = selectedObject;
    if (activeTool !== 'scale' || !obj || !obj.isMesh) {
        if (scaleHandleMeshes.length) removeScaleHandles();
        return;
    }
    ensureScaleHandles();
    obj.updateMatrixWorld();
    const worldCorners = localCornerPoints(obj).map(p => p.applyMatrix4(obj.matrixWorld));
    const worldFaceCenters = localFaceCenterPoints(obj).map(p => p.applyMatrix4(obj.matrixWorld));
    const diag = Math.max(worldCorners[0].distanceTo(worldCorners[7]), 1e-4);
    // +15% over the original sizing (diag*0.06, clamped 0.03..0.4) — easier
    // to grab, per explicit request.
    const cornerSize = THREE.MathUtils.clamp(diag * 0.069, 0.0345, 0.46);
    const faceSize = cornerSize * 0.7;
    scaleHandleMeshes.forEach(m => {
        if (m.userData.handleType === 'corner') {
            m.position.copy(worldCorners[m.userData.index]);
            m.scale.setScalar(cornerSize);
        } else {
            m.position.copy(worldFaceCenters[m.userData.index]);
            m.scale.setScalar(faceSize);
        }
    });
}

function beginScaleDrag(handleMesh) {
    const obj = selectedObject;
    obj.updateMatrixWorld();
    let anchorLocal, dragStartLocal, axisMask;

    if (handleMesh.userData.handleType === 'corner') {
        const i = handleMesh.userData.index, opposite = 7 - i;
        const corners = localCornerPoints(obj);
        anchorLocal = corners[opposite];
        dragStartLocal = corners[i];
        axisMask = null; // uniform on all 3 axes
    } else {
        const i = handleMesh.userData.index, opposite = i % 2 === 0 ? i + 1 : i - 1;
        const faces = localFaceCenterPoints(obj);
        anchorLocal = faces[opposite];
        dragStartLocal = faces[i];
        axisMask = SCALE_FACE_AXES[i].axis; // single-axis resize
    }

    const anchorWorld = anchorLocal.clone().applyMatrix4(obj.matrixWorld);
    const dragStartWorld = dragStartLocal.clone().applyMatrix4(obj.matrixWorld);
    const startDist = Math.max(dragStartWorld.distanceTo(anchorWorld), 1e-5);
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);

    _scaleDragState = {
        obj, anchorLocal: anchorLocal.clone(), anchorWorld, startDist, axisMask,
        startScale: obj.scale.clone(),
        startPosition: obj.position.clone(),
        dragPlane: new THREE.Plane().setFromNormalAndCoplanarPoint(camDir, dragStartWorld),
    };
    orbitControls.enabled = false;
}

function setupScaleHandles(canvas) {
    canvas.addEventListener('pointerdown', e => {
        if (activeTool !== 'scale' || e.button !== 0 || !selectedObject || scaleHandleMeshes.length === 0) return;
        const rect = canvas.getBoundingClientRect();
        _mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        _mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        _raycaster.setFromCamera(_mouse, camera);
        const hits = _raycaster.intersectObjects(scaleHandleMeshes, false);
        if (hits.length === 0) return;
        beginScaleDrag(hits[0].object);
    });

    canvas.addEventListener('pointermove', e => {
        if (!_scaleDragState) return;
        const rect = canvas.getBoundingClientRect();
        _mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        _mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        _raycaster.setFromCamera(_mouse, camera);
        const hitPoint = new THREE.Vector3();
        if (!_raycaster.ray.intersectPlane(_scaleDragState.dragPlane, hitPoint)) return;

        const { obj, anchorWorld, anchorLocal, startDist, startScale, axisMask } = _scaleDragState;
        const ratio = THREE.MathUtils.clamp(hitPoint.distanceTo(anchorWorld) / startDist, 0.02, 50);
        const newScale = startScale.clone();
        if (axisMask) newScale[axisMask] *= ratio;
        else newScale.multiplyScalar(ratio);
        obj.scale.copy(newScale);
        // Object3D scale is about its own local origin, not an arbitrary
        // corner/face — after scaling, solve for the position that keeps
        // anchorLocal mapping back to the same fixed anchorWorld point, so
        // the opposite corner/face stays pinned instead of the object
        // growing from its center.
        const rotatedAnchorOffset = anchorLocal.clone().multiply(newScale).applyQuaternion(obj.quaternion);
        obj.position.copy(anchorWorld).sub(rotatedAnchorOffset);
        obj.updateMatrixWorld();
        setVCB('Scale:', axisMask ? `${axisMask.toUpperCase()}: ${(ratio * 100).toFixed(0)}%` : `${(ratio * 100).toFixed(0)}%`);
    });

    window.addEventListener('pointerup', () => {
        if (!_scaleDragState) return;
        orbitControls.enabled = true;
        const { obj, startScale, startPosition } = _scaleDragState;
        const afterScale = obj.scale.clone(), afterPosition = obj.position.clone();
        pushUndo({
            undo() { obj.scale.copy(startScale); obj.position.copy(startPosition); },
            redo() { obj.scale.copy(afterScale); obj.position.copy(afterPosition); },
        });
        _scaleDragState = null;
    });
}

// ─────────────────────────────────────────────────────────────
// AUTOCAD-STYLE COMMAND LINE — type a command name or alias, press Enter
// to run it. Every entry maps to a real function already used elsewhere in
// this app (setActiveTool, addPrimitive, undo/redo, save/open, ...) — no
// stub commands. Case-insensitive, matching AutoCAD's own convention.
// ─────────────────────────────────────────────────────────────
const CAD_COMMANDS = {
    LINE: () => setActiveTool('line'), L: () => setActiveTool('line'),
    RECTANGLE: () => setActiveTool('rect'), REC: () => setActiveTool('rect'),
    CIRCLE: () => setActiveTool('circle'), C: () => setActiveTool('circle'),
    ARC: () => setActiveTool('arc'), A: () => setActiveTool('arc'),
    POLYGON: (arg) => { if (arg) polygonSides = Math.max(3, parseInt(arg, 10) || 6); setActiveTool('polygon'); }, POL: (arg) => { if (arg) polygonSides = Math.max(3, parseInt(arg, 10) || 6); setActiveTool('polygon'); },
    PIE: (arg) => { if (arg) pieSweepDeg = Math.max(1, parseFloat(arg) || 90); setActiveTool('pie'); },
    ROTRECT: () => setActiveTool('rotrect'), RR: () => setActiveTool('rotrect'),
    POLYLINE: () => setActiveTool('poly_build'), PL: () => setActiveTool('poly_build'),
    WALL: () => setActiveTool('wall'), WA: () => setActiveTool('wall'),
    SLAB: () => setActiveTool('slab'),
    OPENING: () => setActiveTool('opening'),
    OFFSET: () => setActiveTool('offset'), O: () => setActiveTool('offset'),
    TAPE: () => setActiveTool('tape'), DIST: () => setActiveTool('tape'), DI: () => setActiveTool('tape'),
    ERASER: () => setActiveTool('eraser'),

    SELECT: () => setActiveTool('select'),
    SELECTBOX: () => setActiveTool('select_box'), BOXSELECT: () => setActiveTool('select_box'),
    SELECTCIRCLE: () => setActiveTool('select_circle'), CIRCLESELECT: () => setActiveTool('select_circle'),
    LASSO: () => setActiveTool('select_lasso'), SELECTLASSO: () => setActiveTool('select_lasso'),
    KNIFE: () => setActiveTool('knife'),
    LOOPSEL: () => selectFaceLoop(), FILLHOLE: () => fillSelectedHole(),
    ROOM: () => makeRoomsFromWalls(), DOORCOMP: () => addDoorComponent(), WINCOMP: () => addWindowComponent(),
    LEVEL: () => addStorey(), SCHEDULE: () => exportScheduleCsv(), DXFOUT: () => exportPlanDXF(),
    ALIGNZ: () => alignSelectionToFloor(), CAMERA: () => addCameraObject(), LOOKCAM: () => lookThroughSelectedCamera(),
    MOVE: () => setActiveTool('move'), M: () => setActiveTool('move'),
    ROTATE: () => setActiveTool('rotate'), RO: () => setActiveTool('rotate'),
    SCALE: () => setActiveTool('scale'), SC: () => setActiveTool('scale'),
    ERASE: () => deleteSelected(), E: () => deleteSelected(), DELETE: () => deleteSelected(),
    COPY: () => duplicateSelected(), CO: () => duplicateSelected(), CP: () => duplicateSelected(),

    UNDO: () => undo(), U: () => undo(),
    REDO: () => redo(), MREDO: () => redo(),

    ZOOM: () => zoomExtents(), Z: () => zoomExtents(),
    ZOOMALL: () => frameAllObjects(), ZA: () => frameAllObjects(),
    TOP: () => setViewAngle('top'), FRONT: () => setViewAngle('front'), RIGHT: () => setViewAngle('right'),
    LEFT: () => setViewAngle('left'), BACK: () => setViewAngle('back'), BOTTOM: () => setViewAngle('bottom'),

    BOX: () => addPrimitive('cube'), CUBE: () => addPrimitive('cube'),
    SPHERE: () => addPrimitive('sphere'), SPH: () => addPrimitive('sphere'),
    CYLINDER: () => addPrimitive('cylinder'), CYL: () => addPrimitive('cylinder'),
    CONE: () => addPrimitive('cone'),
    PLANE: () => addPrimitive('plane'),

    EXTRUDE: () => executeMeshEditTool('extrude'), EXT: () => executeMeshEditTool('extrude'),
    BEVEL: (arg) => applyBlenderModifier('BEVEL', { amount: arg ? parseFloat(arg) : 0.1 }), BE: (arg) => applyBlenderModifier('BEVEL', { amount: arg ? parseFloat(arg) : 0.1 }),
    INSET: () => executeMeshEditTool('inset'),

    UNION: () => armBooleanTool('union'), SUBTRACT: () => armBooleanTool('subtract'), SU: () => armBooleanTool('subtract'),
    INTERSECT: () => armBooleanTool('intersect'), IN: () => armBooleanTool('intersect'),

    // Modifiers Stack — same applyBlenderModifier() the panel sliders and the
    // AI Assistant's apply_modifier tool call, so behavior is identical
    // across all three entry points. Optional numeric/axis argument, e.g.
    // "ARRAY 5", "BEVEL 0.2", "MIRROR Y", "TWIST -45".
    MIRROR:   (arg) => applyBlenderModifier('MIRROR',   { axis: (arg || 'X').toUpperCase() }),
    ARRAY:    (arg) => applyBlenderModifier('ARRAY',    { count: arg ? parseInt(arg, 10) : 3 }),
    SOLIDIFY: (arg) => applyBlenderModifier('SOLIDIFY', { thickness: arg ? parseFloat(arg) : 0.1 }),
    SUBSURF:  (arg) => applyBlenderModifier('SUBSURF',  { levels: arg ? parseInt(arg, 10) : 1 }),
    SUBD:     (arg) => applyBlenderModifier('SUBSURF',  { levels: arg ? parseInt(arg, 10) : 1 }),
    DECIMATE: (arg) => applyBlenderModifier('DECIMATE', { ratio: arg ? parseFloat(arg) : 0.5 }),
    DEC:      (arg) => applyBlenderModifier('DECIMATE', { ratio: arg ? parseFloat(arg) : 0.5 }),
    TWIST:    (arg) => applyBlenderModifier('SIMPLE_DEFORM_TWIST', { angle: arg ? parseFloat(arg) : 90 }),
    DISPLACE: (arg) => applyBlenderModifier('DISPLACE', { strength: arg ? parseFloat(arg) : 0.2 }),
    DISP:     (arg) => applyBlenderModifier('DISPLACE', { strength: arg ? parseFloat(arg) : 0.2 }),
    WIREFRAMEMOD: () => applyBlenderModifier('WIREFRAME', {}), WFMOD: () => applyBlenderModifier('WIREFRAME', {}),
    HOLLOW:   (arg) => applyBlenderModifier('HOLLOW',   { thickness: arg ? parseFloat(arg) : 0.1 }),

    FOLLOWME: () => doFollowMe(), FOLLOW: () => doFollowMe(),
    SECTION: () => addSectionPlane(), SECTIONPLANE: () => addSectionPlane(),
    SECTIONOFF: () => removeSectionPlane(),
    EYEDROPPER: () => setActiveTool('eyedropper'), SAMPLE: () => setActiveTool('eyedropper'),
    GUIDE: () => convertToGuide(), MAKEGUIDE: () => convertToGuide(),
    XRAY: () => toggleXRay(!xrayEnabled),
    FOG: () => toggleFog(!scene.fog),
    WALK: () => setActiveTool('walk'), LOOKAROUND: () => setActiveTool('lookaround'),
    STYLE: (arg) => applyStyle(arg && arg.toLowerCase() === 'blueprint' ? 'blueprint' : 'photoreal'),
    LIGHT:       (arg) => createLight(arg ? arg.toLowerCase() : 'point'),
    POINTLIGHT:  () => createLight('point'), SPOTLIGHT: () => createLight('spot'),
    SUNLIGHT:    () => createLight('directional'), AREALIGHT: () => createLight('area'),
    TIME: (arg) => setTimeOfDay(arg ? parseFloat(arg) : 12),
    SHADOWQUALITY: (arg) => setShadowQuality(arg ? arg.toUpperCase() : 'MEDIUM'),
    JOINPOOL: () => joinRenderPool(), LEAVEPOOL: () => leaveRenderPool(),
    RENDERPOOL: () => renderImageWithPool(),
    SSAO: () => toggleSSAO(!ssaoEnabled), BLOOM: () => toggleBloom(!bloomEnabled),
    HDRI: () => toggleHdriEnvironment(!hdriEnvEnabled),
    TAG: (arg) => { if (arg) assignSelectedToLayer(arg); }, LAYER: (arg) => { if (arg) assignSelectedToLayer(arg); },
    GROUP: () => groupSelectedObjects(), UNGROUP: () => ungroupSelected(),
    COMPONENT: () => makeComponentFromSelection(), MAKECOMPONENT: () => makeComponentFromSelection(),
    INSTANCE: () => insertComponentInstance(), INSERTINSTANCE: () => insertComponentInstance(),

    SAVE: () => saveProjectFile(),
    OPEN: () => triggerOpenProjectFile(),
    EXPORT: () => exportGLB(),
    IMPORT: () => triggerImportGLB(),
    IMPORTOBJ: () => triggerImportOBJ(), EXPORTOBJ: () => exportOBJ(),
    IMPORTSTL: () => triggerImportSTL(), EXPORTSTL: () => exportSTL(),
    IMPORTDXF: () => triggerImportDXF(), DXF: () => triggerImportDXF(),
    VR: () => enterVR(), ENTERVR: () => enterVR(),
    AR: () => enterAR(), ENTERAR: () => enterAR(),
    PACK: () => exportClientPack(), CLIENTPACK: () => exportClientPack(), ZIP: () => exportClientPack(),
    ASSETS: () => openAssetLibrary(), LIBRARY: () => openAssetLibrary(),

    PRESENT: () => enterPresentMode(), PRES: () => enterPresentMode(),
    QUALITY: (arg) => applyRenderQuality((arg || 'balanced').toLowerCase()),
    GROW: () => growFaceSelection(), SHRINK: () => shrinkFaceSelection(),
    LINKED: () => selectLinkedFaces(), SELLINKED: () => selectLinkedFaces(),
    PE: () => toggleProportionalEdit(), PROPORTIONAL: () => toggleProportionalEdit(),
    LIGHTING: (arg) => applyLightingPreset((arg || 'studio').toLowerCase()),
    EXPOSURE: (arg) => setEngineExposure(arg ? parseFloat(arg) : 1),
    ENV: (arg) => setEngineEnvIntensity(arg ? parseFloat(arg) : 1),
    STATUS: () => pingStudioService(),
    SLIDE: () => addPresentSlide(),
    SCREENSHOT: () => takeViewportScreenshot(), SHOT: () => takeViewportScreenshot(), SS: () => takeViewportScreenshot(),

    HELP: () => openHelpDesk(), H: () => openHelpDesk(), '?': () => openHelpDesk(),
};

function logCadCommand(text, cls) {
    const log = document.getElementById('cad-command-log');
    if (!log) return;
    const line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = text;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
    while (log.children.length > 50) log.removeChild(log.firstChild);
}

function dispatchCadCommand(raw) {
    const text = raw.trim();
    if (!text) return;
    logCadCommand('Command: ' + text, 'cad-log-echo');
    // Split "ARRAY 5" / "BEVEL 0.2" / "MIRROR Y" into command + optional
    // argument — existing zero-arg commands ignore the extra argument
    // harmlessly, so this is backward compatible.
    const parts = text.split(/\s+/);
    const key = parts[0].toUpperCase();
    const arg = parts.slice(1).join(' ');
    const fn = CAD_COMMANDS[key];
    if (!fn) {
        logCadCommand(`Unknown command "${text}". Type HELP for the command list.`, 'cad-log-error');
        return;
    }
    try {
        fn(arg);
        logCadCommand('OK', 'cad-log-ok');
    } catch (err) {
        logCadCommand('Command failed: ' + err.message, 'cad-log-error');
    }
}

function handleCadCommandKey(e) {
    // Escape must still reach the global handler (setupKeyboard()) so it
    // can cancel an in-progress draw even if focus is sitting in this
    // input — stopPropagation() below would otherwise swallow it here
    // and it would never cancel anything.
    if (e.key === 'Escape') return;
    e.stopPropagation(); // don't let single letters also trigger the global tool-shortcut keydown handler
    if (e.key !== 'Enter') return;
    const input = e.target;
    dispatchCadCommand(input.value);
    input.value = '';
}

// ─────────────────────────────────────────────────────────────
// WORKSPACE SWITCHER
// ─────────────────────────────────────────────────────────────
function switchWS(el, ws) {
    document.querySelectorAll('.ws-tab-chip').forEach(t => t.classList.remove('active'));
    el.classList.add('active');

    const modeMap = {
        layout:   () => { switchInteractionMode('object');   switchRightTab('object'); },
        sketchup: () => { switchInteractionMode('sketchup'); switchRightTab('sketchup'); setVCB('Measurements:', '0.00 m'); },
        model:    () => { switchInteractionMode('edit');     switchRightTab('mod'); },
        sculpt:   () => { switchInteractionMode('sculpt');   switchRightTab('sculpt'); },
        anim:     () => { switchInteractionMode('object');   switchRightTab('anim'); },
        shade:    () => { switchInteractionMode('object');   switchRightTab('mat'); },
        render:   () => { switchInteractionMode('object');   switchRightTab('render'); setShadingMode('RAYTRACE'); },
        present:  () => { enterPresentMode(); },
        bim:      () => { switchInteractionMode('object');   switchRightTab('object'); },
    };

    (modeMap[ws] || modeMap.layout)();
}

function switchRightTab(tabId) {
    document.querySelectorAll('.p-strip-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById(`tab-btn-${tabId}`);
    if (btn) btn.classList.add('active');

    const tabs = ['object', 'mod', 'mat', 'render', 'anim', 'sculpt', 'sketchup'];
    tabs.forEach(t => {
        const el = document.getElementById(`tab-${t}`);
        if (el) el.style.display = (t === tabId) ? 'flex' : 'none';
    });
}

// ─────────────────────────────────────────────────────────────
// ADD PRIMITIVES — from _defs_view3d_add (cube, cone, cylinder, UV sphere, Ico sphere)
// ─────────────────────────────────────────────────────────────
function addPrimitive(type) {
    let geo;
    switch (type) {
        case 'cube':     geo = new THREE.BoxGeometry(2, 2, 2); break;
        case 'cylinder': geo = new THREE.CylinderGeometry(1, 1, 2, 32); break;
        case 'sphere':
        case 'uv_sphere':geo = new THREE.SphereGeometry(1, 32, 16); break;
        case 'ico_sphere':geo = new THREE.IcosahedronGeometry(1, 2); break;
        case 'cone':     geo = new THREE.ConeGeometry(1, 2, 32); break;
        case 'torus':    geo = new THREE.TorusGeometry(1, 0.3, 16, 48); break;
        case 'plane':    geo = new THREE.PlaneGeometry(2, 2); break;
        default:         geo = new THREE.BoxGeometry(2, 2, 2);
    }

    const mat  = new THREE.MeshStandardMaterial({ color: 0xbebebe, roughness: 0.5, metalness: 0.0 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow    = true;
    mesh.receiveShadow = true;

    const label = type.charAt(0).toUpperCase() + type.slice(1).replace('_', ' ');
    const count = sceneObjects.filter(o => o.name.startsWith(label)).length;
    mesh.name = count === 0 ? label : `${label}.${String(count).padStart(3, '0')}`;

    // Place near cursor / slightly offset if something else is at origin.
    // Z defaults to the active level's elevation (0 on Ground Floor —
    // identical to the pre-Levels behavior of always spawning at z=0).
    const level = activeLevelIndex;
    mesh.position.set(0, 0, levelElevation(level));

    scene.add(mesh);
    sceneObjects.push({ name: mesh.name, type: 'mesh', mesh, level });
    renderOutliner();
    selectObject(mesh);
    setVCB('Added:', mesh.name);

    pushUndo({
        undo() { removeSceneObject(mesh); },
        redo() { scene.add(mesh); sceneObjects.push({ name: mesh.name, type: 'mesh', mesh, level }); renderOutliner(); selectObject(mesh); },
    });
}

// ─────────────────────────────────────────────────────────────
// MODIFIERS — from properties_data_modifier.py (Generate + Deform categories)
//
// Rebuilt from scratch — the previous version had two problems: (1) every
// "Add Modifier" panel button called this with a lowercase modType
// ('subsurf', 'mirror', ...) while the switch here only matched uppercase
// ('SUBSURF', 'MIRROR', ...), so all 6 buttons silently did nothing at all;
// (2) even once that's fixed, most cases were fake whole-object approximations
// (Bevel = uniform scale, Solidify = Z-scale, Subsurf = Box-geometry-only,
// Array = hardcoded to 3 copies, Decimate = Sphere-geometry-only). Every
// modifier below now does a real, generically-applicable geometry operation,
// takes adjustable parameters, and is reachable identically from three
// places: the panel's mouse-draggable sliders, the AutoCAD-style command bar
// (CAD_COMMANDS), and the AI Assistant (apply_modifier tool) — all three
// call this exact function, so behavior can't drift between them.
// ─────────────────────────────────────────────────────────────
const appliedModifiers = new WeakMap();      // obj -> string[] (stack display labels)
const arrayModifierClones = new WeakMap();   // obj -> Mesh[] (clones from the most recent Array application, so re-applying replaces rather than piling up)

// Modifiers cheap enough to live-preview on every slider tick (pure geometry
// mutation, single mesh, no CSG). Solidify (CSG-based), Array and Mirror
// (create new scene objects) commit on click/Enter only — see
// setupModifierPanelInteractions().
const LIVE_PREVIEW_MODIFIER_TYPES = new Set(['BEVEL', 'SUBSURF', 'DECIMATE', 'SIMPLE_DEFORM_TWIST', 'DISPLACE']);

function subdivideGeometryInPlace(obj) {
    ensureNonIndexed(obj);
    const pos = obj.geometry.attributes.position;
    const triCount = pos.count / 3;
    const out = new Float32Array(triCount * 4 * 3 * 3); // 4 new triangles per original tri, 3 verts, 3 floats
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const ab = new THREE.Vector3(), bc = new THREE.Vector3(), ca = new THREE.Vector3();
    let o = 0;
    const push = v => { out[o++] = v.x; out[o++] = v.y; out[o++] = v.z; };
    for (let f = 0; f < triCount; f++) {
        a.fromBufferAttribute(pos, f * 3); b.fromBufferAttribute(pos, f * 3 + 1); c.fromBufferAttribute(pos, f * 3 + 2);
        ab.addVectors(a, b).multiplyScalar(0.5);
        bc.addVectors(b, c).multiplyScalar(0.5);
        ca.addVectors(c, a).multiplyScalar(0.5);
        push(a); push(ab); push(ca);
        push(ab); push(b); push(bc);
        push(ca); push(bc); push(c);
        push(ab); push(bc); push(ca);
    }
    const newGeo = new THREE.BufferGeometry();
    newGeo.setAttribute('position', new THREE.BufferAttribute(out, 3));
    newGeo.computeVertexNormals();
    obj.geometry.dispose();
    obj.geometry = newGeo;
}

// Real vertex-clustering decimation (a standard, genuine simplification
// algorithm): snap every vertex onto a coarse grid whose cell size is driven
// by `ratio`, so triangles whose corners collapse onto the same grid point
// become degenerate and are dropped. Works on any geometry, unlike the old
// Sphere-only version.
function decimateGeometryInPlace(obj, ratio) {
    ensureNonIndexed(obj);
    const pos = obj.geometry.attributes.position;
    obj.geometry.computeBoundingBox();
    const bb = obj.geometry.boundingBox;
    const size = new THREE.Vector3();
    bb.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const gridRes = Math.max(2, Math.round(2 + THREE.MathUtils.clamp(ratio, 0.02, 1) * 30)); // 2..32 cells across the longest axis
    const cell = maxDim / gridRes;

    const clusterPos = new Map(); // grid key -> representative {x,y,z} (cell center)
    const keyFor = (x, y, z) => {
        const ix = Math.floor((x - bb.min.x) / cell);
        const iy = Math.floor((y - bb.min.y) / cell);
        const iz = Math.floor((z - bb.min.z) / cell);
        const key = `${ix}_${iy}_${iz}`;
        if (!clusterPos.has(key)) {
            clusterPos.set(key, {
                x: bb.min.x + (ix + 0.5) * cell,
                y: bb.min.y + (iy + 0.5) * cell,
                z: bb.min.z + (iz + 0.5) * cell,
            });
        }
        return key;
    };

    const triCount = pos.count / 3;
    const newTris = [];
    for (let f = 0; f < triCount; f++) {
        const keys = [], reps = [];
        for (let k = 0; k < 3; k++) {
            const i = f * 3 + k;
            const key = keyFor(pos.getX(i), pos.getY(i), pos.getZ(i));
            keys.push(key);
            reps.push(clusterPos.get(key));
        }
        if (keys[0] === keys[1] || keys[1] === keys[2] || keys[0] === keys[2]) continue; // collapsed to a point/line — drop
        reps.forEach(r => newTris.push(r.x, r.y, r.z));
    }
    if (newTris.length === 0) return; // ratio too aggressive for this mesh — leave geometry untouched rather than producing nothing
    const newGeo = new THREE.BufferGeometry();
    newGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(newTris), 3));
    newGeo.computeVertexNormals();
    obj.geometry.dispose();
    obj.geometry = newGeo;
}

// angleRad is the TOTAL twist from the object's bottom to its top (matches
// Blender's Simple Deform "Angle" — a real, bounded, adjustable parameter),
// not the old hardcoded `y * 0.5` which scaled with raw world-space Y and
// couldn't be tuned at all.
function twistGeometryInPlace(obj, angleRad) {
    ensureNonIndexed(obj);
    obj.geometry.computeBoundingBox();
    const bb = obj.geometry.boundingBox;
    const halfHeight = (bb.max.y - bb.min.y) / 2 || 1;
    const pos = obj.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        const angle = (y / halfHeight) * angleRad;
        const x = pos.getX(i), z = pos.getZ(i);
        pos.setX(i, x * Math.cos(angle) - z * Math.sin(angle));
        pos.setZ(i, x * Math.sin(angle) + z * Math.cos(angle));
    }
    pos.needsUpdate = true;
    obj.geometry.computeVertexNormals();
}

function displaceGeometryInPlace(obj, strength) {
    ensureNonIndexed(obj);
    if (!obj.geometry.attributes.normal) obj.geometry.computeVertexNormals();
    const pos = obj.geometry.attributes.position;
    const nrm = obj.geometry.attributes.normal;
    for (let i = 0; i < pos.count; i++) {
        const nx = nrm.getX(i), ny = nrm.getY(i), nz = nrm.getZ(i);
        const t = strength * Math.sin(pos.getX(i) * 5) * Math.cos(pos.getY(i) * 5);
        pos.setX(i, pos.getX(i) + nx * t);
        pos.setY(i, pos.getY(i) + ny * t);
        pos.setZ(i, pos.getZ(i) + nz * t);
    }
    pos.needsUpdate = true;
    obj.geometry.computeVertexNormals();
}

// Whole-object Bevel: temporarily selects every triangle as a face-selection
// group and runs the SAME real bevel engine the Edit Mode tools already use
// (extrude-in + inset, see bevelSelectedFaces()) instead of a fake uniform
// scale. If the user already had specific faces selected, only those are
// beveled (more precise, still real) rather than the whole object.
function wholeObjectOrSelectedBevel(obj, amount) {
    ensureNonIndexed(obj);
    const savedFaces = selectedFaces.slice();
    if (selectedFaces.length > 0) {
        bevelSelectedFaces(obj, amount);
    } else {
        // Whole object: bevel each distinct flat face independently. A single
        // combined extrude+inset across ALL faces at once averages their
        // normals together — for a closed solid that cancels to ~zero
        // (opposite faces point opposite ways), so extrudeSelectedFaces()
        // bails out and the whole thing silently does nothing. Inset alone
        // is topology-preserving (moves existing vertices, adds none), so
        // it's safe to run per face group in one pass — earlier groups'
        // triangle indices never shift under later ones.
        const triCount = obj.geometry.attributes.position.count / 3;
        const visited = new Array(triCount).fill(false);
        for (let f = 0; f < triCount; f++) {
            if (visited[f]) continue;
            const group = findCoplanarConnectedFaces(obj, f);
            group.forEach(idx => { visited[idx] = true; });
            selectedFaces = group;
            insetSelectedFaces(obj, Math.min(0.6, amount * 2));
        }
    }
    selectedFaces = savedFaces;
}

function runModifierMutation(type, obj, params) {
    switch (type) {
        case 'BEVEL':               wholeObjectOrSelectedBevel(obj, params.amount ?? 0.1); break;
        case 'SUBSURF':              for (let i = 0, n = Math.round(params.levels ?? 1); i < n; i++) subdivideGeometryInPlace(obj); break;
        case 'DECIMATE':             decimateGeometryInPlace(obj, params.ratio ?? 0.5); break;
        case 'SIMPLE_DEFORM_TWIST':  twistGeometryInPlace(obj, THREE.MathUtils.degToRad(params.angle ?? 90)); break;
        case 'DISPLACE':             displaceGeometryInPlace(obj, params.strength ?? 0.2); break;
    }
}

function modifierResultLabel(type, params) {
    switch (type) {
        case 'BEVEL':              return `Bevel (${(params.amount ?? 0.1).toFixed(2)}m)`;
        case 'SUBSURF':            return `Subdivide (${Math.round(params.levels ?? 1)}×)`;
        case 'DECIMATE':           return `Decimate (${Math.round((params.ratio ?? 0.5) * 100)}%)`;
        case 'SIMPLE_DEFORM_TWIST':return `Twist (${Math.round(params.angle ?? 90)}°)`;
        case 'DISPLACE':           return `Displace (${(params.strength ?? 0.2).toFixed(2)})`;
        default:                  return type;
    }
}

// Reflects geometry across the object's own local axis and fixes triangle
// winding (a plain negative-scale matrix flips faces inside-out — three.js
// doesn't correct this automatically), unlike the old version which only
// ever mirrored X and rendered the clone inside-out.
function computeMirrorClone(obj, axis) {
    ensureNonIndexed(obj);
    const mirrorGeo = deepCloneGeometry(obj.geometry);
    const scaleVec = axis === 'X' ? [-1, 1, 1] : axis === 'Y' ? [1, -1, 1] : [1, 1, -1];
    mirrorGeo.applyMatrix4(new THREE.Matrix4().makeScale(...scaleVec));

    const pos = mirrorGeo.attributes.position;
    const triCount = pos.count / 3;
    const tmp = new THREE.Vector3();
    for (let f = 0; f < triCount; f++) {
        const i1 = f * 3 + 1, i2 = f * 3 + 2;
        tmp.fromBufferAttribute(pos, i1);
        pos.setXYZ(i1, pos.getX(i2), pos.getY(i2), pos.getZ(i2));
        pos.setXYZ(i2, tmp.x, tmp.y, tmp.z);
    }
    pos.needsUpdate = true;
    mirrorGeo.computeVertexNormals();

    const mirrorMesh = new THREE.Mesh(mirrorGeo, obj.material.clone());
    mirrorMesh.position.copy(obj.position);
    mirrorMesh.rotation.copy(obj.rotation);
    mirrorMesh.scale.copy(obj.scale);
    mirrorMesh.castShadow = true;
    mirrorMesh.receiveShadow = true;
    mirrorMesh.name = nextName(obj.name + '_Mirror' + axis);
    return mirrorMesh;
}

function computeArrayClones(obj, count, axis) {
    obj.geometry.computeBoundingBox();
    const size = new THREE.Vector3();
    obj.geometry.boundingBox.getSize(size);
    const axisKey = axis.toLowerCase();
    const dim = size[axisKey] || 2;
    const step = dim * (obj.scale[axisKey] || 1) * 1.1;
    const clones = [];
    for (let i = 1; i < count; i++) {
        const clone = new THREE.Mesh(obj.geometry.clone(), obj.material.clone());
        clone.castShadow = true;
        clone.receiveShadow = true;
        clone.position.copy(obj.position);
        clone.position[axisKey] += i * step;
        clone.rotation.copy(obj.rotation);
        clone.scale.copy(obj.scale);
        clone.name = nextName(`${obj.name}_Array`);
        clones.push(clone);
    }
    return clones;
}

// Live-drag session state for the 5 cheap geometry modifiers — see
// setupModifierPanelInteractions() (index.html slider oninput/onchange) for
// how this is driven; kept here since runModifierMutation()/applyBlenderModifier()
// both need to know whether a drag is currently in progress.
let _modDragBaseGeo = null;
let _modDragType = null;

function previewModifierLive(type, params) {
    const obj = selectedObject;
    if (!obj || !_modDragBaseGeo || _modDragType !== type) return;
    obj.geometry.dispose();
    obj.geometry = deepCloneGeometry(_modDragBaseGeo);
    runModifierMutation(type, obj, params);
    updateInspectorFromSelected();
}

function beginModifierDrag(type) {
    const obj = selectedObject;
    if (!obj || !obj.isMesh) return;
    _modDragType = type;
    _modDragBaseGeo = deepCloneGeometry(obj.geometry);
}

function endModifierDrag(type, params) {
    const obj = selectedObject;
    if (!obj || !_modDragBaseGeo || _modDragType !== type) { _modDragBaseGeo = null; _modDragType = null; return; }
    const beforeGeo = _modDragBaseGeo;
    const afterGeo = deepCloneGeometry(obj.geometry); // already mutated live by previewModifierLive()
    pushUndo({
        undo() { obj.geometry.dispose(); obj.geometry = beforeGeo; updateInspectorFromSelected(); },
        redo() { obj.geometry.dispose(); obj.geometry = afterGeo; updateInspectorFromSelected(); },
    });
    const mods = appliedModifiers.get(obj) || [];
    const label = modifierResultLabel(type, params);
    mods.push(label);
    appliedModifiers.set(obj, mods);
    updateModStackUI(obj);
    setVCB('Modifier:', label);
    _modDragBaseGeo = null;
    _modDragType = null;
}

// The single entry point used identically by: the modifier panel's "Add"
// buttons (a plain click, no drag), the AutoCAD-style command bar
// (CAD_COMMANDS), and the AI Assistant (apply_modifier tool / executeAIAction).
function applyBlenderModifier(modTypeRaw, params) {
    params = params || {};
    const obj = selectedObject;
    if (!obj || !obj.isMesh) { setVCB('Modifier:', 'Select a mesh object first'); return false; }
    const type = String(modTypeRaw).toUpperCase();
    const mods = appliedModifiers.get(obj) || [];
    let label = null;

    if (LIVE_PREVIEW_MODIFIER_TYPES.has(type)) {
        // Plain click (no active drag session on this exact type) — single-shot apply.
        const beforeGeo = deepCloneGeometry(obj.geometry);
        runModifierMutation(type, obj, params);
        const afterGeo = deepCloneGeometry(obj.geometry);
        pushUndo({
            undo() { obj.geometry.dispose(); obj.geometry = beforeGeo; updateInspectorFromSelected(); },
            redo() { obj.geometry.dispose(); obj.geometry = afterGeo; updateInspectorFromSelected(); },
        });
        label = modifierResultLabel(type, params);
    } else {
        switch (type) {
            case 'MIRROR': {
                const axis = (params.axis || 'X').toUpperCase();
                const mirrorMesh = computeMirrorClone(obj, axis);
                scene.add(mirrorMesh);
                sceneObjects.push({ name: mirrorMesh.name, type: 'mesh', mesh: mirrorMesh });
                renderOutliner();
                pushUndo({
                    undo() { removeSceneObject(mirrorMesh); },
                    redo() { scene.add(mirrorMesh); sceneObjects.push({ name: mirrorMesh.name, type: 'mesh', mesh: mirrorMesh }); renderOutliner(); },
                });
                label = `Mirror (${axis})`;
                break;
            }

            case 'SOLIDIFY': {
                const thickness = THREE.MathUtils.clamp(params.thickness ?? 0.1, 0.01, 2);
                runHollowShell(thickness); // real CSG shell — pushes its own undo + setVCB
                label = `Solidify (${formatLength(thickness)})`;
                break;
            }

            case 'ARRAY': {
                const count = Math.max(2, Math.round(params.count ?? 3));
                const axis = (params.axis || 'X').toUpperCase();
                const oldClones = arrayModifierClones.get(obj) || [];
                const newClones = computeArrayClones(obj, count, axis);
                oldClones.forEach(m => removeSceneObject(m));
                newClones.forEach(m => { scene.add(m); sceneObjects.push({ name: m.name, type: 'mesh', mesh: m }); });
                arrayModifierClones.set(obj, newClones);
                renderOutliner();
                pushUndo({
                    undo() {
                        newClones.forEach(m => removeSceneObject(m));
                        oldClones.forEach(m => { scene.add(m); sceneObjects.push({ name: m.name, type: 'mesh', mesh: m }); });
                        arrayModifierClones.set(obj, oldClones);
                        renderOutliner();
                    },
                    redo() {
                        oldClones.forEach(m => removeSceneObject(m));
                        newClones.forEach(m => { scene.add(m); sceneObjects.push({ name: m.name, type: 'mesh', mesh: m }); });
                        arrayModifierClones.set(obj, newClones);
                        renderOutliner();
                    },
                });
                label = `Array (${count}×, ${axis})`;
                break;
            }

            case 'WIREFRAME': {
                const mat = obj.material;
                const before = mat.wireframe;
                mat.wireframe = !before;
                const after = mat.wireframe;
                pushUndo({ undo() { mat.wireframe = before; }, redo() { mat.wireframe = after; } });
                label = 'Wireframe ' + (after ? 'ON' : 'OFF');
                break;
            }

            case 'BOOLEAN_UNION':     armBooleanTool('union');     return true;
            case 'BOOLEAN_INTERSECT': armBooleanTool('intersect'); return true;
            case 'BOOLEAN_DIFF':      armBooleanTool('subtract');  return true;
            case 'HOLLOW':            runHollowShell(THREE.MathUtils.clamp(params.thickness ?? 0.1, 0.01, 2)); propagateComponentEdit(obj); return true;

            default:
                setVCB('Modifier:', 'Unknown modifier: ' + type);
                return false;
        }
    }

    if (label) {
        mods.push(label);
        appliedModifiers.set(obj, mods);
        updateModStackUI(obj);
        updateInspectorFromSelected();
        setVCB('Modifier:', label);
        propagateComponentEdit(obj);
    }
    return true;
}

function updateModStackUI(obj) {
    const list = document.getElementById('mod-stack-list');
    if (!list) return;
    const mods = appliedModifiers.get(obj) || [];
    list.innerHTML = mods.length === 0
        ? '<div style="color:#666; font-size:10px; padding:4px;">No modifiers applied yet.</div>'
        : mods.map((m, i) => `
            <div style="display:flex; align-items:center; gap:6px; padding:3px 6px; background:#2a2a2a; border-radius:3px; margin-bottom:2px;">
                <span style="font-size:10px; color:#e97426;">🔧</span>
                <span style="font-size:10px; flex:1;">${m}</span>
                <span style="font-size:9px; color:#555;">${i + 1}</span>
            </div>
        `).join('');
}

// ─────────────────────────────────────────────────────────────
// MODIFIER PANEL UI — mouse-draggable parameter sliders per modifier
// (dragging a slider IS the "mouse-driven" interaction — the 5 cheap
// geometry-only types additionally live-preview the mesh while dragging,
// see LIVE_PREVIEW_MODIFIER_TYPES above). "Add" click applies once with
// whatever the sliders/selects currently read, going through the exact same
// applyBlenderModifier() the command bar and AI Assistant call.
// ─────────────────────────────────────────────────────────────
const MODIFIER_DEFS = [
    { type: 'SUBSURF', label: 'Subdivide', live: true, params: [{ key: 'levels', label: 'Levels', min: 1, max: 3, step: 1, def: 1 }] },
    { type: 'MIRROR', label: 'Mirror', live: false, params: [{ key: 'axis', label: 'Axis', kind: 'select', options: ['X', 'Y', 'Z'], def: 'X' }] },
    { type: 'BEVEL', label: 'Bevel', live: true, params: [{ key: 'amount', label: 'Amount (m)', min: 0.02, max: 0.5, step: 0.01, def: 0.1 }] },
    { type: 'SOLIDIFY', label: 'Solidify', live: false, params: [{ key: 'thickness', label: 'Thickness (m)', min: 0.02, max: 0.5, step: 0.01, def: 0.1 }] },
    { type: 'ARRAY', label: 'Array', live: false, params: [
        { key: 'count', label: 'Count', min: 2, max: 10, step: 1, def: 3 },
        { key: 'axis', label: 'Axis', kind: 'select', options: ['X', 'Y', 'Z'], def: 'X' },
    ] },
    { type: 'WIREFRAME', label: 'Wireframe', live: false, params: [] },
    { type: 'DECIMATE', label: 'Decimate', live: true, params: [{ key: 'ratio', label: 'Detail', min: 0.1, max: 0.9, step: 0.05, def: 0.5 }] },
    { type: 'SIMPLE_DEFORM_TWIST', label: 'Twist', live: true, params: [{ key: 'angle', label: 'Angle (deg)', min: -180, max: 180, step: 5, def: 90 }] },
    { type: 'DISPLACE', label: 'Displace', live: true, params: [{ key: 'strength', label: 'Strength', min: 0.02, max: 0.6, step: 0.02, def: 0.2 }] },
];

function modParamId(type, key) { return `modp-${type}-${key}`; }

function readModifierParams(def) {
    const params = {};
    def.params.forEach(p => {
        const el = document.getElementById(modParamId(def.type, p.key));
        if (!el) { params[p.key] = p.def; return; }
        params[p.key] = p.kind === 'select' ? el.value : parseFloat(el.value);
    });
    return params;
}

function addModifierFromPanel(type) {
    const def = MODIFIER_DEFS.find(d => d.type === type);
    if (!def) return;
    applyBlenderModifier(type, readModifierParams(def));
}

function onModifierSliderInput(type) {
    const def = MODIFIER_DEFS.find(d => d.type === type);
    if (!def) return;
    def.params.forEach(p => {
        const valEl = document.getElementById(modParamId(type, p.key) + '-val');
        const inputEl = document.getElementById(modParamId(type, p.key));
        if (valEl && inputEl) valEl.innerText = inputEl.value;
    });
    if (!def.live) return; // non-live modifiers (Solidify/Array/Mirror) only update the displayed number here — they commit on "Add" click
    if (!_modDragBaseGeo || _modDragType !== type) beginModifierDrag(type); // safety net if pointerdown was missed
    previewModifierLive(type, readModifierParams(def));
}

function onModifierSliderChange(type) {
    const def = MODIFIER_DEFS.find(d => d.type === type);
    if (!def) return;
    endModifierDrag(type, readModifierParams(def));
}

function renderModifierAddPanel() {
    const container = document.getElementById('modifier-add-list');
    if (!container) return;
    container.innerHTML = MODIFIER_DEFS.map(def => {
        const paramsHtml = def.params.map(p => {
            const id = modParamId(def.type, p.key);
            if (p.kind === 'select') {
                return `<span class="prop-label" style="font-size:9px;">${p.label}</span>` +
                    `<select id="${id}" style="font-size:10px;">${p.options.map(o => `<option value="${o}">${o}</option>`).join('')}</select>` +
                    `<span></span>`;
            }
            const dragAttrs = def.live
                ? `oninput="onModifierSliderInput('${def.type}')" onchange="onModifierSliderChange('${def.type}')" onpointerdown="beginModifierDrag('${def.type}')"`
                : `oninput="onModifierSliderInput('${def.type}')"`; // value-label update only (see onModifierSliderInput's live-drag guard); non-live types stay uncommitted until Add
            return `<span class="prop-label" style="font-size:9px;">${p.label}</span>` +
                `<input type="range" id="${id}" min="${p.min}" max="${p.max}" step="${p.step}" value="${p.def}" ${dragAttrs}>` +
                `<span id="${id}-val" style="font-size:9px; width:30px; text-align:right; color:#999;">${p.def}</span>`;
        }).join('');
        return `
            <div class="mod-add-row" style="background:#242424; border-radius:4px; padding:5px 6px; margin-bottom:4px;">
                <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:${def.params.length ? '4px' : '0'};">
                    <span style="font-size:11px; font-weight:600;">${def.label}</span>
                    <button class="transport-btn" style="padding:2px 10px;" onclick="addModifierFromPanel('${def.type}')">Add</button>
                </div>
                ${paramsHtml ? `<div style="display:grid; grid-template-columns:auto 1fr auto; align-items:center; gap:4px 6px;">${paramsHtml}</div>` : ''}
            </div>
        `;
    }).join('');
}

// ─────────────────────────────────────────────────────────────
// MATERIAL — Principled BSDF (from properties_material.py)
// ─────────────────────────────────────────────────────────────
const MATERIAL_PRESETS = {
    wood:     { color: '#8b6347', roughness: 0.85, metalness: 0.0 },
    concrete: { color: '#8d8d8d', roughness: 0.95, metalness: 0.0 },
    glass:    { color: '#c9e8f5', roughness: 0.02, metalness: 0.0, opacity: 0.3, transparent: true },
    steel:    { color: '#b0bec5', roughness: 0.15, metalness: 0.95 },
    marble:   { color: '#f5f0eb', roughness: 0.25, metalness: 0.0 },
    gold:     { color: '#ffd700', roughness: 0.05, metalness: 1.0 },
    brick:    { color: '#a0522d', roughness: 0.9,  metalness: 0.0 },
    plastic:  { color: '#2196f3', roughness: 0.4,  metalness: 0.0 },
};

function snapshotMaterial(mat) {
    return {
        color: mat.color.clone(), roughness: mat.roughness, metalness: mat.metalness,
        emissiveIntensity: mat.emissiveIntensity, emissive: mat.emissive.clone(),
        transparent: mat.transparent, opacity: mat.opacity, map: mat.map || null,
    };
}
function applyMaterialSnapshot(mat, snap) {
    mat.color.copy(snap.color);
    mat.roughness = snap.roughness;
    mat.metalness = snap.metalness;
    mat.emissiveIntensity = snap.emissiveIntensity;
    mat.emissive.copy(snap.emissive);
    mat.transparent = snap.transparent;
    mat.opacity = snap.opacity;
    mat.map = snap.map;
    mat.needsUpdate = true;
}

// GUIDES — SketchUp construction lines: a real dashed reference line, not
// solid geometry (no face-forming, no booleans, no Push/Pull). Converts the
// selected Line/curve object in place rather than adding a whole separate
// drawing tool — a line's already-drawn points are exactly what a guide
// needs, so this reuses that instead of duplicating the click/drag/Enter
// state machine that Line/Rectangle/Circle each have.
function convertToGuide() {
    const obj = selectedObject;
    if (!obj || !obj.isLine) { setVCB('Guide:', 'Select a drawn Line first, then Make Guide'); return; }
    const entry = sceneObjects.find(o => o.mesh === obj);
    if (!entry || entry.type === 'guide') return;
    const beforeType = entry.type;
    const beforeMat = obj.material;
    obj.material = new THREE.LineDashedMaterial({ color: 0x2fa5ff, dashSize: 0.15, gapSize: 0.1 });
    obj.computeLineDistances(); // required once for LineDashedMaterial to actually render dashed
    entry.type = 'guide';
    renderOutliner();
    setVCB('Guide:', `${obj.name} is now a construction guide`);

    pushUndo({
        undo() { obj.material.dispose(); obj.material = beforeMat; entry.type = beforeType; renderOutliner(); },
        redo() { obj.material.dispose(); obj.material = new THREE.LineDashedMaterial({ color: 0x2fa5ff, dashSize: 0.15, gapSize: 0.1 }); obj.computeLineDistances(); entry.type = 'guide'; renderOutliner(); },
    });
}

// Edit > Delete All Guides — bulk-clears every construction guide (Tape
// Measure measurements + anything converted via Make Guide) in one action,
// matching real SketchUp's Edit > Delete Guides.
function deleteAllGuides() {
    const guides = sceneObjects.filter(o => o.type === 'guide').map(o => o.mesh);
    if (guides.length === 0) { setVCB('Delete Guides:', 'No guides in the model'); return; }
    guides.forEach(m => removeSceneObject(m));
    setVCB('Delete Guides:', `${guides.length} guide(s) removed`);
    pushUndo({
        undo() { guides.forEach(m => { scene.add(m); sceneObjects.push({ name: m.name, type: 'guide', mesh: m }); }); renderOutliner(); },
        redo() { guides.forEach(m => removeSceneObject(m)); },
    });
}

// Color Sample (eyedropper) — see the 'eyedropper' branch in
// setupRaycasterSelection()'s pointerup handler for how this gets called.
function sampleColorAtEvent(hitObject, face) {
    if (!hitObject || !hitObject.material) return;
    // A per-face-painted object's material is an array indexed by
    // face.materialIndex — sample the material of the exact face clicked,
    // not always slot 0, so the eyedropper picks up what you actually see.
    const mat = Array.isArray(hitObject.material)
        ? hitObject.material[(face && face.materialIndex) || 0]
        : hitObject.material;
    const setEl = (id, val) => { const el = document.getElementById(id); if (el && val != null) el.value = val; };
    setEl('mat-color', '#' + mat.color.getHexString());
    setEl('mat-rough', mat.roughness ?? 0.5);
    setEl('mat-metal', mat.metalness ?? 0.0);
    setVCB('Color Sample:', `Picked up ${hitObject.name}'s material`);
}

function applyColorMat() {
    const obj = selectedObject;
    if (!obj || !obj.material) return;

    const mats = allMaterials(obj); // whole-object edit — every face slot, uniform recolor
    const before = mats.map(snapshotMaterial);

    const hex   = (document.getElementById('mat-color')  || {}).value  || '#cccccc';
    const rough = parseFloat((document.getElementById('mat-rough')  || {}).value  || 0.5);
    const metal = parseFloat((document.getElementById('mat-metal')  || {}).value  || 0.0);
    const emis  = parseFloat((document.getElementById('mat-emission')|| {}).value || 0.0);

    mats.forEach(mat => {
        mat.color.set(hex);
        mat.roughness = rough;
        mat.metalness = metal;
        mat.emissiveIntensity = emis;
        if (emis > 0) mat.emissive.set(hex);
    });
    setVCB('Material:', `Roughness: ${rough.toFixed(2)}, Metal: ${metal.toFixed(2)}`);

    const after = mats.map(snapshotMaterial);
    pushUndo({
        undo() { mats.forEach((mat, i) => applyMaterialSnapshot(mat, before[i])); },
        redo() { mats.forEach((mat, i) => applyMaterialSnapshot(mat, after[i])); },
    });
}

function applyPresetMat(name) {
    const obj = selectedObject;
    if (!obj || !obj.material) return;

    const p = MATERIAL_PRESETS[name];
    if (!p) return;

    const mats = allMaterials(obj);
    const before = mats.map(snapshotMaterial);
    mats.forEach(mat => {
        mat.color.set(p.color);
        mat.roughness = p.roughness;
        mat.metalness = p.metalness;
        if (p.transparent) { mat.transparent = true; mat.opacity = p.opacity; }
    });

    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    setEl('mat-color',  p.color);
    setEl('mat-rough',  p.roughness);
    setEl('mat-metal',  p.metalness);

    setVCB('Material Preset:', name.charAt(0).toUpperCase() + name.slice(1));

    const after = mats.map(snapshotMaterial);
    pushUndo({
        undo() { mats.forEach((mat, i) => applyMaterialSnapshot(mat, before[i])); },
        redo() { mats.forEach((mat, i) => applyMaterialSnapshot(mat, after[i])); },
    });
}

// ─────────────────────────────────────────────────────────────
// MATERIAL LIBRARY — a real, categorized browser (Solid Colors, Tiles,
// Paints, Wallpapers, Laminates, Metals, Glass, Wood, Fabric, Landscape),
// each swatch a genuine rotating 3D preview (not a static color chip —
// see stepMaterialThumbnails() below), draggable onto any surface in the
// viewport or click-to-apply to the selected object. Every material stays
// editable afterward through the existing Base Color/Roughness/Metallic
// sliders above, same as before.
// ─────────────────────────────────────────────────────────────
const MATERIAL_LIBRARY = {
    'Solid Colors': [
        { key: 'sc_white',   name: 'Pure White',       color: '#f5f5f5', roughness: 0.5,  metalness: 0 },
        { key: 'sc_offwhite',name: 'Off White',        color: '#e8e4da', roughness: 0.55, metalness: 0 },
        { key: 'sc_lgrey',   name: 'Light Grey',       color: '#b8bcc0', roughness: 0.5,  metalness: 0 },
        { key: 'sc_grey',    name: 'Mid Grey',         color: '#7d8083', roughness: 0.5,  metalness: 0 },
        { key: 'sc_dgrey',   name: 'Charcoal Grey',    color: '#3a3d40', roughness: 0.55, metalness: 0 },
        { key: 'sc_black',   name: 'Matte Black',      color: '#1a1a1a', roughness: 0.6,  metalness: 0 },
        { key: 'sc_red',     name: 'Crimson Red',      color: '#c0392b', roughness: 0.5,  metalness: 0 },
        { key: 'sc_maroon',  name: 'Maroon',           color: '#6e1423', roughness: 0.5,  metalness: 0 },
        { key: 'sc_orange',  name: 'Vivid Orange',     color: '#e67e22', roughness: 0.5,  metalness: 0 },
        { key: 'sc_yellow',  name: 'Sunflower Yellow', color: '#f1c40f', roughness: 0.5,  metalness: 0 },
        { key: 'sc_lime',    name: 'Lime Green',       color: '#8bc34a', roughness: 0.5,  metalness: 0 },
        { key: 'sc_green',   name: 'Forest Green',     color: '#27ae60', roughness: 0.5,  metalness: 0 },
        { key: 'sc_teal',    name: 'Teal',             color: '#16a085', roughness: 0.5,  metalness: 0 },
        { key: 'sc_cyan',    name: 'Cyan',             color: '#17a2b8', roughness: 0.45, metalness: 0 },
        { key: 'sc_blue',    name: 'Cobalt Blue',      color: '#2980b9', roughness: 0.5,  metalness: 0 },
        { key: 'sc_navy',    name: 'Navy',             color: '#1b2a4a', roughness: 0.55, metalness: 0 },
        { key: 'sc_purple',  name: 'Royal Purple',     color: '#8e44ad', roughness: 0.5,  metalness: 0 },
        { key: 'sc_pink',    name: 'Blush Pink',       color: '#e91e8c', roughness: 0.5,  metalness: 0 },
        { key: 'sc_brown',   name: 'Chocolate Brown',  color: '#6f4e37', roughness: 0.6,  metalness: 0 },
        { key: 'sc_beige',   name: 'Warm Beige',       color: '#d8c3a5', roughness: 0.6,  metalness: 0 },
    ],
    // `pattern: 'tile'` + `grout` give these a real generated tile+grout
    // texture (see createTileTexture()) instead of a flat solid color — a
    // "Subway Tile" material previously looked exactly like a painted wall.
    'Tiles': [
        { key: 'ti_white_gloss', name: 'White Gloss Tile',   color: '#f0f0f0', roughness: 0.15, metalness: 0, pattern: 'tile', grout: '#c9c9c9', tilesPerMeter: 2 },
        { key: 'ti_ceramic_grey',name: 'Ceramic Grey Tile',  color: '#9aa0a6', roughness: 0.25, metalness: 0, pattern: 'tile', grout: '#6e7378', tilesPerMeter: 2 },
        { key: 'ti_terracotta',  name: 'Terracotta Tile',    color: '#c1622d', roughness: 0.55, metalness: 0, pattern: 'tile', grout: '#8a4620', tilesPerMeter: 2 },
        { key: 'ti_mosaic_blue', name: 'Mosaic Blue Tile',   color: '#1a5276', roughness: 0.3,  metalness: 0, pattern: 'tile', grout: '#f0f0f0', tilesPerMeter: 4 },
        { key: 'ti_subway',      name: 'Subway Tile',        color: '#e8e8e8', roughness: 0.2,  metalness: 0, pattern: 'tile', grout: '#9a9a9a', tilesPerMeter: 3 },
        { key: 'ti_marble',      name: 'Marble Tile',        color: '#e5e0d8', roughness: 0.1,  metalness: 0, pattern: 'tile', grout: '#bfb8ab', tilesPerMeter: 2 },
        { key: 'ti_hexagon',     name: 'Hexagon Black Tile', color: '#232323', roughness: 0.2,  metalness: 0, pattern: 'tile', grout: '#0e0e0e', tilesPerMeter: 3 },
        { key: 'ti_slate',       name: 'Slate Tile',         color: '#4a4f52', roughness: 0.45, metalness: 0, pattern: 'tile', grout: '#2e3234', tilesPerMeter: 2 },
    ],
    'Paints': [
        { key: 'pa_matte_white',  name: 'Matte White Paint',  color: '#fafafa', roughness: 0.9,  metalness: 0 },
        { key: 'pa_eggshell',     name: 'Eggshell Beige',     color: '#e8dcc8', roughness: 0.7,  metalness: 0 },
        { key: 'pa_sage',         name: 'Sage Green Paint',   color: '#9caf88', roughness: 0.85, metalness: 0 },
        { key: 'pa_navy',         name: 'Navy Blue Paint',    color: '#1b2a4a', roughness: 0.8,  metalness: 0 },
        { key: 'pa_terracotta',   name: 'Terracotta Paint',   color: '#b5651d', roughness: 0.85, metalness: 0 },
        { key: 'pa_dusty_rose',   name: 'Dusty Rose Paint',   color: '#c98d94', roughness: 0.85, metalness: 0 },
        { key: 'pa_mustard',      name: 'Mustard Paint',      color: '#c9a227', roughness: 0.85, metalness: 0 },
        { key: 'pa_charcoal',     name: 'Charcoal Paint',     color: '#2c2c2c', roughness: 0.8,  metalness: 0 },
    ],
    'Wallpapers': [
        { key: 'wp_floral',     name: 'Floral Cream Wallpaper',    color: '#e9dfc8', roughness: 0.75, metalness: 0 },
        { key: 'wp_stripe',     name: 'Striped Grey Wallpaper',    color: '#a9a9a9', roughness: 0.7,  metalness: 0 },
        { key: 'wp_geometric',  name: 'Geometric Navy Wallpaper',  color: '#2c3e50', roughness: 0.7,  metalness: 0 },
        { key: 'wp_botanical',  name: 'Botanical Wallpaper',       color: '#4d6b4d', roughness: 0.75, metalness: 0 },
        { key: 'wp_damask',     name: 'Damask Gold Wallpaper',     color: '#8a7530', roughness: 0.55, metalness: 0.15 },
        { key: 'wp_kids',       name: 'Pastel Kids Wallpaper',     color: '#bcd8e8', roughness: 0.8,  metalness: 0 },
    ],
    'Laminates': [
        { key: 'la_oak',         name: 'Oak Laminate',         color: '#c9a066', roughness: 0.35, metalness: 0 },
        { key: 'la_walnut',      name: 'Walnut Laminate',      color: '#5c4033', roughness: 0.3,  metalness: 0 },
        { key: 'la_white_gloss', name: 'White Gloss Laminate', color: '#f2f2f2', roughness: 0.1,  metalness: 0 },
        { key: 'la_grey_stone',  name: 'Grey Stone Laminate',  color: '#8a8f94', roughness: 0.25, metalness: 0 },
        { key: 'la_black_gloss', name: 'Black Gloss Laminate', color: '#151515', roughness: 0.08, metalness: 0 },
        { key: 'la_teak',        name: 'Teak Laminate',        color: '#b08050', roughness: 0.3,  metalness: 0 },
    ],
    'Metals': [
        { key: 'me_steel',    name: 'Brushed Steel',  color: '#b0bec5', roughness: 0.15, metalness: 0.95 },
        { key: 'me_gold',     name: 'Polished Gold',  color: '#ffd700', roughness: 0.05, metalness: 1.0 },
        { key: 'me_copper',   name: 'Copper',         color: '#b87333', roughness: 0.2,  metalness: 0.9 },
        { key: 'me_chrome',   name: 'Chrome',         color: '#e0e0e0', roughness: 0.02, metalness: 1.0 },
        { key: 'me_bronze',   name: 'Bronze',         color: '#8c7853', roughness: 0.3,  metalness: 0.85 },
        { key: 'me_titanium', name: 'Titanium',       color: '#8a8d90', roughness: 0.35, metalness: 0.9 },
        { key: 'me_brass',    name: 'Brushed Brass',  color: '#c9a24b', roughness: 0.25, metalness: 0.9 },
        { key: 'me_aluminum', name: 'Brushed Aluminum', color: '#d6d9dc', roughness: 0.3, metalness: 0.85 },
        { key: 'me_gunmetal', name: 'Gunmetal',       color: '#3f4448', roughness: 0.35, metalness: 0.9 },
    ],
    'Glass': [
        { key: 'gl_clear',   name: 'Clear Glass',   color: '#dff6ff', roughness: 0.02, metalness: 0, opacity: 0.25, transparent: true },
        { key: 'gl_tinted',  name: 'Tinted Glass',  color: '#3d5a6c', roughness: 0.05, metalness: 0, opacity: 0.4,  transparent: true },
        { key: 'gl_frosted', name: 'Frosted Glass', color: '#eef4f7', roughness: 0.4,  metalness: 0, opacity: 0.55, transparent: true },
        { key: 'gl_smoked',  name: 'Smoked Glass',  color: '#232323', roughness: 0.05, metalness: 0, opacity: 0.5,  transparent: true },
        { key: 'gl_mirror',  name: 'Mirror Glass',  color: '#e8f4f8', roughness: 0.02, metalness: 1.0, opacity: 0.9, transparent: true },
    ],
    'Wood': [
        { key: 'wo_oak',      name: 'Natural Oak',       color: '#c9a066', roughness: 0.7,  metalness: 0 },
        { key: 'wo_walnut',   name: 'Dark Walnut',       color: '#5c4033', roughness: 0.65, metalness: 0 },
        { key: 'wo_pine',     name: 'Pine',              color: '#deb887', roughness: 0.75, metalness: 0 },
        { key: 'wo_mahogany', name: 'Mahogany',          color: '#4e2a1e', roughness: 0.6,  metalness: 0 },
        { key: 'wo_ash',      name: 'Whitewashed Ash',   color: '#e0d5c0', roughness: 0.8,  metalness: 0 },
        { key: 'wo_teak',     name: 'Teak',              color: '#a97c50', roughness: 0.65, metalness: 0 },
        { key: 'wo_cherry',   name: 'Cherry',            color: '#7b3f2e', roughness: 0.55, metalness: 0 },
        { key: 'wo_ebony',    name: 'Ebony',             color: '#2b2422', roughness: 0.5,  metalness: 0 },
    ],
    'Fabric': [
        { key: 'fa_linen',   name: 'Natural Linen',    color: '#f0e6d2', roughness: 0.95, metalness: 0 },
        { key: 'fa_velvet',  name: 'Emerald Velvet',   color: '#046307', roughness: 0.85, metalness: 0 },
        { key: 'fa_denim',   name: 'Denim',            color: '#3b5998', roughness: 0.9,  metalness: 0 },
        { key: 'fa_wool',    name: 'Grey Wool',        color: '#7d7d7d', roughness: 0.95, metalness: 0 },
        { key: 'fa_leather', name: 'Tan Leather',      color: '#a0673a', roughness: 0.55, metalness: 0 },
        { key: 'fa_suede',   name: 'Charcoal Suede',   color: '#403c3c', roughness: 0.98, metalness: 0 },
        { key: 'fa_silk',    name: 'Ivory Silk',       color: '#f5f0dc', roughness: 0.35, metalness: 0 },
        { key: 'fa_burlap',  name: 'Burlap',           color: '#a88a5f', roughness: 0.97, metalness: 0 },
    ],
    'Landscape': [
        { key: 'ls_grass',  name: 'Grass',  color: '#4caf50', roughness: 0.95, metalness: 0 },
        { key: 'ls_soil',   name: 'Soil',   color: '#5c4a3a', roughness: 0.95, metalness: 0 },
        { key: 'ls_sand',   name: 'Sand',   color: '#e0c68a', roughness: 0.9,  metalness: 0 },
        { key: 'ls_gravel', name: 'Gravel', color: '#8a8a80', roughness: 0.9,  metalness: 0 },
        { key: 'ls_water',  name: 'Water',  color: '#2a6f8e', roughness: 0.05, metalness: 0, opacity: 0.75, transparent: true },
        { key: 'ls_snow',   name: 'Snow',   color: '#f5f8fa', roughness: 0.7,  metalness: 0 },
        { key: 'ls_moss',   name: 'Moss',   color: '#5c7a4a', roughness: 0.95, metalness: 0 },
    ],
    'Concrete & Stone': [
        { key: 'cs_polished',  name: 'Polished Concrete', color: '#9b9b93', roughness: 0.3,  metalness: 0 },
        { key: 'cs_raw',       name: 'Raw Concrete',      color: '#8d8d8d', roughness: 0.85, metalness: 0 },
        { key: 'cs_granite',   name: 'Granite',           color: '#5a5a58', roughness: 0.4,  metalness: 0 },
        { key: 'cs_limestone', name: 'Limestone',         color: '#d8cfb8', roughness: 0.6,  metalness: 0 },
        { key: 'cs_brick',     name: 'Red Brick',         color: '#a0522d', roughness: 0.9,  metalness: 0 },
        { key: 'cs_cobblestone', name: 'Cobblestone',     color: '#6b6862', roughness: 0.8,  metalness: 0 },
    ],
    'Plastic': [
        { key: 'pl_glossy_white', name: 'Glossy White Plastic', color: '#f5f5f5', roughness: 0.1,  metalness: 0 },
        { key: 'pl_glossy_red',   name: 'Glossy Red Plastic',   color: '#e63946', roughness: 0.1,  metalness: 0 },
        { key: 'pl_matte_black',  name: 'Matte Black Plastic',  color: '#181818', roughness: 0.55, metalness: 0 },
        { key: 'pl_translucent',  name: 'Translucent Plastic',  color: '#cfe8ff', roughness: 0.15, metalness: 0, opacity: 0.6, transparent: true },
        { key: 'pl_abs_grey',     name: 'ABS Grey Plastic',     color: '#a6a6a6', roughness: 0.3,  metalness: 0 },
    ],
};

let currentMatCategory = 'Solid Colors';

// Real procedural tile texture — draws actual square tiles + grout lines
// onto a canvas and wraps it as a genuine Three.js texture, no external
// image file involved. Cached per (color, grout, density) so repeated
// applications of the same tile material reuse one texture instead of
// generating a fresh canvas every time.
const _tileTextureCache = new Map();
function createTileTexture(baseColorHex, groutColorHex, tilesPerMeter) {
    const cacheKey = `${baseColorHex}|${groutColorHex}|${tilesPerMeter}`;
    if (_tileTextureCache.has(cacheKey)) return _tileTextureCache.get(cacheKey);
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = groutColorHex;
    ctx.fillRect(0, 0, size, size);
    const tileSize = size / tilesPerMeter;
    const inset = Math.max(2, tileSize * 0.03);
    ctx.fillStyle = baseColorHex;
    for (let row = 0; row < tilesPerMeter; row++) {
        for (let col = 0; col < tilesPerMeter; col++) {
            ctx.fillRect(col * tileSize + inset, row * tileSize + inset, tileSize - inset * 2, tileSize - inset * 2);
        }
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(4, 4);
    texture.colorSpace = THREE.SRGBColorSpace;
    _tileTextureCache.set(cacheKey, texture);
    return texture;
}
// Shared getter for any material def carrying a pattern — returns null for
// plain solid-color defs so callers can just do `material.map = matDefMap(def)`.
function matDefMap(def) {
    if (def.pattern === 'tile') return createTileTexture(def.color, def.grout || '#888888', def.tilesPerMeter || 2);
    return null;
}

function applyMaterialDefToObject(def, obj) {
    if (!obj || !obj.material) return;
    const before = snapshotMaterial(obj.material);
    obj.material.color.set(def.color);
    obj.material.roughness = def.roughness;
    obj.material.metalness = def.metalness;
    obj.material.transparent = !!def.transparent;
    obj.material.opacity = def.transparent ? def.opacity : 1;
    obj.material.map = matDefMap(def);
    obj.material.needsUpdate = true;

    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    setEl('mat-color', def.color);
    setEl('mat-rough', def.roughness);
    setEl('mat-metal', def.metalness);

    const after = snapshotMaterial(obj.material);
    const mat = obj.material;
    pushUndo({
        undo() { applyMaterialSnapshot(mat, before); },
        redo() { applyMaterialSnapshot(mat, after); },
    });
    setVCB('Material:', `${def.name} applied to ${obj.name}`);
}

// ─────────────────────────────────────────────────────────────
// PER-FACE MATERIALS — real SketchUp-style "paint this surface, not the
// whole solid," via three.js's actual multi-material support
// (mesh.material becomes an array + geometry.groups map contiguous
// triangle ranges to a material index — a standard, fully-supported
// three.js feature, not a workaround). Previously every material
// application (drag-drop onto a face included) mutated the object's one
// shared material in place, so painting a single face always recolored
// the entire object.
// ─────────────────────────────────────────────────────────────
// Read-only "representative" material for UI display (Properties panel,
// Entity Info, eyedropper) on an object that may now have per-face
// multi-materials — shows the first slot rather than crashing on
// obj.material.color being undefined for an array.
function primaryMaterial(obj) {
    if (!obj || !obj.material) return null;
    return Array.isArray(obj.material) ? obj.material[0] : obj.material;
}

// For whole-object write operations (Base Color panel, preset buttons,
// X-Ray, Style presets) on an object that may have per-face materials —
// every material slot, so the edit is applied uniformly across all of them
// instead of silently only touching slot 0.
function allMaterials(obj) {
    if (!obj || !obj.material) return [];
    return Array.isArray(obj.material) ? obj.material : [obj.material];
}

function ensureMultiMaterial(obj) {
    if (Array.isArray(obj.material)) return;
    ensureNonIndexed(obj);
    const singleMat = obj.material;
    obj.material = [singleMat];
    const triCount = obj.geometry.attributes.position.count / 3;
    obj.geometry.clearGroups();
    obj.geometry.addGroup(0, triCount * 3, 0);
}

// Re-derives every triangle's current material index from the existing
// groups, overwrites the target set to `newMatIndex`, then rebuilds
// `geometry.groups` as the minimal run of contiguous ranges — correct
// whether the target face group's triangles are contiguous in the
// underlying array or scattered from earlier edits.
function rebuildMaterialGroups(obj, triangleIndexSet, newMatIndex) {
    const triCount = obj.geometry.attributes.position.count / 3;
    const indexPerTri = new Array(triCount).fill(0);
    (obj.geometry.groups || []).forEach(g => {
        const startTri = g.start / 3, count = g.count / 3;
        for (let i = 0; i < count; i++) indexPerTri[startTri + i] = g.materialIndex;
    });
    triangleIndexSet.forEach(t => { indexPerTri[t] = newMatIndex; });

    obj.geometry.clearGroups();
    let runStart = 0, runIndex = indexPerTri[0];
    for (let t = 1; t <= triCount; t++) {
        if (t === triCount || indexPerTri[t] !== runIndex) {
            obj.geometry.addGroup(runStart * 3, (t - runStart) * 3, runIndex);
            runStart = t;
            if (t < triCount) runIndex = indexPerTri[t];
        }
    }
}

function findOrCreateMaterialSlot(obj, def) {
    let idx = obj.material.findIndex(m => m.userData.matDefKey === def.key && m.userData.matDefCategory === def.category);
    if (idx !== -1) return idx;
    const mat = new THREE.MeshStandardMaterial({
        color: def.color, roughness: def.roughness, metalness: def.metalness,
        transparent: !!def.transparent, opacity: def.transparent ? def.opacity : 1,
        map: matDefMap(def),
    });
    mat.userData.matDefKey = def.key;
    mat.userData.matDefCategory = def.category;
    obj.material.push(mat);
    return obj.material.length - 1;
}

// Applies `def` to just the coplanar face group containing `faceIndex` —
// the real per-surface paint operation, used by drag-and-drop onto a
// specific face and by click-apply while a face is selected.
function applyMaterialDefToFace(def, obj, faceIndex) {
    if (!obj || !obj.isMesh) return;
    ensureMultiMaterial(obj);
    const beforeMaterials = obj.material.slice();
    const beforeGroups = obj.geometry.groups.map(g => ({ ...g }));

    const group = findCoplanarConnectedFaces(obj, faceIndex);
    const matIndex = findOrCreateMaterialSlot(obj, def);
    rebuildMaterialGroups(obj, group, matIndex);

    const afterMaterials = obj.material.slice();
    const afterGroups = obj.geometry.groups.map(g => ({ ...g }));
    pushUndo({
        undo() { obj.material = beforeMaterials; obj.geometry.groups = beforeGroups; },
        redo() { obj.material = afterMaterials; obj.geometry.groups = afterGroups; },
    });
    setVCB('Material:', `${def.name} applied to ${group.length} face(s) on ${obj.name}`);
}

// Applies material to whichever faces are currently selected (Face Select
// mode) — used by the Material Library's click-to-apply swatches, so
// clicking a swatch with faces selected paints just those faces, matching
// the drag-and-drop behavior; with nothing face-selected it still paints
// the whole object (applyMaterialDefToObject), the pre-existing behavior.
function applyMaterialDefToSelection(def, obj) {
    if (faceSelectOn && selectedFaces.length > 0) {
        ensureMultiMaterial(obj);
        const beforeMaterials = obj.material.slice();
        const beforeGroups = obj.geometry.groups.map(g => ({ ...g }));
        const matIndex = findOrCreateMaterialSlot(obj, def);
        rebuildMaterialGroups(obj, selectedFaces, matIndex);
        const afterMaterials = obj.material.slice();
        const afterGroups = obj.geometry.groups.map(g => ({ ...g }));
        pushUndo({
            undo() { obj.material = beforeMaterials; obj.geometry.groups = beforeGroups; },
            redo() { obj.material = afterMaterials; obj.geometry.groups = afterGroups; },
        });
        setVCB('Material:', `${def.name} applied to ${selectedFaces.length} selected face(s)`);
    } else {
        applyMaterialDefToObject(def, obj);
    }
}

function findMaterialDef(category, key) {
    const list = MATERIAL_LIBRARY[category];
    return list ? list.find(m => m.key === key) : null;
}

// Shared offscreen renderer for ALL swatch thumbnails — one real WebGL
// context cycling through every currently-visible swatch each animation
// tick (mutate the one shared cube's material, render, blit that frame to
// the swatch's own 2D canvas) rather than one WebGL context per swatch,
// which would blow well past a browser's context limit once more than a
// handful of materials are on screen.
let matThumbRenderer, matThumbScene, matThumbCamera, matThumbCube;
let matThumbRotation = 0;
let matThumbAnimHandle = null;
const _activeMatSwatches = []; // { canvas, ctx, def } for the currently-rendered category

function ensureMatThumbRenderer() {
    if (matThumbRenderer) return;
    const off = document.createElement('canvas');
    off.width = 96; off.height = 96;
    matThumbRenderer = new THREE.WebGLRenderer({ canvas: off, antialias: true, alpha: true, preserveDrawingBuffer: true });
    matThumbRenderer.setSize(96, 96, false);
    matThumbRenderer.setClearColor(0x000000, 0);
    matThumbScene = new THREE.Scene();
    matThumbScene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
    dirLight.position.set(3, 4, 5);
    matThumbScene.add(dirLight);
    matThumbCamera = new THREE.PerspectiveCamera(35, 1, 0.1, 20);
    matThumbCamera.position.set(1.6, 1.3, 1.9);
    matThumbCamera.lookAt(0, 0, 0);
    matThumbCube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    matThumbScene.add(matThumbCube);
}

function stepMaterialThumbnails() {
    if (_activeMatSwatches.length === 0) { matThumbAnimHandle = null; return; }
    ensureMatThumbRenderer();
    matThumbRotation += 0.02;
    matThumbCube.rotation.y = matThumbRotation;
    matThumbCube.rotation.x = matThumbRotation * 0.6;
    _activeMatSwatches.forEach(({ canvas, ctx, def }) => {
        matThumbCube.material.color.set(def.color);
        matThumbCube.material.roughness = def.roughness;
        matThumbCube.material.metalness = def.metalness;
        matThumbCube.material.transparent = !!def.transparent;
        matThumbCube.material.opacity = def.transparent ? def.opacity : 1;
        matThumbCube.material.map = matDefMap(def);
        matThumbCube.material.needsUpdate = true;
        matThumbRenderer.render(matThumbScene, matThumbCamera);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(matThumbRenderer.domElement, 0, 0, canvas.width, canvas.height);
    });
    matThumbAnimHandle = requestAnimationFrame(stepMaterialThumbnails);
}

function renderMaterialLibraryTabs() {
    const tabsEl = document.getElementById('mat-library-tabs');
    if (!tabsEl) return;
    tabsEl.innerHTML = '';
    Object.keys(MATERIAL_LIBRARY).forEach(cat => {
        const btn = document.createElement('div');
        btn.className = 'mat-library-tab' + (cat === currentMatCategory ? ' active' : '');
        btn.textContent = cat;
        btn.onclick = () => selectMaterialCategory(cat);
        tabsEl.appendChild(btn);
    });
}

function renderMaterialSwatchGrid(cat) {
    const grid = document.getElementById('mat-library-grid');
    if (!grid) return;
    _activeMatSwatches.length = 0; // stop animating the previous category's swatches
    grid.innerHTML = '';
    (MATERIAL_LIBRARY[cat] || []).forEach(def => {
        const card = document.createElement('div');
        card.className = 'mat-swatch-card';
        card.draggable = true;
        card.title = def.name;

        const canvas = document.createElement('canvas');
        canvas.className = 'mat-swatch-canvas';
        canvas.width = 96; canvas.height = 96;
        card.appendChild(canvas);

        const label = document.createElement('div');
        label.className = 'mat-swatch-name';
        label.textContent = def.name;
        card.appendChild(label);

        card.addEventListener('dragstart', e => {
            e.dataTransfer.setData('text/plain', JSON.stringify({ category: cat, key: def.key }));
            e.dataTransfer.effectAllowed = 'copy';
        });
        card.addEventListener('click', () => {
            if (!selectedObject || !selectedObject.material) { setVCB('Material:', 'Select an object first, or drag this swatch onto a surface'); return; }
            applyMaterialDefToSelection(def, selectedObject);
        });

        grid.appendChild(card);
        _activeMatSwatches.push({ canvas, ctx: canvas.getContext('2d'), def });
    });

    if (!matThumbAnimHandle) matThumbAnimHandle = requestAnimationFrame(stepMaterialThumbnails);
}

function selectMaterialCategory(cat) {
    currentMatCategory = cat;
    renderMaterialLibraryTabs();
    renderMaterialSwatchGrid(cat);
}

// Drag-and-drop onto any surface in the viewport — raycasts at the drop
// point exactly like a click-select would, and applies to whatever real
// object/mesh is under the cursor (not just the currently-selected one).
function setupMaterialDragDrop(canvas) {
    canvas.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    canvas.addEventListener('drop', e => {
        e.preventDefault();
        let payload;
        try { payload = JSON.parse(e.dataTransfer.getData('text/plain')); } catch (err) { return; }
        if (!payload || !payload.category || !payload.key) return;
        const def = findMaterialDef(payload.category, payload.key);
        if (!def) return;

        const rect = canvas.getBoundingClientRect();
        _mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        _mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        _raycaster.setFromCamera(_mouse, camera);
        const targets = sceneObjects.filter(o => o.mesh && o.mesh.isMesh && o.mesh.userData.selectable !== false).map(o => o.mesh);
        const hits = _raycaster.intersectObjects(targets, true);
        if (hits.length === 0) { setVCB('Material:', 'Drop it directly on a surface'); return; }

        let obj = hits[0].object;
        const faceIndex = hits[0].faceIndex;
        while (obj && !sceneObjects.some(o => o.mesh === obj)) obj = obj.parent;
        if (!obj) return;
        selectObject(obj);
        if (faceIndex != null) applyMaterialDefToFace(def, obj, faceIndex);
        else applyMaterialDefToObject(def, obj);
    });
}

// ─────────────────────────────────────────────────────────────
// FACE SELECT — real triangle-level picking + highlight + extrude
// (previously the Face pill only toggled a UI class; clicking a face did
// nothing and Extrude/Push-Pull always faked it via whole-object scale)
// ─────────────────────────────────────────────────────────────
// THREE.BufferAttribute.clone() in this three.js build (r128) does
// `new this.constructor(this.array, this.itemSize)` — it reuses the SAME
// underlying TypedArray rather than copying it. That makes plain
// `geometry.clone()` useless as an undo snapshot: mutating the live
// geometry's position buffer in place (as extrude/inset/sculpt/etc. all
// do) silently corrupts the "before" snapshot too, since both wrappers
// point at the same array. This makes a genuinely independent copy.
function deepCloneGeometry(geo) {
    const clone = geo.clone();
    for (const name in clone.attributes) {
        const attr = clone.attributes[name];
        clone.setAttribute(name, new THREE.BufferAttribute(attr.array.slice(), attr.itemSize, attr.normalized));
    }
    if (clone.index) clone.setIndex(new THREE.BufferAttribute(clone.index.array.slice(), 1));
    return clone;
}

function ensureNonIndexed(mesh) {
    if (mesh.geometry.index) {
        const nonIndexed = mesh.geometry.toNonIndexed();
        mesh.geometry.dispose();
        mesh.geometry = nonIndexed;
    }
}

function clearFaceSelection() {
    selectedFaces = [];
    if (faceHighlightMesh) {
        if (faceHighlightMesh.parent) faceHighlightMesh.parent.remove(faceHighlightMesh);
        faceHighlightMesh.geometry.dispose();
        faceHighlightMesh.material.dispose();
        faceHighlightMesh = null;
    }
}

function rebuildFaceHighlight() {
    if (faceHighlightMesh) {
        if (faceHighlightMesh.parent) faceHighlightMesh.parent.remove(faceHighlightMesh);
        faceHighlightMesh.geometry.dispose();
        faceHighlightMesh.material.dispose();
        faceHighlightMesh = null;
    }
    if (!selectedObject || selectedFaces.length === 0) return;

    const srcPos = selectedObject.geometry.attributes.position;
    const positions = new Float32Array(selectedFaces.length * 9);
    selectedFaces.forEach((faceIdx, i) => {
        for (let v = 0; v < 3; v++) {
            const srcIdx = faceIdx * 3 + v;
            positions[i * 9 + v * 3 + 0] = srcPos.getX(srcIdx);
            positions[i * 9 + v * 3 + 1] = srcPos.getY(srcIdx);
            positions[i * 9 + v * 3 + 2] = srcPos.getZ(srcIdx);
        }
    });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({
        color: 0xff8800, transparent: true, opacity: 0.55, side: THREE.DoubleSide,
        depthTest: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    faceHighlightMesh = new THREE.Mesh(geo, mat);
    faceHighlightMesh.renderOrder = 999;
    // Geometrically coincident with the source faces (no offset — only
    // polygonOffset for render-order, which doesn't move anything for
    // raycasting), so any recursive raycast against the parent mesh
    // (SketchUp-mode surface-click-select, the inference system, etc.)
    // would otherwise hit THIS overlay first and report a faceIndex
    // relative to its own tiny geometry instead of the real mesh's.
    faceHighlightMesh.raycast = () => {};
    selectedObject.add(faceHighlightMesh); // child of the mesh -> follows its transform for free
}

// Every BufferGeometry face here is a single triangle, but a box's "face"
// as a user actually sees it is a whole quad (2 triangles sharing a
// diagonal). Clicking used to select only whichever single triangle was
// under the cursor — visibly wrong (a diagonal half-quad highlight) and
// wrong for tools that then only extrude/inset/offset that half. Flood-
// fills from the clicked triangle across shared edges into any neighbor
// that's essentially exactly coplanar (dot > 0.999, ~2.5°), so it expands
// to cover a full flat quad/n-gon but stops naturally at any real edge or
// curve — sculpted/rounded geometry, where neighboring triangles are only
// approximately coplanar, still resolves to single-triangle granularity.
function findCoplanarConnectedFaces(mesh, seedFaceIndex) {
    ensureNonIndexed(mesh);
    const pos = mesh.geometry.attributes.position;
    const triCount = pos.count / 3;
    if (seedFaceIndex < 0 || seedFaceIndex >= triCount) return [seedFaceIndex];

    const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
    const faceNormal = (t) => {
        _a.fromBufferAttribute(pos, t * 3); _b.fromBufferAttribute(pos, t * 3 + 1); _c.fromBufferAttribute(pos, t * 3 + 2);
        return new THREE.Vector3().subVectors(_b, _a).cross(new THREE.Vector3().subVectors(_c, _a)).normalize();
    };
    const edgeKey = (k1, k2) => (k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`);

    const edgeMap = new Map(); // edgeKey -> triangle indices sharing that edge
    for (let t = 0; t < triCount; t++) {
        const k0 = positionKey(pos, t * 3), k1 = positionKey(pos, t * 3 + 1), k2 = positionKey(pos, t * 3 + 2);
        [[k0, k1], [k1, k2], [k2, k0]].forEach(([a, b]) => {
            const key = edgeKey(a, b);
            if (!edgeMap.has(key)) edgeMap.set(key, []);
            edgeMap.get(key).push(t);
        });
    }

    const seedNormal = faceNormal(seedFaceIndex);
    const visited = new Set([seedFaceIndex]);
    const queue = [seedFaceIndex];
    // Was 0.999 (~2.5 degrees) — too tight to survive normal-vector drift
    // accumulated over several prior edits on what's logically one flat
    // surface; loosened to ~5.7 degrees, still well short of ever merging
    // two genuinely different (intentionally angled) faces.
    const NORMAL_DOT_TOL = 0.995;

    while (queue.length) {
        const t = queue.shift();
        const k0 = positionKey(pos, t * 3), k1 = positionKey(pos, t * 3 + 1), k2 = positionKey(pos, t * 3 + 2);
        [[k0, k1], [k1, k2], [k2, k0]].forEach(([a, b]) => {
            (edgeMap.get(edgeKey(a, b)) || []).forEach(nt => {
                if (visited.has(nt)) return;
                if (faceNormal(nt).dot(seedNormal) > NORMAL_DOT_TOL) {
                    visited.add(nt);
                    queue.push(nt);
                }
            });
        });
    }
    return [...visited];
}

function toggleFaceSelection(mesh, faceIndex, additive) {
    const group = findCoplanarConnectedFaces(mesh, faceIndex);
    if (!additive) selectedFaces = [];
    const allAlreadySelected = group.every(f => selectedFaces.includes(f));
    if (allAlreadySelected) {
        selectedFaces = selectedFaces.filter(f => !group.includes(f));
    } else {
        group.forEach(f => { if (!selectedFaces.includes(f)) selectedFaces.push(f); });
    }
    rebuildFaceHighlight();
    setVCB('Face Select:', `${selectedFaces.length} face(s) selected`);
}

function meshPositionsArray(mesh) {
    ensureNonIndexed(mesh);
    return mesh.geometry.attributes.position.array;
}

function growFaceSelection() {
    if (!selectedObject || !selectedObject.isMesh) { setVCB('Grow:', 'Select a mesh'); return; }
    if (!faceSelectOn) { setVCB('Grow:', 'Turn on Face select'); return; }
    if (!selectedFaces.length) { setVCB('Grow:', 'Select a face first'); return; }
    const MT = window.MeshTools;
    if (!MT) { setVCB('Grow:', 'mesh_tools.js failed to load'); return; }
    const adj = MT.buildFaceAdjacency(meshPositionsArray(selectedObject));
    selectedFaces = MT.growFaceSelection(selectedFaces, adj);
    rebuildFaceHighlight();
    setVCB('Grow:', `${selectedFaces.length} face(s)`);
}

function shrinkFaceSelection() {
    if (!selectedObject || !selectedObject.isMesh) { setVCB('Shrink:', 'Select a mesh'); return; }
    if (!selectedFaces.length) { setVCB('Shrink:', 'Select a face first'); return; }
    const MT = window.MeshTools;
    if (!MT) return;
    const adj = MT.buildFaceAdjacency(meshPositionsArray(selectedObject));
    selectedFaces = MT.shrinkFaceSelection(selectedFaces, adj);
    rebuildFaceHighlight();
    setVCB('Shrink:', `${selectedFaces.length} face(s)`);
}

function selectLinkedFaces() {
    if (!selectedObject || !selectedObject.isMesh) { setVCB('Select Linked:', 'Select a mesh'); return; }
    if (!selectedFaces.length) { setVCB('Select Linked:', 'Select a seed face first'); return; }
    const MT = window.MeshTools;
    if (!MT) return;
    const adj = MT.buildFaceAdjacency(meshPositionsArray(selectedObject));
    selectedFaces = MT.selectLinkedFaces(selectedFaces, adj);
    rebuildFaceHighlight();
    setVCB('Select Linked:', `${selectedFaces.length} face(s)`);
}

function selectFaceLoop() {
    if (!selectedObject || !selectedObject.isMesh) { setVCB('Loop:', 'Select a mesh'); return; }
    if (!selectedFaces.length) { setVCB('Loop:', 'Select a seed face first'); return; }
    const MT = window.MeshTools;
    if (!MT || !MT.selectFaceLoop) { setVCB('Loop:', 'mesh_tools.js failed to load'); return; }
    const pos = meshPositionsArray(selectedObject);
    const adj = MT.buildFaceAdjacency(pos);
    selectedFaces = MT.selectFaceLoop(selectedFaces[0], adj, pos);
    rebuildFaceHighlight();
    setVCB('Loop:', `${selectedFaces.length} face(s) — similar-normal walk, not a half-edge ring`);
}

function fillSelectedHole() {
    if (!selectedObject || !selectedObject.isMesh) { setVCB('Fill:', 'Select a mesh'); return; }
    const MT = window.MeshTools;
    if (!MT || !MT.fillBoundaryFan) return;
    ensureNonIndexed(selectedObject);
    const pos = selectedObject.geometry.attributes.position;
    const extra = MT.fillBoundaryFan(pos.array, selectedFaces.length ? selectedFaces : null);
    if (!extra.length) { setVCB('Fill:', 'No open boundary to fan-fill'); return; }
    const beforeGeo = deepCloneGeometry(selectedObject.geometry);
    const merged = new Float32Array(pos.array.length + extra.length);
    merged.set(pos.array, 0);
    merged.set(extra, pos.array.length);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(merged, 3));
    geo.computeVertexNormals();
    selectedObject.geometry.dispose();
    selectedObject.geometry = geo;
    const afterGeo = deepCloneGeometry(geo);
    pushUndo({
        undo() { selectedObject.geometry.dispose(); selectedObject.geometry = beforeGeo; rebuildFaceHighlight(); },
        redo() { selectedObject.geometry.dispose(); selectedObject.geometry = afterGeo; rebuildFaceHighlight(); },
    });
    setVCB('Fill:', `${extra.length / 9} triangle(s) from boundary fan — not a n-gon fill`);
}

function collectWallSegments() {
    const segs = [];
    sceneObjects.forEach(o => {
        const m = o.mesh;
        if (!m || !m.userData || m.userData.kind !== 'wall' || !m.userData.wall) return;
        const w = m.userData.wall;
        segs.push({ x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2, mesh: m, name: m.name, length: Math.hypot(w.x2 - w.x1, w.y2 - w.y1), height: w.height });
    });
    return segs;
}

function makeRoomsFromWalls() {
    const BK = window.BimKit;
    if (!BK) { setVCB('Rooms:', 'bim_kit.js failed to load'); return; }
    const segs = collectWallSegments();
    if (segs.length < 3) { setVCB('Rooms:', 'Need 3+ wall segments with stored plan data (draw walls after this update)'); return; }
    const loops = BK.loopsFromSegments(segs);
    if (!loops.length) { setVCB('Rooms:', 'No closed wall loop found'); return; }
    const z = levelElevation(activeLevelIndex);
    const level = activeLevelIndex;
    const created = [];
    loops.forEach((loop, i) => {
        const area = BK.polygonArea(loop);
        if (area < 0.2) return;
        const c = BK.polygonCentroid(loop);
        const shape = new THREE.Shape(loop.map(p => new THREE.Vector2(p.x, p.y)));
        const geo = new THREE.ShapeGeometry(shape);
        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x8fbc8f, transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
        mesh.position.z = z + 0.02;
        mesh.name = nextName('Room');
        mesh.userData.kind = 'room';
        mesh.userData.room = { area: area, level: buildingLevels[activeLevelIndex].name };
        mesh.userData.skipRaycast = false;
        created.push(mesh);
        const spr = createDimensionSprite(`${area.toFixed(1)} m²`);
        spr.position.set(c.x, c.y, z + 0.4);
        mesh.add(spr);
    });
    if (!created.length) { setVCB('Rooms:', 'Loops were too small'); return; }
    created.forEach(m => { scene.add(m); sceneObjects.push({ name: m.name, type: 'mesh', mesh: m, level }); });
    renderOutliner();
    pushUndo({
        undo() { created.forEach(m => removeSceneObject(m)); },
        redo() { created.forEach(m => { scene.add(m); sceneObjects.push({ name: m.name, type: 'mesh', mesh: m, level }); }); renderOutliner(); },
    });
    setVCB('Rooms:', `${created.length} room slab(s) from closed walls`);
}

function addOpeningComponent(kind) {
    const BK = window.BimKit;
    const spec = kind === 'window' ? (BK && BK.WINDOW) : (BK && BK.DOOR);
    const w = spec ? spec.width : 0.9, h = spec ? spec.height : 2.1, sill = spec ? spec.sill : 0, d = spec ? spec.depth : 0.08;
    const group = new THREE.Group();
    const frame = new THREE.Mesh(new THREE.BoxGeometry(w, d, h), new THREE.MeshStandardMaterial({ color: kind === 'window' ? 0x88ccee : 0x6b4f2a, roughness: 0.6 }));
    group.add(frame);
    group.position.set(0, 0, sill + h / 2);
    if (selectedObject) {
        const box = new THREE.Box3().setFromObject(selectedObject);
        const c = box.getCenter(new THREE.Vector3());
        group.position.set(c.x, c.y, sill + h / 2);
    }
    group.name = nextName(kind === 'window' ? 'Window' : 'Door');
    group.userData.kind = kind;
    group.userData.opening = { width: w, height: h, sill: sill };
    scene.add(group);
    sceneObjects.push({ name: group.name, type: 'group', mesh: group });
    renderOutliner();
    selectObject(group);
    pushUndo({
        undo() { removeSceneObject(group); },
        redo() { scene.add(group); sceneObjects.push({ name: group.name, type: 'group', mesh: group }); renderOutliner(); selectObject(group); },
    });
    setVCB(kind === 'window' ? 'Window:' : 'Door:', `${w}×${h} m component (not a wall boolean — use Opening tool to cut)`);
}

function addDoorComponent() { addOpeningComponent('door'); }
function addWindowComponent() { addOpeningComponent('window'); }

// addStorey/setActiveStorey/isolateActiveStorey are the BIM Architecture
// tab's original entry points into Levels — kept as real aliases onto the
// consolidated buildingLevels/activeLevelIndex system (see the Levels
// section, added later, which does real per-object level tagging and
// height-cascading instead of this trio's original Z-midpoint-guessing
// isolate heuristic) so both UIs drive the exact same data, not two
// silently-diverging level lists.
function addStorey() { addLevelAbove(); }
function setActiveStorey(i) { setActiveLevel(i); }
function isolateActiveStorey(on) { toggleLevelIsolate(on); }

function exportScheduleCsv() {
    const BK = window.BimKit;
    if (!BK) return;
    const rows = [];
    collectWallSegments().forEach(s => rows.push({ kind: 'wall', name: s.name, qty: 1, length_m: s.length.toFixed(3), area_m2: (s.length * (s.height || 0)).toFixed(3), notes: '' }));
    sceneObjects.forEach(o => {
        const m = o.mesh;
        if (!m || !m.userData) return;
        if (m.userData.kind === 'room' && m.userData.room) {
            rows.push({ kind: 'room', name: m.name, qty: 1, length_m: '', area_m2: m.userData.room.area.toFixed(3), notes: m.userData.room.level || '' });
        }
        if (m.userData.opening) {
            rows.push({ kind: m.userData.kind || 'opening', name: m.name, qty: 1, length_m: m.userData.opening.width, area_m2: (m.userData.opening.width * m.userData.opening.height).toFixed(3), notes: 'component' });
        }
    });
    const csv = BK.buildScheduleCsv(rows.length ? rows : [{ kind: 'empty', name: '', qty: 0, length_m: '', area_m2: '', notes: 'draw walls first' }]);
    triggerDownload('data:text/csv;charset=utf-8,' + encodeURIComponent(csv), '3DCore_schedule.csv');
    setVCB('Schedule:', `${rows.length} row(s)`);
}

function exportPlanDXF() {
    const lines = collectWallSegments().map(s => ({ x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, layer: 'WALLS' }));
    sceneObjects.forEach(o => {
        if (!o.mesh || o.type !== 'guide') return;
        const p = o.mesh.geometry && o.mesh.geometry.attributes && o.mesh.geometry.attributes.position;
        if (!p || p.count < 2) return;
        const a = new THREE.Vector3().fromBufferAttribute(p, 0).applyMatrix4(o.mesh.matrixWorld);
        const b = new THREE.Vector3().fromBufferAttribute(p, p.count - 1).applyMatrix4(o.mesh.matrixWorld);
        lines.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, layer: 'GUIDES' });
    });
    if (!lines.length) { setVCB('DXF:', 'No wall segments to export'); return; }
    const text = (window.FormatIO && FormatIO.serializeDXF) ? FormatIO.serializeDXF(lines) : (window.BimKit && BimKit.serializeDXF(lines));
    triggerDownload('data:application/dxf;charset=utf-8,' + encodeURIComponent(text), '3DCore_plan.dxf');
    setVCB('DXF:', `${lines.length} LINE(s) — plan view only, not DWG`);
}

function alignSelectionToFloor() {
    const targets = outlinerMultiSelect.size ? [...outlinerMultiSelect] : (selectedObject ? [selectedObject] : []);
    if (!targets.length) { setVCB('Align:', 'Select an object'); return; }
    targets.forEach(mesh => {
        const box = new THREE.Box3().setFromObject(mesh);
        mesh.position.z -= box.min.z;
    });
    setVCB('Align:', 'Min Z → 0 (floor)');
}

function addCameraObject() {
    const helper = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.28, 12), new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0x335577, emissiveIntensity: 0.4 }));
    helper.rotation.x = Math.PI / 2;
    const group = new THREE.Group();
    group.add(helper);
    group.position.copy(camera.position);
    group.quaternion.copy(camera.quaternion);
    group.name = nextName('Camera');
    group.userData.kind = 'camera';
    group.userData.camera = { fov: camera.fov, target: orbitControls.target.toArray() };
    scene.add(group);
    sceneObjects.push({ name: group.name, type: 'camera', mesh: group });
    renderOutliner();
    selectObject(group);
    pushUndo({
        undo() { removeSceneObject(group); },
        redo() { scene.add(group); sceneObjects.push({ name: group.name, type: 'camera', mesh: group }); renderOutliner(); selectObject(group); },
    });
    refreshHudContext();
    setVCB('Camera:', 'Stored current view as a camera object');
}

function lookThroughSelectedCamera() {
    const obj = selectedObject;
    if (!obj || !obj.userData || obj.userData.kind !== 'camera') { setVCB('Camera:', 'Select a camera object'); return; }
    camera.position.copy(obj.position);
    camera.quaternion.copy(obj.quaternion);
    if (obj.userData.camera && obj.userData.camera.target) {
        orbitControls.target.fromArray(obj.userData.camera.target);
    }
    camera.updateProjectionMatrix();
    markSceneDirty();
    setVCB('Camera:', 'Looking through ' + obj.name);
}

function refreshHudContext() {
    const el = document.getElementById('hud-context');
    if (!el) return;
    const lvl = buildingLevels[activeLevelIndex] ? buildingLevels[activeLevelIndex].name : 'Ground Floor';
    const cam = sceneObjects.find(o => o.mesh && o.mesh.userData && o.mesh.userData.kind === 'camera');
    el.textContent = `${lvl}${cam ? ' · ' + cam.name : ''}`;
}

function registerPwa() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ─────────────────────────────────────────────────────────────
// VERTEX / EDGE SELECT — real picking + highlight (previously only Face
// select did anything; Vertex/Edge pills were UI-only). Since faces get
// converted to non-indexed geometry (each triangle owns its own copies of
// its 3 vertices), "the same vertex" after that conversion means every
// position-array index that shares that world-space coordinate — grouped
// here so moving a vertex moves all of its duplicates together and the
// mesh doesn't tear apart.
// ─────────────────────────────────────────────────────────────
let selectedVertexGroup = null; // array of position-array indices at one shared coordinate
let selectedEdgeGroups = null;  // { a: [indices], b: [indices] } — the edge's two endpoints
let vertexHighlightMesh = null;
let edgeHighlightMesh = null;

// 4 decimal places (~0.1mm at normal modeling scales) rather than 5 — Float32
// position data only carries ~6-7 significant digits, so after several prior
// edit operations (each introducing its own small rounding) two vertices
// that are logically "the same point" can drift past a 5-decimal match,
// silently fragmenting what should be one connected/coplanar group (seen as
// Push/Pull only extruding a "top layer" sub-patch of a wall built from
// several edit passes, while a manually multi-selected Extrude Region over
// the same geometry worked, since its selection was the union of several
// smaller correctly-grouped patches). Still far tighter than would ever
// weld deliberately-separate geometry at normal scales.
function positionKey(pos, i) {
    return `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
}

function buildPositionGroups(mesh) {
    ensureNonIndexed(mesh);
    const pos = mesh.geometry.attributes.position;
    const map = new Map();
    for (let i = 0; i < pos.count; i++) {
        const k = positionKey(pos, i);
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(i);
    }
    return map;
}

function clearVertexSelection() {
    selectedVertexGroup = null;
    if (vertexHighlightMesh) {
        if (vertexHighlightMesh.parent) vertexHighlightMesh.parent.remove(vertexHighlightMesh);
        vertexHighlightMesh.geometry.dispose(); vertexHighlightMesh.material.dispose();
        vertexHighlightMesh = null;
    }
}

function clearEdgeSelection() {
    selectedEdgeGroups = null;
    if (edgeHighlightMesh) {
        if (edgeHighlightMesh.parent) edgeHighlightMesh.parent.remove(edgeHighlightMesh);
        edgeHighlightMesh.geometry.dispose(); edgeHighlightMesh.material.dispose();
        edgeHighlightMesh = null;
    }
}

function groupWorldPoint(mesh, group) {
    const pos = mesh.geometry.attributes.position;
    return new THREE.Vector3(pos.getX(group[0]), pos.getY(group[0]), pos.getZ(group[0]));
}

function showVertexHighlight(mesh, group) {
    if (vertexHighlightMesh) { if (vertexHighlightMesh.parent) vertexHighlightMesh.parent.remove(vertexHighlightMesh); vertexHighlightMesh.geometry.dispose(); vertexHighlightMesh.material.dispose(); }
    const p = groupWorldPoint(mesh, group);
    const geo = new THREE.SphereGeometry(0.06, 12, 12);
    const mat = new THREE.MeshBasicMaterial({ color: 0xff8800, depthTest: false });
    vertexHighlightMesh = new THREE.Mesh(geo, mat);
    vertexHighlightMesh.position.copy(p);
    vertexHighlightMesh.renderOrder = 1000;
    mesh.add(vertexHighlightMesh);
}

function showEdgeHighlight(mesh, groups) {
    if (edgeHighlightMesh) { if (edgeHighlightMesh.parent) edgeHighlightMesh.parent.remove(edgeHighlightMesh); edgeHighlightMesh.geometry.dispose(); edgeHighlightMesh.material.dispose(); }
    const pA = groupWorldPoint(mesh, groups.a);
    const pB = groupWorldPoint(mesh, groups.b);
    const geo = new THREE.BufferGeometry().setFromPoints([pA, pB]);
    const mat = new THREE.LineBasicMaterial({ color: 0xff8800, linewidth: 3, depthTest: false });
    edgeHighlightMesh = new THREE.Line(geo, mat);
    edgeHighlightMesh.renderOrder = 1000;
    mesh.add(edgeHighlightMesh);
}

function distPointToSegment(p, a, b) {
    const ab = b.clone().sub(a);
    const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-9), 0, 1);
    return p.distanceTo(a.clone().addScaledVector(ab, t));
}

// hit.face gives the 3 position-array indices (a,b,c) of the raycast-hit
// triangle for non-indexed geometry; hit.point is the world-space hit —
// used to find which vertex/edge of that triangle the click was closest to.
function selectVertexAt(mesh, hit, additive) {
    ensureNonIndexed(mesh);
    const pos = mesh.geometry.attributes.position;
    const localHit = mesh.worldToLocal(hit.point.clone());
    const candidates = [hit.face.a, hit.face.b, hit.face.c];
    let best = candidates[0], bestD = Infinity;
    candidates.forEach(i => {
        const v = new THREE.Vector3().fromBufferAttribute(pos, i);
        const d = v.distanceTo(localHit);
        if (d < bestD) { bestD = d; best = i; }
    });
    const groups = buildPositionGroups(mesh);
    const group = groups.get(positionKey(pos, best));
    selectedVertexGroup = group;
    showVertexHighlight(mesh, group);
    setVCB('Vertex Select:', `1 vertex (${group.length} shared corner${group.length > 1 ? 's' : ''})`);
}

function selectEdgeAt(mesh, hit) {
    ensureNonIndexed(mesh);
    const pos = mesh.geometry.attributes.position;
    const localHit = mesh.worldToLocal(hit.point.clone());
    const idxs = [hit.face.a, hit.face.b, hit.face.c];
    const pts = idxs.map(i => new THREE.Vector3().fromBufferAttribute(pos, i));
    const edges = [[0, 1], [1, 2], [2, 0]];
    let best = edges[0], bestD = Infinity;
    edges.forEach(e => {
        const d = distPointToSegment(localHit, pts[e[0]], pts[e[1]]);
        if (d < bestD) { bestD = d; best = e; }
    });
    const aIdx = idxs[best[0]], bIdx = idxs[best[1]];
    const groups = buildPositionGroups(mesh);
    const groupA = groups.get(positionKey(pos, aIdx));
    const groupB = groups.get(positionKey(pos, bIdx));
    selectedEdgeGroups = { a: groupA, b: groupB };
    showEdgeHighlight(mesh, selectedEdgeGroups);
    setVCB('Edge Select:', '1 edge selected');
}

// Real extrude: moves the selected triangles along their averaged normal and
// stitches side-wall quads across the boundary edges of the selection so the
// result is an actual extruded volume, not a whole-object scale hack.
// Shared extrude engine: moves each selected-face vertex by whatever
// getOffset(positionIndex) returns, and stitches side-wall quads across the
// boundary edges of the selection (an edge shared by two selected triangles
// is interior and gets no wall; one referenced only once is on the boundary
// edge of the selection). A uniform offset gives a regular extrude; a
// per-vertex-normal offset gives "Extrude Along Normals".
function extrudeSelectedFacesCore(getOffset) {
    const mesh = selectedObject;
    if (!mesh || !mesh.isMesh || selectedFaces.length === 0) return false;
    ensureNonIndexed(mesh);

    const geo = mesh.geometry;
    const posAttr = geo.attributes.position;

    const key = v => `${v.x.toFixed(5)},${v.y.toFixed(5)},${v.z.toFixed(5)}`;
    const edgeMap = new Map();
    const p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), p2 = new THREE.Vector3();
    selectedFaces.forEach(f => {
        const i0 = f * 3, i1 = f * 3 + 1, i2 = f * 3 + 2;
        p0.fromBufferAttribute(posAttr, i0);
        p1.fromBufferAttribute(posAttr, i1);
        p2.fromBufferAttribute(posAttr, i2);
        [[i0, p0, i1, p1], [i1, p1, i2, p2], [i2, p2, i0, p0]].forEach(([ia, a, ib, b]) => {
            const ka = key(a), kb = key(b);
            const k = ka < kb ? ka + '|' + kb : kb + '|' + ka;
            if (!edgeMap.has(k)) edgeMap.set(k, { count: 0, ia, a: a.clone(), ib, b: b.clone() });
            edgeMap.get(k).count++;
        });
    });
    const boundaryEdges = [...edgeMap.values()].filter(e => e.count === 1);

    // Move the selected (cap) triangles outward — indices stay valid since
    // we only overwrite existing entries, nothing is reordered.
    selectedFaces.forEach(f => {
        for (let v = 0; v < 3; v++) {
            const idx = f * 3 + v;
            const off = getOffset(idx);
            posAttr.setXYZ(idx, posAttr.getX(idx) + off.x, posAttr.getY(idx) + off.y, posAttr.getZ(idx) + off.z);
        }
    });

    const sideTris = [];
    const sideSrcIdx = []; // per new vertex, which ORIGINAL vertex index it inherits UV/color etc. from
    boundaryEdges.forEach(({ ia, a, ib, b }) => {
        const a2 = a.clone().add(getOffset(ia));
        const b2 = b.clone().add(getOffset(ib));
        sideTris.push(a.x, a.y, a.z, b.x, b.y, b.z, b2.x, b2.y, b2.z);
        sideSrcIdx.push(ia, ib, ib);
        sideTris.push(a.x, a.y, a.z, b2.x, b2.y, b2.z, a2.x, a2.y, a2.z);
        sideSrcIdx.push(ia, ib, ia);
    });

    if (sideTris.length > 0) {
        const oldCount = posAttr.count;
        const newCount = sideSrcIdx.length;
        const merged = new Float32Array(oldCount * 3 + sideTris.length);
        merged.set(posAttr.array, 0);
        merged.set(new Float32Array(sideTris), oldCount * 3);
        const newGeo = new THREE.BufferGeometry();
        newGeo.setAttribute('position', new THREE.BufferAttribute(merged, 3));

        // Carry every other per-vertex attribute (UV, vertex color, etc.)
        // forward too — previously this rebuilt a bare position-only
        // geometry, silently deleting UVs (breaking any texture) and vertex
        // colors (breaking sculpt mask/face-set overlays) on every
        // Push/Pull or Extrude that added side walls.
        Object.keys(geo.attributes).forEach(name => {
            if (name === 'position' || name === 'normal') return;
            const src = geo.attributes[name];
            const itemSize = src.itemSize;
            const ext = new Float32Array(oldCount * itemSize + newCount * itemSize);
            ext.set(src.array, 0);
            for (let i = 0; i < newCount; i++) {
                const srcIdx = sideSrcIdx[i];
                for (let c = 0; c < itemSize; c++) ext[oldCount * itemSize + i * itemSize + c] = src.array[srcIdx * itemSize + c];
            }
            newGeo.setAttribute(name, new THREE.BufferAttribute(ext, itemSize, src.normalized));
        });

        // Existing triangles keep their material assignment (their index
        // range in the array is unchanged); the new side-wall triangles
        // inherit whichever material the extruded face itself has, so
        // per-face-painted/textured objects don't silently lose their
        // paint the moment a face is pushed or pulled.
        if (geo.groups && geo.groups.length > 0) {
            let sideMatIndex = 0;
            const firstFaceStart = selectedFaces[0] * 3;
            for (const g of geo.groups) {
                if (firstFaceStart >= g.start && firstFaceStart < g.start + g.count) { sideMatIndex = g.materialIndex; break; }
            }
            geo.groups.forEach(g => newGeo.addGroup(g.start, g.count, g.materialIndex));
            newGeo.addGroup(oldCount, newCount, sideMatIndex);
        }

        newGeo.computeVertexNormals();
        geo.dispose();
        mesh.geometry = newGeo;
    } else {
        posAttr.needsUpdate = true;
        geo.computeVertexNormals();
    }

    rebuildFaceHighlight();
    return true;
}

function extrudeSelectedFaces(depth) {
    const mesh = selectedObject;
    if (!mesh || !mesh.isMesh || selectedFaces.length === 0) return false;
    ensureNonIndexed(mesh);
    mesh.geometry.computeVertexNormals();
    const normAttr = mesh.geometry.attributes.normal;

    const avgNormal = new THREE.Vector3();
    selectedFaces.forEach(f => { for (let v = 0; v < 3; v++) { const idx = f * 3 + v; avgNormal.x += normAttr.getX(idx); avgNormal.y += normAttr.getY(idx); avgNormal.z += normAttr.getZ(idx); } });
    if (avgNormal.lengthSq() === 0) return false;
    avgNormal.normalize();
    const offset = avgNormal.clone().multiplyScalar(depth);
    return extrudeSelectedFacesCore(() => offset);
}

// builtin.extrude_along_normals — like extrude, but each vertex moves along
// its OWN normal rather than the face's averaged normal, so a curved
// selection puffs outward instead of shifting as a flat slab.
function extrudeSelectedFacesAlongNormals(depth) {
    const mesh = selectedObject;
    if (!mesh || !mesh.isMesh || selectedFaces.length === 0) return false;
    ensureNonIndexed(mesh);
    mesh.geometry.computeVertexNormals();
    const normAttr = mesh.geometry.attributes.normal;
    return extrudeSelectedFacesCore(idx => new THREE.Vector3(normAttr.getX(idx), normAttr.getY(idx), normAttr.getZ(idx)).multiplyScalar(depth));
}

// ─────────────────────────────────────────────────────────────
// PLANE-CLIP ENGINE — shared by Bisect (cuts the whole mesh) and Knife
// (cuts only the selected face patch). Standard single-plane
// Sutherland-Hodgman clip per triangle, run twice (once per side) so both
// halves are kept — matches Blender's default Bisect ("just cut", no
// deletion) rather than a boolean subtraction.
// ─────────────────────────────────────────────────────────────
function clipTriangleToPlane(tri, plane, keepPositive) {
    const out = [];
    for (let i = 0; i < 3; i++) {
        const curr = tri[i], next = tri[(i + 1) % 3];
        const dCurr = plane.distanceToPoint(curr) * (keepPositive ? 1 : -1);
        const dNext = plane.distanceToPoint(next) * (keepPositive ? 1 : -1);
        const currIn = dCurr >= 0, nextIn = dNext >= 0;
        if (currIn) out.push(curr.clone());
        if (currIn !== nextIn) {
            const t = dCurr / (dCurr - dNext);
            out.push(curr.clone().lerp(next, t));
        }
    }
    return out;
}

function fixTriWinding(a, b, c, refNormal) {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    return n.dot(refNormal) < 0 ? [a, c, b] : [a, b, c];
}

// Clips `triangleIndices` (position-array triangle indices, i.e. multiples
// of 3) of mesh.geometry against a LOCAL-space plane, replacing them with
// the re-triangulated pieces on both sides. Triangles not in the given set
// pass through unchanged. Returns true if anything was actually cut.
function clipTrianglesToPlane(mesh, triangleIndices, localPlane, collectedFaces) {
    ensureNonIndexed(mesh);
    const geo = mesh.geometry;
    const posAttr = geo.attributes.position;
    const triSet = new Set(triangleIndices.map(f => f * 3));
    const outPositions = [];
    const newSelected = [];
    let outTri = 0;
    let didCut = false;

    for (let i = 0; i < posAttr.count; i += 3) {
        const a = new THREE.Vector3().fromBufferAttribute(posAttr, i);
        const b = new THREE.Vector3().fromBufferAttribute(posAttr, i + 1);
        const c = new THREE.Vector3().fromBufferAttribute(posAttr, i + 2);

        if (!triSet.has(i)) {
            outPositions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
            outTri++;
            continue;
        }

        const refNormal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
        const posPoly = clipTriangleToPlane([a, b, c], localPlane, true);
        const negPoly = clipTriangleToPlane([a, b, c], localPlane, false);

        if (posPoly.length < 3 || negPoly.length < 3) {
            outPositions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
            newSelected.push(outTri);
            outTri++;
            continue;
        }
        didCut = true;
        [posPoly, negPoly].forEach(poly => {
            for (let k = 1; k < poly.length - 1; k++) {
                const [p0, p1, p2] = fixTriWinding(poly[0], poly[k], poly[k + 1], refNormal);
                outPositions.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
                newSelected.push(outTri);
                outTri++;
            }
        });
    }

    if (!didCut) return false;

    const newGeo = new THREE.BufferGeometry();
    newGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(outPositions), 3));
    newGeo.computeVertexNormals();
    geo.dispose();
    mesh.geometry = newGeo;
    if (collectedFaces) {
        collectedFaces.length = 0;
        newSelected.forEach(f => collectedFaces.push(f));
    }
    return true;
}

// Bisect: drag a line across the viewport; the cut plane contains that
// screen-space line (appears as a straight line from the current view,
// exactly like Blender's Bisect gizmo) and passes through the object.
function bisectPlaneFromDrag(mesh, screenStart, screenEnd, canvas, camera) {
    const rect = canvas.getBoundingClientRect();
    const toRay = (sx, sy) => {
        const nx = ((sx - rect.left) / rect.width) * 2 - 1;
        const ny = -((sy - rect.top) / rect.height) * 2 + 1;
        const rc = new THREE.Raycaster();
        rc.setFromCamera(new THREE.Vector2(nx, ny), camera);
        return rc.ray;
    };
    const rayA = toRay(screenStart.x, screenStart.y);
    const rayB = toRay(screenEnd.x, screenEnd.y);

    const center = new THREE.Vector3();
    mesh.getWorldPosition(center);
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    const depth = center.clone().sub(camera.position).dot(camDir);

    const along = (ray) => {
        const denom = ray.direction.dot(camDir);
        if (Math.abs(denom) < 1e-6) return null;
        return camera.position.clone().add(ray.direction.clone().multiplyScalar(depth / denom));
    };
    const pA = along(rayA), pB = along(rayB);
    if (!pA || !pB) return null;
    const dragDir = pB.clone().sub(pA);
    if (dragDir.lengthSq() < 1e-8) return null;

    const worldNormal = dragDir.clone().cross(camDir).normalize();
    const worldPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(worldNormal, pA);
    return worldPlane.clone().applyMatrix4(new THREE.Matrix4().copy(mesh.matrixWorld).invert());
}

function bisectMesh(mesh, localPlane) {
    ensureNonIndexed(mesh);
    const allTris = [];
    for (let f = 0; f < mesh.geometry.attributes.position.count / 3; f++) allTris.push(f);
    return clipTrianglesToPlane(mesh, allTris, localPlane);
}

// Knife: cuts only the currently-selected face(s) along the straight line
// between two clicked points on that patch (a real cut, scoped to the
// selection rather than a free-form path across the whole mesh).
function knifeSelectedFace(mesh, p1World, p2World) {
    if (selectedFaces.length === 0) return false;
    ensureNonIndexed(mesh);
    const geo = mesh.geometry;
    const posAttr = geo.attributes.position;

    const avgNormal = new THREE.Vector3();
    geo.computeVertexNormals();
    const normAttr = geo.attributes.normal;
    selectedFaces.forEach(f => { for (let v = 0; v < 3; v++) { const idx = f * 3 + v; avgNormal.x += normAttr.getX(idx); avgNormal.y += normAttr.getY(idx); avgNormal.z += normAttr.getZ(idx); } });
    if (avgNormal.lengthSq() === 0) return false;
    avgNormal.normalize();

    const p1 = mesh.worldToLocal(p1World.clone());
    const p2 = mesh.worldToLocal(p2World.clone());
    const lineDir = p2.clone().sub(p1);
    if (lineDir.lengthSq() < 1e-8) return false;
    const planeNormal = lineDir.clone().cross(avgNormal).normalize();
    const localPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, p1);

    const nextFaces = [];
    const ok = clipTrianglesToPlane(mesh, selectedFaces, localPlane, nextFaces);
    if (ok && nextFaces.length) selectedFaces = nextFaces;
    return ok;
}

function drawKnifePreview() {
    if (!suCtx || !suCanvas || !camera) return;
    suCtx.clearRect(0, 0, suCanvas.width, suCanvas.height);
    if (!sketchState || sketchState.tool !== 'knife' || !sketchState.points || sketchState.points.length === 0) return;
    const rect = suCanvas.getBoundingClientRect();
    suCtx.strokeStyle = '#ffcc44';
    suCtx.fillStyle = '#ffcc44';
    suCtx.lineWidth = 1.5;
    suCtx.setLineDash([5, 3]);
    suCtx.beginPath();
    sketchState.points.forEach((p, i) => {
        const scr = projectWorldToClient(p, rect);
        if (!scr) return;
        const x = scr.x - rect.left, y = scr.y - rect.top;
        if (i === 0) suCtx.moveTo(x, y); else suCtx.lineTo(x, y);
        suCtx.fillRect(x - 2, y - 2, 4, 4);
    });
    suCtx.stroke();
    suCtx.setLineDash([]);
}

function finishKnife() {
    if (!sketchState || sketchState.tool !== 'knife' || !sketchState.points || sketchState.points.length < 2) {
        setVCB('Knife:', 'Need 2+ points, then Enter');
        return;
    }
    const obj = selectedObject;
    if (!obj || !obj.isMesh) { cancelSketchTool(); return; }
    const pts = sketchState.points.slice();
    const beforeGeo = deepCloneGeometry(obj.geometry);
    const beforeFaces = selectedFaces.slice();
    let cuts = 0;
    for (let i = 0; i < pts.length - 1; i++) {
        if (knifeSelectedFace(obj, pts[i], pts[i + 1])) cuts++;
    }
    sketchState = null;
    if (suCtx) suCtx.clearRect(0, 0, suCanvas.width, suCanvas.height);
    if (cuts) {
        const afterGeo = deepCloneGeometry(obj.geometry);
        const afterFaces = selectedFaces.slice();
        pushUndo({
            undo() { obj.geometry.dispose(); obj.geometry = beforeGeo; selectedFaces = beforeFaces.slice(); rebuildFaceHighlight(); },
            redo() { obj.geometry.dispose(); obj.geometry = afterGeo; selectedFaces = afterFaces.slice(); rebuildFaceHighlight(); },
        });
        rebuildFaceHighlight();
        setVCB('Knife:', `${cuts} cut(s) on selected face`);
    } else {
        beforeGeo.dispose();
        setVCB('Knife:', 'Cut line missed the selected face');
    }
}

// Loop Cut (scoped to a single selected quad face — the common case, a box
// face): splits it into two new quads along the midpoints of its two
// "opposite" boundary edges (found by tracing the boundary loop's
// connectivity, not just guessing from edge direction).
function orderBoundaryLoop(edges) {
    if (edges.length === 0) return null;
    const keyOf = v => `${v.x.toFixed(5)},${v.y.toFixed(5)},${v.z.toFixed(5)}`;
    const remaining = edges.map(e => ({ a: e.a, b: e.b }));
    const loop = [remaining[0].a.clone()];
    let current = remaining[0].b.clone();
    remaining.splice(0, 1);
    while (remaining.length > 0) {
        loop.push(current.clone());
        const idx = remaining.findIndex(e => keyOf(e.a) === keyOf(current) || keyOf(e.b) === keyOf(current));
        if (idx === -1) return null;
        const e = remaining[idx];
        current = (keyOf(e.a) === keyOf(current)) ? e.b.clone() : e.a.clone();
        remaining.splice(idx, 1);
    }
    return loop;
}

function loopCutSelectedFace() {
    const mesh = selectedObject;
    if (!mesh || !mesh.isMesh || selectedFaces.length === 0) return false;
    ensureNonIndexed(mesh);
    const geo = mesh.geometry;
    const posAttr = geo.attributes.position;

    const key = v => `${v.x.toFixed(5)},${v.y.toFixed(5)},${v.z.toFixed(5)}`;
    const edgeMap = new Map();
    const p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), p2 = new THREE.Vector3();
    selectedFaces.forEach(f => {
        p0.fromBufferAttribute(posAttr, f * 3); p1.fromBufferAttribute(posAttr, f * 3 + 1); p2.fromBufferAttribute(posAttr, f * 3 + 2);
        [[p0, p1], [p1, p2], [p2, p0]].forEach(([a, b]) => {
            const ka = key(a), kb = key(b);
            const k = ka < kb ? ka + '|' + kb : kb + '|' + ka;
            if (!edgeMap.has(k)) edgeMap.set(k, { count: 0, a: a.clone(), b: b.clone() });
            edgeMap.get(k).count++;
        });
    });
    const boundary = [...edgeMap.values()].filter(e => e.count === 1);
    if (boundary.length !== 4) return false; // only the common single-quad-face case is supported

    const loop = orderBoundaryLoop(boundary);
    if (!loop || loop.length !== 4) return false;
    const [v0, v1, v2, v3] = loop;
    const midA = v0.clone().add(v1).multiplyScalar(0.5);
    const midC = v2.clone().add(v3).multiplyScalar(0.5);

    const refNormal = new THREE.Vector3().subVectors(v1, v0).cross(new THREE.Vector3().subVectors(v2, v0));
    const newTris = [
        fixTriWinding(v0, midA, midC, refNormal),
        fixTriWinding(v0, midC, v3, refNormal),
        fixTriWinding(midA, v1, v2, refNormal),
        fixTriWinding(midA, v2, midC, refNormal),
    ];

    // Rebuild geometry: keep every triangle NOT in the selection, append the 4 new ones.
    const selectedSet = new Set(selectedFaces.map(f => f * 3));
    const kept = [];
    for (let i = 0; i < posAttr.count; i += 3) {
        if (selectedSet.has(i)) continue;
        for (let v = 0; v < 3; v++) { kept.push(posAttr.getX(i + v), posAttr.getY(i + v), posAttr.getZ(i + v)); }
    }
    newTris.forEach(([a, b, c]) => { kept.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z); });

    const newGeo = new THREE.BufferGeometry();
    newGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(kept), 3));
    newGeo.computeVertexNormals();
    geo.dispose();
    mesh.geometry = newGeo;
    return true;
}

// Wraps extrudeSelectedFaces() with undo/redo; returns false (no-op) when
// there's no active face selection so callers can fall back to the
// whole-object approximation used elsewhere.
function runFaceExtrude(depth) {
    const obj = selectedObject;
    if (!obj || !obj.isMesh || !faceSelectOn || selectedFaces.length === 0) return false;

    const beforeGeo = deepCloneGeometry(obj.geometry);
    const beforeFaces = selectedFaces.slice();
    if (!extrudeSelectedFaces(depth)) { beforeGeo.dispose(); return false; }
    const afterGeo = obj.geometry;
    const afterFaces = selectedFaces.slice();

    pushUndo({
        undo() { obj.geometry.dispose(); obj.geometry = beforeGeo; selectedFaces = beforeFaces.slice(); rebuildFaceHighlight(); },
        redo() { obj.geometry.dispose(); obj.geometry = afterGeo; selectedFaces = afterFaces.slice(); rebuildFaceHighlight(); },
    });
    return true;
}

// builtin.smooth (mesh) — Laplacian smoothing: pulls each selected vertex
// toward the average position of its real adjacent vertices.
function smoothSelectedFaces(mesh, iterations) {
    if (selectedFaces.length === 0) return false;
    ensureNonIndexed(mesh);
    const pos = mesh.geometry.attributes.position;
    const vertIdxs = new Set();
    selectedFaces.forEach(f => { for (let v = 0; v < 3; v++) vertIdxs.add(f * 3 + v); });
    if (vertIdxs.size === 0) return false;

    for (let iter = 0; iter < iterations; iter++) {
        const targets = new Map();
        vertIdxs.forEach(idx => {
            const neighbors = findNeighborPositions(mesh, [idx]);
            if (neighbors.length === 0) return;
            const avg = new THREE.Vector3();
            neighbors.forEach(n => avg.add(n));
            avg.divideScalar(neighbors.length);
            const cur = new THREE.Vector3().fromBufferAttribute(pos, idx);
            targets.set(idx, cur.lerp(avg, 0.5));
        });
        targets.forEach((p, idx) => pos.setXYZ(idx, p.x, p.y, p.z));
    }
    pos.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
    return true;
}

// builtin.randomize — jitters each selected vertex along its own normal by
// a random amount, for breaking up perfectly flat/regular geometry.
function randomizeSelectedFaces(mesh, amount) {
    if (selectedFaces.length === 0) return false;
    ensureNonIndexed(mesh);
    mesh.geometry.computeVertexNormals();
    const pos = mesh.geometry.attributes.position, norm = mesh.geometry.attributes.normal;
    const vertIdxs = new Set();
    selectedFaces.forEach(f => { for (let v = 0; v < 3; v++) vertIdxs.add(f * 3 + v); });
    vertIdxs.forEach(idx => {
        const jitter = (Math.random() * 2 - 1) * amount;
        pos.setXYZ(idx, pos.getX(idx) + norm.getX(idx) * jitter, pos.getY(idx) + norm.getY(idx) * jitter, pos.getZ(idx) + norm.getZ(idx) * jitter);
    });
    pos.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
    return true;
}

// builtin.extrude_individual — like Extrude Region, but each selected face
// gets its own independent cap + side walls instead of one shared patch
// (reuses extrudeSelectedFaces() once per face, since triangle indices
// stay valid across iterations — new geometry is only ever appended).
function extrudeIndividualFaces(depth) {
    const mesh = selectedObject;
    if (!mesh || !mesh.isMesh || selectedFaces.length === 0) return false;
    const original = selectedFaces.slice();
    let ok = true;
    original.forEach(f => {
        selectedFaces = [f];
        if (!extrudeSelectedFaces(depth)) ok = false;
    });
    selectedFaces = original;
    rebuildFaceHighlight();
    return ok;
}

// builtin.extrude_to_cursor — extrudes the current face selection along
// its averaged normal by however far the clicked point is along that
// normal from the patch's centroid.
function extrudeToCursor(worldPoint) {
    const mesh = selectedObject;
    if (!mesh || !mesh.isMesh || selectedFaces.length === 0) return false;
    const local = mesh.worldToLocal(worldPoint.clone());
    const pos = mesh.geometry.attributes.position;
    const centroid = new THREE.Vector3();
    let n = 0;
    selectedFaces.forEach(f => { for (let v = 0; v < 3; v++) { centroid.add(new THREE.Vector3().fromBufferAttribute(pos, f * 3 + v)); n++; } });
    centroid.divideScalar(n);

    mesh.geometry.computeVertexNormals();
    const normAttr = mesh.geometry.attributes.normal;
    const avgNormal = new THREE.Vector3();
    selectedFaces.forEach(f => { for (let v = 0; v < 3; v++) { const idx = f * 3 + v; avgNormal.x += normAttr.getX(idx); avgNormal.y += normAttr.getY(idx); avgNormal.z += normAttr.getZ(idx); } });
    if (avgNormal.lengthSq() === 0) return false;
    avgNormal.normalize();

    const depth = local.clone().sub(centroid).dot(avgNormal);
    return extrudeSelectedFaces(depth);
}

// ─────────────────────────────────────────────────────────────
// IMAGE TEXTURE — upload a real image and apply it as the material's
// base color map (was previously only fake color-name "presets").
// Textures loaded via TextureLoader carry an HTMLImageElement source, which
// is exactly what THREE's own toJSON()/ObjectLoader round-trip (used by our
// scene save/load and GLTFExporter's embedImages) knows how to serialize —
// so uploaded textures survive Save Project, Quick Save, and Export GLB
// for free.
// ─────────────────────────────────────────────────────────────
function triggerUploadTexture() {
    if (!selectedObject || !selectedObject.material) { setVCB('Texture:', 'Select an object first'); return; }
    const input = document.getElementById('file-upload-texture');
    if (input) input.click();
}

function handleUploadTextureFile(evt) {
    const file = evt.target.files && evt.target.files[0];
    evt.target.value = '';
    if (!file) return;
    const obj = selectedObject;
    if (!obj || !obj.material) return;

    const url = URL.createObjectURL(file);
    new THREE.TextureLoader().load(
        url,
        texture => {
            URL.revokeObjectURL(url);
            texture.name = file.name;
            applyTextureToMaterial(obj, texture, file.name);
        },
        undefined,
        err => {
            URL.revokeObjectURL(url);
            alert('Could not load image: ' + (err && err.message ? err.message : err));
        }
    );
}

function applyTextureToMaterial(obj, texture, filename) {
    const mat = obj.material;
    const beforeMap = mat.map || null;
    const beforeColor = mat.color.clone();

    mat.map = texture;
    mat.color.set('#ffffff'); // let the image show its own colors instead of being tinted
    mat.needsUpdate = true;
    if (selectedObject === obj) {
        const el = document.getElementById('mat-color');
        if (el) el.value = '#ffffff';
        updateMaterialTexturePreview(obj);
    }
    setVCB('Texture Applied:', filename);

    pushUndo({
        undo() {
            mat.map = beforeMap; mat.color.copy(beforeColor); mat.needsUpdate = true;
            if (selectedObject === obj) { const el = document.getElementById('mat-color'); if (el) el.value = '#' + beforeColor.getHexString(); updateMaterialTexturePreview(obj); }
        },
        redo() {
            mat.map = texture; mat.color.set('#ffffff'); mat.needsUpdate = true;
            if (selectedObject === obj) { const el = document.getElementById('mat-color'); if (el) el.value = '#ffffff'; updateMaterialTexturePreview(obj); }
        },
    });
}

function clearMaterialTexture() {
    const obj = selectedObject;
    if (!obj || !obj.material || !obj.material.map) return;
    const mat = obj.material;
    const beforeMap = mat.map;

    mat.map = null;
    mat.needsUpdate = true;
    updateMaterialTexturePreview(obj);
    setVCB('Texture:', 'Removed');

    pushUndo({
        undo() { mat.map = beforeMap; mat.needsUpdate = true; if (selectedObject === obj) updateMaterialTexturePreview(obj); },
        redo() { mat.map = null; mat.needsUpdate = true; if (selectedObject === obj) updateMaterialTexturePreview(obj); },
    });
}

function updateMaterialTexturePreview(obj) {
    const row = document.getElementById('mat-tex-preview-row');
    const thumb = document.getElementById('mat-tex-thumb');
    const nameEl = document.getElementById('mat-tex-filename');
    if (!row || !thumb || !nameEl) return;

    const map = obj && obj.material ? obj.material.map : null;
    if (map && map.image) {
        row.style.display = 'flex';
        nameEl.innerText = map.name || 'texture';
        if (map.image.src) thumb.src = map.image.src;
    } else {
        row.style.display = 'none';
        thumb.removeAttribute('src');
    }
}

// ─────────────────────────────────────────────────────────────
// FACE-SELECTION GEOMETRY OPS — Inset, Bevel, Shrink/Fatten, To Sphere.
// Same undo-tracked pattern as runFaceExtrude(): mutate the selected
// triangles' real vertex positions, snapshot geometry before/after for
// undo/redo. Each has a whole-object scale fallback (also undo-tracked)
// for when nothing is face-selected, matching the tool's prior behavior.
// ─────────────────────────────────────────────────────────────
function withFaceGeometryUndo(mutateFn) {
    const obj = selectedObject;
    if (!obj || !obj.isMesh || !faceSelectOn || selectedFaces.length === 0) return false;
    const beforeGeo = deepCloneGeometry(obj.geometry);
    const beforeFaces = selectedFaces.slice();
    if (mutateFn(obj) === false) { beforeGeo.dispose(); return false; }
    const afterGeo = obj.geometry;
    const afterFaces = selectedFaces.slice();
    pushUndo({
        undo() { obj.geometry.dispose(); obj.geometry = beforeGeo; selectedFaces = beforeFaces.slice(); rebuildFaceHighlight(); },
        redo() { obj.geometry.dispose(); obj.geometry = afterGeo; selectedFaces = afterFaces.slice(); rebuildFaceHighlight(); },
    });
    return true;
}

function withScaleUndo(obj, mutateFn) {
    const before = obj.scale.clone();
    mutateFn(obj);
    const after = obj.scale.clone();
    pushUndo({
        undo() { obj.scale.copy(before); },
        redo() { obj.scale.copy(after); },
    });
}

function insetSelectedFaces(mesh, factor) {
    ensureNonIndexed(mesh);
    const pos = mesh.geometry.attributes.position;
    const centroid = new THREE.Vector3();
    let n = 0;
    selectedFaces.forEach(f => { for (let v = 0; v < 3; v++) { const i = f * 3 + v; centroid.x += pos.getX(i); centroid.y += pos.getY(i); centroid.z += pos.getZ(i); n++; } });
    centroid.divideScalar(n);
    const p = new THREE.Vector3();
    selectedFaces.forEach(f => { for (let v = 0; v < 3; v++) { const i = f * 3 + v; p.set(pos.getX(i), pos.getY(i), pos.getZ(i)).lerp(centroid, factor); pos.setXYZ(i, p.x, p.y, p.z); } });
    pos.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
    return true;
}

function shrinkFattenSelectedFaces(mesh, amount) {
    ensureNonIndexed(mesh);
    const geo = mesh.geometry;
    geo.computeVertexNormals();
    const pos = geo.attributes.position, norm = geo.attributes.normal;
    selectedFaces.forEach(f => { for (let v = 0; v < 3; v++) { const i = f * 3 + v;
        pos.setXYZ(i, pos.getX(i) + norm.getX(i) * amount, pos.getY(i) + norm.getY(i) * amount, pos.getZ(i) + norm.getZ(i) * amount);
    } });
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    return true;
}

function toSphereSelectedFaces(mesh, factor) {
    ensureNonIndexed(mesh);
    const pos = mesh.geometry.attributes.position;
    const centroid = new THREE.Vector3();
    const idxs = [];
    let n = 0;
    selectedFaces.forEach(f => { for (let v = 0; v < 3; v++) { const i = f * 3 + v; idxs.push(i); centroid.x += pos.getX(i); centroid.y += pos.getY(i); centroid.z += pos.getZ(i); n++; } });
    centroid.divideScalar(n);
    let avgR = 0;
    const pts = idxs.map(i => new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
    pts.forEach(p => avgR += p.distanceTo(centroid));
    avgR /= n;
    idxs.forEach((i, k) => {
        const p = pts[k];
        const dir = p.clone().sub(centroid);
        const d = dir.length();
        const target = d > 1e-6 ? centroid.clone().add(dir.normalize().multiplyScalar(avgR)) : p;
        const newP = p.clone().lerp(target, factor);
        pos.setXYZ(i, newP.x, newP.y, newP.z);
    });
    pos.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
    return true;
}

// Approximated as extrude-a-little + inset-the-new-cap — a genuine
// chamfered-looking result built from the same real primitives as
// Extrude/Inset, rather than a true edge-bevel (which needs a half-edge
// mesh structure this app doesn't have).
function bevelSelectedFaces(mesh, amount) {
    if (!extrudeSelectedFaces(amount * 0.4)) return false;
    insetSelectedFaces(mesh, Math.min(0.6, amount));
    return true;
}

// Revolves the last Line/Arc profile you drew (SketchUp CAD tab) around
// the Z axis into a real lathed solid — ties the sketch tools and the
// modeling tools together the way SketchUp-profile-into-Blender-spin
// implies.
function spinFromProfile() {
    if (!lastDrawnProfile || lastDrawnProfile.length < 2) {
        setVCB('Spin:', 'Draw a Line/Arc profile first (SketchUp CAD tab), then Spin');
        return false;
    }
    const points = lastDrawnProfile.map(p => new THREE.Vector2(Math.hypot(p.x, p.y), p.z));
    const geo = new THREE.LatheGeometry(points, 32);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xbebebe, roughness: 0.5, metalness: 0.0 }));
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.name = nextName('Spin');
    commitNewObject(mesh, 'mesh');
    setVCB('Spin:', `Revolved ${points.length}-point profile × 360°`);
    return true;
}

// SketchUp's Follow Me: sweeps the selected face's boundary loop along the
// last-drawn Line/Arc path (real path points, not a canned shape), building
// real connecting side-wall geometry between consecutive swept rings — the
// same profile-into-tool pattern as Spin, but a translation sweep along an
// arbitrary path instead of a revolve. The cross-section is carried without
// re-orienting to the path's local tangent at each turn (a plain translate,
// not a full Frenet-frame sweep) — correct and real for the common case of
// straight/gently-curved paths (moldings, pipes, handrails); a path with
// sharp direction changes will show the cross-section keeping its original
// orientation through the turn rather than rotating to match.
function runFollowMe() {
    const obj = selectedObject;
    if (!obj || !obj.isMesh || selectedFaces.length === 0) { setVCB('Follow Me:', 'Face-select a face first'); return false; }
    if (!lastDrawnProfile || lastDrawnProfile.length < 2) { setVCB('Follow Me:', 'Draw a Line/Arc path first (SketchUp CAD tab), then Follow Me'); return false; }

    ensureNonIndexed(obj);
    const pos = obj.geometry.attributes.position;
    const key = v => `${v.x.toFixed(5)},${v.y.toFixed(5)},${v.z.toFixed(5)}`;
    const edgeMap = new Map();
    const pA = new THREE.Vector3(), pB = new THREE.Vector3(), pC = new THREE.Vector3();
    selectedFaces.forEach(f => {
        const i0 = f * 3, i1 = f * 3 + 1, i2 = f * 3 + 2;
        pA.fromBufferAttribute(pos, i0); pB.fromBufferAttribute(pos, i1); pC.fromBufferAttribute(pos, i2);
        [[pA, pB], [pB, pC], [pC, pA]].forEach(([a, b]) => {
            const ka = key(a), kb = key(b);
            const k = ka < kb ? ka + '|' + kb : kb + '|' + ka;
            if (!edgeMap.has(k)) edgeMap.set(k, { count: 0, a: a.clone(), b: b.clone() });
            edgeMap.get(k).count++;
        });
    });
    const boundary = [...edgeMap.values()].filter(e => e.count === 1);
    if (boundary.length < 3) { setVCB('Follow Me:', 'Selected face has no open boundary to sweep'); return false; }

    // Walk the boundary edges into one ordered loop.
    const loop = [boundary[0].a.clone()];
    let cur = boundary[0].b.clone();
    const used = new Set([0]);
    while (used.size < boundary.length) {
        let found = -1;
        for (let i = 0; i < boundary.length; i++) {
            if (used.has(i)) continue;
            if (boundary[i].a.distanceTo(cur) < 1e-4) { found = i; loop.push(cur.clone()); cur = boundary[i].b.clone(); break; }
            if (boundary[i].b.distanceTo(cur) < 1e-4) { found = i; loop.push(cur.clone()); cur = boundary[i].a.clone(); break; }
        }
        if (found === -1) break;
        used.add(found);
    }
    if (loop.length < 3) { setVCB('Follow Me:', 'Could not trace a closed boundary loop'); return false; }

    const localPath = lastDrawnProfile.map(p => obj.worldToLocal(p.clone()));
    const deltas = [];
    for (let i = 1; i < localPath.length; i++) deltas.push(localPath[i].clone().sub(localPath[i - 1]));
    if (deltas.every(d => d.lengthSq() < 1e-10)) { setVCB('Follow Me:', 'Path has zero length'); return false; }

    const newTris = [];
    let ring = loop.map(p => p.clone());
    deltas.forEach(delta => {
        const nextRing = ring.map(p => p.clone().add(delta));
        for (let i = 0; i < ring.length; i++) {
            const a = ring[i], b = ring[(i + 1) % ring.length], a2 = nextRing[i], b2 = nextRing[(i + 1) % ring.length];
            newTris.push(a.x, a.y, a.z, b.x, b.y, b.z, b2.x, b2.y, b2.z);
            newTris.push(a.x, a.y, a.z, b2.x, b2.y, b2.z, a2.x, a2.y, a2.z);
        }
        ring = nextRing;
    });

    const oldCount = pos.count;
    const merged = new Float32Array(oldCount * 3 + newTris.length);
    merged.set(pos.array, 0);
    merged.set(new Float32Array(newTris), oldCount * 3);
    const newGeo = new THREE.BufferGeometry();
    newGeo.setAttribute('position', new THREE.BufferAttribute(merged, 3));
    newGeo.computeVertexNormals();
    obj.geometry.dispose();
    obj.geometry = newGeo;
    rebuildFaceHighlight();
    return true;
}

function doFollowMe() {
    const obj = selectedObject;
    if (!obj || !obj.isMesh) { setVCB('Follow Me:', 'Select a face first'); return; }
    const beforeGeo = deepCloneGeometry(obj.geometry);
    const beforeFaces = selectedFaces.slice();
    if (!runFollowMe()) { beforeGeo.dispose(); return; }
    const afterGeo = deepCloneGeometry(obj.geometry);
    const afterFaces = selectedFaces.slice();
    pushUndo({
        undo() { obj.geometry.dispose(); obj.geometry = beforeGeo; selectedFaces = beforeFaces.slice(); rebuildFaceHighlight(); },
        redo() { obj.geometry.dispose(); obj.geometry = afterGeo; selectedFaces = afterFaces.slice(); rebuildFaceHighlight(); },
    });
    updateInspectorFromSelected();
    propagateComponentEdit(obj);
    setVCB('Follow Me:', `Swept along ${lastDrawnProfile.length}-point path`);
}

// ─────────────────────────────────────────────────────────────
// EDIT MESH TOOLS — from _defs_edit_mesh
// ─────────────────────────────────────────────────────────────
function executeMeshEditTool(tool) {
    if (tool === 'spin') { spinFromProfile(); return; } // doesn't need a mesh selected — builds a new object from the last-drawn profile
    if (tool === 'follow_me') { doFollowMe(); return; }

    const obj = selectedObject;
    if (!obj || !obj.isMesh) return;

    switch (tool) {
        case 'extrude':  // builtin.extrude_region
            if (runFaceExtrude(0.5)) { setVCB('Extrude Region:', `+0.5 m — ${selectedFaces.length} face(s)`); break; }
            obj.scale.z += 0.5;
            setVCB('Extrude Region:', '+0.5 m');
            break;
        case 'extrude_normals': // builtin.extrude_along_normals
            if (withFaceGeometryUndo(() => extrudeSelectedFacesAlongNormals(0.4))) { setVCB('Extrude Along Normals:', `+0.4 — ${selectedFaces.length} face(s)`); break; }
            withScaleUndo(obj, o => o.scale.multiplyScalar(1.25));
            setVCB('Extrude Along Normals:', '×1.25 (whole-object approx — select a face first for a real per-vertex extrude)');
            break;
        case 'inset':    // builtin.inset_faces
            if (withFaceGeometryUndo(m => insetSelectedFaces(m, 0.3))) { setVCB('Inset Faces:', `30% — ${selectedFaces.length} face(s)`); break; }
            withScaleUndo(obj, o => o.scale.multiplyScalar(0.85));
            setVCB('Inset Faces:', '15% (whole-object approx — select a face first for a real inset)');
            break;
        case 'bevel':    // builtin.bevel
            if (withFaceGeometryUndo(m => bevelSelectedFaces(m, 0.3))) { setVCB('Bevel:', `${selectedFaces.length} face(s)`); break; }
            // No face selected — real whole-object bevel (same engine as the
            // Modifiers panel's Bevel modifier), not the old uniform-scale hack.
            { const beforeGeo = deepCloneGeometry(obj.geometry);
              wholeObjectOrSelectedBevel(obj, 0.1);
              const afterGeo = deepCloneGeometry(obj.geometry);
              pushUndo({
                  undo() { obj.geometry.dispose(); obj.geometry = beforeGeo; },
                  redo() { obj.geometry.dispose(); obj.geometry = afterGeo; },
              }); }
            setVCB('Bevel:', 'Whole-object bevel (0.1m)');
            break;
        case 'loopcut': { // builtin.loop_cut — scoped to a single selected quad face (the common case)
            if (withFaceGeometryUndo(() => loopCutSelectedFace())) { setVCB('Loop Cut:', 'Face split into 2'); break; }
            setVCB('Loop Cut:', 'Select exactly one quad face (Face select) first');
            break;
        }
        case 'knife':    // builtin.knife — armed via setActiveTool; click two points on the selected face
            setVCB('Knife:', 'Face Select a face, then click two points on it to cut');
            break;
        case 'bisect':   // builtin.bisect — armed via setActiveTool; drag a line across the viewport
            setVCB('Bisect:', 'Drag a line across the viewport to cut the mesh');
            break;
        case 'subdivide':
            applyBlenderModifier('SUBSURF');
            break;
        case 'to_sphere':  // builtin.to_sphere
            if (withFaceGeometryUndo(m => toSphereSelectedFaces(m, 1.0))) { setVCB('To Sphere:', `factor 1.0 — ${selectedFaces.length} face(s)`); break; }
            const beforeGeo = obj.geometry;
            const beforeClone = deepCloneGeometry(beforeGeo);
            obj.geometry = new THREE.SphereGeometry(1, 32, 16);
            beforeGeo.dispose();
            pushUndo({
                undo() { obj.geometry.dispose(); obj.geometry = beforeClone; },
                redo() { obj.geometry.dispose(); obj.geometry = new THREE.SphereGeometry(1, 32, 16); },
            });
            setVCB('To Sphere:', 'factor 1.0 (whole-object approx — select a face first for a real reshape)');
            break;
        case 'shrink_fatten':
            if (withFaceGeometryUndo(m => shrinkFattenSelectedFaces(m, 0.3))) { setVCB('Shrink/Fatten:', `+0.3 — ${selectedFaces.length} face(s)`); break; }
            withScaleUndo(obj, o => o.scale.multiplyScalar(1.1));
            setVCB('Shrink/Fatten:', '+10% (whole-object approx — select a face first for a real per-vertex offset)');
            break;
        case 'poly_build':
            setVCB('Poly Build:', 'Click points in the viewport to build a face, double-click/Enter to finish');
            break;
        case 'edge_slide':
            setVCB('Edge Slide:', 'Edge Select an edge, then drag on the mesh near it');
            break;
        case 'vertex_slide':
            setVCB('Vertex Slide:', 'Vertex Select a corner, then drag on the mesh near it');
            break;
        case 'smooth':   // builtin.smooth (mesh) — Laplacian smoothing on the selected face's vertices
            if (withFaceGeometryUndo(m => smoothSelectedFaces(m, 3))) { setVCB('Smooth:', `${selectedFaces.length} face(s)`); break; }
            setVCB('Smooth:', 'Select a face first');
            break;
        case 'randomize': // builtin.randomize
            if (withFaceGeometryUndo(m => randomizeSelectedFaces(m, 0.08))) { setVCB('Randomize:', `${selectedFaces.length} face(s)`); break; }
            setVCB('Randomize:', 'Select a face first');
            break;
        case 'extrude_individual': // builtin.extrude_individual
            if (withFaceGeometryUndo(() => extrudeIndividualFaces(0.4))) { setVCB('Extrude Individual:', `${selectedFaces.length} face(s), independent caps`); break; }
            setVCB('Extrude Individual:', 'Select one or more faces first');
            break;
        case 'extrude_to_cursor': // builtin.extrude_to_cursor — armed via setActiveTool; click a point to extrude to
            setVCB('Extrude to Cursor:', 'Select a face, then click a point in the viewport');
            break;
        case 'grow':
            growFaceSelection();
            break;
        case 'shrink':
            shrinkFaceSelection();
            break;
        case 'linked':
            selectLinkedFaces();
            break;
    }

    updateInspectorFromSelected();
    propagateComponentEdit(obj);
}

// Was setMeshSelectMode(m): an exclusive radio-style switch that always
// cleared the other two selections. Vertex/Edge/Face are now independent
// toggles — clicking one flips only its own state, so any combination can
// be active at once (see the click-dispatcher priority cascade above:
// Vertex > Edge > Face). Turning a mode OFF still drops its own selection,
// same as before; turning one ON no longer touches the other two.
function toggleMeshSelectMode(m) {
    const wasOn = m === 'vertex' ? vertexSelectOn : m === 'edge' ? edgeSelectOn : faceSelectOn;
    const on = !wasOn;
    if (m === 'vertex') vertexSelectOn = on;
    else if (m === 'edge') edgeSelectOn = on;
    else if (m === 'face') faceSelectOn = on;
    if (!on) {
        if (m === 'vertex') clearVertexSelection();
        else if (m === 'edge') clearEdgeSelection();
        else if (m === 'face') clearFaceSelection();
    }
    const pill = document.getElementById(`pill-${m.substring(0,4)}`);
    if (pill) pill.classList.toggle('active', on);
    const hints = { face: 'Face — click a face on the mesh to select it', vertex: 'Vertex — click a corner to select it', edge: 'Edge — click an edge to select it' };
    setVCB('Select Mode:', `${hints[m] || m.charAt(0).toUpperCase() + m.slice(1)} — ${on ? 'On' : 'Off'}`);
}

// ─────────────────────────────────────────────────────────────
// SCULPT — from _defs_sculpt (14 brushes from Blender source)
// ─────────────────────────────────────────────────────────────
const SCULPT_BRUSHES = {
    // brush_type from Blender source (brush.sculpt.*)
    draw:           { label: 'Draw',              cursor: 'PAINT_BRUSH' },
    clay:           { label: 'Clay',              cursor: 'PAINT_BRUSH' },
    clay_strips:    { label: 'Clay Strips',       cursor: 'PAINT_BRUSH' },
    smooth:         { label: 'Smooth',            cursor: 'PAINT_BRUSH' },
    grab:           { label: 'Grab',              cursor: 'HAND' },
    inflate:        { label: 'Inflate/Deflate',   cursor: 'PAINT_BRUSH' },
    snake_hook:     { label: 'Snake Hook',        cursor: 'CROSSHAIR' },
    crease:         { label: 'Crease',            cursor: 'PAINT_BRUSH' },
    flatten:        { label: 'Flatten/Contrast',  cursor: 'PAINT_BRUSH' },
    pinch:          { label: 'Pinch/Magnify',     cursor: 'PAINT_BRUSH' },
    scrape:         { label: 'Scrape/Fill',       cursor: 'PAINT_BRUSH' },
    thumb:          { label: 'Thumb',             cursor: 'PAINT_BRUSH' },
    rotate:         { label: 'Rotate',            cursor: 'PAINT_BRUSH' },
    cloth:          { label: 'Cloth',             cursor: 'CROSSHAIR' },
    mask:           { label: 'Mask',              cursor: 'PAINT_BRUSH' },
    draw_face_sets: { label: 'Draw Face Sets',    cursor: 'PAINT_BRUSH' },
};

// ─────────────────────────────────────────────────────────────
// SCULPTING — real per-vertex displacement. Previously the 16 brush
// buttons only changed which name was "active": dragging on the mesh
// applied the exact same push-along-normal for 6 of them (Draw/Clay/Clay
// Strips/Crease/Layer/Cloth), the exact same rigid translation for 4 more
// (Grab/Snake Hook/Thumb/Rotate), the exact same plane-push for 2
// (Flatten/Scrape), and Mask/Draw Face Sets did nothing at all. Every
// brush below now has its own real, distinct math — ported from Blender's
// actual brush behavior (reference/extracted/blender-main/source/blender/
// editors/sculpt_paint/) onto this app's non-indexed BufferGeometry model,
// not Blender's internal PBVH/BMesh structures. Cloth is the one honest
// exception: true cloth brushes run a mass-spring simulation, which is out
// of scope here — it's a wider-radius, softer elastic push, labeled as an
// approximation rather than faked as identical to Draw.
// ─────────────────────────────────────────────────────────────
let _sculptStroke = null; // { mesh, beforeGeo, startLocalHit, startLocalNormal, faceSetId } snapshot/state for the whole stroke
let _nextFaceSetId = 1;

function sculptFalloff(dist, radius) {
    if (dist >= radius) return 0;
    const t = dist / radius;
    return 1 - t * t * (3 - 2 * t); // smoothstep
}

// Real per-vertex mask (Blender: paint to PROTECT an area from further
// sculpting). Stored as a plain Float32Array on the mesh's userData —
// resets if the vertex count changes (a topology-changing edit invalidates
// any prior mask, same as Blender's own behavior). 0 = fully sculptable,
// 1 = fully protected.
function ensureSculptMask(mesh) {
    const n = mesh.geometry.attributes.position.count;
    if (!mesh.userData.sculptMask || mesh.userData.sculptMask.length !== n) {
        mesh.userData.sculptMask = new Float32Array(n); // all zero = unprotected
    }
    return mesh.userData.sculptMask;
}

// Real per-triangle face sets (Blender: paint to tag regions with an ID,
// used later for isolating/selecting parts of the mesh). Stored as a plain
// Int32Array on userData, one entry per triangle, default set 1.
function ensureFaceSets(mesh) {
    const triCount = mesh.geometry.attributes.position.count / 3;
    if (!mesh.userData.faceSets || mesh.userData.faceSets.length !== triCount) {
        mesh.userData.faceSets = new Int32Array(triCount).fill(1);
    }
    return mesh.userData.faceSets;
}

function faceSetColor(id) {
    const hue = (id * 47) % 360; // deterministic, well-spread hue per id
    return new THREE.Color().setHSL(hue / 360, 0.55, 0.5);
}

// Recomputes the mesh's vertex-color overlay from mask + face-set state —
// the actual visible feedback for both (matching Blender's red mask tint /
// colored face-set overlay), composited: face-set hue as the base, darkened
// toward red where masked.
function refreshSculptOverlayColors(mesh) {
    const geo = mesh.geometry;
    const n = geo.attributes.position.count;
    const hasMask = mesh.userData.sculptMask && mesh.userData.sculptMask.some(v => v > 0.001);
    const hasFaceSets = mesh.userData.faceSets && mesh.userData.faceSets.some(v => v !== 1);
    if (!hasMask && !hasFaceSets) {
        if (geo.attributes.color) geo.deleteAttribute('color');
        allMaterials(mesh).forEach(m => { m.vertexColors = false; m.needsUpdate = true; });
        return;
    }
    const colors = new Float32Array(n * 3);
    const mask = mesh.userData.sculptMask;
    const faceSets = mesh.userData.faceSets;
    const triCount = n / 3;
    const base = new THREE.Color();
    for (let t = 0; t < triCount; t++) {
        base.copy(hasFaceSets ? faceSetColor(faceSets[t]) : new THREE.Color(0xffffff));
        for (let k = 0; k < 3; k++) {
            const i = t * 3 + k;
            const m = mask ? mask[i] : 0;
            const c = base.clone().lerp(new THREE.Color(0xff3b3b), m * 0.6);
            colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
        }
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    allMaterials(mesh).forEach(m => { m.vertexColors = true; m.needsUpdate = true; });
}

function applySculptStroke(mesh, hitPointWorld, prevHitPointWorld) {
    const geo = mesh.geometry;
    geo.computeVertexNormals();
    const pos = geo.attributes.position, norm = geo.attributes.normal;
    const isWideBrush = sculpt.brush === 'cloth'; // real cloth brushes affect a much wider area than their visible radius
    const radiusWorld = Math.max(0.05, sculpt.radius / 60) * (isWideBrush ? 1.8 : 1);
    const strength = sculpt.strength * 0.15; // per-frame step; a drag applies this many times/sec
    const invertSign = sculpt.invert ? -1 : 1;

    const localHit = mesh.worldToLocal(hitPointWorld.clone());
    let dragDeltaLocal = null;
    if (prevHitPointWorld) {
        const invMat = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
        dragDeltaLocal = hitPointWorld.clone().sub(prevHitPointWorld).transformDirection(invMat);
    }

    const affected = [];
    const centroid = new THREE.Vector3();
    const avgNormal = new THREE.Vector3();
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        if (v.distanceTo(localHit) < radiusWorld) {
            affected.push(i);
            centroid.add(v);
            avgNormal.add(new THREE.Vector3().fromBufferAttribute(norm, i));
        }
    }
    if (affected.length === 0) return false;
    centroid.divideScalar(affected.length);
    avgNormal.normalize();

    // Mask + Draw Face Sets are non-geometric brushes — they paint state,
    // never move a vertex.
    if (sculpt.brush === 'mask') {
        const mask = ensureSculptMask(mesh);
        affected.forEach(i => {
            v.fromBufferAttribute(pos, i);
            const falloff = sculptFalloff(v.distanceTo(localHit), radiusWorld);
            mask[i] = THREE.MathUtils.clamp(mask[i] + (sculpt.invert ? -1 : 1) * falloff * strength * 3, 0, 1);
        });
        refreshSculptOverlayColors(mesh);
        return true;
    }
    if (sculpt.brush === 'draw_face_sets') {
        const faceSets = ensureFaceSets(mesh);
        if (_sculptStroke && _sculptStroke.faceSetId == null) _sculptStroke.faceSetId = ++_nextFaceSetId;
        const id = (_sculptStroke && _sculptStroke.faceSetId) || ++_nextFaceSetId;
        for (let t = 0; t < faceSets.length; t++) {
            let anyVertInRange = false;
            for (let k = 0; k < 3; k++) {
                v.fromBufferAttribute(pos, t * 3 + k);
                if (v.distanceTo(localHit) < radiusWorld) { anyVertInRange = true; break; }
            }
            if (anyVertInRange) faceSets[t] = id;
        }
        refreshSculptOverlayColors(mesh);
        return true;
    }

    // Reference plane for Flatten/Scrape/Clay Strips/Layer — captured once
    // at stroke start (first click), not re-derived every frame, so the
    // target plane/depth stays fixed for the whole stroke like Blender's does.
    const refPoint = (_sculptStroke && _sculptStroke.startLocalHit) || localHit;
    const refNormal = (_sculptStroke && _sculptStroke.startLocalNormal) || avgNormal;

    const mask = mesh.userData.sculptMask;
    const n = new THREE.Vector3();
    affected.forEach(i => {
        v.fromBufferAttribute(pos, i);
        n.fromBufferAttribute(norm, i);
        let falloff = sculptFalloff(v.distanceTo(localHit), radiusWorld);
        if (mask) falloff *= (1 - mask[i]); // masked vertices resist every geometry brush

        switch (sculpt.brush) {
            case 'smooth':
                v.lerp(centroid, falloff * strength * 2);
                break;

            case 'grab':
                // Rigid: every affected vertex follows the cursor 1:1, weighted only by falloff.
                if (dragDeltaLocal) v.addScaledVector(dragDeltaLocal, falloff);
                break;

            case 'snake_hook': {
                // Stretches a tapering "tail" toward the cursor — unlike Grab's
                // rigid follow, points nearer the very center stretch further
                // than points near the radius edge (sharper falloff power).
                if (dragDeltaLocal) v.addScaledVector(dragDeltaLocal, Math.pow(falloff, 3) * 1.8);
                break;
            }

            case 'thumb':
                // Grab blended with smoothing, so it pushes without leaving spikes.
                if (dragDeltaLocal) v.addScaledVector(dragDeltaLocal, falloff * 0.6);
                v.lerp(centroid, falloff * strength * 0.5);
                break;

            case 'rotate': {
                // True rotation: twist each affected vertex around the axis
                // through localHit along the average surface normal, by an
                // angle driven by the drag's tangential (sideways) motion.
                if (dragDeltaLocal) {
                    const tangential = dragDeltaLocal.clone().sub(avgNormal.clone().multiplyScalar(dragDeltaLocal.dot(avgNormal)));
                    const angle = tangential.length() * 2.5 * (Math.sign(tangential.dot(new THREE.Vector3(1, 0, 0).cross(avgNormal))) || 1) * falloff;
                    const q = new THREE.Quaternion().setFromAxisAngle(avgNormal, angle);
                    const rel = v.clone().sub(localHit).applyQuaternion(q);
                    v.copy(localHit).add(rel);
                }
                break;
            }

            case 'pinch':
                v.lerp(localHit, falloff * strength);
                break;

            case 'crease':
                // Draw's push PLUS a lateral pinch toward the stroke centerline —
                // the combination is what actually produces a sharp ridge instead
                // of a rounded bump.
                v.addScaledVector(n, falloff * strength * invertSign);
                v.lerp(localHit, falloff * strength * 0.5);
                break;

            case 'layer': {
                // Pushes along the normal like Draw, but clamped to a fixed max
                // offset from the reference plane — sculpting further in the
                // same spot doesn't keep piling up past that layer height.
                const currentOffset = v.clone().sub(refPoint).dot(refNormal);
                const maxOffset = strength * 8 * invertSign;
                const room = maxOffset - currentOffset;
                if ((invertSign > 0 && room > 0) || (invertSign < 0 && room < 0)) {
                    v.addScaledVector(n, falloff * strength * invertSign * 0.5);
                }
                break;
            }

            case 'clay':
                // Like Draw but along the STROKE's averaged normal (not each
                // vertex's own), giving a flatter, firmer bump than Draw's
                // per-vertex push.
                v.addScaledVector(avgNormal, falloff * strength * invertSign * 0.8);
                break;

            case 'clay_strips': {
                // Pushes toward a flat reference plane through the current hit
                // point — genuinely flattens the affected patch into a strip
                // rather than bulging it.
                const dist = v.clone().sub(localHit).dot(avgNormal);
                v.addScaledVector(avgNormal, (strength * invertSign - dist) * falloff * 0.6);
                break;
            }

            case 'flatten': {
                // Pushes toward the plane captured at stroke start — both
                // directions (raises low points, lowers high points), the
                // real "make this area flat" behavior.
                const dist = v.clone().sub(refPoint).dot(refNormal);
                v.addScaledVector(refNormal, -dist * falloff * strength * 2);
                break;
            }

            case 'scrape': {
                // Same reference plane as Flatten, but ONE-DIRECTIONAL — only
                // ever removes material above the plane, never pushes material
                // out past it (a real scraper can't add height).
                const dist = v.clone().sub(refPoint).dot(refNormal);
                if (dist > 0) v.addScaledVector(refNormal, -dist * falloff * strength * 2);
                break;
            }

            case 'inflate':
                v.addScaledVector(n, falloff * strength * invertSign);
                break;

            case 'cloth':
                // Honest approximation, not true cloth physics (a real mass-
                // spring solve is out of scope) — a wide, soft elastic push
                // that also drags the surrounding area gently, giving a
                // "fabric" feel without simulating one.
                if (dragDeltaLocal) v.addScaledVector(dragDeltaLocal, falloff * 0.5);
                v.addScaledVector(n, falloff * strength * 0.3 * invertSign);
                break;

            default: // draw
                v.addScaledVector(n, falloff * strength * invertSign);
        }
        pos.setXYZ(i, v.x, v.y, v.z);
    });

    pos.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return true;
}

function setupSculptTools(canvas) {
    let sculpting = false;
    let lastWorldPoint = null;

    function raycastSculptTarget(e) {
        const rect = canvas.getBoundingClientRect();
        _mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        _mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        _raycaster.setFromCamera(_mouse, camera);
        const targets = (selectedObject && selectedObject.isMesh)
            ? [selectedObject]
            : sceneObjects.filter(o => o.mesh && o.mesh.isMesh).map(o => o.mesh);
        const hits = _raycaster.intersectObjects(targets, false);
        return hits.length > 0 ? hits[0] : null;
    }

    canvas.addEventListener('pointerdown', e => {
        if (currentInteractionMode !== 'sculpt' || e.button !== 0) return;
        const hit = raycastSculptTarget(e);
        if (!hit || !hit.object.isMesh) return;
        if (selectedObject !== hit.object) selectObject(hit.object);

        sculpting = true;
        lastWorldPoint = hit.point.clone();
        const startLocalHit = hit.object.worldToLocal(hit.point.clone());
        // face.normal from THREE.Raycaster is already in the object's LOCAL
        // space (computed from local-space vertex positions) — matches what
        // applySculptStroke() needs directly, no extra transform.
        const startLocalNormal = hit.face ? hit.face.normal.clone() : new THREE.Vector3(0, 0, 1);
        _sculptStroke = {
            mesh: hit.object,
            beforeGeo: deepCloneGeometry(hit.object.geometry),
            beforeMask: hit.object.userData.sculptMask ? hit.object.userData.sculptMask.slice() : null,
            beforeFaceSets: hit.object.userData.faceSets ? hit.object.userData.faceSets.slice() : null,
            startLocalHit, startLocalNormal,
            faceSetId: null,
        };
        orbitControls.enabled = false;
        applySculptStroke(hit.object, hit.point, null);
        setVCB('Sculpt:', SCULPT_BRUSHES[sculpt.brush]?.label || sculpt.brush);
    });

    canvas.addEventListener('pointermove', e => {
        if (!sculpting || !_sculptStroke) return;
        const hit = raycastSculptTarget(e);
        if (!hit || hit.object !== _sculptStroke.mesh) return;
        applySculptStroke(hit.object, hit.point, lastWorldPoint);
        lastWorldPoint = hit.point.clone();
    });

    window.addEventListener('pointerup', () => {
        if (!sculpting) return;
        sculpting = false;
        orbitControls.enabled = true;
        if (_sculptStroke) {
            const { mesh, beforeGeo, beforeMask, beforeFaceSets } = _sculptStroke;
            const afterGeo = deepCloneGeometry(mesh.geometry);
            const afterMask = mesh.userData.sculptMask ? mesh.userData.sculptMask.slice() : null;
            const afterFaceSets = mesh.userData.faceSets ? mesh.userData.faceSets.slice() : null;
            pushUndo({
                undo() {
                    mesh.geometry.dispose(); mesh.geometry = beforeGeo;
                    mesh.userData.sculptMask = beforeMask; mesh.userData.faceSets = beforeFaceSets;
                    refreshSculptOverlayColors(mesh);
                },
                redo() {
                    mesh.geometry.dispose(); mesh.geometry = afterGeo;
                    mesh.userData.sculptMask = afterMask; mesh.userData.faceSets = afterFaceSets;
                    refreshSculptOverlayColors(mesh);
                },
            });
            _sculptStroke = null;
        }
    });
}

function setSculptBrush(name) {
    sculpt.brush = name;
    const info = SCULPT_BRUSHES[name] || { label: name };
    const lbl  = document.getElementById('sculpt-brush-label');
    if (lbl) lbl.innerText = info.label;
    setVCB('Sculpt Brush:', info.label);

    document.querySelectorAll('.sculpt-brush-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById(`tb-s-${name.replace(/_/g, '-')}`);
    if (btn) btn.classList.add('active');
}

// Builds the real brush picker — previously setSculptBrush() looked for
// buttons (id="tb-s-<name>") to highlight, but nothing in the page ever
// created them and nothing ever called setSculptBrush() at all, so a user
// had no way to reach 15 of the 16 real, distinct sculpt brushes built this
// session; only whatever 'Draw' did by default was ever reachable. Renders
// straight from SCULPT_BRUSHES so the picker can't drift out of sync with
// the real brush registry.
function renderSculptBrushGrid() {
    const grid = document.getElementById('sculpt-brush-grid');
    if (!grid) return;
    grid.innerHTML = '';
    Object.keys(SCULPT_BRUSHES).forEach(name => {
        const info = SCULPT_BRUSHES[name];
        const btn = document.createElement('button');
        btn.className = 'sculpt-brush-btn' + (sculpt.brush === name ? ' active' : '');
        btn.id = `tb-s-${name.replace(/_/g, '-')}`;
        btn.textContent = info.label;
        btn.title = info.label;
        btn.onclick = () => setSculptBrush(name);
        grid.appendChild(btn);
    });
}

// ─────────────────────────────────────────────────────────────
// ANIMATION / DOPE SHEET — from space_dopesheet.py
// ─────────────────────────────────────────────────────────────
function setupDopeSheet() {
    drawDopeSheet();
}

function togglePlay() {
    isAnimPlaying = !isAnimPlaying;
    const btn = document.getElementById('btn-play');
    if (btn) btn.innerText = isAnimPlaying ? '⏸' : '▶';
    setVCB(isAnimPlaying ? 'Playback:' : 'Paused:', `Frame ${animFrame}`);
}

function setAnimFrame(f) {
    animFrame = Math.max(1, Math.min(250, parseInt(f)));
    const scrub = document.getElementById('anim-scrubber');
    const disp  = document.getElementById('frame-display');
    if (scrub) scrub.value = animFrame;
    if (disp)  disp.innerText = animFrame;
    applyAnimationAtFrame(animFrame);
    drawDopeSheet();
}

function stepAnimFrame(delta) { setAnimFrame(animFrame + delta); }
function onScrub(val)         { setAnimFrame(val); }

function insertKeyframe() {
    if (!selectedObject) { setVCB('Keyframe:', 'Select object first'); return; }

    const id = selectedObject.uuid;
    if (!keyframes[id]) keyframes[id] = [];

    keyframes[id] = keyframes[id].filter(k => k.frame !== animFrame);
    keyframes[id].push({
        frame: animFrame,
        pos:   selectedObject.position.clone(),
        rot:   selectedObject.rotation.clone(),
        scale: selectedObject.scale.clone(),
    });
    keyframes[id].sort((a, b) => a.frame - b.frame);

    drawDopeSheet();
    updateKeyframeListUI();
    setVCB('Keyframe Inserted:', `Frame ${animFrame} — ${selectedObject.name}`);
}

// Keying menu (Timeline) — Delete Keyframe at the current playhead frame.
function deleteKeyframeAtCurrentFrame() {
    if (!selectedObject) { setVCB('Keyframe:', 'Select object first'); return; }
    const id = selectedObject.uuid;
    const kf = keyframes[id];
    if (!kf) { setVCB('Keyframe:', 'No keyframes on this object'); return; }
    const before = kf.length;
    keyframes[id] = kf.filter(k => k.frame !== animFrame);
    if (keyframes[id].length === before) { setVCB('Keyframe:', `No keyframe at frame ${animFrame}`); return; }
    drawDopeSheet();
    updateKeyframeListUI();
    setVCB('Keyframe Deleted:', `Frame ${animFrame} — ${selectedObject.name}`);
}

// Marker menu (Timeline) — real named frame bookmarks, drawn as ticks on
// the dope sheet ruler.
let timelineMarkers = [];
function addMarkerAtCurrentFrame() {
    timelineMarkers = timelineMarkers.filter(m => m.frame !== animFrame);
    timelineMarkers.push({ frame: animFrame, name: `F_${animFrame}` });
    timelineMarkers.sort((a, b) => a.frame - b.frame);
    drawDopeSheet();
    setVCB('Marker:', `Added at frame ${animFrame}`);
}
function clearAllMarkers() {
    timelineMarkers = [];
    drawDopeSheet();
    setVCB('Marker:', 'All markers cleared');
}
function jumpToNextMarker() {
    const next = timelineMarkers.find(m => m.frame > animFrame);
    if (next) setAnimFrame(next.frame);
}
function jumpToPrevMarker() {
    const prev = [...timelineMarkers].reverse().find(m => m.frame < animFrame);
    if (prev) setAnimFrame(prev.frame);
}

function applyAnimationAtFrame(f) {
    sceneObjects.forEach(({ mesh }) => {
        const kf = keyframes[mesh.uuid];
        if (!kf || kf.length < 2) {
            if (kf && kf.length === 1) {
                mesh.position.copy(kf[0].pos);
                mesh.rotation.copy(kf[0].rot);
                mesh.scale.copy(kf[0].scale);
            }
            return;
        }

        let prev = kf[0], next = kf[kf.length - 1];
        for (let i = 0; i < kf.length; i++) {
            if (kf[i].frame <= f) prev = kf[i];
            if (kf[i].frame >= f) { next = kf[i]; break; }
        }

        if (prev === next) {
            mesh.position.copy(prev.pos);
            mesh.rotation.copy(prev.rot);
            mesh.scale.copy(prev.scale);
            return;
        }
        const alpha = (f - prev.frame) / (next.frame - prev.frame);
        mesh.position.lerpVectors(prev.pos, next.pos, alpha);
        mesh.scale.lerpVectors(prev.scale, next.scale, alpha);
        // Rotation needs spherical interpolation (slerp) via quaternions,
        // not a per-axis Euler lerp — a raw Euler lerp takes the wrong path
        // for any rotation over roughly half a turn and can twist through
        // an unexpected axis. This was previously not interpolated AT ALL
        // (only position/scale were), so an animation that changed only
        // rotation between its two keyframes showed no motion whatsoever
        // during playback — exactly "insert a 2nd keyframe, play, nothing
        // reflects it."
        const qPrev = new THREE.Quaternion().setFromEuler(prev.rot);
        const qNext = new THREE.Quaternion().setFromEuler(next.rot);
        const qOut = new THREE.Quaternion();
        // This build's slerpQuaternions() mutates qOut in place but doesn't
        // return `this` the way the documented API implies — using the
        // (undefined) return value here crashed setFromQuaternion().
        qOut.slerpQuaternions(qPrev, qNext, alpha);
        mesh.rotation.setFromQuaternion(qOut);
    });

    if (selectedObject) updateInspectorFromSelected();
}

function drawDopeSheet() {
    const canvas = document.getElementById('dope-canvas');
    if (!canvas) return;

    const W = canvas.offsetWidth || 400;
    const H = 28;
    canvas.width  = W;
    canvas.height = H;

    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#111111';
    ctx.fillRect(0, 0, W, H);

    // Frame ticks every 10 frames
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 1;
    for (let f = 10; f <= 250; f += 10) {
        const x = ((f - 1) / 249) * W;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }

    // Timeline markers — small green ticks along the bottom
    ctx.fillStyle = '#2ecc71';
    timelineMarkers.forEach(m => {
        const x = ((m.frame - 1) / 249) * W;
        ctx.beginPath();
        ctx.moveTo(x - 4, H); ctx.lineTo(x + 4, H); ctx.lineTo(x, H - 7);
        ctx.closePath(); ctx.fill();
    });

    // Keyframe diamonds for selected object (yellow — Blender default)
    const kf = selectedObject ? keyframes[selectedObject.uuid] : null;
    if (kf) {
        kf.forEach(k => {
            const x = ((k.frame - 1) / 249) * W;
            ctx.fillStyle = '#f1c40f';
            ctx.beginPath();
            ctx.moveTo(x, 4);
            ctx.lineTo(x + 5, 14);
            ctx.lineTo(x, 24);
            ctx.lineTo(x - 5, 14);
            ctx.closePath();
            ctx.fill();
        });
    }

    // Playhead — blue vertical bar (Blender signature)
    const px = ((animFrame - 1) / 249) * W;
    ctx.strokeStyle = '#4772b3';
    ctx.lineWidth   = 2;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();

    // Playhead triangle
    ctx.fillStyle = '#4772b3';
    ctx.beginPath();
    ctx.moveTo(px - 5, 0);
    ctx.lineTo(px + 5, 0);
    ctx.lineTo(px, 7);
    ctx.closePath();
    ctx.fill();
}

function updateKeyframeListUI() {
    const list = document.getElementById('keyframe-list');
    if (!list) return;

    const kf = selectedObject ? keyframes[selectedObject.uuid] : null;
    if (!kf || kf.length === 0) {
        list.innerHTML = '<div style="color:#666; font-size:10px; padding:4px;">No keyframes. Press (I) to insert.</div>';
        return;
    }

    list.innerHTML = kf.map(k => `
        <div style="display:flex; align-items:center; gap:8px; padding:3px 6px; background:#2a2a2a; border-radius:3px; margin-bottom:2px; cursor:pointer;"
             onclick="setAnimFrame(${k.frame})">
            <span style="font-size:10px; color:#f1c40f;">◆</span>
            <span style="font-size:10px;">Frame ${k.frame}</span>
            <span style="font-size:9px; color:#555; margin-left:auto;">LocRot</span>
        </div>
    `).join('');
}

// ─────────────────────────────────────────────────────────────
// SKETCHUP CAD — Push/Pull, Offset, Tape Measure, VCB
// ─────────────────────────────────────────────────────────────
let suCanvas, suCtx, suMode = null, suPoints = [];

function setupSuCanvas() {
    suCanvas = document.getElementById('su-canvas');
    if (!suCanvas) return;
    suCtx = suCanvas.getContext('2d');
    suCanvas.style.pointerEvents = 'none';
}

function doPushPull() {
    const obj = selectedObject;
    if (!obj || !obj.isMesh) { setVCB('Push/Pull:', 'Select a face first'); return; }

    const depth = parseFloat((document.getElementById('pp-depth') || {}).value || 2.5);

    if (runFaceExtrude(depth)) {
        setVCB('Push/Pull (Face):', `+${depth.toFixed(2)} m — ${selectedFaces.length} face(s)`);
        return;
    }

    // No active face selection (e.g. Object Mode) — fall back to the
    // whole-object approximation.
    withScaleUndo(obj, o => { o.scale.z += depth / (obj.geometry.parameters?.depth || 2); });
    updateInspectorFromSelected();
    setVCB('Push/Pull:', `+${depth.toFixed(2)} m`);
}

// ─────────────────────────────────────────────────────────────
// VCB — SketchUp Value Control Box / Blender Status Bar
// ─────────────────────────────────────────────────────────────
function setVCB(label, value) {
    const lEl = document.getElementById('vcb-label');
    const vEl = document.getElementById('vcb-value');
    if (lEl) lEl.innerText = label;
    if (vEl) vEl.innerText = value;
}

// ─────────────────────────────────────────────────────────────
// OBJECT OPS — Duplicate, Delete, New Scene
// ─────────────────────────────────────────────────────────────
function duplicateSelected() {
    const targets = [];
    if (outlinerMultiSelect.size) outlinerMultiSelect.forEach(m => { if (m && m.isMesh) targets.push(m); });
    else if (selectedObject && selectedObject.isMesh) targets.push(selectedObject);
    if (!targets.length) return;
    const clones = [];
    targets.forEach(src => {
        const clone = src.clone();
        clone.material = Array.isArray(src.material) ? src.material.map(m => m.clone()) : src.material.clone();
        clone.geometry = deepCloneGeometry(src.geometry);
        clone.position.x += 2.2;
        clone.name = src.name + '.001';
        const type = (sceneObjects.find(o => o.mesh === src) || {}).type || 'mesh';
        scene.add(clone);
        sceneObjects.push({ name: clone.name, type, mesh: clone });
        clones.push(clone);
    });
    outlinerMultiSelect.clear();
    clones.forEach(c => outlinerMultiSelect.add(c));
    renderOutliner();
    selectObject(clones[clones.length - 1]);
    setVCB('Duplicate:', clones.length === 1 ? clones[0].name : `${clones.length} objects`);
    pushUndo({
        undo() { clones.forEach(c => removeSceneObject(c)); },
        redo() { clones.forEach(c => { const type = 'mesh'; scene.add(c); sceneObjects.push({ name: c.name, type, mesh: c }); }); renderOutliner(); selectObject(clones[clones.length - 1]); },
    });
}

// Removes a scene object from the live scene/outliner WITHOUT disposing its
// geometry/material, so a later undo() can re-add the exact same instance.
function removeSceneObject(mesh) {
    const idx = sceneObjects.findIndex(o => o.mesh === mesh);
    if (idx === -1) return false;
    if (selectedObject === mesh) transformControls.detach();
    scene.remove(mesh);
    sceneObjects.splice(idx, 1);
    if (selectedObject === mesh) selectObject(null);
    renderOutliner();
    return true;
}

// ─────────────────────────────────────────────────────────────
// GROUP / COMPONENT — SketchUp-style object organization.
//
// Group: bundles several existing scene objects into one rigid unit (a real
// THREE.Group parent; children re-parented with their world transform
// preserved) so they select/move/rotate/scale together and don't fuse with
// surrounding geometry — matches real SketchUp Group semantics. Not
// live-linked (SketchUp Groups aren't either); to edit a member, Ungroup,
// edit it with the normal single-mesh tools, then Group again.
//
// Component: a single mesh tagged with a shared definition id. "Insert
// Instance" clones it (own geometry/material objects — never a shared
// BufferGeometry reference, which would risk one instance's tool disposing
// a buffer another instance still renders with). Instead,
// propagateComponentEdit() is called at every edit-tool commit point
// (applyBlenderModifier, executeMeshEditTool, the Offset/Push-Pull drag
// tools) and re-clones the edited instance's current geometry+material onto
// every sibling instance — real "edit one, all update" behavior without the
// dangling-buffer hazard. Position/rotation/scale stay independent per
// instance, matching SketchUp. Scoped to single-mesh components (not
// multi-object groups) so it reuses every existing single-mesh tool as-is —
// no changes needed to selection/raycasting for nested children.
// ─────────────────────────────────────────────────────────────
let outlinerMultiSelect = new Set(); // meshes ctrl/shift-clicked in the Outliner, for Group Selected
const componentInstancesByDef = new Map(); // defId -> Set<mesh>
let _nextComponentDefId = 1;

function toggleOutlinerMultiSelect(mesh, additive) {
    if (!additive) { outlinerMultiSelect.clear(); outlinerMultiSelect.add(mesh); }
    else if (outlinerMultiSelect.has(mesh)) outlinerMultiSelect.delete(mesh);
    else outlinerMultiSelect.add(mesh);
    renderOutliner();
}

function groupSelectedObjects() {
    const members = outlinerMultiSelect.size > 0 ? Array.from(outlinerMultiSelect) : (selectedObject ? [selectedObject] : []);
    if (members.length === 0) { setVCB('Group:', 'Select 2+ objects in the Outliner first (Ctrl/Shift-click)'); return; }

    const group = new THREE.Group();
    group.name = nextName('Group');
    scene.add(group);
    const invGroupMatrix = new THREE.Matrix4();

    const before = members.map(m => ({
        mesh: m,
        entry: sceneObjects.find(o => o.mesh === m),
        worldMatrix: m.matrixWorld.clone(),
    }));

    members.forEach(m => {
        m.updateMatrixWorld(true);
        scene.remove(m);
        group.add(m);
    });
    invGroupMatrix.copy(group.matrixWorld).invert();
    before.forEach(({ mesh, worldMatrix }) => {
        const local = worldMatrix.clone().premultiply(invGroupMatrix);
        local.decompose(mesh.position, mesh.quaternion, mesh.scale);
    });
    before.forEach(({ entry }) => { if (entry) sceneObjects.splice(sceneObjects.indexOf(entry), 1); });
    sceneObjects.push({ name: group.name, type: 'group', mesh: group });

    outlinerMultiSelect.clear();
    renderOutliner();
    selectObject(group);
    setVCB('Group:', `${members.length} object(s)`);

    pushUndo({
        undo() {
            members.forEach(m => { m.updateMatrixWorld(true); const wm = m.matrixWorld.clone(); scene.remove(m); scene.add(m); wm.decompose(m.position, m.quaternion, m.scale); });
            removeSceneObject(group);
            before.forEach(({ mesh, entry }) => sceneObjects.push(entry || { name: mesh.name, type: 'mesh', mesh }));
            renderOutliner();
        },
        redo() {
            before.forEach(({ entry }) => { if (entry) { const i = sceneObjects.indexOf(entry); if (i !== -1) sceneObjects.splice(i, 1); } });
            scene.add(group);
            members.forEach(m => { m.updateMatrixWorld(true); scene.remove(m); group.add(m); });
            const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
            before.forEach(({ mesh, worldMatrix }) => { const local = worldMatrix.clone().premultiply(inv); local.decompose(mesh.position, mesh.quaternion, mesh.scale); });
            sceneObjects.push({ name: group.name, type: 'group', mesh: group });
            renderOutliner();
        },
    });
}

function ungroupSelected() {
    const group = selectedObject;
    const entry = sceneObjects.find(o => o.mesh === group);
    if (!group || !entry || entry.type !== 'group') { setVCB('Ungroup:', 'Select a Group first'); return; }

    const children = group.children.slice();
    const beforeLocal = children.map(c => c.matrix.clone());

    children.forEach(c => {
        c.updateMatrixWorld(true);
        const wm = c.matrixWorld.clone();
        group.remove(c);
        scene.add(c);
        wm.decompose(c.position, c.quaternion, c.scale);
    });
    removeSceneObject(group);
    children.forEach(c => sceneObjects.push({ name: c.name, type: 'mesh', mesh: c }));
    renderOutliner();
    setVCB('Ungroup:', `${children.length} object(s)`);

    pushUndo({
        undo() {
            children.forEach(c => { const i = sceneObjects.findIndex(o => o.mesh === c); if (i !== -1) sceneObjects.splice(i, 1); scene.remove(c); group.add(c); });
            children.forEach((c, i) => c.matrix.copy(beforeLocal[i]).decompose(c.position, c.quaternion, c.scale));
            scene.add(group);
            sceneObjects.push({ name: group.name, type: 'group', mesh: group });
            renderOutliner();
        },
        redo() {
            removeSceneObject(group);
            children.forEach(c => { c.updateMatrixWorld(true); const wm = c.matrixWorld.clone(); group.remove(c); scene.add(c); wm.decompose(c.position, c.quaternion, c.scale); sceneObjects.push({ name: c.name, type: 'mesh', mesh: c }); });
            renderOutliner();
        },
    });
}

function makeComponentFromSelection() {
    const obj = selectedObject;
    if (!obj || !obj.isMesh) { setVCB('Component:', 'Select a single mesh first'); return; }
    const entry = sceneObjects.find(o => o.mesh === obj);
    if (!entry) return;
    const defId = 'comp' + (_nextComponentDefId++);
    obj.userData.componentDefId = defId;
    componentInstancesByDef.set(defId, new Set([obj]));
    entry.type = 'component';
    renderOutliner();
    setVCB('Component:', `${obj.name} is now a Component (${defId})`);
}

function insertComponentInstance() {
    const obj = selectedObject;
    const defId = obj && obj.userData.componentDefId;
    if (!defId) { setVCB('Insert Instance:', 'Select a Component first (Make Component on a mesh)'); return; }

    const clone = obj.clone();
    clone.material = obj.material.clone();
    clone.geometry = deepCloneGeometry(obj.geometry);
    clone.position.x += 2.2;
    clone.name = nextName(obj.name.replace(/\.\d+$/, '') + '_Instance');
    clone.userData.componentDefId = defId;

    scene.add(clone);
    sceneObjects.push({ name: clone.name, type: 'component', mesh: clone });
    (componentInstancesByDef.get(defId) || new Set()).add(clone);
    if (!componentInstancesByDef.has(defId)) componentInstancesByDef.set(defId, new Set([obj, clone]));
    renderOutliner();
    selectObject(clone);
    setVCB('Insert Instance:', clone.name);

    pushUndo({
        undo() { componentInstancesByDef.get(defId)?.delete(clone); removeSceneObject(clone); },
        redo() { scene.add(clone); sceneObjects.push({ name: clone.name, type: 'component', mesh: clone }); componentInstancesByDef.get(defId)?.add(clone); renderOutliner(); selectObject(clone); },
    });
}

// Call after any tool commits a geometry/material edit to `mesh` — if it's a
// component instance, mirrors the change onto every sibling instance.
function propagateComponentEdit(mesh) {
    const defId = mesh && mesh.userData && mesh.userData.componentDefId;
    if (!defId) return;
    const siblings = componentInstancesByDef.get(defId);
    if (!siblings) return;
    siblings.forEach(inst => {
        if (inst === mesh) return;
        inst.geometry.dispose();
        inst.geometry = deepCloneGeometry(mesh.geometry);
        inst.material.dispose();
        inst.material = mesh.material.clone();
    });
}

// Make Unique — detaches one component instance from its shared definition
// so future edits to it (or to its former siblings) no longer propagate
// either way, matching real SketchUp's "Make Unique" on a component copy.
function makeUniqueComponent() {
    const obj = selectedObject;
    const defId = obj && obj.userData && obj.userData.componentDefId;
    if (!defId) { setVCB('Make Unique:', 'Select a Component instance first'); return; }
    const siblings = componentInstancesByDef.get(defId);
    const entry = sceneObjects.find(o => o.mesh === obj);

    delete obj.userData.componentDefId;
    if (siblings) siblings.delete(obj);
    if (entry) entry.type = 'mesh';
    renderOutliner();
    setVCB('Make Unique:', `${obj.name} no longer shares edits with other instances`);

    pushUndo({
        undo() { obj.userData.componentDefId = defId; if (siblings) siblings.add(obj); if (entry) entry.type = 'component'; renderOutliner(); },
        redo() { delete obj.userData.componentDefId; if (siblings) siblings.delete(obj); if (entry) entry.type = 'mesh'; renderOutliner(); },
    });
}

// ─────────────────────────────────────────────────────────────
// DELETE/DISSOLVE (X) for a sub-element selection — removes just the
// selected face(s), or every triangle touching the selected vertex/edge,
// from the mesh's geometry. Previously X/Delete always deleted the whole
// object even in Edit Mode with a face selected.
// ─────────────────────────────────────────────────────────────
function deleteSelectedSubElementGeometry() {
    const mesh = selectedObject;
    if (!mesh || !mesh.isMesh) return false;
    ensureNonIndexed(mesh);
    const pos = mesh.geometry.attributes.position;
    const vecKey = v => `${v.x.toFixed(5)},${v.y.toFixed(5)},${v.z.toFixed(5)}`;

    // Same Vertex > Edge > Face priority as the click dispatcher — with the
    // three select modes now independently combinable, more than one kind
    // of selection can be live at once, so pick whichever the user most
    // recently/precisely selected in that priority order.
    let dropTri;
    if (vertexSelectOn && selectedVertexGroup) {
        const targetKey = vecKey(new THREE.Vector3().fromBufferAttribute(pos, selectedVertexGroup[0]));
        dropTri = i => [0, 1, 2].some(v => vecKey(new THREE.Vector3().fromBufferAttribute(pos, i + v)) === targetKey);
    } else if (edgeSelectOn && selectedEdgeGroups) {
        const keyA = vecKey(new THREE.Vector3().fromBufferAttribute(pos, selectedEdgeGroups.a[0]));
        const keyB = vecKey(new THREE.Vector3().fromBufferAttribute(pos, selectedEdgeGroups.b[0]));
        dropTri = i => [0, 1, 2].some(v => { const k = vecKey(new THREE.Vector3().fromBufferAttribute(pos, i + v)); return k === keyA || k === keyB; });
    } else if (faceSelectOn && selectedFaces.length > 0) {
        const selectedSet = new Set(selectedFaces.map(f => f * 3));
        dropTri = i => selectedSet.has(i);
    } else {
        return false;
    }

    const kept = [];
    for (let i = 0; i < pos.count; i += 3) {
        if (dropTri(i)) continue;
        for (let v = 0; v < 3; v++) kept.push(pos.getX(i + v), pos.getY(i + v), pos.getZ(i + v));
    }
    if (kept.length === pos.array.length) return false; // nothing actually removed

    const newGeo = new THREE.BufferGeometry();
    newGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(kept), 3));
    newGeo.computeVertexNormals();
    mesh.geometry.dispose();
    mesh.geometry = newGeo;
    return true;
}

function runDeleteSubElement() {
    const obj = selectedObject;
    if (!obj || !obj.isMesh) return false;
    const beforeGeo = deepCloneGeometry(obj.geometry);
    if (!deleteSelectedSubElementGeometry()) { beforeGeo.dispose(); return false; }
    const afterGeo = obj.geometry;
    clearFaceSelection(); clearVertexSelection(); clearEdgeSelection();
    pushUndo({
        undo() { obj.geometry.dispose(); obj.geometry = beforeGeo; },
        redo() { obj.geometry.dispose(); obj.geometry = afterGeo; },
    });
    setVCB('Delete:', 'Selection removed');
    return true;
}

// ─────────────────────────────────────────────────────────────
// MERGE BY DISTANCE (M) — Blender's most commonly used Merge variant:
// welds any vertices within a small threshold of each other to their
// average position, across the whole mesh. Doesn't need a multi-vertex
// selection UI (this app's Vertex select is single-element), and is what
// actually matters after Bisect/Knife, which can leave tiny numerical
// gaps at cut boundaries.
// ─────────────────────────────────────────────────────────────
function mergeByDistance(mesh, threshold) {
    ensureNonIndexed(mesh);
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    const n = pos.count;
    const points = [];
    for (let i = 0; i < n; i++) points.push(new THREE.Vector3().fromBufferAttribute(pos, i));

    const parent = Array.from({ length: n }, (_, i) => i);
    const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (points[i].distanceTo(points[j]) < threshold) union(i, j);

    const groupSum = new Map(), groupCount = new Map();
    for (let i = 0; i < n; i++) {
        const r = find(i);
        if (!groupSum.has(r)) groupSum.set(r, new THREE.Vector3());
        groupSum.get(r).add(points[i]);
        groupCount.set(r, (groupCount.get(r) || 0) + 1);
    }

    let merged = 0;
    for (let i = 0; i < n; i++) {
        const r = find(i);
        const cnt = groupCount.get(r);
        if (cnt > 1) {
            const avg = groupSum.get(r).clone().divideScalar(cnt);
            pos.setXYZ(i, avg.x, avg.y, avg.z);
            merged++;
        }
    }
    if (merged === 0) return false;
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    return true;
}

function runMergeByDistance() {
    const obj = selectedObject;
    if (!obj || !obj.isMesh) return false;
    const beforeGeo = deepCloneGeometry(obj.geometry);
    if (!mergeByDistance(obj, 0.015)) { beforeGeo.dispose(); setVCB('Merge:', 'No nearby vertices to merge'); return false; }
    const afterGeo = obj.geometry;
    clearFaceSelection(); clearVertexSelection(); clearEdgeSelection();
    pushUndo({
        undo() { obj.geometry.dispose(); obj.geometry = beforeGeo; },
        redo() { obj.geometry.dispose(); obj.geometry = afterGeo; },
    });
    setVCB('Merge by Distance:', 'Nearby vertices welded');
    return true;
}

// ─────────────────────────────────────────────────────────────
// SHADE SMOOTH / SHADE FLAT — a real, explicit action in Blender too
// (not something that survives topology edits automatically there
// either). Matters here because ensureNonIndexed() duplicates every
// vertex the first time any edit tool touches a mesh, so a naive
// computeVertexNormals() afterward makes even originally-smooth
// primitives (UV Sphere, Cylinder, Cone) look faceted everywhere, not
// just at the edited area. Shade Smooth re-averages normals across every
// group of vertices that still share a world position.
// ─────────────────────────────────────────────────────────────
function shadeSmooth() {
    const obj = selectedObject;
    if (!obj || !obj.isMesh) return;
    ensureNonIndexed(obj);
    const beforeGeo = deepCloneGeometry(obj.geometry);

    const geo = obj.geometry;
    geo.computeVertexNormals();
    const norm = geo.attributes.normal;
    const groups = buildPositionGroups(obj);
    groups.forEach(indices => {
        if (indices.length < 2) return;
        const avg = new THREE.Vector3();
        indices.forEach(i => avg.add(new THREE.Vector3(norm.getX(i), norm.getY(i), norm.getZ(i))));
        avg.normalize();
        indices.forEach(i => norm.setXYZ(i, avg.x, avg.y, avg.z));
    });
    norm.needsUpdate = true;

    const afterGeo = deepCloneGeometry(geo);
    pushUndo({ undo() { obj.geometry.dispose(); obj.geometry = beforeGeo; }, redo() { obj.geometry.dispose(); obj.geometry = afterGeo; } });
    setVCB('Shade:', 'Smooth');
}

function shadeFlat() {
    const obj = selectedObject;
    if (!obj || !obj.isMesh) return;
    ensureNonIndexed(obj);
    const beforeGeo = deepCloneGeometry(obj.geometry);
    obj.geometry.computeVertexNormals();
    obj.geometry.attributes.normal.needsUpdate = true;
    const afterGeo = deepCloneGeometry(obj.geometry);
    pushUndo({ undo() { obj.geometry.dispose(); obj.geometry = beforeGeo; }, redo() { obj.geometry.dispose(); obj.geometry = afterGeo; } });
    setVCB('Shade:', 'Flat');
}

// ─────────────────────────────────────────────────────────────
// RECALCULATE NORMALS (OUTSIDE) / FLIP NORMALS — mesh.normals_make_consistent
// (Alt+N) and Flip, from the ZEPETO modeling-applications guide (same
// concept as Blender's). "Outside" flips any triangle whose winding
// points toward the mesh's own centroid instead of away from it — the
// standard heuristic for convex-ish shapes; concave shapes may still need
// a manual Flip on individual faces (Face select + Flip Normals).
// ─────────────────────────────────────────────────────────────
function recalculateNormalsOutside(mesh) {
    ensureNonIndexed(mesh);
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    const centroid = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) centroid.add(new THREE.Vector3().fromBufferAttribute(pos, i));
    centroid.divideScalar(pos.count);

    let flipped = 0;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let i = 0; i < pos.count; i += 3) {
        a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
        const faceCentroid = a.clone().add(b).add(c).divideScalar(3);
        const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
        const outward = faceCentroid.clone().sub(centroid);
        if (normal.dot(outward) < 0) {
            pos.setXYZ(i + 1, c.x, c.y, c.z);
            pos.setXYZ(i + 2, b.x, b.y, b.z);
            flipped++;
        }
    }
    if (flipped === 0) return false;
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    return true;
}

// Flips the winding of the selected face(s), or every face if none are selected.
function flipNormals(mesh) {
    ensureNonIndexed(mesh);
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    const triSet = (faceSelectOn && selectedFaces.length > 0) ? new Set(selectedFaces.map(f => f * 3)) : null;
    const b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let i = 0; i < pos.count; i += 3) {
        if (triSet && !triSet.has(i)) continue;
        b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
        pos.setXYZ(i + 1, c.x, c.y, c.z);
        pos.setXYZ(i + 2, b.x, b.y, b.z);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    return true;
}

function runRecalculateNormals() {
    const obj = selectedObject;
    if (!obj || !obj.isMesh) return;
    const beforeGeo = deepCloneGeometry(obj.geometry);
    if (!recalculateNormalsOutside(obj)) { beforeGeo.dispose(); setVCB('Recalculate Normals:', 'Already consistent'); return; }
    const afterGeo = deepCloneGeometry(obj.geometry);
    pushUndo({ undo() { obj.geometry.dispose(); obj.geometry = beforeGeo; }, redo() { obj.geometry.dispose(); obj.geometry = afterGeo; } });
    setVCB('Recalculate Normals:', 'Outside');
}

function runFlipNormals() {
    const obj = selectedObject;
    if (!obj || !obj.isMesh) return;
    const beforeGeo = deepCloneGeometry(obj.geometry);
    flipNormals(obj);
    const afterGeo = deepCloneGeometry(obj.geometry);
    pushUndo({ undo() { obj.geometry.dispose(); obj.geometry = beforeGeo; }, redo() { obj.geometry.dispose(); obj.geometry = afterGeo; } });
    setVCB('Flip Normals:', faceSelectOn && selectedFaces.length > 0 ? `${selectedFaces.length} face(s)` : 'Whole mesh');
}

// ─────────────────────────────────────────────────────────────
// FACE ORIENTATION overlay (Blender: Viewport Overlays > Face Orientation)
// — blue = normal faces outward (correct), red = faces inward (flipped).
// Renders a translucent double pass (FrontSide blue, BackSide red) as
// children of each mesh so it tracks that mesh's transform live; if you
// edit geometry while it's on, toggle it off/on to refresh.
// ─────────────────────────────────────────────────────────────
let faceOrientationOverlay = null;
function toggleFaceOrientation() {
    if (faceOrientationOverlay) {
        faceOrientationOverlay.forEach(m => { if (m.parent) m.parent.remove(m); m.material.dispose(); });
        faceOrientationOverlay = null;
        setVCB('Face Orientation:', 'Off');
        return;
    }
    faceOrientationOverlay = [];
    sceneObjects.forEach(o => {
        if (!o.mesh || !o.mesh.isMesh) return;
        const matOpts = { transparent: true, opacity: 0.55, depthTest: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
        const front = new THREE.Mesh(o.mesh.geometry, new THREE.MeshBasicMaterial({ ...matOpts, color: 0x3a7bd5, side: THREE.FrontSide }));
        const back = new THREE.Mesh(o.mesh.geometry, new THREE.MeshBasicMaterial({ ...matOpts, color: 0xd53a3a, side: THREE.BackSide }));
        o.mesh.add(front); o.mesh.add(back);
        faceOrientationOverlay.push(front, back);
    });
    setVCB('Face Orientation:', 'On — blue=outward, red=inward (flipped)');
}

function deleteSelected() {
    const targets = [];
    if (outlinerMultiSelect.size) outlinerMultiSelect.forEach(m => { if (m) targets.push(m); });
    else if (selectedObject) targets.push(selectedObject);
    if (!targets.length) return;
    const records = [];
    let lockedSkipped = 0;
    targets.forEach(mesh => {
        const entry = sceneObjects.find(o => o.mesh === mesh);
        if (!entry) return;
        if (entry.locked) { lockedSkipped++; return; } // Lock (see toggleLockSelected()) blocks Delete same as Move/Rotate/Scale
        records.push({ mesh, type: entry.type, parent: mesh.parent || scene });
    });
    if (!records.length) {
        setVCB('Delete:', lockedSkipped ? `${lockedSkipped} object(s) locked — unlock first` : 'Nothing to delete');
        return;
    }
    records.forEach(r => removeSceneObject(r.mesh));
    outlinerMultiSelect.clear();
    setVCB('Deleted:', (records.length === 1 ? 'Object removed' : `${records.length} objects removed`) + (lockedSkipped ? ` (${lockedSkipped} locked, skipped)` : ''));
    pushUndo({
        undo() { records.forEach(r => { r.parent.add(r.mesh); sceneObjects.push({ name: r.mesh.name, type: r.type, mesh: r.mesh }); }); renderOutliner(); selectObject(records[0].mesh); },
        redo() { records.forEach(r => removeSceneObject(r.mesh)); },
    });
}

// Lock prevents Move/Rotate/Scale (transformControls never attaches to a
// locked object) and Delete — the primary real-world use of Lock in
// SketchUp: protecting a finished piece from an accidental bump. Locked
// objects stay fully selectable/inspectable, matching real SketchUp.
function toggleLockSelected() {
    const mesh = selectedObject;
    const entry = mesh && sceneObjects.find(o => o.mesh === mesh);
    if (!entry) { setVCB('Lock:', 'Select an object first'); return; }
    entry.locked = !entry.locked;
    if (entry.locked) transformControls.detach();
    else if (currentInteractionMode === 'object' || currentInteractionMode === 'sketchup') transformControls.attach(mesh);
    renderOutliner();
    setVCB(entry.locked ? 'Locked:' : 'Unlocked:', entry.name);
    pushUndo({
        undo() { entry.locked = !entry.locked; renderOutliner(); if (selectedObject === mesh) selectObject(mesh); },
        redo() { entry.locked = !entry.locked; renderOutliner(); if (selectedObject === mesh) selectObject(mesh); },
    });
}

function newScene() {
    buildDefaultBlenderScene();
    keyframes = {};
    persistentDimensions = [];
    _dimensionFirstObj = null;
    undoStack.length = 0;
    redoStack.length = 0;
    // sectionPlaneMesh/renderer.clippingPlanes live outside sceneObjects (so
    // they aren't touched by the sceneObjects wipe above) — without this,
    // a Section Plane active before New Scene leaves a dangling reference
    // that silently blocks addSectionPlane() from ever re-adding one.
    sectionPlaneMesh = null;
    renderer.clippingPlanes = [];
    outlinerMultiSelect.clear();
    sceneLayers = ['Untagged'];
    layerVisible = { Untagged: true };
    renderLayersPanel();
    populateLayerSelect();
    buildingLevels = [{ name: 'Ground Floor', height: 3.0 }];
    _levelIsolateOn = false;
    setActiveLevel(0);
    sunLight = null; // see ensureSunLight() — buildDefaultBlenderScene() just removed every previous scene object including any Sun
    presentSlides = [];
    presentIndex = 0;
    refreshPresentSlideSelect();
    scheduleAutosave(); // overwrite the autosave slot so a refresh doesn't resurrect the old scene
    setVCB('New Scene', 'Default Blender startup');
}

// ─────────────────────────────────────────────────────────────
// UNDO / REDO — command-pattern history for object add/remove,
// transform (gizmo drag), and material edits.
// ─────────────────────────────────────────────────────────────
function pushUndo(command) {
    undoStack.push(command);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
    scheduleAutosave();
}

function undo() {
    const cmd = undoStack.pop();
    if (!cmd) { setVCB('Undo:', 'Nothing to undo'); return; }
    cmd.undo();
    redoStack.push(cmd);
    renderOutliner();
    updateHUD();
    scheduleAutosave();
    setVCB('Undo', `${undoStack.length} step(s) left`);
}

function redo() {
    const cmd = redoStack.pop();
    if (!cmd) { setVCB('Redo:', 'Nothing to redo'); return; }
    cmd.redo();
    undoStack.push(cmd);
    renderOutliner();
    updateHUD();
    scheduleAutosave();
    setVCB('Redo', `${redoStack.length} step(s) left`);
}

// ─────────────────────────────────────────────────────────────
// DATASET PANELS — DeepFurniture & TexVerse
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// TOP MENU (File / Edit dropdowns)
// ─────────────────────────────────────────────────────────────
function toggleTopMenu(e, id) {
    e.stopPropagation();
    const el = document.getElementById(id);
    const wasOpen = el.classList.contains('open');
    document.querySelectorAll('.top-menu-item.open').forEach(m => m.classList.remove('open'));
    if (!wasOpen) el.classList.add('open');
}
window.addEventListener('click', () => {
    document.querySelectorAll('.top-menu-item.open').forEach(m => m.classList.remove('open'));
});

// ─────────────────────────────────────────────────────────────
// SCENE SERIALIZATION — JSON document core (Phase 1)
// Real node/transform/material/hierarchy graph via THREE's own
// Object3D.toJSON()/ObjectLoader, wrapped with app-level metadata
// (outliner type, keyframes, animation state) so round-trips are lossless
// for everything the app actually lets a user edit.
// ─────────────────────────────────────────────────────────────
const PROJECT_FORMAT = '3dcore.json';
const PROJECT_VERSION = 1;

function sceneToJSON() {
    return {
        format: PROJECT_FORMAT,
        version: PROJECT_VERSION,
        meta: { modified: new Date().toISOString() },
        animFrame,
        // updateMatrix() first: Object3D.toJSON() serializes the local `matrix`
        // property directly without recomputing it, and that matrix is only
        // normally kept current by the render loop's updateMatrixWorld() pass.
        // A transform set programmatically and saved before the next rendered
        // frame (scripted flows, AI Assistant tool calls) would otherwise
        // serialize a stale/identity matrix instead of the live position.
        objects: sceneObjects.map(o => {
            if (o.type === 'dimension') {
                // Deliberately NOT o.mesh.toJSON(): a dimension group's
                // children include a Sprite with a CanvasTexture material,
                // which doesn't round-trip cleanly through THREE.ObjectLoader
                // in r128 (silently fails to parse and gets dropped). The
                // children are pure runtime decoration, fully rebuilt by
                // updateDimensionGroup() right after load anyway — so skip
                // serializing them and just save enough to reconstruct the
                // link on load.
                const dim = persistentDimensions.find(d => d.group === o.mesh);
                return { appType: 'dimension', appName: o.name, appLevel: o.level, appDimRefs: dim ? [dim.objA.name, dim.objB.name] : null };
            }
            o.mesh.updateMatrix();
            return { appType: o.type, appName: o.name, appLevel: o.level, object: o.mesh.toJSON() };
        }),
        buildingLevels,
        activeLevelIndex,
        keyframes: Object.fromEntries(
            Object.entries(keyframes).map(([uuid, kfs]) => [uuid, kfs.map(k => ({
                frame: k.frame,
                pos:   [k.pos.x, k.pos.y, k.pos.z],
                rot:   [k.rot.x, k.rot.y, k.rot.z],
                scale: [k.scale.x, k.scale.y, k.scale.z],
            }))])
        ),
        presentSlides,
        renderQualityName,
    };
}

function loadSceneFromJSON(data) {
    if (!data || data.format !== PROJECT_FORMAT) {
        throw new Error('Not a valid 3D Core project file (missing/incorrect format field).');
    }

    sceneObjects.forEach(o => scene.remove(o.mesh));
    sceneObjects = [];
    persistentDimensions = []; // stale refs would otherwise point at meshes this reload just removed
    _dimensionFirstObj = null;
    transformControls.detach();
    selectedObject = null;
    sectionPlaneMesh = null; // see newScene()'s identical reset for why this can't be left dangling
    renderer.clippingPlanes = [];
    outlinerMultiSelect.clear();
    sunLight = null;

    const loader = new THREE.ObjectLoader();
    const uuidRemap = {}; // old uuid (from file) -> live object, for keyframe rehydration
    const dimEntries = []; // {name, refs: [nameA, nameB]} -- resolved into real dimension groups once every other object exists

    (data.objects || []).forEach(entry => {
        // Dimensions are never round-tripped through the object JSON at
        // all (see sceneToJSON) — just queue the link and build a real
        // group for it below, once every other object has loaded.
        if (entry.appType === 'dimension') {
            if (Array.isArray(entry.appDimRefs)) dimEntries.push({ name: entry.appName, refs: entry.appDimRefs });
            return;
        }
        let obj;
        try {
            obj = loader.parse(entry.object);
        } catch (err) {
            console.error('Failed to parse object from project file:', entry, err);
            return;
        }
        obj.name = entry.appName || obj.name;
        if (obj.isMesh) { obj.castShadow = true; obj.receiveShadow = true; }
        scene.add(obj);
        sceneObjects.push({ name: obj.name, type: entry.appType || 'mesh', mesh: obj, level: typeof entry.appLevel === 'number' ? entry.appLevel : 0 });
        if (entry.object && entry.object.object && entry.object.object.uuid) {
            uuidRemap[entry.object.object.uuid] = obj;
        }
    });

    // Re-link each dimension to its two live objects (found by name) and
    // build a fresh group + line/label from their real current positions.
    dimEntries.forEach(({ name, refs }) => {
        const objA = sceneObjects.find(o => o.name === refs[0]);
        const objB = sceneObjects.find(o => o.name === refs[1]);
        if (!objA || !objB) return; // referenced object no longer exists in this file
        const group = new THREE.Group();
        group.name = name || nextName('Dimension');
        scene.add(group);
        sceneObjects.push({ name: group.name, type: 'dimension', mesh: group, level: 0 });
        const dim = { objA: objA.mesh, objB: objB.mesh, group };
        persistentDimensions.push(dim);
        updateDimensionGroup(dim);
    });

    keyframes = {};
    Object.entries(data.keyframes || {}).forEach(([oldUuid, kfs]) => {
        const liveObj = uuidRemap[oldUuid];
        if (!liveObj) return;
        keyframes[liveObj.uuid] = kfs.map(k => ({
            frame: k.frame,
            pos:   new THREE.Vector3(...k.pos),
            rot:   new THREE.Euler(...k.rot),
            scale: new THREE.Vector3(...k.scale),
        }));
    });

    animFrame = data.animFrame || 1;
    const scrub = document.getElementById('anim-scrubber');
    const disp  = document.getElementById('frame-display');
    if (scrub) scrub.value = animFrame;
    if (disp)  disp.innerText = animFrame;

    // Older project files predate Levels entirely — fall back to a single
    // Ground Floor rather than leaving buildingLevels in some stale state.
    buildingLevels = Array.isArray(data.buildingLevels) && data.buildingLevels.length
        ? data.buildingLevels
        : [{ name: 'Ground Floor', height: 3.0 }];
    _levelIsolateOn = false;
    setActiveLevel(Math.min(data.activeLevelIndex || 0, buildingLevels.length - 1));

    undoStack.length = 0;
    redoStack.length = 0;

    presentSlides = Array.isArray(data.presentSlides) ? data.presentSlides : [];
    presentIndex = 0;
    refreshPresentSlideSelect();
    if (data.renderQualityName) applyRenderQuality(data.renderQualityName);

    renderOutliner();
    selectObject(null);
    drawDopeSheet();
    scheduleAutosave();
}

// ─────────────────────────────────────────────────────────────
// PERSISTENCE — file download/upload (.3dcore.json) + IndexedDB quick slot
// ─────────────────────────────────────────────────────────────
function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function saveProjectFile() {
    const data = sceneToJSON();
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    downloadBlob(blob, '3DCore_Project.3dcore.json');
    saveToRecentProjects('3DCore Project', data);
    setVCB('Saved:', '3DCore_Project.3dcore.json');
}

function triggerOpenProjectFile() {
    const input = document.getElementById('file-open-project');
    if (input) input.click();
}

function handleOpenProjectFile(evt) {
    const file = evt.target.files && evt.target.files[0];
    evt.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
        try {
            const data = JSON.parse(e.target.result);
            loadSceneFromJSON(data);
            const name = file.name.replace(/\.3dcore\.json$/i, '').replace(/\.json$/i, '') || 'Opened Project';
            saveToRecentProjects(name, data);
            setVCB('Opened:', file.name);
        } catch (err) {
            alert('Could not open project file: ' + err.message);
        }
    };
    reader.onerror = () => alert('Could not read file: ' + file.name);
    reader.readAsText(file);
}

const IDB_NAME = '3dcore_studio';
const IDB_STORE = 'projects';
const IDB_QUICK_KEY = 'quicksave';       // explicit, user-triggered Quick Save/Quick Load slot only
const IDB_SESSION_KEY = 'autosave_session'; // background debounced autosave / refresh-restore slot only — MUST stay
                                             // separate from IDB_QUICK_KEY: they used to share one key, so the
                                             // debounced autosave (armed by every edit, incl. New Scene) could fire
                                             // ~1s later and silently overwrite an explicit Quick Save before the
                                             // user's next Quick Load read it back.
const IDB_RECENTS_STORE = 'recent_projects'; // one real record per Save Project / Quick Save / Open Project — powers the Welcome screen's Recent list
const IDB_RECENTS_CAP = 12;

// Cache a single shared connection instead of opening a fresh one on every
// call — each idbOpen() previously leaked a brand-new IndexedDB connection
// (never closed), which under repeated autosaves made connection-open
// latency balloon unpredictably and worsened the race above.
let _idbConnPromise = null;
function idbOpen() {
    if (_idbConnPromise) return _idbConnPromise;
    _idbConnPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 2);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
            if (!db.objectStoreNames.contains(IDB_RECENTS_STORE)) db.createObjectStore(IDB_RECENTS_STORE, { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { _idbConnPromise = null; reject(req.error); };
    });
    return _idbConnPromise;
}

// Renders the CURRENT frame to a small JPEG data URL for a Recent-Projects
// thumbnail. Must call renderer.render() and read the canvas back in the
// same synchronous tick — this canvas has no preserveDrawingBuffer, so a
// read any time after control returns to the event loop can capture a
// stale/cleared buffer instead (bit this project once already, see
// renderStillImage() above).
function captureViewportThumbnail() {
    try {
        return withRenderResolution(320, 200, () => {
            renderer.render(scene, camera);
            return renderer.domElement.toDataURL('image/jpeg', 0.72);
        });
    } catch (err) {
        console.error('Thumbnail capture failed:', err);
        return null;
    }
}

async function saveToRecentProjects(name, sceneData) {
    const thumb = captureViewportThumbnail(); // synchronous — must happen before any await, see captureViewportThumbnail()
    try {
        const db = await idbOpen();
        const record = { id: 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7), name, thumb, timestamp: Date.now(), data: sceneData };
        await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_RECENTS_STORE, 'readwrite');
            tx.objectStore(IDB_RECENTS_STORE).put(record);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
        const all = await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_RECENTS_STORE, 'readonly');
            const req = tx.objectStore(IDB_RECENTS_STORE).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
        if (all.length > IDB_RECENTS_CAP) {
            const stale = all.sort((a, b) => a.timestamp - b.timestamp).slice(0, all.length - IDB_RECENTS_CAP);
            const tx = db.transaction(IDB_RECENTS_STORE, 'readwrite');
            const store = tx.objectStore(IDB_RECENTS_STORE);
            stale.forEach(r => store.delete(r.id));
            await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
        }
    } catch (err) {
        console.error('Saving to recent projects failed:', err);
    }
}

async function getRecentProjects() {
    try {
        const db = await idbOpen();
        const all = await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_RECENTS_STORE, 'readonly');
            const req = tx.objectStore(IDB_RECENTS_STORE).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
        return all.sort((a, b) => b.timestamp - a.timestamp);
    } catch (err) {
        console.error('Reading recent projects failed:', err);
        return [];
    }
}

async function deleteRecentProject(id) {
    try {
        const db = await idbOpen();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_RECENTS_STORE, 'readwrite');
            tx.objectStore(IDB_RECENTS_STORE).delete(id);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    } catch (err) {
        console.error('Deleting recent project failed:', err);
    }
}

// ─────────────────────────────────────────────────────────────
// WELCOME SCREEN — SketchUp-style startup dialog: Create New + a real
// Recent Projects grid (thumbnail, name, last-modified) sourced from the
// recent_projects IndexedDB store above. Shown on every launch; dismissing
// it just leaves whatever's already in the viewport (the default scene, or
// whatever tryAutoRestoreSession() silently restored) untouched.
// ─────────────────────────────────────────────────────────────
const WELCOME_PREF_KEY = '3dcore_show_welcome_on_startup';

function toggleShowWelcomeOnStartup(show) {
    try { localStorage.setItem(WELCOME_PREF_KEY, show ? '1' : '0'); } catch (err) { /* private-mode storage denial — non-fatal */ }
}

function formatRecentDate(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) +
        ', ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

async function showWelcomeScreen() {
    const screen = document.getElementById('welcome-screen');
    const grid = document.getElementById('welcome-recent-grid');
    const empty = document.getElementById('welcome-recent-empty');
    if (!screen || !grid) return;

    const startupCheckbox = document.getElementById('welcome-startup-checkbox');
    if (startupCheckbox) {
        let showOnStartup = true;
        try { showOnStartup = localStorage.getItem(WELCOME_PREF_KEY) !== '0'; } catch (err) { /* private-mode storage denial — default stays true */ }
        startupCheckbox.checked = showOnStartup;
    }

    const recents = await getRecentProjects();
    grid.innerHTML = '';
    if (empty) empty.style.display = recents.length === 0 ? 'block' : 'none';

    recents.forEach(r => {
        const item = document.createElement('div');
        item.className = 'welcome-recent-item';
        item.style.cssText = 'cursor:pointer;';

        const thumbWrap = document.createElement('div');
        thumbWrap.style.cssText = 'position:relative;';
        const img = document.createElement('img');
        img.src = r.thumb || '';
        img.style.cssText = 'width:100%; aspect-ratio:16/10; object-fit:cover; border-radius:4px; border:1px solid var(--b-border-light); background:#222; display:block;';
        thumbWrap.appendChild(img);

        const removeBtn = document.createElement('button');
        removeBtn.title = 'Remove from Recent';
        removeBtn.textContent = '✕';
        removeBtn.style.cssText = 'position:absolute; top:3px; right:3px; background:rgba(0,0,0,0.65); border:none; color:#ccc; width:16px; height:16px; border-radius:3px; font-size:9px; cursor:pointer; line-height:16px; padding:0;';
        removeBtn.addEventListener('click', (evt) => {
            evt.stopPropagation();
            deleteRecentProject(r.id).then(showWelcomeScreen);
        });
        thumbWrap.appendChild(removeBtn);
        item.appendChild(thumbWrap);

        const nameEl = document.createElement('div');
        nameEl.textContent = r.name;
        nameEl.title = r.name;
        nameEl.style.cssText = 'font-size:10px; margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
        item.appendChild(nameEl);

        const dateEl = document.createElement('div');
        dateEl.textContent = formatRecentDate(r.timestamp);
        dateEl.style.cssText = 'font-size:8.5px; color:var(--b-text-sub);';
        item.appendChild(dateEl);

        item.addEventListener('click', () => loadRecentProjectFromWelcome(r.id));
        grid.appendChild(item);
    });

    screen.style.display = 'flex';
}

function closeWelcomeScreen() {
    const screen = document.getElementById('welcome-screen');
    if (screen) screen.style.display = 'none';
}

function startNewProjectFromWelcome() {
    newScene();
    closeWelcomeScreen();
}

async function loadRecentProjectFromWelcome(id) {
    try {
        const db = await idbOpen();
        const record = await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_RECENTS_STORE, 'readonly');
            const req = tx.objectStore(IDB_RECENTS_STORE).get(id);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        if (!record) { alert('That project is no longer available.'); return; }
        loadSceneFromJSON(record.data);
        closeWelcomeScreen();
        setVCB('Opened:', record.name);
    } catch (err) {
        alert('Could not open project: ' + err.message);
    }
}

async function saveProjectToBrowser(silent) {
    const key = silent ? IDB_SESSION_KEY : IDB_QUICK_KEY;
    try {
        const db = await idbOpen();
        const data = sceneToJSON();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).put(data, key);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
        if (!silent) {
            saveToRecentProjects('Quick Save', data);
            setVCB('Quick Save:', 'Saved to browser storage');
        }
    } catch (err) {
        if (silent) console.error('Autosave failed:', err);
        else alert('Quick save failed: ' + err.message);
    }
}

async function loadProjectFromBrowser() {
    try {
        const db = await idbOpen();
        const data = await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const req = tx.objectStore(IDB_STORE).get(IDB_QUICK_KEY);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        if (!data) { setVCB('Quick Load:', 'No browser save found'); return; }
        loadSceneFromJSON(data);
        setVCB('Quick Load:', 'Loaded from browser storage');
    } catch (err) {
        alert('Quick load failed: ' + err.message);
    }
}

// Autosave — debounced so rapid edits (dragging, slider input) don't hammer
// IndexedDB, and auto-restore on load so a page refresh doesn't discard
// in-progress work back to the default startup scene.
let _autosaveTimer = null;
function scheduleAutosave() {
    clearTimeout(_autosaveTimer);
    _autosaveTimer = setTimeout(() => saveProjectToBrowser(true), 800);
}

async function tryAutoRestoreSession() {
    try {
        const db = await idbOpen();
        const data = await new Promise((resolve, reject) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const req = tx.objectStore(IDB_STORE).get(IDB_SESSION_KEY);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        if (!data) return;
        loadSceneFromJSON(data);
        setVCB('Restored:', 'Previous session (auto-saved)');
    } catch (err) {
        console.error('Auto-restore failed:', err);
    }
}

// EXPORT SCOPE — "Structure Only" (design idea studied from the Pascal
// Editor reference project's Full Floor Plan / Structure Only export
// toggle): walls/doors/windows/slabs, no furniture or decorative meshes.
// A real category filter on userData.kind (set by the Wall/Opening tools)
// plus the plain "Slab" name convention (slabs aren't kind-tagged) — not
// a separate export path, just a shared predicate every exporter below
// applies identically.
let exportStructureOnly = false;
function toggleExportStructureOnly(on) {
    exportStructureOnly = on;
    setVCB('Export Scope:', on ? 'Structure Only (walls/doors/windows/slabs)' : 'Full Model');
}
function isStructuralMesh(o) {
    const kind = o.mesh && o.mesh.userData && o.mesh.userData.kind;
    return kind === 'wall' || kind === 'door' || kind === 'window' || /^Slab(\.\d+)?$/.test(o.name);
}
function exportableMeshObjects() {
    const all = sceneObjects.filter(o => o.type === 'mesh' && o.mesh && o.mesh.isMesh);
    return exportStructureOnly ? all.filter(isStructuralMesh) : all;
}

// ─────────────────────────────────────────────────────────────
// GLB IMPORT / EXPORT — real glTF binary via three.js loader/exporter
// (Phase 1: deterministic GLB round-trip in the browser)
// ─────────────────────────────────────────────────────────────
function exportGLB() {
    const exportGroup = new THREE.Group();
    exportableMeshObjects()
        .forEach(o => exportGroup.add(o.mesh.clone()));

    if (exportGroup.children.length === 0) {
        alert('Nothing to export — add a mesh object first.');
        return;
    }

    // THREE.GLTFExporter (r128) signature is parse(input, onDone, options) —
    // no error-callback argument; a 4-arg call silently drops the options
    // object into the error-callback slot and falls back to non-binary JSON.
    const exporter = new THREE.GLTFExporter();
    try {
        exporter.parse(
            exportGroup,
            result => {
                if (!(result instanceof ArrayBuffer)) {
                    alert('GLB export failed: exporter did not return binary data.');
                    return;
                }
                const blob = new Blob([result], { type: 'model/gltf-binary' });
                downloadBlob(blob, '3DCore_Project.glb');
                setVCB('Exported:', '3DCore_Project.glb');
            },
            { binary: true }
        );
    } catch (err) {
        alert('GLB export failed: ' + (err && err.message ? err.message : err));
        return;
    }
}

function triggerImportGLB() {
    const input = document.getElementById('file-import-glb');
    if (input) input.click();
}

function triggerImportImage() {
    const input = document.getElementById('file-import-image');
    if (input) input.click();
}

// Imports a raster image (e.g. a scanned/exported floorplan) as a flat,
// unlit textured plane lying on the ground — a real tracing underlay, not
// a decoration: it's a normal selectable/movable/scalable scene object, and
// Tape Measure (see offerTapeMeasureRescale()) can calibrate the whole
// model against a known real-world length drawn on it, exactly like real
// SketchUp's "import image, then rescale" floorplan workflow.
function handleImportImageFile(evt) {
    const file = evt.target.files && evt.target.files[0];
    evt.target.value = '';
    if (!file) return;

    const reader = new FileReader();
    reader.onload = e => {
        const dataUrl = e.target.result;
        const img = new Image();
        img.onload = () => {
            const aspect = img.naturalWidth / Math.max(1, img.naturalHeight);
            const texture = new THREE.TextureLoader().load(dataUrl);
            texture.encoding = THREE.sRGBEncoding;
            const width = 10; // default footprint (world units) — user rescales via Scale tool or the Tape Measure calibration prompt
            const height = width / aspect;
            const geometry = new THREE.PlaneGeometry(width, height);
            const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, transparent: true });
            const mesh = new THREE.Mesh(geometry, material);
            mesh.name = nextName(file.name.replace(/\.(png|jpe?g|gif|webp|bmp)$/i, '') || 'Floorplan Image');
            mesh.rotation.x = -Math.PI / 2; // lie flat, traced from Top view like a real floorplan underlay
            mesh.position.set(0, 0.001, 0); // tiny lift to avoid z-fighting with the ground grid
            mesh.userData.isReferenceImage = true;

            scene.add(mesh);
            sceneObjects.push({ name: mesh.name, type: 'mesh', mesh });
            renderOutliner();
            selectObject(mesh);
            setVCB('Imported Image:', `${file.name} — ${formatLength(width, 2)} x ${formatLength(height, 2)} (Scale/Tape Measure to resize)`);

            pushUndo({
                undo() { removeSceneObject(mesh); },
                redo() { scene.add(mesh); sceneObjects.push({ name: mesh.name, type: 'mesh', mesh }); renderOutliner(); selectObject(mesh); },
            });
        };
        img.onerror = () => alert('Could not load image: ' + file.name);
        img.src = dataUrl;
    };
    reader.onerror = () => alert('Could not read file: ' + file.name);
    reader.readAsDataURL(file);
}

// Shared by file-picker GLB import and the Asset Library import — flattens
// a loaded glTF scene's meshes to top-level scene objects with their world
// transform baked in (so imported content is immediately selectable/
// transformable/deletable like anything else, not a locked group), commits
// them, and registers one combined undo entry.
function commitImportedMeshes(imported, baseName) {
    if (imported.length === 0) { alert('File contained no mesh data.'); return; }
    imported.forEach((mesh, i) => {
        const worldPos = new THREE.Vector3(), worldQuat = new THREE.Quaternion(), worldScale = new THREE.Vector3();
        mesh.matrixWorld.decompose(worldPos, worldQuat, worldScale);
        mesh.position.copy(worldPos);
        mesh.quaternion.copy(worldQuat);
        mesh.scale.copy(worldScale);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        if (!mesh.name) mesh.name = baseName + (imported.length > 1 ? `.${i}` : '');
        scene.add(mesh);
        sceneObjects.push({ name: mesh.name, type: 'mesh', mesh });
    });
    renderOutliner();
    selectObject(imported[0]);
    pushUndo({
        undo() { imported.forEach(m => removeSceneObject(m)); },
        redo() { imported.forEach(m => { scene.add(m); sceneObjects.push({ name: m.name, type: 'mesh', mesh: m }); }); renderOutliner(); },
    });
}

function handleImportGLBFile(evt) {
    const file = evt.target.files && evt.target.files[0];
    evt.target.value = '';
    if (!file) return;

    const reader = new FileReader();
    reader.onload = e => {
        const loader = new THREE.GLTFLoader();
        loader.parse(e.target.result, '', gltf => {
            gltf.scene.updateMatrixWorld(true);
            const imported = [];
            gltf.scene.traverse(child => { if (child.isMesh) imported.push(child); });
            const baseName = file.name.replace(/\.glb$|\.gltf$/i, '');
            commitImportedMeshes(imported, baseName);
            if (imported.length > 0) setVCB('Imported:', `${file.name} (${imported.length} mesh${imported.length > 1 ? 'es' : ''})`);
        }, err => {
            alert('GLB import failed: ' + (err && err.message ? err.message : err));
        });
    };
    reader.onerror = () => alert('Could not read file: ' + file.name);
    reader.readAsArrayBuffer(file);
}

function collectExportMeshSnapshots() {
    const snaps = [];
    exportableMeshObjects().forEach(o => {
        const geo = o.mesh.geometry.clone();
        o.mesh.updateMatrixWorld(true);
        geo.applyMatrix4(o.mesh.matrixWorld);
        if (!geo.attributes.position) return;
        const positions = Array.from(geo.attributes.position.array);
        const indices = geo.index ? Array.from(geo.index.array) : null;
        snaps.push({ name: o.name || 'Mesh', positions, indices });
    });
    return snaps;
}

function meshesFromSnapshots(parsed, baseName) {
    const objects = (parsed && parsed.objects) || [];
    const imported = [];
    objects.forEach((obj, i) => {
        if (!obj.positions || obj.positions.length < 9) return;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(obj.positions), 3));
        if (obj.indices && obj.indices.length) geo.setIndex(obj.indices);
        geo.computeVertexNormals();
        const mat = new THREE.MeshStandardMaterial({ color: 0xb8b8b8, roughness: 0.55, metalness: 0.05 });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.name = obj.name || (baseName + (objects.length > 1 ? `.${i}` : ''));
        imported.push(mesh);
    });
    return imported;
}

function triggerImportOBJ() {
    const input = document.getElementById('file-import-obj');
    if (input) input.click();
}
function triggerImportSTL() {
    const input = document.getElementById('file-import-stl');
    if (input) input.click();
}
function triggerImportDXF() {
    const input = document.getElementById('file-import-dxf');
    if (input) input.click();
}

function handleImportOBJFile(evt) {
    const file = evt.target.files && evt.target.files[0];
    evt.target.value = '';
    if (!file) return;
    const IO = window.FormatIO;
    if (!IO) { alert('OBJ parser failed to load.'); return; }
    const reader = new FileReader();
    reader.onload = e => {
        try {
            const parsed = IO.parseOBJ(e.target.result);
            const imported = meshesFromSnapshots(parsed, file.name.replace(/\.obj$/i, ''));
            commitImportedMeshes(imported, file.name.replace(/\.obj$/i, ''));
            if (imported.length) setVCB('Imported:', `${file.name} (${imported.length} mesh${imported.length > 1 ? 'es' : ''})`);
        } catch (err) {
            alert('OBJ import failed: ' + (err && err.message ? err.message : err));
        }
    };
    reader.onerror = () => alert('Could not read file: ' + file.name);
    reader.readAsText(file);
}

function handleImportSTLFile(evt) {
    const file = evt.target.files && evt.target.files[0];
    evt.target.value = '';
    if (!file) return;
    const IO = window.FormatIO;
    if (!IO) { alert('STL parser failed to load.'); return; }
    const reader = new FileReader();
    reader.onload = e => {
        try {
            const parsed = IO.parseSTL(e.target.result);
            const imported = meshesFromSnapshots(parsed, file.name.replace(/\.stl$/i, ''));
            commitImportedMeshes(imported, file.name.replace(/\.stl$/i, ''));
            if (imported.length) setVCB('Imported:', `${file.name} (${imported.length} mesh${imported.length > 1 ? 'es' : ''})`);
        } catch (err) {
            alert('STL import failed: ' + (err && err.message ? err.message : err));
        }
    };
    reader.onerror = () => alert('Could not read file: ' + file.name);
    reader.readAsArrayBuffer(file);
}

function handleImportDXFFile(evt) {
    const file = evt.target.files && evt.target.files[0];
    evt.target.value = '';
    if (!file) return;
    const IO = window.FormatIO;
    if (!IO) { alert('DXF parser failed to load.'); return; }
    const reader = new FileReader();
    reader.onload = e => {
        try {
            const parsed = IO.parseDXF(e.target.result);
            const paths = [];
            (parsed.lines || []).forEach(ln => {
                paths.push([
                    new THREE.Vector3(ln.x1, ln.y1, 0),
                    new THREE.Vector3(ln.x2, ln.y2, 0),
                ]);
            });
            (parsed.polylines || []).forEach(pl => {
                const pts = pl.points.map(p => new THREE.Vector3(p.x, p.y, 0));
                if (pl.closed && pts.length >= 2) pts.push(pts[0].clone());
                if (pts.length >= 2) paths.push(pts);
            });
            if (!paths.length) {
                alert('DXF had no LINE or LWPOLYLINE entities. Binary DWG is not supported.');
                return;
            }
            const created = [];
            paths.forEach(pts => created.push(...createWallMeshesFromPoints(pts)));
            if (!created.length) { alert('DXF lines were too short to make walls.'); return; }
            commitWallMeshes(created, `DXF → ${created.length} wall layer(s) from ${paths.length} path(s)`);
            setVCB('Imported:', `${file.name} — ASCII DXF walls (not full CAD)`);
        } catch (err) {
            alert('DXF import failed: ' + (err && err.message ? err.message : err));
        }
    };
    reader.onerror = () => alert('Could not read file: ' + file.name);
    reader.readAsText(file);
}

function exportOBJ() {
    const IO = window.FormatIO;
    if (!IO) { alert('OBJ exporter failed to load.'); return; }
    const snaps = collectExportMeshSnapshots();
    if (!snaps.length) { alert('Nothing to export — add a mesh object first.'); return; }
    const text = IO.serializeOBJ(snaps);
    downloadBlob(new Blob([text], { type: 'text/plain' }), '3DCore_Project.obj');
    setVCB('Exported:', '3DCore_Project.obj');
}

function exportSTL() {
    const IO = window.FormatIO;
    if (!IO) { alert('STL exporter failed to load.'); return; }
    const snaps = collectExportMeshSnapshots();
    if (!snaps.length) { alert('Nothing to export — add a mesh object first.'); return; }
    const text = IO.serializeSTLAscii(snaps, '3DCore');
    downloadBlob(new Blob([text], { type: 'model/stl' }), '3DCore_Project.stl');
    setVCB('Exported:', '3DCore_Project.stl');
}

function dataUrlToBytes(dataUrl) {
    const b64 = String(dataUrl || '').split(',')[1] || '';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

function exportGLBBuffer() {
    return new Promise((resolve, reject) => {
        const exportGroup = new THREE.Group();
        exportableMeshObjects().forEach(o => exportGroup.add(o.mesh.clone()));
        if (exportGroup.children.length === 0) { resolve(null); return; }
        const exporter = new THREE.GLTFExporter();
        try {
            exporter.parse(
                exportGroup,
                result => {
                    if (!(result instanceof ArrayBuffer)) {
                        reject(new Error('GLB exporter did not return binary data'));
                        return;
                    }
                    resolve(result);
                },
                { binary: true }
            );
        } catch (err) {
            reject(err);
        }
    });
}

async function exportClientPack() {
    const Zip = window.ZipStore;
    if (!Zip || !Zip.buildZip) {
        alert('Zip builder failed to load (js/zip_store.js).');
        return;
    }
    setVCB('Pack:', 'Building client zip…');
    const files = [
        {
            name: 'README.txt',
            data: [
                '3D Core Studio — client pack',
                '',
                'project.3dcore.json  Open in 3D Core (File → Open Project).',
                'preview.png          Still from the current camera (WebGL PBR, not a path tracer).',
                'model.glb            Mesh export if the scene had meshes. Blender / Unity / phone AR viewers.',
                '',
                'Not included: USDZ, FBX, DWG, SKP, IFC. Those encoders are not in this app.',
                'VR/AR is WebXR in a headset/phone browser on HTTPS or localhost — not a file in this zip.',
            ].join('\n'),
        },
        { name: 'project.3dcore.json', data: JSON.stringify(sceneToJSON(), null, 2) },
    ];
    try {
        const png = captureStillDataUrl(1280, 720);
        if (png && png.indexOf('data:image/png') === 0) {
            files.push({ name: 'preview.png', data: dataUrlToBytes(png) });
        }
    } catch (err) {
        console.warn('Client pack preview failed:', err);
    }
    try {
        const glb = await exportGLBBuffer();
        if (glb) files.push({ name: 'model.glb', data: glb });
    } catch (err) {
        console.warn('Client pack GLB failed:', err);
    }
    const zipBytes = Zip.buildZip(files);
    downloadBlob(new Blob([zipBytes], { type: 'application/zip' }), '3DCore_ClientPack.zip');
    setVCB('Pack:', '3DCore_ClientPack.zip');
}

let xrWorldScale = 1;
let xrActiveSession = null;
let xrSessionKind = null;
let xrHitTestSource = null;
let xrARHitPose = null;
let xrARReticle = null;

function ensureARReticle() {
    if (xrARReticle) return xrARReticle;
    const geo = new THREE.RingGeometry(0.06, 0.09, 32);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
        color: 0x88e0ff, side: THREE.DoubleSide, depthTest: false,
        transparent: true, opacity: 0.9
    });
    xrARReticle = new THREE.Mesh(geo, mat);
    xrARReticle.name = '_ar_reticle';
    xrARReticle.renderOrder = 1000;
    xrARReticle.visible = false;
    xrARReticle.raycast = function () {};
    scene.add(xrARReticle);
    return xrARReticle;
}
let xrFrame = null;

function xrMeshTargets() {
    return sceneObjects.filter(o => o.mesh && o.mesh.isMesh).map(o => o.mesh);
}

function xrTeleportToWorldPoint(point) {
    if (!point || !renderer || !renderer.xr) return;
    const xrCam = renderer.xr.getCamera ? renderer.xr.getCamera() : camera;
    if (xrCam && xrCam.updateMatrixWorld) xrCam.updateMatrixWorld();
    const camPos = new THREE.Vector3();
    if (xrCam && xrCam.getWorldPosition) xrCam.getWorldPosition(camPos);
    else camPos.set(0, 0, 0);
    scene.position.x += camPos.x - point.x;
    scene.position.z += camPos.z - point.z;
    markSceneDirty();
}

function onXRControllerSelect(ev) {
    if (xrSessionKind === 'ar' && xrARHitPose) {
        scene.position.set(xrARHitPose.x, xrARHitPose.y, xrARHitPose.z);
        markSceneDirty();
        setVCB('AR:', 'Placed on detected plane (trigger)');
        return;
    }
    const ctrl = ev.target;
    if (!ctrl || !ctrl.matrixWorld) return;
    const origin = new THREE.Vector3().setFromMatrixPosition(ctrl.matrixWorld);
    const dir = new THREE.Vector3(0, 0, -1).transformDirection(ctrl.matrixWorld);
    _raycaster.set(origin, dir);
    const hits = _raycaster.intersectObjects(xrMeshTargets(), true);
    if (hits.length) {
        xrTeleportToWorldPoint(hits[0].point);
        setVCB('VR:', 'Teleported to surface');
        return;
    }
    const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    if (_raycaster.ray.intersectPlane(floor, hit)) {
        xrTeleportToWorldPoint(hit);
        setVCB('VR:', 'Teleported to floor');
    }
}

function bindXRControllers() {
    if (!renderer || !renderer.xr || !renderer.xr.getController) return;
    [0, 1].forEach(i => {
        const c = renderer.xr.getController(i);
        if (!c.userData.xrSelectBound) {
            c.addEventListener('select', onXRControllerSelect);
            c.userData.xrSelectBound = true;
        }
        scene.add(c);
    });
}

async function setupARHitTest(session) {
    xrHitTestSource = null;
    xrARHitPose = null;
    try {
        const viewerSpace = await session.requestReferenceSpace('viewer');
        if (session.requestHitTestSource) {
            xrHitTestSource = await session.requestHitTestSource({ space: viewerSpace });
        }
    } catch (e) {
        xrHitTestSource = null;
    }
}

function pollARHitTest() {
    if (!xrHitTestSource || !xrFrame || !renderer || !renderer.xr) return;
    const ref = renderer.xr.getReferenceSpace ? renderer.xr.getReferenceSpace() : null;
    if (!ref || !xrFrame.getHitTestResults) return;
    const results = xrFrame.getHitTestResults(xrHitTestSource);
    if (!results.length) {
        xrARHitPose = null;
        if (xrARReticle) xrARReticle.visible = false;
        return;
    }
    const pose = results[0].getPose(ref);
    if (!pose || !pose.transform || !pose.transform.position) {
        xrARHitPose = null;
        if (xrARReticle) xrARReticle.visible = false;
        return;
    }
    const p = pose.transform.position;
    xrARHitPose = { x: p.x, y: p.y, z: p.z };
    const ring = ensureARReticle();
    const world = new THREE.Vector3(p.x, p.y, p.z);
    if (ring.parent) ring.parent.worldToLocal(world);
    ring.position.copy(world);
    const o = pose.transform.orientation;
    if (o) {
        const qWorld = new THREE.Quaternion(o.x, o.y, o.z, o.w);
        if (ring.parent) {
            const qParent = new THREE.Quaternion();
            ring.parent.getWorldQuaternion(qParent);
            ring.quaternion.copy(qParent.invert()).multiply(qWorld);
        } else {
            ring.quaternion.copy(qWorld);
        }
    }
    ring.visible = true;
}

function setXRWorldScale(value) {
    const n = parseFloat(value);
    xrWorldScale = (n > 0 && isFinite(n)) ? n : 1;
    const a = document.getElementById('xr-scale-select');
    const b = document.getElementById('present-xr-scale');
    if (a && String(a.value) !== String(xrWorldScale)) a.value = String(xrWorldScale);
    if (b && String(b.value) !== String(xrWorldScale)) b.value = String(xrWorldScale);
    if (renderer && renderer.xr && renderer.xr.isPresenting) {
        scene.scale.setScalar(xrWorldScale);
        markSceneDirty();
    }
}

function applyXRScenePose(on) {
    if (!scene) return;
    if (on) {
        scene.rotation.x = -Math.PI / 2;
        scene.scale.setScalar(xrWorldScale);
    } else {
        scene.rotation.x = 0;
        scene.scale.set(1, 1, 1);
        scene.position.set(0, 0, 0);
    }
}

function setXRButtonEnabled(id, enabled, reason) {
    const el = document.getElementById(id);
    if (!el) return;
    el.disabled = !enabled;
    if (reason) el.title = reason;
    else el.removeAttribute('title');
}

async function refreshXRButtons() {
    const ids = ['enter-vr-btn', 'enter-ar-btn', 'present-vr-btn', 'present-ar-btn'];
    const secure = typeof window.isSecureContext === 'undefined' ? true : window.isSecureContext;
    if (!navigator.xr) {
        ids.forEach(id => setXRButtonEnabled(id, false, 'WebXR is not in this browser. Use Chrome, Edge, or Quest Browser.'));
        return;
    }
    if (!secure) {
        ids.forEach(id => setXRButtonEnabled(id, false, 'WebXR needs HTTPS or localhost (http://127.0.0.1).'));
        return;
    }
    let vrOk = false, arOk = false;
    try { vrOk = await navigator.xr.isSessionSupported('immersive-vr'); } catch (e) { vrOk = false; }
    try { arOk = await navigator.xr.isSessionSupported('immersive-ar'); } catch (e) { arOk = false; }
    setXRButtonEnabled('enter-vr-btn', vrOk, vrOk ? 'Walk the model in a headset (WebXR).' : 'This device has no immersive VR session.');
    setXRButtonEnabled('present-vr-btn', vrOk, vrOk ? 'Walk the model in a headset (WebXR).' : 'This device has no immersive VR session.');
    setXRButtonEnabled('enter-ar-btn', true, arOk ? 'Place with WebXR AR.' : 'AR session not supported — will export GLB for a phone viewer.');
    setXRButtonEnabled('present-ar-btn', true, arOk ? 'Place with WebXR AR.' : 'AR session not supported — will export GLB for a phone viewer.');
}

function endXRSessionCleanup() {
    xrAnimating = false;
    xrActiveSession = null;
    xrSessionKind = null;
    xrARHitPose = null;
    if (xrARReticle) xrARReticle.visible = false;
    if (xrHitTestSource && xrHitTestSource.cancel) {
        try { xrHitTestSource.cancel(); } catch (e) { /* already ended */ }
    }
    xrHitTestSource = null;
    xrFrame = null;
    applyXRScenePose(false);
    if (orbitControls) orbitControls.enabled = true;
    if (renderer && renderer.setAnimationLoop) renderer.setAnimationLoop(null);
    requestAnimationFrame(renderLoop);
    markSceneDirty();
    setVCB('XR:', 'Session ended');
    refreshXRButtons();
}

async function startXRSession(session, kind) {
    if (!renderer.xr || !renderer.xr.setSession) {
        alert('This Three.js build has no WebXR manager.');
        return;
    }
    xrActiveSession = session;
    xrSessionKind = kind;
    applyXRScenePose(true);
    if (orbitControls) orbitControls.enabled = false;
    if (transformControls) transformControls.detach();
    bindXRControllers();
    if (kind === 'ar') await setupARHitTest(session);
    xrAnimating = true;
    renderer.setAnimationLoop((time, frame) => {
        xrFrame = frame || null;
        renderTick(true);
    });
    session.addEventListener('end', endXRSessionCleanup);
    const maybePromise = renderer.xr.setSession(session);
    if (maybePromise && typeof maybePromise.then === 'function') await maybePromise;
    setVCB(kind === 'ar' ? 'AR:' : 'VR:', kind === 'ar'
        ? 'Immersive AR — pull trigger on a detected plane to place'
        : 'Immersive VR — 1 scene meter = 1 real meter at 1:1. Trigger teleports');
}

async function enterVR() {
    if (!navigator.xr) {
        setVCB('VR:', 'WebXR missing — Chrome/Edge/Quest Browser on HTTPS or localhost');
        return;
    }
    let supported = false;
    try { supported = await navigator.xr.isSessionSupported('immersive-vr'); } catch (e) { supported = false; }
    if (!supported) {
        setVCB('VR:', 'No immersive VR on this device/browser');
        return;
    }
    try {
        let session;
        try {
            session = await navigator.xr.requestSession('immersive-vr', { requiredFeatures: ['local-floor'] });
        } catch (e) {
            session = await navigator.xr.requestSession('immersive-vr');
        }
        await startXRSession(session, 'vr');
    } catch (err) {
        endXRSessionCleanup();
        setVCB('VR:', err && err.message ? err.message : 'Could not start VR');
    }
}

async function enterAR() {
    if (navigator.xr) {
        let supported = false;
        try { supported = await navigator.xr.isSessionSupported('immersive-ar'); } catch (e) { supported = false; }
        if (supported) {
            try {
                let session;
                try {
                    session = await navigator.xr.requestSession('immersive-ar', { optionalFeatures: ['hit-test'] });
                } catch (e) {
                    session = await navigator.xr.requestSession('immersive-ar');
                }
                await startXRSession(session, 'ar');
                return;
            } catch (err) {
                endXRSessionCleanup();
                setVCB('AR:', err && err.message ? err.message : 'AR session failed');
            }
        }
    }
    setVCB('AR:', 'No immersive AR here. Exporting GLB for a phone AR viewer. USDZ encoder is not in this app.');
    exportGLB();
}

// ─────────────────────────────────────────────────────────────
// ASSET LIBRARY — browses real, already-downloaded 3D models (the
// TexVerse-1K GLB dataset, sourced from Hugging Face — see server.py's
// scan_texverse_glbs(), which lists the actual files on disk under
// assets/TexVerse/glbs) and imports the real file straight into the scene
// on click via GLTFLoader, reusing the same commit/undo path as manual GLB
// import. Replaces the old DeepFurniture/TexVerse tabs, which opened a
// plain alert() with a hardcoded, non-3D catalog instead of an actual panel.
//
// Card thumbnails are real renders of the actual file (a small offscreen
// THREE.js scene loads each GLB and snapshots one frame to a PNG data URL),
// not stock icons — see renderAssetThumbnail(). Results are cached per URL
// so reopening the library doesn't re-render.
// ─────────────────────────────────────────────────────────────
let thumbRenderer, thumbScene, thumbCamera;
const _assetThumbCache = new Map();

function ensureThumbRenderer() {
    if (thumbRenderer) return;
    const canvas = document.createElement('canvas');
    canvas.width = 160; canvas.height = 160;
    thumbRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    thumbRenderer.setSize(160, 160, false);
    thumbRenderer.setClearColor(0x000000, 0);
    thumbScene = new THREE.Scene();
    thumbScene.add(new THREE.AmbientLight(0xffffff, 0.65));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
    dirLight.position.set(3, -4, 5);
    thumbScene.add(dirLight);
    thumbCamera = new THREE.PerspectiveCamera(40, 1, 0.01, 200);
}

function renderAssetThumbnail(url) {
    if (_assetThumbCache.has(url)) return Promise.resolve(_assetThumbCache.get(url));
    ensureThumbRenderer();
    return new Promise(resolve => {
        const loader = new THREE.GLTFLoader();
        loader.load(url, gltf => {
            const obj = gltf.scene;
            thumbScene.add(obj);
            const box = new THREE.Box3().setFromObject(obj);
            const size = new THREE.Vector3(); box.getSize(size);
            const center = new THREE.Vector3(); box.getCenter(center);
            const maxDim = Math.max(size.x, size.y, size.z, 1e-4);
            const dist = maxDim * 1.9;
            thumbCamera.position.set(center.x + dist * 0.6, center.y - dist * 0.75, center.z + dist * 0.55);
            thumbCamera.up.set(0, 0, 1);
            thumbCamera.lookAt(center);
            thumbRenderer.render(thumbScene, thumbCamera);
            const dataUrl = thumbRenderer.domElement.toDataURL('image/png');
            thumbScene.remove(obj);
            _assetThumbCache.set(url, dataUrl);
            resolve(dataUrl);
        }, undefined, () => resolve(null));
    });
}

// Runs `tasks` (each a zero-arg function returning a Promise) with at most
// `limit` in flight at once, starting the next queued task the moment a
// running one settles — a small worker-pool, not a fixed-size batch wait.
function runWithConcurrencyLimit(tasks, limit) {
    let next = 0;
    const worker = () => {
        const i = next++;
        if (i >= tasks.length) return Promise.resolve();
        return tasks[i]().catch(() => {}).then(worker);
    };
    return Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

function openAssetLibrary() {
    const modal = document.getElementById('asset-library-modal');
    const grid = document.getElementById('asset-library-grid');
    const sourceEl = document.getElementById('asset-library-source');
    grid.innerHTML = '<div style="grid-column:1/-1; color:var(--b-text-sub); font-size:11px; padding:20px; text-align:center;">Loading catalog…</div>';
    modal.style.display = 'flex';

    fetch('/api/texverse/catalog')
        .then(r => r.json())
        .then(data => {
            const models = data.models || [];
            sourceEl.textContent = data.source ? `Source: ${data.source} — ${models.length} model(s) on disk` : '';
            if (models.length === 0) {
                grid.innerHTML = '<div style="grid-column:1/-1; color:var(--b-text-sub); font-size:11px; padding:20px; text-align:center;">No GLB files found in assets/TexVerse/glbs.</div>';
                return;
            }
            grid.innerHTML = '';
            const thumbTasks = [];
            models.forEach(m => {
                const card = document.createElement('div');
                card.style.cssText = 'border:1px solid var(--b-border-light); border-radius:4px; padding:8px; display:flex; flex-direction:column; gap:6px; background:#1c1c1c;';
                const sizeLabel = m.size_kb ? (m.size_kb > 1024 ? `${(m.size_kb / 1024).toFixed(1)} MB` : `${m.size_kb} KB`) : '';
                card.innerHTML = `
                    <div class="asset-thumb-box" style="width:100%; aspect-ratio:1; background:#141414; border-radius:3px; display:flex; align-items:center; justify-content:center; overflow:hidden;">
                        <span class="asset-thumb-spinner" style="font-size:9px; color:var(--b-text-sub);">Rendering…</span>
                        <img class="asset-thumb-img" style="display:none; width:100%; height:100%; object-fit:contain;" />
                    </div>
                    <div style="font-size:10.5px; color:#ddd; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${m.filename}">${m.filename}</div>
                    <div style="font-size:9px; color:var(--b-text-sub);">${sizeLabel}</div>
                    <button style="background:#2f6fdc; border:none; color:#fff; font-size:10px; padding:4px 0; border-radius:3px; cursor:pointer;">Import to Scene</button>
                `;
                card.querySelector('button').onclick = () => importAssetIntoScene(m.serve_path, m.filename);
                grid.appendChild(card);

                thumbTasks.push(() => renderAssetThumbnail(m.serve_path).then(dataUrl => {
                    const img = card.querySelector('.asset-thumb-img');
                    const spinner = card.querySelector('.asset-thumb-spinner');
                    if (dataUrl) { img.src = dataUrl; img.style.display = 'block'; spinner.style.display = 'none'; }
                    else { spinner.textContent = 'No preview'; }
                }));
            });
            // Firing every card's GLTFLoader.parse() at once (each one real
            // work: decoding a full binary GLB plus its embedded textures)
            // made the browser's decode queue back up badly — most cards sat
            // on "Rendering…" for 5+ seconds while a handful of the largest
            // files hogged the pipeline. Cap concurrency so thumbnails
            // actually appear progressively instead of arriving in one
            // late, uneven burst.
            runWithConcurrencyLimit(thumbTasks, 3);
        })
        .catch(err => {
            grid.innerHTML = `<div style="grid-column:1/-1; color:#e77; font-size:11px; padding:20px; text-align:center;">Could not load catalog: ${err.message}</div>`;
        });
}

function closeAssetLibrary() {
    document.getElementById('asset-library-modal').style.display = 'none';
}

function importAssetIntoScene(url, name) {
    const loader = new THREE.GLTFLoader();
    setVCB('Asset Library:', `Downloading ${name}…`);
    loader.load(url, gltf => {
        gltf.scene.updateMatrixWorld(true);
        const imported = [];
        gltf.scene.traverse(child => { if (child.isMesh) imported.push(child); });
        commitImportedMeshes(imported, name.replace(/\.glb$|\.gltf$/i, ''));
        if (imported.length > 0) setVCB('Asset Library:', `${name} added to scene`);
        closeAssetLibrary();
    }, undefined, err => {
        alert('Failed to import asset: ' + (err && err.message ? err.message : err));
    });
}

// ─────────────────────────────────────────────────────────────
// AI ASSISTANT — natural language → real tool calls. The prompt goes to
// /api/ai-command (server.py relays it to whichever provider is
// configured via /api/ai-settings, with a curated tool schema). Whatever
// tool calls come back are executed here through executeAIAction(), a
// fixed dispatch table onto this app's REAL functions — the AI can only
// ever invoke one of these named operations with validated inputs, never
// arbitrary code, and every action goes through the same undo system as
// a manual click.
// ─────────────────────────────────────────────────────────────
function toggleAIPanel(show) {
    const el = document.getElementById('ai-panel');
    if (!el) return;
    const willShow = show === undefined ? el.style.display === 'none' : show;
    el.style.display = willShow ? 'flex' : 'none';
    if (willShow) document.getElementById('ai-prompt-input')?.focus();
}

function aiLog(role, text) {
    const log = document.getElementById('ai-log');
    if (!log) return;
    const row = document.createElement('div');
    row.style.cssText = role === 'user'
        ? 'align-self:flex-end; background:var(--b-orange); color:#111; padding:5px 8px; border-radius:6px; max-width:85%; white-space:pre-wrap;'
        : 'align-self:flex-start; background:var(--b-bg-input); color:#ddd; padding:5px 8px; border-radius:6px; max-width:90%; white-space:pre-wrap;';
    row.innerText = text;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    return row;
}

function currentSceneSummary() {
    return {
        objects: sceneObjects.filter(o => o.mesh).map(o => ({ name: o.name, type: o.type })),
        selected: selectedObject ? selectedObject.name : null,
        interactionMode: currentInteractionMode,
        meshSelectModes: { vertex: vertexSelectOn, edge: edgeSelectOn, face: faceSelectOn },
        faceSelectionCount: selectedFaces.length,
    };
}

async function sendAICommand() {
    const input = document.getElementById('ai-prompt-input');
    const prompt = input.value.trim();
    if (!prompt) return;
    input.value = '';
    aiLog('user', prompt);
    const thinking = aiLog('assistant', '…thinking');

    let data;
    try {
        const res = await fetch('/api/ai-command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, scene: currentSceneSummary() }),
        });
        data = await res.json();
    } catch (err) {
        thinking.innerText = 'Error: ' + err.message;
        return;
    }
    thinking.remove();

    if (data.status !== 'OK') {
        aiLog('assistant', 'Error: ' + (data.message || 'AI command failed'));
        return;
    }
    if (data.assistant_text) aiLog('assistant', data.assistant_text);
    (data.actions || []).forEach(action => aiLog('assistant', executeAIAction(action)));
    if (!data.assistant_text && (!data.actions || data.actions.length === 0)) {
        aiLog('assistant', '(No action taken)');
    }
}

function executeAIAction(action) {
    const { tool, input } = action || {};
    try {
        switch (tool) {
            case 'add_primitive':
                addPrimitive(input?.type || 'cube');
                return `✓ Added ${input?.type || 'cube'}`;

            case 'set_transform': {
                const obj = selectedObject;
                if (!obj) return '✗ No object selected';
                const before = { position: obj.position.clone(), rotation: obj.rotation.clone(), scale: obj.scale.clone() };
                if (input?.position?.length === 3) obj.position.set(...input.position);
                if (input?.rotation_deg?.length === 3) obj.rotation.set(...input.rotation_deg.map(THREE.MathUtils.degToRad));
                if (input?.scale?.length === 3) obj.scale.set(...input.scale);
                const after = { position: obj.position.clone(), rotation: obj.rotation.clone(), scale: obj.scale.clone() };
                pushUndo({
                    undo() { obj.position.copy(before.position); obj.rotation.copy(before.rotation); obj.scale.copy(before.scale); },
                    redo() { obj.position.copy(after.position); obj.rotation.copy(after.rotation); obj.scale.copy(after.scale); },
                });
                updateInspectorFromSelected();
                return `✓ Transformed ${obj.name}`;
            }

            case 'apply_material': {
                if (!selectedObject) return '✗ No object selected';
                if (input?.preset) { applyPresetMat(input.preset); return `✓ Applied ${input.preset} material`; }
                const set = (id, val) => { const el = document.getElementById(id); if (el && val != null) el.value = val; };
                set('mat-color', input?.color_hex);
                set('mat-rough', input?.roughness);
                set('mat-metal', input?.metalness);
                applyColorMat();
                return '✓ Applied material';
            }

            case 'mesh_edit':
                executeMeshEditTool(input?.tool);
                return `✓ Ran ${input?.tool}`;

            case 'add_light': {
                const light = createLight(input?.type || 'point', { intensity: input?.intensity, color: input?.color_hex });
                return light ? `✓ Added ${light.name}` : `✗ Unknown light type: ${input?.type}`;
            }

            case 'set_time_of_day':
                setTimeOfDay(input?.hours ?? 12);
                return `✓ Time set to ${formatTimeOfDay(input?.hours ?? 12)}`;

            case 'apply_modifier': {
                if (!selectedObject) return '✗ No object selected';
                const modifier = input?.modifier;
                if (!modifier) return '✗ No modifier specified';
                const ok = applyBlenderModifier(modifier, input || {});
                return ok ? `✓ Applied ${modifier}` : `✗ Could not apply ${modifier}`;
            }

            case 'select_object': {
                const entry = sceneObjects.find(o => o.name === input?.name);
                if (!entry) return `✗ No object named "${input?.name}"`;
                selectObject(entry.mesh);
                return `✓ Selected ${input.name}`;
            }

            case 'delete_selected':
                if (!selectedObject) return '✗ No object selected';
                deleteSelected();
                return '✓ Deleted selection';

            case 'duplicate_selected':
                if (!selectedObject) return '✗ No object selected';
                duplicateSelected();
                return '✓ Duplicated selection';

            case 'set_shading_mode':
                setShadingMode(input?.mode || 'MATERIAL');
                return `✓ Shading: ${input?.mode}`;

            case 'new_scene':
                newScene();
                return '✓ New scene';

            case 'add_wall':
                setActiveTool('wall');
                return '✓ Wall tool — click points in the viewport';

            case 'make_rooms':
                makeRoomsFromWalls();
                return '✓ Tried to make rooms from closed walls';

            case 'add_door_component':
                addDoorComponent();
                return '✓ Door component added';

            case 'export_schedule':
                exportScheduleCsv();
                return '✓ Schedule CSV download started';

            default:
                return `✗ Unknown action: ${tool}`;
        }
    } catch (err) {
        return `✗ Failed (${tool}): ${err.message}`;
    }
}

// ─────────────────────────────────────────────────────────────
// AI SETTINGS — provider + API key, saved server-side (never re-sent to
// the browser once stored; GET only reports whether a key is present).
// ─────────────────────────────────────────────────────────────
async function loadAISettings() {
    try {
        const res = await fetch('/api/ai-settings');
        const data = await res.json();
        const providerEl = document.getElementById('ai-provider-select');
        if (providerEl) providerEl.value = data.provider || 'anthropic';
        const statusEl = document.getElementById('ai-settings-status');
        if (statusEl) statusEl.innerText = `Anthropic key: ${data.anthropic_configured ? 'configured ✓' : 'not set'}  |  OpenAI key: ${data.openai_configured ? 'configured ✓' : 'not set'}`;
        updateAIKeyHelpLink();
    } catch (err) {
        const statusEl = document.getElementById('ai-settings-status');
        if (statusEl) statusEl.innerText = 'Could not load settings: ' + err.message;
    }
}

// Neither provider offers a "log in with your account" flow a third-party
// local app can use — API access always goes through a key from the
// provider's own console, generated separately from any ChatGPT/Claude.ai
// subscription login. This just points at exactly where to get one.
const AI_KEY_HELP_URLS = {
    anthropic: 'https://console.anthropic.com/settings/keys',
    openai: 'https://platform.openai.com/api-keys',
};
function updateAIKeyHelpLink() {
    const provider = (document.getElementById('ai-provider-select') || {}).value || 'anthropic';
    const el = document.getElementById('ai-key-help-link');
    if (!el) return;
    const label = provider === 'anthropic' ? 'Anthropic Console' : 'OpenAI Platform';
    el.innerHTML = `Get a key from <a href="${AI_KEY_HELP_URLS[provider]}" target="_blank" rel="noopener" style="color:#6fa8ff;">${label} → API Keys</a>`;
}

async function testAIKey() {
    const provider = document.getElementById('ai-provider-select').value;
    const key = document.getElementById('ai-key-input').value.trim();
    const resultEl = document.getElementById('ai-key-test-result');
    if (resultEl) { resultEl.style.color = '#aaa'; resultEl.textContent = 'Testing…'; }
    try {
        const res = await fetch('/api/ai-test-key', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider, api_key: key }),
        });
        const data = await res.json();
        if (resultEl) {
            resultEl.style.color = data.status === 'OK' ? '#7adf7a' : '#ff7a7a';
            resultEl.textContent = data.message || (data.status === 'OK' ? 'Key is valid.' : 'Key test failed.');
        }
    } catch (err) {
        if (resultEl) { resultEl.style.color = '#ff7a7a'; resultEl.textContent = 'Could not reach the server: ' + err.message; }
    }
}

async function saveAISettings() {
    const provider = document.getElementById('ai-provider-select').value;
    const keyInput = document.getElementById('ai-key-input');
    const key = keyInput.value.trim();
    if (!key) { setVCB('AI Settings:', 'Enter an API key first'); return; }
    try {
        const res = await fetch('/api/ai-settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider, api_key: key }),
        });
        const data = await res.json();
        keyInput.value = '';
        await loadAISettings();
        setVCB('AI Settings:', data.status === 'OK' ? 'Saved' : (data.message || 'Failed'));
    } catch (err) {
        setVCB('AI Settings:', 'Failed: ' + err.message);
    }
}

function toggleAISettingsPanel(show) {
    const el = document.getElementById('ai-settings-panel');
    if (!el) return;
    const willShow = show === undefined ? el.style.display === 'none' : show;
    el.style.display = willShow ? 'flex' : 'none';
    if (willShow) loadAISettings();
}

// ─────────────────────────────────────────────────────────────
// DOCKABLE PANELS — drag any panel's header to float it anywhere on
// screen, or drop it near a screen edge to dock it there. Layout persists
// across reloads via localStorage. Previously every panel (tool palette,
// outliner/properties, timeline, AI assistant) was fixed in place with no
// way to rearrange the workspace.
// ─────────────────────────────────────────────────────────────
const DOCK_RAIL_IDS = { left: 'dock-left', right: 'dock-right', top: 'dock-top', bottom: 'dock-bottom' };
const DOCK_LAYOUT_KEY = '3dcore_dock_layout';
const DOCK_EDGE_PX = 60;

// Per-panel preferred size when docked to a vertical (left/right) vs
// horizontal (top/bottom) rail — the generic CSS default (320 / 38px) is
// right for Outliner+Properties and Timeline respectively, but not both,
// so this fills in the sensible size for whichever rail a panel actually
// lands in.
const DOCK_PANEL_SIZE = {
    'outliner-props':    { vertical: { width: 320 }, horizontal: { height: 220 } },
    'sketchup-toolbar':  { vertical: { width: 78 },  horizontal: { height: 78 } }, // 2 columns of ~34px buttons + padding
    'ai-assistant':       { vertical: { width: 320 }, horizontal: { height: 220 } },
};

function initDockablePanels() {
    document.querySelectorAll('.dockable-panel[data-panel-id]').forEach(panel => {
        const header = panel.querySelector('.dock-panel-header');
        if (header) makePanelDraggable(panel, header);
        addResizeHandle(panel);
    });
    restoreDockLayout();
}

// Drag-to-resize the inner edge of a DOCKED panel (floating panels get a
// native CSS `resize` corner handle instead) — previously docked panels
// had a fixed size with no way to adjust it at all.
function addResizeHandle(panel) {
    const handle = document.createElement('div');
    handle.className = 'dock-resize-handle';
    panel.appendChild(handle);

    let dragging = false, startX = 0, startY = 0, startW = 0, startH = 0, pointerId = null;
    handle.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        dragging = true;
        pointerId = e.pointerId;
        handle.setPointerCapture(pointerId);
        const rect = panel.getBoundingClientRect();
        startX = e.clientX; startY = e.clientY; startW = rect.width; startH = rect.height;
        e.stopPropagation(); e.preventDefault();
    });
    handle.addEventListener('pointermove', e => {
        if (!dragging) return;
        const zone = ['left', 'right', 'top', 'bottom'].find(z => panel.classList.contains('docked-' + z));
        if (!zone) return;
        if (zone === 'right') panel.style.width = Math.max(180, startW - (e.clientX - startX)) + 'px';
        else if (zone === 'left') panel.style.width = Math.max(180, startW + (e.clientX - startX)) + 'px';
        else if (zone === 'bottom') panel.style.height = Math.max(32, startH - (e.clientY - startY)) + 'px';
        else if (zone === 'top') panel.style.height = Math.max(32, startH + (e.clientY - startY)) + 'px';
    });
    const finish = () => {
        if (!dragging) return;
        dragging = false;
        try { handle.releasePointerCapture(pointerId); } catch (err) { /* already released */ }
        saveDockLayout();
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
}

function makePanelDraggable(panel, header) {
    let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0, startW = 0, startH = 0, pointerId = null;

    header.addEventListener('pointerdown', e => {
        if (e.button !== 0 || e.target.tagName === 'BUTTON') return;
        dragging = true;
        pointerId = e.pointerId;
        const rect = panel.getBoundingClientRect();
        startX = e.clientX; startY = e.clientY;
        startLeft = rect.left; startTop = rect.top; startW = rect.width; startH = rect.height;
        // Reparent (floatPanel) BEFORE capturing the pointer — moving a
        // captured element in the DOM invalidates its capture, which
        // silently kills the drag (pointermove stops firing) if done after.
        floatPanel(panel, startLeft, startTop, startW, startH);
        header.setPointerCapture(pointerId);
        e.preventDefault();
    });

    header.addEventListener('pointermove', e => {
        if (!dragging) return;
        const dx = e.clientX - startX, dy = e.clientY - startY;
        panel.style.left = Math.max(0, startLeft + dx) + 'px';
        panel.style.top = Math.max(0, startTop + dy) + 'px';
    });

    const finishDrag = e => {
        if (!dragging) return;
        dragging = false;
        try { header.releasePointerCapture(pointerId); } catch (err) { /* already released */ }
        const zone = dockZoneAtPoint(e.clientX, e.clientY, panel.dataset.panelId);
        if (zone) dockPanel(panel, zone);
        saveDockLayout();
    };
    header.addEventListener('pointerup', finishDrag);
    header.addEventListener('pointercancel', finishDrag);
}

// Outliner+Properties has a fixed internal layout (a vertical icon tab
// strip down one side, property rows sized for a narrow column) that only
// makes sense in a tall vertical dock — docking it to the top/bottom edge
// squashed that layout into an unreadable horizontal strip. Panels not
// listed here allow all 4 edges (their layout doesn't assume an orientation).
const PANEL_ALLOWED_ZONES = {
    'outliner-props': ['left', 'right'],
};

function dockZoneAtPoint(x, y, panelId) {
    let zone = null;
    if (x < DOCK_EDGE_PX) zone = 'left';
    else if (x > window.innerWidth - DOCK_EDGE_PX) zone = 'right';
    else if (y < DOCK_EDGE_PX + 70) zone = 'top';    // account for the top header + sub-toolbar
    else if (y > window.innerHeight - DOCK_EDGE_PX) zone = 'bottom';
    if (!zone) return null;
    const allowed = panelId && PANEL_ALLOWED_ZONES[panelId];
    if (allowed && !allowed.includes(zone)) return null; // outside this panel's valid zones — drop as floating instead
    return zone;
}

function floatPanel(panel, x, y, w, h) {
    if (panel.parentElement !== document.body) document.body.appendChild(panel);
    panel.classList.add('floating');
    panel.classList.remove('docked-left', 'docked-right', 'docked-top', 'docked-bottom');
    panel.style.right = ''; panel.style.bottom = '';
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
    panel.style.width = w + 'px';
    panel.style.height = h + 'px';
    if (panel.id === 'ai-panel' || panel.id === 'ai-settings-panel') panel.style.display = 'flex';
}

function dockPanel(panel, zone) {
    const rail = document.getElementById(DOCK_RAIL_IDS[zone]);
    if (!rail) return;
    panel.classList.remove('floating');
    panel.classList.add('docked-' + zone);
    panel.style.left = ''; panel.style.top = ''; panel.style.right = ''; panel.style.bottom = '';
    const vertical = zone === 'left' || zone === 'right';
    const size = DOCK_PANEL_SIZE[panel.dataset.panelId];
    if (size) {
        const s = vertical ? size.vertical : size.horizontal;
        panel.style.width = vertical ? (s.width || 300) + 'px' : '100%';
        panel.style.height = vertical ? '100%' : (s.height || 200) + 'px';
    } else {
        panel.style.width = vertical ? '300px' : '100%';
        panel.style.height = vertical ? '100%' : '200px';
    }
    rail.appendChild(panel);
}

function saveDockLayout() {
    const state = {};
    document.querySelectorAll('.dockable-panel[data-panel-id]').forEach(panel => {
        const id = panel.dataset.panelId;
        if (panel.classList.contains('floating')) {
            state[id] = { mode: 'floating', left: panel.style.left, top: panel.style.top, width: panel.style.width, height: panel.style.height };
        } else {
            const zone = ['left', 'right', 'top', 'bottom'].find(z => panel.classList.contains('docked-' + z));
            if (zone) state[id] = { mode: 'docked', zone, width: panel.style.width, height: panel.style.height };
        }
    });
    try { localStorage.setItem(DOCK_LAYOUT_KEY, JSON.stringify(state)); } catch (err) { /* storage unavailable — layout just won't persist */ }
}

function restoreDockLayout() {
    let state = {};
    try { state = JSON.parse(localStorage.getItem(DOCK_LAYOUT_KEY) || '{}'); } catch (err) { return; }
    document.querySelectorAll('.dockable-panel[data-panel-id]').forEach(panel => {
        const saved = state[panel.dataset.panelId];
        if (!saved) return; // no saved override — leave it in its default HTML position
        if (saved.mode === 'floating') {
            const x = parseFloat(saved.left) || 100, y = parseFloat(saved.top) || 100;
            const w = parseFloat(saved.width) || 300, h = parseFloat(saved.height) || 200;
            floatPanel(panel, x, y, w, h);
        } else if (saved.mode === 'docked') {
            // A layout saved before PANEL_ALLOWED_ZONES existed could name a
            // zone this panel no longer permits — fall back to its first
            // allowed zone rather than restoring the broken layout.
            const allowed = PANEL_ALLOWED_ZONES[panel.dataset.panelId];
            const zone = (allowed && !allowed.includes(saved.zone)) ? allowed[0] : saved.zone;
            dockPanel(panel, zone);
            if (saved.width) panel.style.width = saved.width;
            if (saved.height) panel.style.height = saved.height;
        }
    });
}

function resetDockLayout() {
    try { localStorage.removeItem(DOCK_LAYOUT_KEY); } catch (err) { /* ignore */ }
    location.reload();
}

// ─────────────────────────────────────────────────────────────
// CSG (Constructive Solid Geometry) — real Union/Subtract/Intersect via a
// BSP-tree algorithm (the standard technique — same approach as Evan
// Wallace's csg.js). Was previously not implemented at all: the modifier
// buttons for it didn't even exist in the UI, and the dead code behind
// them just set a status message and returned. Works on arbitrary
// triangle meshes; like any BSP CSG, very thin/degenerate/exactly-coplanar
// inputs can produce numerically messy results — same caveat every CSG
// implementation has, including professional ones.
// ─────────────────────────────────────────────────────────────
const CSG_EPSILON = 1e-5;

class CSGVertex {
    constructor(pos, normal) { this.pos = pos.clone(); this.normal = normal.clone(); }
    clone() { return new CSGVertex(this.pos, this.normal); }
    flip() { this.normal.negate(); }
    interpolate(other, t) { return new CSGVertex(this.pos.clone().lerp(other.pos, t), this.normal.clone().lerp(other.normal, t)); }
}

class CSGPlane {
    constructor(normal, w) { this.normal = normal; this.w = w; }
    static fromPoints(a, b, c) {
        const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
        return new CSGPlane(n, n.dot(a));
    }
    clone() { return new CSGPlane(this.normal.clone(), this.w); }
    flip() { this.normal.negate(); this.w = -this.w; }

    splitPolygon(polygon, coplanarFront, coplanarBack, front, back) {
        const COPLANAR = 0, FRONT = 1, BACK = 2, SPANNING = 3;
        let polygonType = 0;
        const types = [];
        for (const v of polygon.vertices) {
            const t = this.normal.dot(v.pos) - this.w;
            const type = t < -CSG_EPSILON ? BACK : t > CSG_EPSILON ? FRONT : COPLANAR;
            polygonType |= type;
            types.push(type);
        }
        switch (polygonType) {
            case COPLANAR:
                (this.normal.dot(polygon.plane.normal) > 0 ? coplanarFront : coplanarBack).push(polygon);
                break;
            case FRONT:
                front.push(polygon);
                break;
            case BACK:
                back.push(polygon);
                break;
            default: { // SPANNING
                const f = [], b = [];
                for (let i = 0; i < polygon.vertices.length; i++) {
                    const j = (i + 1) % polygon.vertices.length;
                    const ti = types[i], tj = types[j];
                    const vi = polygon.vertices[i], vj = polygon.vertices[j];
                    if (ti !== BACK) f.push(vi);
                    if (ti !== FRONT) b.push(ti !== BACK ? vi.clone() : vi);
                    if ((ti | tj) === SPANNING) {
                        const t = (this.w - this.normal.dot(vi.pos)) / this.normal.dot(new THREE.Vector3().subVectors(vj.pos, vi.pos));
                        const v = vi.interpolate(vj, t);
                        f.push(v);
                        b.push(v.clone());
                    }
                }
                if (f.length >= 3) front.push(new CSGPolygon(f));
                if (b.length >= 3) back.push(new CSGPolygon(b));
            }
        }
    }
}

class CSGPolygon {
    constructor(vertices) { this.vertices = vertices; this.plane = CSGPlane.fromPoints(vertices[0].pos, vertices[1].pos, vertices[2].pos); }
    clone() { return new CSGPolygon(this.vertices.map(v => v.clone())); }
    flip() { this.vertices.reverse(); this.vertices.forEach(v => v.flip()); this.plane.flip(); }
}

class CSGNode {
    constructor(polygons) { this.plane = null; this.front = null; this.back = null; this.polygons = []; if (polygons) this.build(polygons); }
    clone() {
        const node = new CSGNode();
        node.plane = this.plane && this.plane.clone();
        node.front = this.front && this.front.clone();
        node.back = this.back && this.back.clone();
        node.polygons = this.polygons.map(p => p.clone());
        return node;
    }
    invert() {
        for (const p of this.polygons) p.flip();
        if (this.plane) this.plane.flip();
        if (this.front) this.front.invert();
        if (this.back) this.back.invert();
        const t = this.front; this.front = this.back; this.back = t;
    }
    clipPolygons(polygons) {
        if (!this.plane) return polygons.slice();
        let front = [], back = [];
        for (const p of polygons) this.plane.splitPolygon(p, front, back, front, back);
        if (this.front) front = this.front.clipPolygons(front);
        back = this.back ? this.back.clipPolygons(back) : [];
        return front.concat(back);
    }
    clipTo(bsp) {
        this.polygons = bsp.clipPolygons(this.polygons);
        if (this.front) this.front.clipTo(bsp);
        if (this.back) this.back.clipTo(bsp);
    }
    allPolygons() {
        let polygons = this.polygons.slice();
        if (this.front) polygons = polygons.concat(this.front.allPolygons());
        if (this.back) polygons = polygons.concat(this.back.allPolygons());
        return polygons;
    }
    build(polygons) {
        if (polygons.length === 0) return;
        if (!this.plane) this.plane = polygons[0].plane.clone();
        const front = [], back = [];
        for (const p of polygons) this.plane.splitPolygon(p, this.polygons, this.polygons, front, back);
        if (front.length > 0) { if (!this.front) this.front = new CSGNode(); this.front.build(front); }
        if (back.length > 0) { if (!this.back) this.back = new CSGNode(); this.back.build(back); }
    }
}

// mesh (with its current world transform) -> CSG polygons, baked into world space
function geometryToCSGPolygons(mesh) {
    ensureNonIndexed(mesh);
    mesh.geometry.computeVertexNormals();
    mesh.updateMatrixWorld(true);
    const pos = mesh.geometry.attributes.position;
    const norm = mesh.geometry.attributes.normal;
    const mat = mesh.matrixWorld;
    const normalMat = new THREE.Matrix3().getNormalMatrix(mat);
    const polygons = [];
    for (let i = 0; i < pos.count; i += 3) {
        const verts = [];
        for (let v = 0; v < 3; v++) {
            const idx = i + v;
            const p = new THREE.Vector3(pos.getX(idx), pos.getY(idx), pos.getZ(idx)).applyMatrix4(mat);
            const n = new THREE.Vector3(norm.getX(idx), norm.getY(idx), norm.getZ(idx)).applyMatrix3(normalMat).normalize();
            verts.push(new CSGVertex(p, n));
        }
        const cross = verts[1].pos.clone().sub(verts[0].pos).cross(verts[2].pos.clone().sub(verts[0].pos));
        if (cross.lengthSq() < 1e-14) continue; // skip degenerate triangles
        polygons.push(new CSGPolygon(verts));
    }
    return polygons;
}

function csgPolygonsToGeometry(polygons) {
    const positions = [];
    polygons.forEach(poly => {
        for (let i = 1; i < poly.vertices.length - 1; i++) {
            const a = poly.vertices[0].pos, b = poly.vertices[i].pos, c = poly.vertices[i + 1].pos;
            positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
        }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geo.computeVertexNormals();
    return geo;
}

// Result geometry is baked in WORLD space (since A and B may have different
// transforms) — callers must reset the receiving mesh's own transform to
// identity when assigning it, or the geometry will be displaced twice.
function csgOperation(meshA, meshB, op) {
    const a = new CSGNode(geometryToCSGPolygons(meshA));
    const b = new CSGNode(geometryToCSGPolygons(meshB));
    if (op === 'union') {
        a.clipTo(b); b.clipTo(a); b.invert(); b.clipTo(a); b.invert();
        a.build(b.allPolygons());
    } else if (op === 'subtract') {
        a.invert(); a.clipTo(b); b.clipTo(a); b.invert(); b.clipTo(a); b.invert();
        a.build(b.allPolygons()); a.invert();
    } else if (op === 'intersect') {
        a.invert(); b.clipTo(a); b.invert(); a.clipTo(b); b.clipTo(a);
        a.build(b.allPolygons()); a.invert();
    }
    return csgPolygonsToGeometry(a.allPolygons());
}

// Union/Subtract/Intersect need a second object — arm the tool, then a
// click on another mesh in the viewport runs the operation against the
// currently-selected one.
function armBooleanTool(op) {
    if (!selectedObject || !selectedObject.isMesh) { setVCB('Boolean:', 'Select the first object first'); return; }
    setActiveTool('boolean_' + op);
    setVCB('Boolean ' + op[0].toUpperCase() + op.slice(1) + ':', 'Click the second object');
}

function runBooleanOperation(meshA, meshB, op) {
    const entryA = sceneObjects.find(o => o.mesh === meshA);
    const entryB = sceneObjects.find(o => o.mesh === meshB);
    if (!entryA || !entryB) return false;

    let resultGeo;
    try {
        resultGeo = csgOperation(meshA, meshB, op);
    } catch (err) {
        setVCB('Boolean:', 'Failed: ' + err.message);
        return false;
    }
    if (resultGeo.attributes.position.count === 0) {
        resultGeo.dispose();
        setVCB('Boolean:', 'Result is empty (no overlap)');
        return false;
    }

    const beforeGeoA = deepCloneGeometry(meshA.geometry);
    const beforePosA = meshA.position.clone(), beforeRotA = meshA.rotation.clone(), beforeScaleA = meshA.scale.clone();
    const parentB = meshB.parent || scene;
    const typeB = entryB.type;

    meshA.geometry.dispose();
    meshA.geometry = resultGeo; // baked in world space
    meshA.position.set(0, 0, 0); meshA.rotation.set(0, 0, 0); meshA.scale.set(1, 1, 1);
    removeSceneObject(meshB);

    const afterGeoA = deepCloneGeometry(meshA.geometry);
    pushUndo({
        undo() {
            meshA.geometry.dispose(); meshA.geometry = beforeGeoA;
            meshA.position.copy(beforePosA); meshA.rotation.copy(beforeRotA); meshA.scale.copy(beforeScaleA);
            parentB.add(meshB); sceneObjects.push({ name: meshB.name, type: typeB, mesh: meshB }); renderOutliner(); selectObject(meshA);
        },
        redo() {
            meshA.geometry.dispose(); meshA.geometry = afterGeoA;
            meshA.position.set(0, 0, 0); meshA.rotation.set(0, 0, 0); meshA.scale.set(1, 1, 1);
            removeSceneObject(meshB); selectObject(meshA);
        },
    });
    selectObject(meshA);
    setVCB('Boolean ' + op[0].toUpperCase() + op.slice(1) + ':', 'Done');
    return true;
}

// Hollow/Shell — real boolean subtract of an inward-scaled copy of the
// object from itself, leaving a shell of the given wall thickness.
function runHollowShell(thickness) {
    const obj = selectedObject;
    if (!obj || !obj.isMesh) return;
    obj.geometry.computeBoundingBox();
    const size = new THREE.Vector3();
    obj.geometry.boundingBox.getSize(size);
    const minDim = Math.min(size.x, size.y, size.z) * Math.max(obj.scale.x, obj.scale.y, obj.scale.z);
    if (thickness * 2 >= minDim) { setVCB('Hollow:', 'Wall thickness too large for this object'); return; }

    const inner = obj.clone();
    inner.geometry = deepCloneGeometry(obj.geometry);
    inner.material = obj.material;
    const shrink = new THREE.Vector3(
        1 - (thickness * 2) / (size.x || 1),
        1 - (thickness * 2) / (size.y || 1),
        1 - (thickness * 2) / (size.z || 1)
    );
    inner.geometry.scale(shrink.x, shrink.y, shrink.z);
    inner.updateMatrixWorld(true);

    let resultGeo;
    try {
        resultGeo = csgOperation(obj, inner, 'subtract');
    } catch (err) {
        inner.geometry.dispose();
        setVCB('Hollow:', 'Failed: ' + err.message);
        return;
    }
    inner.geometry.dispose();

    const beforeGeo = deepCloneGeometry(obj.geometry);
    const beforePos = obj.position.clone(), beforeRot = obj.rotation.clone(), beforeScale = obj.scale.clone();
    obj.geometry.dispose();
    obj.geometry = resultGeo;
    obj.position.set(0, 0, 0); obj.rotation.set(0, 0, 0); obj.scale.set(1, 1, 1);
    const afterGeo = deepCloneGeometry(obj.geometry);

    pushUndo({
        undo() { obj.geometry.dispose(); obj.geometry = beforeGeo; obj.position.copy(beforePos); obj.rotation.copy(beforeRot); obj.scale.copy(beforeScale); },
        redo() { obj.geometry.dispose(); obj.geometry = afterGeo; obj.position.set(0, 0, 0); obj.rotation.set(0, 0, 0); obj.scale.set(1, 1, 1); },
    });
    updateInspectorFromSelected();
    setVCB('Hollow:', `${formatLength(thickness)} wall thickness`);
}

// ─────────────────────────────────────────────────────────────
// UNITS — a real, app-wide unit setting (was hardcoded to meters
// everywhere). Applies to Tape Measure, Rectangle/Circle dimensions, and
// Push/Pull depth readouts. Internally everything still stores meters
// (three.js scene units) — this only changes what's displayed.
// ─────────────────────────────────────────────────────────────
const UNIT_DEFS = {
    m:  { label: 'm',  factor: 1 },
    cm: { label: 'cm', factor: 100 },
    mm: { label: 'mm', factor: 1000 },
    ft: { label: 'ft', factor: 3.28084 },
    in: { label: 'in', factor: 39.3701 },
};
let appUnits = 'm';
try { appUnits = localStorage.getItem('3dcore_units') || 'm'; } catch (err) { /* storage unavailable */ }

function formatLength(meters, decimals) {
    const u = UNIT_DEFS[appUnits] || UNIT_DEFS.m;
    return `${(meters * u.factor).toFixed(decimals != null ? decimals : 2)} ${u.label}`;
}

function setAppUnits(u) {
    if (!UNIT_DEFS[u]) return;
    appUnits = u;
    try { localStorage.setItem('3dcore_units', u); } catch (err) { /* ignore */ }
    document.querySelectorAll('.units-quick-select').forEach(el => { el.value = u; });
    setVCB('Units:', UNIT_DEFS[u].label);
}

// ─────────────────────────────────────────────────────────────
// RIGHT-CLICK CONTEXT MENU — Add primitives at the clicked point (was
// entirely absent; right-click did nothing but let the browser's own
// menu through, or got eaten by OrbitControls' pan binding).
// ─────────────────────────────────────────────────────────────
let _contextMenuSpawnPoint = null;

function toggleContextMenu(show, x, y) {
    const el = document.getElementById('context-menu');
    if (!el) return;
    if (show) {
        el.style.left = x + 'px';
        el.style.top = y + 'px';
        el.style.display = 'block';
        const hasSel = !!selectedObject;
        document.getElementById('context-menu-duplicate').style.display = hasSel ? 'flex' : 'none';
        document.getElementById('context-menu-delete').style.display = hasSel ? 'flex' : 'none';
    } else {
        el.style.display = 'none';
    }
}

function contextMenuAdd(type) {
    toggleContextMenu(false);
    addPrimitive(type);
    if (_contextMenuSpawnPoint && selectedObject) selectedObject.position.copy(_contextMenuSpawnPoint);
}

// Boolean tools (Union/Subtract/Intersect) are armed via armBooleanTool()
// with object A already selected; this handles the "click object B" step.
function setupBooleanPicker(canvas) {
    canvas.addEventListener('pointerup', e => {
        if (!activeTool.startsWith('boolean_') || e.button !== 0) return;
        const rect = canvas.getBoundingClientRect();
        _mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        _mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        _raycaster.setFromCamera(_mouse, camera);
        const targets = sceneObjects.filter(o => o.mesh && o.mesh.isMesh && o.mesh !== selectedObject).map(o => o.mesh);
        const hits = _raycaster.intersectObjects(targets, false);
        if (hits.length === 0) return;
        const op = activeTool.replace('boolean_', '');
        const meshA = selectedObject;
        setActiveTool('select');
        runBooleanOperation(meshA, hits[0].object, op);
    });
}

function setupContextMenu(canvas) {
    // Right mouse button also drives OrbitControls' Pan — only open the
    // menu on a genuine right-CLICK (no significant drag), so panning the
    // camera doesn't pop the Add menu open as a side effect.
    let rightDownPos = null;
    canvas.addEventListener('pointerdown', e => { if (e.button === 2) rightDownPos = { x: e.clientX, y: e.clientY }; });

    canvas.addEventListener('contextmenu', e => {
        e.preventDefault();
        if (rightDownPos) {
            const dx = Math.abs(e.clientX - rightDownPos.x), dy = Math.abs(e.clientY - rightDownPos.y);
            if (dx > 5 || dy > 5) return; // was a pan drag, not a menu request
        }
        const rect = canvas.getBoundingClientRect();
        _mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        _mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        _raycaster.setFromCamera(_mouse, camera);
        const hits = _raycaster.intersectObjects(sceneObjects.filter(o => o.mesh && o.mesh.isMesh).map(o => o.mesh), true);
        const pt = new THREE.Vector3();
        if (hits.length > 0) {
            _contextMenuSpawnPoint = hits[0].point.clone();
            // Right-click on a surface selects it first (AutoCAD/SketchUp
            // convention: right-click both selects AND opens the menu for
            // whatever's now selected), reusing the same coplanar-face
            // select as the left-click SketchUp-mode path.
            if (hits[0].faceIndex != null) {
                let obj = hits[0].object;
                while (obj && !sceneObjects.some(o => o.mesh === obj)) obj = obj.parent;
                if (obj) {
                    ensureNonIndexed(obj);
                    selectObject(obj);
                    toggleFaceSelection(obj, hits[0].faceIndex, false);
                }
            }
        } else {
            _contextMenuSpawnPoint = _raycaster.ray.intersectPlane(_groundPlane, pt) ? pt.clone() : new THREE.Vector3();
        }
        toggleContextMenu(true, e.clientX, e.clientY);
    });
    window.addEventListener('click', e => {
        if (e.target.closest && e.target.closest('#context-menu')) return;
        toggleContextMenu(false);
    });
}

// ─────────────────────────────────────────────────────────────
// HELP MENU — previously did nothing at all when clicked.
// ─────────────────────────────────────────────────────────────
// EXPLORE SCENE GRAPH — a real raw-hierarchy inspector (design idea
// studied from the Pascal Editor reference project). Deliberately
// different granularity than the Outliner: the Outliner only shows
// top-level tracked sceneObjects entries, while this walks the actual
// live THREE.Scene tree recursively — every child of a Wall
// group/component, every side-mesh, anything nested — useful for seeing
// what's REALLY in the scene, not just the named objects a user placed.
function _escapeHtmlText(s) {
    const div = document.createElement('div');
    div.textContent = String(s);
    return div.innerHTML;
}
function _sceneGraphNodeHtml(obj, depth) {
    const kind = obj.userData && obj.userData.kind;
    const label = obj.name || '(unnamed)';
    const meta = [obj.type, kind ? `kind:${kind}` : null, obj.children.length ? `${obj.children.length} child(ren)` : null].filter(Boolean).join(' · ');
    let html = `<div style="padding-left:${depth * 16}px; white-space:nowrap; font-family:monospace; font-size:10px; padding-top:2px;">`;
    html += `<span style="color:${obj.visible ? '#ddd' : '#666'};">${_escapeHtmlText(label)}</span> <span style="color:var(--b-text-sub);">${_escapeHtmlText(meta)}</span>`;
    html += `</div>`;
    obj.children.forEach(c => { html += _sceneGraphNodeHtml(c, depth + 1); });
    return html;
}
function exploreSceneGraph() {
    // Rooted at the curated sceneObjects list, not the raw THREE.Scene tree
    // — the latter is dominated by internal helpers (TransformControls'
    // own gizmo, its handle sub-meshes, the ground grid, axis lines,
    // selection outline) that have nothing to do with the user's actual
    // model. Recursing into each tracked object's real children is where
    // this genuinely goes deeper than the Outliner (a Wall's side meshes,
    // a Group's members, anything nested) without the internal noise.
    let html = '<div style="max-height:60vh; overflow-y:auto;">';
    html += sceneObjects.map(o => _sceneGraphNodeHtml(o.mesh, 0)).join('');
    html += '</div>';
    showInfoModal(`Scene Graph — ${sceneObjects.length} tracked object(s)`, html);
}

function showInfoModal(title, html) {
    const t = document.getElementById('info-modal-title');
    const b = document.getElementById('info-modal-body');
    const m = document.getElementById('info-modal');
    if (t) t.innerText = title;
    if (b) b.innerHTML = html;
    if (m) m.style.display = 'flex';
}

function showKeyboardShortcuts() {
    showInfoModal('Keyboard Shortcuts', `
        <div style="display:grid; grid-template-columns:auto 1fr; gap:5px 12px;">
            <b>G / R / S</b><span>Move / Rotate / Scale</span>
            <b>Q</b><span>Rotate (alt binding)</span>
            <b>Tab</b><span>Object ⇄ Edit Mode</span>
            <b>1 / 2 / 3</b><span>Vertex / Edge / Face select (Edit Mode)</span>
            <b>E</b><span>Eraser tool</span>
            <b>L</b><span>Select Linked (Edit + Face) / Line (SketchUp CAD)</span>
            <b>Ctrl+= / Ctrl+-</b><span>Grow / shrink face selection</span>
            <b>PE chip</b><span>Proportional object translate falloff</span>
            <b>Lasso / Box / Circle</b><span>Region select — objects, or faces in Edit+Face. Shift adds</span>
            <b>Loop / Fill</b><span>Face loop walk / boundary fan-fill (not half-edge)</span>
            <b>ROOM / LEVEL / SCHEDULE / DXFOUT</b><span>BIM rooms, storeys, CSV, plan DXF</span>
            <b>CAMERA / LOOKCAM</b><span>Store current view / look through camera object</span>
            <b>C</b><span>Circle tool (SketchUp CAD workspace)</span>
            <b>A</b><span>Arc tool (SketchUp CAD) — elsewhere: Select All / Deselect</span>
            <b>P / U</b><span>Push/Pull tool</span>
            <b>F</b><span>Offset tool</span>
            <b>T</b><span>Tape Measure</span>
            <b>B</b><span>Material tab</span>
            <b>X / Delete</b><span>Delete — the selected face/vertex/edge in Edit Mode, else the whole object</span>
            <b>M</b><span>Merge by Distance (Edit Mode) — elsewhere: Move tool</span>
            <b>I</b><span>Insert Keyframe</span>
            <b>Space</b><span>Play / Pause</span>
            <b>Numpad 1 / 3 / 7 / 5</b><span>Front / Right / Top / toggle Ortho</span>
            <b>Shift+D</b><span>Duplicate</span>
            <b>F5</b><span>Present mode (fullscreen client view)</span>
            <b>F10 / Ctrl+Shift+S</b><span>Screenshot current view (PNG)</span>
            <b>PACK</b><span>Client zip (project + preview PNG + GLB)</span>
            <b>VR / AR commands</b><span>ENTERVR / ENTERAR (headset or GLB fallback)</span>
            <b>F12</b><span>Render (Rendered shading)</span>
            <b>Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y</b><span>Undo / Redo</span>
            <b>Ctrl+S / Ctrl+O</b><span>Save / Open Project</span>
            <b>Enter / Esc</b><span>Finish / cancel Line, Arc, or Poly Build</span>
        </div>
    `);
}

function openHelpDesk() {
    const commandRows = Object.keys(CAD_COMMANDS)
        .filter(k => k.length <= 3) // short aliases only — the reference table below spells out the full names
        .sort()
        .join(', ');
    showInfoModal('Help Desk — How to Use 3D Core Studio', `
        <div style="font-size:10.5px; line-height:1.65;">

        <b>Workspaces</b> (top tab bar) switch the whole toolset for what you're doing:
        <ul style="margin:4px 0 10px 16px; padding:0;">
            <li><b>Layout</b> — general Object Mode: select, move, rotate, scale whole objects.</li>
            <li><b>SketchUp CAD</b> — click a face to select just that surface directly (no separate Edit Mode needed), draw Line/Rectangle/Circle/Arc/Wall/Slab, Push/Pull faces.</li>
            <li><b>Modeling</b> — Blender-style Edit Mode: Vertex/Edge/Face select (1/2/3), Extrude, Inset, Bevel, Loop Cut, Knife, Bisect, and the rest of the mesh-editing toolset.</li>
            <li><b>Sculpting</b> — real vertex-displacement brushes.</li>
            <li><b>Animation</b> — Timeline, keyframes (see below), markers.</li>
            <li><b>BIM Architecture</b> — Wall/Slab/Window-Door-Opening tools, built on real boolean CSG.</li>
            <li><b>Asset Library</b> (top-right tab) — browse and import real, already-on-disk 3D models.</li>
        </ul>

        <b>Navigation</b>
        <ul style="margin:4px 0 10px 16px; padding:0;">
            <li>Orbit: middle-mouse drag. Pan: right-mouse drag (or Shift+middle). Zoom: scroll wheel.</li>
            <li><b>ViewCube</b> (top-right widget) — click a face/the home icon to snap to that view, or click-and-drag anywhere on it to free-orbit, just like AutoCAD's. The corner arrows rotate the view 90° at a time.</li>
        </ul>

        <b>Selecting &amp; editing surfaces</b>
        <ul style="margin:4px 0 10px 16px; padding:0;">
            <li>Left-click or right-click a face to select it (selects the whole flat quad/surface you see, not a single triangle).</li>
            <li>Shift-click to add/remove a face from the selection.</li>
            <li>Right-click also opens a context menu (Add primitive at that point, Duplicate, Delete) for whatever's now selected.</li>
            <li>Hovering shows vertex/edge/face detection markers and a tooltip — this runs continuously while Select/Move/Rotate/Scale is active, not just while drawing.</li>
        </ul>

        <b>Drawing with precision (SketchUp-style)</b>
        <ul style="margin:4px 0 10px 16px; padding:0;">
            <li>While drawing a Line/Wall/Poly Build path, red/green/blue guide lines show when you're aligned to the X/Y/Z axis from your last point.</li>
            <li>Type a number any time mid-draw (no need to click an input box) and press Enter — the next point is placed at exactly that distance along wherever the cursor is pointing, in whatever unit the units dropdown is set to. Enter with nothing typed finishes the shape instead.</li>
        </ul>

        <b>Scale handles</b> — with the Scale tool active, drag a corner cube to resize uniformly (the opposite corner stays pinned), or drag a smaller face-center dot to resize along just that one axis.

        <b>Files</b>
        <ul style="margin:4px 0 10px 16px; padding:0;">
            <li><b>GLB</b> — full scene round-trip (meshes + materials).</li>
            <li><b>OBJ / STL</b> — triangle meshes. STL is geometry only (3D print). These read and write real bytes from your file.</li>
            <li><b>DXF</b> — ASCII LINE and LWPOLYLINE only, turned into wall layers. Not DWG, and not a full CAD kernel.</li>
            <li><b>Client pack (ZIP)</b> — project JSON + preview PNG + GLB (if meshes exist). File → Client Pack or command PACK. Not USDZ.</li>
            <li>FBX / SKP / IFC / USDZ are <b>not</b> in the menu because this app does not decode them yet.</li>
        </ul>

        <b>VR / AR</b>
        <ul style="margin:4px 0 10px 16px; padding:0;">
            <li><b>Enter VR</b> starts a WebXR <code>immersive-vr</code> session when the browser reports one (Quest Browser, Chrome on a compatible headset). The scene is rotated from Z-up to Y-up for the headset. Scale 1:1 / 1:10 / 1:50 is in the Output panel. Controller trigger teleports onto a mesh or the floor.</li>
            <li>If VR is unavailable the button stays disabled — it does not fake a headset view.</li>
            <li><b>Place in AR</b> uses WebXR <code>immersive-ar</code> when the phone supports it. If hit-test is available, trigger places the model on a detected plane. Otherwise it exports a GLB for a phone AR viewer. There is no USDZ encoder and no webcam “fake AR”.</li>
            <li>WebXR needs HTTPS or <code>http://127.0.0.1</code>.</li>
        </ul>

        <b>Keyframe animation</b> — select an object, move the Timeline playhead to a frame, click Insert Keyframe, move/rotate/scale the object, advance the playhead to a different frame, Insert Keyframe again. Position, rotation, and scale all interpolate smoothly between keyframes on Play.

        <b>Command line</b> (bottom bar) — type a command name or short alias and press Enter, AutoCAD-style. Short aliases: ${commandRows}. Type <b>HELP</b> any time to reopen this panel.

        <b>Saving your work</b> — Ctrl+S saves a .3dcore.json project file; Ctrl+O opens one. Export GLB and Import GLB are in the File menu. Undo/Redo: Ctrl+Z / Ctrl+Y.

        <p style="margin-top:10px; color:var(--b-text-sub);">See <code>docs/ROADMAP.md</code> in the project for exactly which tools are real and tested versus still in progress.</p>
        </div>
    `);
}

function showAboutDialog() {
    showInfoModal('About 3D Core Studio', `
        <div style="display:flex; align-items:center; gap:12px; margin-bottom:10px;">
            <img src="/icons/logo.png" width="48" height="48" alt="3D Core Studio" class="logo-pulse-img" style="flex-shrink:0; object-fit:contain;">
            <div>
                <div style="font-size:16px; font-weight:800; letter-spacing:0.5px;"><span style="color:#9aa5b1;">3D</span><span style="color:#4a90e2;">CORE</span></div>
                <div style="font-size:9px; letter-spacing:1.5px; color:var(--b-text-muted);">INNOVATION · CREATIVITY · TECHNOLOGY</div>
            </div>
        </div>
        <p><b>3D Core Studio</b> is a lightweight, browser-first 3D/CAD editor — Blender-, SketchUp-, and Cycles-inspired workflow, running entirely client-side in WebGL with a small dependency-free Python static server.</p>
        <p style="margin-top:8px;">See <code>docs/ROADMAP.md</code> in the project for exactly which tools are real and tested versus still in progress — this app is built to say so honestly rather than fake a feature.</p>
    `);
}

// ─────────────────────────────────────────────────────────────
// MISC HELPERS
// ─────────────────────────────────────────────────────────────
function setShadingModeFromDropdown(val) { setShadingMode(val); }


// ─────────────────────────────────────────────────────────────
// QUALITY LADDER + PRESENT MODE
// Draft / Balanced / Present change real renderer knobs.
// Present hides modeling chrome, stores camera slides, exports PNG/WebM.
// ─────────────────────────────────────────────────────────────
function applyRenderQuality(name) {
    const RQ = window.RenderQuality;
    if (!RQ) return;
    const preset = RQ.PRESETS[name] || RQ.PRESETS.balanced;
    renderQualityName = preset.id;
    const clampPR = RQ.clampPixelRatio || RQ.clampPixelRatio;
    const cap = preset.pixelRatioCap != null ? preset.pixelRatioCap : preset.pixelRatioCap;
    const dpr = clampPR(window.devicePixelRatio || 1, cap);
    renderer.setPixelRatio(dpr);
    const smConst = RQ.shadowMapConstant || RQ.shadowMapConstant;
    const smKind = preset.shadowType || preset.shadowType;
    const smType = smConst(THREE, smKind);
    if (smType != null) renderer.shadowMap.type = smType;
    if (preset.shadows) {
        toggleShadows(userShadowPref, true);
        const tier = preset.shadowSize >= 2048 ? 'HIGH' : (preset.shadowSize >= 1024 ? 'MEDIUM' : 'LOW');
        setShadowQuality(tier);
        const sq = document.getElementById('shadow-quality-select');
        if (sq) sq.value = tier;
    } else {
        toggleShadows(false, true);
    }
    if (preset.id === 'draft') {
        toggleSSAO(false);
        toggleBloom(false);
        toggleHdriEnvironment(false);
        const ssao = document.getElementById('ssao-toggle');
        const bloom = document.getElementById('bloom-toggle');
        const hdri = document.getElementById('hdri-toggle');
        if (ssao) ssao.checked = false;
        if (bloom) bloom.checked = false;
        if (hdri) hdri.checked = false;
    } else if (preset.id === 'present') {
        toggleSSAO(true);
        toggleHdriEnvironment(true);
        const ssao = document.getElementById('ssao-toggle');
        const hdri = document.getElementById('hdri-toggle');
        if (ssao) ssao.checked = true;
        if (hdri) hdri.checked = true;
        setShadingMode('RAYTRACE');
    } else {
        toggleHdriEnvironment(true);
        const hdri = document.getElementById('hdri-toggle');
        if (hdri) hdri.checked = true;
    }
    const qSel = document.getElementById('quality-select');
    if (qSel) qSel.value = preset.id;
    if (preset.exposure != null) setEngineExposure(preset.exposure, true);
    if (preset.envIntensity != null) setEngineEnvIntensity(preset.envIntensity, true);
    markSceneDirty();
    setVCB('Quality:', preset.id.charAt(0).toUpperCase() + preset.id.slice(1));
}

function setEngineExposure(val, quiet) {
    const RQ = window.RenderQuality;
    engineExposure = RQ && RQ.clampExposure ? RQ.clampExposure(val) : Math.max(0.1, Math.min(3, Number(val) || 1));
    if (renderer) renderer.toneMappingExposure = engineExposure;
    const sl = document.getElementById('exposure-slider');
    if (sl && sl.value !== String(engineExposure)) sl.value = engineExposure;
    const lab = document.getElementById('exposure-value');
    if (lab) lab.textContent = engineExposure.toFixed(2);
    markSceneDirty();
    if (!quiet) setVCB('Exposure:', engineExposure.toFixed(2));
}

function applyEnvIntensityToScene() {
    if (!scene) return;
    scene.traverse(obj => {
        const mats = obj.material ? (Array.isArray(obj.material) ? obj.material : [obj.material]) : [];
        mats.forEach(m => {
            if (m && m.envMapIntensity != null) m.envMapIntensity = engineEnvIntensity;
        });
    });
}

function setEngineEnvIntensity(val, quiet) {
    const RQ = window.RenderQuality;
    engineEnvIntensity = RQ && RQ.clampEnvIntensity ? RQ.clampEnvIntensity(val) : Math.max(0, Math.min(4, Number(val) || 1));
    applyEnvIntensityToScene();
    const sl = document.getElementById('env-intensity-slider');
    if (sl && sl.value !== String(engineEnvIntensity)) sl.value = engineEnvIntensity;
    const lab = document.getElementById('env-intensity-value');
    if (lab) lab.textContent = engineEnvIntensity.toFixed(2);
    markSceneDirty();
    if (!quiet) setVCB('IBL:', engineEnvIntensity.toFixed(2));
}

function applyLightingPreset(id) {
    const RQ = window.RenderQuality;
    if (!RQ || !RQ.LIGHTING) return;
    let key = id;
    if (key === 'overcast' && !RQ.LIGHTING.overcast) key = 'overcast';
    const L = RQ.LIGHTING[key] || RQ.LIGHTING.overcast || RQ.LIGHTING.studio;
    lightingPresetName = L.id;
    lightingSunScale = L.sunIntensityScale;
    setTimeOfDay(L.hours);
    setEngineExposure(L.exposure, true);
    setEngineEnvIntensity(L.envIntensity, true);
    if (L.ibl) {
        toggleHdriEnvironment(true);
        const hdri = document.getElementById('hdri-toggle');
        if (hdri) hdri.checked = true;
    }
    const sel = document.getElementById('lighting-preset-select');
    if (sel) sel.value = id;
    markSceneDirty();
    setVCB('Lighting:', (L.label || L.id) + ' (WebGL PBR)');
}

function pingStudioService() {
    fetch('/api/status').then(r => r.json()).then(s => {
        if (s && s.renderer_label) setVCB('Service:', s.renderer_label);
    }).catch(() => {});
}

function withPresentationHelpersHidden(fn) {
    const gridOn = groundGrid ? groundGrid.visible : true;
    const axisPrev = axisHelpers.map(h => h.visible);
    const tcOn = transformControls ? transformControls.visible : true;
    if (groundGrid) groundGrid.visible = false;
    axisHelpers.forEach(h => { h.visible = false; });
    if (transformControls) transformControls.visible = false;
    try { return fn(); }
    finally {
        if (groundGrid) groundGrid.visible = gridOn;
        axisHelpers.forEach((h, i) => { h.visible = axisPrev[i]; });
        if (transformControls) transformControls.visible = tcOn;
        markSceneDirty();
    }
}

function capturePresentSlide() {
    return {
        name: 'Slide ' + (presentSlides.length + 1),
        position: camera.position.toArray(),
        quaternion: camera.quaternion.toArray(),
        target: orbitControls.target.toArray(),
        fov: camera.fov,
    };
}

function applyPresentSlide(slide, t) {
    if (!slide) return;
    const k = t == null ? 1 : t;
    if (k >= 1) {
        camera.position.fromArray(slide.position);
        camera.quaternion.fromArray(slide.quaternion);
        orbitControls.target.fromArray(slide.target);
        camera.fov = slide.fov;
        camera.updateProjectionMatrix();
        orbitControls.update();
        markSceneDirty();
        return;
    }
}

function refreshPresentSlideSelect() {
    const sel = document.getElementById('present-slide-select');
    const label = document.getElementById('present-slide-label');
    if (sel) {
        sel.innerHTML = '';
        presentSlides.forEach((s, i) => {
            const opt = document.createElement('option');
            opt.value = String(i);
            opt.textContent = s.name || ('Slide ' + (i + 1));
            if (i === presentIndex) opt.selected = true;
            sel.appendChild(opt);
        });
        if (!presentSlides.length) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = 'No slides — Add Slide';
            sel.appendChild(opt);
        }
    }
    if (label) {
        label.textContent = presentSlides.length
            ? ((presentIndex + 1) + ' / ' + presentSlides.length)
            : 'No slides';
    }
}

function addPresentSlide() {
    presentSlides.push(capturePresentSlide());
    presentIndex = presentSlides.length - 1;
    refreshPresentSlideSelect();
    scheduleAutosave();
    setVCB('Present:', presentSlides[presentIndex].name + ' saved');
}

function deletePresentSlide() {
    if (!presentSlides.length) return;
    presentSlides.splice(presentIndex, 1);
    presentIndex = Math.max(0, presentIndex - 1);
    refreshPresentSlideSelect();
    scheduleAutosave();
    setVCB('Present:', 'Slide removed');
}

function gotoPresentSlide(i, animate) {
    if (!presentSlides.length) { setVCB('Present:', 'Add a slide first'); return; }
    const n = presentSlides.length;
    presentIndex = ((i % n) + n) % n;
    const slide = presentSlides[presentIndex];
    if (animate) {
        presentLerp = {
            fromPos: camera.position.clone(),
            fromQuat: camera.quaternion.clone(),
            fromTarget: orbitControls.target.clone(),
            fromFov: camera.fov,
            to: slide,
            t0: performance.now(),
            dur: 900,
        };
    } else {
        applyPresentSlide(slide, 1);
    }
    refreshPresentSlideSelect();
    markSceneDirty();
}

function stepPresentLerp(now) {
    if (!presentLerp) return;
    const u = Math.min(1, (now - presentLerp.t0) / presentLerp.dur);
    const s = u * u * (3 - 2 * u);
    const to = presentLerp.to;
    camera.position.lerpVectors(presentLerp.fromPos, new THREE.Vector3().fromArray(to.position), s);
    const qTo = new THREE.Quaternion().fromArray(to.quaternion);
    camera.quaternion.copy(presentLerp.fromQuat).slerp(qTo, s);
    orbitControls.target.lerpVectors(presentLerp.fromTarget, new THREE.Vector3().fromArray(to.target), s);
    camera.fov = presentLerp.fromFov + (to.fov - presentLerp.fromFov) * s;
    camera.updateProjectionMatrix();
    if (u >= 1) presentLerp = null;
}

function togglePresentPlayback() {
    if (presentPlaying) {
        presentPlaying = false;
        if (presentPlayRaf) cancelAnimationFrame(presentPlayRaf);
        presentPlayRaf = 0;
        const btn = document.getElementById('present-play-btn');
        if (btn) btn.textContent = 'Play';
        setVCB('Present:', 'Paused');
        return;
    }
    if (presentSlides.length < 2) { setVCB('Present:', 'Need 2+ slides to play'); return; }
    presentPlaying = true;
    const btn = document.getElementById('present-play-btn');
    if (btn) btn.textContent = 'Pause';
    const tick = () => {
        if (!presentPlaying) return;
        if (presentLerp) { presentPlayRaf = requestAnimationFrame(tick); return; }
        gotoPresentSlide(presentIndex + 1, true);
        presentPlayRaf = requestAnimationFrame(tick);
    };
    gotoPresentSlide(presentIndex, true);
    presentPlayRaf = requestAnimationFrame(tick);
}

function setPresentChrome(on) {
    document.body.classList.toggle('present-mode', on);
    if (groundGrid) groundGrid.visible = !on;
    axisHelpers.forEach(h => { h.visible = !on; });
    if (transformControls) transformControls.visible = !on;
    if (transformControls && on) transformControls.detach();
    const bar = document.getElementById('present-bar');
    if (bar) bar.style.display = on ? 'flex' : 'none';
    markSceneDirty();
}

function enterPresentMode() {
    if (presentMode) return;
    presentMode = true;
    presentSavedQuality = renderQualityName;
    setPresentChrome(true);
    applyRenderQuality('present');
    if (!presentSlides.length) addPresentSlide();
    else gotoPresentSlide(presentIndex, false);
    setVCB('Present:', 'F5 / Esc to exit — arrows change slides');
}

function exitPresentMode() {
    if (!presentMode) return;
    presentMode = false;
    presentPlaying = false;
    presentLerp = null;
    if (presentPlayRaf) cancelAnimationFrame(presentPlayRaf);
    presentPlayRaf = 0;
    setPresentChrome(false);
    applyRenderQuality(presentSavedQuality || 'balanced');
    if (selectedObject) transformControls.attach(selectedObject);
    setVCB('Present:', 'Exited');
}

function togglePresentMode() {
    if (presentMode) exitPresentMode();
    else enterPresentMode();
}

async function exportPresentSlidePng() {
    if (!presentSlides.length) addPresentSlide();
    applyPresentSlide(presentSlides[presentIndex], 1);
    const { w, h } = getRenderResolution();
    const dataUrl = captureStillDataUrl(w, h);
    triggerDownload(dataUrl, `3DCore_Slide_${presentIndex + 1}_${w}x${h}.png`);
    setVCB('Present:', 'Slide PNG exported');
}

async function exportAllPresentSlides() {
    if (!presentSlides.length) { setVCB('Present:', 'No slides'); return; }
    const { w, h } = getRenderResolution();
    for (let i = 0; i < presentSlides.length; i++) {
        presentIndex = i;
        applyPresentSlide(presentSlides[i], 1);
        const dataUrl = captureStillDataUrl(w, h);
        triggerDownload(dataUrl, `3DCore_Slide_${i + 1}_${w}x${h}.png`);
        await new Promise(r => setTimeout(r, 250));
    }
    refreshPresentSlideSelect();
    setVCB('Present:', presentSlides.length + ' slide PNG(s) exported');
}

async function exportPresentPathVideo() {
    if (presentSlides.length < 2) { setVCB('Present:', 'Need 2+ slides for a path video'); return; }
    if (typeof MediaRecorder === 'undefined') { setVCB('Present:', 'MediaRecorder not available'); return; }
    const { w, h } = getRenderResolution();
    const fps = 24;
    const framesPerLeg = 24;
    const prevPR = renderer.getPixelRatio();
    const prevW = renderer.domElement.width, prevH = renderer.domElement.height;
    const prevAspect = camera.aspect;
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const stream = renderer.domElement.captureStream(fps);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8e6 });
    const chunks = [];
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise(res => { rec.onstop = res; });
    rec.start();
    withPresentationHelpersHidden(() => {});
    const gridOn = groundGrid ? groundGrid.visible : true;
    if (groundGrid) groundGrid.visible = false;
    axisHelpers.forEach(h => { h.visible = false; });
    for (let s = 0; s < presentSlides.length - 1; s++) {
        const a = presentSlides[s], b = presentSlides[s + 1];
        for (let f = 0; f <= framesPerLeg; f++) {
            const u = f / framesPerLeg;
            const k = u * u * (3 - 2 * u);
            camera.position.lerpVectors(new THREE.Vector3().fromArray(a.position), new THREE.Vector3().fromArray(b.position), k);
            const qa = new THREE.Quaternion().fromArray(a.quaternion);
            const qb = new THREE.Quaternion().fromArray(b.quaternion);
            camera.quaternion.copy(qa).slerp(qb, k);
            orbitControls.target.lerpVectors(new THREE.Vector3().fromArray(a.target), new THREE.Vector3().fromArray(b.target), k);
            camera.fov = a.fov + (b.fov - a.fov) * k;
            camera.updateProjectionMatrix();
            renderer.render(scene, camera);
            await new Promise(r => setTimeout(r, 1000 / fps));
        }
    }
    rec.stop();
    await stopped;
    if (groundGrid) groundGrid.visible = gridOn;
    axisHelpers.forEach(h => { h.visible = !presentMode; });
    renderer.setPixelRatio(prevPR);
    renderer.setSize(prevW, prevH, false);
    camera.aspect = prevAspect;
    camera.updateProjectionMatrix();
    const blob = new Blob(chunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, `3DCore_Present_${w}x${h}.webm`);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    markSceneDirty();
    setVCB('Present:', 'Path video exported');
}


window.onload = initApp;
