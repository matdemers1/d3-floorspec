/** The summary as plain, Markdown-ish text: what `describe` returns to an agent. */
import {
  describeJson,
  SIDES,
  type DescribeOptions,
  type DocumentSummary,
  type EdgeSummary,
  type ElementSummary,
  type Neighbour,
  type OpeningSummary,
  type RoomSummary,
} from './summary.js';
import { inches, lengthText } from './units.js';
import { ROOM_FUNCTIONS_TEXT } from '../vocabulary.js';

const SIDE_TITLES = { north: 'North', east: 'East', south: 'South', west: 'West' } as const;

const q = (s: string | undefined): string => (s === undefined ? '' : ` ${JSON.stringify(s)}`);

function neighbour(n: Neighbour, self?: string): string {
  switch (n.kind) {
    case 'exterior':
      return 'exterior';
    case 'room':
      return n.id === self ? `${n.id} (this room)` : `${n.id}${q(n.name)}`;
    case 'unanchored':
      return `unanchored face ${n.index}`;
    case 'degenerate':
      return 'a degenerate face (walls closer than their thickness)';
  }
}

function opening(o: OpeningSummary, self: string): string {
  let s = `${o.kind} ${o.id}${q(o.name)}${o.fill ? ` [${o.fill}]` : ''}: ${lengthText(o.width)} wide, ${lengthText(o.offset)} from the wall's start`;
  if (o.kind === 'door') {
    s += `, hinge ${o.hinge ?? 'start'}, swing ${o.swing ?? 'right'}`;
    if (o.swingsInto) s += `, opens into ${neighbour(o.swingsInto, self)}`;
  }
  if (o.kind === 'window') s += `, ${lengthText(o.height)} high${o.sill ? ` above a ${lengthText(o.sill)} sill` : ''}`;
  if (o.operation) s += `, operation ${o.operation}`;
  if (o.clearOpening) {
    const c = o.clearOpening;
    s += `, clear opening ${lengthText(c.width)} × ${lengthText(c.height)}${c.area ? `, ${c.area.squareFeet} ft² clear` : ''} (declared)`;
  }
  return s;
}

function edge(e: EdgeSummary, self: string): string[] {
  // Core 0.4, chapter 21: an arc edge's length is along its polyline; its sagitta and chord say how it bends.
  const arc = e.arc ? ` (an arc: sagitta ${lengthText(e.arc.sagitta)}, chord ${lengthText(e.arc.chord)}, length along the arc)` : '';
  if (e.kind === 'separator') return [`- separator ${e.id}${q(e.name)}, ${lengthText(e.length)}${arc}, open to ${neighbour(e.otherSide, self)}`];
  const type = e.type ? `${e.type.id}${q(e.type.name)}` : 'own layers';
  const thick = e.thickness ? ` ${inches(e.thickness.baseUnits)} (${e.thickness.baseUnits})` : '';
  return [
    `- wall ${e.id}${q(e.name)}, ${lengthText(e.length)}${arc}, ${type}${thick}; other side: ${neighbour(e.otherSide, self)}`,
    ...e.openings.map((o) => `  - ${opening(o, self)}`),
    ...(e.devices ?? []).map((d) => `  - ${d.kind} ${d.id}${q(d.name)} on this face: ${lengthText(d.offset)} from the wall's start, ${lengthText(d.height)} high${d.circuits ? `, on circuit ${d.circuits.join(' and ')}` : ''}`),
  ];
}

function room(r: RoomSummary): string[] {
  const out = [`### ${r.id}${q(r.name)} — ${r.function}`];
  if (!r.placed || !r.area || !r.size) {
    out.push(`Not placed: its anchor [${r.anchor.join(', ')}] is in no bounded face of ${r.level}.`);
    return out;
  }
  out.push(
    `Net area ${r.area.squareFeet} ft² (${r.area.squareBaseUnits} sq bu). ` +
      `Size ${r.size.eastWest.ftIn} E-W × ${r.size.northSouth.ftIn} N-S (${r.size.eastWest.baseUnits} × ${r.size.northSouth.baseUnits}). ` +
      `Anchor [${r.anchor.join(', ')}].`,
  );
  if (r.ceiling) {
    const c = r.ceiling;
    const height = c.low.baseUnits === c.high.baseUnits ? lengthText(c.low) : `${lengthText(c.low)} to ${lengthText(c.high)}`;
    out.push(`Ceiling ${c.kind}, ${height} above the floor${c.floorOffset.baseUnits === 0 ? '' : `; floor ${lengthText(c.floorOffset)} from the level`}.`);
  }
  for (const side of SIDES) {
    const edges = r.sides[side];
    out.push(`${SIDE_TITLES[side]}:${edges.length ? '' : ' (nothing)'}`);
    for (const e of edges) out.push(...edge(e, r.id));
  }
  if (r.daylight) {
    const d = r.daylight;
    out.push(
      d.windows === 0
        ? 'Daylight: no windows to the outside.'
        : `Daylight: ${d.windows} window${d.windows === 1 ? '' : 's'} to the outside (${d.facing.join(', ')}), ${d.roughOpening.squareFeet} ft² of rough opening, ${d.percentOfFloor}% of the floor area.`,
    );
  }
  if (r.inside.length) {
    out.push('Inside the room (freestanding):');
    for (const e of r.inside) out.push(...edge(e, r.id));
  }
  if (r.devices?.length) {
    out.push('On its floor and ceiling:');
    for (const d of r.devices) out.push(`- ${d.kind} ${d.id}${q(d.name)} on the ${d.surface}${d.circuits ? `, on circuit ${d.circuits.join(' and ')}` : ''}`);
  }
  if (r.furniture?.length)
    out.push(`Furniture (FS_furniture): ${r.furniture.map((f) => `${f.category} ${f.id}${q(f.name)} ${inches(f.size[0])} W × ${inches(f.size[1])} D`).join('; ')}.`);
  return out;
}

function element(e: ElementSummary): string {
  const h = e.host;
  const on =
    h === undefined
      ? 'unhosted (placed by its fallback box)'
      : h.mode === 'wallFace'
        ? `on the ${h.side} face of wall ${h.wall}, ${lengthText(h.offset)} from its start, ${lengthText(h.height)} above its base`
        : h.mode === 'surface'
          ? `on the ${h.surface} of ${h.room}`
          : 'standing free';
  const at = e.placement ? `; at [${e.placement.point.join(', ')}], facing ${e.placement.facing / 1_000_000}°` : '';
  const room = e.room === undefined ? '' : `; in ${e.room}`;
  const circuits = e.circuits === undefined ? '' : `; on circuit ${e.circuits.join(' and ')}`;
  return `- ${e.kind} ${e.id}${q(e.name)}: ${on}${at}${room}${circuits}`;
}

/** Render a summary as text. */
export function summaryText(s: DocumentSummary): string {
  const out: string[] = [`# Floorspec summary: ${s.project || '(unnamed project)'}`];
  out.push(
    `Lengths are ft-in to 1/16", with exact base units in parentheses (1/1280 mm: 1 in = 32512, 1 ft = 390144); ≈ marks an irrational length rounded to the nearest unit. ` +
      `Areas are net, inside finished wall faces. Sides follow Floorspec Ops §3.4: "north wall of LIV" names the walls listed under North. ` +
      `Wall lengths are location lines; opening positions are measured from the wall's start junction.`,
    ROOM_FUNCTIONS_TEXT,
  );
  if (s.site) {
    const f = s.site.facing;
    out.push(
      `Site: plan north faces ${f.north.compass} (${f.north.bearing}°), east ${f.east.compass} (${f.east.bearing}°), south ${f.south.compass} (${f.south.bearing}°), west ${f.west.compass} (${f.west.bearing}°) — a window on a side looks that way` +
        (s.site.latitude !== undefined && s.site.longitude !== undefined ? `; location ${s.site.latitude.toFixed(4)}°, ${s.site.longitude.toFixed(4)}°.` : '; no location.'),
    );
  }
  if (!s.valid) out.push('', 'The document is NOT valid: fix the error diagnostics below first; geometry is reported only where it can be derived.');
  if (s.options?.length) {
    out.push('', '## Design options', 'Described: the primary design; elements of other options are left out. floorspec_apply\'s `option` adds what a batch draws into one.');
    for (const set of s.options)
      out.push(
        `- set ${set.id}${q(set.name)}, primary ${set.primary}: ${set.options.map((o) => `${o.id}${q(o.name)} (${o.members} element${o.members === 1 ? '' : 's'})`).join(', ')}`,
      );
  }
  for (const l of s.levels) {
    out.push('', `## Level ${l.id}${q(l.name)} — elevation ${lengthText(l.elevation)}, height ${lengthText(l.height)}, ${l.rooms.length} room${l.rooms.length === 1 ? '' : 's'}`);
    if (!l.derived) out.push('Its walls break Core 5.1–5.3, so it has no faces: rooms, sides and adjacency are not available.');
    for (const r of l.rooms) out.push('', ...room(r));
    out.push('', `### Adjacency (${l.id})`);
    if (!l.adjacency.length) out.push('(none)');
    for (const a of l.adjacency) {
      const via = [...a.walls.map((w) => `wall ${w}`), ...a.separators.map((x) => `separator ${x}`)].join(', ');
      out.push(`- ${neighbour(a.between[0])} | ${neighbour(a.between[1])}: ${via}`);
    }
    out.push('', `### Door graph (${l.id})`);
    if (!l.doorGraph.length) out.push('(none)');
    for (const d of l.doorGraph) {
      const how = d.kind === 'separator' ? `open plan across separator ${d.via}` : `${d.kind} ${d.via} in wall ${d.wall ?? ''}`;
      out.push(`- ${neighbour(d.between[0])} <-> ${neighbour(d.between[1])}: ${how}`);
    }
    if (l.elements?.length) {
      out.push('', `### Extension elements (${l.id})`);
      for (const e of l.elements) out.push(element(e));
    }
    if (l.circuits?.length) {
      out.push('', `### Circuits (${l.id}, FS_electrical)`);
      for (const c of l.circuits)
        out.push(
          `- ${c.id}${q(c.name)} on panel ${c.panel}: ${c.breaker} A, ${c.volts} V${c.poles > 1 ? `, ${c.poles}-pole` : ''}; loads ${c.loads.length ? c.loads.join(', ') : '(none)'}; ` +
            `connected ${c.connectedLoad} W of ${c.capacity} W (stated watts only; not a load calculation)`,
        );
    }
    if (l.roofs?.length) {
      out.push('', `### Roofs (${l.id})`);
      for (const r of l.roofs)
        out.push(`- ${r.id}${q(r.name)}: ${r.kind}${r.pitch ? `, ${r.pitch}` : ''}, eave ${lengthText(r.eave)} above the level${r.surfaceDerived ? '' : '; surface not derived (FS-LINT-015)'}`);
    }
    if (l.stairs?.length) {
      out.push('', `### Stairs (${l.id})`);
      for (const s of l.stairs)
        out.push(
          `- ${s.id}${q(s.name)}: ${s.form} to ${s.to}, ${s.risers} risers × ${inches(s.riserHeight.baseUnits)} (${s.riserHeight.baseUnits}), tread ${inches(s.tread.baseUnits)}, ${lengthText(s.width)} wide` +
            (s.headroom ? `, headroom ${lengthText(s.headroom)}` : ', headroom not derived') +
            (s.walklineGoing ? `; tapered treads: least going ${lengthText(s.walklineGoing)} at the walkline, ${s.narrowGoing ? lengthText(s.narrowGoing) : '0'} at the narrow end` : '') +
            (s.minHeadroom ? `; designed for ${lengthText(s.minHeadroom)} headroom${s.openFromStep !== undefined ? `, the floor above open from step ${s.openFromStep}` : ', met with no opening'}` : ''),
        );
    }
    if (l.unanchored.length) {
      out.push('', `### Unanchored faces (${l.id})`);
      for (const u of l.unanchored) {
        out.push(
          `- face ${u.index}: ${u.area.squareFeet} ft² (${u.area.squareBaseUnits} sq bu), ${u.size.eastWest.ftIn} E-W × ${u.size.northSouth.ftIn} N-S` +
            (u.suggestedAnchor ? `; a room here could anchor at [${u.suggestedAnchor.join(', ')}]` : ''),
        );
        for (const e of u.boundary) out.push(...edge(e, '').map((x) => `  ${x}`));
      }
    }
  }
  if (s.program) {
    out.push('', '## Program');
    for (const it of s.program.items) {
      const areas = [
        it.minAreaMet !== undefined && `minimum area ${it.minAreaMet ? 'met' : 'NOT met'}`,
        it.targetAreaMet !== undefined && `target area ${it.targetAreaMet ? 'met' : 'not met'}`,
      ].filter(Boolean);
      out.push(
        `- ${it.id}${q(it.name)} — ${it.function}: ${it.rooms.length} of ${it.count} room${it.count === 1 ? '' : 's'}` +
          `${it.rooms.length ? ` (${it.rooms.join(', ')})` : ''}, count ${it.countMet ? 'met' : 'NOT met'}${areas.length ? `, ${areas.join(', ')}` : ''}`,
      );
    }
    for (const a of s.program.adjacency)
      out.push(`- ${a.kind} ${a.a} | ${a.b}: ${a.adjacent ? 'adjacent' : 'not adjacent'}${a.connected ? ', connected' : ''} — ${a.met ? 'met' : 'NOT met'}`);
  }
  if (s.circulation) {
    const c = s.circulation;
    out.push('', '## Circulation');
    for (const b of c.noEntry) out.push(`- building ${b} has doors but no way in: no room has a door, cased opening or separator to the outside`);
    if (c.unreachable.length) out.push(`- unreachable through doors: ${c.unreachable.join(', ')}`);
    if (c.throughSleeping.length) out.push(`- reachable only through another sleeping room: ${c.throughSleeping.join(', ')}`);
  }
  if (s.area?.length)
    out.push('', `Finished area after ANSI Z765-2021 (paraphrased; an app measure, not part of Floorspec): ${s.area.map((a) => `${a.building} ${a.aboveGradeSqFt} sq ft above grade, ${a.belowGradeSqFt} below`).join('; ')}.`);
  out.push('', '## Diagnostics');
  if (!s.diagnostics.length) out.push('(none)');
  for (const d of s.diagnostics) out.push(`- ${d.code} (${d.severity})${d.elements.length ? ` [${d.elements.join(', ')}]` : ''}${d.level ? ` on ${d.level}` : ''}${d.design ? ` in option ${d.design}'s design` : ''}: ${d.message}`);
  return `${out.join('\n')}\n`;
}

/** The room-centric summary of a document (FLR-T-2.7), as text an agent reads. */
export function describe(document: string | Uint8Array | object, options: DescribeOptions = {}): string {
  return summaryText(describeJson(document, options));
}
