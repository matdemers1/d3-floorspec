/**
 * The few web-platform globals the engine uses, all of which exist in every browser and in Node:
 * the build loads neither the DOM nor Node's types (FLR-ADR-010), so they are declared here.
 */
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
declare function structuredClone<T>(value: T): T;
