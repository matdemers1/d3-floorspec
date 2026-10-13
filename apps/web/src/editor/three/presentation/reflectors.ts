import * as THREE from 'three';

/**
 * What kind of reflector each pixel is, for Presentation's screen-space passes (FLR-T-13.7,
 * FLR-T-13.19): written by the scene's own draw into the alpha of its float target, beside the light
 * in its colour and the depth in its depth texture — so the frame draws the scene once, and no pass
 * swaps every mesh's material for a geometry buffer of its own. The normals the passes need are
 * rebuilt from the depth (GTAO's and the resolve's).
 *
 * Alpha:
 *  - 1     reflects nothing worth tracing: what is not patched writes its opaque alpha, 1 (a matte
 *          Lambert, an unlit colour, a line);
 *  - 2…3   a dielectric, its roughness + 2 (per pixel, from its roughness map where it has one);
 *  - 4…5   a metal, roughness + 4;
 *  - 6…7   glass, roughness + 6 — reflects, and is left out of the ambient occlusion;
 *  - 12    a light: a lamp's lit lens — what blooms;
 *  - 16    nothing: the sky (the clear value), or the backdrop.
 *
 * Who writes it: three.js's `opaque_fragment`, patched here, under the defines the Presentation view
 * sets — `FLOORSPEC_PRESENTATION` on every lit material (a physically based one writes its kind and
 * roughness), `FLOORSPEC_LIGHT` on a lit lens, `FLOORSPEC_GLASS` on a pane's reflecting pass (whose
 * alpha blend replaces what is under it: textures.ts presentationPane). What is blended over a
 * surface — a highlight, an outline — and the sky's dome keep the alpha under them (keepAlpha).
 */

export const SURFACE = { matte: 1, dielectric: 2, metal: 4, glass: 6, light: 12, sky: 16 } as const;
/** Rougher than this, a surface's reflection is the sky's prefiltered light alone: nothing is traced. */
export const TRACE_ROUGHNESS = 0.6;
/** Metalness at or over which a material without a metalness map reflects as a metal. */
export const METAL = 0.35;

export const PRESENTATION = 'FLOORSPEC_PRESENTATION';
export const LIGHT = 'FLOORSPEC_LIGHT';
export const GLASS = 'FLOORSPEC_GLASS';

const MARK = '// floorspec: presentation reflectors';

const CODE = /* glsl */ `
${MARK}
#if defined( FLOORSPEC_GLASS )
	#ifdef STANDARD
		gl_FragColor.a = ${SURFACE.glass.toFixed(1)} + saturate( roughnessFactor );
	#else
		gl_FragColor.a = ${SURFACE.glass.toFixed(1)};
	#endif
#elif defined( FLOORSPEC_LIGHT )
	gl_FragColor.a = ${SURFACE.light.toFixed(1)};
#elif defined( FLOORSPEC_PRESENTATION ) && defined( OPAQUE ) && defined( STANDARD )
	#ifdef USE_METALNESSMAP
		gl_FragColor.a = ${SURFACE.dielectric.toFixed(1)} + saturate( roughnessFactor );
	#else
		gl_FragColor.a = ( metalnessFactor >= ${METAL.toFixed(2)} ? ${SURFACE.metal.toFixed(1)} : ${SURFACE.dielectric.toFixed(1)} ) + saturate( roughnessFactor );
	#endif
#endif
`;

/** Patch three.js's `opaque_fragment` once: the reflector's code into alpha, under Presentation's defines only. */
export function installReflectorCodes(): void {
  const C = THREE.ShaderChunk as unknown as Record<string, string>;
  const chunk = C['opaque_fragment'] ?? '';
  if (chunk.includes(MARK)) return;
  if (!chunk.includes('gl_FragColor = vec4( outgoingLight, diffuseColor.a );')) throw new Error("three.js's opaque_fragment has changed");
  C['opaque_fragment'] = `${chunk}\n${CODE}`;
}

interface Blend {
  blending: THREE.Blending;
  blendSrc: THREE.BlendingSrcFactor;
  blendDst: THREE.BlendingDstFactor;
  blendEquation: THREE.BlendingEquation;
  blendSrcAlpha: THREE.BlendingSrcFactor | null;
  blendDstAlpha: THREE.BlendingDstFactor | null;
  blendEquationAlpha: THREE.BlendingEquation | null;
}

const kept = new WeakMap<THREE.Material, Blend>();

/**
 * Draw `m` with its colour blended as before and the alpha under it kept: a highlight, an outline
 * or the sky's dome is not a surface, and must not overwrite (or blend into) the reflector's code
 * of what is under it. Only a material blended normally (or not at all) is changed; returns whether it was.
 */
export function keepAlpha(m: THREE.Material): boolean {
  if (kept.has(m)) return true;
  if (m.blending !== THREE.NormalBlending && m.blending !== THREE.NoBlending) return false;
  kept.set(m, {
    blending: m.blending,
    blendSrc: m.blendSrc,
    blendDst: m.blendDst,
    blendEquation: m.blendEquation,
    blendSrcAlpha: m.blendSrcAlpha,
    blendDstAlpha: m.blendDstAlpha,
    blendEquationAlpha: m.blendEquationAlpha,
  });
  // three.js's normal blending (straight alpha) for the colour of what is transparent; nothing for an opaque one.
  const blended = m.transparent && m.blending === THREE.NormalBlending;
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation;
  m.blendSrc = blended ? (m.premultipliedAlpha ? THREE.OneFactor : THREE.SrcAlphaFactor) : THREE.OneFactor;
  m.blendDst = blended ? THREE.OneMinusSrcAlphaFactor : THREE.ZeroFactor;
  m.blendEquationAlpha = THREE.AddEquation;
  m.blendSrcAlpha = THREE.ZeroFactor;
  m.blendDstAlpha = THREE.OneFactor;
  return true;
}

/** Put back what keepAlpha changed. */
export function restoreAlpha(m: THREE.Material): void {
  const k = kept.get(m);
  if (k === undefined) return;
  Object.assign(m, k);
  kept.delete(m);
}
