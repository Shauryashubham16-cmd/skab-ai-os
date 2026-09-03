/* ---------------- IMAGINATION VIEWER (Phase 4) ----------------
   A real, manipulable Three.js scene built from the structured scene graph
   utils/imaginationEngine.js proposes/edits — not a generated image. Every
   object is one of a fixed set of primitive shapes (see buildObjectMesh);
   the LLM only ever chooses type/position/scale/color, never raw geometry,
   so a bad response can't crash the renderer — imaginationEngine.js's
   sanitizeScene() also clamps everything server-side before it gets here. */
const imaginationOverlay = document.getElementById('imaginationOverlay');
const imaginationCanvasWrap = document.getElementById('imaginationCanvasWrap');
const imaginationEmpty = document.getElementById('imaginationEmpty');
const imaginationLoading = document.getElementById('imaginationLoading');
const imaginationLoadingLabel = document.getElementById('imaginationLoadingLabel');
const imaginationStatus = document.getElementById('imaginationStatus');
const imaginationInput = document.getElementById('imaginationInput');
const imaginationGoBtn = document.getElementById('imaginationGoBtn');
const imaginationScreenBtn = document.getElementById('imaginationScreenBtn');
const imaginationNewBtn = document.getElementById('imaginationNewBtn');
const imaginationClose = document.getElementById('imaginationClose');

let imag3d = null; // { scene, camera, renderer, controls, group, rafId, resizeObserver }
let imaginationVisible = false; // gates the render loop — see animate() in ensureImaginationEngine()
let imaginationCurrentScene = null; // last scene graph rendered, for conversational edits
let imaginationBusy = false;

function ensureImaginationEngine(){
  if (imag3d || typeof THREE === 'undefined') return;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
  camera.position.set(22, 18, 26);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  imaginationCanvasWrap.insertBefore(renderer.domElement, imaginationEmpty);

  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 6;
  controls.maxDistance = 90;
  controls.maxPolarAngle = Math.PI * 0.49; // don't let the camera dip below the ground

  const ambient = new THREE.AmbientLight(0xffffff, 0.55);
  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(30, 40, 20);
  scene.add(ambient, sun);

  const group = new THREE.Group(); // everything sanitizeScene() produced lives here, cleared/rebuilt per render
  scene.add(group);

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(40, 48),
    new THREE.MeshStandardMaterial({ color: 0x3a6b4a, roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  function animate(){
    // Paused (not scheduling further frames) whenever the overlay is
    // closed — openImagination()/closeImagination() flip imaginationVisible
    // and restart the loop on reopen. Without this the renderer kept
    // drawing an invisible scene every frame indefinitely once opened once.
    if (!imaginationVisible) { imag3d.rafId = null; return; }
    controls.update();
    renderer.render(scene, camera);
    imag3d.rafId = requestAnimationFrame(animate);
  }

  imag3d = { scene, camera, renderer, controls, group, ambient, sun, ground, ambientLight: ambient, sunLight: sun, animate, rafId: null };
  animate();

  // Canvas fills its wrap; resize the renderer/camera whenever that wrap's
  // size changes (overlay open/close, window resize) rather than polling.
  const ro = new ResizeObserver(() => resizeImaginationEngine());
  ro.observe(imaginationCanvasWrap);
  imag3d.resizeObserver = ro;
  resizeImaginationEngine();
}

function resizeImaginationEngine(){
  if (!imag3d) return;
  const w = imaginationCanvasWrap.clientWidth || 1;
  const h = imaginationCanvasWrap.clientHeight || 1;
  imag3d.camera.aspect = w / h;
  imag3d.camera.updateProjectionMatrix();
  imag3d.renderer.setSize(w, h);
}

// type -> a small Three.js primitive mesh (or group of primitives). Anything
// the LLM proposes is one of these types only (imaginationEngine.js's
// OBJECT_TYPES) — no free-form geometry ever reaches the renderer.
function buildObjectMesh(obj){
  const color = new THREE.Color(obj.color || '#8899aa');
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.15 });
  const emissiveMat = () => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.5, roughness: 0.4 });
  let mesh;
  switch (obj.type) {
    case 'building':
      mesh = new THREE.Mesh(new THREE.BoxGeometry(1.6, 3.2, 1.6), mat);
      mesh.position.y = 1.6;
      break;
    case 'tower':
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.9, 5, 10), mat);
      mesh.position.y = 2.5;
      break;
    case 'tree': {
      const g = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 1, 6), new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 0.9 }));
      trunk.position.y = 0.5;
      const leaves = new THREE.Mesh(new THREE.ConeGeometry(0.9, 1.8, 8), mat);
      leaves.position.y = 1.6;
      g.add(trunk, leaves);
      mesh = g;
      break;
    }
    case 'drone': {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8), emissiveMat());
      const rotorGeo = new THREE.TorusGeometry(0.32, 0.03, 6, 16);
      const rotorMat = new THREE.MeshStandardMaterial({ color: 0x222831 });
      [[0.4, 0, 0.4], [-0.4, 0, 0.4], [0.4, 0, -0.4], [-0.4, 0, -0.4]].forEach(([x, y, z]) => {
        const r = new THREE.Mesh(rotorGeo, rotorMat);
        r.position.set(x, y, z);
        r.rotation.x = Math.PI / 2;
        g.add(r);
      });
      g.add(body);
      mesh = g;
      break;
    }
    case 'car':
      mesh = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.4, 0.5), mat);
      mesh.position.y = 0.25;
      break;
    case 'flyingCar': {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.35, 0.5), emissiveMat());
      const glowRing = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.03, 6, 16), new THREE.MeshStandardMaterial({ color: 0x37f2ff, emissive: 0x37f2ff, emissiveIntensity: 0.8 }));
      glowRing.rotation.x = Math.PI / 2;
      glowRing.position.y = -0.2;
      g.add(body, glowRing);
      mesh = g;
      break;
    }
    case 'road':
      mesh = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.05, 10), new THREE.MeshStandardMaterial({ color: 0x22262e, roughness: 0.9 }));
      break;
    case 'panel':
      mesh = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.06, 0.9), new THREE.MeshStandardMaterial({ color, metalness: 0.6, roughness: 0.3 }));
      mesh.rotation.x = -Math.PI / 8;
      mesh.position.y = 0.6;
      break;
    case 'person':
      mesh = new THREE.Mesh(new THREE.CapsuleGeometry ? new THREE.CapsuleGeometry(0.18, 0.6, 4, 8) : new THREE.CylinderGeometry(0.18, 0.18, 1, 8), mat);
      mesh.position.y = 0.6;
      break;
    case 'water':
      mesh = new THREE.Mesh(new THREE.BoxGeometry(3, 0.05, 3), new THREE.MeshStandardMaterial({ color: 0x2266aa, roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.85 }));
      break;
    case 'sphere':
      mesh = new THREE.Mesh(new THREE.SphereGeometry(0.8, 16, 12), mat);
      mesh.position.y = 0.8;
      break;
    default:
      mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
      mesh.position.y = 0.5;
  }
  mesh.position.x += obj.x;
  mesh.position.z += obj.z;
  mesh.position.y += obj.y;
  mesh.rotation.y = obj.rotationY || 0;
  const s = obj.scale || 1;
  mesh.scale.set(s, s, s);
  return mesh;
}

// Rebuilds the whole object group + lighting/sky/ground from a scene graph.
// Simple full-rebuild rather than a diff against the previous group — these
// scenes are at most ~24 objects, so this is cheap, and it means a scene
// graph is always the single source of truth for what's on screen (no
// drift between incremental patches and what the JSON actually says).
function renderSceneGraph(graph){
  ensureImaginationEngine();
  if (!imag3d) return;
  imaginationCurrentScene = graph;
  imaginationEmpty.style.display = 'none';

  while (imag3d.group.children.length) imag3d.group.remove(imag3d.group.children[0]);
  graph.objects.forEach((obj) => imag3d.group.add(buildObjectMesh(obj)));

  imag3d.ground.material.color.set(graph.ground?.color || '#3a6b4a');

  const skyColors = { day: 0x1a2842, night: 0x03060d, dusk: 0x2a1830 };
  const fogColors = { day: 0x0a1626, night: 0x020306, dusk: 0x140a1c };
  const sunIntensity = { day: 0.9, night: 0.15, dusk: 0.5 };
  const ambientIntensity = { day: 0.55, night: 0.18, dusk: 0.35 };
  const sky = graph.sky || 'day';
  imag3d.renderer.setClearColor(skyColors[sky] ?? skyColors.day, 1);
  imag3d.scene.fog = new THREE.Fog(fogColors[sky] ?? fogColors.day, 30, 90);
  imag3d.sunLight.intensity = sunIntensity[sky] ?? 0.9;
  imag3d.ambientLight.intensity = ambientIntensity[sky] ?? 0.55;
  imag3d.sunLight.color.set(sky === 'night' ? 0x6688ff : sky === 'dusk' ? 0xff9a5a : 0xffffff);

  imaginationStatus.textContent = `${graph.objects.length} object(s) — ${sky}${graph.notes ? ` · ${graph.notes}` : ''}`;
  resizeImaginationEngine();
}

function setImaginationBusy(busy, label){
  imaginationBusy = busy;
  imaginationLoading.classList.toggle('active', busy);
  if (label) imaginationLoadingLabel.textContent = label;
  [imaginationGoBtn, imaginationScreenBtn, imaginationNewBtn, imaginationInput].forEach((el) => { el.disabled = busy; });
}

// Opens the overlay. If `scene` is passed (e.g. the chat /imagine command's
// response), renders it immediately; otherwise reopens on whatever scene
// was already loaded, or the empty state if none yet.
function openImagination(scene){
  imaginationOverlay.classList.add('open');
  imaginationVisible = true;
  ensureImaginationEngine();
  resizeImaginationEngine();
  if (imag3d && imag3d.rafId == null) imag3d.animate(); // resume the render loop if a prior close paused it
  if (scene) renderSceneGraph(scene);
  else if (imaginationCurrentScene) renderSceneGraph(imaginationCurrentScene);
  else imaginationEmpty.style.display = 'flex';
}

function closeImagination(){
  imaginationOverlay.classList.remove('open');
  imaginationVisible = false; // animate()'s next frame check stops the render loop
}

async function requestScene(prompt){
  if (imaginationBusy || !prompt.trim()) return;
  const editing = !!imaginationCurrentScene;
  setImaginationBusy(true, editing ? 'Updating the scene…' : 'Building the scene…');
  try {
    const res = await fetch(editing ? '/api/imagination/edit' : '/api/imagination/scene', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editing ? { scene: imaginationCurrentScene, instruction: prompt } : { prompt }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Imagination request failed');
    renderSceneGraph(data.scene);
    reactorBurst();
  } catch (err) {
    imaginationStatus.textContent = `Error: ${err.message}`;
  } finally {
    setImaginationBusy(false);
  }
}

async function requestSceneFromScreen(instruction){
  if (imaginationBusy) return;
  setImaginationBusy(true, 'Looking at your screen…');
  try {
    const res = await fetch('/api/imagination/from-screen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(instruction ? { instruction } : {}),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Could not build a scene from the screen');
    renderSceneGraph(data.scene);
    reactorBurst();
  } catch (err) {
    imaginationStatus.textContent = `Error: ${err.message}`;
  } finally {
    setImaginationBusy(false);
  }
}

imaginationGoBtn.addEventListener('click', () => { const v = imaginationInput.value; imaginationInput.value = ''; requestScene(v); });
imaginationInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const v = imaginationInput.value; imaginationInput.value = ''; requestScene(v); }
});
imaginationScreenBtn.addEventListener('click', () => { const v = imaginationInput.value; imaginationInput.value = ''; requestSceneFromScreen(v); });
imaginationNewBtn.addEventListener('click', () => {
  imaginationCurrentScene = null;
  imaginationStatus.textContent = 'Describe a scene below to begin';
  if (imag3d) { while (imag3d.group.children.length) imag3d.group.remove(imag3d.group.children[0]); }
  imaginationEmpty.style.display = 'flex';
  imaginationInput.focus();
});
imaginationClose.addEventListener('click', closeImagination);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && imaginationOverlay.classList.contains('open')) closeImagination();
});
