"""An IFC file that came back, reconciled by Floorspec ID into Ops and a report (FLR-T-9.5, FLR-REQ-132).

The original version's payload is exported again here, in-process, and both files are read into
the same facts (``facts.py``). Every element is then compared by its ``Floorspec_Identity`` key —
(Kind, ID, Part) — and each difference becomes either a proposal (a member of a Floorspec element
and its new value), a junction observation (where a wall's ends now are), a removal, a new wall, or
a report entry saying what changed and why it was not imported.

Proposals for one member from several places in the file — a door's width from the opening's body
and from the door's ``OverallWidth`` — must agree, or the member is reported as ambiguous and left
alone. Junction observations work the same way: a junction moves when every wall that moved it puts
it in the same place; the walls that did not move it follow it, as walls sharing a junction do.

What comes out is an Ops 0.3 batch, grouped into edits (one element's changes, one junction move, one
removal) so the server can apply what applies and report what the applier refuses.
"""

from __future__ import annotations

import json
import math
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

import ifcopenshell
import numpy as np

from ..export import Exporter, effective_layers, entries, left_offset
from ..payload import Payload
from .facts import Facts, Reader, apply, is_upright, plan_angle, relative
from .values import CONVERT, IGNORED_PSETS, LAYER_FUNCTIONS, PSETS, Units, base, groups, length, mm_text

FORMAT = "floorspec-ifc-reconciliation"
VERSION = 1
UNSET = "\u0000unset"
"""A proposal to remove a member, so its default applies again."""

NAMED = {"wall", "opening", "room", "slab", "roof", "stair", "level", "building", "separator", "material", "type", "programItem"}
WALL_CLASSES = {"IfcWall", "IfcWallStandardCase", "IfcWallElementedCase"}
FILL_CLASSES = {"IfcDoor", "IfcWindow", "IfcDoorStandardCase", "IfcWindowStandardCase"}
DERIVED_PARTS = {"floor", "ceiling", "floorFinish", "wallFinish"}

# The order edits are applied in: definitions first, then the elements that use them, the junction
# graph, removals, and new walls last — drawn into the plan as it then stands.
PHASE = {"project": 0, "site": 0, "building": 0, "level": 0, "material": 1, "type": 1, "programItem": 1, "junction": 3, "remove": 4, "add": 5}


class ReconcileError(ValueError):
    """The file cannot be reconciled at all; the message says why, for a person."""


@dataclass
class Proposal:
    value: Any
    old: Any
    change: str
    source: Facts


@dataclass
class Observation:
    position: tuple[int, int]
    source: Facts
    change: str


@dataclass
class Edit:
    element: str
    kind: str
    ops: list[dict[str, Any]]
    changes: list[str]
    sources: list[Facts]
    phase: int = 2

    def view(self) -> dict[str, Any]:
        seen: list[dict[str, str]] = []
        for s in self.sources:
            ref = {"globalId": s.gid, "entity": s.cls}
            if ref not in seen:
                seen.append(ref)
        return {"element": self.element, "kind": self.kind, "changes": self.changes, "ops": self.ops, "sources": seen}


@dataclass
class Entry:
    severity: str
    """``unmapped`` (an edit that was not imported), ``ambiguous`` (one the file says two ways) or
    ``note`` (something worth knowing that needs nothing done)."""
    change: str
    reason: str
    gid: str | None = None
    entity: str | None = None
    element: str | None = None
    kind: str | None = None
    name: str | None = None

    def view(self) -> dict[str, Any]:
        return {
            "severity": self.severity,
            "globalId": self.gid,
            "entity": self.entity,
            "element": self.element,
            "kind": self.kind,
            "name": self.name,
            "change": self.change,
            "reason": self.reason,
        }


@dataclass
class Result:
    base: str
    document_hash: str | None
    edits: list[Edit]
    report: list[Entry]
    counts: dict[str, int] = field(default_factory=dict)
    file: dict[str, Any] = field(default_factory=dict)

    @property
    def batch(self) -> list[dict[str, Any]]:
        return [op for e in self.edits for op in e.ops]

    def view(self) -> dict[str, Any]:
        return {
            "format": FORMAT,
            "version": VERSION,
            "base": self.base,
            "documentHash": self.document_hash,
            "file": self.file,
            "batch": self.batch,
            "edits": [e.view() for e in self.edits],
            "report": [r.view() for r in self.report],
            "counts": self.counts,
        }


def _order(k: tuple) -> tuple:
    return (k[0], k[1], k[2] or "")


def _same(a: Any, b: Any) -> bool:
    return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


def _ring_key(ring: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """A ring as a comparable value: counter-clockwise, from its least vertex."""
    r = list(ring)
    if len(r) > 1 and r[0] == r[-1]:
        r = r[:-1]
    if not r:
        return r
    a = sum(r[i][0] * r[(i + 1) % len(r)][1] - r[(i + 1) % len(r)][0] * r[i][1] for i in range(len(r)))
    if a < 0:
        r = r[::-1]
    i = r.index(min(r))
    return r[i:] + r[:i]


class Reconciler:
    def __init__(self, payload: Payload, edited: ifcopenshell.file):
        self.p = payload
        self.doc = payload.document
        self.der = payload.derived
        self.edited = edited
        self.expected = Exporter(payload).run()
        self.E = Reader(self.expected)
        self.X = Reader(edited)
        self.ue = Units(self.E.scale, self.E.area_scale, self.E.angle_unit)
        self.ux = Units(self.X.scale, self.X.area_scale, self.X.angle_unit)
        self.report: list[Entry] = []
        self.props: dict[str, dict[str, list[Proposal]]] = defaultdict(lambda: defaultdict(list))
        self.kinds: dict[str, str] = {}
        self.obs: dict[str, list[Observation]] = defaultdict(list)
        self.removals: list[Edit] = []
        self.additions: list[Edit] = []
        self.removed: set[str] = set()
        self.skip: set[tuple[str, str, str | None]] = set()
        self.walls_z: dict[str, dict[str, tuple[float, float]]] = {"e": {}, "x": {}}

    # ------------------------------------------------------------------ helpers

    def entry(self, severity: str, change: str, reason: str, f: Facts | None = None, element: str | None = None, kind: str | None = None) -> None:
        self.report.append(
            Entry(
                severity,
                change,
                reason,
                gid=f.gid if f else None,
                entity=f.cls if f else None,
                element=element if element is not None else (f.fid if f else None),
                kind=kind if kind is not None else (f.kind if f else None),
                name=f.name if f else None,
            )
        )

    def propose(self, eid: str, kind: str, path: str, value: Any, old: Any, change: str, src: Facts) -> None:
        self.kinds.setdefault(eid, kind)
        self.props[eid][path].append(Proposal(value, old, change, src))

    def collection(self, name: str) -> dict[str, Any]:
        return self.doc.get(name) or {}

    def extension_elements(self) -> dict[str, tuple[str, str, dict]]:
        out = {}
        for ext, data in entries(self.doc.get("extensions")):
            if isinstance(data, dict) and isinstance(data.get("collections"), dict):
                for coll, els in entries(data["collections"]):
                    for eid, el in entries(els):
                        out[eid] = (ext, coll, el)
        return out

    def level_of(self, kind: str, fid: str) -> str | None:
        if kind == "opening":
            o = self.collection("openings").get(fid)
            return (self.collection("walls").get(o["wall"]) or {}).get("level") if o else None
        coll = {"wall": "walls", "room": "rooms", "slab": "slabs", "roof": "roofs", "stair": "stairs", "separator": "separators"}.get(kind)
        if coll:
            return (self.collection(coll).get(fid) or {}).get("level")
        if ":" in kind:
            fb = (self.der.get("fallbacks") or {}).get(fid)
            return fb.get("level") if fb else None
        return None

    def storey(self, side: str, level: str | None) -> np.ndarray | None:
        return (self.storeys_e if side == "e" else self.storeys_x).get(level or "")

    def rel(self, side: str, f: Facts, level: str | None) -> np.ndarray | None:
        return relative(self.storey(side, level), f.matrix)

    def type_id(self, f: Facts, reader: Reader) -> str | None:
        t = f.type_entity
        if t is None:
            return None
        return (reader.psets(t).get("Floorspec_Identity") or {}).get("ID")

    def identity_of(self, e: Any, reader: Reader) -> tuple[str | None, str | None]:
        if e is None:
            return (None, None)
        i = reader.psets(e).get("Floorspec_Identity") or {}
        return (i.get("ID"), i.get("Kind"))

    # ------------------------------------------------------------------ the whole reconciliation

    def run(self) -> Result:
        exp_all = self.E.all()
        x_all = self.X.all()
        self.exp: dict[tuple, Facts] = {f.key: f for f in exp_all if f.fid}
        by_key: dict[tuple, list[Facts]] = defaultdict(list)
        project = next((f for f in x_all if f.cls == "IfcProject"), None)
        file_hash = project.doc_hash if project else None
        if not self.edited.by_type("IfcProject"):
            raise ReconcileError("the file has no IfcProject")
        if file_hash is None:
            hashes = [f.doc_hash for f in x_all if f.doc_hash]
            file_hash = max(set(hashes), key=hashes.count) if hashes else None
        if file_hash is not None and file_hash != self.p.hash:
            self.entry("note", f"the file was exported from version {file_hash[:12]}, and is reconciled against version {self.p.hash[:12]}", "the base version was chosen for this import")
        new: list[Facts] = []
        for f in x_all:
            if not f.fid:
                new.append(f)
                continue
            if f.doc_hash and file_hash and f.doc_hash != file_hash:
                self.entry("unmapped", f"{f.cls} carries the Floorspec identity {f.fid} of another document ({f.doc_hash[:12]})", "it was copied from another export; it is not an element of this model", f)
                continue
            by_key[f.key].append(f)
        self.x: dict[tuple, Facts] = {}
        for key, fs in by_key.items():
            if len(fs) > 1:
                for f in fs:
                    self.entry("ambiguous", f"{len(fs)} entities carry the identity of {key[0]} {key[1]}" + (f" ({key[2]})" if key[2] else ""), "the element was split or copied in the other tool; Floorspec cannot tell which one is the original", f)
                self.skip.add(key)
                continue
            self.x[key] = fs[0]

        self.units()
        self.storeys_e = {f.fid: f.matrix for f in exp_all if f.kind == "level" and f.part is None and f.fid}
        self.storeys_x = {k[1]: f.matrix for k, f in self.x.items() if k[0] == "level" and k[2] is None}
        self.frames()
        for key in sorted(self.exp, key=lambda k: (k[0], k[1], k[2] or "")):
            if key in self.skip:
                continue
            e = self.exp[key]
            x = self.x.get(key)
            if x is None:
                continue
            if not self.same_class(e, x):
                self.entry("unmapped", f"{e.cls} {e.fid} became {x.cls}", "an element cannot change what it is", x)
                continue
            self.compare(key, e, x)
        self.compare_openings()
        self.deletions()
        for f in new:
            self.new_element(f)
        edits = self.assemble()
        seen: set[tuple] = set()
        report = []
        for r in self.report:
            k = (r.severity, r.element, r.kind, r.change) if r.severity == "note" else (id(r),)
            if k not in seen:
                seen.add(k)
                report.append(r)
        self.report = report
        touched = {s.gid for ed in edits for s in ed.sources} | {r.gid for r in self.report if r.gid}
        unchanged = sum(1 for k in self.exp if k in self.x and self.x[k].gid not in touched)
        counts = {
            "elements": len(self.exp),
            "unchanged": unchanged,
            "edits": len(edits),
            "ops": sum(len(e.ops) for e in edits),
            "unmapped": sum(1 for r in self.report if r.severity == "unmapped"),
            "ambiguous": sum(1 for r in self.report if r.severity == "ambiguous"),
            "notes": sum(1 for r in self.report if r.severity == "note"),
        }
        header = self.edited.header.file_name
        file = {
            "schema": self.edited.schema,
            "originatingSystem": getattr(header, "originating_system", None) or None,
            "lengthUnitMm": self.X.scale,
        }
        return Result(self.p.hash, file_hash, edits, self.report, counts, file)

    def frames(self) -> None:
        """The frame each storey's contents are compared in.

        A storey moved or rotated in plan is reported (a level has no plan position), and its
        contents are compared in whichever frame they kept: a tool that turned the storey with its
        contents leaves them unchanged relative to it; one that turned only the storey's placement
        left them where they were in the world. Whichever frame more of the storey's elements are
        unchanged in is the one the person did not mean to edit.
        """
        for lid, mx in list(self.storeys_x.items()):
            me = self.storeys_e.get(lid)
            if me is None or mx is None:
                continue
            if abs(me[0, 3] - mx[0, 3]) <= 1 / 2560 and abs(me[1, 3] - mx[1, 3]) <= 1 / 2560 and np.allclose(me[:3, :3], mx[:3, :3], atol=1e-9):
                continue
            kept = me.copy()
            kept[2, 3] = mx[2, 3]
            score = {"with": 0, "without": 0}
            for k, x in self.x.items():
                e = self.exp.get(k)
                if e is None or k[2] is not None or e.matrix is None or x.matrix is None or self.level_of(k[0], k[1]) != lid:
                    continue
                er = relative(me, e.matrix)
                score["with"] += int(np.allclose(er, relative(mx, x.matrix), atol=1 / 2560))
                score["without"] += int(np.allclose(er, relative(kept, x.matrix), atol=1 / 2560))
            if score["without"] > score["with"]:
                self.storeys_x[lid] = kept

    def units(self) -> None:
        if abs(self.X.scale - 1.0) > 1e-12:
            self.entry("note", f"the file's length unit is {self.X.scale:g} mm (the export wrote millimetres)", "every length was converted back; values are compared in base units")
        if abs(self.X.area_scale - 1.0) > 1e-12:
            self.entry("note", f"the file's area unit is {self.X.area_scale:g} m²", "areas were converted back")
        if self.X.angle_unit and "DEGREE" not in self.X.angle_unit and "DEGREE" in self.E.angle_unit:
            self.entry("note", f"the file's plane angle unit is {self.X.angle_unit}", "angles were converted back to degrees")

    @staticmethod
    def same_class(e: Facts, x: Facts) -> bool:
        if e.cls == x.cls:
            return True
        if e.cls in WALL_CLASSES and x.cls in WALL_CLASSES:
            return True
        return e.cls in FILL_CLASSES and x.cls in FILL_CLASSES

    # ------------------------------------------------------------------ one element

    def compare(self, key: tuple, e: Facts, x: Facts) -> None:
        kind, fid, part = key
        if part is None and kind == "project":
            self.compare_project(e, x)
        elif kind in NAMED and part is None:
            self.compare_name(kind, fid, e, x)
        elif ":" in kind and part is None:
            self.compare_name(kind, fid, e, x)
        self.compare_psets(kind, fid, part, e, x)
        if kind == "level" and part is None:
            self.compare_level(fid, e, x)
        elif kind == "wall" and part is None:
            self.compare_wall(fid, e, x)
        elif kind == "wall" and part and part.startswith("finish:"):
            self.compare_finish(fid, part, e, x)
        elif kind == "separator":
            self.compare_separator(fid, e, x)
        elif kind == "room":
            self.compare_room(fid, part, e, x)
        elif kind == "slab":
            self.compare_slab(fid, e, x)
        elif kind == "roof":
            self.compare_roof(fid, part, e, x)
        elif kind == "stair":
            self.compare_stair(fid, part, e, x)
        elif kind == "type":
            self.compare_type(fid, e, x)
        elif kind in ("site", "building"):
            self.compare_placement_fixed(kind, fid, e, x)
        elif ":" in kind:
            self.compare_extension(fid, e, x)
        if part is None:
            self.check_container(kind, fid, part, e, x)

    def compare_name(self, kind: str, fid: str, e: Facts, x: Facts) -> None:
        if (x.name or "") == (e.name or ""):
            return
        coll = self.element(kind, fid)
        old = coll.get("name") if coll is not None else None
        if not x.name:
            if old is not None:
                self.propose(fid, kind, "/name", UNSET, old, f"name {old!r} removed", x)
            return
        self.propose(fid, kind, "/name", x.name, old, f"name {e.name!r} → {x.name!r}", x)

    def element(self, kind: str, fid: str) -> dict | None:
        coll = {
            "wall": "walls", "opening": "openings", "room": "rooms", "slab": "slabs", "roof": "roofs", "stair": "stairs", "level": "levels",
            "building": "buildings", "separator": "separators", "material": "materials", "type": "types",
        }.get(kind)
        if coll:
            return self.collection(coll).get(fid)
        if kind == "programItem":
            return ((self.doc.get("program") or {}).get("items") or {}).get(fid)
        if ":" in kind:
            el = self.extension_elements().get(fid)
            return el[2] if el else None
        return None

    def compare_project(self, e: Facts, x: Facts) -> None:
        project = self.doc.get("project") or {}
        if (x.name or "") != (e.name or ""):
            self.propose("$project", "project", "/name", x.name or "", project.get("name"), f"project name {e.name!r} → {x.name!r}", x)
        ed, xd = getattr(e.entity, "Description", None), getattr(x.entity, "Description", None)
        if (xd or "") != (ed or ""):
            self.propose("$project", "project", "/description", xd if xd else UNSET, project.get("description"), "project description changed", x)

    # ------------------------------------------------------------------ property sets

    def compare_psets(self, kind: str, fid: str, part: str | None, e: Facts, x: Facts) -> None:
        table = PSETS.get(groups(kind, part), {})
        target, target_kind, prefix = fid, kind, ""
        if kind == "site":
            target, target_kind = "$site", "site"
        if part and ":region:" in part:
            bits = part.split(":")
            prefix = f"/finishes/{bits[1]}/regions/{bits[3]}"
        names = sorted(set(e.psets) | set(x.psets))
        e_floorspec = [n for n in e.psets if n.startswith("Floorspec_") and n not in IGNORED_PSETS]
        if e_floorspec and not any(n in x.psets for n in e_floorspec):
            self.entry("note", "the Floorspec property sets were removed", "a missing property is not an edit: nothing was changed", x)
            return
        for pname in names:
            if pname in IGNORED_PSETS:
                continue
            ep, xp = e.psets.get(pname, {}), x.psets.get(pname)
            if xp is None:
                if ep and pname.startswith("Floorspec_"):
                    self.entry("note", f"the property set {pname} was removed", "a missing property is not an edit: nothing was changed", x)
                continue
            known = table.get(pname, {})
            for prop in sorted(set(ep) | set(xp)):
                if prop not in xp:
                    if prop in ep:
                        self.entry("note", f"{pname}.{prop} was removed", "a missing property is not an edit: nothing was changed", x)
                    continue
                spec = known.get(prop)
                conv = CONVERT[spec[1]] if spec else None
                ev = ep.get(prop)
                xv = xp.get(prop)
                if conv is not None:
                    try:
                        ec = None if ev is None else conv(ev, self.ue)
                        xc = None if xv is None else conv(xv, self.ux)
                    except (TypeError, ValueError):
                        self.entry("unmapped", f"{pname}.{prop} is {xv!r}", "the value is not of the property's type", x)
                        continue
                else:
                    ec, xc = ev, xv
                    if isinstance(ev, float) and isinstance(xv, float) and abs(ev * self.E.scale - xv * self.X.scale) < 1 / 2560:
                        continue
                if _same(ec, xc):
                    continue
                if spec is None:
                    self.entry("unmapped", f"{pname}.{prop}: {ev!r} → {xv!r}", "the property is derived from the model, or read-only; change what it is derived from in Floorspec", x)
                    continue
                path = spec[0].replace("{region}", prefix)
                if xc is None:
                    self.propose(target, target_kind, path, UNSET, ec, f"{pname}.{prop} cleared", x)
                else:
                    self.propose(target, target_kind, path, xc, ec, f"{pname}.{prop}: {self.describe(spec[1], ec)} → {self.describe(spec[1], xc)}", x)

    @staticmethod
    def describe(conv: str, v: Any) -> str:
        if v is None:
            return "nothing"
        if conv == "len":
            return mm_text(v)
        if conv == "area":
            return f"{v / (1280 * 1000) ** 2:.3f} m²".replace(".000 ", " ")
        if conv == "angle":
            return f"{v / 1_000_000:g}°"
        return repr(v)

    # ------------------------------------------------------------------ levels, sites, buildings

    def compare_level(self, fid: str, e: Facts, x: Facts) -> None:
        level = self.collection("levels").get(fid) or {}
        if e.matrix is not None and x.matrix is not None:
            moved = abs(e.matrix[0, 3] - x.matrix[0, 3]) > 1 / 2560 or abs(e.matrix[1, 3] - x.matrix[1, 3]) > 1 / 2560
            turned = abs(plan_angle(e.matrix) - plan_angle(x.matrix)) > 1e-7 or not is_upright(x.matrix)
            if moved or turned:
                self.entry("unmapped", "the storey was " + ("rotated" if turned else "moved in plan"), "a Floorspec level has an elevation and nothing else: a storey moved or rotated in plan, or tilted, has no edit; its contents were compared where they kept their places", x)
        de = base(x.elevation) - base(e.elevation) if x.elevation is not None and e.elevation is not None else 0
        dz = base(x.matrix[2, 3]) - base(e.matrix[2, 3]) if x.matrix is not None and e.matrix is not None else 0
        delta = de or dz
        if de and dz and de != dz:
            self.entry("ambiguous", f"the storey's Elevation says {mm_text(base(x.elevation))} but its placement {mm_text(base(x.matrix[2, 3]))}", "the two disagree; the elevation was not changed", x)
            return
        if delta:
            old = level.get("elevation", 0)
            self.propose(fid, "level", "/elevation", old + delta, old, f"elevation {mm_text(old)} → {mm_text(old + delta)}", x)

    def compare_placement_fixed(self, kind: str, fid: str, e: Facts, x: Facts) -> None:
        if e.matrix is None or x.matrix is None:
            return
        if not np.allclose(e.matrix, x.matrix, atol=1 / 2560):
            self.entry("unmapped", f"the {kind} was moved", f"a Floorspec {kind} has no placement; move its contents instead", x)
        if kind == "site":
            for attr in ("RefLatitude", "RefLongitude", "RefElevation"):
                if getattr(e.entity, attr, None) != getattr(x.entity, attr, None):
                    self.entry("unmapped", f"the site's {attr} changed", "set the site's location in Floorspec", x)

    def check_container(self, kind: str, fid: str, part: str | None, e: Facts, x: Facts) -> None:
        if e.container is None or x.container is None or part is not None:
            return
        ef, _ = self.identity_of(e.container, self.E)
        xf, _ = self.identity_of(x.container, self.X)
        if ef != xf:
            self.entry("unmapped", f"{e.cls} moved from {e.container.Name!r} to {x.container.Name!r}", "an element's level (or room) is not changed by an edit: draw it on the other level in Floorspec", x)

    # ------------------------------------------------------------------ walls

    def wall_fills(self, wid: str) -> int:
        """How many junction fills ride in a wall's body: they are the last items (export.py)."""
        at: dict[str, list[str]] = defaultdict(list)
        for w_id, w in entries(self.doc.get("walls")):
            at[w["start"]].append(w_id)
            at[w["end"]].append(w_id)
        return sum(1 for jid in (self.der.get("junctionFills") or {}) if at.get(jid) and at[jid][0] == wid)

    def compare_wall(self, wid: str, e: Facts, x: Facts) -> None:
        w = self.collection("walls")[wid]
        level = w["level"]
        me, mx = self.rel("e", e, level), self.rel("x", x, level)
        if mx is None or me is None:
            return
        if not is_upright(mx):
            self.entry("unmapped", "the wall was tilted out of vertical", "a Floorspec wall stands vertical", x)
            return
        # The location line: where its ends are now.
        js = self.collection("junctions")
        if x.axis is not None and len(x.axis) != 2:
            self.entry("unmapped", f"the wall's axis has {len(x.axis)} points", "a Floorspec wall is straight from one junction to the next; the axis was not imported", x)
        elif e.axis is not None:
            pts = x.axis
            if pts is None:
                length_mm = math.dist(e.axis[0], e.axis[1])
                pts = [(0.0, 0.0), (length_mm, 0.0)]
                if not np.allclose(me, mx, atol=1 / 2560):
                    self.entry("note", "the wall has no Axis representation; its ends were read from its placement", "the wall's length is taken as exported", x)
            for end, p in (("start", pts[0]), ("end", pts[-1])):
                xp = apply(mx, p)
                pos = (base(xp[0]), base(xp[1]))
                jid = w[end]
                was = tuple(js[jid]["position"])
                if pos != was:
                    self.obs[jid].append(Observation(pos, x, f"wall {wid}'s {end} moved {self.vector(was, pos)}"))
        # Its body: the base and the top, read from the extrusions.
        fills = self.wall_fills(wid)
        if x.body_type != e.body_type or x.extrusions is None or e.extrusions is None:
            what = x.body_type or ("no body" if not x.body_items else ", ".join(sorted(set(x.body_items))))
            self.entry("unmapped", f"the wall's geometry representation was replaced by {what}" + (f" ({', '.join(sorted(set(x.body_items)))})" if x.body_items and x.body_type else ""), "a Floorspec wall's body is derived from its junctions, layers and heights; a body that is not vertical extrusions cannot be read back into them", x)
        elif len(x.extrusions) != len(e.extrusions):
            self.entry("unmapped", f"the wall's body has {len(x.extrusions)} extrusions instead of {len(e.extrusions)}", "the body was restructured; its heights could not be matched piece by piece", x)
        else:
            self.wall_heights(wid, w, e, x, me, mx, fills)
        self.wall_layers(wid, w, e, x)
        t_e, t_x = self.type_id(e, self.E), self.type_id(x, self.X)
        if t_x != t_e:
            if t_x is None or t_x not in self.collection("types"):
                self.entry("unmapped", f"the wall's type became {getattr(x.type_entity, 'Name', None)!r}", "the type is not one of this model's wall types", x)
            else:
                self.propose(wid, "wall", "/type", t_x, w.get("type"), f"type {t_e} → {t_x}", x)

    def wall_heights(self, wid: str, w: dict, e: Facts, x: Facts, me: np.ndarray, mx: np.ndarray, fills: int) -> None:
        dw = self.der["walls"][wid]
        elev = self.collection("levels")[w["level"]]["elevation"]
        b0, t0 = dw["baseElevation"] - elev, dw["topElevation"] - elev
        n = len(e.extrusions) - fills
        bases, tops, thick_e, thick_x = set(), set(), [], []
        for i in range(n):
            ee, xe = e.extrusions[i], x.extrusions[i]
            ez0, ez1 = base(ee.z0 + me[2, 3]), base(ee.z1 + me[2, 3])
            xz0, xz1 = base(xe.z0 + mx[2, 3]), base(xe.z1 + mx[2, 3])
            if ez0 == b0:
                bases.add(xz0)
            if ez1 == t0:
                tops.add(xz1)
            thick_e += [p[1] for p in ee.ring]
            thick_x += [p[1] for p in xe.ring]
        self.walls_z["e"][wid] = (b0, t0)
        nb, nt = b0, t0
        if len(bases) > 1 or len(tops) > 1:
            self.entry("ambiguous", "parts of the wall's body changed height and parts did not", "a Floorspec wall has one base and one top; its heights were not changed", x)
        else:
            nb = next(iter(bases), b0)
            nt = next(iter(tops), t0)
        self.walls_z["x"][wid] = (nb, nt)
        db, dt = nb - b0, nt - t0
        if db:
            b = dict(w.get("base") or {})
            old = b.get("offset", 0)
            b["offset"] = old + db
            self.propose(wid, "wall", "/base", b, w.get("base"), f"base {mm_text(dw['baseElevation'])} → {mm_text(dw['baseElevation'] + db)}", x)
        if dt or (db and "height" in (w.get("top") or {})):
            top = w.get("top")
            new_top = dw["topElevation"] + dt
            if top is None or "height" in top:
                value = {"height": new_top - (dw["baseElevation"] + db)}
            else:
                value = {**top, "offset": top.get("offset", 0) + dt}
            self.propose(wid, "wall", "/top", value, top, f"top {mm_text(dw['topElevation'])} → {mm_text(new_top)}", x)
        if thick_e and thick_x:
            te = base(max(thick_e) - min(thick_e))
            tx = base(max(thick_x) - min(thick_x))
            layers_same = e.layers is not None and x.layers is not None and [base(l.thickness) for l in e.layers.layers] == [base(l.thickness) for l in x.layers.layers]
            if te != tx and layers_same:
                self.entry("unmapped", f"the wall's body is {mm_text(tx)} thick instead of {mm_text(te)}, but its layer set is unchanged", "a wall's thickness is the sum of its layers: change the layer set (or the wall's type) instead", x)

    def layers_value(self, usage: Any, like: list[dict], f: Facts) -> list[dict] | None:
        materials = self.collection("materials")
        by_name = {(m.get("name") or mid): mid for mid, m in materials.items()}
        out = []
        for i, l in enumerate(usage.layers):
            function = l.name if l.name in LAYER_FUNCTIONS else (like[i]["function"] if i < len(like) else "core")
            layer: dict[str, Any] = {"thickness": base(l.thickness * 1.0), "function": function}
            if l.material is not None:
                mid = l.material if l.material in materials else by_name.get(l.material)
                if mid is None:
                    self.entry("unmapped", f"layer {i + 1} is of the material {l.material!r}", "the material is not one of this model's; add it in Floorspec first", f)
                    return None
                layer["material"] = mid
            out.append(layer)
        return out

    def wall_layers(self, wid: str, w: dict, e: Facts, x: Facts) -> None:
        if e.layers is None:
            return
        if x.layers is None:
            self.entry("note", "the wall's material layer set was removed", "a missing layer set is not an edit: the layers were not changed", x)
            return
        types = self.collection("types")
        own = bool(w.get("layers")) or w.get("type") not in types
        # Whether the edited wall still uses its type's layer set: the type compares that one.
        type_set = None
        tkey = ("type", w.get("type"), None)
        if tkey in self.x and self.x[tkey].layers is not None:
            type_set = self.x[tkey].layers.set_id
        uses_type = type_set is not None and x.layers.set_id == type_set
        sig = lambda u: [(base(l.thickness), l.material, l.name) for l in u.layers]  # noqa: E731
        current = effective_layers(self.doc, w) or []
        if not uses_type and (own or sig(x.layers) != sig(e.layers)):
            if sig(x.layers) != sig(e.layers):
                value = self.layers_value(x.layers, current, x)
                if value is not None:
                    self.propose(wid, "wall", "/layers", value, w.get("layers"), f"layers {self.layers_text(current)} → {self.layers_text(value)}", x)
                    current = value
        if (x.layers.sense, x.layers.direction) != (e.layers.sense, e.layers.direction):
            self.entry("unmapped", f"the layer set usage runs {x.layers.direction} {x.layers.sense}", "Floorspec layers run from the left face to the right; the direction was not imported", x)
            return
        if base(x.layers.offset) != base(e.layers.offset):
            a = base(x.layers.offset)
            found = [j for j in ("center", "exteriorFace", "interiorFace", "coreFace") if base(left_offset({**w, "justification": j}, current) / 1280) == a]
            if found:
                j = found[0]
                self.propose(wid, "wall", "/justification", j, w.get("justification", "center"), f"justification {w.get('justification', 'center')} → {j}", x)
            else:
                self.entry("unmapped", f"the layer set is offset {mm_text(a)} from the wall's axis", "no Floorspec justification puts the layers there", x)

    @staticmethod
    def layers_text(layers: list[dict]) -> str:
        return "[" + ", ".join(f"{l['function']} {mm_text(l['thickness'])}" for l in layers) + "]"

    @staticmethod
    def vector(a: tuple, b: tuple) -> str:
        dx, dy = b[0] - a[0], b[1] - a[1]
        parts = []
        if dx:
            parts.append(f"{mm_text(abs(dx))} {'east' if dx > 0 else 'west'}")
        if dy:
            parts.append(f"{mm_text(abs(dy))} {'north' if dy > 0 else 'south'}")
        return " and ".join(parts) or "nowhere"

    def compare_separator(self, sid: str, e: Facts, x: Facts) -> None:
        s = self.collection("separators")[sid]
        self.graph_observations(s, e, x, f"separator {sid}")

    def graph_observations(self, el: dict, e: Facts, x: Facts, what: str) -> None:
        eg, xg = e.psets.get("Floorspec_Graph") or {}, x.psets.get("Floorspec_Graph") or {}
        js = self.collection("junctions")
        for end, px, py in (("start", "StartX", "StartY"), ("end", "EndX", "EndY")):
            if xg.get(px) is None or xg.get(py) is None or eg.get(px) is None:
                continue
            ep = (base(eg[px] * self.E.scale), base(eg[py] * self.E.scale))
            xp = (base(xg[px] * self.X.scale), base(xg[py] * self.X.scale))
            if ep != xp:
                jid = el[end]
                self.obs[jid].append(Observation(xp, x, f"{what}'s Floorspec_Graph {end} moved {self.vector(tuple(js[jid]['position']), xp)}"))
        for prop in ("StartJunction", "EndJunction"):
            if xg.get(prop) is not None and eg.get(prop) is not None and xg[prop] != eg[prop]:
                self.entry("unmapped", f"Floorspec_Graph.{prop}: {eg[prop]!r} → {xg[prop]!r}", "which junctions an edge joins is the plan's topology; draw it again in Floorspec", x)

    def compare_finish(self, wid: str, part: str, e: Facts, x: Facts) -> None:
        bits = part.split(":")
        side = bits[1]
        if x.material != e.material and x.material is not None:
            mid = self.material_id(x.material)
            path = f"/finishes/{side}/regions/{bits[3]}/material" if len(bits) == 4 else f"/finishes/{side}/material"
            if mid is None:
                self.entry("unmapped", f"the {side} face finish became {x.material!r}", "the material is not one of this model's; add it in Floorspec first", x, element=wid)
            else:
                self.propose(wid, "wall", path, mid, e.material, f"{side} face {'region ' + str(int(bits[3]) + 1) + ' ' if len(bits) == 4 else ''}finish {e.material} → {mid}", x)

    def material_id(self, key: str) -> str | None:
        materials = self.collection("materials")
        if key in materials:
            return key
        return next((mid for mid, m in materials.items() if (m.get("name") or mid) == key), None)

    # ------------------------------------------------------------------ openings

    def compare_openings(self) -> None:
        for oid, o in entries(self.doc.get("openings")):
            ek, fk = ("opening", oid, None), ("opening", oid, "fill")
            if ek in self.skip or ek not in self.x or ek not in self.exp:
                continue
            self.compare_opening(oid, o, self.exp[ek], self.x[ek], self.exp.get(fk), self.x.get(fk) if fk not in self.skip else None)

    def opening_box(self, side: str, f: Facts, wall: Facts, level: str, wid: str) -> tuple[int, int, int, int] | None:
        mo = self.rel(side, f, level)
        mw = self.rel(side, wall, level)
        if mo is None or mw is None or f.extrusions is None or len(f.extrusions) != 1:
            return None
        m = np.linalg.inv(mw) @ mo
        ex = f.extrusions[0]
        pts = [apply(m, p, ex.z0) for p in ex.ring] + [apply(m, p, ex.z1) for p in ex.ring]
        us = [p[0] for p in pts]
        zs = [p[2] + mw[2, 3] for p in pts]
        return (base(min(us)), base(max(us)), base(min(zs)), base(max(zs)))

    def compare_opening(self, oid: str, o: dict, e: Facts, x: Facts, ef: Facts | None, xf: Facts | None) -> None:
        types = self.collection("types")
        t = types.get(o.get("fill") or "") or {}
        wid = o["wall"]
        level = self.collection("walls")[wid]["level"]
        host_x, _ = self.identity_of(x.host, self.X)
        new_wall = wid
        if host_x is not None and host_x != wid:
            if host_x in self.collection("walls"):
                new_wall = host_x
                self.propose(oid, "opening", "/wall", host_x, wid, f"moved from wall {wid} to wall {host_x}", x)
            else:
                self.entry("unmapped", f"the opening now voids {getattr(x.host, 'Name', None)!r}", "that element is not one of this model's walls", x)
                return
        we, wx = self.exp.get(("wall", wid, None)), self.x.get(("wall", new_wall, None))
        if we is None or wx is None:
            return
        if x.body_type != e.body_type or x.extrusions is None or len(x.extrusions) != 1:
            self.entry("unmapped", f"the opening's geometry representation was replaced by {x.body_type or 'nothing'}", "an opening is a box in its wall: its position and size could not be read back", x)
            box_x = None
        else:
            box_x = self.opening_box("x", x, wx, self.collection("walls")[new_wall]["level"], new_wall)
        box_e = self.opening_box("e", e, we, level, wid)
        eff_w = o.get("width", t.get("width"))
        eff_h = o.get("height", t.get("height"))
        eff_s = o.get("sill", t.get("sill", 0))
        if box_x is not None and box_e is not None:
            (eu0, eu1, ez0, ez1), (xu0, xu1, xz0, xz1) = box_e, box_x
            if xu0 != eu0 or new_wall != wid:
                self.propose(oid, "opening", "/offset", o["offset"] + (xu0 - eu0), o["offset"], f"offset {mm_text(o['offset'])} → {mm_text(o['offset'] + xu0 - eu0)}", x)
            if (xu1 - xu0) != (eu1 - eu0):
                nw = xu1 - xu0
                self.propose(oid, "opening", "/width", nw, eff_w, f"width {mm_text(eff_w)} → {mm_text(nw)}", x)
            if (xz1 - xz0) != (ez1 - ez0):
                nh = xz1 - xz0
                self.propose(oid, "opening", "/height", nh, eff_h, f"height {mm_text(eff_h)} → {mm_text(nh)}", x)
            be = self.walls_z["e"].get(wid, (None, None))[0]
            bx = self.walls_z["x"].get(new_wall, self.walls_z["e"].get(new_wall, (None, None)))[0]
            if be is not None and bx is not None and (xz0 - bx) != (ez0 - be):
                ns = eff_s + (xz0 - bx) - (ez0 - be)
                self.propose(oid, "opening", "/sill", ns, eff_s, f"sill {mm_text(eff_s)} → {mm_text(ns)}", x)
        if ef is None or xf is None:
            return
        # The door or window in it: its overall size, and its type.
        for i, (path, eff, what) in enumerate((("/width", eff_w, "OverallWidth"), ("/height", eff_h, "OverallHeight"))):
            ev, xv = ef.overall[i], xf.overall[i]
            if ev is None or xv is None or base(ev) == base(xv):
                continue
            self.propose(oid, "opening", path, base(xv), eff, f"{xf.cls} {what} {mm_text(base(ev))} → {mm_text(base(xv))}", xf)
        te, tx = self.type_id(ef, self.E), self.type_id(xf, self.X)
        if tx != te:
            if tx is None or tx not in types or types[tx].get("kind") not in ("doorType", "windowType"):
                self.entry("unmapped", f"the {xf.cls} became of type {getattr(xf.type_entity, 'Name', None)!r}", "the type is not one of this model's door or window types; add it in Floorspec first", xf, element=oid)
            else:
                self.propose(oid, "opening", "/fill", tx, o.get("fill"), f"fill {te} → {tx}", xf)
        if (xf.name or "") != (ef.name or ""):
            if xf.name:
                self.propose(oid, "opening", "/name", xf.name, o.get("name"), f"name {ef.name!r} → {xf.name!r}", xf)

    # ------------------------------------------------------------------ rooms, slabs, roofs, stairs

    def geometry_changed(self, side_level: str | None, e: Facts, x: Facts) -> bool:
        me, mx = self.rel("e", e, side_level), self.rel("x", x, side_level)
        if (me is None) != (mx is None) or (me is not None and not np.allclose(me, mx, atol=1 / 2560)):
            return True
        if e.body_items != x.body_items or e.body_type != x.body_type:
            return True
        if e.extrusions is not None and x.extrusions is not None:
            for a, b in zip(e.extrusions, x.extrusions):
                if base(a.z0) != base(b.z0) or base(a.z1) != base(b.z1) or [tuple(map(base, p)) for p in a.ring] != [tuple(map(base, p)) for p in b.ring]:
                    return True
        return False

    def compare_room(self, rid: str, part: str | None, e: Facts, x: Facts) -> None:
        r = self.collection("rooms").get(rid) or {}
        level = r.get("level")
        if part is None:
            if (x.long_name or "") != (e.long_name or ""):
                self.entry("unmapped", f"the space's LongName became {x.long_name!r}", "a room has one name, and it travels as the space's Name", x)
            te, tx = self.type_id(e, self.E), self.type_id(x, self.X)
            if tx != te:
                items = (self.doc.get("program") or {}).get("items") or {}
                if tx is None and x.type_entity is None:
                    self.propose(rid, "room", "/brief", UNSET, r.get("brief"), "brief removed", x)
                elif tx in items:
                    self.propose(rid, "room", "/brief", tx, r.get("brief"), f"brief {te} → {tx}", x)
                else:
                    self.entry("unmapped", f"the space became of type {getattr(x.type_entity, 'Name', None)!r}", "the type is not one of this model's program items", x)
            if self.geometry_changed(level, e, x):
                self.entry("note", "the space's outline or height changed", "a room's outline is derived from the walls around it: move the walls, and the room follows", x)
            return
        if part == "floor" and x.cls == "IfcSlab" and e.extrusions and x.extrusions and len(e.extrusions) == len(x.extrusions) == 1:
            me, mx = self.rel("e", e, level), self.rel("x", x, level)
            if me is None or mx is None:
                return
            et, eb = base(e.extrusions[0].z1 + me[2, 3]), base(e.extrusions[0].z0 + me[2, 3])
            xt, xb = base(x.extrusions[0].z1 + mx[2, 3]), base(x.extrusions[0].z0 + mx[2, 3])
            floor = r.get("floor") or {}
            if xt != et:
                old = floor.get("offset", 0)
                self.propose(rid, "room", "/floor/offset", old + xt - et, old, f"floor top raised {mm_text(xt - et)}" if xt > et else f"floor top lowered {mm_text(et - xt)}", x)
            if (xt - xb) != (et - eb):
                self.propose(rid, "room", "/floor/thickness", xt - xb, floor.get("thickness"), f"floor thickness {mm_text(et - eb)} → {mm_text(xt - xb)}", x)
            ering = [tuple(base(c) for c in p) for p in e.extrusions[0].ring]
            xring = [tuple(base(c) for c in p) for p in x.extrusions[0].ring]
            if _ring_key(ering) != _ring_key(xring):
                self.entry("note", "the floor slab's outline changed", "a room's floor follows the room's outline, which is derived from its walls", x)
        elif part in ("floor", "ceiling", "floorFinish", "wallFinish"):
            if self.geometry_changed(level, e, x):
                self.entry("note", f"the room's {part} geometry changed", "it is derived from the room and its properties; the change was not imported", x)
        if part in ("floorFinish", "ceiling", "wallFinish") or (part == "floor" and x.cls == "IfcCovering"):
            member = {"floorFinish": "floorFinish", "floor": "floorFinish", "ceiling": "ceilingFinish", "wallFinish": "wallFinish"}[part]
            if x.material != e.material:
                if x.material is None:
                    self.propose(rid, "room", f"/{member}", UNSET, r.get(member), f"{member} {e.material} removed", x)
                else:
                    mid = self.material_id(x.material)
                    if mid is None:
                        self.entry("unmapped", f"the room's {member} became {x.material!r}", "the material is not one of this model's; add it in Floorspec first", x)
                    else:
                        self.propose(rid, "room", f"/{member}", mid, r.get(member), f"{member} {e.material} → {mid}", x)

    def compare_slab(self, sid: str, e: Facts, x: Facts) -> None:
        s = self.collection("slabs")[sid]
        level = s["level"]
        if (x.object_type or None) != (e.object_type or None):
            self.propose(sid, "slab", "/purpose", x.object_type if x.object_type else UNSET, s.get("purpose"), f"purpose {e.object_type!r} → {x.object_type!r}", x)
        if x.material != e.material:
            mid = self.material_id(x.material) if x.material else None
            if x.material is None:
                self.propose(sid, "slab", "/material", UNSET, s.get("material"), "material removed", x)
            elif mid is None:
                self.entry("unmapped", f"the slab's material became {x.material!r}", "the material is not one of this model's; add it in Floorspec first", x)
            else:
                self.propose(sid, "slab", "/material", mid, s.get("material"), f"material {e.material} → {mid}", x)
        me, mx = self.rel("e", e, level), self.rel("x", x, level)
        if me is None or mx is None:
            return
        if x.body_type != e.body_type or x.extrusions is None or len(x.extrusions) != 1:
            self.entry("unmapped", f"the slab's geometry representation was replaced by {x.body_type or 'nothing'}", "a slab is an outline extruded by its thickness; its body could not be read back", x)
            return
        if not is_upright(mx):
            self.entry("unmapped", "the slab was tilted", "a Floorspec slab is level", x)
            return
        ee, xe = e.extrusions[0], x.extrusions[0]
        et, eb = base(ee.z1 + me[2, 3]), base(ee.z0 + me[2, 3])
        xt, xb = base(xe.z1 + mx[2, 3]), base(xe.z0 + mx[2, 3])
        if xt != et:
            old = s.get("offset", 0)
            self.propose(sid, "slab", "/offset", old + xt - et, old, f"top {mm_text(et)} → {mm_text(xt)} above the level", x)
        if (xt - xb) != (et - eb):
            self.propose(sid, "slab", "/thickness", xt - xb, s.get("thickness"), f"thickness {mm_text(et - eb)} → {mm_text(xt - xb)}", x)
        ering = [(base(p[0]), base(p[1])) for p in (apply(me, q)[:2] for q in ee.ring)]
        xring = [(base(p[0]), base(p[1])) for p in (apply(mx, q)[:2] for q in xe.ring)]
        if _ring_key(ering) != _ring_key(xring):
            self.propose(sid, "slab", "/boundary", [list(p) for p in xring], s.get("boundary"), f"outline changed ({len(ering)} → {len(xring)} vertices)", x)

    def compare_roof(self, fid: str, part: str | None, e: Facts, x: Facts) -> None:
        rf = self.collection("roofs")[fid]
        if part is not None and part.startswith("face:"):
            if x.material != e.material:
                mid = self.material_id(x.material) if x.material else None
                if mid is None:
                    self.entry("unmapped", f"a roof face's material became {x.material!r}", "the material is not one of this model's; add it in Floorspec first", x)
                else:
                    self.propose(fid, "roof", "/material", mid, rf.get("material"), f"material {e.material} → {mid}", x)
            if self.geometry_changed(rf["level"], e, x):
                self.entry("note", "a roof face's geometry changed", "a roof's faces are derived from its outline, pitch and edges; change those in Floorspec", x)

    def compare_stair(self, sid: str, part: str | None, e: Facts, x: Facts) -> None:
        st = self.collection("stairs")[sid]
        level = st["level"]
        if part is None:
            me, mx = self.rel("e", e, level), self.rel("x", x, level)
            if me is None or mx is None or np.allclose(me, mx, atol=1 / 2560):
                return
            if not is_upright(mx):
                self.entry("unmapped", "the stair was tilted", "a Floorspec stair rises vertically", x)
                return
            t = mx @ np.linalg.inv(me)
            if abs(t[2, 3]) > 1 / 2560:
                self.entry("unmapped", "the stair was moved up or down", "a stair rises from its level to the level it reaches", x)
            p = (st["position"][0] / 1280, st["position"][1] / 1280)
            q = apply(t, p)
            pos = [base(q[0]), base(q[1])]
            turn = int(round(math.degrees(math.atan2(t[1, 0], t[0, 0])) * 1_000_000))
            if pos != list(st["position"]):
                self.propose(sid, "stair", "/position", pos, st["position"], f"moved {self.vector(tuple(st['position']), tuple(pos))}", x)
            if turn:
                r = st.get("rotation", 0) + turn
                r = (r + 180_000_000) % 360_000_000 - 180_000_000
                if r == -180_000_000:
                    r = 180_000_000
                self.propose(sid, "stair", "/rotation", r, st.get("rotation", 0), f"rotated {turn / 1_000_000:g}°", x)
        elif self.geometry_changed(level, e, x):
            self.entry("note", f"the stair's {part.split(':')[0]} geometry changed", "a stair's flights, landings and handrails are derived from the stair; change the stair in Floorspec", x)

    def compare_type(self, tid: str, e: Facts, x: Facts) -> None:
        t = self.collection("types").get(tid) or {}
        if t.get("kind") != "wallType" or e.layers is None:
            return
        if x.layers is None:
            return
        sig = lambda u: [(base(l.thickness), l.material, l.name) for l in u.layers]  # noqa: E731
        if sig(x.layers) != sig(e.layers):
            value = self.layers_value(x.layers, t.get("layers") or [], x)
            if value is not None:
                users = sorted(w for w, wall in self.collection("walls").items() if wall.get("type") == tid and not wall.get("layers"))
                self.propose(tid, "type", "/layers", value, t.get("layers"), f"layers {self.layers_text(t.get('layers') or [])} → {self.layers_text(value)}" + (f" (walls {', '.join(users)})" if users else ""), x)

    def compare_extension(self, eid: str, e: Facts, x: Facts) -> None:
        if e.matrix is not None and x.matrix is not None and not np.allclose(e.matrix, x.matrix, atol=1 / 2560):
            self.entry("unmapped", "the element was moved", "an extension element is placed by its host; change its host (wall, offset, height or room) in Floorspec", x)

    # ------------------------------------------------------------------ deletions

    def deletions(self) -> None:
        missing = {k for k in self.exp if k not in self.x and k not in self.skip}
        ext = self.extension_elements()
        gone = lambda kind, i, part=None: (kind, i, part) in missing  # noqa: E731
        js = self.collection("junctions")

        def report(k: tuple, change: str, reason: str) -> None:
            self.entry("ambiguous", change, reason, self.exp[k])

        def remove(k: tuple, cascade: bool, change: str, takes: list[str]) -> None:
            kind, eid, _ = k
            if eid in self.removed:
                return
            op: dict[str, Any] = {"op": "removeElement", "id": eid}
            if cascade:
                op["cascade"] = True
            self.removals.append(Edit(eid, kind, [op], [change], [self.exp[k]], PHASE["remove"]))
            self.removed.add(eid)
            self.removed.update(takes)

        # Buildings and levels: only when everything on them went too.
        level_contents: dict[str, list[tuple]] = defaultdict(list)
        for k in self.exp:
            if k[2] is None and k[0] not in ("level", "building", "project", "site", "type", "material", "programItem"):
                lvl = self.level_of(k[0], k[1])
                if lvl:
                    level_contents[lvl].append(k)
        for k in sorted(missing, key=_order):
            kind, eid, part = k
            if kind == "building" and part is None:
                levels = [l for l, lv in self.collection("levels").items() if lv.get("building") == eid]
                left = [l for l in levels if not gone("level", l)] + [c[1] for l in levels for c in level_contents[l] if c not in missing]
                if left:
                    report(k, f"the building {eid} was deleted but {', '.join(sorted(left)[:5])} remain", "a building takes its levels with it; delete what is on it too, or keep it")
                else:
                    remove(k, True, f"building {eid} deleted, with its levels", [*levels, *(c[1] for l in levels for c in level_contents[l])])
        for k in sorted(missing, key=_order):
            kind, eid, part = k
            if kind == "level" and part is None and eid not in self.removed:
                left = [c[1] for c in level_contents[eid] if c not in missing]
                left += [s for s, st in self.collection("stairs").items() if st.get("to") == eid and not gone("stair", s)]
                if left:
                    report(k, f"the storey {eid} was deleted but {', '.join(sorted(set(left))[:5])} remain on it", "a level takes everything on it with it; Floorspec does not delete what the file still has")
                else:
                    remove(k, True, f"level {eid} deleted, with everything on it", [c[1] for c in level_contents[eid]] + [j for j, jn in js.items() if jn.get("level") == eid])
        for k in sorted(missing, key=_order):
            kind, eid, part = k
            if kind == "wall" and part is None and eid not in self.removed:
                ops = [oid for oid, o in self.collection("openings").items() if o["wall"] == eid]
                hosted = [x for x, (_, _, el) in ext.items() if (el.get("host") or {}).get("wall") == eid]
                left = [o for o in ops if not gone("opening", o) and o not in self.removed] + [h for h in hosted if not any(kk[1] == h and kk[2] is None for kk in missing)]
                if left:
                    report(k, f"the wall {eid} was deleted but {', '.join(left)} remain in it", "an opening or a hosted element belongs to its wall; delete them too, or keep the wall")
                else:
                    remove(k, bool(ops or hosted), f"wall {eid} deleted" + (f", with {', '.join(ops + hosted)}" if ops or hosted else ""), ops + hosted)
            elif kind == "room" and part is None and eid not in self.removed:
                hosted = [x for x, (_, _, el) in ext.items() if (el.get("host") or {}).get("room") == eid]
                left = [h for h in hosted if (self.exp_key(h) or ("", "", None)) not in missing]
                if left:
                    report(k, f"the space {eid} was deleted but {', '.join(left)} in it remain", "an element on a room's floor or ceiling belongs to the room")
                else:
                    remove(k, bool(hosted), f"room {eid} deleted (its walls stay; the area is no longer a named room)", hosted)
        for k in sorted(missing, key=_order):
            kind, eid, part = k
            if eid in self.removed:
                continue
            if kind == "opening":
                o = self.collection("openings").get(eid) or {}
                if part is None:
                    if ("opening", eid, "fill") in self.exp and not gone("opening", eid, "fill"):
                        report(k, f"the opening element of {eid} was deleted but its {self.x[('opening', eid, 'fill')].cls} remains", "a door or window fills an opening; delete both, or neither")
                    else:
                        remove(k, False, f"opening {eid} deleted" + (f" ({o.get('name')})" if o.get("name") else ""), [])
                elif part == "fill" and not gone("opening", eid):
                    t = self.collection("types").get(o.get("fill") or "") or {}
                    ops: list[dict[str, Any]] = []
                    for member in ("width", "height"):
                        if member not in o and member in t:
                            ops.append({"op": "setProperty", "id": eid, "path": f"/{member}", "value": t[member]})
                    if "sill" not in o and t.get("sill"):
                        ops.append({"op": "setProperty", "id": eid, "path": "/sill", "value": t["sill"]})
                    ops.append({"op": "unsetProperty", "id": eid, "path": "/fill"})
                    self.removals.append(Edit(eid, "opening", ops, [f"the {self.exp[k].cls.replace('Ifc', '').lower()} in {eid} was removed; the opening stays, empty, at its size"], [self.exp[k]], PHASE["remove"]))
            elif part is None and kind in ("slab", "roof", "stair", "separator"):
                remove(k, False, f"{kind} {eid} deleted", [])
            elif part is None and ":" in kind:
                remove(k, False, f"{kind} {eid} deleted", [])
            elif kind == "stair" and part and part.startswith("handrail:") and not gone("stair", eid):
                side = part.split(":")[1]
                other = "right" if side == "left" else "left"
                both = gone("stair", eid, f"handrail:{other}") or ("stair", eid, f"handrail:{other}") not in self.exp
                if both:
                    if any(e.element == eid and e.ops[0].get("path") == "/handrail" for e in self.removals):
                        continue
                    self.removals.append(Edit(eid, "stair", [{"op": "unsetProperty", "id": eid, "path": "/handrail"}], ["handrails removed"], [self.exp[k]], PHASE["remove"]))
                else:
                    self.removals.append(Edit(eid, "stair", [{"op": "setProperty", "id": eid, "path": "/handrail/sides", "value": other}], [f"{side} handrail removed"], [self.exp[k]], PHASE["remove"]))
            elif kind == "wall" and part and part.startswith("finish:") and not gone("wall", eid):
                bits = part.split(":")
                if len(bits) == 2:
                    self.removals.append(Edit(eid, "wall", [{"op": "unsetProperty", "id": eid, "path": f"/finishes/{bits[1]}/material"}], [f"{bits[1]} face finish removed"], [self.exp[k]], PHASE["remove"]))
                else:
                    self.entry("unmapped", f"a {bits[1]} face finish region of {eid} was deleted", "regions are addressed by their place in a list; remove it in Floorspec", self.exp[k], element=eid)
            elif kind == "room" and part in ("floorFinish", "wallFinish") and not gone("room", eid):
                self.removals.append(Edit(eid, "room", [{"op": "unsetProperty", "id": eid, "path": f"/{part}"}], [f"{part} removed"], [self.exp[k]], PHASE["remove"]))
            elif kind in ("type", "material", "programItem") and part is None:
                users = self.users_of(kind, eid)
                if users:
                    report(k, f"the {kind} {eid} was deleted but {', '.join(users[:5])} still use it", "a definition in use cannot be removed; change what uses it first")
                else:
                    remove(k, False, f"{kind} {eid} deleted", [])
            elif part is None and kind in ("project", "site"):
                self.entry("unmapped", f"the {kind} was deleted", f"a model always has its {kind}", self.exp[k], element=eid)
            elif part is not None and not gone(kind, eid):
                self.entry("unmapped", f"{self.exp[k].cls} {self.exp[k].name!r} ({part}) was deleted", "it is derived from its element, which is still there; it comes back on the next export", self.exp[k], element=eid)

    def exp_key(self, eid: str) -> tuple | None:
        return next((k for k in self.exp if k[1] == eid and k[2] is None), None)

    def users_of(self, kind: str, eid: str) -> list[str]:
        users = []
        if kind == "type":
            users += [w for w, wall in self.collection("walls").items() if wall.get("type") == eid and w not in self.removed]
            users += [o for o, op in self.collection("openings").items() if op.get("fill") == eid and o not in self.removed]
        elif kind == "material":
            for coll in ("walls", "types", "rooms", "slabs", "roofs"):
                for i, el in self.collection(coll).items():
                    if i not in self.removed and f'"{eid}"' in json.dumps(el):
                        users.append(i)
        elif kind == "programItem":
            users += [r for r, room in self.collection("rooms").items() if room.get("brief") == eid and r not in self.removed]
        return users

    # ------------------------------------------------------------------ new elements

    def new_element(self, f: Facts) -> None:
        e = f.entity
        if not (e.is_a("IfcElement") or e.is_a("IfcSpatialElement")):
            return
        if f.cls in WALL_CLASSES and self.new_wall(f):
            return
        if e.is_a("IfcOpeningElement"):
            fills = [r.RelatedBuildingElement for r in getattr(e, "HasFillings", None) or ()]
            if fills:
                return  # reported with the door or window that fills it
        self.entry("unmapped", f"a new {f.cls} {f.name!r}", "it has no Floorspec identity: it was made in the other tool. Only a straight new wall is drawn from a file; draw this in Floorspec", f, element=None, kind=None)

    def new_wall(self, f: Facts) -> bool:
        """A straight new wall: its storey, its axis, its thickness and heights — drawn with drawWall."""
        storey = f.container
        lid, lkind = self.identity_of(storey, self.X)
        if lkind != "level" or lid not in self.collection("levels"):
            return False
        ms = self.storeys_x.get(lid)
        m = relative(ms, f.matrix)
        if m is None or not is_upright(m):
            return False
        ext = f.extrusions[0] if f.extrusions and len(f.extrusions) == 1 else None
        axis = f.axis
        thickness = None
        if f.layers is not None and f.layers.layers:
            thickness = sum(l.thickness for l in f.layers.layers)
        if axis is None and ext is not None and len(ext.ring) == 4:
            xs, ys = [p[0] for p in ext.ring], [p[1] for p in ext.ring]
            if all(any(abs(p[0] - v) < 1e-6 for v in (min(xs), max(xs))) and any(abs(p[1] - v) < 1e-6 for v in (min(ys), max(ys))) for p in ext.ring):
                yc = (min(ys) + max(ys)) / 2
                axis = [(min(xs), yc), (max(xs), yc)]
                thickness = thickness or (max(ys) - min(ys))
        if axis is None or len(axis) != 2 or ext is None:
            return False
        if thickness is None:
            ys = [-(p[0] - axis[0][0]) * (axis[1][1] - axis[0][1]) + (p[1] - axis[0][1]) * (axis[1][0] - axis[0][0]) for p in ext.ring]
            span = math.dist(axis[0], axis[1])
            if span == 0:
                return False
            ys = [v / span for v in ys]
            thickness = max(ys) - min(ys)
            centre = (max(ys) + min(ys)) / 2
        else:
            centre = 0.0
            if f.layers is not None and f.layers.layers:
                total = thickness
                lo, hi = (f.layers.offset - total, f.layers.offset) if f.layers.sense == "NEGATIVE" else (f.layers.offset, f.layers.offset + total)
                centre = (lo + hi) / 2
        (ax, ay), (bx, by) = axis
        span = math.dist(axis[0], axis[1])
        if span == 0 or thickness <= 0:
            return False
        nx, ny = -(by - ay) / span, (bx - ax) / span
        a = apply(m, (ax + nx * centre, ay + ny * centre))
        b = apply(m, (bx + nx * centre, by + ny * centre))
        z0, z1 = base(ext.z0 + m[2, 3]), base(ext.z1 + m[2, 3])
        level = self.collection("levels")[lid]
        t_mm = base(thickness)
        start, s_note = self.snap((base(a[0]), base(a[1])), lid, t_mm)
        end, e_note = self.snap((base(b[0]), base(b[1])), lid, t_mm)
        op: dict[str, Any] = {"op": "drawWall", "level": lid, "from": start, "to": end}
        tid = self.type_id(f, self.X)
        types = self.collection("types")
        if tid in types and types[tid].get("kind") == "wallType":
            op["type"] = tid
        else:
            op["layers"] = [{"thickness": t_mm, "function": "core"}]
        op["justification"] = "center"
        if z0 != 0:
            op["base"] = {"offset": z0}
        if z0 != 0 or z1 != level["height"]:
            op["top"] = {"height": z1 - z0}
        if f.name:
            op["name"] = f.name
        notes = [n for n in (s_note, e_note) if n]
        self.additions.append(Edit(f.name or f.gid, "wall", [op], [f"new wall {f.name!r} on {lid}, {mm_text(t_mm)} thick" + (f" ({'; '.join(notes)})" if notes else "")], [f], PHASE["add"]))
        return True

    def snap(self, p: tuple[int, int], level: str, thickness: int) -> tuple[Any, str | None]:
        """A new wall's end, on the junction or wall it was drawn to in the other tool, within half a
        wall's thickness: a wall drawn to the face of another is meant to meet it."""
        js = {j: tuple(jn["position"]) for j, jn in self.collection("junctions").items() if jn.get("level") == level}
        for jid, obs in self.obs.items():
            if jid in js and obs:
                js[jid] = obs[0].position
        reach = thickness // 2 + 1280
        best = None
        for jid, q in sorted(js.items()):
            d = math.dist(p, q)
            if d <= reach + self.half_thickness_at(jid) and (best is None or d < best[0]):
                best = (d, jid)
        if best is not None:
            return best[1], (None if best[0] == 0 else f"an end snapped {mm_text(int(best[0]))} to junction {best[1]}")
        for wid, w in sorted(self.collection("walls").items()):
            if w["level"] != level or wid in self.removed:
                continue
            s, e = js.get(w["start"]), js.get(w["end"])
            if s is None or e is None:
                continue
            dx, dy = e[0] - s[0], e[1] - s[1]
            L2 = dx * dx + dy * dy
            if L2 == 0:
                continue
            t = ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / L2
            if not 0 < t < 1:
                continue
            q = (s[0] + t * dx, s[1] + t * dy)
            d = math.dist(p, q)
            half = self.wall_thickness(w) // 2
            if d <= half + reach:
                pt = [int(round(q[0])), int(round(q[1]))]
                return pt, (None if d == 0 else f"an end snapped {mm_text(int(d))} onto wall {wid}'s axis")
        return [p[0], p[1]], None

    def wall_thickness(self, w: dict) -> int:
        return sum(l["thickness"] for l in effective_layers(self.doc, w) or [])

    def half_thickness_at(self, jid: str) -> int:
        ts = [self.wall_thickness(w) for w in self.collection("walls").values() if jid in (w["start"], w["end"])]
        return max(ts) // 2 if ts else 0

    # ------------------------------------------------------------------ the batch

    def assemble(self) -> list[Edit]:
        edits: list[Edit] = []
        # Members.
        for eid in sorted(self.props):
            if eid in self.removed:
                continue
            kind = self.kinds[eid]
            ops: list[dict[str, Any]] = []
            changes: list[str] = []
            sources: list[Facts] = []
            paths = sorted(self.props[eid], key=lambda p: (p == "/name", p))
            target = self.target(eid, kind)
            for path in paths:
                ps = self.props[eid][path]
                values = []
                for pr in ps:
                    if not any(_same(pr.value, v) for v in values):
                        values.append(pr.value)
                if len(values) > 1:
                    for pr in ps:
                        self.entry("ambiguous", pr.change, f"the file says two things about {kind} {eid}'s {path[1:]}; it was not changed", pr.source, element=eid if not eid.startswith("$") else None, kind=kind)
                    continue
                value = values[0]
                old = ps[0].old
                if _same(value, old):
                    continue
                changes += sorted({pr.change for pr in ps})
                sources += [pr.source for pr in ps]
                if value == UNSET:
                    if old is None:
                        continue
                    ops.append({"op": "unsetProperty", "id": target, "path": path})
                elif kind == "opening" and path == "/offset" and "/wall" not in self.props[eid]:
                    delta = value - old
                    ops.append({"op": "moveOpening", "opening": eid, "by": length(delta)})
                else:
                    ops.append({"op": "setProperty", "id": target, "path": path, "value": value})
            if ops:
                edits.append(Edit(eid, kind, ops, changes, sources, PHASE.get(kind, 2)))
        edits += self.junction_edits()
        edits += self.removals
        edits += self.additions
        edits.sort(key=lambda e: e.phase)
        return edits

    def target(self, eid: str, kind: str) -> str:
        """A room by its name where that is unambiguous — it reads as the plan does — else by ID."""
        if kind != "room":
            return eid
        rooms = self.collection("rooms")
        name = (rooms.get(eid) or {}).get("name")
        if not name:
            return eid
        same = [r for r in rooms.values() if (r.get("name") or "").lower() == name.lower()]
        ids = {i.lower() for coll in ("walls", "rooms", "openings", "junctions", "levels", "slabs", "separators", "types", "materials") for i in self.collection(coll)}
        if len(same) == 1 and name.lower() not in ids and "'" not in name and name.strip() == name:
            return name
        return eid

    def junction_edits(self) -> list[Edit]:
        js = self.collection("junctions")
        moves: dict[str, tuple[int, int]] = {}
        sources: dict[str, list[Observation]] = {}
        for jid in sorted(self.obs):
            obs = self.obs[jid]
            if jid not in js:
                continue
            positions = sorted({o.position for o in obs})
            if len(positions) > 1:
                for o in obs:
                    self.entry("ambiguous", o.change, f"the walls at junction {jid} put it in {len(positions)} different places; it was not moved", o.source, element=jid, kind="junction")
                continue
            if self.removed_walls_only(jid):
                continue
            moves[jid] = positions[0]
            sources[jid] = obs
        out: list[Edit] = []
        used: set[str] = set()
        # A wall moved sideways, both ends by the same vector square to it: moveWall.
        for wid, w in sorted(self.collection("walls").items()):
            a, b = w["start"], w["end"]
            if a in used or b in used or a not in moves or b not in moves or wid in self.removed:
                continue
            sa, sb = tuple(js[a]["position"]), tuple(js[b]["position"])
            da = (moves[a][0] - sa[0], moves[a][1] - sa[1])
            db = (moves[b][0] - sb[0], moves[b][1] - sb[1])
            dx, dy = sb[0] - sa[0], sb[1] - sa[1]
            if da != db or da[0] * dx + da[1] * dy != 0:
                continue
            L = math.hypot(dx, dy)
            if L == 0:
                continue
            nx, ny = -dy / L, dx / L
            by = int(round(da[0] * nx + da[1] * ny))
            if (int(round(by * nx)), int(round(by * ny))) != da:
                continue
            used.update((a, b))
            followers = self.followers([a, b], wid)
            out.append(
                Edit(
                    wid,
                    "wall",
                    [{"op": "moveWall", "wall": wid, "by": length(by)}],
                    [f"wall {wid} moved {self.vector(sa, moves[a])}" + (f"; {', '.join(followers)} follow" if followers else "")],
                    [o.source for j in (a, b) for o in sources[j]],
                    PHASE["junction"],
                )
            )
        for jid, pos in sorted(moves.items()):
            if jid in used:
                continue
            was = tuple(js[jid]["position"])
            d = (pos[0] - was[0], pos[1] - was[1])
            if d[1] == 0 and d[0] != 0:
                to: Any = f"{length(abs(d[0]))} {'east' if d[0] > 0 else 'west'} of {jid}"
            elif d[0] == 0 and d[1] != 0:
                to = f"{length(abs(d[1]))} {'north' if d[1] > 0 else 'south'} of {jid}"
            else:
                to = [pos[0], pos[1]]
            walls = sorted({o.source.fid for o in sources[jid] if o.source.fid})
            followers = self.followers([jid], None, exclude=walls)
            out.append(
                Edit(
                    jid,
                    "junction",
                    [{"op": "moveJunction", "id": jid, "to": to}],
                    [f"junction {jid} moved {self.vector(was, pos)} (by {', '.join(walls)})" + (f"; {', '.join(followers)} follow" if followers else "")],
                    [o.source for o in sources[jid]],
                    PHASE["junction"],
                )
            )
        return out

    def removed_walls_only(self, jid: str) -> bool:
        edges = [w for coll in ("walls", "separators") for w, el in self.collection(coll).items() if jid in (el["start"], el["end"])]
        return bool(edges) and all(w in self.removed for w in edges)

    def followers(self, jids: list[str], moved: str | None, exclude: list[str] | None = None) -> list[str]:
        out = []
        for coll in ("walls", "separators"):
            for i, el in sorted(self.collection(coll).items()):
                if i == moved or i in (exclude or []) or i in self.removed:
                    continue
                if el["start"] in jids or el["end"] in jids:
                    out.append(i)
        return out


def reconcile(payload: Payload, edited: ifcopenshell.file) -> Result:
    return Reconciler(payload, edited).run()
