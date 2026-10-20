import type { Command } from '../commands';
import type { EditorStore, ToolId } from '../store';

/**
 * The site's tools (FLR-T-15.1), in the registry so the palette and the keys reach them alike: the lot
 * (⇧B, its boundary), the setback tool (⇧K: click the street edge), a spot elevation (⇧E), a contour
 * line (⇧C) and a grading pad (⇧G). Landscape mode's rail shows them.
 */

const drawable = (store: EditorStore): boolean => {
  const s = store.get();
  return s.readOnly === null && s.model !== null && s.level !== null && s.compare === null;
};

const siteTool = (tool: ToolId, label: string, letter: string, keywords: string): Command => ({
  id: `tool.${tool}`,
  label,
  group: 'Tools',
  keywords: `site landscape ${keywords}`,
  codes: [`Shift+Key${letter}`],
  hint: `⇧${letter}`,
  enabled: drawable,
  run: (store, tools) => {
    tools.setTool(store.get().tool === tool ? 'select' : tool);
  },
});

export const SITE_COMMANDS: readonly Command[] = [
  siteTool('lot', 'Draw the lot — its boundary, corner by corner', 'B', 'lot boundary property line plat survey'),
  siteTool('setback', 'Setbacks — click the lot edge on the street', 'K', 'setback street front side rear'),
  siteTool('spot', 'Spot elevation — a height of the ground', 'E', 'spot elevation level height grade survey topography'),
  siteTool('contour', 'Contour line — a line of the ground at one height', 'C', 'contour topography terrain survey'),
  siteTool('pad', 'Grade pad — ground set to one height, cut and filled', 'G', 'pad grade grading cut fill earthwork'),
  // FLR-T-15.2: a fence or a garden wall (FS_outdoor), drawn as a wall is, its gates openings along it.
  siteTool('fence', 'Fence — a fence or a garden wall, drawn point to point', 'F', 'fence wall gate garden yard outdoor'),
];
