/** Browser-mode commands: functions the browser tests call that run in Node (the Vitest server). */
import type { BrowserCommand } from 'vitest/node';
import { loadMesher } from '../src/index.js';
import { digest } from './digest.js';

/** Mesh a document in Node and digest the result, so the browser can compare its own byte for byte. */
const meshDigestInNode: BrowserCommand<[text: string]> = async (_ctx, text) => digest((await loadMesher()).meshDocument(text));

export const nodeCommands = { meshDigestInNode };

declare module 'vitest/browser' {
  interface BrowserCommands {
    meshDigestInNode: (text: string) => Promise<string>;
  }
}
