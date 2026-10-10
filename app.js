// Point cloud viewer for our VRML exports (.wrz / .wrl).
// Classic script (no ES modules) so it also runs from file://. Depends on window.THREE,
// THREE.OrbitControls, window.pako and window.parseVRML.
(function () {
'use strict';

// ---- Look: one look for every model -------------------------------------------------------
// All models are drawn the same way, whatever their file's Material says: white points and a
// white outline. Points are drawn as light-absorbing "optical depth": every point adds
// POINT_DEPTH to the pixels under it (splatted with sub-pixel weights, so the regular point
// lattice doesn't alias into moire), and a pixel shows POINT_BRIGHTNESS * (1 - e^-depth). That
// is alpha blending of identical points, just order-independent and anti-aliased.
// Calibrated against the Sketchfab proofs of 8RMO, 8RON, ACR and Test-Pattern: first fitted on
// pixel statistics, then the density set by eye side by side with the proofs (perceived
// brightness depends on the surroundings, which pixel statistics don't capture).
const POINT_DEPTH = 0.038; // per point, at the reference scale below
const POINT_BRIGHTNESS = 0.9;
const OUTLINE_OPACITY = 0.5;
const BACKGROUND_COLOR = 0x000000;

// How bright a region looks depends on how many points overlap each pixel, i.e. on the
// scale. POINT_DEPTH gives the Sketchfab look at the scale of its proofs (camera 1550 mm away,
// 5 degree lens, 700 px canvas). Each model's starting view is drawn at its own scale (size
// curve, window size), so point depth is scaled by that view's footprint ratio, (reference mm
// per pixel / starting view's mm per pixel)^2: every model, large or small, opens at the
// proofs' brightness. The factor is fixed while zooming, so as in Sketchfab zooming out packs
// more points into each pixel and brightens the image, and zooming in dims it.
const REFERENCE_MM_PER_PX = (2 * 1550 * Math.tan((5 * Math.PI) / 360)) / 700;

// ---- Scale: consistent sizes, compressed at the extremes -----------------------------------
// Models are never auto-fit. A model's size on screen follows its physical size (largest
// bounding-box dimension, in mm) along one fixed curve, so a bigger piece always looks bigger:
//  - between LINEAR_MIN_MM and LINEAR_MAX_MM (typical pieces) screen size is proportional to
//    physical size, anchored so a REFERENCE_EXTENT_MM piece (8RON, 100 mm) spans REFERENCE_FILL
//    of the canvas' shorter side;
//  - outside that band screen size changes only with (size ratio)^EXTREME_EXPONENT, so very
//    large pieces (CAMM_8, 200 mm) still fit and very small ones (20-30 mm) stay visible.
const CAMERA_FOV_DEG = 5; // same narrow, near-orthographic lens as the Sketchfab proofs
const REFERENCE_EXTENT_MM = 100;
const REFERENCE_FILL = 0.6;
const LINEAR_MIN_MM = 60;
const LINEAR_MAX_MM = 120;
const EXTREME_EXPONENT = 0.4;

// Fraction of the canvas' shorter side that a piece of the given extent spans.
function screenFill(extentMm) {
  const e = Math.max(extentMm, 1e-3);
  const clamped = Math.min(LINEAR_MAX_MM, Math.max(LINEAR_MIN_MM, e));
  return REFERENCE_FILL * (clamped / REFERENCE_EXTENT_MM) * Math.pow(e / clamped, EXTREME_EXPONENT);
}

// Camera distance at which a piece of the given extent spans screenFill(extent).
function viewDistanceFor(extentMm) {
  return extentMm / screenFill(extentMm) / (2 * Math.tan((CAMERA_FOV_DEG * Math.PI) / 360));
}
const DEFAULT_VIEW_DISTANCE = viewDistanceFor(REFERENCE_EXTENT_MM);

// ---- Resolution and performance ------------------------------------------------------------
// Frames are drawn only when something changes. Points are accumulated at one sample per CSS
// pixel whatever the screen's pixel density (then smoothly upscaled), which is how Sketchfab's
// look behaves too: drawn per Retina pixel, the regular point lattice showed through as grain
// and looked harsher. It also keeps the expensive part (blending millions of points) cheap on
// Retina screens. The outline and the final image use the full device resolution.
const MAX_PIXEL_RATIO = 2;

// Camera direction from the model for each view button. The camera keeps +Y as its up axis,
// like OrbitControls; at the poles (top/bottom) that leaves -Z / +Z pointing up on screen.
const VIEW_PRESETS = {
  front:  [0, 0, 1],
  back:   [0, 0, -1],
  left:   [-1, 0, 0],
  right:  [1, 0, 0],
  top:    [0, 1, 0],
  bottom: [0, -1, 0],
};

// View-button transitions orbit the camera there (and zoom back to the model's starting
// distance) instead of jumping. Duration grows with how far it has to turn and zoom.
const VIEW_ANIMATION_MIN_MS = 350;
const VIEW_ANIMATION_MAX_MS = 1000;

// Edge and corner cubes are shown the way they are seen on a desk: the side views (front,
// back, left, right) look down on them from this many degrees above horizontal. Top and
// bottom still look straight down / up. Ordinary blocks are viewed horizontally.
const CUT_CUBE_VIEW_ELEVATION_DEG = 30;

// ---- Zoom -------------------------------------------------------------------------------
// The mouse wheel is handled here rather than by OrbitControls, whose wheel step is divided
// by devicePixelRatio (so a notch zoomed only ~2.5% on Retina screens) and ignores wheel
// events reported in lines. One wheel notch (~100 px of delta) changes the distance by
// ZOOM_PER_NOTCH; trackpad scrolling and pinching scale with their deltas. The camera glides
// to each new distance with time constant ZOOM_GLIDE_MS (0 = jump).
const ZOOM_PER_NOTCH = 1.15;
const PINCH_ZOOM_BOOST = 4; // a trackpad pinch arrives as ctrl+wheel with small deltas
const ZOOM_GLIDE_MS = 60;

const statusEl = document.getElementById('status');
const statusTextEl = document.getElementById('status-text');
const openBtn = document.getElementById('open-btn');
const fileInput = document.getElementById('file-input');
const titleEl = document.getElementById('viewer-title');
const readoutEl = document.getElementById('view-readout');

function setStatus(text, { error = false, offerOpen = false } = {}) {
  statusTextEl.textContent = text;
  statusEl.classList.toggle('error', error);
  openBtn.hidden = !offerOpen;
  statusEl.classList.remove('hidden');
}

function hideStatus() {
  statusEl.classList.add('hidden');
}

// Lets the browser paint the status text before a long synchronous step.
function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function isGzip(bytes) {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

// ---- Edge and corner cubes ----------------------------------------------------------------
// Some blocks have one edge or one corner cut off and stand on that cut. They are recognized
// from the outline: its drawn vertices are the bounding-box corners that remain plus extra
// vertices on the cut. The cut's outward normal is turned to point straight down (the block rests on
// it), then the block is spun about the vertical so its data front (+Z, the side the VRML
// Front viewpoint looks at) faces the Front camera as closely as possible. All view buttons
// are then relative to the standing block. Returns null for ordinary blocks.
function restingPose(lineSets) {
  // Only vertices the outline actually draws: templates may still list a cut-off corner.
  const vertices = [];
  for (const { positions, segments } of lineSets) {
    for (const i of new Set(segments)) {
      vertices.push(new THREE.Vector3(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]));
    }
  }
  if (vertices.length < 4) return null;
  const box = new THREE.Box3().setFromPoints(vertices);
  const size = box.getSize(new THREE.Vector3());
  const tol = 1e-3 * Math.max(1, size.x, size.y, size.z);
  const onFace = (v, axis) => Math.abs(v[axis] - box.min[axis]) < tol || Math.abs(v[axis] - box.max[axis]) < tol;
  const isBoxCorner = (v) => onFace(v, 'x') && onFace(v, 'y') && onFace(v, 'z');

  const cut = vertices.filter((v) => !isBoxCorner(v));
  if (cut.length < 3) return null;

  let presentCorners = 0;
  for (let i = 0; i < 8; i++) {
    const corner = new THREE.Vector3(
      i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    if (vertices.some((v) => v.distanceTo(corner) < tol)) presentCorners++;
  }
  const missing = 8 - presentCorners;
  const kind = missing === 2 ? 'edge cube' : missing === 1 ? 'corner cube' : 'cut block';

  // Plane through the cut vertices, normal pointing out of the block.
  const centroid = cut.reduce((sum, v) => sum.add(v), new THREE.Vector3()).divideScalar(cut.length);
  const normal = new THREE.Vector3();
  const cross = new THREE.Vector3();
  for (let i = 0; i < cut.length; i++) {
    for (let j = i + 1; j < cut.length; j++) {
      cross.subVectors(cut[i], centroid).cross(cut[j].clone().sub(centroid));
      if (cross.lengthSq() > normal.lengthSq()) normal.copy(cross);
    }
  }
  if (normal.lengthSq() === 0) return null;
  normal.normalize();
  if (normal.dot(centroid.clone().sub(box.getCenter(new THREE.Vector3()))) < 0) normal.negate();

  const quaternion = new THREE.Quaternion().setFromUnitVectors(normal, new THREE.Vector3(0, -1, 0));
  const front = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion);
  if (Math.hypot(front.x, front.z) > 1e-6) {
    const spin = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.atan2(front.x, front.z));
    quaternion.premultiply(spin);
  }
  return { kind, quaternion, outline: vertices };
}

// Adds each point's optical depth into a single-channel float target. A point covers the 2x2
// pixels nearest its exact projected position, weighted bilinearly (weights sum to 1).
const pointVertexShader = `
  uniform vec2 uResolution;
  varying vec2 vCenter;
  void main() {
    vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = clip;
    vCenter = (clip.xy / clip.w * 0.5 + 0.5) * uResolution;
    gl_PointSize = 2.0;
  }
`;
const pointFragmentShader = `
  uniform float uDepth;
  varying vec2 vCenter;
  void main() {
    vec2 w = max(1.0 - abs(gl_FragCoord.xy - vCenter), 0.0);
    gl_FragColor = vec4(w.x * w.y * uDepth, 0.0, 0.0, 1.0);
  }
`;

// Turns accumulated depth into the displayed color (display-space values, no conversion).
const resolveVertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;
const resolveFragmentShader = `
  uniform sampler2D tDepth;
  uniform vec3 uColor;
  varying vec2 vUv;
  void main() {
    float depth = texture2D(tDepth, vUv).r;
    gl_FragColor = vec4(uColor * (1.0 - exp(-depth)), 1.0);
  }
`;

class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      // No MSAA and no depth buffer: MSAA made blending ~8x slower on integrated GPUs, and
      // nothing here needs depth testing.
      antialias: false,
      depth: false,
      powerPreference: 'high-performance', // use the discrete GPU on dual-GPU laptops
    });
    this.renderer.setClearColor(BACKGROUND_COLOR, 1);
    this.renderer.autoClear = false;

    // Point depth is accumulated in full float precision where blending it is supported;
    // half floats would drop the tiny per-point increments of a zoomed-out view.
    const floatBlend = !!this.renderer.extensions.get('EXT_float_blend');
    // Upscaling to the device resolution filters the depth texture; float32 textures need an
    // extension for that (half floats don't).
    const smooth = !floatBlend || !!this.renderer.extensions.get('OES_texture_float_linear');
    this.depthTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: floatBlend ? THREE.FloatType : THREE.HalfFloatType,
      format: THREE.RedFormat,
      minFilter: smooth ? THREE.LinearFilter : THREE.NearestFilter,
      magFilter: smooth ? THREE.LinearFilter : THREE.NearestFilter,
      depthBuffer: false,
    });

    this.pointScene = new THREE.Scene();
    this.pointGroup = new THREE.Group();
    this.pointScene.add(this.pointGroup);
    this.pointMaterial = new THREE.ShaderMaterial({
      uniforms: { uResolution: { value: new THREE.Vector2() }, uDepth: { value: 0 } },
      vertexShader: pointVertexShader,
      fragmentShader: pointFragmentShader,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.pointDepth = POINT_DEPTH;
    this.densityTweak = 1; // [ / ] while the readout is shown: try out a different point density

    this.resolveMaterial = new THREE.ShaderMaterial({
      uniforms: { tDepth: { value: this.depthTarget.texture }, uColor: { value: new THREE.Color().setScalar(POINT_BRIGHTNESS) } },
      vertexShader: resolveVertexShader,
      fragmentShader: resolveFragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.resolveMaterial);
    quad.frustumCulled = false;
    this.resolveScene = new THREE.Scene();
    this.resolveScene.add(quad);
    this.resolveCamera = new THREE.Camera();

    this.lineScene = new THREE.Scene();
    this.lineGroup = new THREE.Group();
    this.lineScene.add(this.lineGroup);

    this.fovDeg = CAMERA_FOV_DEG;
    this.viewElevation = 0; // radians above horizontal for the side views
    this.viewDistance = DEFAULT_VIEW_DISTANCE;
    this.camera = new THREE.PerspectiveCamera(this.fovDeg, 1, 1, DEFAULT_VIEW_DISTANCE * 100);

    this.controls = new THREE.OrbitControls(this.camera, canvas);
    this.controls.enableDamping = false; // stop dead on release instead of drifting

    this.renderQueued = false;
    this.renderNow = this.renderNow.bind(this);

    this.animation = null;
    this.zoomDistance = null; // distance a wheel zoom is gliding to
    this.lastFrameTime = 0;
    this.controls.addEventListener('start', () => {
      this.animation = null; // grabbing the model stops a view transition where it is
      this.zoomDistance = null;
    });
    this.controls.addEventListener('change', () => this.requestRender());

    // Capture phase on the parent, so the wheel never reaches OrbitControls' own handler.
    canvas.parentElement.addEventListener('wheel', (e) => this.onWheel(e), { capture: true, passive: false });

    new ResizeObserver(() => this.requestRender()).observe(canvas);
    this.setView('front');
  }

  setModel({ pointSets, lineSets }) {
    for (const group of [this.pointGroup, this.lineGroup]) {
      for (const child of [...group.children]) {
        child.geometry.dispose();
        if (child.material !== this.pointMaterial) child.material.dispose();
        group.remove(child);
      }
    }

    const box = new THREE.Box3();
    let pointCount = 0;

    for (const { positions } of pointSets) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.computeBoundingBox();
      box.union(geometry.boundingBox);
      pointCount += positions.length / 3;
      const points = new THREE.Points(geometry, this.pointMaterial);
      points.frustumCulled = false;
      this.pointGroup.add(points);
    }

    for (const { positions, segments } of lineSets) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(segments, 1));
      geometry.computeBoundingBox();
      box.union(geometry.boundingBox);
      this.lineGroup.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
        color: 0xffffff,
        opacity: OUTLINE_OPACITY,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      })));
    }

    // Edge / corner cubes stand on their cut; the outline (the glass block) then defines the
    // extent, since marker points at cut-off corners would lie outside it.
    const pose = restingPose(lineSets);
    const rotation = pose ? pose.quaternion : new THREE.Quaternion();
    if (pose) box.setFromPoints(pose.outline.map((v) => v.clone().applyQuaternion(rotation)));

    // Center the model on the orbit target, whatever its absolute VRML coordinates.
    const center = box.getCenter(new THREE.Vector3()).negate();
    for (const group of [this.pointGroup, this.lineGroup]) {
      group.quaternion.copy(rotation);
      group.position.copy(center);
    }

    const size = box.getSize(new THREE.Vector3());
    const extent = Math.max(size.x, size.y, size.z);
    this.viewDistance = viewDistanceFor(extent);
    this.viewElevation = pose ? (CUT_CUBE_VIEW_ELEVATION_DEG * Math.PI) / 180 : 0;
    this.controls.minDistance = this.viewDistance * 0.05;
    this.controls.maxDistance = this.viewDistance * 4;

    this.setView('front');
    return { pointCount, size, fill: screenFill(extent), kind: pose ? pose.kind : 'block' };
  }

  // Moves the camera to a preset view: an orbit about the model (and a zoom to the model's
  // starting distance) when animate is true, a jump otherwise.
  setView(name, { animate = false } = {}) {
    this.zoomDistance = null;
    const [dx, dy, dz] = VIEW_PRESETS[name];
    const lift = dy === 0 ? this.viewElevation : 0; // side views only; top/bottom stay vertical
    const endOffset = new THREE.Vector3(dx * Math.cos(lift), dy + Math.sin(lift), dz * Math.cos(lift))
      .multiplyScalar(this.viewDistance);
    const end = new THREE.Spherical().setFromVector3(endOffset);
    end.makeSafe(); // same pole clamping as OrbitControls, so both agree on the final pose

    if (!animate) {
      this.animation = null;
      this.controls.target.set(0, 0, 0);
      this.applyOrbit(end, this.controls.target);
      return;
    }

    const start = new THREE.Spherical().setFromVector3(
      this.camera.position.clone().sub(this.controls.target));
    // Turn the short way round.
    let dTheta = end.theta - start.theta;
    dTheta -= Math.round(dTheta / (2 * Math.PI)) * 2 * Math.PI;
    // Near the poles theta barely moves the camera, so don't let it dictate the duration.
    const turn = Math.hypot(end.phi - start.phi, dTheta * Math.sin((start.phi + end.phi) / 2));
    const zoom = Math.abs(Math.log(end.radius / start.radius));
    if (turn < 1e-4 && zoom < 1e-4 && this.controls.target.lengthSq() < 1e-6) return; // already there
    const duration = Math.min(VIEW_ANIMATION_MAX_MS,
      VIEW_ANIMATION_MIN_MS + 450 * (turn / Math.PI) + 300 * zoom);

    this.animation = {
      startTime: performance.now(),
      duration,
      start,
      dPhi: end.phi - start.phi,
      dTheta,
      radiusRatio: end.radius / start.radius,
      startTarget: this.controls.target.clone(),
      spherical: new THREE.Spherical(),
      target: new THREE.Vector3(),
    };
    this.requestRender();
  }

  // Places the camera at `spherical` around `target`, looking at it, and syncs OrbitControls.
  applyOrbit(spherical, target) {
    this.controls.target.copy(target);
    this.camera.position.setFromSpherical(spherical).add(target);
    this.camera.lookAt(target);
    this.controls.update();
    this.requestRender();
  }

  onWheel(event) {
    event.preventDefault();
    event.stopPropagation();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.canvas.clientHeight : 1;
    let delta = event.deltaY * unit;
    if (event.ctrlKey) delta *= PINCH_ZOOM_BOOST;
    if (!delta) return;
    this.animation = null; // zooming takes over from a view transition
    const from = this.zoomDistance ?? this.camera.position.distanceTo(this.controls.target);
    this.zoomDistance = Math.min(this.controls.maxDistance, Math.max(this.controls.minDistance,
      from * Math.pow(ZOOM_PER_NOTCH, delta / 100)));
    this.requestRender();
  }

  // Moves a wheel zoom along toward its target distance; called once per frame before drawing.
  stepZoom(dt) {
    const target = this.controls.target;
    const offset = this.camera.position.clone().sub(target);
    const distance = offset.length();
    const k = ZOOM_GLIDE_MS > 0 ? 1 - Math.exp(-dt / ZOOM_GLIDE_MS) : 1;
    let next = Math.exp(Math.log(distance) + (Math.log(this.zoomDistance) - Math.log(distance)) * k);
    if (Math.abs(Math.log(next / this.zoomDistance)) < 1e-3) {
      next = this.zoomDistance;
      this.zoomDistance = null;
    }
    this.camera.position.copy(target).add(offset.multiplyScalar(next / distance));
    this.controls.update();
    this.requestRender(); // next glide step
  }

  // Advances a running view transition; called once per frame before drawing.
  stepAnimation(now) {
    const a = this.animation;
    const t = Math.min(1, (now - a.startTime) / a.duration);
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // ease in-out
    a.spherical.set(
      a.start.radius * Math.pow(a.radiusRatio, e), // zoom evenly in log space
      a.start.phi + a.dPhi * e,
      a.start.theta + a.dTheta * e);
    a.spherical.makeSafe();
    a.target.copy(a.startTarget).multiplyScalar(1 - e); // recenter if the view was panned
    this.applyOrbit(a.spherical, a.target);
    if (t >= 1) this.animation = null;
  }

  requestRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(this.renderNow);
  }

  // Sizes the drawing buffer for the current state, then draws one frame.
  renderNow(now) {
    this.renderQueued = false;
    now = now || performance.now();
    const dt = Math.min(Math.max(now - this.lastFrameTime, 0), 34); // cap: first frame after idle
    this.lastFrameTime = now;
    if (this.zoomDistance !== null) this.stepZoom(dt);
    if (this.animation) this.stepAnimation(now);
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (!width || !height) return;

    const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    const buffer = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    if (ratio !== this.renderer.getPixelRatio() ||
        buffer.x !== Math.floor(width * ratio) || buffer.y !== Math.floor(height * ratio)) {
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(width, height, false);
    }
    if (this.depthTarget.width !== width || this.depthTarget.height !== height) {
      this.depthTarget.setSize(width, height); // one sample per CSS pixel
      this.pointMaterial.uniforms.uResolution.value.set(width, height);
    }

    // The global scale is defined on the canvas' shorter side, so in a portrait-shaped
    // canvas the lens widens to keep the same horizontal coverage.
    const aspect = width / height;
    const halfFov = (this.fovDeg * Math.PI) / 360;
    const fov = aspect >= 1 ? this.fovDeg : (360 / Math.PI) * Math.atan(Math.tan(halfFov) / aspect);
    if (this.camera.aspect !== aspect || this.camera.fov !== fov) {
      this.camera.aspect = aspect;
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    // Depth each point deposits per CSS pixel, set by the starting view's scale (see
    // REFERENCE_MM_PER_PX), not the current zoom.
    const startMmPerCssPx = (2 * this.viewDistance * Math.tan((fov * Math.PI) / 360)) / height;
    const footprintRatio = (REFERENCE_MM_PER_PX / startMmPerCssPx) ** 2;
    this.pointMaterial.uniforms.uDepth.value = this.pointDepth * footprintRatio * this.densityTweak;

    const renderer = this.renderer;
    renderer.setRenderTarget(this.depthTarget);
    renderer.clear();
    renderer.render(this.pointScene, this.camera);
    renderer.setRenderTarget(null);
    renderer.clear();
    renderer.render(this.resolveScene, this.resolveCamera);
    renderer.render(this.lineScene, this.camera);
    if (!readoutEl.hidden) this.updateReadout();
  }

  // Camera angles around the model, in the same frame as the view buttons: azimuth 0 = Front,
  // +90 = Right, -90 = Left, 180 = Back; elevation is degrees above horizontal.
  updateReadout() {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const distance = offset.length();
    const deg = (rad) => (rad * 180) / Math.PI;
    const azimuth = deg(Math.atan2(offset.x, offset.z));
    const elevation = deg(Math.asin(Math.max(-1, Math.min(1, offset.y / distance))));
    const lines = [
      `azimuth   ${azimuth.toFixed(1).padStart(6)}°`,
      `elevation ${elevation.toFixed(1).padStart(6)}°`,
      `distance  ${distance.toFixed(0).padStart(6)} mm  (zoom ${(this.viewDistance / distance).toFixed(2)}×)`,
    ];
    const t = this.controls.target;
    if (t.lengthSq() > 1e-4) {
      lines.push(`pan       ${[t.x, t.y, t.z].map((v) => v.toFixed(1)).join(', ')} mm`);
    }
    lines.push(`density   ×${this.densityTweak.toFixed(2).padStart(5)}  ([ / ] to adjust)`);
    readoutEl.textContent = lines.join('\n');
  }
}

const viewer = new Viewer(document.getElementById('viewer-canvas'));
window.viewer = viewer; // handy from the devtools console

document.querySelectorAll('.view-btn').forEach((btn) => {
  if (VIEW_PRESETS[btn.dataset.view]) {
    btn.addEventListener('click', () => viewer.setView(btn.dataset.view, { animate: true }));
  }
});

async function showFile(name, loadBytes) {
  try {
    setStatus(`Loading ${name}…`);
    const t0 = performance.now();
    let bytes = await loadBytes();
    const t1 = performance.now();
    if (isGzip(bytes)) {
      setStatus(`Decompressing ${name}…`);
      await nextPaint();
      bytes = window.pako.inflate(bytes);
    }
    setStatus(`Parsing ${name}…`);
    await nextPaint();
    const t2 = performance.now();
    const parsed = window.parseVRML(new TextDecoder('utf-8').decode(bytes));
    const t3 = performance.now();
    if (parsed.pointSets.length === 0 && parsed.lineSets.length === 0) {
      throw new Error('No recognizable PointSet or IndexedLineSet geometry found in file.');
    }
    const { pointCount, size, fill, kind } = viewer.setModel(parsed);
    titleEl.textContent = name;
    document.title = `${name} – Point Cloud Viewer`;
    hideStatus();
    console.log(`[STATS] ${name}: points=${pointCount} size=${size.toArray().map((v) => +v.toFixed(1)).join('x')}mm ${kind} fill=${fill.toFixed(2)} ` +
      `load=${Math.round(t1 - t0)}ms inflate=${Math.round(t2 - t1)}ms parse=${Math.round(t3 - t2)}ms`);
  } catch (err) {
    console.error(err);
    setStatus(`Failed to load "${name}": ${err.message}`, { error: true, offerOpen: true });
  }
}

function showLocalFile(file) {
  if (file) showFile(file.name, async () => new Uint8Array(await file.arrayBuffer()));
}

// V toggles the camera angle readout; the choice is remembered in this browser.
function setReadoutVisible(visible) {
  readoutEl.hidden = !visible;
  try { localStorage.setItem('viewReadout', visible ? '1' : '0'); } catch (e) { /* storage unavailable */ }
  if (visible) viewer.updateReadout();
}
try { setReadoutVisible(localStorage.getItem('viewReadout') === '1'); } catch (e) { /* storage unavailable */ }
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key.toLowerCase() === 'v') {
    setReadoutVisible(readoutEl.hidden);
  } else if ((e.key === '[' || e.key === ']') && !readoutEl.hidden) {
    // For matching the look by eye; not saved, so a reload shows the built-in default again.
    viewer.densityTweak *= e.key === ']' ? 1.1 : 1 / 1.1;
    viewer.requestRender();
  }
});

openBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => showLocalFile(fileInput.files[0]));

// Drag-and-drop anywhere on the page.
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  showLocalFile(e.dataTransfer.files[0]);
});

const file = new URLSearchParams(window.location.search).get('file');
if (!file) {
  setStatus('Open a .wrz or .wrl file, drop one here, or add ?file=yourfile.wrz to the URL.', { offerOpen: true });
} else if (window.location.protocol === 'file:') {
  // Browsers don't let a page opened from disk read other files by URL.
  setStatus(`This page was opened from disk, so the browser won't load "${file}" by itself. ` +
    'Open it here or drop it onto the page.', { offerOpen: true });
} else {
  showFile(file, async () => {
    const response = await fetch(file);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  });
}
})();
