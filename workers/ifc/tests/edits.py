"""Edits another tool makes to one of our exports, made with IfcOpenShell's authoring API.

``ifcopenshell.api`` is the layer Bonsai's (BlenderBIM's) interface calls when a person moves a
wall, renames a space or deletes a window, so these are the edits an architect's tool writes —
and every edited file is written out and parsed again before it is reconciled, as an upload is.

Also a command line, for the server's integration test:

    python -m tests.edits IN.ifc OUT.ifc SCENARIO [SCENARIO ...]
"""

from __future__ import annotations

import sys
from typing import Any

import ifcopenshell
import ifcopenshell.api.geometry
import ifcopenshell.api.pset
import ifcopenshell.api.root
import ifcopenshell.api.spatial
import ifcopenshell.util.placement
import numpy as np


def ident(e: Any) -> dict:
    for rel in getattr(e, "IsDefinedBy", None) or ():
        ps = rel.RelatingPropertyDefinition
        if ps.is_a("IfcPropertySet") and ps.Name == "Floorspec_Identity":
            return {p.Name: p.NominalValue.wrappedValue for p in ps.HasProperties if p.NominalValue is not None}
    for ps in getattr(e, "HasPropertySets", None) or ():
        if ps.Name == "Floorspec_Identity":
            return {p.Name: p.NominalValue.wrappedValue for p in ps.HasProperties if p.NominalValue is not None}
    for mp in getattr(e, "HasProperties", None) or ():
        if mp.is_a("IfcMaterialProperties") and mp.Name == "Floorspec_Identity":
            return {p.Name: p.NominalValue.wrappedValue for p in mp.Properties if p.NominalValue is not None}
    return {}


def find(f: ifcopenshell.file, fid: str, part: str | None = None, cls: str = "IfcRoot") -> Any:
    for e in f.by_type(cls):
        i = ident(e)
        if i.get("ID") == fid and i.get("Part") == part:
            return e
    raise KeyError(f"{fid} ({part}) not found")


def reparse(f: ifcopenshell.file) -> ifcopenshell.file:
    return ifcopenshell.file.from_string(f.to_string())


def pset_of(e: Any, name: str) -> Any:
    for ps in getattr(e, "HasPropertySets", None) or ():
        if ps.Name == name:
            return ps
    for rel in getattr(e, "IsDefinedBy", None) or ():
        ps = rel.RelatingPropertyDefinition
        if ps.is_a("IfcPropertySet") and ps.Name == name:
            return ps
    raise KeyError(name)


# ---------------------------------------------------------------------------- the edits


def move_wall(f: ifcopenshell.file, wid: str, by_mm: float) -> None:
    """Drag a wall sideways, to its left, as a tool without wall joins does: only that wall moves."""
    wall = find(f, wid, cls="IfcWall")
    m = ifcopenshell.util.placement.get_local_placement(wall.ObjectPlacement)
    m = np.array(m)
    left = np.array([-m[1, 0], m[0, 0], 0.0])
    m[:3, 3] += left * by_mm
    ifcopenshell.api.geometry.edit_object_placement(f, product=wall, matrix=m, is_si=False)


def change_door_width(f: ifcopenshell.file, oid: str, by_mm: float, opening_too: bool = True) -> None:
    """Make a door wider: its OverallWidth, and (as Bonsai does) the opening's box."""
    door = find(f, oid, "fill")
    door.OverallWidth = door.OverallWidth + by_mm
    if opening_too:
        opening = find(f, oid, cls="IfcOpeningElement")
        solid = opening.Representation.Representations[0].Items[0]
        pts = solid.SweptArea.OuterCurve.Points
        xs = [p.Coordinates[0] for p in pts]
        hi = max(xs)
        for p in pts:
            if p.Coordinates[0] == hi:
                p.Coordinates = (p.Coordinates[0] + by_mm, p.Coordinates[1])


def rename(f: ifcopenshell.file, fid: str, name: str, cls: str = "IfcSpace") -> None:
    find(f, fid, cls=cls).Name = name


def delete_opening(f: ifcopenshell.file, oid: str) -> None:
    """Delete a window or door and the opening it fills, as deleting it in Bonsai does."""
    fill = find(f, oid, "fill")
    opening = find(f, oid, cls="IfcOpeningElement")
    ifcopenshell.api.root.remove_product(f, product=fill)
    ifcopenshell.api.root.remove_product(f, product=opening)


def thicken_slab(f: ifcopenshell.file, sid: str, by_mm: float) -> None:
    """Make a slab thicker downwards: its top stays, its bottom drops."""
    slab = find(f, sid, cls="IfcSlab")
    solid = slab.Representation.Representations[0].Items[0]
    loc = solid.Position.Location
    loc.Coordinates = (loc.Coordinates[0], loc.Coordinates[1], loc.Coordinates[2] - by_mm)
    solid.Depth = solid.Depth + by_mm


def raise_wall_top(f: ifcopenshell.file, wid: str, by_mm: float) -> None:
    """Raise a wall's top: every extrusion that reached the top now reaches higher."""
    wall = find(f, wid, cls="IfcWall")
    items = [i for r in wall.Representation.Representations if r.RepresentationIdentifier == "Body" for i in r.Items]
    top = max(i.Position.Location.Coordinates[2] + i.Depth for i in items)
    for i in items:
        if abs(i.Position.Location.Coordinates[2] + i.Depth - top) < 1e-9:
            i.Depth = i.Depth + by_mm


def add_wall(f: ifcopenshell.file, storey_id: str, start: tuple[float, float], end: tuple[float, float], thickness: float, height: float, name: str = "New wall") -> Any:
    """Draw a new wall from scratch, as another tool does: no Floorspec identity."""
    storey = find(f, storey_id, cls="IfcBuildingStorey")
    body_ctx = next(c for c in f.by_type("IfcGeometricRepresentationSubContext") if c.ContextIdentifier == "Body")
    axis_ctx = next(c for c in f.by_type("IfcGeometricRepresentationSubContext") if c.ContextIdentifier == "Axis")
    wall = ifcopenshell.api.root.create_entity(f, ifc_class="IfcWall", name=name, predefined_type="STANDARD")
    dx, dy = end[0] - start[0], end[1] - start[1]
    length = (dx * dx + dy * dy) ** 0.5
    m = np.eye(4)
    m[:3, 0] = [dx / length, dy / length, 0]
    m[:3, 1] = [-dy / length, dx / length, 0]
    m[:3, 3] = [start[0], start[1], 0]
    ifcopenshell.api.geometry.edit_object_placement(f, product=wall, matrix=m, is_si=False)
    wall.ObjectPlacement.PlacementRelTo = storey.ObjectPlacement
    ifcopenshell.api.spatial.assign_container(f, products=[wall], relating_structure=storey)
    half = thickness / 2
    ring = [(0.0, -half), (length, -half), (length, half), (0.0, half)]
    pts = [f.createIfcCartesianPoint(p) for p in ring]
    profile = f.createIfcArbitraryClosedProfileDef("AREA", None, f.createIfcPolyline([*pts, pts[0]]))
    solid = f.createIfcExtrudedAreaSolid(profile, f.createIfcAxis2Placement3D(f.createIfcCartesianPoint((0.0, 0.0, 0.0))), f.createIfcDirection((0.0, 0.0, 1.0)), height)
    axis = f.createIfcPolyline([f.createIfcCartesianPoint((0.0, 0.0)), f.createIfcCartesianPoint((length, 0.0))])
    wall.Representation = f.createIfcProductDefinitionShape(
        None,
        None,
        [f.createIfcShapeRepresentation(axis_ctx, "Axis", "Curve2D", [axis]), f.createIfcShapeRepresentation(body_ctx, "Body", "SweptSolid", [solid])],
    )
    return wall


def brep_wall(f: ifcopenshell.file, wid: str) -> None:
    """Replace a wall's body with a faceted brep of its box, as a tool that remeshes does."""
    wall = find(f, wid, cls="IfcWall")
    body = next(r for r in wall.Representation.Representations if r.RepresentationIdentifier == "Body")
    item = body.Items[0]
    ring = [p.Coordinates for p in item.SweptArea.OuterCurve.Points][:-1]
    z0 = item.Position.Location.Coordinates[2]
    z1 = z0 + item.Depth

    def face(pts: list) -> Any:
        return f.createIfcFace([f.createIfcFaceOuterBound(f.createIfcPolyLoop([f.createIfcCartesianPoint(p) for p in pts]), True)])

    faces = [face([(x, y, z0) for x, y in ring[::-1]]), face([(x, y, z1) for x, y in ring])]
    for i in range(len(ring)):
        a, b = ring[i], ring[(i + 1) % len(ring)]
        faces.append(face([(a[0], a[1], z0), (b[0], b[1], z0), (b[0], b[1], z1), (a[0], a[1], z1)]))
    body.Items = [f.createIfcFacetedBrep(f.createIfcClosedShell(faces))]
    body.RepresentationType = "Brep"


def edit_pset(f: ifcopenshell.file, fid: str, part: str | None, pset: str, props: dict, cls: str = "IfcRoot") -> None:
    e = find(f, fid, part, cls)
    if e.is_a("IfcMaterial"):
        mp = next(p for p in e.HasProperties if p.Name == pset)
        for p in mp.Properties:
            if p.Name in props:
                p.NominalValue = f.create_entity(p.NominalValue.is_a(), props[p.Name])
        return
    ifcopenshell.api.pset.edit_pset(f, pset=pset_of(e, pset), properties=props)


def rotate_storey(f: ifcopenshell.file, lid: str, degrees: float) -> None:
    storey = find(f, lid, cls="IfcBuildingStorey")
    m = np.array(ifcopenshell.util.placement.get_local_placement(storey.ObjectPlacement))
    t = np.radians(degrees)
    r = np.array([[np.cos(t), -np.sin(t), 0, 0], [np.sin(t), np.cos(t), 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]])
    ifcopenshell.api.geometry.edit_object_placement(f, product=storey, matrix=r @ m, is_si=False)


def rotate_storey_all(f: ifcopenshell.file, lid: str, degrees: float) -> None:
    """Turn a storey with everything on it: only the storey's own placement changes."""
    storey = find(f, lid, cls="IfcBuildingStorey")
    m = np.array(ifcopenshell.util.placement.get_local_placement(storey.ObjectPlacement))
    t = np.radians(degrees)
    r = np.array([[np.cos(t), -np.sin(t), 0, 0], [np.sin(t), np.cos(t), 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]])
    m = r @ m
    rel = storey.ObjectPlacement.RelativePlacement
    rel.Location.Coordinates = tuple(float(v) for v in m[:3, 3])
    rel.RefDirection = f.createIfcDirection(tuple(float(v) for v in m[:3, 0]))
    rel.Axis = f.createIfcDirection((0.0, 0.0, 1.0))


def move_product(f: ifcopenshell.file, fid: str, cls: str, dx: float, dy: float, degrees: float = 0.0) -> None:
    e = find(f, fid, cls=cls)
    m = np.array(ifcopenshell.util.placement.get_local_placement(e.ObjectPlacement))
    t = np.radians(degrees)
    r = np.array([[np.cos(t), -np.sin(t), 0, 0], [np.sin(t), np.cos(t), 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]])
    m = r @ m
    m[0, 3] += dx
    m[1, 3] += dy
    ifcopenshell.api.geometry.edit_object_placement(f, product=e, matrix=m, is_si=False)


def split_wall(f: ifcopenshell.file, wid: str) -> Any:
    """A wall cut in two, the copy keeping the original's property sets (as copying in a tool does)."""
    wall = find(f, wid, cls="IfcWall")
    copy = ifcopenshell.api.root.copy_class(f, product=wall)
    return copy


SCENARIOS = {
    "move-wall": lambda f: move_wall(f, "WW", 300),
    "door-width": lambda f: change_door_width(f, "FD", 100),
    "rename-space": lambda f: rename(f, "KIT", "Kitchen and pantry"),
    "delete-window": lambda f: delete_opening(f, "KW"),
    # From the face of the partition WI1 (x = 6096 mm, 146.3 mm thick) to the east wall's axis, 1 m
    # north of the south wall: clear of the bedroom's door and window.
    "new-wall": lambda f: add_wall(f, "MAIN", (6096 + 73.152, 1000), (10972.8, 1000), 114, 3000, "Closet wall"),
    "brep-wall": lambda f: brep_wall(f, "WI2"),
}


def main(argv: list[str]) -> int:
    src, out, *names = argv
    f = ifcopenshell.open(src)
    for n in names:
        SCENARIOS[n](f)
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(f.to_string())
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
