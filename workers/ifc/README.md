# workers/ifc

The IFC worker (FLR-T-9.4, FLR-REQ-131): a Floorspec design to **IFC4 ADD2 TC1 Reference View**
through IfcOpenShell. Python 3.13, a separate process and image because IfcOpenShell is LGPL.

The Node worker (`apps/worker`, job kind `export.ifc`) evaluates and derives the document with the
engine, then POSTs `{document, derived, hash, design, file, engine}` to this worker
(`IFC_WORKER_URL`: `http://ifc-worker:3410` in production, `http://127.0.0.1:3410` elsewhere) and
stores the file it answers. The queue protocol stays in one place, the drain; this worker holds no
database connection.

- `floorspec_ifc/export.py` — the mapping, class by class from Annex A of Floorspec Core
  (`../floorspec/spec/core/annex-ifc.md`); `mapping.py` holds its enumeration tables
- `floorspec_ifc/geometry.py` — walls cut at their openings, vaults, trays, prisms; base units to mm
- `floorspec_ifc/server.py` — `GET /health`, `POST /export`, `POST /import` (one request at a time)
- `floorspec_ifc/importer/` — the round trip (FLR-T-9.5, FLR-REQ-132): an export edited in another
  tool, reconciled by `Floorspec_Identity` against the version it came from into an Ops 0.3 batch
  and a report of every edit that could not be mapped (below)
- `floorspec_ifc/check.py` — IfcOpenShell's validator and geometry kernel, for the tests

```bash
python3.13 -m venv .venv
.venv/bin/pip install --require-hashes --only-binary=:all: -r requirements-dev.lock
.venv/bin/python -m pytest -q                     # or `pnpm test:python` from the repo root

.venv/bin/python -m floorspec_ifc serve           # 127.0.0.1:3410, for the api's inline drain
.venv/bin/python -m floorspec_ifc samples         # samples/*.ifc from tests/fixtures (gitignored)
.venv/bin/python -m floorspec_ifc check samples/l-stair-hip-roof.ifc
.venv/bin/python -m floorspec_ifc reconcile tests/fixtures/three-room-house.payload.json edited.ifc
```

## The round trip (`POST /import`)

The api finds the version an uploaded file came from by its `DocumentHash`, builds that version's
payload exactly as an export does, and sends `{format: "floorspec-ifc-import", version: 1, payload,
ifc: <base64>, name}`. The worker exports the payload again in-process and reads both files with one
reader (`importer/facts.py`) — lengths scaled by each file's own unit, placements relative to the
element's storey — then compares them element by element, keyed by (Kind, ID, Part):

| In the file | Becomes |
|---|---|
| a wall's axis moved (placement or Axis) | junction moves: `moveWall` when both ends moved square to it by one vector, else `moveJunction` (`"300mm north of J4"` when the move is along an axis, `[x, y]` otherwise); walls sharing a junction follow it, and two walls that put one junction in two places are ambiguous |
| a wall's extrusions raised or lowered | `/base`, `/top` (in the form the wall already uses) |
| a layer set's thicknesses or materials | `/layers` of the wall type that owns the set, or of the wall when it has its own; the usage's offset → `/justification` |
| a wall, door or window given another of our types | `/type`, `/fill` |
| an opening's box in its wall; a door's `OverallWidth`/`Height` | `moveOpening` by the difference, `/width`, `/height`, `/sill`; a door and its opening that disagree are ambiguous |
| `Name` (and a space's name) | `/name` — a room by its name, when that is unambiguous |
| a slab's outline, top or bottom | `/boundary`, `/offset`, `/thickness`; a room's floor slab → `/floor/offset`, `/floor/thickness` |
| a stair moved or turned | `/position`, `/rotation` |
| a covering's or slab's material | `/floorFinish`, `/ceilingFinish`, `/wallFinish`, a face's `/finishes/…/material`, `/material` |
| a `Floorspec_*` property (`values.py` lists each) | the member it carries |
| an element deleted | `removeElement` — with `cascade` only when everything it would take is gone from the file too; a door taken out of its opening leaves the opening empty at its size |
| a new straight `IfcWall` with no identity | `drawWall` from its axis, thickness and heights, its ends snapped to the junction or wall they meet |

Everything else is in the report, with its GlobalId, entity, what changed and why: a body replaced by
a brep, an element split (two entities with one identity), a storey moved or turned in plan, a
derived value or property edited (a space's outline, a roof face, `Pset_WallCommon.IsExternal`), a
new element that is not a straight wall, an element carrying another document's identity. An IFC
value is unchanged when it rounds to the same integer base units; otherwise the edit is the new value
rounded once. An unedited export reconciles to an empty batch and an empty report — also after
another tool rewrites it in metres.

`tests/fixtures/*.payload.json` are the payloads of the sample houses, written by the Node test
`apps/worker/test/ifc.test.ts` (`UPDATE_IFC_FIXTURES=1 pnpm --filter @d3-floorspec/worker test`),
which fails when they drift from what the engine derives.

## Dependencies

Every version is pinned in `requirements.in` / `requirements-dev.in`; `python3 scripts/lock.py`
writes the `.lock` files with the sha256 of every file PyPI has for each version and refuses one
published in the last seven days (the TypeScript side's `minimumReleaseAge`). IfcOpenShell is
**0.8.5**: 0.9.0 was published on 2026-09-29, inside the wait. 0.8.5 has `py313` wheels for macOS
arm64 and x86_64, manylinux_2_31 x86_64 and aarch64, and Windows; the image is `python:3.13-slim`.
