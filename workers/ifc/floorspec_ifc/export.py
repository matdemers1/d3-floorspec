"""Floorspec → IFC4 ADD2 TC1 Reference View, by Annex A of Floorspec Core (FLR-T-9.4, FLR-REQ-131).

One payload (the design's view, what the engine derived from it, the version's facts) becomes one
IFC file. Every class and relationship is the one the annex names; ``mapping.py`` holds its
enumeration tables.

Reference View geometry. RV 1.2 carries no Boolean operations: a wall's body arrives with its
openings already cut, and the IfcOpeningElement with its IfcRelVoidsElement and IfcRelFillsElement
are there for what they mean — the void, the door in it — not for a receiver to subtract. So:

- a wall's body is a set of vertical extrusions (``SweptSolid``): its derived plan outline, cut
  square to the wall at every opening's ends, each piece extruded over the heights no opening takes;
  a junction fill (5.7) rides in the body of the first wall, by ID, that meets at the junction;
- openings, doors and windows, spaces, slabs, room floors, landings, stair treads and extension
  elements' fallback boxes are extrusions of exact plan polygons;
- a roof face is a planar polygon in 3D: a ``SurfaceModel`` face, or with a thickness a closed
  ``Brep`` (the face and the face moved down by the thickness); ceilings are ``SurfaceModel``s;
- handrails are ``Brep`` bars along each flight's nosing line.

Every exported element carries ``Floorspec_Identity`` (``ID``, ``Kind``, ``DocumentHash`` and, for a
piece of an element, ``Part``), so FLR-T-9.5 can reconcile an edited file element by element.
GlobalIds are UUIDv5 of the element's identity, so the same element keeps its GlobalId from one
version to the next, and the same version gives the same bytes.
"""

from __future__ import annotations

import math
import uuid
from collections import defaultdict
from typing import Any, Iterable, Sequence

import ifcopenshell
import ifcopenshell.guid
from shapely.geometry import Point, Polygon

from . import __version__
from .geometry import (
    Cut,
    Frame,
    box_faces,
    centroid,
    dms,
    flat_faces,
    m2_from_base,
    mm,
    mm2,
    mm3,
    prism_faces,
    tray_faces,
    vault_faces,
    wall_pieces,
)
from .mapping import SCHEMA, VIEW_DEFINITION, ROOF_TYPES, door_hand, door_operation, stair_type, window_operation
from .payload import Payload

NAMESPACE = uuid.UUID("6f6c6f6f-7273-7065-632d-6966632d7634")
"""Fixed: the namespace of every GlobalId this exporter writes."""

LAYER_CATEGORY = {"core": "LoadBearing", "insulation": "Insulation", "finish": "Finish"}
DEFAULT_STYLES = {
    "default": ((0.8, 0.8, 0.8), 0.0),
    "door": ((0.55, 0.42, 0.3), 0.0),
    "glass": ((0.62, 0.77, 0.86), 0.6),
    "stair": ((0.74, 0.62, 0.46), 0.0),
    "railing": ((0.25, 0.25, 0.27), 0.0),
    "proxy": ((0.82, 0.8, 0.74), 0.0),
}
DOOR_LEAF = 50.0
"""A door leaf's thickness in its body, in millimetres: Core declares none."""
GLAZING = 30.0
HANDRAIL_BAR = 50.0
HANDRAIL_INSET = 50.0

SUMMARY_CLASSES = (
    "IfcBuildingStorey",
    "IfcWall",
    "IfcOpeningElement",
    "IfcDoor",
    "IfcWindow",
    "IfcSpace",
    "IfcSlab",
    "IfcCovering",
    "IfcRoof",
    "IfcStair",
    "IfcStairFlight",
    "IfcRailing",
    "IfcVirtualElement",
    "IfcBuildingElementProxy",
    "IfcMaterial",
)


class ExportError(RuntimeError):
    """The export could not be written; the message is for a person."""


def entries(c: dict | None) -> list[tuple[str, Any]]:
    return sorted((c or {}).items())


def colour(hexcode: str | None) -> tuple[float, float, float] | None:
    if not isinstance(hexcode, str) or len(hexcode) != 7 or not hexcode.startswith("#"):
        return None
    try:
        return tuple(int(hexcode[i : i + 2], 16) / 255 for i in (1, 3, 5))  # type: ignore[return-value]
    except ValueError:
        return None


def effective_layers(doc: dict, wall: dict) -> list[dict] | None:
    if wall.get("layers"):
        return wall["layers"]
    t = (doc.get("types") or {}).get(wall.get("type", ""))
    return t["layers"] if t and t.get("kind") == "wallType" else None


def left_offset(wall: dict, layers: list[dict]) -> float:
    """5.4: a, the distance from the location line to the left face, in base units."""
    total = sum(l["thickness"] for l in layers)
    j = wall.get("justification", "center")
    if j == "exteriorFace":
        return 0
    if j == "interiorFace":
        return total
    if j == "coreFace":
        first = next((i for i, l in enumerate(layers) if l["function"] == "core"), 0)
        return sum(l["thickness"] for l in layers[:first])
    return total / 2  # type: ignore[return-value]


class Exporter:
    def __init__(self, payload: Payload):
        self.p = payload
        self.doc = payload.document
        self.der = payload.derived
        self.f = ifcopenshell.file(schema=SCHEMA)
        self._keys: set[str] = set()
        self._styles: dict[str, Any] = {}
        self.materials: dict[str, Any] = {}
        self.storeys: dict[str, tuple[Any, Any, float]] = {}
        self.walls: dict[str, dict[str, Any]] = {}
        self.spaces: dict[str, Any] = {}
        self.types: dict[str, Any] = {}
        self.space_types: dict[str, Any] = {}
        self.layer_sets: dict[str, Any] = {}
        self._contained: dict[int, tuple[Any, list[Any]]] = {}
        self._typed: dict[int, tuple[Any, list[Any]]] = {}
        self._material_of: dict[int, tuple[Any, list[Any]]] = {}
        self._space_covers: dict[str, list[Any]] = defaultdict(list)

    # ---------------------------------------------------------------- identity and properties

    def gid(self, key: str) -> str:
        k, n = key, 1
        while k in self._keys:
            n += 1
            k = f"{key}#{n}"
        self._keys.add(k)
        return ifcopenshell.guid.compress(uuid.uuid5(NAMESPACE, k).hex)

    def value(self, typ: str, v: Any) -> Any:
        if typ == "IfcInteger":
            v = int(v)
        elif typ == "IfcBoolean":
            v = bool(v)
        elif typ in ("IfcLengthMeasure", "IfcPositiveLengthMeasure", "IfcAreaMeasure", "IfcPlaneAngleMeasure", "IfcReal", "IfcCountMeasure"):
            v = float(v)
        return self.f.create_entity(typ, v)

    def properties(self, spec: Iterable[tuple]) -> list[Any]:
        out = []
        for s in spec:
            if s[1] == "list":
                name, _, typ, values = s
                if values:
                    out.append(self.f.create_entity("IfcPropertyListValue", Name=name, ListValues=[self.value(typ, v) for v in values]))
            else:
                name, typ, v = s
                if v is not None:
                    out.append(self.f.create_entity("IfcPropertySingleValue", Name=name, NominalValue=self.value(typ, v)))
        return out

    def pset(self, owner: Any, name: str, spec: Iterable[tuple]) -> Any:
        props = self.properties(spec)
        if not props:
            return None
        if owner.is_a("IfcMaterialDefinition"):
            return self.f.create_entity("IfcMaterialProperties", Name=name, Properties=props, Material=owner)
        ps = self.f.create_entity("IfcPropertySet", GlobalId=self.gid(f"pset/{name}/{owner.GlobalId}"), Name=name, HasProperties=props)
        if owner.is_a("IfcTypeObject"):
            owner.HasPropertySets = tuple(owner.HasPropertySets or ()) + (ps,)
        else:
            self.f.create_entity("IfcRelDefinesByProperties", GlobalId=self.gid(f"rel/props/{name}/{owner.GlobalId}"), RelatedObjects=[owner], RelatingPropertyDefinition=ps)
        return ps

    def identity(self, owner: Any, fid: str, kind: str, part: str | None = None) -> None:
        self.pset(
            owner,
            "Floorspec_Identity",
            [("ID", "IfcIdentifier", fid), ("Kind", "IfcLabel", kind), ("Part", "IfcLabel", part), ("DocumentHash", "IfcIdentifier", self.p.hash)],
        )

    # ---------------------------------------------------------------- geometry

    def pt3(self, p: Sequence[float]) -> Any:
        return self.f.create_entity("IfcCartesianPoint", Coordinates=[float(p[0]), float(p[1]), float(p[2])])

    def pt2(self, p: Sequence[float]) -> Any:
        return self.f.create_entity("IfcCartesianPoint", Coordinates=[float(p[0]), float(p[1])])

    def dir3(self, d: Sequence[float]) -> Any:
        return self.f.create_entity("IfcDirection", DirectionRatios=[float(d[0]), float(d[1]), float(d[2])])

    def axis3(self, origin: Sequence[float] = (0.0, 0.0, 0.0), xdir: Sequence[float] | None = None) -> Any:
        if xdir is None:
            return self.f.create_entity("IfcAxis2Placement3D", Location=self.pt3(origin))
        return self.f.create_entity("IfcAxis2Placement3D", Location=self.pt3(origin), Axis=self.dir3((0.0, 0.0, 1.0)), RefDirection=self.dir3(xdir))

    def placement(self, rel: Any, origin: Sequence[float] = (0.0, 0.0, 0.0), xdir: Sequence[float] | None = None) -> Any:
        return self.f.create_entity("IfcLocalPlacement", PlacementRelTo=rel, RelativePlacement=self.axis3(origin, xdir))

    def polyline2(self, ring: Sequence[Sequence[float]]) -> Any:
        pts = [self.pt2(p) for p in ring]
        return self.f.create_entity("IfcPolyline", Points=[*pts, pts[0]])

    def profile(self, outer: Sequence[Sequence[float]], holes: Sequence[Sequence[Sequence[float]]] = ()) -> Any:
        if holes:
            return self.f.create_entity(
                "IfcArbitraryProfileDefWithVoids", ProfileType="AREA", OuterCurve=self.polyline2(outer), InnerCurves=[self.polyline2(h) for h in holes]
            )
        return self.f.create_entity("IfcArbitraryClosedProfileDef", ProfileType="AREA", OuterCurve=self.polyline2(outer))

    def extrusion(self, outer: Sequence[Sequence[float]], holes: Sequence[Sequence[Sequence[float]]], z0: float, z1: float) -> Any:
        return self.f.create_entity(
            "IfcExtrudedAreaSolid",
            SweptArea=self.profile(outer, holes),
            Position=self.axis3((0.0, 0.0, z0)),
            ExtrudedDirection=self.dir3((0.0, 0.0, 1.0)),
            Depth=float(z1 - z0),
        )

    def loop(self, ring: Sequence[Sequence[float]]) -> Any:
        return self.f.create_entity("IfcPolyLoop", Polygon=[self.pt3(p) for p in ring])

    def face(self, outer: Sequence[Sequence[float]], holes: Sequence[Sequence[Sequence[float]]] = ()) -> Any:
        bounds = [self.f.create_entity("IfcFaceOuterBound", Bound=self.loop(outer), Orientation=True)]
        bounds += [self.f.create_entity("IfcFaceBound", Bound=self.loop(h), Orientation=True) for h in holes]
        return self.f.create_entity("IfcFace", Bounds=bounds)

    def brep(self, faces: Sequence[Sequence[Sequence[float]]]) -> Any:
        shell = self.f.create_entity("IfcClosedShell", CfsFaces=[self.face(fc) for fc in faces])
        return self.f.create_entity("IfcFacetedBrep", Outer=shell)

    def surface_model(self, faces: Sequence[tuple[Sequence[Sequence[float]], Sequence[Sequence[Sequence[float]]]]]) -> Any:
        shell = self.f.create_entity("IfcOpenShell", CfsFaces=[self.face(o, h) for o, h in faces])
        return self.f.create_entity("IfcShellBasedSurfaceModel", SbsmBoundary=[shell])

    def shape(self, reps: Sequence[tuple[str, str, Sequence[Any]]]) -> Any:
        out = []
        for ident, rtype, items in reps:
            if not items:
                continue
            ctx = self.axis_ctx if ident == "Axis" else self.body_ctx
            out.append(self.f.create_entity("IfcShapeRepresentation", ContextOfItems=ctx, RepresentationIdentifier=ident, RepresentationType=rtype, Items=list(items)))
        return self.f.create_entity("IfcProductDefinitionShape", Representations=out) if out else None

    def body(self, rtype: str, items: Sequence[Any], style: str | None, axis: Any = None) -> Any:
        if style is not None:
            s = self.style(style)
            for it in items:
                self.f.create_entity("IfcStyledItem", Item=it, Styles=[s])
        reps: list[tuple[str, str, Sequence[Any]]] = []
        if axis is not None:
            reps.append(("Axis", "Curve2D", [axis]))
        reps.append(("Body", rtype, items))
        return self.shape(reps)

    # ---------------------------------------------------------------- styles and materials

    def style(self, key: str) -> Any:
        """A material's surface style by its ID, or one of the default styles by name."""
        if key in self._styles:
            return self._styles[key]
        if key in DEFAULT_STYLES:
            rgb, transparency = DEFAULT_STYLES[key]
            name = f"Floorspec {key}"
        else:
            m = (self.doc.get("materials") or {}).get(key, {})
            rgb = colour(m.get("color")) or DEFAULT_STYLES["default"][0]
            transparency = 0.0
            name = m.get("name") or key
        rendering = self.f.create_entity(
            "IfcSurfaceStyleRendering",
            SurfaceColour=self.f.create_entity("IfcColourRgb", Name=None, Red=rgb[0], Green=rgb[1], Blue=rgb[2]),
            Transparency=transparency,
            # Annex A names PHYSICAL, which IfcReflectanceMethodEnum gained only in IFC4.3; IFC4 ADD2
            # TC1 has no physically based method, so NOTDEFINED, with metallic and roughness in
            # Floorspec_Material.
            ReflectanceMethod="NOTDEFINED",
        )
        styles = [rendering]
        if key not in DEFAULT_STYLES:
            tex = self.textures(key)
            if tex is not None:
                styles.append(tex)
        s = self.f.create_entity("IfcSurfaceStyle", Name=name, Side="POSITIVE", Styles=styles)
        self._styles[key] = s
        return s

    def textures(self, mid: str) -> Any:
        m = (self.doc.get("materials") or {}).get(mid, {})
        t = m.get("texture")
        if not t:
            return None
        assets = self.doc.get("assets") or {}
        sx, sy = mm(t["size"][0]), mm(t["size"][1])
        ox, oy = mm2(t.get("offset", [0, 0]))
        r = math.radians(t.get("rotation", 0) / 1_000_000)
        out = []
        for member, mode in (("asset", "DIFFUSE"), ("normal", "NORMAL"), ("metallicRoughness", "METALLICROUGHNESS"), ("occlusion", "OCCLUSION")):
            aid = t.get(member)
            a = assets.get(aid) if aid else None
            if not a:
                continue
            url = a.get("path") or a.get("uri")
            op = self.f.create_entity(
                "IfcCartesianTransformationOperator2DnonUniform",
                Axis1=self.f.create_entity("IfcDirection", DirectionRatios=[math.cos(r), math.sin(r)]),
                Axis2=self.f.create_entity("IfcDirection", DirectionRatios=[-math.sin(r), math.cos(r)]),
                LocalOrigin=self.pt2((ox, oy)),
                Scale=sx,
                Scale2=sy,
            )
            out.append(self.f.create_entity("IfcImageTexture", RepeatS=True, RepeatT=True, Mode=mode, TextureTransform=op, URLReference=url))
        return self.f.create_entity("IfcSurfaceStyleWithTextures", Textures=out) if out else None

    def library(self, source: dict) -> Any:
        info = self.f.create_entity("IfcLibraryInformation", Name=source["library"], Version=source["version"], Location=source["library"])
        return self.f.create_entity("IfcLibraryReference", Identification=source["item"], ReferencedLibrary=info)

    def build_materials(self) -> None:
        for mid, m in entries(self.doc.get("materials")):
            mat = self.f.create_entity("IfcMaterial", Name=m.get("name") or mid)
            self.materials[mid] = mat
            self.identity(mat, mid, "material")
            self.pset(mat, "Floorspec_Material", [("Metallic", "IfcInteger", m.get("metallic")), ("Roughness", "IfcInteger", m.get("roughness")), ("Colour", "IfcLabel", m.get("color"))])
            styled = self.f.create_entity("IfcStyledItem", Item=None, Styles=[self.style(mid)])
            rep = self.f.create_entity("IfcStyledRepresentation", ContextOfItems=self.body_ctx, RepresentationIdentifier="Style", RepresentationType="Material", Items=[styled])
            self.f.create_entity("IfcMaterialDefinitionRepresentation", Representations=[rep], RepresentedMaterial=mat)
            if m.get("source"):
                self.f.create_entity("IfcExternalReferenceRelationship", RelatingReference=self.library(m["source"]), RelatedResourceObjects=[mat])

    def associate(self, material: Any, element: Any) -> None:
        if material is None:
            return
        self._material_of.setdefault(material.id(), (material, []))[1].append(element)

    # ---------------------------------------------------------------- relationships

    def contain(self, spatial: Any, element: Any) -> None:
        self._contained.setdefault(spatial.id(), (spatial, []))[1].append(element)

    def typed(self, typ: Any, element: Any) -> None:
        self._typed.setdefault(typ.id(), (typ, []))[1].append(element)

    def aggregate(self, whole: Any, parts: Sequence[Any]) -> None:
        if parts:
            self.f.create_entity("IfcRelAggregates", GlobalId=self.gid(f"rel/aggregates/{whole.GlobalId}"), RelatingObject=whole, RelatedObjects=list(parts))

    def flush(self) -> None:
        for spatial, elements in self._contained.values():
            self.f.create_entity(
                "IfcRelContainedInSpatialStructure", GlobalId=self.gid(f"rel/contains/{spatial.GlobalId}"), RelatedElements=elements, RelatingStructure=spatial
            )
        for typ, elements in self._typed.values():
            self.f.create_entity("IfcRelDefinesByType", GlobalId=self.gid(f"rel/type/{typ.GlobalId}"), RelatedObjects=elements, RelatingType=typ)
        for material, elements in self._material_of.values():
            self.f.create_entity(
                "IfcRelAssociatesMaterial", GlobalId=self.gid(f"rel/material/{material.id()}"), RelatedObjects=elements, RelatingMaterial=material
            )
        for rid, coverings in self._space_covers.items():
            self.f.create_entity("IfcRelCoversSpaces", GlobalId=self.gid(f"rel/coversSpaces/{rid}"), RelatingSpace=self.spaces[rid], RelatedCoverings=coverings)
        declared = [*self.types.values(), *self.space_types.values()]
        if declared:
            self.f.create_entity("IfcRelDeclares", GlobalId=self.gid("rel/declares"), RelatingContext=self.project, RelatedDefinitions=declared)

    # ---------------------------------------------------------------- project and spatial structure

    def header(self) -> None:
        h = self.f.header
        h.file_description.description = (VIEW_DEFINITION,)
        h.file_description.implementation_level = "2;1"
        h.file_name.name = self.p.name
        h.file_name.time_stamp = self.p.timestamp
        h.file_name.author = ("",)
        h.file_name.organization = ("",)
        h.file_name.preprocessor_version = f"IfcOpenShell {ifcopenshell.version}"
        h.file_name.originating_system = f"D3 Floorspec {self.p.engine_version} (floorspec-ifc {__version__})".strip()
        h.file_name.authorization = ""

    def build_project(self) -> None:
        site = self.doc.get("site") or {}
        theta = math.radians(site.get("trueNorth", 0) / 1_000_000)
        north = self.f.create_entity("IfcDirection", DirectionRatios=[-math.sin(theta), math.cos(theta)])
        self.model_ctx = self.f.create_entity(
            "IfcGeometricRepresentationContext", ContextType="Model", CoordinateSpaceDimension=3, Precision=1.0e-5, WorldCoordinateSystem=self.axis3(), TrueNorth=north
        )
        self.body_ctx = self.f.create_entity("IfcGeometricRepresentationSubContext", ContextIdentifier="Body", ContextType="Model", ParentContext=self.model_ctx, TargetView="MODEL_VIEW")
        self.axis_ctx = self.f.create_entity("IfcGeometricRepresentationSubContext", ContextIdentifier="Axis", ContextType="Model", ParentContext=self.model_ctx, TargetView="GRAPH_VIEW")
        radian = self.f.create_entity("IfcSIUnit", UnitType="PLANEANGLEUNIT", Name="RADIAN")
        degree = self.f.create_entity(
            "IfcConversionBasedUnit",
            Dimensions=self.f.create_entity("IfcDimensionalExponents", 0, 0, 0, 0, 0, 0, 0),
            UnitType="PLANEANGLEUNIT",
            Name="DEGREE",
            ConversionFactor=self.f.create_entity("IfcMeasureWithUnit", ValueComponent=self.f.create_entity("IfcPlaneAngleMeasure", math.pi / 180), UnitComponent=radian),
        )
        units = self.f.create_entity(
            "IfcUnitAssignment",
            Units=[
                self.f.create_entity("IfcSIUnit", UnitType="LENGTHUNIT", Prefix="MILLI", Name="METRE"),
                self.f.create_entity("IfcSIUnit", UnitType="AREAUNIT", Name="SQUARE_METRE"),
                self.f.create_entity("IfcSIUnit", UnitType="VOLUMEUNIT", Name="CUBIC_METRE"),
                degree,
            ],
        )
        project = self.doc["project"]
        self.project = self.f.create_entity(
            "IfcProject",
            GlobalId=self.gid("project"),
            Name=project.get("name"),
            Description=project.get("description"),
            RepresentationContexts=[self.model_ctx],
            UnitsInContext=units,
        )
        self.identity(self.project, "project", "project")
        if self.p.design:
            self.pset(self.project, "Floorspec_Design", [(s, "IfcLabel", o) for s, o in sorted(self.p.design.items())])

        parent, parent_placement = self.project, None
        if "site" in self.doc:
            loc = site.get("location")
            ifc_site = self.f.create_entity(
                "IfcSite",
                GlobalId=self.gid("site"),
                Name="Site",
                ObjectPlacement=self.placement(None),
                CompositionType="ELEMENT",
                RefLatitude=dms(loc["latitude"]) if loc else None,
                RefLongitude=dms(loc["longitude"]) if loc else None,
            )
            self.identity(ifc_site, "site", "site")
            self.pset(ifc_site, "Floorspec_Site", [("TrueNorth", "IfcPlaneAngleMeasure", site.get("trueNorth", 0) / 1_000_000)])
            self.aggregate(self.project, [ifc_site])
            parent, parent_placement = ifc_site, ifc_site.ObjectPlacement

        buildings = []
        levels = self.doc.get("levels") or {}
        for bid, b in entries(self.doc.get("buildings")):
            bp = self.placement(parent_placement)
            building = self.f.create_entity("IfcBuilding", GlobalId=self.gid(f"building/{bid}"), Name=b.get("name") or bid, ObjectPlacement=bp, CompositionType="ELEMENT")
            self.identity(building, bid, "building")
            buildings.append(building)
            storeys = []
            mine = sorted(((lid, l) for lid, l in levels.items() if l.get("building") == bid), key=lambda e: (e[1]["elevation"], e[0]))
            for lid, l in mine:
                elev = mm(l["elevation"])
                sp = self.placement(bp, (0.0, 0.0, elev))
                storey = self.f.create_entity(
                    "IfcBuildingStorey", GlobalId=self.gid(f"level/{lid}"), Name=l.get("name") or lid, ObjectPlacement=sp, CompositionType="ELEMENT", Elevation=elev
                )
                self.identity(storey, lid, "level")
                self.pset(
                    storey,
                    "Floorspec_Level",
                    [("Height", "IfcLengthMeasure", mm(l["height"])), ("FloorThickness", "IfcLengthMeasure", mm(l["floorThickness"]) if "floorThickness" in l else None),
                     ("CeilingHeight", "IfcLengthMeasure", mm(l["ceilingHeight"]) if "ceilingHeight" in l else None)],
                )
                self.storeys[lid] = (storey, sp, elev)
                storeys.append(storey)
            self.aggregate(building, storeys)
        self.aggregate(parent, buildings)

    def storey(self, level: str) -> tuple[Any, Any, float]:
        s = self.storeys.get(level)
        if s is None:
            raise ExportError(f"level {level} belongs to no building")
        return s

    def level_elevation(self, level: str) -> float:
        return mm(self.doc["levels"][level]["elevation"])

    # ---------------------------------------------------------------- types

    def layer_set(self, key: str, name: str, layers: list[dict]) -> Any:
        if key in self.layer_sets:
            return self.layer_sets[key]
        ifc_layers = [
            self.f.create_entity(
                "IfcMaterialLayer",
                Material=self.materials.get(l.get("material", "")),
                LayerThickness=mm(l["thickness"]),
                IsVentilated=True if l["function"] == "airGap" else None,
                Name=l["function"],
                Category=LAYER_CATEGORY.get(l["function"]),
            )
            for l in layers
        ]
        s = self.f.create_entity("IfcMaterialLayerSet", MaterialLayers=ifc_layers, LayerSetName=name)
        self.layer_sets[key] = s
        return s

    def clear_opening(self, owner: Any, co: dict | None) -> None:
        if not co:
            return
        self.pset(
            owner,
            "Floorspec_ClearOpening",
            [("ClearWidth", "IfcPositiveLengthMeasure", mm(co["width"])), ("ClearHeight", "IfcPositiveLengthMeasure", mm(co["height"])),
             ("ClearArea", "IfcAreaMeasure", m2_from_base(co["area"]) if "area" in co else None)],
        )

    def build_types(self) -> None:
        for tid, t in entries(self.doc.get("types")):
            name = t.get("name") or tid
            kind = t["kind"]
            if kind == "wallType":
                typ = self.f.create_entity("IfcWallType", GlobalId=self.gid(f"type/{tid}"), Name=name, PredefinedType="STANDARD")
                layer_set = self.layer_set(f"type/{tid}", name, t["layers"])
                self.f.create_entity("IfcRelAssociatesMaterial", GlobalId=self.gid(f"rel/material/type/{tid}"), RelatedObjects=[typ], RelatingMaterial=layer_set)
            elif kind == "doorType":
                op, user = door_operation(t.get("operation"), door_hand(None, None))
                typ = self.f.create_entity("IfcDoorType", GlobalId=self.gid(f"type/{tid}"), Name=name, PredefinedType="DOOR", OperationType=op, UserDefinedOperationType=user)
            else:
                part, panels = window_operation(t.get("operation"))
                typ = self.f.create_entity("IfcWindowType", GlobalId=self.gid(f"type/{tid}"), Name=name, PredefinedType="WINDOW", PartitioningType=part)
                for i, (operation, position) in enumerate(panels):
                    panel = self.f.create_entity(
                        "IfcWindowPanelProperties", GlobalId=self.gid(f"panel/{tid}/{i}"), Name=f"Panel {i + 1}", OperationType=operation, PanelPosition=position
                    )
                    typ.HasPropertySets = tuple(typ.HasPropertySets or ()) + (panel,)
            self.types[tid] = typ
            self.identity(typ, tid, "type")
            if kind != "wallType":
                self.pset(
                    typ,
                    "Floorspec_Type",
                    [("Operation", "IfcLabel", t.get("operation")), ("Width", "IfcPositiveLengthMeasure", mm(t["width"]) if "width" in t else None),
                     ("Height", "IfcPositiveLengthMeasure", mm(t["height"]) if "height" in t else None), ("Sill", "IfcLengthMeasure", mm(t["sill"]) if "sill" in t else None)],
                )
                self.clear_opening(typ, t.get("clearOpening"))
            if t.get("source"):
                self.f.create_entity("IfcRelAssociatesLibrary", GlobalId=self.gid(f"rel/library/{tid}"), RelatedObjects=[typ], RelatingLibrary=self.library(t["source"]))

    def build_program(self) -> None:
        program = self.doc.get("program") or {}
        for iid, item in entries(program.get("items")):
            st = self.f.create_entity(
                "IfcSpaceType", GlobalId=self.gid(f"programItem/{iid}"), Name=item.get("name") or iid, ElementType=item["function"], PredefinedType="USERDEFINED"
            )
            self.space_types[iid] = st
            self.identity(st, iid, "programItem")
            self.pset(
                st,
                "Floorspec_Program",
                [("Function", "IfcLabel", item["function"]), ("Count", "IfcInteger", item.get("count")),
                 ("TargetArea", "IfcAreaMeasure", m2_from_base(item["targetArea"]) if "targetArea" in item else None),
                 ("MinArea", "IfcAreaMeasure", m2_from_base(item["minArea"]) if "minArea" in item else None), ("Level", "IfcIdentifier", item.get("level"))],
            )
        by_a: dict[str, list[dict]] = defaultdict(list)
        for adj in program.get("adjacency") or []:
            by_a[adj["a"]].append(adj)
        for a, adjs in sorted(by_a.items()):
            st = self.space_types.get(a)
            if st is None:
                continue
            spec: list[tuple] = []
            for kind in ("required", "preferred", "forbidden"):
                these = [x for x in adjs if x["kind"] == kind]
                label = kind.capitalize()
                spec.append((label, "list", "IfcIdentifier", [x["b"] for x in these]))
                spec.append((f"{label}Weights", "list", "IfcInteger", [x.get("weight", 5) for x in these]))
            self.pset(st, "Floorspec_Adjacency", spec)

    # ---------------------------------------------------------------- walls, openings, separators

    def build_walls(self) -> None:
        doc, der = self.doc, self.der
        junctions = doc.get("junctions") or {}
        walls = doc.get("walls") or {}
        openings_on: dict[str, list[str]] = defaultdict(list)
        for oid, o in entries(doc.get("openings")):
            if oid in der["openings"]:
                openings_on[o["wall"]].append(oid)
        at_junction: dict[str, list[tuple[str, str]]] = defaultdict(list)
        for wid, w in entries(walls):
            at_junction[w["start"]].append((wid, "ATSTART"))
            at_junction[w["end"]].append((wid, "ATEND"))
        fills_of: dict[str, list[str]] = defaultdict(list)
        for jid in sorted(der.get("junctionFills") or {}):
            if at_junction.get(jid):
                fills_of[at_junction[jid][0][0]].append(jid)
        finishes = (der.get("finishes") or {}).get("walls") or {}

        for wid, w in entries(walls):
            dw = der["walls"].get(wid)
            if dw is None:
                continue
            storey, sp, elev = self.storey(w["level"])
            S, E = junctions[w["start"]]["position"], junctions[w["end"]]["position"]
            frame = Frame.along(S, E)
            pl = self.placement(sp, (frame.ox, frame.oy, 0.0), (frame.dx, frame.dy, 0.0))
            outline = [frame.local_base(dw[k]) for k in ("startRight", "endRight", "endLeft", "startLeft")]
            base, top = mm(dw["baseElevation"]) - elev, mm(dw["topElevation"]) - elev
            cuts = []
            for oid in openings_on.get(wid, []):
                do = der["openings"][oid]
                u = sorted((frame.local_base(do["start"])[0], frame.local_base(do["end"])[0]))
                cuts.append(Cut(u[0], u[1], mm(do["sillElevation"]) - elev, mm(do["headElevation"]) - elev))
            items = [self.extrusion(pc.outer, pc.holes, pc.z0, pc.z1) for pc in wall_pieces(outline, cuts, base, top)]
            for jid in fills_of.get(wid, []):
                incident = [der["walls"][x] for x, _ in at_junction[jid] if x in der["walls"]]
                z0 = mm(min(x["baseElevation"] for x in incident)) - elev
                z1 = mm(max(x["topElevation"] for x in incident)) - elev
                ring = [frame.local_base(p) for p in der["junctionFills"][jid]]
                items.append(self.extrusion(ring, [], z0, z1))
            layers = effective_layers(doc, w)
            style = next((l["material"] for l in layers or [] if l.get("material") in self.materials), None)
            length = math.hypot(mm(E[0]) - mm(S[0]), mm(E[1]) - mm(S[1]))
            axis = self.f.create_entity("IfcPolyline", Points=[self.pt2((0.0, 0.0)), self.pt2((length, 0.0))])
            wall = self.f.create_entity(
                "IfcWall",
                GlobalId=self.gid(f"wall/{wid}"),
                Name=w.get("name") or wid,
                ObjectPlacement=pl,
                Representation=self.body("SweptSolid", items, style or "default", axis),
                PredefinedType="STANDARD",
            )
            vs = [p[1] for p in outline]
            self.walls[wid] = {"entity": wall, "placement": pl, "frame": frame, "elev": elev, "base": base, "top": top, "vmin": min(vs), "vmax": max(vs), "outline": outline}
            self.contain(storey, wall)
            self.identity(wall, wid, "wall")
            self.pset(
                wall,
                "Floorspec_Graph",
                [("StartJunction", "IfcIdentifier", w["start"]), ("EndJunction", "IfcIdentifier", w["end"]),
                 ("StartX", "IfcLengthMeasure", mm(S[0])), ("StartY", "IfcLengthMeasure", mm(S[1])),
                 ("EndX", "IfcLengthMeasure", mm(E[0])), ("EndY", "IfcLengthMeasure", mm(E[1])),
                 ("JunctionFills", "list", "IfcIdentifier", fills_of.get(wid, []))],
            )
            self.pset(wall, "Floorspec_Wall", [("Type", "IfcIdentifier", w.get("type")), ("Justification", "IfcLabel", w.get("justification", "center"))])
            faces = finishes.get(wid, {})
            exterior = not (faces.get("left", {}).get("room") and faces.get("right", {}).get("room"))
            self.pset(wall, "Pset_WallCommon", [("IsExternal", "IfcBoolean", exterior)])
            if w.get("type") in self.types and self.types[w["type"]].is_a("IfcWallType"):
                self.typed(self.types[w["type"]], wall)
            if layers:
                own = bool(w.get("layers")) or w.get("type") not in self.types
                layer_set = self.layer_set(f"wall/{wid}" if own else f"type/{w['type']}", f"{w.get('name') or wid} layers" if own else (self.doc["types"][w["type"]].get("name") or w["type"]), layers)
                # Layers run left to right (5.4), the left face is at +y of the wall's frame and the
                # location line at y = 0: the layer set starts at the left face, a above the axis,
                # and grows towards −y.
                usage = self.f.create_entity(
                    "IfcMaterialLayerSetUsage", ForLayerSet=layer_set, LayerSetDirection="AXIS2", DirectionSense="NEGATIVE", OffsetFromReferenceLine=mm(left_offset(w, layers))
                )
                self.f.create_entity("IfcRelAssociatesMaterial", GlobalId=self.gid(f"rel/material/wall/{wid}"), RelatedObjects=[wall], RelatingMaterial=usage)

        # IfcRelConnectsPathElements between every two walls that meet at a junction.
        for jid, here in sorted(at_junction.items()):
            here = [h for h in here if h[0] in self.walls]
            for i in range(len(here)):
                for j in range(i + 1, len(here)):
                    (a, at_a), (b, at_b) = here[i], here[j]
                    self.f.create_entity(
                        "IfcRelConnectsPathElements",
                        GlobalId=self.gid(f"rel/connects/{jid}/{a}/{b}"),
                        Name=jid,
                        RelatingElement=self.walls[a]["entity"],
                        RelatedElement=self.walls[b]["entity"],
                        RelatingPriorities=[],
                        RelatedPriorities=[],
                        RelatingConnectionType=at_a,
                        RelatedConnectionType=at_b,
                    )

    def build_openings(self) -> None:
        doc, der = self.doc, self.der
        types = doc.get("types") or {}
        for oid, o in entries(doc.get("openings")):
            do = der["openings"].get(oid)
            info = self.walls.get(o["wall"])
            if do is None or info is None:
                continue
            frame: Frame = info["frame"]
            elev = info["elev"]
            u0, u1 = sorted((frame.local_base(do["start"])[0], frame.local_base(do["end"])[0]))
            sill, head = mm(do["sillElevation"]) - elev, mm(do["headElevation"]) - elev
            vmin, vmax = info["vmin"], info["vmax"]
            rect = [(u0, vmin), (u1, vmin), (u1, vmax), (u0, vmax)]
            opl = self.placement(info["placement"])
            opening = self.f.create_entity(
                "IfcOpeningElement",
                GlobalId=self.gid(f"opening/{oid}"),
                Name=o.get("name") or oid,
                ObjectPlacement=opl,
                Representation=self.body("SweptSolid", [self.extrusion(rect, [], sill, head)], None),
                PredefinedType="OPENING",
            )
            self.f.create_entity("IfcRelVoidsElement", GlobalId=self.gid(f"rel/voids/{oid}"), RelatingBuildingElement=info["entity"], RelatedOpeningElement=opening)
            self.identity(opening, oid, "opening")
            self.pset(
                opening,
                "Floorspec_Opening",
                [("Wall", "IfcIdentifier", o["wall"]), ("Offset", "IfcLengthMeasure", mm(o["offset"])), ("Fill", "IfcIdentifier", o.get("fill")),
                 ("Width", "IfcPositiveLengthMeasure", mm(o["width"]) if "width" in o else None), ("Height", "IfcPositiveLengthMeasure", mm(o["height"]) if "height" in o else None),
                 ("Sill", "IfcLengthMeasure", mm(o["sill"]) if "sill" in o else None), ("Hinge", "IfcLabel", o.get("hinge")), ("Swing", "IfcLabel", o.get("swing"))],
            )
            t = types.get(o.get("fill", ""))
            if not t or t.get("kind") not in ("doorType", "windowType"):
                self.clear_opening(opening, o.get("clearOpening"))
                continue
            width, height = u1 - u0, head - sill
            thickness = vmax - vmin
            vmid = (vmin + vmax) / 2
            storey = self.storey(self.doc["walls"][o["wall"]]["level"])[0]
            if t["kind"] == "doorType":
                hand = door_hand(o.get("hinge"), o.get("swing"))
                op, user = door_operation(t.get("operation"), hand)
                left = (o.get("swing") or "right") == "left"
                origin = (u0, vmid, sill) if left else (u1, vmid, sill)
                xdir = (1.0, 0.0, 0.0) if left else (-1.0, 0.0, 0.0)
                leaf = min(DOOR_LEAF, thickness)
                panel = self.extrusion([(0.0, -leaf / 2), (width, -leaf / 2), (width, leaf / 2), (0.0, leaf / 2)], [], 0.0, height)
                fill = self.f.create_entity(
                    "IfcDoor",
                    GlobalId=self.gid(f"opening/{oid}/fill"),
                    Name=o.get("name") or t.get("name") or oid,
                    ObjectPlacement=self.placement(opl, origin, xdir),
                    Representation=self.body("SweptSolid", [panel], "door"),
                    OverallHeight=height,
                    OverallWidth=width,
                    PredefinedType="DOOR",
                    OperationType=op,
                    UserDefinedOperationType=user,
                )
            else:
                glass = min(GLAZING, thickness)
                panel = self.extrusion([(0.0, -glass / 2), (width, -glass / 2), (width, glass / 2), (0.0, glass / 2)], [], 0.0, height)
                part, _ = window_operation(t.get("operation"))
                fill = self.f.create_entity(
                    "IfcWindow",
                    GlobalId=self.gid(f"opening/{oid}/fill"),
                    Name=o.get("name") or t.get("name") or oid,
                    ObjectPlacement=self.placement(opl, (u0, vmid, sill), (1.0, 0.0, 0.0)),
                    Representation=self.body("SweptSolid", [panel], "glass"),
                    OverallHeight=height,
                    OverallWidth=width,
                    PredefinedType="WINDOW",
                    PartitioningType=part,
                )
            self.f.create_entity("IfcRelFillsElement", GlobalId=self.gid(f"rel/fills/{oid}"), RelatingOpeningElement=opening, RelatedBuildingElement=fill)
            self.contain(storey, fill)
            self.typed(self.types[o["fill"]], fill)
            self.identity(fill, oid, "opening", "fill")
            self.clear_opening(fill, o.get("clearOpening"))

    def build_separators(self) -> dict[str, Any]:
        out = {}
        junctions = self.doc.get("junctions") or {}
        for sid, s in entries(self.doc.get("separators")):
            storey, sp, _ = self.storey(s["level"])
            a, b = junctions[s["start"]]["position"], junctions[s["end"]]["position"]
            el = self.f.create_entity("IfcVirtualElement", GlobalId=self.gid(f"separator/{sid}"), Name=s.get("name") or sid, ObjectPlacement=self.placement(sp))
            self.contain(storey, el)
            self.identity(el, sid, "separator")
            self.pset(
                el,
                "Floorspec_Graph",
                [("StartJunction", "IfcIdentifier", s["start"]), ("EndJunction", "IfcIdentifier", s["end"]), ("StartX", "IfcLengthMeasure", mm(a[0])),
                 ("StartY", "IfcLengthMeasure", mm(a[1])), ("EndX", "IfcLengthMeasure", mm(b[0])), ("EndY", "IfcLengthMeasure", mm(b[1]))],
            )
            out[sid] = (el, s, mm2(a), mm2(b))
        return out

    # ---------------------------------------------------------------- rooms

    def boundary(self, space: Any, element: Any, physical: str, side: str, key: str) -> None:
        self.f.create_entity(
            "IfcRelSpaceBoundary",
            GlobalId=self.gid(f"rel/boundary/{key}"),
            RelatingSpace=space,
            RelatedBuildingElement=element,
            PhysicalOrVirtualBoundary=physical,
            InternalOrExternalBoundary=side,
        )

    def covering(self, key: str, name: str, kind: str, storey: Any, placement: Any, shape: Any, material: str | None, fid: str, fkind: str, part: str, object_type: str | None = None) -> Any:
        cov = self.f.create_entity(
            "IfcCovering", GlobalId=self.gid(key), Name=name, ObjectType=object_type, ObjectPlacement=placement, Representation=shape, PredefinedType=kind
        )
        self.contain(storey, cov)
        self.associate(self.materials.get(material or ""), cov)
        self.identity(cov, fid, fkind, part)
        return cov

    def build_rooms(self, separators: dict[str, Any]) -> None:
        doc, der = self.doc, self.der
        levels = doc.get("levels") or {}
        floors, ceilings = der.get("floors") or {}, der.get("ceilings") or {}
        by_storey: dict[str, list[Any]] = defaultdict(list)
        polys: dict[str, tuple[str, Polygon]] = {}
        for rid, r in entries(doc.get("rooms")):
            poly = der["rooms"].get(rid)
            if poly is None:
                continue
            storey, sp, elev = self.storey(r["level"])
            level = levels[r["level"]]
            rings = [[mm2(p) for p in poly["outer"]], *[[mm2(p) for p in h] for h in poly["holes"]]]
            polys[rid] = (r["level"], Polygon(rings[0], rings[1:]))
            fl, ce = floors.get(rid), ceilings.get(rid)
            z0 = (mm(fl["top"]) if fl else elev) - elev
            z1 = (mm(ce["low"]) if ce else elev + mm(level["height"])) - elev
            if z1 <= z0:
                z1 = z0 + mm(level["height"])
            name = r.get("name") or rid
            space = self.f.create_entity(
                "IfcSpace",
                GlobalId=self.gid(f"room/{rid}"),
                Name=name,
                ObjectPlacement=self.placement(sp),
                Representation=self.body("SweptSolid", [self.extrusion(rings[0], rings[1:], z0, z1)], None),
                CompositionType="ELEMENT",
                PredefinedType="EXTERNAL" if r.get("function") == "exterior" else "INTERNAL",
            )
            self.spaces[rid] = space
            by_storey[r["level"]].append(space)
            self.identity(space, rid, "room")
            self.pset(space, "Floorspec_Room", [("Function", "IfcLabel", r.get("function", "unspecified")), ("Brief", "IfcIdentifier", r.get("brief"))])
            quantities = [self.f.create_entity("IfcQuantityArea", Name="NetFloorArea", AreaValue=m2_from_base(poly["area"]))]
            if fl and ce:
                quantities.append(self.f.create_entity("IfcQuantityLength", Name="FinishCeilingHeight", LengthValue=mm(ce["low"]) - mm(fl["top"])))
            qto = self.f.create_entity("IfcElementQuantity", GlobalId=self.gid(f"qto/{rid}"), Name="Qto_SpaceBaseQuantities", Quantities=quantities)
            self.f.create_entity("IfcRelDefinesByProperties", GlobalId=self.gid(f"rel/qto/{rid}"), RelatedObjects=[space], RelatingPropertyDefinition=qto)
            if r.get("brief") in self.space_types:
                self.typed(self.space_types[r["brief"]], space)

            # The room's floor (15.1): a slab when its thickness is declared, else a covering.
            if fl:
                declared = fl["top"] > fl["bottom"]
                floor_spec = [("Offset", "IfcLengthMeasure", mm((r.get("floor") or {}).get("offset", 0))), ("Thickness", "IfcLengthMeasure", mm(fl["top"] - fl["bottom"]))]
                top = mm(fl["top"]) - elev
                if declared:
                    floor = self.f.create_entity(
                        "IfcSlab",
                        GlobalId=self.gid(f"room/{rid}/floor"),
                        Name=name,
                        ObjectPlacement=self.placement(sp),
                        Representation=self.body("SweptSolid", [self.extrusion(rings[0], rings[1:], mm(fl["bottom"]) - elev, top)], r.get("floorFinish") or "default"),
                        PredefinedType="FLOOR",
                    )
                    self.contain(storey, floor)
                    self.identity(floor, rid, "room", "floor")
                    if r.get("floorFinish"):
                        finish = self.covering(f"room/{rid}/floorFinish", f"{name} floor finish", "FLOORING", storey, None, None, r["floorFinish"], rid, "room", "floorFinish")
                        self.f.create_entity("IfcRelCoversBldgElements", GlobalId=self.gid(f"rel/covers/{rid}/floor"), RelatingBuildingElement=floor, RelatedCoverings=[finish])
                        self._space_covers[rid].append(finish)
                else:
                    shape = self.body("SurfaceModel", [self.surface_model(flat_faces(rings, top, down=False))], r.get("floorFinish") or "default")
                    floor = self.covering(f"room/{rid}/floor", name, "FLOORING", storey, self.placement(sp), shape, r.get("floorFinish"), rid, "room", "floor")
                    self._space_covers[rid].append(floor)
                self.pset(floor, "Floorspec_Floor", floor_spec)
                self.boundary(space, floor, "PHYSICAL", "NOTDEFINED", f"{rid}/floor")

            # The room's ceiling (15.2–15.5): a covering whose body is the ceiling's surface.
            if ce:
                c = r.get("ceiling") or {"kind": "flat"}
                low, high = mm(ce["low"]) - elev, mm(ce["high"]) - elev
                if c["kind"] == "tray" and ce.get("tray"):
                    centre = [[mm2(p) for p in ce["tray"]["outer"]], *[[mm2(p) for p in h] for h in ce["tray"]["holes"]]]
                    faces = tray_faces(rings, centre, low, high)
                elif c["kind"] == "vaulted":
                    base = mm(level["elevation"] + c.get("height", level.get("ceilingHeight", level["height"]))) - elev
                    faces = vault_faces(rings, [mm2(p) for p in c["ridge"]], c["pitch"]["rise"], c["pitch"]["run"], c.get("slopes", "both"), base)
                else:
                    faces = flat_faces(rings, low, down=True)
                shape = self.body("SurfaceModel", [self.surface_model(faces)], r.get("ceilingFinish") or "default")
                ceiling = self.covering(f"room/{rid}/ceiling", f"{name} ceiling", "CEILING", storey, self.placement(sp), shape, r.get("ceilingFinish"), rid, "room", "ceiling")
                self._space_covers[rid].append(ceiling)
                ridge = c.get("ridge")
                self.pset(
                    ceiling,
                    "Floorspec_Ceiling",
                    [("Form", "IfcLabel", c["kind"]), ("Height", "IfcPositiveLengthMeasure", mm(c["height"]) if "height" in c else None),
                     ("Border", "IfcPositiveLengthMeasure", mm(c["border"]) if "border" in c else None), ("Depth", "IfcPositiveLengthMeasure", mm(c["depth"]) if "depth" in c else None),
                     ("Ridge", "list", "IfcLengthMeasure", [mm(v) for p in ridge for v in p] if ridge else []),
                     ("PitchRise", "IfcInteger", c["pitch"]["rise"] if "pitch" in c else None), ("PitchRun", "IfcInteger", c["pitch"]["run"] if "pitch" in c else None),
                     ("Slopes", "IfcLabel", c.get("slopes", "both") if c["kind"] == "vaulted" else None),
                     ("Low", "IfcLengthMeasure", mm(ce["low"])), ("High", "IfcLengthMeasure", mm(ce["high"]))],
                )
            if r.get("wallFinish"):
                finish = self.covering(f"room/{rid}/wallFinish", f"{name} wall finish", "CLADDING", storey, None, None, r["wallFinish"], rid, "room", "wallFinish", "wallFinish")
                self._space_covers[rid].append(finish)

        for lid, spaces in sorted(by_storey.items()):
            self.aggregate(self.storeys[lid][0], spaces)

        # Space boundaries: the walls each room's faces face (18.6's facing rooms), and the
        # separators between rooms, found by the rooms on either side of each one's midpoint.
        faces = (der.get("finishes") or {}).get("walls") or {}
        for wid, sides in sorted(faces.items()):
            info = self.walls.get(wid)
            if info is None:
                continue
            rooms = [sides.get(s, {}).get("room") for s in ("left", "right")]
            internal = "INTERNAL" if all(rooms) else "EXTERNAL"
            for side, rid in zip(("left", "right"), rooms):
                if rid in self.spaces:
                    self.boundary(self.spaces[rid], info["entity"], "PHYSICAL", internal, f"{rid}/wall/{wid}/{side}")
        for sid, (el, s, a, b) in sorted(separators.items()):
            dx, dy = b[0] - a[0], b[1] - a[1]
            length = math.hypot(dx, dy)
            if length == 0:
                continue
            mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
            nx, ny = -dy / length, dx / length
            for side, sign in (("left", 1), ("right", -1)):
                probe = Point(mx + sign * nx, my + sign * ny)
                for rid, (lvl, poly) in sorted(polys.items()):
                    if lvl == s["level"] and poly.contains(probe):
                        self.boundary(self.spaces[rid], el, "VIRTUAL", "INTERNAL", f"{rid}/separator/{sid}/{side}")

    def build_wall_finishes(self) -> None:
        for wid, w in entries(self.doc.get("walls")):
            info = self.walls.get(wid)
            fin = w.get("finishes")
            if info is None or not fin:
                continue
            frame: Frame = info["frame"]
            storey = self.storey(w["level"])[0]
            dw = self.der["walls"][wid]
            coverings = []
            for side in ("left", "right"):
                ff = fin.get(side)
                if not ff:
                    continue
                key = "Left" if side == "left" else "Right"
                s0, s1 = frame.local_base(dw[f"start{key}"]), frame.local_base(dw[f"end{key}"])
                v = s0[1]

                def rect(u0: float, u1: float, z0: float, z1: float) -> list[tuple[float, float, float]]:
                    # Facing out of the face: +y on the left, −y on the right.
                    pts = [(u0, v, z0), (u0, v, z1), (u1, v, z1), (u1, v, z0)]
                    return pts if side == "left" else pts[::-1]

                if ff.get("material"):
                    shape = self.body("SurfaceModel", [self.surface_model([(rect(s0[0], s1[0], info["base"], info["top"]), [])])], ff["material"])
                    cov = self.covering(f"wall/{wid}/finish/{side}", f"{w.get('name') or wid} {side} face", "CLADDING", storey, self.placement(info["placement"]), shape, ff["material"], wid, "wall", f"finish:{side}")
                    self.pset(cov, "Floorspec_Finish", [("Side", "IfcLabel", side)])
                    coverings.append(cov)
                for i, reg in enumerate(ff.get("regions") or []):
                    face = rect(mm(reg["from"]), mm(reg["to"]), info["base"] + mm(reg["bottom"]), info["base"] + mm(reg["top"]))
                    shape = self.body("SurfaceModel", [self.surface_model([(face, [])])], reg["material"])
                    cov = self.covering(
                        f"wall/{wid}/finish/{side}/region/{i}", f"{w.get('name') or wid} {side} region {i + 1}", "CLADDING", storey,
                        self.placement(info["placement"]), shape, reg["material"], wid, "wall", f"finish:{side}:region:{i}", "region",
                    )
                    self.pset(
                        cov,
                        "Floorspec_Finish",
                        [("Side", "IfcLabel", side), ("From", "IfcLengthMeasure", mm(reg["from"])), ("To", "IfcLengthMeasure", mm(reg["to"])),
                         ("Bottom", "IfcLengthMeasure", mm(reg["bottom"])), ("Top", "IfcLengthMeasure", mm(reg["top"]))],
                    )
                    coverings.append(cov)
            if coverings:
                self.f.create_entity("IfcRelCoversBldgElements", GlobalId=self.gid(f"rel/covers/wall/{wid}"), RelatingBuildingElement=info["entity"], RelatedCoverings=coverings)

    # ---------------------------------------------------------------- slabs, roofs, stairs

    def build_slabs(self) -> None:
        for sid, s in entries(self.doc.get("slabs")):
            ds = (self.der.get("slabs") or {}).get(sid)
            if ds is None:
                continue
            storey, sp, elev = self.storey(s["level"])
            outline = [mm2(p) for p in ds["outline"]]
            purpose = s.get("purpose")
            slab = self.f.create_entity(
                "IfcSlab",
                GlobalId=self.gid(f"slab/{sid}"),
                Name=s.get("name") or sid,
                ObjectType=purpose,
                ObjectPlacement=self.placement(sp),
                Representation=self.body("SweptSolid", [self.extrusion(outline, [], mm(ds["bottom"]) - elev, mm(ds["top"]) - elev)], s.get("material") or "default"),
                PredefinedType="LANDING" if purpose == "landing" else "FLOOR",
            )
            self.contain(storey, slab)
            self.associate(self.materials.get(s.get("material", "")), slab)
            self.identity(slab, sid, "slab")
            self.pset(slab, "Floorspec_Slab", [("Purpose", "IfcLabel", purpose), ("Thickness", "IfcPositiveLengthMeasure", mm(s["thickness"])), ("Offset", "IfcLengthMeasure", mm(s.get("offset", 0)))])

    def build_roofs(self) -> None:
        for fid, rf in entries(self.doc.get("roofs")):
            dr = (self.der.get("roofs") or {}).get(fid)
            if dr is None:
                continue
            storey, sp, elev = self.storey(rf["level"])
            name = rf.get("name") or fid
            surface = dr.get("surface")
            roof = self.f.create_entity(
                "IfcRoof",
                GlobalId=self.gid(f"roof/{fid}"),
                Name=name,
                ObjectPlacement=self.placement(sp),
                PredefinedType=ROOF_TYPES.get(dr["kind"], "NOTDEFINED") if surface else "NOTDEFINED",
            )
            self.contain(storey, roof)
            self.identity(roof, fid, "roof")
            pitch = rf.get("pitch") or {}
            gables = sorted(int(k) for k, e in (rf.get("edges") or {}).items() if (e or {}).get("gable"))
            self.pset(
                roof,
                "Floorspec_Roof",
                [("Kind", "IfcLabel", dr["kind"]), ("PitchRise", "IfcInteger", pitch.get("rise")), ("PitchRun", "IfcInteger", pitch.get("run")),
                 ("Overhang", "IfcLengthMeasure", mm(rf.get("overhang", 0))), ("Height", "IfcLengthMeasure", mm(rf["height"]) if "height" in rf else None),
                 ("Thickness", "IfcPositiveLengthMeasure", mm(rf["thickness"]) if "thickness" in rf else None), ("Gables", "list", "IfcInteger", gables)],
            )
            thickness = mm(rf["thickness"]) if "thickness" in rf else None
            material = rf.get("material")
            pieces: list[tuple[list[tuple[float, float, float]], int | None]] = []
            if surface:
                for face in surface["faces"]:
                    pieces.append(([(x, y, z - elev) for x, y, z in (mm3(p) for p in face["polygon"])], face.get("edge")))
            else:
                eave = mm(dr["eave"]) - elev
                pieces.append(([(x, y, eave) for x, y in (mm2(p) for p in dr["outline"])], None))
            slabs = []
            for i, (ring, edge) in enumerate(pieces):
                if thickness:
                    shape = self.body("Brep", [self.brep(prism_faces(ring, thickness))], material or "default")
                else:
                    shape = self.body("SurfaceModel", [self.surface_model([(ring, [])])], material or "default")
                slab = self.f.create_entity(
                    "IfcSlab",
                    GlobalId=self.gid(f"roof/{fid}/face/{i}"),
                    Name=f"{name} face {i + 1}" if len(pieces) > 1 else name,
                    ObjectPlacement=self.placement(sp),
                    Representation=shape,
                    PredefinedType="ROOF",
                )
                self.associate(self.materials.get(material or ""), slab)
                self.identity(slab, fid, "roof", f"face:{i}")
                if edge is not None:
                    self.pset(slab, "Floorspec_RoofFace", [("Edge", "IfcInteger", edge)])
                slabs.append(slab)
            self.aggregate(roof, slabs)

    def build_stairs(self) -> None:
        for sid, st in entries(self.doc.get("stairs")):
            ds = (self.der.get("stairs") or {}).get(sid)
            if ds is None:
                continue
            storey, sp, elev = self.storey(st["level"])
            name = st.get("name") or sid
            steps = ds.get("steps")
            parts: list[Any] = []
            stair_shape = None
            if not steps:
                mn, mx = ds["box"]["min"], ds["box"]["max"]
                rect = [mm2((mn[0], mn[1])), mm2((mx[0], mn[1])), mm2((mx[0], mx[1])), mm2((mn[0], mx[1]))]
                stair_shape = self.body("SweptSolid", [self.extrusion(rect, [], mm(mn[2]) - elev, mm(mx[2]) - elev)], "stair")
            stair = self.f.create_entity(
                "IfcStair", GlobalId=self.gid(f"stair/{sid}"), Name=name, ObjectPlacement=self.placement(sp), Representation=stair_shape, PredefinedType=stair_type(st.get("form"))
            )
            self.contain(storey, stair)
            self.identity(stair, sid, "stair")
            form = st.get("form") or {"kind": "straight"}
            treads = sum(1 for s in steps or [] if not s.get("landing"))
            self.pset(
                stair,
                "Floorspec_Stair",
                [("Form", "IfcLabel", form["kind"]), ("To", "IfcIdentifier", st["to"]), ("Width", "IfcPositiveLengthMeasure", mm(st["width"])),
                 ("Tread", "IfcPositiveLengthMeasure", mm(st["tread"])), ("Risers", "IfcInteger", st.get("risers")),
                 ("MaxRiser", "IfcPositiveLengthMeasure", mm(st["maxRiser"]) if "maxRiser" in st else None),
                 ("Rotation", "IfcPlaneAngleMeasure", st.get("rotation", 0) / 1_000_000), ("PositionX", "IfcLengthMeasure", mm(st["position"][0])),
                 ("PositionY", "IfcLengthMeasure", mm(st["position"][1])), ("Turn", "IfcLabel", form.get("turn")),
                 ("RisersBeforeTurn", "IfcInteger", form.get("risersBeforeTurn")), ("Gap", "IfcLengthMeasure", mm(form["gap"]) if "gap" in form else None),
                 ("Angle", "IfcLabel", form.get("angle")), ("Winders", "IfcInteger", form.get("winders")),
                 ("Diameter", "IfcPositiveLengthMeasure", mm(form["diameter"]) if "diameter" in form else None), ("Sweep", "IfcPlaneAngleMeasure", form["sweep"] / 1_000_000 if "sweep" in form else None),
                 ("Rise", "IfcLengthMeasure", mm(ds["rise"])), ("Headroom", "IfcLengthMeasure", mm(ds["headroom"]) if "headroom" in ds else None)],
            )
            self.pset(
                stair,
                "Pset_StairCommon",
                [("NumberOfRiser", "IfcCountMeasure", ds["risers"]), ("NumberOfTreads", "IfcCountMeasure", treads if steps else max(ds["risers"] - 1, 0)),
                 ("RiserHeight", "IfcPositiveLengthMeasure", mm(ds["riserHeight"])), ("TreadLength", "IfcPositiveLengthMeasure", mm(st["tread"]))],
            )
            flights: list[list[dict]] = []
            if steps:
                pieces = [
                    {"outline": [mm2(p) for p in s["outline"]], "lo": mm(steps[k - 2]["top"] if k >= 2 else ds["bottom"]) - elev, "top": mm(s["top"]) - elev, "landing": bool(s.get("landing"))}
                    for k, s in enumerate(steps)
                ]
                current: list[dict] = []
                landings = 0
                for pc in pieces:
                    if not pc["landing"]:
                        current.append(pc)
                        continue
                    if current:
                        flights.append(current)
                        current = []
                    landings += 1
                    landing = self.f.create_entity(
                        "IfcSlab",
                        GlobalId=self.gid(f"stair/{sid}/landing/{landings}"),
                        Name=f"{name} landing {landings}",
                        ObjectPlacement=self.placement(sp),
                        Representation=self.body("SweptSolid", [self.extrusion(pc["outline"], [], pc["lo"], pc["top"])], "stair"),
                        PredefinedType="LANDING",
                    )
                    self.identity(landing, sid, "stair", f"landing:{landings}")
                    parts.append(landing)
                if current:
                    flights.append(current)
                for n, flight in enumerate(flights, start=1):
                    items = [self.extrusion(pc["outline"], [], pc["lo"], pc["top"]) for pc in flight]
                    fl = self.f.create_entity(
                        "IfcStairFlight",
                        GlobalId=self.gid(f"stair/{sid}/flight/{n}"),
                        Name=f"{name} flight {n}",
                        ObjectPlacement=self.placement(sp),
                        Representation=self.body("SweptSolid", items, "stair"),
                        NumberOfRisers=len(flight) + 1,
                        NumberOfTreads=len(flight),
                        RiserHeight=mm(ds["riserHeight"]),
                        TreadLength=mm(st["tread"]),
                        PredefinedType="STRAIGHT",
                    )
                    self.identity(fl, sid, "stair", f"flight:{n}")
                    parts.append(fl)
            handrail = st.get("handrail")
            if handrail:
                h = mm(handrail["height"])
                sides = handrail.get("sides", "both")
                for side in ("left", "right"):
                    if sides not in (side, "both"):
                        continue
                    bars = [self.brep(box_faces(p0, p1, HANDRAIL_BAR, HANDRAIL_BAR)) for p0, p1 in self.rails(flights, side, h)]
                    rail = self.f.create_entity(
                        "IfcRailing",
                        GlobalId=self.gid(f"stair/{sid}/handrail/{side}"),
                        Name=f"{name} handrail ({side})",
                        ObjectPlacement=self.placement(sp),
                        Representation=self.body("Brep", bars, "railing") if bars else None,
                        PredefinedType="HANDRAIL",
                    )
                    self.identity(rail, sid, "stair", f"handrail:{side}")
                    self.pset(rail, "Pset_RailingCommon", [("Height", "IfcPositiveLengthMeasure", h)])
                    parts.append(rail)
            self.aggregate(stair, parts)

    @staticmethod
    def rails(flights: list[list[dict]], side: str, height: float) -> list[tuple[tuple[float, float, float], tuple[float, float, float]]]:
        """Each flight's handrail on one side: a bar along its nosing line, height above it.

        A flight's direction runs from its first tread's centre to its last; the rail is inset from
        the flight's side and runs from the first tread's nosing to the last tread's back edge.
        A flight of one tread has no direction of its own, and no rail.
        """
        out = []
        for flight in flights:
            if len(flight) < 2:
                continue
            c0, c1 = centroid(flight[0]["outline"]), centroid(flight[-1]["outline"])
            dx, dy = c1[0] - c0[0], c1[1] - c0[1]
            length = math.hypot(dx, dy)
            dx, dy = dx / length, dy / length
            nx, ny = -dy, dx
            along = lambda p: p[0] * dx + p[1] * dy  # noqa: E731
            across = lambda p: p[0] * nx + p[1] * ny  # noqa: E731
            pts = [p for pc in flight for p in pc["outline"]]
            lateral = (max(across(p) for p in pts) - HANDRAIL_INSET) if side == "left" else (min(across(p) for p in pts) + HANDRAIL_INSET)
            s0 = min(along(p) for p in flight[0]["outline"])
            s_last = min(along(p) for p in flight[-1]["outline"])
            s1 = max(along(p) for p in flight[-1]["outline"])
            z0, z_last = flight[0]["top"], flight[-1]["top"]
            slope = (z_last - z0) / (s_last - s0) if s_last != s0 else 0.0

            def at(s: float) -> tuple[float, float, float]:
                return (dx * s + nx * lateral, dy * s + ny * lateral, z0 + slope * (s - s0) + height)

            out.append((at(s0), at(s1)))
        return out

    # ---------------------------------------------------------------- extension elements

    def build_extensions(self) -> None:
        fallbacks = self.der.get("fallbacks") or {}
        found = []
        for ext, data in entries(self.doc.get("extensions")):
            if not isinstance(data, dict) or not isinstance(data.get("collections"), dict):
                continue
            for coll, elements in entries(data["collections"]):
                for eid, el in entries(elements):
                    found.append((eid, ext, coll, el))
        for eid, ext, coll, el in sorted(found):
            fb = fallbacks.get(eid)
            if fb is None:
                continue
            storey, sp, elev = self.storey(fb["level"])
            host = el.get("host") or {"mode": "free"}
            wall = self.walls.get(host.get("wall", "")) if host.get("mode") == "wallFace" else None
            ring = [mm2(p) for p in fb["footprint"]]
            if wall is not None:
                frame: Frame = wall["frame"]
                ring = [frame.local(p) for p in ring]
                z0, z1 = mm(fb["bottom"]) - wall["elev"], mm(fb["top"]) - wall["elev"]
                pl = self.placement(wall["placement"])
            else:
                z0, z1 = mm(fb["bottom"]) - elev, mm(fb["top"]) - elev
                pl = self.placement(sp)
            proxy = self.f.create_entity(
                "IfcBuildingElementProxy",
                GlobalId=self.gid(f"extension/{eid}"),
                Name=el.get("name") or eid,
                ObjectType=f"{ext}:{coll}",
                ObjectPlacement=pl,
                Representation=self.body("SweptSolid", [self.extrusion(ring, [], z0, z1)], "proxy") if z1 > z0 else None,
                PredefinedType="NOTDEFINED",
            )
            container = self.spaces.get(host.get("room", "")) if host.get("mode") == "surface" else None
            self.contain(container or storey, proxy)
            if wall is not None:
                self.f.create_entity("IfcRelConnectsElements", GlobalId=self.gid(f"rel/hosts/{eid}"), RelatingElement=wall["entity"], RelatedElement=proxy)
            self.identity(proxy, eid, f"{ext}:{coll}")
            spec: list[tuple] = [("Extension", "IfcLabel", ext), ("Collection", "IfcLabel", coll), ("Mode", "IfcLabel", host.get("mode"))]
            if host.get("mode") == "wallFace":
                spec += [("Wall", "IfcIdentifier", host["wall"]), ("Side", "IfcLabel", host["side"]), ("Offset", "IfcLengthMeasure", mm(host["offset"])), ("Height", "IfcLengthMeasure", mm(host["height"]))]
            elif host.get("mode") == "surface":
                spec += [("Room", "IfcIdentifier", host["room"]), ("Surface", "IfcLabel", host["surface"])]
            elif host.get("mode") == "free" and "level" in host:
                spec += [("Level", "IfcIdentifier", host["level"])]
            self.pset(proxy, "Floorspec_Host", spec)

    # ---------------------------------------------------------------- the whole file

    def run(self) -> ifcopenshell.file:
        self.header()
        self.build_project()
        self.build_materials()
        self.build_types()
        self.build_program()
        self.build_walls()
        self.build_openings()
        separators = self.build_separators()
        self.build_rooms(separators)
        self.build_wall_finishes()
        self.build_slabs()
        self.build_roofs()
        self.build_stairs()
        self.build_extensions()
        self.flush()
        return self.f


def export(payload: Payload) -> ifcopenshell.file:
    """Write one payload's design as an IFC4 Reference View model."""
    return Exporter(payload).run()


def summary(f: ifcopenshell.file, errors: int = 0) -> dict[str, Any]:
    counts = {c: len(f.by_type(c, include_subtypes=False)) for c in SUMMARY_CLASSES}
    return {"schema": f.schema, "view": VIEW_DEFINITION.split("[", 1)[1].rstrip("]"), "entities": {k: v for k, v in counts.items() if v}, "validation": {"errors": errors}}
