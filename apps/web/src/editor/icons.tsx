import type { ReactNode, SVGProps } from 'react';

/**
 * The Floorspec icons the editor uses, from the board's Components page (`Icon/fs/*`), drawn on
 * lucide's 16-unit grid at its stroke so they sit beside lucide icons. They take `currentColor`,
 * so the theme colours them.
 */

function icon(name: string, paths: ReactNode) {
  const Icon = (props: SVGProps<SVGSVGElement>) => (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {paths}
    </svg>
  );
  Icon.displayName = `FsIcon(${name})`;
  return Icon;
}

export const SelectIcon = icon('select', <path d="M3.333 2 7.333 13.333 8.667 8.667 13.333 7.333 3.333 2Z" />);
export const WallIcon = icon('wall', <path d="M2 6h12M2 10h12M2 6v4M14 6v4" />);
export const DoorIcon = icon('door', <path d="M3.333 13.333V2.667M3.333 2.667a10 10 0 0 1 10 10M2 13.333h12" />);
export const WindowIcon = icon('window', <path d="M2.667 3.333h10.666v9.334H2.667zM8 3.333v9.334M2.667 8h10.666" />);
export const RoomAnchorIcon = icon('room-anchor', <path d="M8 2.667 13.333 8 8 13.333 2.667 8 8 2.667ZM8 7v2M7 8h2" />);
export const SeparatorIcon = icon('separator', <path d="M2 8h2M6 8h2M10 8h2" />);
export const ArcWallIcon = icon('arc-wall', <path d="M2 12.667a6 6 0 0 1 12 0M4.667 12.667a3.333 3.333 0 0 1 6.666 0" />);
export const SlabIcon = icon('slab', <path d="M2 10.667 6 6.667h8L10 10.667H2ZM2 10.667v2h8v-2M10 12.667l4-4v-2" />);
export const StairIcon = icon('stair', <path d="M2 13.333h3.333v-2.666H8V8h2.667V5.333H14" />);
export const RoofIcon = icon('roof', <path d="M1.333 8 8 2.667 14.667 8M3.333 6.667v6.666h9.334V6.667" />);
export const PlugIcon = icon(
  'plug',
  <path d="M6 1.333v3.334M10 1.333v3.334M4 4.667h8v2.666a4 4 0 0 1-8 0V4.667ZM8 11.333v3.334" />,
);
export const DropIcon = icon('drop', <path d="M8 2c2 2.667 4 5 4 7.333a4 4 0 0 1-8 0C4 7 6 4.667 8 2Z" />);
export const AirIcon = icon(
  'air',
  <path d="M2 5.333h7.333a2 2 0 1 0-2-2M2 10.667h9.333a2 2 0 1 1-2 2M2 8h11.333" />,
);
export const SofaIcon = icon(
  'furniture',
  <path d="M3.333 7.333v-2a1.333 1.333 0 0 1 1.334-1.333h6.666a1.333 1.333 0 0 1 1.334 1.333v2M2 7.333h12v4H2zM3.333 11.333v1.334M12.667 11.333v1.334" />,
);
export const MeasureIcon = icon('measure', <path d="M2 11.333 11.333 2 14 4.667 4.667 14 2 11.333ZM4.667 8.667 6 10M6.667 6.667 8 8M8.667 4.667 10 6" />);
export const RoomIcon = icon('room', <path d="M2.667 2.667h10.666v10.666H2.667zM8 6.667 9.333 8 8 9.333 6.667 8 8 6.667Z" />);
export const EyeIcon = icon(
  'eye',
  <>
    <path d="M1.333 8S4 3.333 8 3.333 14.667 8 14.667 8 12 12.667 8 12.667 1.333 8 1.333 8Z" />
    <circle cx="8" cy="8" r="2" />
  </>,
);
export const SparklesIcon = icon(
  'sparkles',
  <path d="M7.333 2 8.533 5.467 12 6.667 8.533 7.867 7.333 11.333 6.133 7.867 2.667 6.667 6.133 5.467 7.333 2ZM12.667 2v2.667M11.333 3.333H14M12.667 10.667v2.666M11.333 12h2.667" />,
);
export const PencilIcon = icon('pencil', <path d="M11.333 2a1.886 1.886 0 0 1 2.667 2.667L5 13.667 1.333 14.667 2.333 11 11.333 2Z" />);
export const JunctionIcon = icon('junction', <path d="M8 2v4M8 10v4M2 8h4M10 8h4" />);
export const DataIcon = icon('data', <path d="M8 2.667 13.333 12.667H2.667L8 2.667ZM8 7.333v2.667" />);
