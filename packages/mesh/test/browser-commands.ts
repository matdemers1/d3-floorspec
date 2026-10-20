/** Browser-mode commands: functions the browser tests call that run in Node (the Vitest server). */
import type { BrowserCommand } from 'vitest/node';
import { deriveEvaluation, evaluate } from '@floorspec/engine';
import { loadMesher, xrayMeshes, xrayPlan, type DoorState } from '../src/index.js';
import { digest, xrayDigest } from './digest.js';

/** Mesh a document in Node (its doors as `doors` says, FLR-T-13.8) and digest the result, so the browser can compare its own byte for byte. */
const meshDigestInNode: BrowserCommand<[text: string, doors?: DoorState | 'both']> = async (_ctx, text, doors) => digest((await loadMesher()).meshDocument(text, doors === undefined ? {} : { doors }));

/** X-ray a document in Node (FLR-T-14.5) and digest its meshes about an origin, for the browser to compare. */
const xrayDigestInNode: BrowserCommand<[text: string, origin: [number, number, number]]> = (_ctx, text, origin) => {
  const ev = evaluate(text, {});
  return xrayDigest(xrayMeshes(xrayPlan((ev.view ?? ev.document)!, deriveEvaluation(ev)), origin));
};

export const nodeCommands = { meshDigestInNode, xrayDigestInNode };

declare module 'vitest/browser' {
  interface BrowserCommands {
    meshDigestInNode: (text: string, doors?: DoorState | 'both') => Promise<string>;
    xrayDigestInNode: (text: string, origin: [number, number, number]) => Promise<string>;
  }
}
