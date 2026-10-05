"""IFC own-export round trip (FLR-T-9.5, FLR-REQ-132).

An IFC file that this worker exported, edited in another tool and brought back, is reconciled by
Floorspec ID against the version it was exported from: the mappable edits become an Ops 0.3 batch,
and every edit that cannot be mapped is reported with its GlobalId, its entity, what changed and why.

- ``request.py`` — the ``POST /import`` request: the original version's export payload and the file
- ``facts.py`` — one reader for both files: properties, placements, bodies, axes, layers
- ``reconcile.py`` — the comparison, element by element, into edits and a report
- ``values.py`` — base units, lengths as the reference grammar writes them, the property-set table
"""

from .reconcile import FORMAT, VERSION, ReconcileError, Result, reconcile
from .request import ImportRequest, RequestError, parse_request, read_ifc

__all__ = ["FORMAT", "VERSION", "ImportRequest", "ReconcileError", "RequestError", "Result", "parse_request", "read_ifc", "reconcile"]
