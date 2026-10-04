# workers/ifc

The IFC worker: Floorspec documents to and from IFC through IfcOpenShell. Python 3.13, a separate
process and image because IfcOpenShell is LGPL. Phase 0 ships only the process and its health
check; IfcOpenShell is not installed yet.

```bash
python3.13 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/pytest
```
