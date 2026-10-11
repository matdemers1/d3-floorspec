/** Browser-mode commands: functions the browser tests call that run in Node (the Vitest server). */
import type { BrowserCommand } from 'vitest/node';
import { loadMesher, type DoorState } from '../src/index.js';
import { digest } from './digest.js';

/** Mesh a document in Node (its doors as `doors` says, FLR-T-13.8) and digest the result, so the browser can compare its own byte for byte. */
const meshDigestInNode: BrowserCommand<[text: string, doors?: DoorState | 'both']> = async (_ctx, text, doors) => digest((await loadMesher()).meshDocument(text, doors === undefined ? {} : { doors }));

export const nodeCommands = { meshDigestInNode };

declare module 'vitest/browser' {
  interface BrowserCommands {
    meshDigestInNode: (text: string, doors?: DoorState | 'both') => Promise<string>;
  }
}
