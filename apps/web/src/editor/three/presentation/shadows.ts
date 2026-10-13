import * as THREE from 'three';
import { REACH } from '../lights';

/**
 * Soft shadows for Presentation (FLR-T-13.7): percentage-closer soft shadows (PCSS) — a shadow's
 * penumbra widens with the distance between what casts it and what it falls on, in proportion to
 * the size of the light: sharp where a chair leg meets the floor, soft where a pendant's shade
 * throws the island's edge across it.
 *
 * Classic PCSS reads the shadow map's raw depths to find the blockers. three.js binds a shadow map
 * as a comparison sampler (`sampler2DShadow`), and a second, raw sampler of the same map would be a
 * second texture unit for every shadowed lamp — the units FLR-T-13.17 budgets to the last one. So the
 * blocker search here uses only comparisons: the fraction of the search disc nearer than a depth is a
 * comparison's answer, and asked at the depths where a blocker's penumbra would be 15%, 40% and all of
 * the widest, it is the histogram of the penumbrae the blockers make. Their mean is the filter's
 * radius. A receiver with nothing nearer in the disc is lit after 6 taps; one with every tap blocked
 * is in umbra after 6; only the penumbra pays the full 34.
 *
 * Every shader three.js builds for a lit material is patched once, here; only a program compiled
 * with `FLOORSPEC_PRESENTATION` (the Presentation view sets it on every lit material) takes the new
 * path — Draft's programs are as they were. What each light's `shadow.radius` means then:
 *  - the sun (orthographic): penumbra texels per unit of the shadow map's depth;
 *  - a spot: its emitter's radius times the map's texels over the tangent of its half-angle (the
 *    perspective depth is made linear with the lamps' shadow near and far, `NEAR` and `REACH`);
 *  - a point light: its emitter's radius, metres.
 * The Presentation view sets them (presentationShadow) and puts Draft's back.
 */

/** Metres: a lamp's shadow camera's near plane (FixtureLights' `shade`). */
export const LAMP_SHADOW_NEAR = 0.03;
/** Texels: the widest penumbra searched for in a 2D shadow map. */
export const MAX_PENUMBRA_TEXELS = 24;
/** Radians: the widest penumbra searched for in a point light's cube map. */
export const MAX_PENUMBRA_ANGLE = 0.12;
/** The sun's angular radius, radians (0.267°), a little wider for the haze about it. */
export const SUN_ANGULAR_RADIUS = 0.0065;
/** Lux: below this a lamp's light on a surface is lost in the room's bounce, and its shadow is not looked up. */
export const SHADOW_MIN_LUX = 1.5;

const PCSS = /* glsl */ `
#if defined( SHADOWMAP_TYPE_PCF ) && defined( FLOORSPEC_PRESENTATION )

	#define PCSS_SEARCH 6
	#define PCSS_FILTER 10
	#define PCSS_MAX_TEXELS ${MAX_PENUMBRA_TEXELS.toFixed(1)}
	#define PCSS_MAX_ANGLE ${MAX_PENUMBRA_ANGLE.toFixed(4)}
	#define PCSS_NEAR ${LAMP_SHADOW_NEAR.toFixed(4)}
	#define PCSS_FAR ${REACH.toFixed(4)}

	// The fraction of a disc of the map lit at reference depth z.
	float pcssLit( sampler2DShadow map, vec2 uv, float radius, float z, float phi ) {
		float s = 0.0;
		for ( int i = 0; i < PCSS_SEARCH; i ++ ) s += texture( map, vec3( uv + vogelDiskSample( i, PCSS_SEARCH, phi ) * radius, z ) );
		return s / float( PCSS_SEARCH );
	}

	float pcssLinear( float z ) { return PCSS_NEAR * PCSS_FAR / ( PCSS_FAR - z * ( PCSS_FAR - PCSS_NEAR ) ); }
	float pcssDepth( float d ) { return PCSS_FAR * ( d - PCSS_NEAR ) / ( d * ( PCSS_FAR - PCSS_NEAR ) ); }

	// The map depth of a blocker whose penumbra on this receiver is w texels.
	float pcssBlockerAt( float w, float zr, float dr, float K, bool persp ) {
		if ( persp ) return pcssDepth( K * dr / ( w * dr + K ) );
		return zr - w / K;
	}

	// The mean penumbra (texels) of a disc's blockers from their histogram: b[k] the fraction blocked
	// nearer than the depth at which a blocker's penumbra would be w[k], b0 every blocker.
	float pcssMean( float b0, float b1, float b2, float b3, float w1, float w2, float w3 ) {
		return ( ( b0 - b1 ) * w1 * 0.5 + ( b1 - b2 ) * ( w1 + w2 ) * 0.5 + ( b2 - b3 ) * ( w2 + w3 ) * 0.5 + b3 * w3 ) / max( b0, 1e-4 );
	}

	float getShadowPCSS( sampler2DShadow shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float K, vec4 shadowCoord, bool persp ) {
		shadowCoord.xyz /= shadowCoord.w;
		shadowCoord.z += shadowBias;
		bool inFrustum = shadowCoord.x >= 0.0 && shadowCoord.x <= 1.0 && shadowCoord.y >= 0.0 && shadowCoord.y <= 1.0;
		if ( ! inFrustum || shadowCoord.z > 1.0 ) return 1.0;
		float texel = 1.0 / shadowMapSize.x;
		float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;
		float zr = shadowCoord.z;
		float dr = persp ? pcssLinear( zr ) : zr;
		float search = PCSS_MAX_TEXELS * texel;
		float lit0 = pcssLit( shadowMap, shadowCoord.xy, search, zr, phi );
		float shadow;
		if ( lit0 > 0.999 ) {
			shadow = 1.0;
		} else if ( lit0 < 0.001 ) {
			shadow = 0.0;
		} else {
			float w3 = PCSS_MAX_TEXELS;
			float w2 = w3 * 0.4;
			float w1 = w3 * 0.15;
			float b0 = 1.0 - lit0;
			float b1 = min( b0, 1.0 - pcssLit( shadowMap, shadowCoord.xy, search, pcssBlockerAt( w1, zr, dr, K, persp ), phi ) );
			float b2 = min( b1, 1.0 - pcssLit( shadowMap, shadowCoord.xy, search, pcssBlockerAt( w2, zr, dr, K, persp ), phi ) );
			float b3 = min( b2, 1.0 - pcssLit( shadowMap, shadowCoord.xy, search, pcssBlockerAt( w3, zr, dr, K, persp ), phi ) );
			float w = clamp( pcssMean( b0, b1, b2, b3, w1, w2, w3 ), 1.25, w3 ) * texel;
			float s = 0.0;
			for ( int i = 0; i < PCSS_FILTER; i ++ ) s += texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( i, PCSS_FILTER, phi + 1.0 ) * w, zr ) );
			shadow = s / float( PCSS_FILTER );
		}
		return mix( 1.0, shadow, shadowIntensity );
	}

	#if NUM_POINT_LIGHT_SHADOWS > 0

	float pcssPointLit( samplerCubeShadow map, vec3 dir, vec3 t, vec3 b, float radius, float dp, float phi ) {
		float s = 0.0;
		for ( int i = 0; i < PCSS_SEARCH; i ++ ) {
			vec2 o = vogelDiskSample( i, PCSS_SEARCH, phi ) * radius;
			s += texture( map, vec4( dir + t * o.x + b * o.y, dp ) );
		}
		return s / float( PCSS_SEARCH );
	}

	float getPointShadowPCSS( samplerCubeShadow shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float L, vec4 shadowCoord, float shadowCameraNear, float shadowCameraFar ) {
		vec3 v = shadowCoord.xyz;
		vec3 av = abs( v );
		float dr = max( max( av.x, av.y ), av.z );
		if ( dr > shadowCameraFar || dr < shadowCameraNear ) return 1.0;
		float n = shadowCameraNear;
		float f = shadowCameraFar;
		#define PCSS_DP( d ) ( f * ( ( d ) - n ) / ( ( d ) * ( f - n ) ) + shadowBias )
		vec3 dir = normalize( v );
		vec3 ad = abs( dir );
		vec3 t = ad.x > ad.z ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 );
		t = normalize( cross( dir, t ) );
		vec3 b = cross( dir, t );
		float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;
		float zr = PCSS_DP( dr );
		float lit0 = pcssPointLit( shadowMap, dir, t, b, PCSS_MAX_ANGLE, zr, phi );
		float shadow;
		if ( lit0 > 0.999 ) {
			shadow = 1.0;
		} else if ( lit0 < 0.001 ) {
			shadow = 0.0;
		} else {
			// A blocker at distance db makes a penumbra of L (dr - db) / (db dr) radians here.
			float a3 = PCSS_MAX_ANGLE;
			float a2 = a3 * 0.4;
			float a1 = a3 * 0.15;
			float b0 = 1.0 - lit0;
			float b1 = min( b0, 1.0 - pcssPointLit( shadowMap, dir, t, b, a3, PCSS_DP( L * dr / ( a1 * dr + L ) ), phi ) );
			float b2 = min( b1, 1.0 - pcssPointLit( shadowMap, dir, t, b, a3, PCSS_DP( L * dr / ( a2 * dr + L ) ), phi ) );
			float b3 = min( b2, 1.0 - pcssPointLit( shadowMap, dir, t, b, a3, PCSS_DP( L * dr / ( a3 * dr + L ) ), phi ) );
			float a = clamp( pcssMean( b0, b1, b2, b3, a1, a2, a3 ), 1.5 / shadowMapSize.x, a3 );
			float s = 0.0;
			for ( int i = 0; i < PCSS_FILTER; i ++ ) {
				vec2 o = vogelDiskSample( i, PCSS_FILTER, phi + 1.0 ) * a;
				s += texture( shadowMap, vec4( dir + t * o.x + b * o.y, zr ) );
			}
			shadow = s / float( PCSS_FILTER );
		}
		#undef PCSS_DP
		return mix( 1.0, shadow, shadowIntensity );
	}

	#endif

#endif
`;

const MARK = '// floorspec: presentation shadows';

/** Patch three.js's shadow chunks once: the PCSS functions, and the light loops calling them in Presentation. */
export function installPresentationShadows(): void {
  const C = THREE.ShaderChunk as unknown as Record<string, string>;
  const pars = C['shadowmap_pars_fragment'] ?? '';
  if (pars.includes(MARK)) return;
  // Before the chunk's closing `#endif` of USE_SHADOWMAP: after three.js's own getShadow and getPointShadow.
  const end = pars.lastIndexOf('#endif');
  C['shadowmap_pars_fragment'] = `${pars.slice(0, end)}\n${MARK}\n${PCSS}\n${pars.slice(end)}`;
  const begin = C['lights_fragment_begin'] ?? '';
  const swap = (s: string, from: string, to: string): string => {
    if (!s.includes(from)) throw new Error(`three.js's lights_fragment_begin has changed: ${from.slice(0, 60)}…`);
    return s.replace(from, `\n#if defined( SHADOWMAP_TYPE_PCF ) && defined( FLOORSPEC_PRESENTATION )\n${to}\n#else\n${from}\n#endif\n`);
  };
  const lux = `dot( directLight.color, vec3( 0.2126, 0.7152, 0.0722 ) ) > ${SHADOW_MIN_LUX.toFixed(3)}`;
  let b = begin;
  b = swap(
    b,
    'directLight.color *= ( directLight.visible && receiveShadow ) ? getPointShadow( pointShadowMap[ i ], pointLightShadow.shadowMapSize, pointLightShadow.shadowIntensity, pointLightShadow.shadowBias, pointLightShadow.shadowRadius, vPointShadowCoord[ i ], pointLightShadow.shadowCameraNear, pointLightShadow.shadowCameraFar ) : 1.0;',
    `directLight.color *= ( directLight.visible && receiveShadow && ${lux} ) ? getPointShadowPCSS( pointShadowMap[ i ], pointLightShadow.shadowMapSize, pointLightShadow.shadowIntensity, pointLightShadow.shadowBias, pointLightShadow.shadowRadius, vPointShadowCoord[ i ], pointLightShadow.shadowCameraNear, pointLightShadow.shadowCameraFar ) : 1.0;`,
  );
  b = swap(
    b,
    'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( spotShadowMap[ i ], spotLightShadow.shadowMapSize, spotLightShadow.shadowIntensity, spotLightShadow.shadowBias, spotLightShadow.shadowRadius, vSpotLightCoord[ i ] ) : 1.0;',
    `directLight.color *= ( directLight.visible && receiveShadow && ${lux} ) ? getShadowPCSS( spotShadowMap[ i ], spotLightShadow.shadowMapSize, spotLightShadow.shadowIntensity, spotLightShadow.shadowBias, spotLightShadow.shadowRadius, vSpotLightCoord[ i ], true ) : 1.0;`,
  );
  b = swap(
    b,
    'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;',
    'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadowPCSS( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ], false ) : 1.0;',
  );
  C['lights_fragment_begin'] = b;
  // The sky lights the house through its light probe (SkyScene): in Presentation the prefiltered sky
  // is there for reflections only, so its irradiance is not added a second time.
  const maps = C['lights_fragment_maps'] ?? '';
  const irr = 'iblIrradiance += getIBLIrradiance( geometryNormal );';
  if (!maps.includes(irr)) throw new Error("three.js's lights_fragment_maps has changed");
  C['lights_fragment_maps'] = maps.replace(irr, `#ifndef FLOORSPEC_PRESENTATION\n${irr}\n#endif`);
}

interface Kept {
  radius: number;
  size: number;
}
/** A light, and its shadow if it has one (three.js's types keep it on the subclasses). */
export type Shadowed = THREE.Light & { shadow?: THREE.LightShadow };
const kept = new WeakMap<Shadowed, Kept>();

/**
 * Set the `shadow.radius` of a light that casts shadows to what PCSS reads (above), keeping Draft's to put back.
 * A spot's map is drawn at twice Draft's size: PCSS softens what it is given, not what it is not.
 */
export function presentationShadow(light: Shadowed): void {
  const shadow = light.shadow;
  if (shadow === undefined || !light.castShadow) return;
  if (!kept.has(light)) kept.set(light, { radius: shadow.radius, size: shadow.mapSize.x });
  const size = (light.userData as { size?: number }).size ?? 0.03;
  let radius: number;
  if (light instanceof THREE.DirectionalLight) {
    const cam = shadow.camera as THREE.OrthographicCamera;
    const span = Math.max(1e-3, cam.right - cam.left);
    radius = ((cam.far - cam.near) * SUN_ANGULAR_RADIUS * shadow.mapSize.x) / span;
  } else if (light instanceof THREE.SpotLight) {
    const want = Math.max(1024, kept.get(light)?.size ?? 512);
    if (shadow.mapSize.x !== want) {
      shadow.mapSize.set(want, want);
      shadow.map?.dispose();
      shadow.map = null;
      shadow.needsUpdate = true;
    }
    radius = (size * shadow.mapSize.x) / (2 * Math.tan(Math.min(light.angle, 1.55)));
  } else {
    radius = size;
  }
  if (shadow.radius !== radius) shadow.radius = radius;
}

/** Put a light's Draft shadow back. */
export function draftShadow(light: Shadowed): void {
  const k = kept.get(light);
  const shadow = light.shadow;
  if (k === undefined || shadow === undefined) return;
  shadow.radius = k.radius;
  if (shadow.mapSize.x !== k.size) {
    shadow.mapSize.set(k.size, k.size);
    shadow.map?.dispose();
    shadow.map = null;
    shadow.needsUpdate = true;
  }
  kept.delete(light);
}
