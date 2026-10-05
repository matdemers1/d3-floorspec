# Starter templates

Three whole houses to start a project from — a **ranch**, a **two-storey** house and a **cabin** —
each a valid Floorspec Core 0.3 document (FLR-REQ-078). They are not normative: nothing in
Floorspec requires them. They double as conformance samples: each is a test of the Core 0.3 suite,
its `input.json` this file byte for byte —
[`examples/004-ranch-template`](../conformance/core/0.3/examples/004-ranch-template/),
[`005-two-storey-template`](../conformance/core/0.3/examples/005-two-storey-template/) and
[`006-cabin-template`](../conformance/core/0.3/examples/006-cabin-template/) — so the suite checks
exactly the file a project starts from, and a conformant implementation must open it.

| Template | Levels | Rooms | Net area of rooms | Roof | Diagnostics |
|---|---|---|---|---|---|
| [`ranch.floorspec.json`](ranch.floorspec.json) | 1 | 16 | 1,625 ft² + a 447 ft² garage | hip, 5 in 12 | none |
| [`two-storey.floorspec.json`](two-storey.floorspec.json) | 2 | 19 | 907 ft² + 852 ft² | gable, 8 in 12 | `FS-LINT-003` (info): the stair well |
| [`cabin.floorspec.json`](cabin.floorspec.json) | 2 | 6 | 653 ft² + a 321 ft² loft | shed, 3 in 12 | `FS-LINT-003` (info): the open-to-below |

Net areas are Core's (6.4): inside the walls, closets and halls included, wall thickness not.

## What they have in common

- **Types from the US starter library.** Every wall, door and window type, and every material
  their layers use, is the [US starter library](../library/us-starter/)'s 0.1.0 item, embedded as
  the library publishes it, under the item's ID and with its `source` (Core 8.1) — the suite's
  author script checks that each still is. Exterior walls are 2x6 with fibre-cement siding,
  justified on their exterior face, so the junctions are the outside corners of the house; partitions
  are 2x4. The garage and the floor finishes the library does not publish (oak, tile, carpet, vinyl
  plank, pine, decking, roofing) are the template's own materials.
- **A brief.** A program (Core 11) with minimum and target areas and required, preferred and
  forbidden adjacencies, and every room that answers an item names it in `brief`. Every item is
  met: no program lint.
- **Circulation that works.** Every room is reachable from an entry, no bedroom is reached through
  another (Core 14), and a stair joins the levels of the two-storey house and the cabin.
- **Floors, ceilings, slabs and roofs** (Core 15, 16): level ceiling heights and floor thicknesses,
  vaulted ceilings where the roof allows them, a stoop, porch, patio, driveway or deck as slabs, and
  a roof whose surface Core derives.
- **A few building-system devices.** Plumbing fixtures, a water heater and a stack of FS_plumbing
  0.1.0, and a panel of FS_electrical 0.1.0, each with the clearance envelope its extension asks
  for. A Core reader keeps and places them; a reader of those extensions also finds them valid,
  with nothing to report. There is no furniture: FS_furniture's items need their models and symbols
  as package assets.
- **A placeholder site.** `site.location` is the geographic centre of the contiguous United States
  and `trueNorth` is `0`, so plan north is true north and the front of every house faces south.
  Set both for your lot before you study sun or orientation.

Lengths are integers in base units (1/1280 mm); the houses were laid out on whole and half feet.

## Ranch

A single-storey ranch, 56 ft by 32 ft with a 22 ft by 22 ft garage attached at the east end, under
one hip roof of 5 in 12 with 18 in overhangs. Its L-shaped footprint gives it a valley where the
garage meets the house.

- **Great room** in the middle: a 308 ft² living room behind the front door, open through separators
  to a 159 ft² dining room with patio doors and a 232 ft² kitchen.
- **Bedroom wing** to the west, off a hall: the primary bedroom (189 ft²) with its bath (73 ft², two
  lavatories and a shower) and a walk-in closet reached through it; bedrooms 2 and 3 (120 and
  149 ft²), each with a reach-in closet; a hall bath with a tub; a linen closet.
- **Service side** to the east: a den off the living room, a laundry and mudroom between the kitchen
  and the garage, and the garage with a 16 ft overhead door, the water heater and the panel.
- Ceilings 8 ft; walls 8 ft 1-1/8 in. A front stoop, a rear patio and a driveway are slabs.
- The brief keeps the garage away from every bedroom (forbidden adjacencies) and puts the laundry
  between the kitchen and the garage.

The hall bath has no window: it is an interior room, as in most ranches, and needs an exhaust fan.

## Two-storey

A side-hall house, 36 ft by 28 ft on two floors, under a gable roof of 8 in 12 — eaves on the front
and back, gables at the ends with 6 in rakes.

- **Main floor**, 9 ft ceilings: a foyer with the stair, a 208 ft² living room through a cased
  opening, a dining room (140 ft²) open to the kitchen (165 ft²), a family room (155 ft²) open to the
  kitchen and through a wide cased opening to the living room, and by the back door a mudroom, a
  powder room and a utility closet with the water heater.
- **Stair**: L-shaped, 3 ft wide with 10 in treads, three risers up from the foyer to a landing in
  the corner and thirteen more along the west wall. Its riser count is derived from its `maxRiser`
  of 7-3/4 in: sixteen risers of 7-1/2 in for the 10 ft rise. It rises through a well drawn on the
  upper floor with railing separators; its derived headroom is 7 ft 1-1/2 in, at the landing.
- **Upper floor**, 8 ft ceilings over a 12 in floor: the primary suite across the east end — the
  bedroom (176 ft²) under a 4 in 12 cathedral ceiling whose ridge runs under the roof's ridge, rising
  to 10 ft 8 in, the walls around it carried up to meet it; a bath with two lavatories and a shower;
  a walk-in closet — and bedrooms 2 and 3 (145 and 138 ft²) with reach-in closets, a hall bath, a
  laundry and a linen closet off the upper hall.
- A front porch and a back patio are slabs.

`FS-LINT-003` is reported for the stair well: a bounded face with no room is how Core draws the
opening a stair rises through (17.6).

## Cabin

A small cabin, 28 ft by 26 ft, under a shed roof of 3 in 12 that rises from its south eave to the
north, its other three edges gables, in standing-seam metal.

- **Living room** across the south side, 346 ft² and open to the roof: its ceiling is a one-sided
  vault that follows the roof down from 15 ft 6 in at the loft's edge. Doors to the deck, a picture
  window, and clerestory windows in the loft level's south wall.
- **Under the loft**: a kitchen and dining area (122 ft²) with its own door, a bedroom (120 ft²), a
  bath with a tub, and a small hall with a tankless water heater.
- **Stair**: straight, 3 ft wide, along the east wall of the living room — fourteen risers of 7-5/7
  in for the 9 ft rise — its head landing on the loft's railing.
- **Sleeping loft** (321 ft²) over the north half, its ceiling sloping with the roof from 6 ft 10-1/2
  in at the railing to 10 ft at the north wall, which rises to the roof; its end walls rise to 7 ft.
- A cedar deck, a slab 8 in below the floor, along the south wall.

`FS-LINT-003` is reported for the open part of the loft level — the void over the living room and the
stair. The stair has nothing above it, so Core derives no headroom for it.

## Changing a template

A template is a Floorspec document: edit it as one, keep it valid, and run the suite's author script
so its test follows it:

```sh
python3.13 -m tools.oracle.author03     # rewrites examples/004-006 from these files
python3.13 -m tools.oracle templates/ranch.floorspec.json --core 0.3   # what the oracle reports and derives
```

Keep each template free of errors and of every lint but the ones explained above, and keep its
library types exactly the library's: the author script refuses one that has drifted.
