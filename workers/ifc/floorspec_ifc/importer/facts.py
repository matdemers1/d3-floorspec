"""What an IFC file says about each element, read the same way from our export and from the edit.

The reconciler never compares IFC entities directly: it reads both files — the export the original
version would produce, written again in-process, and the file that came back — into the same plain
facts, keyed by each element's ``Floorspec_Identity`` (ID, Kind, Part), and compares those. Reading
both files with one reader is what makes an untouched element compare equal: whatever this module
does to a value, it does to both sides.

Every length comes out in millimetres, scaled by the file's own length unit, so a file another tool
rewrote in metres reads the same as ours. Placements are taken relative to the element's storey,
so a storey that moved carries its contents with it and they compare unchanged.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import ifcopenshell
import ifcopenshell.util.placement as placement
import ifcopenshell.util.unit as units
import numpy as np

IDENTITY = "Floorspec_Identity"
VERTICAL = 1e-6
"""How far from vertical (as a direction's x and y) an extrusion or a placement's z axis may be."""


Point2 = tuple[float, float]


@dataclass
class Extrusion:
    """One extruded solid of a body, in the element's own coordinates (millimetres)."""

    ring: list[Point2]
    z0: float
    z1: float


@dataclass
class Layer:
    thickness: float
    material: str | None
    """The material's Floorspec ID, else its name."""
    name: str | None


@dataclass
class LayerUsage:
    layers: list[Layer]
    offset: float
    sense: str
    direction: str
    set_id: int
    """The IfcMaterialLayerSet's entity id: the same set the wall type owns, or the wall's own."""


@dataclass
class Facts:
    """One entity that carries (or should carry) a Floorspec identity."""

    entity: Any
    cls: str
    gid: str
    fid: str | None
    kind: str | None
    part: str | None
    doc_hash: str | None
    name: str | None
    long_name: str | None = None
    object_type: str | None = None
    psets: dict[str, dict[str, Any]] = field(default_factory=dict)
    matrix: np.ndarray | None = None
    """The absolute placement (millimetres)."""
    body_type: str | None = None
    body_items: list[str] = field(default_factory=list)
    extrusions: list[Extrusion] | None = None
    """Every body item read as a vertical extrusion; None when any item is not one."""
    axis: list[Point2] | None = None
    type_entity: Any = None
    material: str | None = None
    """A single associated IfcMaterial's Floorspec ID, else its name."""
    layers: LayerUsage | None = None
    overall: tuple[float | None, float | None] = (None, None)
    elevation: float | None = None
    container: Any = None
    host: Any = None
    """For an opening element: the element it voids."""

    @property
    def key(self) -> tuple[str, str, str | None]:
        return (self.kind or "", self.fid or "", self.part)


class Reader:
    """Facts from one file. ``scale`` turns the file's length unit into millimetres."""

    def __init__(self, f: ifcopenshell.file):
        self.f = f
        self.scale = units.calculate_unit_scale(f) * 1000.0
        self.area_scale = self._unit_scale("AREAUNIT")
        self.angle_unit = self._angle_unit()

    def _unit_scale(self, unit_type: str) -> float:
        try:
            return float(units.calculate_unit_scale(self.f, unit_type))
        except Exception:
            return 1.0

    def _angle_unit(self) -> str:
        for ua in self.f.by_type("IfcUnitAssignment"):
            for u in ua.Units or ():
                if getattr(u, "UnitType", None) == "PLANEANGLEUNIT":
                    return (u.Name or "").upper()
        return "RADIAN"

    # ------------------------------------------------------------------ properties

    @staticmethod
    def _value(v: Any) -> Any:
        return getattr(v, "wrappedValue", v)

    def _props(self, props: Any) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for p in props or ():
            if p.is_a("IfcPropertySingleValue"):
                out[p.Name] = None if p.NominalValue is None else self._value(p.NominalValue)
            elif p.is_a("IfcPropertyListValue"):
                out[p.Name] = [self._value(v) for v in p.ListValues or ()]
        return out

    def psets(self, e: Any) -> dict[str, dict[str, Any]]:
        """The element's own property sets — never its type's, which ``get_psets`` would merge in."""
        out: dict[str, dict[str, Any]] = {}
        if e.is_a("IfcMaterialDefinition"):
            for mp in getattr(e, "HasProperties", None) or ():
                out[mp.Name] = self._props(mp.Properties)
            return out
        if e.is_a("IfcTypeObject"):
            for ps in e.HasPropertySets or ():
                if ps.is_a("IfcPropertySet"):
                    out[ps.Name] = self._props(ps.HasProperties)
            return out
        for rel in getattr(e, "IsDefinedBy", None) or ():
            if rel.is_a("IfcRelDefinesByProperties") and rel.RelatingPropertyDefinition.is_a("IfcPropertySet"):
                ps = rel.RelatingPropertyDefinition
                out[ps.Name] = self._props(ps.HasProperties)
        return out

    # ------------------------------------------------------------------ geometry

    def matrix(self, obj_placement: Any) -> np.ndarray | None:
        if obj_placement is None:
            return None
        m = np.array(placement.get_local_placement(obj_placement), dtype=float)
        m[:3, 3] *= self.scale
        return m

    def curve(self, c: Any) -> list[Point2] | None:
        if c is None:
            return None
        if c.is_a("IfcPolyline"):
            pts = [(float(p.Coordinates[0]) * self.scale, float(p.Coordinates[1]) * self.scale) for p in c.Points]
        elif c.is_a("IfcIndexedPolyCurve"):
            coords = c.Points.CoordList
            if c.Segments:
                idx: list[int] = []
                for s in c.Segments:
                    if s.is_a("IfcArcIndex"):
                        return None
                    seg = list(s.wrappedValue if hasattr(s, "wrappedValue") else s[0])
                    idx += seg if not idx else seg[1:]
                coords = [coords[i - 1] for i in idx]
            pts = [(float(p[0]) * self.scale, float(p[1]) * self.scale) for p in coords]
        else:
            return None
        if len(pts) > 1 and math.dist(pts[0], pts[-1]) < 1e-9:
            pts = pts[:-1]
        return pts

    def profile(self, prof: Any) -> list[Point2] | None:
        if prof.is_a("IfcArbitraryClosedProfileDef"):
            return self.curve(prof.OuterCurve)
        if prof.is_a("IfcRectangleProfileDef"):
            x, y = prof.XDim * self.scale / 2, prof.YDim * self.scale / 2
            corners = [(-x, -y), (x, -y), (x, y), (-x, y)]
            if prof.Position is None:
                return corners
            m = placement.get_axis2placement(prof.Position)
            return [(float(m[0, 0] * a + m[0, 1] * b + m[0, 3] * self.scale), float(m[1, 0] * a + m[1, 1] * b + m[1, 3] * self.scale)) for a, b in corners]
        return None

    def extrusion(self, item: Any) -> Extrusion | None:
        if not item.is_a("IfcExtrudedAreaSolid"):
            return None
        ring = self.profile(item.SweptArea)
        if ring is None:
            return None
        m = np.array(placement.get_axis2placement(item.Position), dtype=float) if item.Position is not None else np.eye(4)
        m[:3, 3] *= self.scale
        if abs(m[0, 2]) > VERTICAL or abs(m[1, 2]) > VERTICAL or m[2, 2] < 0:
            return None
        d = m[:3, :3] @ np.array(item.ExtrudedDirection.DirectionRatios, dtype=float)
        n = float(np.linalg.norm(d))
        if n == 0 or abs(d[0] / n) > VERTICAL or abs(d[1] / n) > VERTICAL:
            return None
        pts = [(float(m[0, 0] * a + m[0, 1] * b + m[0, 3]), float(m[1, 0] * a + m[1, 1] * b + m[1, 3])) for a, b in ring]
        z0 = float(m[2, 3])
        z1 = z0 + float(item.Depth) * self.scale * (1 if d[2] > 0 else -1)
        return Extrusion(pts, min(z0, z1), max(z0, z1))

    def shape(self, e: Any, facts: Facts) -> None:
        rep = getattr(e, "Representation", None)
        if rep is None:
            return
        for r in rep.Representations or ():
            ident = r.RepresentationIdentifier
            if ident == "Body":
                facts.body_type = r.RepresentationType
                items = list(r.Items or ())
                facts.body_items = [i.is_a() for i in items]
                ex = [self.extrusion(i) for i in items]
                facts.extrusions = None if any(x is None for x in ex) else ex  # type: ignore[assignment]
            elif ident == "Axis":
                items = list(r.Items or ())
                if len(items) == 1:
                    facts.axis = self.curve(items[0])

    # ------------------------------------------------------------------ relationships

    def material_key(self, m: Any) -> str | None:
        if m is None:
            return None
        ident = self.psets(m).get(IDENTITY) or {}
        return ident.get("ID") or m.Name

    def associations(self, e: Any, facts: Facts) -> None:
        for rel in getattr(e, "HasAssociations", None) or ():
            if not rel.is_a("IfcRelAssociatesMaterial"):
                continue
            m = rel.RelatingMaterial
            if m.is_a("IfcMaterial"):
                facts.material = self.material_key(m)
            elif m.is_a("IfcMaterialLayerSetUsage"):
                facts.layers = LayerUsage(self.layers(m.ForLayerSet), float(m.OffsetFromReferenceLine or 0) * self.scale, m.DirectionSense, m.LayerSetDirection, m.ForLayerSet.id())
            elif m.is_a("IfcMaterialLayerSet"):
                facts.layers = LayerUsage(self.layers(m), 0.0, "POSITIVE", "AXIS2", m.id())

    def layers(self, s: Any) -> list[Layer]:
        return [Layer(float(l.LayerThickness) * self.scale, self.material_key(l.Material), l.Name) for l in s.MaterialLayers or ()]

    @staticmethod
    def type_of(e: Any) -> Any:
        for rel in getattr(e, "IsTypedBy", None) or ():
            return rel.RelatingType
        return None

    @staticmethod
    def container_of(e: Any) -> Any:
        for rel in getattr(e, "ContainedInStructure", None) or ():
            return rel.RelatingStructure
        for rel in getattr(e, "Decomposes", None) or ():
            return rel.RelatingObject
        return None

    # ------------------------------------------------------------------ the whole file

    def read(self, e: Any) -> Facts:
        ps = self.psets(e)
        ident = ps.get(IDENTITY) or {}
        facts = Facts(
            entity=e,
            cls=e.is_a(),
            gid=getattr(e, "GlobalId", None) or f"#{e.id()}",
            fid=ident.get("ID"),
            kind=ident.get("Kind"),
            part=ident.get("Part"),
            doc_hash=ident.get("DocumentHash"),
            name=getattr(e, "Name", None),
            long_name=getattr(e, "LongName", None) if e.is_a("IfcSpatialElement") else None,
            object_type=getattr(e, "ObjectType", None) if e.is_a("IfcObject") else None,
            psets=ps,
        )
        if e.is_a("IfcProduct"):
            facts.matrix = self.matrix(e.ObjectPlacement)
            self.shape(e, facts)
            facts.container = self.container_of(e)
            if e.is_a("IfcOpeningElement"):
                for rel in e.VoidsElements or ():
                    facts.host = rel.RelatingBuildingElement
        if e.is_a("IfcObject"):
            facts.type_entity = self.type_of(e)
        if e.is_a("IfcBuildingStorey") and e.Elevation is not None:
            facts.elevation = float(e.Elevation) * self.scale
        if e.is_a("IfcDoor") or e.is_a("IfcWindow"):
            w, h = e.OverallWidth, e.OverallHeight
            facts.overall = (None if w is None else float(w) * self.scale, None if h is None else float(h) * self.scale)
        if not e.is_a("IfcMaterialDefinition"):
            self.associations(e, facts)
        return facts

    def all(self) -> list[Facts]:
        """Every product, type, material and the project: what can carry an identity."""
        out = [self.read(e) for e in self.f.by_type("IfcProject")]
        out += [self.read(e) for e in self.f.by_type("IfcProduct")]
        out += [self.read(e) for e in self.f.by_type("IfcTypeObject")]
        out += [self.read(e) for e in self.f.by_type("IfcMaterial")]
        return out


def relative(storey: np.ndarray | None, m: np.ndarray | None) -> np.ndarray | None:
    """A placement relative to a storey's."""
    if m is None:
        return None
    if storey is None:
        return m
    return np.linalg.inv(storey) @ m


def apply(m: np.ndarray, p: tuple[float, float], z: float = 0.0) -> tuple[float, float, float]:
    v = m @ np.array([p[0], p[1], z, 1.0])
    return (float(v[0]), float(v[1]), float(v[2]))


def is_upright(m: np.ndarray | None) -> bool:
    """Whether a placement keeps z vertical (a turn in plan is fine; a tilt is not)."""
    return m is None or (abs(m[0, 2]) < VERTICAL and abs(m[1, 2]) < VERTICAL and m[2, 2] > 0)


def plan_angle(m: np.ndarray) -> float:
    """A placement's turn in plan, in degrees."""
    return math.degrees(math.atan2(m[1, 0], m[0, 0]))
