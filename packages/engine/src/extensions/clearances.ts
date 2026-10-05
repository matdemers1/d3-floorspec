/**
 * Floorspec's default clearance envelopes for the official extensions' kinds (FS_electrical 2.7,
 * FS_plumbing 2.5, FS_mechanical 2.5, FS_lowvoltage 2.6, FS_furniture 4.2): what a writer gives a new element when it
 * has no better information. These are Floorspec's own round numbers, never a code's — a code's
 * requirements are a Floorspec Rules pack's to state, with citations.
 */
import type { Box, ClearanceEnvelope, ExtensionElement } from '../model/document.js';
import { defaultFurnitureEnvelopes } from './fs/furniture.js';

const MM = 1280;
type Triple = [number, number, number];
const env = (purpose: ClearanceEnvelope['purpose'], min: Triple, max: Triple): ClearanceEnvelope => ({ purpose, shape: 'box', min, max });

/**
 * In front of the box (+x), `depth` deep; as wide as the box, or `width` wide centred on the frame
 * (`atLeast`: whichever is wider); from the box's bottom up `height`, or to its top.
 */
function front(b: Box, purpose: ClearanceEnvelope['purpose'], depth: number, opts: { width?: number; atLeast?: boolean; height?: number; toTop?: boolean } = {}): ClearanceEnvelope {
  const half = opts.width === undefined ? undefined : opts.width / 2;
  const z0 = b.min[2];
  const z1 = opts.height === undefined ? b.max[2] : opts.toTop ? Math.max(b.max[2], z0 + opts.height) : z0 + opts.height;
  return env(
    purpose,
    [b.max[0], half === undefined ? b.min[1] : opts.atLeast ? Math.min(b.min[1], -half) : -half, z0],
    [b.max[0] + depth, half === undefined ? b.max[1] : opts.atLeast ? Math.max(b.max[1], half) : half, z1],
  );
}

/**
 * The default envelopes of a new element of an official extension's kind, by name — `{}` for a kind
 * that has none. `element` needs its fallback box, and for a panel its host (the height of its frame
 * above the floor).
 */
export function defaultClearances(extension: string, collection: string, element: Pick<ExtensionElement, 'fallback' | 'host'> & Record<string, unknown>): Record<string, ClearanceEnvelope> {
  const b = element.fallback.box;
  switch (`${extension}/${collection}`) {
    case 'FS_electrical/panels': {
      const h = element.host?.mode === 'wallFace' ? element.host.height : 0;
      return { working: env('workingSpace', [0, Math.min(b.min[1], -400 * MM), -h], [1000 * MM, Math.max(b.max[1], 400 * MM), 2000 * MM - h]) };
    }
    case 'FS_plumbing/fixtures':
      if (element.fixture === 'waterCloset') return { front: front(b, 'fixtureClearance', 600 * MM, { width: 800 * MM, height: 2000 * MM }) };
      if (['lavatory', 'kitchenSink', 'barSink', 'laundryTub'].includes(element.fixture as string))
        return { front: front(b, 'fixtureClearance', 600 * MM, { height: 2000 * MM }) };
      return {};
    case 'FS_plumbing/waterHeaters':
      return { service: front(b, 'access', 600 * MM) };
    case 'FS_plumbing/cleanouts':
      return { access: front(b, 'access', 450 * MM, { width: 450 * MM, height: 450 * MM }) };
    case 'FS_mechanical/equipment':
      if (['furnace', 'airHandler', 'boiler'].includes(element.equipment as string))
        return { service: front(b, 'workingSpace', 750 * MM, { width: 750 * MM, atLeast: true, height: 2000 * MM, toTop: true }) };
      return {};
    case 'FS_furniture/pieces':
    case 'FS_furniture/appliances':
    case 'FS_furniture/casework':
      return typeof element.category === 'string' ? defaultFurnitureEnvelopes(element.category, b) : {};
    case 'FS_lowvoltage/headEnds':
      return { access: front(b, 'access', 600 * MM) };
    default:
      return {};
  }
}
