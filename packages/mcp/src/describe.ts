import { collection, read } from './model.js';
import { squareFeet } from './units.js';

/**
 * **A stub of `floorspec_describe`**, standing in until the room-centric summary in
 * `./summary/` (walls by cardinal side, openings, adjacency and the door graph) is merged. It lists
 * levels and rooms with their net areas, and says that it is a stub, so nobody mistakes it for the
 * summary the agent eval is run against.
 */
export function describeStub(document: unknown, options: { level?: string; room?: string } = {}) {
  const model = read(document);
  const doc = model.document;
  const rooms = collection(doc, 'rooms')
    .filter(([, room]) => options.level === undefined || room['level'] === options.level)
    .filter(([id, room]) => options.room === undefined || id === options.room || (typeof room['name'] === 'string' && room['name'].toLowerCase() === options.room.toLowerCase()))
    .map(([id, room]) => {
      const area = model.derived?.rooms[id]?.area;
      return {
        id,
        name: room['name'] ?? null,
        function: room['function'] ?? null,
        level: room['level'] ?? null,
        netArea: area === undefined ? null : { sqft: squareFeet(area), units: area },
      };
    });
  const count = (name: string) => collection(doc, name).length;
  const project = doc['project'] as { name?: unknown } | undefined;
  return {
    summary: 'stub',
    note: 'The full room-centric summary (walls by side, openings, adjacency, door graph) is not merged yet; this lists levels and rooms only.',
    projectName: typeof project?.name === 'string' ? project.name : null,
    valid: model.valid,
    levels: collection(doc, 'levels').map(([id, level]) => ({ id, name: level['name'] ?? null, elevation: level['elevation'] ?? null })),
    rooms,
    unnamedFaces: model.derived?.unanchored.length ?? 0,
    counts: {
      walls: count('walls'),
      separators: count('separators'),
      openings: count('openings'),
      junctions: count('junctions'),
      types: count('types'),
    },
    diagnostics: {
      errors: model.diagnostics.filter((d) => d.severity === 'error').length,
      warnings: model.diagnostics.filter((d) => d.severity === 'warning').length,
    },
  };
}
