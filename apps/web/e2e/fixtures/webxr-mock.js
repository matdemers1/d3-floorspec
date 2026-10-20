/* global window */
// A headset that is not there (FLR-T-14.3), for the xr suite: headless Chromium has no WebXR device,
// so this page script stands in for one before the editor loads. `navigator.xr` says immersive VR is
// supported (or not, with `window.__xrSupported = false` set first); a session runs frames from a head
// standing 1.6 m above a floor-level space, and draws them into the page's canvas side by side — the
// two eyes — through three.js's own WebXR path (an XRWebGLLayer whose framebuffer is the canvas).
// `window.__xr` lets a test pinch (a transient pointer, as Vision Pro's look-and-pinch is) and see
// where the head is in the house. Plain JavaScript: it is the page's, not the test's.
(() => {
  const I = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  // Column-major 4×4 products.
  const mul = (a, b) => {
    const o = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return o;
  };
  const translate = (x, y, z) => { const m = I(); m[12] = x; m[13] = y; m[14] = z; return m; };
  const fromPose = (p, q) => {
    const { x, y, z, w } = q;
    return [
      1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
      2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
      2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
      p.x, p.y, p.z, 1,
    ];
  };
  const quatOf = (m) => {
    const t = m[0] + m[5] + m[10];
    if (t > 0) { const s = Math.sqrt(t + 1) * 2; return { x: (m[6] - m[9]) / s, y: (m[8] - m[2]) / s, z: (m[1] - m[4]) / s, w: s / 4 }; }
    if (m[0] > m[5] && m[0] > m[10]) { const s = Math.sqrt(1 + m[0] - m[5] - m[10]) * 2; return { x: s / 4, y: (m[1] + m[4]) / s, z: (m[8] + m[2]) / s, w: (m[6] - m[9]) / s }; }
    if (m[5] > m[10]) { const s = Math.sqrt(1 + m[5] - m[0] - m[10]) * 2; return { x: (m[1] + m[4]) / s, y: s / 4, z: (m[6] + m[9]) / s, w: (m[8] - m[2]) / s }; }
    const s = Math.sqrt(1 + m[10] - m[0] - m[5]) * 2;
    return { x: (m[8] + m[2]) / s, y: (m[6] + m[9]) / s, z: s / 4, w: (m[1] - m[4]) / s };
  };
  const invertRigid = (m) => {
    // Rᵀ and −Rᵀt.
    const r = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1];
    r[12] = -(r[0] * m[12] + r[4] * m[13] + r[8] * m[14]);
    r[13] = -(r[1] * m[12] + r[5] * m[13] + r[9] * m[14]);
    r[14] = -(r[2] * m[12] + r[6] * m[13] + r[10] * m[14]);
    return r;
  };

  class RigidTransform {
    constructor(position = {}, orientation = {}) {
      const p = { x: position.x ?? 0, y: position.y ?? 0, z: position.z ?? 0, w: 1 };
      const q = { x: orientation.x ?? 0, y: orientation.y ?? 0, z: orientation.z ?? 0, w: orientation.w ?? 1 };
      const n = Math.hypot(q.x, q.y, q.z, q.w) || 1;
      this.position = p;
      this.orientation = { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
      this.matrix = new Float32Array(fromPose(p, this.orientation));
    }
    static of(m) {
      const t = new RigidTransform({ x: m[12], y: m[13], z: m[14] }, quatOf(m));
      t.matrix = new Float32Array(m);
      return t;
    }
    get inverse() { return RigidTransform.of(invertRigid([...this.matrix])); }
  }

  // A space: its pose in the house is `m` × a pose in the base (floor-level) space.
  class Space extends EventTarget {
    constructor(m, local = I()) { super(); this.m = m; this.local = local; }
    getOffsetReferenceSpace(t) { return new Space(mul([...t.inverse.matrix], this.m)); }
  }

  const HEAD = translate(0, 1.6, 0);
  const proj = (() => {
    const f = 1 / Math.tan(Math.PI / 4); const n = 0.05; const fa = 1000;
    return new Float32Array([f, 0, 0, 0, 0, f, 0, 0, 0, 0, (fa + n) / (n - fa), -1, 0, 0, (2 * fa * n) / (n - fa), 0]);
  })();
  const state = { frames: 0, init: null, session: null, lastRef: null, sources: [] };

  class Frame {
    constructor(session) { this.session = session; }
    getViewerPose(ref) {
      const m = mul(ref.m, HEAD);
      if (ref !== state.base) state.lastRef = ref;
      const view = (eye, dx) => ({ eye, projectionMatrix: proj, transform: RigidTransform.of(mul(m, translate(dx, 0, 0))), recommendedViewportScale: null, requestViewportScale() {} });
      return { transform: RigidTransform.of(m), views: [view('left', -0.032), view('right', 0.032)], emulatedPosition: false };
    }
    getPose(space, ref) {
      return { transform: RigidTransform.of(mul(ref.m, space.local)), emulatedPosition: false };
    }
    getJointPose() { return null; }
  }

  class Session extends EventTarget {
    constructor(init) {
      super();
      this.init = init;
      this.inputSources = [];
      this.renderState = { baseLayer: null, depthNear: 0.1, depthFar: 1000, inlineVerticalFieldOfView: null };
      this.enabledFeatures = ['local-floor'];
      this.environmentBlendMode = 'opaque';
      this.visibilityState = 'visible';
      this.ended = false;
      this.n = 0;
    }
    updateRenderState(s) { this.renderState = { ...this.renderState, ...s }; }
    requestReferenceSpace(type) {
      if (type !== 'local-floor' && type !== 'local') return Promise.reject(new DOMException('not supported', 'NotSupportedError'));
      const base = new Space(I());
      state.base = base;
      return Promise.resolve(base);
    }
    requestAnimationFrame(cb) {
      const id = ++this.n;
      setTimeout(() => {
        if (this.ended) return;
        state.frames++;
        state.frame = new Frame(this);
        cb(performance.now(), state.frame);
      }, 16);
      return id;
    }
    cancelAnimationFrame() {}
    end() {
      if (this.ended) return Promise.resolve();
      this.ended = true;
      this.dispatchEvent(new Event('end'));
      return Promise.resolve();
    }
  }

  class WebGLLayer {
    constructor() {
      this.framebuffer = null;
      this.framebufferWidth = 1600;
      this.framebufferHeight = 800;
      this.antialias = true;
      this.ignoreDepthValues = true;
      this.fixedFoveation = 0;
    }
    getViewport(view) { return { x: view.eye === 'left' ? 0 : 800, y: 0, width: 800, height: 800 }; }
  }

  const supported = () => window.__xrSupported !== false;
  const system = new EventTarget();
  system.isSessionSupported = (mode) => Promise.resolve(supported() && mode === 'immersive-vr');
  system.requestSession = (mode, init) => {
    if (!supported() || mode !== 'immersive-vr') return Promise.reject(new DOMException('not supported', 'NotSupportedError'));
    const s = new Session(init);
    state.init = init;
    state.session = s;
    return Promise.resolve(s);
  };
  Object.defineProperty(navigator, 'xr', { value: system, configurable: true });
  window.XRRigidTransform = RigidTransform;
  window.XRWebGLLayer = WebGLLayer;
  // three.js takes the projection-layer path when XRWebGLBinding exists: the fake layer is the other one.
  try { delete window.XRWebGLBinding; } catch { window.XRWebGLBinding = undefined; }
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) if (C) C.prototype.makeXRCompatible = () => Promise.resolve();

  window.__xr = {
    get frames() { return state.frames; },
    get init() { return state.init; },
    get ended() { return state.session?.ended ?? null; },
    /** The head in the house: where the last frame drawn put it (x east, y north, z up). */
    head() {
      if (state.lastRef === null) return null;
      const m = mul(state.lastRef.m, HEAD);
      return [m[12], m[13], m[14]];
    },
    /**
     * A pinch: a transient pointer from the head along `dir` (in the head's frame: −z ahead, y up),
     * held for `ms`, then let go — Vision Pro's look and pinch.
     */
    async pinch(dir, ms = 600) {
      const s = state.session;
      const n = Math.hypot(dir[0], dir[1], dir[2]);
      const d = { x: dir[0] / n, y: dir[1] / n, z: dir[2] / n };
      // A ray space looking along d from the head: −z turned onto d.
      const ax = { x: d.y, y: -d.x, z: 0 }; // (0,0,−1) × d, unnormalised
      const dot = -d.z;
      const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
      const an = Math.hypot(ax.x, ax.y) || 1;
      const sin = Math.sin(angle / 2);
      const q = { x: (ax.x / an) * sin, y: (ax.y / an) * sin, z: 0, w: Math.cos(angle / 2) };
      const ray = new Space(I(), mul(HEAD, fromPose({ x: 0, y: 0, z: 0 }, q)));
      const source = { handedness: 'none', targetRayMode: 'transient-pointer', targetRaySpace: ray, gripSpace: undefined, hand: undefined, gamepad: undefined, profiles: [] };
      s.inputSources = [source];
      const change = new Event('inputsourceschange');
      change.added = [source];
      change.removed = [];
      s.dispatchEvent(change);
      await new Promise((r) => setTimeout(r, 100));
      const start = new Event('selectstart');
      start.inputSource = source;
      start.frame = state.frame;
      s.dispatchEvent(start);
      await new Promise((r) => setTimeout(r, ms));
      const end = new Event('selectend');
      end.inputSource = source;
      end.frame = state.frame;
      s.dispatchEvent(end);
      const sel = new Event('select');
      sel.inputSource = source;
      sel.frame = state.frame;
      s.dispatchEvent(sel);
      s.inputSources = [];
      const gone = new Event('inputsourceschange');
      gone.added = [];
      gone.removed = [source];
      s.dispatchEvent(gone);
    },
  };
})();
