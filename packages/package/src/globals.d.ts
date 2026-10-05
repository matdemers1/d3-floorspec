/**
 * The one web-platform global this package uses beyond the engine's (its globals.d.ts declares
 * TextEncoder and structuredClone). It exists in every browser and in Node; the build loads neither
 * the DOM nor Node's types (FLR-ADR-010), so it is declared here.
 */
declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  decode(input?: Uint8Array): string;
}
