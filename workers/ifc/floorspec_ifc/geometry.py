"""Plan and 3D geometry for the IFC export, from what the engine derived.

Every input is in Floorspec base units (integers, 1/1280 mm) and every output in millimetres, the
file's length unit. The conversion is one division per coordinate (``v / 1280``), so an integer
coordinate becomes the double nearest its exact value in millimetres — which is what lets FLR-T-9.5
round-trip an export back to the same integers. Nothing here is normative: the normative values were
derived exactly by the engine; this module only places them in IFC's frames.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable, Sequence

from shapely.geometry import MultiPolygon, Polygon, box
from shapely.geometry.polygon import orient

BASE_PER_MM = 1280
"""Base units per millimetre (FLR-ADR-004)."""

Point2 = tuple[float, float]
Point3 = tuple[float, float, float]
Ring2 = list[Point2]
Ring3 = list[Point3]


def mm(v: float | int) -> float:
    """A length in base units, in millimetres."""
    return v / BASE_PER_MM


def mm2(p: Sequence[float | int]) -> Point2:
    return (mm(p[0]), mm(p[1]))


def mm3(p: Sequence[float | int]) -> Point3:
    return (mm(p[0]), mm(p[1]), mm(p[2]))


def m2_from_base(area: float | int | str) -> float:
    """An area in square base units (a decimal string, as the engine writes net areas), in m²."""
    return float(area) / (BASE_PER_MM * 1000) ** 2


def signed_area(ring: Sequence[Sequence[float]]) -> float:
    a = 0.0
    n = len(ring)
    for i in range(n):
        x0, y0 = ring[i][0], ring[i][1]
        x1, y1 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
        a += x0 * y1 - x1 * y0
    return a / 2


def ccw(ring: Sequence[Sequence[float]]) -> list:
    """The ring counter-clockwise seen from above."""
    r = list(ring)
    return r if signed_area(r) >= 0 else r[::-1]


def cw(ring: Sequence[Sequence[float]]) -> list:
    r = list(ring)
    return r if signed_area(r) <= 0 else r[::-1]


def dedupe(ring: Iterable[Sequence[float]], eps: float = 1e-9) -> list:
    """Drop consecutive repeats and a closing point equal to the first."""
    out: list = []
    for p in ring:
        if not out or any(abs(a - b) > eps for a, b in zip(p, out[-1])):
            out.append(tuple(p))
    while len(out) > 1 and all(abs(a - b) <= eps for a, b in zip(out[0], out[-1])):
        out.pop()
    return out


@dataclass(frozen=True)
class Frame:
    """A plan frame: an origin and a unit x direction, in millimetres; y is x turned left (CCW)."""

    ox: float
    oy: float
    dx: float
    dy: float

    @staticmethod
    def along(start: Sequence[int], end: Sequence[int]) -> "Frame":
        sx, sy = mm2(start)
        ex, ey = mm2(end)
        length = math.hypot(ex - sx, ey - sy)
        if length == 0:
            return Frame(sx, sy, 1.0, 0.0)
        return Frame(sx, sy, (ex - sx) / length, (ey - sy) / length)

    def local(self, p: Sequence[float]) -> Point2:
        """A plan point in millimetres, in this frame."""
        x, y = p[0] - self.ox, p[1] - self.oy
        return (x * self.dx + y * self.dy, -x * self.dy + y * self.dx)

    def local_base(self, p: Sequence[int]) -> Point2:
        return self.local(mm2(p))

    def world(self, u: float, v: float) -> Point2:
        return (self.ox + u * self.dx - v * self.dy, self.oy + u * self.dy + v * self.dx)


def polygons_of(geom) -> list[Polygon]:
    if geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return list(geom.geoms)
    return [g for g in getattr(geom, "geoms", []) if isinstance(g, Polygon)]


def rings_of(poly: Polygon) -> tuple[Ring2, list[Ring2]]:
    """A shapely polygon's rings, outer counter-clockwise and holes clockwise, unclosed."""
    p = orient(poly, 1.0)
    outer = dedupe(p.exterior.coords)
    holes = [dedupe(i.coords) for i in p.interiors]
    return outer, holes


@dataclass(frozen=True)
class Cut:
    """An opening through a wall, in the wall's frame: along the wall from u0 to u1, z from sill to head."""

    u0: float
    u1: float
    sill: float
    head: float


@dataclass(frozen=True)
class Piece:
    """One prism of a wall's body: a plan polygon (wall frame) extruded from z0 to z1."""

    outer: Ring2
    holes: list[Ring2]
    z0: float
    z1: float


def wall_pieces(outline: Sequence[Point2], cuts: Sequence[Cut], base: float, top: float, min_area: float = 1e-6) -> list[Piece]:
    """A wall's body with its openings already cut, as Reference View wants it.

    The wall's outline (its derived plan polygon, in its own frame, x along the wall) is cut at
    every opening's two ends by lines square to the wall — an opening's box spans the wall's whole
    thickness — and each piece is extruded over the heights no opening takes from it: from base to
    top where no opening is, and below the sill and above the head where one is. The pieces touch
    along their cut faces and never overlap, so their union is exactly the outline prism minus the
    openings' boxes.
    """
    poly = Polygon(outline)
    if not poly.is_valid:
        poly = poly.buffer(0)
    vs = [p[1] for p in outline]
    vmin, vmax = min(vs) - 1.0, max(vs) + 1.0
    us = [p[0] for p in outline]
    edges = sorted({c.u0 for c in cuts} | {c.u1 for c in cuts})
    bounds = [min(us) - 1.0, *[e for e in edges if min(us) < e < max(us)], max(us) + 1.0]
    out: list[Piece] = []
    for a, b in zip(bounds, bounds[1:]):
        if b - a <= 1e-9:
            continue
        mid = (a + b) / 2
        here = [c for c in cuts if c.u0 <= mid <= c.u1]
        spans: list[tuple[float, float]] = []
        if not here:
            spans = [(base, top)]
        else:
            c = here[0]
            spans = [(base, min(c.sill, top)), (max(c.head, base), top)]
        for g in polygons_of(poly.intersection(box(a, vmin, b, vmax))):
            if g.area <= min_area:
                continue
            outer, holes = rings_of(g)
            for z0, z1 in spans:
                if z1 - z0 > 1e-9:
                    out.append(Piece(outer, holes, z0, z1))
    return out


def prism_faces(ring: Sequence[Point3], depth: float) -> list[list[Point3]]:
    """A closed prism: a planar polygon (any slope) and the same polygon moved down by depth."""
    top = list(ring)
    if signed_area(top) < 0:
        top = top[::-1]
    bottom = [(x, y, z - depth) for x, y, z in top]
    faces: list[list[Point3]] = [top, bottom[::-1]]
    n = len(top)
    for i in range(n):
        j = (i + 1) % n
        faces.append([bottom[i], bottom[j], top[j], top[i]])
    return faces


def box_faces(p0: Point3, p1: Point3, width: float, height: float) -> list[list[Point3]]:
    """A bar from p0 to p1 (its top centre line), width wide and height deep, as a closed shell."""
    dx, dy, dz = p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]
    h = math.hypot(dx, dy)
    if h == 0:
        nx, ny = 0.0, 1.0
    else:
        nx, ny = -dy / h, dx / h
    w = width / 2

    def corners(p: Point3) -> list[Point3]:
        return [
            (p[0] - nx * w, p[1] - ny * w, p[2]),
            (p[0] + nx * w, p[1] + ny * w, p[2]),
            (p[0] + nx * w, p[1] + ny * w, p[2] - height),
            (p[0] - nx * w, p[1] - ny * w, p[2] - height),
        ]

    a, b = corners(p0), corners(p1)
    faces = [a[::-1], b]
    for i in range(4):
        j = (i + 1) % 4
        faces.append([a[i], a[j], b[j], b[i]])
    return faces


def vault_faces(rings: Sequence[Ring2], ridge: Sequence[Point2], rise: int, run: int, slopes: str, base: float) -> list[tuple[Ring3, list[Ring3]]]:
    """A vaulted ceiling (15.3), as planar faces with holes: the room polygon lifted to the vault.

    The elevation at P is base − (rise/run)·f(P), where f is P's signed distance from the ridge line
    (positive to its left, walked from its first point to its second): |f| for a vault that falls
    both ways, f for one falling to the left, −f to the right. A vault falling both ways is split
    along the ridge line so each face lies in one plane.
    """
    (ax, ay), (bx, by) = ridge
    length = math.hypot(bx - ax, by - ay)
    ux, uy = (bx - ax) / length, (by - ay) / length

    def signed(p: Point2) -> float:
        return ux * (p[1] - ay) - uy * (p[0] - ax)

    def lift(p: Point2) -> Point3:
        f = signed(p)
        g = abs(f) if slopes == "both" else (f if slopes == "left" else -f)
        return (p[0], p[1], base - rise * g / run)

    poly = Polygon(rings[0], list(rings[1:]))
    parts: list[Polygon]
    if slopes == "both":
        big = 10 * (max(abs(v) for r in rings for p in r for v in p) + length + 1.0)
        nx, ny = -uy, ux
        left = Polygon([(ax - ux * big, ay - uy * big), (ax + ux * big, ay + uy * big), (ax + ux * big + nx * big, ay + uy * big + ny * big), (ax - ux * big + nx * big, ay - uy * big + ny * big)])
        right = Polygon([(ax - ux * big, ay - uy * big), (ax - ux * big - nx * big, ay - uy * big - ny * big), (ax + ux * big - nx * big, ay + uy * big - ny * big), (ax + ux * big, ay + uy * big)])
        parts = polygons_of(poly.intersection(left)) + polygons_of(poly.intersection(right))
    else:
        parts = [poly]
    out: list[tuple[Ring3, list[Ring3]]] = []
    for g in parts:
        if g.area <= 1e-6:
            continue
        outer, holes = rings_of(g)
        # A ceiling faces down: clockwise seen from above.
        out.append(([lift(p) for p in outer[::-1]], [[lift(p) for p in h[::-1]] for h in holes]))
    return out


def tray_faces(rings: Sequence[Ring2], centre: Sequence[Ring2], low: float, high: float) -> list[tuple[Ring3, list[Ring3]]]:
    """A tray ceiling (15.4): its border at low, its raised centre at high, and the step between."""
    room = Polygon(rings[0], list(rings[1:]))
    middle = Polygon(centre[0], list(centre[1:]))
    out: list[tuple[Ring3, list[Ring3]]] = []
    for g in polygons_of(room.difference(middle)):
        outer, holes = rings_of(g)
        out.append(([(x, y, low) for x, y in outer[::-1]], [[(x, y, low) for x, y in h[::-1]] for h in holes]))
    for g in polygons_of(middle):
        outer, holes = rings_of(g)
        out.append(([(x, y, high) for x, y in outer[::-1]], [[(x, y, high) for x, y in h[::-1]] for h in holes]))
        for r in [outer, *holes]:
            for i in range(len(r)):
                p, q = r[i], r[(i + 1) % len(r)]
                out.append(([(p[0], p[1], low), (q[0], q[1], low), (q[0], q[1], high), (p[0], p[1], high)], []))
    return out


def flat_faces(rings: Sequence[Ring2], z: float, down: bool) -> list[tuple[Ring3, list[Ring3]]]:
    outer = cw(rings[0]) if down else ccw(rings[0])
    holes = [ccw(h) if down else cw(h) for h in rings[1:]]
    return [([(x, y, z) for x, y in outer], [[(x, y, z) for x, y in h] for h in holes])]


def centroid(ring: Sequence[Sequence[float]]) -> Point2:
    c = Polygon(ring).centroid
    return (c.x, c.y)


def dms(microdegrees: int) -> list[int]:
    """An angle in microdegrees as IfcCompoundPlaneAngleMeasure: degrees, minutes, seconds, millionths.

    Every component carries the angle's sign, as IFC4 requires.
    """
    sign = -1 if microdegrees < 0 else 1
    a = abs(int(microdegrees))
    # Millionths of a second: 1 microdegree is 3600/1e6 s = 3600 millionths of a second.
    total = a * 3600  # millionths of a second
    deg, rest = divmod(total, 3600 * 1_000_000)
    minutes, rest = divmod(rest, 60 * 1_000_000)
    seconds, millionths = divmod(rest, 1_000_000)
    return [sign * deg, sign * minutes, sign * seconds, sign * millionths]
