/* eslint-disable @typescript-eslint/no-non-null-assertion -- a test asserts on values it has just looked up. */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_COLOURS, flatShaded, loadMesher, ROLE_LOOKS, ROOM_PALETTE, type HouseMesh, type MeshPart } from '@floorspec/mesh';
import { readModel, type EditorModel } from '../src/editor/model';
import { basisOf, eyeOf, fitOrbit, orbitBy, panBy, presetOf, PRESETS, zoomBy, type Orbit } from '../src/editor/three/camera';
import { describeScene, elementOfPart, faceColours, isVisible, levelOrder, linear, lookOf, partSelected, partsOfElement } from '../src/editor/three/parts';
import { isSurfacePart, surfaceBuffers } from '../src/editor/three/surfaces';
import { blocked, buildWorld, entryOf, groundAt, look, NO_INPUT, placeAt, roomAt, standAt, stepWalker, WALK, type Walker, type WalkInput, type World } from '../src/editor/three/walk';

/**
 * FLR-T-7.5: the 3D view's arithmetic without a browser — the orbit camera, which element a part
 * selects and what shows, and the walkthrough's physics over a real house meshed by
 * @floorspec/mesh: eye height above the floor, walls and doors, and an L stair climbed by walking.
 *
 * The house is the e2e suite's fixture: two levels, a front door into the kitchen, an L stair in
 * the living room rising to a loft, under a 6:12 hip roof.
 */

const HOUSE = readFileSync(new URL('../e2e/fixtures/l-stair-hip-roof.json', import.meta.url), 'utf8');
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

let model: EditorModel;
let mesh: HouseMesh;
let world: World;

beforeAll(async () => {
  model = readModel('fixture', HOUSE);
  expect(model.valid).toBe(true);
  const mesher = await loadMesher();
  mesh = mesher.meshDerived(model.document, model.derived!);
  world = buildWorld(model, mesh);
});

describe('the orbit camera', () => {
  const o: Orbit = { target: [1, 2, 3], azimuth: PRESETS.sw.azimuth, elevation: PRESETS.sw.elevation, distance: 10 };

  it('stands at its distance from the target, south-west and above for the SW iso', () => {
    const [x, y, z] = eyeOf(o);
    expect(Math.hypot(x - 1, y - 2, z - 3)).toBeCloseTo(10, 9);
    expect(x).toBeLessThan(1);
    expect(y).toBeLessThan(2);
    expect(z).toBeGreaterThan(3);
    // An isometric view: the three axes foreshortened alike.
    expect(Math.abs(x - 1)).toBeCloseTo(Math.abs(y - 2), 9);
    expect(Math.abs(z - 3)).toBeCloseTo(Math.abs(x - 1), 9);
    expect(presetOf(o)).toBe('sw');
  });

  it('frames a box so its bounding sphere fits the narrower field of view', () => {
    const box = { min: [-5, -4, 0] as [number, number, number], max: [5, 4, 6] as [number, number, number] };
    const f = fitOrbit(box, 'ne', 45, 16 / 9);
    expect(f.target).toEqual([0, 0, 3]);
    const r = Math.hypot(10, 8, 6) / 2;
    expect(f.distance * Math.sin((22.5 * Math.PI) / 180)).toBeGreaterThanOrEqual(r);
    expect(presetOf(f)).toBe('ne');
    // A tall, narrow viewport frames from further away.
    expect(fitOrbit(box, 'ne', 45, 0.5).distance).toBeGreaterThan(f.distance);
  });

  it('orbits round, stops short of the zenith and of looking far up from below, and zooms within limits', () => {
    const turned = orbitBy(o, Math.PI * 2, 0);
    expect(close(Math.cos(turned.azimuth), Math.cos(o.azimuth))).toBe(true);
    expect(orbitBy(o, 0, 10).elevation).toBeLessThan(Math.PI / 2);
    expect(orbitBy(o, 0, -10).elevation).toBeGreaterThan(-Math.PI / 4);
    expect(zoomBy(o, 1e-6).distance).toBeGreaterThan(0);
    expect(zoomBy(o, 1e6).distance).toBeLessThanOrEqual(800);
    expect(presetOf(orbitBy(o, 0.1, 0))).toBeNull();
  });

  it('pans the target across the screen, never along the line of sight', () => {
    const moved = panBy(o, 100, 0, 800, 45);
    const d: [number, number, number] = [moved.target[0] - o.target[0], moved.target[1] - o.target[1], moved.target[2] - o.target[2]];
    const { forward, right } = basisOf(o);
    expect(d[0] * forward[0] + d[1] * forward[1] + d[2] * forward[2]).toBeCloseTo(0, 9);
    // Dragging right moves the scene right: the target goes left.
    expect(d[0] * right[0] + d[1] * right[1] + d[2] * right[2]).toBeLessThan(0);
    // From the south-west, the screen's right is south-east and its up leans north-east.
    expect(right[0]).toBeGreaterThan(0);
    expect(right[1]).toBeLessThan(0);
    const { up } = basisOf(o);
    expect(up[2]).toBeGreaterThan(0);
    expect(up[0]).toBeGreaterThan(0);
    expect(up[1]).toBeGreaterThan(0);
  });
});

describe('parts in the 3D view', () => {
  it('select their element: a stair from each flight and landing, an opening from its cut and its joinery, a room from its floor', () => {
    const stair = mesh.parts.filter((p) => p.id === 'ST1');
    expect(new Set(stair.map((p) => p.kind))).toEqual(new Set(['stairFlight', 'stairLanding']));
    expect(stair.length).toBeGreaterThan(1);
    for (const p of stair) expect(elementOfPart(p)).toBe('ST1');
    expect(partsOfElement(mesh.parts, 'ST1')).toHaveLength(stair.length);
    // An opening's cut is a pick target; what fills it is its joinery (FLR-T-13.8) — a window's glass
    // drawn as glass, its frame and casings and a door's slab solid — and selects the opening too.
    const window = mesh.parts.find((p) => p.kind === 'opening' && p.opening?.category === 'window')!;
    expect(lookOf(window)).toBe('pick');
    expect(elementOfPart(window)).toBe(window.id);
    expect(model.document.openings?.[window.id]).toBeDefined();
    const pane = mesh.parts.find((p) => p.kind === 'joinery' && p.id === window.id && p.model?.role === 'glass')!;
    expect(lookOf(pane)).toBe('glass');
    expect(elementOfPart(pane)).toBe(window.id);
    expect(lookOf(mesh.parts.find((p) => p.kind === 'joinery' && p.id === window.id && p.model?.role === 'frame')!)).toBe('solid');
    const door = mesh.parts.find((p) => p.id === 'FRONT')!;
    expect(lookOf(door)).toBe('pick');
    expect(partsOfElement(mesh.parts, 'FRONT').some((p) => p.kind === 'joinery' && p.model?.role === 'door')).toBe(true);
    expect(new Set(partsOfElement(mesh.parts, 'KIT').map((p) => p.kind))).toEqual(new Set(['floor', 'ceiling']));
    expect(lookOf(mesh.parts.find((p) => p.kind === 'ceiling')!)).toBe('ceiling');
    expect(lookOf(mesh.parts.find((p) => p.kind === 'wall')!)).toBe('solid');
    expect(lookOf(mesh.parts.find((p) => p.kind === 'floor')!)).toBe('floor');
    expect(partsOfElement(mesh.parts, null)).toEqual([]);
  });

  it('show an appliance described twice once, and select it for either element (FLR-T-12.34)', async () => {
    // The Courtyard House's kitchen and mudroom: a washer, a dishwasher and a cooktop, each with the
    // plumbing fixture or gas appliance that serves it in its own box.
    const courtyard = readModel('courtyard', readFileSync(new URL('../../../packages/mesh/test/fixtures/courtyard-kitchen-mudroom.floorspec.json', import.meta.url), 'utf8'));
    expect(courtyard.valid).toBe(true);
    const m = (await loadMesher()).meshDerived(courtyard.view, courtyard.derived!);
    const listed = new Set(courtyard.levels.flatMap((l) => l.devices.map((d) => d.id)));
    for (const [service, appliance] of [['KIT-DW-P', 'KIT-DW'], ['MUD-WASH-P', 'MUD-WASHER'], ['KIT-COOKTOP-G', 'KIT-COOKTOP']] as const) {
      // Still in the model — in the plan, in the lists, selectable — but drawn in 3D as its appliance.
      expect(listed.has(service), service).toBe(true);
      expect(m.parts.some((p) => p.id === service), service).toBe(false);
      const parts = partsOfElement(m.parts, service);
      expect(parts.length, service).toBeGreaterThan(0);
      expect(new Set(parts.map((p) => p.id)), service).toEqual(new Set([appliance]));
      expect(partsOfElement(m.parts, appliance)).toEqual(parts);
      // A click on the appliance selects the appliance.
      for (const p of parts) expect(elementOfPart(p)).toBe(appliance);
    }
    expect(partSelected(m.parts.find((p) => p.id === 'KIT-DW')!, 'KIT-SINK')).toBe(false);
    expect(partSelected(m.parts.find((p) => p.id === 'KIT-DW')!, null)).toBe(false);
  });

  it('shows the doors closed in the orbit views and open in the walkthrough, as the editor meshes them (FLR-T-13.8)', async () => {
    const both = (await loadMesher()).meshDerived(model.document, model.derived!, { doors: 'both' });
    const order = levelOrder(model);
    const shown = (walking: boolean) => both.parts.filter((p) => isVisible(p, { walking, cutaway: false, roof: true, level: 'L1', order }));
    const moving = both.parts.filter((p) => p.state !== undefined);
    expect(new Set(moving.map((p) => p.state))).toEqual(new Set(['closed', 'open']));
    expect(shown(false).filter((p) => p.state !== undefined).every((p) => p.state === 'closed')).toBe(true);
    expect(shown(true).filter((p) => p.state !== undefined).every((p) => p.state === 'open')).toBe(true);
    expect(shown(true).filter((p) => p.state === 'open')).toHaveLength(moving.filter((p) => p.state === 'open').length);
    // What does not move shows either way; the doorway stays walkable, the walls' cuts being what stops a person.
    const fixed = both.parts.filter((p) => p.kind === 'joinery' && p.state === undefined);
    for (const w of [false, true]) expect(shown(w).filter((p) => p.kind === 'joinery' && p.state === undefined)).toHaveLength(fixed.length);
  });

  it('cut away: up to the current level, without its ceilings or the roof it carries; walking shows everything', () => {
    const order = levelOrder(model);
    const at = (level: string, cutaway = true, roof = true, walking = false) => mesh.parts.filter((p) => isVisible(p, { walking, cutaway, roof, level, order }));
    const l1 = at('L1');
    expect(l1.every((p) => p.level === 'L1')).toBe(true);
    expect(l1.some((p) => p.kind === 'ceiling')).toBe(false);
    expect(l1.some((p) => p.kind === 'stairFlight')).toBe(true);
    const l2 = at('L2');
    expect(l2.some((p) => p.level === 'L1' && p.kind === 'ceiling')).toBe(true);
    expect(l2.some((p) => p.level === 'L2' && p.kind === 'ceiling')).toBe(false);
    expect(l2.some((p) => p.kind === 'roof')).toBe(false);
    expect(at('L1', false).some((p) => p.kind === 'roof')).toBe(true);
    expect(at('L1', false, false).some((p) => p.kind === 'roof')).toBe(false);
    // Walking shows everything but a door drawn closed (FLR-T-13.8): the doors open, or — in a mesh of
    // closed doors alone — not at all, so a person walks through every doorway.
    const shut = mesh.parts.filter((p) => p.state === 'closed');
    expect(shut.length).toBeGreaterThan(0);
    expect(at('L1', true, false, true)).toHaveLength(mesh.parts.length - shut.length);
    expect(at('L1', false).filter((p) => p.state === 'closed')).toHaveLength(shut.length);
    expect(describeScene(model, l1)).toBe('Level 1: 7 walls, 2 doors, 4 windows, 2 rooms, 1 stair, no roof showing.');
  });

  it('colours a wall’s faces from its layers: the left (exterior) face, the right face, and the core between', () => {
    const wall = mesh.parts.find((p) => p.kind === 'wall' && p.id === 'GAB')!;
    const { normals } = flatShaded(wall.mesh);
    const walls = new Map(model.levels.flatMap((l) => l.walls.map((w) => [w.id, w] as const)));
    const colours = faceColours(model, wall, normals, walls);
    const [siding, paint, stud] = [linear('#d9d2c3'), linear('#eeebe4'), linear('#e2cfa2')];
    const seen = new Set<string>();
    // GAB runs north along x = 0: its left face looks west (−x), outside the house.
    for (let i = 0; i < normals.length; i += 3) {
      const c = [colours[i]!, colours[i + 1]!, colours[i + 2]!];
      const want = normals[i]! < -0.7 ? siding : normals[i]! > 0.7 ? paint : stud;
      expect(c.map((v) => v.toFixed(6))).toEqual(want.map((v) => v.toFixed(6)));
      seen.add(c.join());
    }
    expect(seen.size).toBe(3);
    const floor = mesh.parts.find((p) => p.kind === 'floor' && p.id === 'KIT') as MeshPart;
    const tile = faceColours(model, floor, flatShaded(floor.mesh).normals, walls);
    expect([...tile.slice(0, 3)].map((v) => v.toFixed(6))).toEqual(linear('#cfd3da').map((v) => v.toFixed(6)));
  });

  it('draws a fixture model’s pieces in their roles’ colours: glass see-through, a lens lit (FLR-T-12.21)', async () => {
    const showcase = readModel('showcase', readFileSync(new URL('../../../packages/mesh/test/fixtures/showcase.floorspec.json', import.meta.url), 'utf8'));
    expect(showcase.valid).toBe(true);
    const m = (await loadMesher()).meshDerived(showcase.document, showcase.derived!);
    const walls = new Map(showcase.levels.flatMap((l) => l.walls.map((w) => [w.id, w] as const)));
    const looks = new Map<string, Set<string>>();
    for (const p of m.parts.filter((q) => q.model !== undefined)) {
      const role = p.model!.role;
      looks.set(role, new Set([...(looks.get(role) ?? []), lookOf(p)]));
      const c = faceColours(showcase, p, flatShaded(p.mesh).normals, walls);
      expect([...c.slice(0, 3)].map((v) => v.toFixed(5)), p.key).toEqual(linear(ROLE_LOOKS[role].color).map((v) => v.toFixed(5)));
    }
    expect(looks.get('glass')).toEqual(new Set(['glass']));
    expect(looks.get('lens')).toEqual(new Set(['lens']));
    expect(looks.get('porcelain')).toEqual(new Set(['solid']));
    // A toilet selects as one element, whichever of its pieces is clicked.
    expect(new Set(partsOfElement(m.parts, 'S2').map((p) => elementOfPart(p)))).toEqual(new Set(['S2']));
    expect(partsOfElement(m.parts, 'S2').length).toBeGreaterThan(4);
  });
});

describe('doorways and corners in 3D (FLR-T-12.20)', () => {
  const hex = (c: ArrayLike<number>): string => Array.from(c, (v) => v.toFixed(6)).join();
  const colours = (part: MeshPart): Set<string> => {
    const b = surfaceBuffers(model, mesh, part);
    const out = new Set<string>();
    for (let i = 0; i < b.colors.length; i += 3) out.add(hex(b.colors.slice(i, i + 3)));
    return out;
  };

  it('floor the front door with thresholds that select it and are drawn as the kitchen floor they continue', () => {
    const ths = mesh.parts.filter((p) => p.kind === 'threshold' && p.id === 'FRONT');
    expect(ths.map((p) => p.key)).toEqual(['threshold:FRONT:left', 'threshold:FRONT:right']);
    for (const t of ths) {
      expect(lookOf(t)).toBe('floor');
      expect(isSurfacePart(t)).toBe(true);
      expect(elementOfPart(t)).toBe('FRONT');
      expect(t.threshold!.room).toBe('KIT');
      // The kitchen's tile, outside half too: the doorway has one sill.
      expect(colours(t)).toEqual(new Set([hex(linear('#cfd3da'))]));
    }
  });

  it('draw a junction fill’s faces as its walls’ faces and its top as their core', () => {
    const fills = mesh.parts.filter((p) => p.kind === 'junctionFill');
    expect(fills.length).toBeGreaterThan(0);
    const stud = hex(linear('#e2cfa2'));
    const allowed = new Set([stud, hex(linear('#d9d2c3')), hex(linear('#eeebe4'))]);
    for (const f of fills) {
      expect(isSurfacePart(f)).toBe(true);
      const b = surfaceBuffers(model, mesh, f);
      for (let i = 0; i < b.colors.length; i += 3) {
        const c = hex(b.colors.slice(i, i + 3));
        // Every face is a wall's finish or its core, never the old flat fill colour.
        expect(allowed.has(c), `${f.key}: ${c}`).toBe(true);
        if (b.normals[i + 2]! > 0.9) expect(c, `${f.key}: its top`).toBe(stud);
      }
    }
  });
});

describe('the palette where the model names no material (FLR-T-12.23)', () => {
  // A one-storey house with two bays — arc walls (Core 21) — and no materials at all.
  const BAY = readFileSync(new URL('../e2e/fixtures/bay-house.json', import.meta.url), 'utf8');
  const hex = (c: ArrayLike<number>): string => Array.from(c, (v) => v.toFixed(6)).join();

  it('draws each room’s floor by its function, and an arc wall’s faces as faces — its room’s paint, the exterior outside — round the curve', async () => {
    const bay = readModel('bay', BAY);
    expect(bay.valid).toBe(true);
    const m = (await loadMesher()).meshDerived(bay.view, bay.derived!);
    const floorColour = (room: string) => hex(surfaceBuffers(bay, m, m.parts.find((p) => p.kind === 'floor' && p.id === room)!).colors.slice(0, 3));
    expect(floorColour('LIV')).toBe(hex(linear(ROOM_PALETTE.living.floor)));
    expect(floorColour('KIT')).toBe(hex(linear(ROOM_PALETTE.kitchen.floor)));
    const arcs = m.parts.filter((p) => p.kind === 'wall' && (bay.derived!.walls[p.id]!.polyline?.length ?? 0) > 2);
    expect(arcs.length).toBe(2);
    const faces = new Set([DEFAULT_COLOURS.exterior, ROOM_PALETTE.living.wall, ROOM_PALETTE.kitchen.wall].map((c) => hex(linear(c))));
    for (const wall of arcs) {
      const b = surfaceBuffers(bay, m, wall);
      let face = 0;
      let side = 0;
      for (let i = 0; i < b.colors.length; i += 9) {
        // Its faces stand upright; its top and bottom do not.
        if (Math.abs(b.normals[i + 2]!) > 0.5) continue;
        if (faces.has(hex(b.colors.slice(i, i + 3)))) face++;
        else side++;
      }
      // Only its ends and its openings' reveals are its core: never a face's segment.
      expect(face, wall.id).toBeGreaterThan(4 * side);
    }
  });
});

describe('upper floors drawn down to the ceiling below (FLR-T-12.32)', () => {
  const hex = (c: ArrayLike<number>): string => Array.from(c, (v) => v.toFixed(6)).join();
  /** A colour as the buffers hold it: Float32. */
  const f32 = (c: string): string => hex(Float32Array.from(linear(c)));

  it('draws a loft’s floor with no thickness as its floor on top, the ceiling below under it and the structure’s band round it', async () => {
    // The fixture's loft, its level's floor thickness taken away.
    const json = JSON.parse(HOUSE) as { levels: Record<string, Record<string, unknown>> };
    delete json.levels['L2']!['floorThickness'];
    const loft = readModel('loft', JSON.stringify(json));
    expect(loft.valid).toBe(true);
    const m = (await loadMesher()).meshDerived(loft.view, loft.derived!);
    const floor = m.parts.find((p) => p.kind === 'floor' && p.id === 'LOFT')!;
    expect(floor.closed).toBe(true);
    expect(floor.plenum?.room).toBeDefined();
    const under = floor.plenum!.room!;
    const want = {
      // The loft's own finish: the fixture's white oak.
      top: f32('#b98d5f'),
      under: f32(ROOM_PALETTE[under === 'KIT' ? 'kitchen' : 'living'].ceiling),
      edge: f32(DEFAULT_COLOURS.floorEdge),
    };
    const check = (colors: Float32Array, normals: Float32Array, label: string) => {
      const seen = new Set<string>();
      for (let i = 0; i < colors.length; i += 3) {
        const c = hex(colors.slice(i, i + 3));
        const nz = normals[i + 2]!;
        expect(c, `${label}: ${nz > 0.98 ? 'top' : nz < -0.98 ? 'underside' : 'edge'}`).toBe(nz > 0.98 ? want.top : nz < -0.98 ? want.under : want.edge);
        seen.add(c);
      }
      expect(seen.size, label).toBe(3);
    };
    // By finished surface, and — with no derived values to lay it out by — face by face.
    const b = surfaceBuffers(loft, m, floor);
    check(b.colors, b.normals, 'surfaces');
    const flat = flatShaded(floor.mesh);
    check(faceColours(loft, floor, flat.normals, new Map()), flat.normals, 'faces');
    // Drawn as a floor: in front of what shares its plane, as before.
    expect(lookOf(floor)).toBe('floor');
  });
});

describe('the walkthrough', () => {
  const run = (w: Walker, input: WalkInput, until: (w: Walker) => boolean, limit = 30): Walker => {
    let t = 0;
    let now = w;
    while (!until(now) && t < limit) {
      now = stepWalker(world, now, input, 1 / 60);
      t += 1 / 60;
    }
    expect(until(now), `stopped at ${JSON.stringify(now)}`).toBe(true);
    return now;
  };
  const forward: WalkInput = { ...NO_INPUT, forward: 1 };

  it('starts inside the entry door, on the kitchen floor, facing in, at eye height', () => {
    const w = entryOf(world, model, mesh, null)!;
    expect(roomAt(world, w.x, w.y, w.feet)?.id).toBe('KIT');
    expect(w.feet).toBe(0);
    // The front door is in the south wall: inside is north.
    expect(Math.sin(w.yaw)).toBeCloseTo(1, 9);
    expect(blocked(world, w.x, w.y, w.feet)).toBeNull();
    const eye = w.feet + WALK.eye;
    expect(eye - groundAt(world, w.x, w.y, w.feet).z).toBeCloseTo(1.6, 9);
  });

  it('is stopped by a wall and slides along it, but walks through a door', () => {
    // Facing west towards the partition at x = 4.2, away from its door.
    const start = standAt(world, 5.0, 1.5, Math.PI, 0);
    let w = start;
    for (let i = 0; i < 120; i++) w = stepWalker(world, w, forward, 1 / 60);
    expect(w.x).toBeGreaterThan(4.2 + 0.05 + WALK.radius - 0.01);
    expect(blocked(world, w.x, w.y, w.feet)).toBeNull();
    // Through the kitchen door (y 3.6–4.4 on the partition): from the kitchen into the living room.
    const atDoor = standAt(world, 5.0, 4.0, Math.PI, 0);
    const through = run(atDoor, forward, (n) => n.x < 3.6, 4);
    expect(roomAt(world, through.x, through.y, through.feet)?.id).toBe('LIV');
    // A window lets nobody through: its sill is above a step.
    const atWindow = standAt(world, 6.6, 1.95, 0, 0);
    let out = atWindow;
    for (let i = 0; i < 120; i++) out = stepWalker(world, out, forward, 1 / 60);
    expect(out.x).toBeLessThan(7.2 - 0.1 - WALK.radius + 0.01);
  });

  it('climbs the L stair by walking: each tread at its top, the landing, then the loft floor', () => {
    // At the foot, facing east up the first flight.
    let w = standAt(world, 0.6, 0.6, 0, 0);
    expect(w.feet).toBe(0);
    const tops: number[] = [];
    w = run(w, forward, (n) => {
      if (tops[tops.length - 1] !== n.feet) tops.push(n.feet);
      return n.x >= 2.95;
    });
    const landing = model.derived!.stairs!['ST1']!.steps!.find((s) => s.landing === true)!;
    expect(w.feet).toBeCloseTo(landing.top / 1_280_000, 9);
    // Standing on the stair, not in a room: the place underfoot is the stair.
    expect(placeAt(world, w.x, w.y, w.feet)).toMatchObject({ id: 'ST1', kind: 'step', level: 'L1' });
    expect(roomAt(world, w.x, w.y, w.feet)).toBeNull();
    // Every height stood at on the way was a tread's top: up one riser at a time.
    const treads = new Set(model.derived!.stairs!['ST1']!.steps!.map((s) => (s.top / 1_280_000).toFixed(9)));
    for (const t of tops.slice(1)) expect(treads.has(t.toFixed(9))).toBe(true);
    expect(tops.length).toBe(8);
    // Turn left, as the stair does, and walk up the second flight onto the loft floor.
    w = look(w, Math.PI / 2, 0);
    w = run(w, forward, (n) => n.y > 3.0);
    expect(w.feet).toBeCloseTo(2.7, 9);
    expect(roomAt(world, w.x, w.y, w.feet)?.id).toBe('LOFT');
    expect(w.feet + WALK.eye - groundAt(world, w.x, w.y, w.feet).z).toBeCloseTo(1.6, 9);
    // And back down: the treads followed, not fallen from.
    w = look(w, Math.PI, 0);
    let lowest = w.feet;
    let falling = false;
    w = run(w, forward, (n) => {
      lowest = Math.min(lowest, n.feet);
      if (n.vz < -2) falling = true;
      return n.y < 0.9;
    });
    expect(falling).toBe(false);
    expect(w.feet).toBeCloseTo(landing.top / 1_280_000, 9);
  });

  it('falls onto the floor below from a height, and lands', () => {
    const w: Walker = { ...standAt(world, 2.0, 4.0, 0, 0), feet: 1.0 };
    const landed = run(w, NO_INPUT, (n) => n.vz === 0 && n.feet === 0, 3);
    expect(landed.feet).toBe(0);
  });

  it('stands on the level asked for, not the floor overhead', () => {
    expect(standAt(world, 6.0, 2.7, 0, 0).feet).toBe(0);
    expect(standAt(world, 6.0, 2.7, 0, 2.7).feet).toBeCloseTo(2.7, 9);
    expect(roomAt(world, 6.0, 2.7, 2.7)?.id).toBe('BED');
  });
});
