# Renovation plans

FLR-T-18.13 and FLR-ADR-048: a remodel is one document, FS_renovation 0.1.0 (Draft), in which every
wall, separator, opening, room, slab, roof, stair and extension element is **existing** (the
default), to be **demolished**, or **new**. The house as it stands and the house when the work is
done are two **states** of it, and every drawing of the remodel is one of four **filters**.

## Statuses

- A core element's status is its own `extensions.FS_renovation.status`; an extension element's
  (furniture, a fixture, a receptacle) is `extensions.FS_renovation.elements[<ID>]`, since an
  extension element has no `extensions` of its own. No status means existing.
- **Start a remodel** (the Renovation menu) declares `FS_renovation` — the house as drawn is what
  stands today.
- The inspector's **Renovation** field marks one element; the multi-select inspector marks many in
  one batch. A wall takes its doors, windows and what hangs on it (FS_renovation 6.1.1).
- What is drawn in the **Proposed** or **Combined** plan is marked new as it is drawn (6.1.3); what
  is drawn in the **Existing** or **Demolition** plan is the house as it stands.
- Agents mark elements with `setProperty`: `{"op":"setProperty","id":"W8","path":"/extensions/FS_renovation/status","value":"demolish"}`, or of `$document` at `/extensions/FS_renovation/elements/X12`.

The engine checks that no element in a state refers to one outside it (an existing door in a wall
to be demolished, FS-RENO-INV-002) and that each state is a valid house (two rooms in one face of
the proposed kitchen, FS-RENO-INV-004): mark the room that goes with its wall.

## Filters

| Filter | State drawn | Existing | To demolish | New |
|---|---|---|---|---|
| Existing | as it stands | plain | plain | hidden |
| Demolition | as it stands | grey | dashed red, no poché | hidden |
| Proposed | when done | grey | hidden | solid poché |
| Combined | everything | grey | dashed red | solid poché |

One table (`@floorspec/engine`'s `filterStyle`) drives the editor's canvas (a Renovation menu beside
the plan style, kept per project), render2d's SVG (`renovation` option), the 3D view (the state;
what goes ghosted in red), the PDF (existing work screened under new work, what goes dashed over
both, a legend, `Main floor demolition plan`), the DXF (status layers `A-WALL-DEMO`,
`A-WALL-NEWW`, `A-DOOR-DEMO`, `I-FURN-DEMO`, `A-FLOR-DEMO`), `GET /render?renovation=` and
`floorspec_render`'s `renovation`. A state is drawn as FS_renovation 2.4 checks it: Core's
invariants, without known extensions.

## Reports

The Schedules screen adds **Remodel areas** — each room's net area as it stands and when the work
is done, the change, and the house's total — and **Remodel quantities** — walls, wall length, doors
and windows, rooms, separators, slabs and their area, roofs, stairs and items, by status — both from
FS_renovation's derived values (5.3, 5.4).

## The demo

`apps/worker/test/fixtures/courtyard-remodel.json`, written by
`apps/worker/test/fixtures/make/courtyard-remodel.mjs`: the Courtyard House's kitchen opened into its
pantry — the pantry's walls, pocket door, room, outlets and light, the east run of cabinets, the
refrigerator and the island demolished; a new feature wall, a window, an island and cooktop, and a
run of cabinets and a refrigerator where the pantry was. The `renovation` e2e suite shows it in all
four plans and in 3D.
