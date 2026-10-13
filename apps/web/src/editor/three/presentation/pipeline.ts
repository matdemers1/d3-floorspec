import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { SURFACE } from './reflectors';
import { resolveMaterial, setResolve } from './resolve';
import type { Indoor } from './indoor';
import { ACCUMULATE } from './stats';

export { ACCUMULATE };

/**
 * Presentation's frame (FLR-T-13.7), in passes, all at one resolution:
 *
 *   the scene in linear light (float; in alpha, each pixel's kind of reflector — reflectors.ts — and
 *   its depth in a depth texture, so the scene is drawn once a frame) → ambient occlusion (GTAO, half
 *   size, its normals rebuilt from the depth)
 *   → resolve: occlusion and screen-space reflections → bloom → tone curve and sRGB (three.js's
 *   OutputPass: the renderer's own curve and exposure, the path tracer's) → SMAA, or a jittered
 *   frame folded into the accumulation → the screen.
 *
 * Standing still, the view keeps drawing frames a sub-pixel apart (Halton 2, 3) and averages them:
 * temporal anti-aliasing for a still camera, which also smooths the noise in the soft shadows,
 * the occlusion and the reflections. Moving, each frame is SMAA'd on its own.
 */

/**
 * Bloom: the tone curve's input (after the exposure) above which a light blooms — a lit lens (at
 * Presentation's LENS_OVER_WHITE) or the sky by the sun. Surfaces never do, however brightly lit (a
 * white counter under a pendant at 1000 lux is about 10): only what the resolve marks blooms.
 */
export const BLOOM_THRESHOLD = 16;
export const BLOOM_STRENGTH = 0.16;
export const BLOOM_RADIUS = 0.45;
/** GTAO, metres. */
export const AO_RADIUS = 0.55;
export const AO_INTENSITY = 0.85;
export const SSR_INTENSITY = 1;

const halton = (i: number, b: number): number => {
  let f = 1;
  let r = 0;
  for (let n = i; n > 0; n = Math.floor(n / b)) {
    f /= b;
    r += f * (n % b);
  }
  return r;
};

const COPY_UNIFORMS = { tDiffuse: { value: null as THREE.Texture | null }, opacity: { value: 1 } };
const COPY = new THREE.ShaderMaterial({
  uniforms: COPY_UNIFORMS,
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }',
  fragmentShader: 'uniform sampler2D tDiffuse; uniform float opacity; varying vec2 vUv; void main() { gl_FragColor = vec4( texture2D( tDiffuse, vUv ).rgb, opacity ); }',
  depthTest: false,
  depthWrite: false,
});

/**
 * Unbind every texture from every unit. The last frame's passes leave their inputs bound — the
 * picture, the depth — and the next frame draws into those very buffers. A
 * texture bound to a unit while it is also the target being drawn is a feedback loop the driver
 * must rule out at every draw (ANGLE on Metal does, at great cost: the first seconds of a turn ran at
 * a third of a second a frame). three.js's own record of the bindings is then reset to match.
 */
function unbindTextures(r: THREE.WebGLRenderer): void {
  const g = r.getContext() as WebGL2RenderingContext;
  const units = r.capabilities.maxTextures;
  for (let i = 0; i < units; i++) {
    g.activeTexture(g.TEXTURE0 + i);
    g.bindTexture(g.TEXTURE_2D, null);
    g.bindTexture(g.TEXTURE_CUBE_MAP, null);
    g.bindTexture(g.TEXTURE_2D_ARRAY, null);
    g.bindTexture(g.TEXTURE_3D, null);
  }
  g.activeTexture(g.TEXTURE0);
  r.state.reset();
}

class Targets {
  readonly hdr: THREE.WebGLRenderTarget;
  readonly lit: THREE.WebGLRenderTarget;
  readonly ldr: THREE.WebGLRenderTarget;
  readonly accum: THREE.WebGLRenderTarget;
  readonly gtao: GTAOPass;
  readonly bloom: UnrealBloomPass;
  readonly smaa: SMAAPass;
  readonly size: THREE.Vector2;

  constructor(
    readonly width: number,
    readonly height: number,
    scene: THREE.Scene,
    readonly camera: THREE.PerspectiveCamera,
  ) {
    this.size = new THREE.Vector2(width, height);
    // The scene's light, and in alpha what reflects (reflectors.ts); its depth a texture the passes read.
    const depth = new THREE.DepthTexture(width, height);
    depth.type = THREE.UnsignedIntType;
    this.hdr = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true, depthBuffer: true, depthTexture: depth });
    this.lit = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, depthBuffer: false });
    this.ldr = new THREE.WebGLRenderTarget(width, height, { type: THREE.UnsignedByteType, depthBuffer: false });
    this.accum = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, depthBuffer: false });
    const aw = Math.max(1, Math.round(width / 2));
    const ah = Math.max(1, Math.round(height / 2));
    // Made with its own (small) buffer and then pointed at our depth, with no normals: three.js's
    // GTAOPass reads its own normal buffer's depth while it is set up, which it does not have when
    // given one at construction; without a normal texture it rebuilds the normals from the depth.
    // (@types/three lags the class: it takes the AO and denoise parameters too.)
    const Gtao = GTAOPass as unknown as new (...args: unknown[]) => GTAOPass;
    this.gtao = new Gtao(scene, camera, aw, ah, undefined, { radius: AO_RADIUS, distanceExponent: 1, thickness: 1, scale: 1, samples: 16, distanceFallOff: 1 }, { radius: 6, rings: 2, samples: 12 });
    this.gtao.setGBuffer(depth, undefined);
    this.gtao.output = GTAOPass.OUTPUT.Off;
    this.bloom = new UnrealBloomPass(new THREE.Vector2(width, height), BLOOM_STRENGTH, BLOOM_RADIUS, 1);
    // Only what the resolve marks in alpha blooms (a lit lens, the sky): a counter under a pendant
    // is clipped to white, as a photograph clips it, but does not glow.
    const high = this.bloom.materialHighPassFilter;
    const pass = 'float alpha = smoothstep( luminosityThreshold, luminosityThreshold + smoothWidth, v );';
    if (!high.fragmentShader.includes(pass)) throw new Error("three.js's LuminosityHighPassShader has changed");
    high.fragmentShader = high.fragmentShader.replace(pass, `${pass}\n\t\t\talpha *= texel.a;`);
    high.needsUpdate = true;
    this.smaa = new SMAAPass();
    this.smaa.setSize(width, height);
  }

  dispose(): void {
    this.hdr.depthTexture?.dispose();
    this.hdr.dispose();
    this.lit.dispose();
    this.ldr.dispose();
    this.accum.dispose();
    this.gtao.dispose();
    this.bloom.dispose();
    this.smaa.dispose();
  }
}

export interface FrameOptions {
  /** Of the drawing buffer: what the passes are drawn at (1 standing still). */
  scale: number;
  /** The prefiltered sky (three.js's PMREM), for the reflections the resolve replaces; null without a sky. */
  env: THREE.Texture | null;
  envIntensity: number;
  /** Where the house is indoors (indoor.ts), or null. */
  indoor: Indoor | null;
  /** Accumulate: the frame's index since the camera stopped (0: start again), or null not to (moving). */
  accumulate: number | null;
}

export class PresentationPipeline {
  private targets: Targets[] = [];
  private readonly resolve = resolveMaterial();
  private readonly output = new OutputPass();
  private readonly quad = new FullScreenQuad(this.resolve);
  private readonly copy = new FullScreenQuad(COPY);
  private readonly saved = new THREE.Matrix4();
  private readonly savedInverse = new THREE.Matrix4();
  /** The passes a frame draws, for the test hook. */
  readonly passes = ['scene', 'gtao', 'resolve:ao+ssr', 'bloom', 'output:tone+srgb', 'smaa|accumulate'] as const;
  /** Under automation: 0 the picture, 1 the reflections alone, 2 the occlusion, 3 the reflectors (reflectors.ts), 4 indoors (green) and out (red). */
  debugView = 0;
  /** Under automation: passes left out, to measure what each costs. */
  skip = new Set<string>();
  /** Target sets made so far (each a reallocation). */
  created = 0;
  /** Last frame's drawn size. */
  drawn = new THREE.Vector2();

  constructor(private readonly renderer: THREE.WebGLRenderer) {}

  private targetsFor(width: number, height: number, scene: THREE.Scene, camera: THREE.PerspectiveCamera): Targets {
    const hit = this.targets.find((t) => t.width === width && t.height === height && t.camera === camera);
    if (hit !== undefined) {
      this.targets = [hit, ...this.targets.filter((t) => t !== hit)];
      return hit;
    }
    const t = new Targets(width, height, scene, camera);
    this.created++;
    this.targets.unshift(t);
    // Two sizes at most: standing still, and moving.
    for (const old of this.targets.splice(2)) old.dispose();
    return t;
  }

  /** Draw a frame of `scene` to the screen. Returns the frame's accumulation count (0 when not accumulating). */
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, o: FrameOptions): number {
    const r = this.renderer;
    const buffer = r.getDrawingBufferSize(new THREE.Vector2());
    const width = Math.max(1, Math.round(buffer.x * o.scale));
    const height = Math.max(1, Math.round(buffer.y * o.scale));
    const t = this.targetsFor(width, height, scene, camera);
    this.drawn.set(width, height);
    const k = o.accumulate ?? 0;
    const jitter = o.accumulate !== null && k > 0;
    const autoClear = r.autoClear;
    r.autoClear = false;
    unbindTextures(r);

    // A sub-pixel step of the projection for an accumulated frame.
    this.saved.copy(camera.projectionMatrix);
    this.savedInverse.copy(camera.projectionMatrixInverse);
    if (jitter) {
      const jx = halton(k, 2) - 0.5;
      const jy = halton(k, 3) - 0.5;
      const e = camera.projectionMatrix.elements;
      e[8] += (2 * jx) / width;
      e[9] += (2 * jy) / height;
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    }

    // 1–2. The scene, in linear light, its reflectors and its depth.
    this.drawScene(t, scene, camera);
    // 3. Ambient occlusion (half size, denoised).
    const ao = !this.skip.has('ao');
    if (ao) t.gtao.render(r, null as unknown as THREE.WebGLRenderTarget, null as unknown as THREE.WebGLRenderTarget, 0, false);
    // 4. Occlusion and reflections.
    setResolve(this.resolve, { color: t.hdr.texture, indoor: o.indoor, ao: ao ? t.gtao.gtaoMap : null, depth: t.hdr.depthTexture as THREE.Texture, env: o.env }, camera, t.size, AO_INTENSITY, this.skip.has('ssr') ? 0 : SSR_INTENSITY);
    const dbg = this.resolve.uniforms['debugView'];
    if (dbg !== undefined) dbg.value = this.debugView;
    const dbs = this.resolve.uniforms['debugScale'];
    if (dbs !== undefined) dbs.value = 0.6 / Math.max(1e-9, r.toneMappingExposure);
    const env = this.resolve.uniforms['envIntensity'];
    if (env !== undefined) env.value = o.envIntensity;
    this.quad.material = this.resolve;
    r.setRenderTarget(t.lit);
    this.quad.render(r);
    // 5. Bloom: what is brighter than the curve's white, by the view's exposure.
    const exposure = Math.max(1e-9, r.toneMappingExposure);
    t.bloom.threshold = (BLOOM_THRESHOLD * 0.6) / exposure;
    const hp = (t.bloom as unknown as { highPassUniforms: Record<string, THREE.IUniform> }).highPassUniforms;
    const sw = hp['smoothWidth'];
    if (sw !== undefined) sw.value = t.bloom.threshold;
    if (!this.skip.has('bloom')) t.bloom.render(r, null as unknown as THREE.WebGLRenderTarget, t.lit, 0, false);
    // 6. The tone curve and the screen's encoding.
    this.output.render(r, t.ldr, t.lit, 0, false);

    camera.projectionMatrix.copy(this.saved);
    camera.projectionMatrixInverse.copy(this.savedInverse);

    // 7. Anti-aliased: SMAA on a frame of its own; a jittered frame folded into the average.
    if (!jitter) {
      t.smaa.render(r, t.accum, t.ldr, 0, false);
    } else {
      COPY_UNIFORMS.tDiffuse.value = t.ldr.texture;
      COPY_UNIFORMS.opacity.value = 1 / (k + 1);
      COPY.transparent = true;
      COPY.blending = THREE.NormalBlending;
      r.setRenderTarget(t.accum);
      this.copy.render(r);
      COPY.transparent = false;
      COPY.blending = THREE.NoBlending;
    }
    // 8. To the screen.
    COPY_UNIFORMS.tDiffuse.value = t.accum.texture;
    COPY_UNIFORMS.opacity.value = 1;
    r.setRenderTarget(null);
    this.copy.render(r);
    r.autoClear = autoClear;
    return jitter ? k + 1 : 1;
  }

  /**
   * Draw everything once, nothing culled, into the passes' buffers. A GPU driver (ANGLE on Metal)
   * builds a pipeline for each program, target format and blend the first time it is drawn with
   * them — a shader compile of its own, which compiling the WebGL programs ahead does not do. Drawn
   * here while the view says "Preparing", turning to face a room not yet seen does not stall on it.
   */
  warm(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    const r = this.renderer;
    const buffer = r.getDrawingBufferSize(new THREE.Vector2());
    const t = this.targetsFor(Math.max(1, buffer.x), Math.max(1, buffer.y), scene, camera);
    unbindTextures(r);
    const culled: THREE.Object3D[] = [];
    scene.traverse((o) => {
      if (o.frustumCulled) {
        o.frustumCulled = false;
        culled.push(o);
      }
    });
    this.drawScene(t, scene, camera);
    for (const o of culled) o.frustumCulled = true;
    r.setRenderTarget(null);
  }

  /**
   * The scene into the float target: cleared to "sky" in alpha, so what draws nothing there (the sky's
   * dome keeps the alpha under it) reads as the sky. A backdrop colour is cleared here rather than by
   * three.js, which would clear its alpha to 1 — a surface's — and three.js premultiplies a clear
   * colour by its alpha (on a premultiplied canvas): the colour is divided by it first.
   */
  private drawScene(t: Targets, scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    const r = this.renderer;
    const background = scene.background;
    const clear = r.getClearColor(new THREE.Color());
    const alpha = r.getClearAlpha();
    r.setRenderTarget(t.hdr);
    const premultiplied = r.getContext().getContextAttributes()?.premultipliedAlpha !== false;
    const fill = background instanceof THREE.Color ? background.clone().multiplyScalar(premultiplied ? 1 / SURFACE.sky : 1) : new THREE.Color(0, 0, 0);
    if (background instanceof THREE.Color) scene.background = null;
    r.setClearColor(fill, SURFACE.sky);
    r.clear(true, true, true);
    r.render(scene, camera);
    r.setClearColor(clear, alpha);
    scene.background = background;
  }

  /** Show the last accumulated picture again, without drawing the scene. */
  present(): boolean {
    const t = this.targets[0];
    if (t === undefined) return false;
    COPY_UNIFORMS.tDiffuse.value = t.accum.texture;
    COPY_UNIFORMS.opacity.value = 1;
    this.renderer.setRenderTarget(null);
    this.copy.render(this.renderer);
    return true;
  }

  dispose(): void {
    for (const t of this.targets) t.dispose();
    this.targets = [];
    this.resolve.dispose();
    this.output.dispose();
    this.quad.dispose();
    this.copy.dispose();
  }
}
