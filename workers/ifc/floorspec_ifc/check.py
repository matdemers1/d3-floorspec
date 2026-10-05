"""Checking an export: IfcOpenShell's schema validator, and the geometry it computes.

The server validates every file against the IFC4 schema before answering (attribute types,
cardinalities, enumerations, inverses). The tests also run the schema's WHERE rules
(``express_rules=True``), which need pytest's assertion rewriter and so are not run in the image.
"""

from __future__ import annotations

from typing import Any

import ifcopenshell
import ifcopenshell.validate


def problems(f: ifcopenshell.file, express_rules: bool = False) -> list[dict[str, Any]]:
    """Every error the validator reports, as dicts; empty for a valid file."""
    log = ifcopenshell.validate.json_logger()
    ifcopenshell.validate.validate(f, log, express_rules=express_rules)
    return [dict(s) for s in log.statements if str(s.get("level", "ERROR")).upper() == "ERROR"]


def boxes(f: ifcopenshell.file) -> dict[str, tuple[tuple[float, float, float], tuple[float, float, float]]]:
    """Each product's world bounding box from IfcOpenShell's geometry kernel, in the file's units.

    The kernel subtracts an IfcOpeningElement from the element it voids; a Reference View wall
    is already cut, so subtracting it again changes nothing.
    """
    import ifcopenshell.geom
    import numpy as np

    s = ifcopenshell.geom.settings()
    s.set("use-world-coords", True)
    s.set("convert-back-units", True)
    out: dict[str, tuple[tuple[float, float, float], tuple[float, float, float]]] = {}
    it = ifcopenshell.geom.iterator(s, f, 1)
    if it.initialize():
        while True:
            shape = it.get()
            v = np.array(shape.geometry.verts).reshape(-1, 3)
            if len(v):
                e = f.by_id(shape.id)
                out[e.GlobalId] = (tuple(v.min(0).tolist()), tuple(v.max(0).tolist()))  # type: ignore[assignment]
            if not it.next():
                break
    return out
