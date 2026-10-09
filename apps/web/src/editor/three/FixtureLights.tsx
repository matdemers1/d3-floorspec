import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { ViewLight } from './lights';

/**
 * The house's light fixtures, lit (FLR-T-12.22): a three.js point light for each light that shines
 * every way and a spot pointing down for each downlight, track and under-cabinet strip — placed,
 * sized and shadowed as lights.ts works out. Each light's `userData.fixture` is its element's ID.
 */
export function FixtureLights({ lights }: { lights: readonly ViewLight[] }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => { invalidate(); }, [lights, invalidate]);
  return (
    <>
      {lights.map((l) => (l.kind === 'spot' ? <SpotLamp key={l.id} light={l} /> : <PointLamp key={l.id} light={l} />))}
    </>
  );
}

/** Shadow settings for a lamp a few centimetres from the surfaces it lights. */
function shade(shadow: THREE.LightShadow, far: number): void {
  shadow.mapSize.set(512, 512);
  shadow.bias = -0.002;
  shadow.normalBias = 0.02;
  shadow.radius = 3;
  const cam = shadow.camera as THREE.PerspectiveCamera;
  cam.near = 0.03;
  cam.far = far;
  cam.updateProjectionMatrix();
  shadow.needsUpdate = true;
}

function PointLamp({ light }: { light: ViewLight }) {
  const ref = useRef<THREE.PointLight>(null);
  useLayoutEffect(() => {
    if (ref.current !== null && light.shadow) shade(ref.current.shadow, light.distance);
  }, [light]);
  return (
    <pointLight
      ref={ref}
      position={light.position}
      color={light.color}
      intensity={light.intensity}
      distance={light.distance}
      decay={2}
      castShadow={light.shadow}
      userData={{ fixture: light.id }}
    />
  );
}

function SpotLamp({ light }: { light: ViewLight }) {
  const ref = useRef<THREE.SpotLight>(null);
  const target = useMemo(() => new THREE.Object3D(), []);
  useLayoutEffect(() => {
    const [x, y, z] = light.position;
    target.position.set(x, y, z - 1);
    target.updateMatrixWorld();
    if (ref.current !== null && light.shadow) shade(ref.current.shadow, light.distance);
  }, [light, target]);
  return (
    <>
      <primitive object={target} />
      <spotLight
        ref={ref}
        position={light.position}
        target={target}
        color={light.color}
        intensity={light.intensity}
        distance={light.distance}
        decay={2}
        angle={light.angle ?? Math.PI / 4}
        penumbra={light.penumbra ?? 0.5}
        castShadow={light.shadow}
        userData={{ fixture: light.id }}
      />
    </>
  );
}
