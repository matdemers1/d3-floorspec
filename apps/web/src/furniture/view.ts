import type { Diagnostic, FloorspecDocument } from '@floorspec/engine';
import type { EditorModel, LevelView } from '../editor/model';
import type { DeviceView } from '../editor/systems/view';
import { EXTENSION } from './ops';

/**
 * What the plan, the 3D view and the inspector read of an FS_furniture element (FLR-T-8.3): its
 * model's and symbol's files, by the document's assets (Core 18.4), and the lints that name it
 * (FS_furniture 5.3). Nothing here computes a position: the engine derived the footprint, the
 * placement and the envelopes, and they are on the element's DeviceView.
 */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export const isFurniture = (d: { extension: string }): boolean => d.extension === EXTENSION;

/** The furniture on a level. */
export const furnitureOn = (level: LevelView): DeviceView[] => level.devices.filter(isFurniture);

export interface AssetFile {
  id: string;
  sha256: string;
  mediaType: string;
  byteLength: number | null;
  name: string | null;
}

/** An asset of the document by ID, when it is a packaged file with a digest. */
export function assetOf(document: FloorspecDocument, id: unknown): AssetFile | null {
  if (typeof id !== 'string') return null;
  const a = (document.assets as Record<string, Json | undefined> | undefined)?.[id];
  if (!isObject(a) || typeof a['sha256'] !== 'string' || !/^[0-9a-f]{64}$/.test(a['sha256'])) return null;
  return {
    id,
    sha256: a['sha256'],
    mediaType: typeof a['mediaType'] === 'string' ? a['mediaType'] : '',
    byteLength: typeof a['byteLength'] === 'number' ? a['byteLength'] : null,
    name: typeof a['name'] === 'string' ? a['name'] : null,
  };
}

/** An element's fallback model and symbol (Core 12.6). */
export function filesOf(document: FloorspecDocument, element: Json): { model: AssetFile | null; symbol: AssetFile | null } {
  const fb = isObject(element['fallback']) ? element['fallback'] : {};
  return { model: assetOf(document, fb['asset']), symbol: assetOf(document, fb['symbol']) };
}

/** The interference and placement lints that name an element (FS_furniture 5.3), and Core's own about it. */
export function lintsOf(model: EditorModel, id: string): Diagnostic[] {
  return model.diagnostics.filter((d) => d.severity !== 'error' && d.elements.includes(id));
}

/** "a refrigerator door that cannot open": FS-FURN-LINT-004 and 005 in a person's words. */
export function lintText(model: EditorModel, d: Diagnostic, id: string, label: (id: string) => string): string {
  const others = d.elements.filter((e) => e !== id).map(label);
  switch (d.code) {
    case 'FS-FURN-LINT-004': {
      // The diagnostic's elements are sorted; the engine's message says which one owns the envelope.
      const owner = /of (\S+) runs into/.exec(d.message)?.[1];
      if (owner === id) return `Its clearance runs into ${others.join(', ')}: something stands where it needs space kept clear.`;
      if (owner !== undefined) return `It stands in the clearance of ${others.join(', ')}.`;
      return `A clearance and ${others.join(', ')} are in each other’s way.`;
    }
    case 'FS-FURN-LINT-005':
      return `It collides with ${others.join(', ')}.`;
    case 'FS-FURN-LINT-001':
      return 'It has no clearance envelope of the purpose its category needs.';
    case 'FS-FURN-LINT-002':
      return 'Its box reaches behind the wall face it is hosted on.';
    case 'FS-FURN-LINT-003':
      return 'It hangs on a wall, but is not hosted on a wall face.';
    default:
      return d.message;
  }
}

/** "1.2 MB", "412 KB". */
export function bytesText(n: number | null): string {
  if (n === null) return 'size not stated';
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${String(Math.round(n / 1024))} KB`;
  return `${String(n)} bytes`;
}
