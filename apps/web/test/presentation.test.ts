import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EXPOSURE_PER_NIT } from '@floorspec/mesh';
import { narkowicz, toneMap, untoneMap } from '../src/editor/three/presentation/tone';
import { installPresentationShadows, presentationShadow, draftShadow, SUN_ANGULAR_RADIUS } from '../src/editor/three/presentation/shadows';
import { surfaceOf, SURFACE } from '../src/editor/three/presentation/gbuffer';
import { GUARANTEED_TEXTURE_UNITS, LIT_EXPOSURE, PRESENTATION_SCENE_TEXTURE_UNITS, SCENE_TEXTURE_UNITS, shadowBudget, toneMappingExposure } from '../src/editor/three/lights';
import { MATERIAL_TEXTURE_UNITS, presentationPane } from '../src/editor/three/textures';
import { readQuality, ThreeStore } from '../src/editor/three/mode';

/**
 * FLR-T-13.7: the 3D view's Presentation quality — its tone curve's inverse (for colours that must
 * reach the screen as they are), its soft shadows patched into three.js only where asked for, the
 * texture units it spends, what the geometry buffer calls a reflector, its glass, and the choice
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

describe('the geometry buffer', () => {
  it('calls glossy surfaces, metals and glass reflectors, and overlays nothing', () => {
    expect(surfaceOf(new THREE.MeshStandardMaterial({ roughness: 0.3 }))).toMatchObject({ code: 0, roughness: 0.3 });
    expect(surfaceOf(new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.5 }))?.code).toBe(SURFACE.metal);
    expect(surfaceOf(new THREE.MeshLambertMaterial())?.code).toBe(SURFACE.matte);
    const pane = presentationPane([0.8, 0.85, 0.82]);
    expect(surfaceOf(pane.reflect)?.code).toBe(SURFACE.glass);
    expect(surfaceOf(pane.transmit)).toBeNull();
    expect(surfaceOf(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.4 }))).toBeNull();
    expect(surfaceOf(new THREE.MeshBasicMaterial({ colorWrite: false }))).toBeNull();
    // A lit lens is a light: what blooms, and what the occlusion leaves alone.
    const lens = new THREE.MeshBasicMaterial({ toneMapped: false });
    lens.userData = { lens: true };
    expect(surfaceOf(lens)?.code).toBe(SURFACE.light);
  });

  it('draws a pane in two passes: what it lets through, multiplied, then what it reflects, added', () => {
    const { transmit, reflect } = presentationPane([0.8, 0.85, 0.82]);
    expect([transmit.blendSrc, transmit.blendDst]).toEqual([THREE.ZeroFactor, THREE.SrcColorFactor]);
    expect(transmit.fragmentShader).toContain('glassTransmission( pane, c )');
    expect([reflect.blendSrc, reflect.blendDst]).toEqual([THREE.OneFactor, THREE.OneFactor]);
    expect(reflect.color.getHex()).toBe(0);
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
