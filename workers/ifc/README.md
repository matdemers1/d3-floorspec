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
- `floorspec_ifc/server.py` — `GET /health`, `POST /export` (one export at a time)
- `floorspec_ifc/check.py` — IfcOpenShell's validator and geometry kernel, for the tests

```bash
python3.13 -m venv .venv
.venv/bin/pip install --require-hashes --only-binary=:all: -r requirements-dev.lock
.venv/bin/python -m pytest -q                     # or `pnpm test:python` from the repo root

.venv/bin/python -m floorspec_ifc serve           # 127.0.0.1:3410, for the api's inline drain
.venv/bin/python -m floorspec_ifc samples         # samples/*.ifc from tests/fixtures (gitignored)
.venv/bin/python -m floorspec_ifc check samples/l-stair-hip-roof.ifc
```

`tests/fixtures/*.payload.json` are the payloads of the sample houses, written by the Node test
`apps/worker/test/ifc.test.ts` (`UPDATE_IFC_FIXTURES=1 pnpm --filter @d3-floorspec/worker test`),
which fails when they drift from what the engine derives.

## Dependencies

Every version is pinned in `requirements.in` / `requirements-dev.in`; `python3 scripts/lock.py`
writes the `.lock` files with the sha256 of every file PyPI has for each version and refuses one
published in the last seven days (the TypeScript side's `minimumReleaseAge`). IfcOpenShell is
**0.8.5**: 0.9.0 was published on 2026-09-29, inside the wait. 0.8.5 has `py313` wheels for macOS
arm64 and x86_64, manylinux_2_31 x86_64 and aarch64, and Windows; the image is `python:3.13-slim`.
