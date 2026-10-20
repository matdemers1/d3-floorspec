/**
 * The menu in the headset (FLR-T-14.3, the board's "In the headset" frame): the house's name and where
 * you are, a button per level (the one you are on marked), the roofs, and Exit VR — drawn on a canvas
 * that becomes the texture of a panel at your side, and pressed by pointing at it and pulling the
 * trigger (or pinching). Laid out here without a canvas, so where each button is can be tested.
 */

export interface MenuColours {
  surface: string;
  border: string;
  fg: string;
  muted: string;
  accent: string;
  accentFg: string;
  danger: string;
}

export interface MenuModel {
  house: string;
  /** "Kitchen · Level 1". */
  where: string;
  /** Top level first, as the board lists them. */
  levels: readonly { id: string; name: string }[];
  current: string | null;
  roofs: boolean;
  /** A line under the buttons: why a teleport cannot land, or the controls. */
  note: string;
}

export type MenuAction = { kind: 'level'; level: string } | { kind: 'roofs' } | { kind: 'exit' };

export interface MenuButton {
  action: MenuAction;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The canvas's size, pixels, and the panel's, metres: about a hand's span wide. */
export const MENU_PX = { width: 512, pad: 28, row: 72, gap: 14 } as const;
export const MENU_WIDTH_M = 0.26;

/** Where each button is, and how tall the menu is. */
export function menuLayout(m: Pick<MenuModel, 'levels'>): { height: number; buttons: MenuButton[] } {
  const { width, pad, row, gap } = MENU_PX;
  const inner = width - 2 * pad;
  let y = pad + 96 + 34; // the title, where you are, and the "Level" overline
  const buttons: MenuButton[] = [];
  for (const l of m.levels) {
    buttons.push({ action: { kind: 'level', level: l.id }, x: pad, y, w: inner, h: row });
    y += row + gap;
  }
  y += 8;
  buttons.push({ action: { kind: 'roofs' }, x: pad, y, w: inner, h: row - 16 });
  y += row - 16 + gap;
  buttons.push({ action: { kind: 'exit' }, x: pad, y, w: inner, h: row - 8 });
  y += row - 8 + gap;
  return { height: y + 56 + pad, buttons };
}

/** The button under a point of the canvas, if any. */
export function buttonAt(buttons: readonly MenuButton[], x: number, y: number): MenuButton | null {
  return buttons.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) ?? null;
}

const same = (a: MenuAction, b: MenuAction | null) => b !== null && a.kind === b.kind && (a.kind !== 'level' || (b.kind === 'level' && a.level === b.level));

/** Draw the menu: the board's dark card, its buttons, the one under the pointer lit. */
export function drawMenu(ctx: CanvasRenderingContext2D, m: MenuModel, c: MenuColours, hover: MenuAction | null): { height: number; buttons: MenuButton[] } {
  const layout = menuLayout(m);
  const { width, pad } = MENU_PX;
  const H = layout.height;
  ctx.clearRect(0, 0, width, H);
  rounded(ctx, 2, 2, width - 4, H - 4, 28);
  ctx.fillStyle = c.surface;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = c.border;
  ctx.stroke();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = c.fg;
  ctx.font = '600 34px Inter, system-ui, sans-serif';
  ctx.fillText(clip(ctx, m.house, width - 2 * pad), pad, pad + 24);
  ctx.fillStyle = c.muted;
  ctx.font = '500 26px Inter, system-ui, sans-serif';
  ctx.fillText(clip(ctx, m.where, width - 2 * pad), pad, pad + 66);
  ctx.font = '600 20px Inter, system-ui, sans-serif';
  ctx.fillText('LEVEL', pad, pad + 112);
  for (const b of layout.buttons) {
    const lit = same(b.action, hover);
    if (b.action.kind === 'level') {
      const here = b.action.level === m.current;
      const name = m.levels.find((l) => b.action.kind === 'level' && l.id === b.action.level)?.name ?? b.action.level;
      rounded(ctx, b.x, b.y, b.w, b.h, 16);
      if (here) {
        ctx.fillStyle = c.accent;
        ctx.fill();
      } else if (lit) {
        ctx.fillStyle = c.border;
        ctx.fill();
      }
      ctx.lineWidth = lit ? 4 : 2;
      ctx.strokeStyle = here || lit ? c.accent : c.border;
      ctx.stroke();
      ctx.fillStyle = here ? c.accentFg : c.fg;
      ctx.font = '600 28px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(here ? `${name} · you are here` : name, b.x + b.w / 2, b.y + b.h / 2);
      ctx.textAlign = 'left';
    } else if (b.action.kind === 'roofs') {
      if (lit) {
        rounded(ctx, b.x - 8, b.y, b.w + 16, b.h, 14);
        ctx.fillStyle = c.border;
        ctx.fill();
      }
      ctx.fillStyle = c.fg;
      ctx.font = '500 26px Inter, system-ui, sans-serif';
      ctx.fillText('Roofs', b.x, b.y + b.h / 2);
      // A switch: the track, and the knob at its end.
      const tw = 72;
      const th = 38;
      const tx = b.x + b.w - tw;
      const ty = b.y + (b.h - th) / 2;
      rounded(ctx, tx, ty, tw, th, th / 2);
      ctx.fillStyle = m.roofs ? c.accent : c.border;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(m.roofs ? tx + tw - th / 2 : tx + th / 2, ty + th / 2, th / 2 - 5, 0, Math.PI * 2);
      ctx.fillStyle = m.roofs ? c.accentFg : c.fg;
      ctx.fill();
      ctx.fillStyle = c.muted;
      ctx.font = '500 22px Inter, system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(m.roofs ? 'On' : 'Off', tx - 14, b.y + b.h / 2);
      ctx.textAlign = 'left';
    } else {
      rounded(ctx, b.x, b.y, b.w, b.h, 16);
      if (lit) {
        ctx.fillStyle = c.border;
        ctx.fill();
      }
      ctx.fillStyle = c.danger;
      ctx.font = '600 28px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Exit VR', b.x + b.w / 2, b.y + b.h / 2);
      ctx.textAlign = 'left';
    }
  }
  ctx.fillStyle = c.muted;
  ctx.font = '500 21px Inter, system-ui, sans-serif';
  ctx.fillText(clip(ctx, m.note, width - 2 * pad), pad, H - pad - 22);
  return layout;
}

function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function clip(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}
