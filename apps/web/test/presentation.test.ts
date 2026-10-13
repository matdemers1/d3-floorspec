import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EXPOSURE_PER_NIT } from '@floorspec/mesh';
import { narkowicz, toneMap, untoneMap } from '../src/editor/three/presentation/tone';
import { installPresentationShadows, presentationShadow, draftShadow, SUN_ANGULAR_RADIUS } from '../src/editor/three/presentation/shadows';
import { installReflectorCodes, keepAlpha, restoreAlpha, SURFACE } from '../src/editor/three/presentation/reflectors';
import { GUARANTEED_TEXTURE_UNITS, LIT_EXPOSURE, PRESENTATION_SCENE_TEXTURE_UNITS, SCENE_TEXTURE_UNITS, shadowBudget, toneMappingExposure } from '../src/editor/three/lights';
import { MATERIAL_TEXTURE_UNITS, presentationPane } from '../src/editor/three/textures';
import { readQuality, ThreeStore } from '../src/editor/three/mode';

/**
 * FLR-T-13.7: the 3D view's Presentation quality — its tone curve's inverse (for colours that must
 * reach the screen as they are), its soft shadows patched into three.js only where asked for, the
 * texture units it spends, the reflector codes the scene's draw writes into alpha (FLR-T-13.19), its glass, and the choice
 * between it and Draft.
 */

describe('the tone curve and its inverse', () => {
  it('is the renderers\' curve: the same exposure reads the same in Draft and Presentation', () => {
    // A white wall at 200 lux under the lamps' exposure: what the editor has shown since FLR-T-13.1.
    const nits = (0.8 * 200) / Math.PI;
    expect(narkowicz(nits, toneMappingExposure(LIT_EXPOSURE))).toBeCloseTo(narkowicz(nits * EXPOSURE_PER_NIT.nightMax, 0.6), 9);
  });
  for (const mapping of [THREE.CustomToneMapping, THREE.ACESFilmicToneMapping]) {
    it(`gives back a display colour through ${mapping === THREE.CustomToneMapping ? 'the filmic fit' : "three.js's ACES"} at any exposure`, () => {
      for (const exposure of [1, 0.024, 6e-4]) {
        for (const c of [[0.42, 0.33, 0.95], [0.05, 0.05, 0.06], [0.9, 0.9, 0.9]] as [number, number, number][]) {
          const back = toneMap(untoneMap(c, mapping, exposure), mapping, exposure);
          for (let k = 0; k < 3; k++) expect(back[k]).toBeCloseTo(c[k] ?? 0, 3);
        }
      }
    });
  }
});

describe('soft shadows (PCSS)', () => {
  it('patches three.js once, and only a Presentation program takes the new path', () => {
    installPresentationShadows();
    const once = THREE.ShaderChunk.shadowmap_pars_fragment;
    installPresentationShadows();
    expect(THREE.ShaderChunk.shadowmap_pars_fragment).toBe(once);
    expect(once).toContain('float getShadowPCSS(');
    expect(once).toContain('float getPointShadowPCSS(');
    expect(once).toContain('#if defined( SHADOWMAP_TYPE_PCF ) && defined( FLOORSPEC_PRESENTATION )');
    const begin = THREE.ShaderChunk.lights_fragment_begin;
    // Each light type: the PCSS call under the define, three.js's own otherwise.
    expect(begin.match(/getShadowPCSS\(/g)?.length).toBe(2);
    expect(begin.match(/getPointShadowPCSS\(/g)?.length).toBe(1);
    expect(begin).toContain('getShadow( spotShadowMap[ i ]');
    expect(begin).toContain('getPointShadow( pointShadowMap[ i ]');
    // No second sampler: PCSS reads the comparison samplers three.js already binds.
    expect(once).not.toMatch(/uniform sampler2D \w+Raw/);
    // The sky's light probe lights the house; its prefiltered map does not light it a second time.
    expect(THREE.ShaderChunk.lights_fragment_maps).toMatch(/#ifndef FLOORSPEC_PRESENTATION\s+iblIrradiance \+= getIBLIrradiance/);
  });

  it('sizes each light\'s penumbra, and gives Draft its shadows back', () => {
    const sun = new THREE.DirectionalLight();
    sun.castShadow = true;
    sun.shadow.radius = 2;
    sun.shadow.mapSize.set(4096, 4096);
    const cam = sun.shadow.camera;
    Object.assign(cam, { left: -20, right: 20, near: 10, far: 110 });
    presentationShadow(sun);
    // Texels of penumbra per unit of map depth: depth range × tan(sun's radius) over a texel.
    expect(sun.shadow.radius).toBeCloseTo((100 * SUN_ANGULAR_RADIUS * 4096) / 40, 6);
    draftShadow(sun);
    expect(sun.shadow.radius).toBe(2);

    const spot = new THREE.SpotLight();
    spot.castShadow = true;
    spot.angle = Math.PI / 4;
    spot.shadow.mapSize.set(512, 512);
    spot.shadow.radius = 3;
    spot.userData = { size: 0.05 };
    presentationShadow(spot);
    expect(spot.shadow.mapSize.x).toBe(1024);
    expect(spot.shadow.radius).toBeCloseTo((0.05 * 1024) / 2, 6);
    draftShadow(spot);
    expect(spot.shadow.mapSize.x).toBe(512);
    expect(spot.shadow.radius).toBe(3);

    const point = new THREE.PointLight();
    point.castShadow = true;
    point.userData = { size: 0.02 };
    presentationShadow(point);
    expect(point.shadow.radius).toBe(0.02);
  });
});

describe('texture units', () => {
  it('spends one more on the sky\'s reflection map in Presentation: one shadowed lamp fewer, still within 16', () => {
    const draft = shadowBudget(16, MATERIAL_TEXTURE_UNITS, SCENE_TEXTURE_UNITS);
    const presentation = shadowBudget(16, MATERIAL_TEXTURE_UNITS, PRESENTATION_SCENE_TEXTURE_UNITS);
    expect(draft).toBe(11);
    expect(presentation).toBe(10);
    expect(presentation + MATERIAL_TEXTURE_UNITS + PRESENTATION_SCENE_TEXTURE_UNITS).toBeLessThanOrEqual(GUARANTEED_TEXTURE_UNITS);
    // A GPU with more (SwiftShader's 32) is planned for 16 all the same.
    expect(shadowBudget(32, MATERIAL_TEXTURE_UNITS, PRESENTATION_SCENE_TEXTURE_UNITS)).toBe(10);
  });
});

describe("the reflectors, in the scene's alpha", () => {
  it('patches three.js once, and only under Presentation\'s defines', () => {
    const before = THREE.ShaderChunk.opaque_fragment;
    installReflectorCodes();
    const once = THREE.ShaderChunk.opaque_fragment;
    installReflectorCodes();
    expect(THREE.ShaderChunk.opaque_fragment).toBe(once);
    // three.js's own line first, then the codes over its alpha — nothing else changed.
    expect(once.startsWith(before)).toBe(true);
    expect(once).toContain('gl_FragColor = vec4( outgoingLight, diffuseColor.a );');
    const after = once.slice(before.length);
    expect(after.match(/^\s*#(if|elif) .*$/gm)?.map((l) => l.trim())).toEqual([
      '#if defined( FLOORSPEC_GLASS )',
      '#elif defined( FLOORSPEC_LIGHT )',
      '#elif defined( FLOORSPEC_PRESENTATION ) && defined( OPAQUE ) && defined( STANDARD )',
    ]);
    // A metal from its metalness; a material with a metalness map (the library's ORM) a dielectric, as before.
    expect(after).toContain(`metalnessFactor >= 0.35 ? ${SURFACE.metal.toFixed(1)} : ${SURFACE.dielectric.toFixed(1)}`);
    expect(after).toContain(`gl_FragColor.a = ${SURFACE.light.toFixed(1)};`);
    // Kinds with room for a roughness of 0–1 between them; what nothing patches writes 1, "matte".
    expect(SURFACE.matte).toBe(1);
    expect(SURFACE.dielectric + 1).toBeLessThan(SURFACE.metal);
    expect(SURFACE.metal + 1).toBeLessThan(SURFACE.glass);
    expect(SURFACE.glass + 1).toBeLessThan(SURFACE.light);
    expect(SURFACE.light).toBeLessThan(SURFACE.sky);
  });

  it('draws an overlay keeping the alpha under it, and puts it back', () => {
    const over = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.4 });
    expect(keepAlpha(over)).toBe(true);
    expect(over.blending).toBe(THREE.CustomBlending);
    // The colour blended as three.js's normal blending; the alpha under it kept.
    expect([over.blendSrc, over.blendDst, over.blendSrcAlpha, over.blendDstAlpha]).toEqual([THREE.SrcAlphaFactor, THREE.OneMinusSrcAlphaFactor, THREE.ZeroFactor, THREE.OneFactor]);
    restoreAlpha(over);
    expect(over.blending).toBe(THREE.NormalBlending);
    expect(over.blendSrcAlpha).toBeNull();
    // The sky's dome: opaque, its colour replacing what is there, its alpha ("sky") kept.
    const dome = new THREE.ShaderMaterial();
    keepAlpha(dome);
    expect([dome.blendSrc, dome.blendDst, dome.blendSrcAlpha, dome.blendDstAlpha]).toEqual([THREE.OneFactor, THREE.ZeroFactor, THREE.ZeroFactor, THREE.OneFactor]);
    // A pane's passes blend as they must already.
    expect(keepAlpha(presentationPane([0.8, 0.85, 0.82]).transmit)).toBe(false);
  });

  it('draws a pane in two passes: what it lets through, multiplied, then what it reflects, added', () => {
    const { transmit, reflect } = presentationPane([0.8, 0.85, 0.82]);
    expect([transmit.blendSrc, transmit.blendDst]).toEqual([THREE.ZeroFactor, THREE.SrcColorFactor]);
    expect(transmit.fragmentShader).toContain('glassTransmission( pane, c )');
    expect([reflect.blendSrc, reflect.blendDst]).toEqual([THREE.OneFactor, THREE.OneFactor]);
    expect(reflect.color.getHex()).toBe(0);
    // In alpha: the transmitting pass keeps what is under it (× its alpha, 1); the reflecting pass puts
    // glass there, and its depth — the screen-space passes see the pane, not what is behind it.
    expect([transmit.blendSrcAlpha, transmit.blendDstAlpha]).toEqual([null, null]);
    expect(transmit.fragmentShader).toContain('gl_FragColor = vec4( glassTransmission( pane, c ), 1.0 );');
    expect([reflect.blendSrcAlpha, reflect.blendDstAlpha]).toEqual([THREE.OneFactor, THREE.ZeroFactor]);
    expect(reflect.defines).toHaveProperty('FLOORSPEC_GLASS');
    expect(reflect.depthWrite).toBe(true);
  });
});

describe('Draft or Presentation', () => {
  it('defaults to Presentation on a GPU and Draft in software, and remembers the choice', () => {
    // This browser's storage (the tests run in Node).
    const kept = new Map<string, string>();
    globalThis.localStorage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, v); }, removeItem: (k: string) => { kept.delete(k); } } as unknown as Storage;
    expect(readQuality(() => false)).toBe('presentation');
    expect(readQuality(() => true)).toBe('draft');
    const three = new ThreeStore('p', () => false);
    expect(three.get().quality).toBe('presentation');
    three.setQuality('draft');
    expect(three.get().quality).toBe('draft');
    expect(new ThreeStore('p', () => false).get().quality).toBe('draft');
    expect(kept.get('floorspec.quality3d')).toBe('draft');
  });
});
