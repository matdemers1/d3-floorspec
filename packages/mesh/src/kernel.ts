/**
 * manifold-3d, loaded once and lazily. The WASM module is fetched the first time a caller needs it
 * and shared by every caller after that, in Node and in the browser alike.
 *
 * In Node the module reads `manifold.wasm` beside its own script; in a browser it resolves
 * `new URL('manifold.wasm', import.meta.url)`, which Vite (and Vitest's browser mode) turn into an
 * asset URL. A bundler that does neither passes `locateFile` to point at the file.
 *
 * The types below are the part of manifold-3d's API this package uses, written out: the package's
 * own declarations import their siblings without extensions, which NodeNext resolution cannot
 * follow, so through them every member would silently be `any`.
 */
import Module from 'manifold-3d';

export type Vec2 = [number, number];
export type Box = { min: [number, number, number]; max: [number, number, number] };

/** A watertight solid in WASM memory: free it with `delete()`. */
export interface Manifold {
  translate(x: number, y?: number, z?: number): Manifold;
  scale(s: number): Manifold;
  subtract(other: Manifold): Manifold;
  intersect(other: Manifold): Manifold;
  isEmpty(): boolean;
  volume(): number;
  genus(): number;
  status(): string;
  boundingBox(): Box;
  getMesh(): MeshData;
  delete(): void;
}

export interface MeshData {
  numProp: number;
  vertProperties: Float32Array;
  triVerts: Uint32Array;
}

export interface Kernel {
  Manifold: {
    new (mesh: MeshData): Manifold;
    /** Extrude plan polygons (outer rings counter-clockwise, holes clockwise) from z = 0 up to `height`. */
    extrude(polygons: Vec2[][], height: number): Manifold;
    union(manifolds: readonly Manifold[]): Manifold;
    difference(manifolds: readonly Manifold[]): Manifold;
  };
  Mesh: new (options: MeshData) => MeshData;
  /** Triangulate polygons with holes: index triples into the rings' points, concatenated in order, counter-clockwise. */
  triangulate(polygons: Vec2[][], epsilon?: number): [number, number, number][];
}

export interface KernelOptions {
  /** Where `manifold.wasm` is served, for a bundler that does not resolve `new URL(…, import.meta.url)`. */
  locateFile?: () => string;
}

let loading: Promise<Kernel> | undefined;

/** The manifold-3d module, initialised once. Later calls return the same promise and ignore their options. */
export function loadKernel(options: KernelOptions = {}): Promise<Kernel> {
  loading ??= (async () => {
    const m = await Module(options.locateFile ? { locateFile: options.locateFile } : undefined);
    m.setup();
    // Its own declarations type these members as `any` under NodeNext (above): name what they are.
    const kernel: Kernel = m;
    return kernel;
  })();
  return loading;
}

/** Something manifold-3d allocated in WASM memory, which JavaScript's collector never frees. */
interface Deletable {
  delete(): void;
}

/**
 * Run `f` with a scope that frees every WASM object handed to `keep`, whatever `f` returns or
 * throws. Each Manifold is created inside such a scope.
 */
export function scoped<T>(f: (keep: <D extends Deletable>(d: D) => D) => T): T {
  const owned: Deletable[] = [];
  try {
    return f((d) => {
      owned.push(d);
      return d;
    });
  } finally {
    for (const d of owned) d.delete();
  }
}
