/** An element of a collection by ID, or undefined: own members only, as the engine reads them (1.4). */
export const get = <T>(c: Record<string, T | undefined> | undefined, id: string): T | undefined => (c && Object.hasOwn(c, id) ? c[id] : undefined);
