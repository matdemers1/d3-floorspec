import * as THREE from 'three';
import { SURFACE, TRACE_ROUGHNESS } from './gbuffer';
import type { Indoor } from './indoor';

/**
 * Presentation's resolve (FLR-T-13.7): the scene's linear light with its ambient occlusion and its
 * screen-space reflections, in one full-screen pass.
 *
 * - **Ambient occlusion** (GTAO) darkens the light in corners, under furniture and where walls meet
 *   floors; glass is left alone, so the garden through a window is not darkened at its frame.
 * - **Reflections**: from every pixel of a glossy surface (a floor, a counter, a pane — the geometry
 *   buffer's alpha) a ray is marched in screen space along the mirror direction against the depth
 *   buffer, perspective-correct (McGuire and Mara's DDA), jittered per pixel, refined by bisection. A
 *   hit's light — from the picture's mip chain, blurrier the rougher the surface and the longer the
 *   ray — takes the place of what the material already reflects there: the sky's prefiltered light
 *   in that direction (the same `envMap` three.js read), weighed by the split-sum Fresnel term. A ray
 *   leaving the screen, passing behind a surface or meeting one from behind fades out, and the sky's
 *   light stays.
 *
 * All in scene-referred light (cd/m² before the exposure): the tone curve comes after.
 */

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}`;

const FRAGMENT = /* glsl */ `
#include <common>
#include <packing>
#ifdef USE_ENV
  uniform sampler2D envMap;
  uniform float envIntensity;
  #include <cube_uv_reflection_fragment>
#endif
uniform sampler2D tColor;
uniform sampler2D tAO;
uniform sampler2D tNormal;
uniform sampler2D tDepth;
uniform mat4 proj;
uniform mat4 invProj;
uniform mat4 camWorld;
uniform vec2 resolution;
uniform float near;
uniform float far;
uniform float aoIntensity;
uniform float maxDistance;
uniform float colorLods;
uniform float ssrIntensity;
uniform int debugView;
uniform float debugScale;
#ifdef USE_INDOOR
  uniform sampler2D indoorMap;
  uniform vec2 indoorMin;
  uniform vec2 indoorMax;
#endif
varying vec2 vUv;

#define MAX_STEPS 56
#define TRACE_ROUGHNESS ${TRACE_ROUGHNESS.toFixed(3)}

vec3 viewAt( vec2 uv, float depth ) {
  vec4 v = invProj * vec4( uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0 );
  return v.xyz / v.w;
}
float zAt( vec2 uv ) { return perspectiveDepthToViewZ( textureLod( tDepth, uv, 0.0 ).r, near, far ); }
float ign( vec2 p ) { return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) ); }

// Karis's analytic fit of the split-sum environment BRDF.
vec2 envBRDF( float NoV, float r ) {
  const vec4 c0 = vec4( - 1.0, - 0.0275, - 0.572, 0.022 );
  const vec4 c1 = vec4( 1.0, 0.0425, 1.04, - 0.04 );
  vec4 rr = r * c0 + c1;
  float a004 = min( rr.x * rr.x, exp2( - 9.28 * NoV ) ) * rr.x + rr.y;
  return vec2( - 1.04, 1.04 ) * a004 + rr.zw;
}

// Half floats top out at 65 504: the sky near the sun can pass it, and an overflow is infinite — which
// the bloom's blur would spread over the whole picture as NaN. Held finite here, before anything reads it.
vec3 finite( vec3 c ) {
  return any( isnan( c ) ) ? vec3( 0.0 ) : min( c, vec3( 6.0e4 ) );
}

void main() {
  vec3 col = finite( textureLod( tColor, vUv, 0.0 ).rgb );
  vec4 g = textureLod( tNormal, vUv, 0.0 );
  float code = g.a;
  bool glass = code >= ${SURFACE.glass.toFixed(1)} && code < ${(SURFACE.glass + 2).toFixed(1)};
  float ao = textureLod( tAO, vUv, 0.0 ).r;
  // Occlusion darkens surfaces: not glass (the view through it), a lit lens or the sky.
  float aoF = code < ${(SURFACE.light - 0.5).toFixed(1)} && ! glass ? mix( 1.0, ao, aoIntensity ) : 1.0;
  // Debug views are shown at the curve's white, whatever the exposure.
  if ( debugView == 2 ) {
    gl_FragColor = vec4( vec3( ao ) * debugScale, 1.0 );
    return;
  }
  if ( debugView == 3 ) {
    gl_FragColor = vec4( ( code < 2.0 ? vec3( 1.0 - code, 0.0, 0.0 ) : code < 4.0 ? vec3( 0.0, 3.0 - code, 0.0 ) : code < 6.0 ? vec3( 0.0, 0.0, 5.0 - code ) : vec3( code < 16.0 ? 0.2 : 0.0 ) ) * debugScale, 1.0 );
    return;
  }
  vec3 shown = col;
  // Alpha: what may bloom — a lamp's lens and the sky, never a surface however brightly lit.
  float blooms = code > ${(SURFACE.light - 0.5).toFixed(1)} ? 1.0 : 0.0;
  if ( code >= ${(SURFACE.glass + 2).toFixed(1)} ) {
    gl_FragColor = vec4( debugView == 1 ? vec3( 0.0 ) : col * aoF, blooms );
    return;
  }
  float base = code >= ${SURFACE.glass.toFixed(1)} ? ${SURFACE.glass.toFixed(1)} : code >= ${SURFACE.metal.toFixed(1)} ? ${SURFACE.metal.toFixed(1)} : 0.0;
  float rough = clamp( code - base, 0.0, 1.0 );
  float depth = textureLod( tDepth, vUv, 0.0 ).r;
  vec3 P = viewAt( vUv, depth );
  vec3 N = normalize( g.rgb * 2.0 - 1.0 );
  vec3 V = normalize( - P );
  float NoV = clamp( dot( N, V ), 0.0, 1.0 );
  vec3 R = normalize( reflect( - V, N ) );
  vec2 ab = envBRDF( NoV, rough );
  vec3 F0 = base == ${SURFACE.metal.toFixed(1)} ? vec3( 0.35 ) : vec3( 0.04 );
  vec3 spec = F0 * ab.x + ab.y;
  #ifdef USE_ENV
    vec3 Rr = normalize( mix( R, N, rough * rough ) );
    vec3 sky = finite( textureCubeUV( envMap, normalize( ( camWorld * vec4( Rr, 0.0 ) ).xyz ), rough ).rgb * envIntensity );
  #else
    vec3 sky = vec3( 0.0 );
  #endif

  // In a room (indoor.ts): the sky is not what a floor reflects.
  bool indoor = false;
  #ifdef USE_INDOOR
    if ( ! glass ) {
      vec3 Wp = ( camWorld * vec4( P, 1.0 ) ).xyz;
      vec2 iu = ( Wp.xy - indoorMin ) / ( indoorMax - indoorMin );
      if ( all( greaterThanEqual( iu, vec2( 0.0 ) ) ) && all( lessThanEqual( iu, vec2( 1.0 ) ) ) ) {
        vec2 span = textureLod( indoorMap, iu, 0.0 ).rg;
        indoor = span.y > span.x && Wp.z > span.x - 0.05 && Wp.z < span.y - 0.02;
      }
    }
  #endif

  float weight = ssrIntensity * ( 1.0 - smoothstep( TRACE_ROUGHNESS * 0.55, TRACE_ROUGHNESS, rough ) );
  vec3 hit = vec3( 0.0 );
  float conf = 0.0;
  if ( weight > 0.0 ) {
    // The ray, clipped to the near plane, in screen space and homogeneous view space.
    float len = maxDistance;
    if ( P.z + R.z * len > - near ) len = ( - near * 1.01 - P.z ) / R.z;
    vec3 E = P + R * len;
    vec4 H0 = proj * vec4( P, 1.0 );
    vec4 H1 = proj * vec4( E, 1.0 );
    float k0 = 1.0 / H0.w;
    float k1 = 1.0 / H1.w;
    vec2 S0 = ( H0.xy * k0 * 0.5 + 0.5 ) * resolution;
    vec2 S1 = ( H1.xy * k1 * 0.5 + 0.5 ) * resolution;
    vec3 Q0 = P * k0;
    vec3 Q1 = E * k1;
    float pixels = length( S1 - S0 );
    float steps = clamp( pixels / 3.0, 4.0, float( MAX_STEPS ) );
    float jitter = ign( gl_FragCoord.xy );
    float hitT = - 1.0;
    float prevT = 0.0;
    for ( int i = 1; i <= MAX_STEPS; i ++ ) {
      float t = ( float( i ) - 1.0 + jitter ) / steps;
      if ( t > 1.0 ) break;
      vec2 uv = mix( S0, S1, t ) / resolution;
      if ( uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0 ) break;
      float rayZ = mix( Q0.z, Q1.z, t ) / mix( k0, k1, t );
      float dz = zAt( uv ) - rayZ;
      if ( dz > 0.0 && dz < max( 0.12, 0.035 * abs( rayZ ) ) ) {
        // Bisect between the last step in front and this one behind.
        float a = prevT;
        float b = t;
        for ( int j = 0; j < 5; j ++ ) {
          float m = 0.5 * ( a + b );
          vec2 um = mix( S0, S1, m ) / resolution;
          float rz = mix( Q0.z, Q1.z, m ) / mix( k0, k1, m );
          if ( zAt( um ) - rz > 0.0 ) b = m; else a = m;
        }
        hitT = b;
        break;
      }
      prevT = t;
    }
    if ( hitT > 0.0 ) {
      vec2 S = mix( S0, S1, hitT );
      vec2 uv = S / resolution;
      vec4 gh = textureLod( tNormal, uv, 0.0 );
      vec3 Nh = normalize( gh.rgb * 2.0 - 1.0 );
      // Met from behind, or the sky: no hit.
      float facing = gh.a >= ${(SURFACE.sky - 0.5).toFixed(1)} ? 0.0 : smoothstep( 0.0, 0.25, - dot( Nh, R ) );
      vec2 edge = smoothstep( vec2( 0.0 ), vec2( 0.08 ), uv ) * ( 1.0 - smoothstep( vec2( 0.92 ), vec2( 1.0 ), uv ) );
      conf = edge.x * edge.y * ( 1.0 - smoothstep( 0.7, 1.0, hitT ) ) * facing * weight;
      float spread = rough * rough * length( S - S0 ) * 0.6 + rough * 6.0;
      hit = finite( textureLod( tColor, uv, clamp( log2( max( spread, 1.0 ) ), 0.0, colorLods ) ).rgb );
    }
  }
  if ( indoor ) col += spec * ( hit * conf - sky );
  else col += spec * ( hit - sky ) * conf;
  // What the sky's reflection was taken out of, and the trace's put in, in the occlusion's shade.
  col = max( col, shown * 0.25 ) * aoF;
  col = finite( col );
  gl_FragColor = vec4( debugView == 1 ? spec * hit * conf : debugView == 4 ? ( indoor ? vec3( 0.0, debugScale, 0.0 ) : vec3( debugScale, 0.0, 0.0 ) ) : col, 0.0 );
}`;

export interface ResolveInputs {
  /** Where the house is indoors (indoor.ts); null for none. */
  indoor: Indoor | null;
  color: THREE.Texture;
  ao: THREE.Texture | null;
  normal: THREE.Texture;
  depth: THREE.Texture;
  env: THREE.Texture | null;
}

export function resolveMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      tColor: { value: null },
      tAO: { value: null },
      tNormal: { value: null },
      tDepth: { value: null },
      envMap: { value: null },
      envIntensity: { value: 1 },
      proj: { value: new THREE.Matrix4() },
      invProj: { value: new THREE.Matrix4() },
      camWorld: { value: new THREE.Matrix4() },
      resolution: { value: new THREE.Vector2() },
      near: { value: 0.05 },
      far: { value: 4000 },
      aoIntensity: { value: 1 },
      maxDistance: { value: 14 },
      colorLods: { value: 6 },
      ssrIntensity: { value: 1 },
      debugView: { value: 0 },
      debugScale: { value: 1 },
      indoorMap: { value: null },
      indoorMin: { value: new THREE.Vector2() },
      indoorMax: { value: new THREE.Vector2(1, 1) },
    },
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });
}

/** Point the resolve at this frame's inputs and camera; `envDefines` are the prefiltered sky's (three.js's cube-UV sizes). */
export function setResolve(m: THREE.ShaderMaterial, inputs: ResolveInputs, camera: THREE.PerspectiveCamera, size: THREE.Vector2, aoIntensity: number, ssrIntensity: number): void {
  const u = m.uniforms;
  const set = (k: string, v: unknown) => {
    const x = u[k];
    if (x !== undefined) x.value = v;
  };
  set('tColor', inputs.color);
  set('tAO', inputs.ao);
  set('tNormal', inputs.normal);
  set('tDepth', inputs.depth);
  set('envMap', inputs.env);
  if (inputs.indoor !== null) {
    set('indoorMap', inputs.indoor.texture);
    (u['indoorMin']?.value as THREE.Vector2).copy(inputs.indoor.min);
    (u['indoorMax']?.value as THREE.Vector2).copy(inputs.indoor.max);
  }
  (u['proj']?.value as THREE.Matrix4).copy(camera.projectionMatrix);
  (u['invProj']?.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
  (u['camWorld']?.value as THREE.Matrix4).copy(camera.matrixWorld);
  (u['resolution']?.value as THREE.Vector2).copy(size);
  set('near', camera.near);
  set('far', camera.far);
  set('aoIntensity', inputs.ao === null ? 0 : aoIntensity);
  set('ssrIntensity', ssrIntensity);
  set('colorLods', Math.max(0, Math.floor(Math.log2(Math.max(size.x, size.y))) - 3));
  const env = inputs.env;
  const want: Record<string, string | number> = {};
  if (inputs.indoor !== null) want['USE_INDOOR'] = '';
  if (env !== null) {
    const h = (env.image as { height: number }).height;
    const maxMip = Math.log2(h) - 2;
    want['USE_ENV'] = '';
    want['ENVMAP_TYPE_CUBE_UV'] = '';
    want['CUBEUV_TEXEL_WIDTH'] = 1 / (3 * Math.max(2 ** maxMip, 7 * 16));
    want['CUBEUV_TEXEL_HEIGHT'] = 1 / h;
    want['CUBEUV_MAX_MIP'] = maxMip.toFixed(1);
  }
  const have = m.defines as Record<string, string | number>;
  const same = Object.keys(want).length === Object.keys(have).length && Object.entries(want).every(([k, v]) => have[k] === v);
  if (!same) {
    m.defines = want;
    m.needsUpdate = true;
  }
}
