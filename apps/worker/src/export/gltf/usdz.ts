/**
 * USDZ for augmented reality on a tablet (FLR-T-9.2, FLR-REQ-128): AR Quick Look on an iPad opens
 * it and stands the house on the floor at 1:1.
 *
 * The package is a stored, 64-byte-aligned ZIP (zip.ts) whose first file is the root layer, written
 * as USDA text — the plainest form of USD, which every USD reader accepts — with `metersPerUnit = 1`
 * and `upAxis = "Y"`. It holds the same scene as the glTF export: an Xform per level and per element
 * (prim names are made safe for USD; the Floorspec ID is in each prim's `customData`), a Mesh per
 * primitive with face-varying flat normals, and a `UsdPreviewSurface` material per material, with
 * its maps as `UsdUVTexture`s reading `st` when their PNG or JPEG bytes are given.
 *
 * AR Quick Look puts the stage's origin on the floor it finds, so the model is moved: the centre of
 * its footprint to the origin and its lowest point to y = 0. The translation is on the root prim and
 * in `customLayerData`, so the document's coordinates can be recovered.
 */
import type { ImageSource } from './glb.js';
import type { Scene, SceneMaterial, Vec3 } from './scene.js';
import { storeZip, type ZipEntry } from './zip.js';

export interface UsdzOptions {
  readonly about?: Record<string, unknown>;
  readonly images?: ImageSource;
}

export interface UsdzResult {
  readonly bytes: Uint8Array;
  readonly usda: string;
  readonly triangles: number;
  readonly materials: number;
  readonly embedded: string[];
  readonly omitted: { asset: string; reason: string }[];
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg' };

/** Lengths to the micrometre, unit vectors and factors to six places; no trailing zeros, no −0. */
function num(x: number, places = 6): string {
  const s = x.toFixed(places);
  const t = s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  return t === '-0' ? '0' : t;
}

const str = (s: string): string => JSON.stringify(s);

/** A USD prim name: an identifier, unique among its siblings. */
function namer(): (raw: string) => string {
  const used = new Set<string>();
  return (raw) => {
    let base = raw.replace(/[^A-Za-z0-9_]/g, '_');
    if (!/^[A-Za-z_]/.test(base)) base = `_${base}`;
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}_${String(i)}`;
    used.add(name);
    return name;
  };
}

function dictionary(value: Record<string, unknown>, indent: string): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined || v === null) continue;
    const key = k.replace(/[^A-Za-z0-9_]/g, '_');
    if (typeof v === 'string') lines.push(`${indent}string ${key} = ${str(v)}`);
    else if (typeof v === 'number') lines.push(`${indent}${Number.isInteger(v) ? 'int64' : 'double'} ${key} = ${String(v)}`);
    else if (typeof v === 'boolean') lines.push(`${indent}bool ${key} = ${v ? '1' : '0'}`);
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) lines.push(`${indent}string[] ${key} = [${v.map((x) => str(x)).join(', ')}]`);
    else if (typeof v === 'object') lines.push(`${indent}dictionary ${key} = {\n${dictionary(v as Record<string, unknown>, `${indent}    `)}\n${indent}}`);
  }
  return lines.join('\n');
}

/** Write the scene as a USDZ. */
export function writeUsdz(scene: Scene, options: UsdzOptions = {}): UsdzResult {
  const files: ZipEntry[] = [];
  const embedded: string[] = [];
  const omitted: { asset: string; reason: string }[] = [];
  const fileOf = new Map<string, string | null>();
  const textureFile = (asset: string): string | null => {
    if (fileOf.has(asset)) return fileOf.get(asset)!;
    const info = scene.assets[asset];
    let file: string | null = null;
    if (info !== undefined) {
      const ext = EXT[info.mediaType];
      const bytes = ext === undefined ? undefined : options.images?.({ id: asset, sha256: info.sha256, mediaType: info.mediaType });
      if (ext === undefined) omitted.push({ asset, reason: `AR Quick Look does not read ${info.mediaType}` });
      else if (bytes === undefined) omitted.push({ asset, reason: 'its bytes were not available to the exporter' });
      else {
        file = `textures/${asset.replace(/[^A-Za-z0-9._-]/g, '_')}.${ext}`;
        files.push({ name: file, bytes });
        embedded.push(asset);
      }
    }
    fileOf.set(asset, file);
    return file;
  };
  const usda = usdaOf(scene, options.about ?? {}, textureFile);
  const triangles = scene.levels.reduce((n, l) => n + l.nodes.reduce((m, node) => m + node.primitives.reduce((k, p) => k + p.indices.length / 3, 0), 0), 0);
  const bytes = storeZip([{ name: 'model.usda', bytes: new TextEncoder().encode(usda) }, ...files]);
  return { bytes, usda, triangles, materials: scene.materials.length, embedded, omitted };
}

/** The root layer's text. `textureFile` names a map's file in the package, or null without one. */
export function usdaOf(scene: Scene, about: Record<string, unknown>, textureFile: (asset: string) => string | null = () => null): string {
  // The footprint's centre to the origin, the lowest point to the floor.
  const b = scene.bounds ?? { min: [0, 0, 0] as Vec3, max: [0, 0, 0] as Vec3 };
  const shift: Vec3 = [-(b.min[0] + b.max[0]) / 2, -b.min[1], -(b.min[2] + b.max[2]) / 2];
  const out: string[] = [];
  out.push('#usda 1.0');
  out.push('(');
  out.push('    customLayerData = {');
  out.push(`        dictionary floorspec = {\n${dictionary({ ...about, design: scene.design ?? undefined, origin: `translate ${shift.map((v) => num(v)).join(' ')} undoes this to the document's frame` }, '            ')}\n        }`);
  out.push('    }');
  out.push('    defaultPrim = "Model"');
  out.push('    doc = "Exported by D3 Floorspec from a Floorspec model: metres, +Y up."');
  out.push('    metersPerUnit = 1');
  out.push('    upAxis = "Y"');
  out.push(')');
  out.push('');
  out.push('def Xform "Model" (');
  out.push(`    assetInfo = {\n        string name = ${str(scene.project)}\n    }`);
  out.push('    kind = "component"');
  out.push(')');
  out.push('{');
  out.push(`    double3 xformOp:translate = (${shift.map((v) => num(v)).join(', ')})`);
  out.push('    uniform token[] xformOpOrder = ["xformOp:translate"]');
  out.push('');

  const matName = namer();
  const matPaths = scene.materials.map((m) => `/Model/Materials/${matName(m.floorspec === undefined ? m.key.replace('default:', 'Default_') : `M_${m.floorspec}`)}`);
  out.push('    def Scope "Materials"');
  out.push('    {');
  scene.materials.forEach((m, i) => out.push(materialUsda(m, matPaths[i]!, textureFile)));
  out.push('    }');

  const levelName = namer();
  for (const level of scene.levels) {
    out.push('');
    out.push(`    def Xform ${str(levelName(level.id))} (`);
    out.push(`        customData = {\n            string floorspecId = ${str(level.id)}\n            string floorspecKind = "level"${level.name === undefined ? '' : `\n            string floorspecName = ${str(level.name)}`}\n        }`);
    out.push('    )');
    out.push('    {');
    const nodeName = namer();
    for (const node of level.nodes) {
      if (node.primitives.length === 0) continue;
      out.push(`        def Xform ${str(nodeName(node.id))} (`);
      out.push(
        `            customData = {\n                string floorspecId = ${str(node.id)}\n                string floorspecKind = ${str(node.kind)}${node.name === undefined ? '' : `\n                string floorspecName = ${str(node.name)}`}\n            }`,
      );
      out.push('        )');
      out.push('        {');
      const meshName = namer();
      for (const p of node.primitives) {
        const n = p.indices.length / 3;
        const pts: string[] = [];
        for (let i = 0; i < p.positions.length; i += 3) pts.push(`(${num(p.positions[i]!)}, ${num(p.positions[i + 1]!)}, ${num(p.positions[i + 2]!)})`);
        // Face-varying normals: a flat face's normal at each of its corners, so nothing is smoothed.
        const normals: string[] = [];
        for (let k = 0; k < p.indices.length; k++) {
          const v = p.indices[k]!;
          normals.push(`(${num(p.normals[3 * v]!)}, ${num(p.normals[3 * v + 1]!)}, ${num(p.normals[3 * v + 2]!)})`);
        }
        let lo: Vec3 = [Infinity, Infinity, Infinity];
        let hi: Vec3 = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < p.positions.length; i += 3)
          for (let k = 0; k < 3; k++) {
            lo[k] = Math.min(lo[k]!, p.positions[i + k]!);
            hi[k] = Math.max(hi[k]!, p.positions[i + k]!);
          }
        if (!Number.isFinite(lo[0])) lo = hi = [0, 0, 0];
        out.push(`            def Mesh ${str(meshName(p.part))} (`);
        out.push('                prepend apiSchemas = ["MaterialBindingAPI"]');
        out.push('            )');
        out.push('            {');
        out.push('                uniform bool doubleSided = 0');
        out.push(`                float3[] extent = [(${lo.map((v) => num(v)).join(', ')}), (${hi.map((v) => num(v)).join(', ')})]`);
        out.push(`                int[] faceVertexCounts = [${new Array<string>(n).fill('3').join(', ')}]`);
        out.push(`                int[] faceVertexIndices = [${Array.from(p.indices).join(', ')}]`);
        out.push(`                rel material:binding = <${matPaths[p.material]!}>`);
        out.push(`                normal3f[] normals = [${normals.join(', ')}] (\n                    interpolation = "faceVarying"\n                )`);
        out.push(`                point3f[] points = [${pts.join(', ')}]`);
        if (p.uvs !== null) {
          // USD's t runs up the image, glTF's v down it.
          const st: string[] = [];
          for (let i = 0; i < p.uvs.length; i += 2) st.push(`(${num(p.uvs[i]!)}, ${num(-p.uvs[i + 1]!)})`);
          out.push(`                texCoord2f[] primvars:st = [${st.join(', ')}] (\n                    interpolation = "vertex"\n                )`);
        }
        out.push('                uniform token subdivisionScheme = "none"');
        out.push('            }');
      }
      out.push('        }');
    }
    out.push('    }');
  }
  out.push('}');
  out.push('');
  return out.join('\n');
}

function materialUsda(m: SceneMaterial, path: string, textureFile: (asset: string) => string | null): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const maps = m.texture?.maps ?? {};
  const files = {
    base: maps.asset === undefined ? null : textureFile(maps.asset),
    normal: maps.normal === undefined ? null : textureFile(maps.normal),
    mr: maps.metallicRoughness === undefined ? null : textureFile(maps.metallicRoughness),
    occlusion: maps.occlusion === undefined ? null : textureFile(maps.occlusion),
  };
  const textured = Object.values(files).some((f) => f !== null);
  const i = '            ';
  const lines: string[] = [];
  lines.push(`        def Material ${str(name)} (`);
  lines.push(`            customData = {\n                string floorspecMaterial = ${str(m.floorspec ?? m.key)}\n                string displayName = ${str(m.name)}\n            }`);
  lines.push('        )');
  lines.push('        {');
  lines.push(`${i}token outputs:surface.connect = <${path}/Surface.outputs:surface>`);
  if (textured) lines.push(`${i}string inputs:frame:stPrimvarName = "st"`);
  lines.push(`${i}def Shader "Surface"`);
  lines.push(`${i}{`);
  lines.push(`${i}    uniform token info:id = "UsdPreviewSurface"`);
  const [r, g, b, a] = m.baseColor;
  if (files.base !== null) lines.push(`${i}    color3f inputs:diffuseColor.connect = <${path}/BaseColor.outputs:rgb>`);
  else lines.push(`${i}    color3f inputs:diffuseColor = (${num(r)}, ${num(g)}, ${num(b)})`);
  const metallic = files.mr === null ? m.metallic : (m.declared.metallic ?? 1000) / 1000;
  const roughness = files.mr === null ? m.roughness : (m.declared.roughness ?? 1000) / 1000;
  if (files.mr !== null) {
    lines.push(`${i}    float inputs:metallic.connect = <${path}/MetallicRoughness.outputs:b>`);
    lines.push(`${i}    float inputs:roughness.connect = <${path}/MetallicRoughness.outputs:g>`);
  } else {
    lines.push(`${i}    float inputs:metallic = ${num(metallic)}`);
    lines.push(`${i}    float inputs:roughness = ${num(roughness)}`);
  }
  if (files.normal !== null) lines.push(`${i}    normal3f inputs:normal.connect = <${path}/Normal.outputs:rgb>`);
  if (files.occlusion !== null) lines.push(`${i}    float inputs:occlusion.connect = <${path}/Occlusion.outputs:r>`);
  lines.push(`${i}    float inputs:opacity = ${num(a)}`);
  lines.push(`${i}    int inputs:useSpecularWorkflow = 0`);
  lines.push(`${i}    token outputs:surface`);
  lines.push(`${i}}`);
  if (textured) {
    lines.push(`${i}def Shader "TexCoords"`);
    lines.push(`${i}{`);
    lines.push(`${i}    uniform token info:id = "UsdPrimvarReader_float2"`);
    lines.push(`${i}    string inputs:varname.connect = <${path}.inputs:frame:stPrimvarName>`);
    lines.push(`${i}    float2 outputs:result`);
    lines.push(`${i}}`);
    const tex = (shader: string, file: string, space: 'sRGB' | 'raw', outputs: string[], scaleBias?: { scale: string; bias: string }) => {
      lines.push(`${i}def Shader ${str(shader)}`);
      lines.push(`${i}{`);
      lines.push(`${i}    uniform token info:id = "UsdUVTexture"`);
      lines.push(`${i}    asset inputs:file = @${file}@`);
      lines.push(`${i}    float2 inputs:st.connect = <${path}/TexCoords.outputs:result>`);
      lines.push(`${i}    token inputs:sourceColorSpace = "${space}"`);
      lines.push(`${i}    token inputs:wrapS = "repeat"`);
      lines.push(`${i}    token inputs:wrapT = "repeat"`);
      if (scaleBias !== undefined) {
        lines.push(`${i}    float4 inputs:scale = ${scaleBias.scale}`);
        lines.push(`${i}    float4 inputs:bias = ${scaleBias.bias}`);
      }
      for (const o of outputs) lines.push(`${i}    ${o}`);
      lines.push(`${i}}`);
    };
    if (files.base !== null) tex('BaseColor', files.base, 'sRGB', ['float3 outputs:rgb']);
    if (files.mr !== null) tex('MetallicRoughness', files.mr, 'raw', ['float outputs:g', 'float outputs:b'], { scale: `(1, ${num(roughness)}, ${num(metallic)}, 1)`, bias: '(0, 0, 0, 0)' });
    if (files.normal !== null) tex('Normal', files.normal, 'raw', ['float3 outputs:rgb'], { scale: '(2, 2, 2, 1)', bias: '(-1, -1, -1, 0)' });
    if (files.occlusion !== null) tex('Occlusion', files.occlusion, 'raw', ['float outputs:r']);
  }
  lines.push('        }');
  return lines.join('\n');
}
