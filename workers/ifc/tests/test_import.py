"""FLR-T-9.5: an export edited in another tool, reconciled by Floorspec ID into Ops and a report.

Every edited file is one of our own exports changed with IfcOpenShell's authoring API (the layer
Bonsai's interface calls; ``edits.py``), written out and parsed again — the bytes an upload carries.
Each test asserts the whole batch and the whole report, so nothing extra slips in.
"""

import base64
import json
import threading
import urllib.error
import urllib.request

import ifcopenshell
import ifcopenshell.api.root
import ifcopenshell.api.type
import ifcopenshell.util.unit
import numpy as np
import pytest

from floorspec_ifc.export import export
from floorspec_ifc.importer import RequestError, parse_request, read_ifc, reconcile
from floorspec_ifc.importer.values import length
from floorspec_ifc.payload import parse
from floorspec_ifc.server import serve

from . import edits as E
from .conftest import NAMES, raw_payload


def payload(name):
    return parse(raw_payload(name))


def roundtrip(name, *changes):
    """Export a fixture, apply the edits, write the file out and read it back, and reconcile it."""
    p = payload(name)
    f = E.reparse(export(p))
    for change in changes:
        change(f)
    return reconcile(p, E.reparse(f))


def report(r, severity=None):
    return [(x.severity, x.entity, x.element, x.change) for x in r.report if severity is None or x.severity == severity]


# ---------------------------------------------------------------------------- nothing changed


@pytest.mark.parametrize("name", NAMES)
def test_an_unedited_export_reconciles_to_an_empty_batch_and_an_empty_report(name):
    r = roundtrip(name)
    assert r.batch == []
    assert r.report == []
    assert r.counts["unchanged"] == r.counts["elements"] > 40
    assert r.document_hash == r.base == payload(name).hash


def test_a_file_rewritten_in_metres_is_still_unchanged():
    p = payload("every-mapping")
    f = ifcopenshell.util.unit.convert_file_length_units(E.reparse(export(p)), "METER")
    r = reconcile(p, E.reparse(f))
    assert r.batch == []
    assert report(r) == [("note", None, None, "the file's length unit is 1000 mm (the export wrote millimetres)")]


def test_lengths_are_written_exactly_in_the_reference_grammar():
    assert length(384000) == "300mm"
    assert length(1) == "0.00078125mm"
    assert length(-128640) == "-100.5mm"


# ---------------------------------------------------------------------------- the junction graph


def test_a_wall_moved_300_mm_sideways_is_a_movewall_and_its_neighbours_follow():
    r = roundtrip("three-room-house", lambda f: E.move_wall(f, "WW", 300))
    assert r.batch == [{"op": "moveWall", "wall": "WW", "by": "300mm"}]
    assert [e.view()["changes"] for e in r.edits] == [["wall WW moved 300 mm west; WN1, WS2 follow"]]
    assert r.report == []


def test_a_wall_moved_along_itself_moves_its_junctions_by_relative_references():
    r = roundtrip("every-mapping", lambda f: E.move_product(f, "GAB", "IfcWall", 0, 250))
    assert r.batch == [
        {"op": "moveJunction", "id": "GA", "to": "250mm north of GA"},
        {"op": "moveJunction", "id": "GB", "to": "250mm north of GB"},
    ]


def test_a_diagonal_move_is_written_as_integers():
    r = roundtrip("three-room-house", lambda f: E.move_product(f, "WI1", "IfcWall", 10, 20))
    ops = {op["id"]: op["to"] for op in r.batch}
    assert ops == {"TS": [7802880 + 12800, 25600], "TM": [7802880 + 12800, 4681728 + 25600]}


def test_two_walls_that_put_one_junction_in_two_places_are_ambiguous():
    def both(f):
        E.move_product(f, "WI1", "IfcWall", 100, 0)
        E.move_product(f, "WI2", "IfcWall", 0, 100)

    r = roundtrip("three-room-house", both)
    moved = {op["id"] for op in r.batch}
    assert "TM" not in moved
    assert ("ambiguous", "IfcWall", "TM", "wall WI1's end moved 100 mm east") in report(r)


def test_a_rotated_storey_is_reported_and_its_contents_compare_unchanged():
    for turn in (E.rotate_storey, E.rotate_storey_all):
        r = roundtrip("every-mapping", lambda f: turn(f, "L2", 10))
        assert r.batch == []
        assert [(x.severity, x.entity, x.element, x.change) for x in r.report] == [("unmapped", "IfcBuildingStorey", "L2", "the storey was rotated")]


# ---------------------------------------------------------------------------- walls


def test_a_raised_wall_top_sets_its_top():
    r = roundtrip("every-mapping", lambda f: E.raise_wall_top(f, "GEF", 300))
    # The partition stops at 2700 mm (its own height); 300 mm higher is 3000 mm.
    assert r.batch == [{"op": "setProperty", "id": "GEF", "path": "/top", "value": {"height": 3840000}}]
    assert r.edits[0].changes == ["top 2700 mm → 3000 mm"]


def test_a_wall_types_layer_set_changed_sets_the_types_layers():
    def thicker(f):
        t = E.find(f, "EXT", cls="IfcWallType")
        s = next(r.RelatingMaterial for r in t.HasAssociations if r.is_a("IfcRelAssociatesMaterial"))
        s.MaterialLayers[1].LayerThickness += 50

    r = roundtrip("every-mapping", thicker)
    assert r.batch == [
        {
            "op": "setProperty",
            "id": "EXT",
            "path": "/layers",
            "value": [
                {"thickness": 32000, "function": "finish", "material": "SIDING"},
                {"thickness": 268800, "function": "core", "material": "STUD"},
                {"thickness": 19200, "function": "finish", "material": "GWB"},
            ],
        }
    ]


def test_a_body_replaced_by_a_brep_is_reported_and_nothing_is_imported_from_it():
    r = roundtrip("three-room-house", lambda f: E.brep_wall(f, "WI2"))
    assert r.batch == []
    wall = E.find(read_ifc(export(payload("three-room-house")).to_string().encode()), "WI2", cls="IfcWall")
    assert [x.view() for x in r.report] == [
        {
            "severity": "unmapped",
            "globalId": wall.GlobalId,
            "entity": "IfcWall",
            "element": "WI2",
            "kind": "wall",
            "name": "WI2",
            "change": "the wall's geometry representation was replaced by Brep (IfcFacetedBrep)",
            "reason": "a Floorspec wall's body is derived from its junctions, layers and heights; a body that is not vertical extrusions cannot be read back into them",
        }
    ]


def test_a_split_wall_is_ambiguous_and_neither_half_is_imported():
    r = roundtrip("every-mapping", lambda f: E.split_wall(f, "GAB"))
    assert r.batch == []
    assert report(r) == [("ambiguous", "IfcWall", "GAB", "2 entities carry the identity of wall GAB")] * 2


def test_a_new_wall_without_identity_is_drawn_onto_the_walls_it_meets():
    r = roundtrip("three-room-house", E.SCENARIOS["new-wall"])
    assert r.batch == [
        {
            "op": "drawWall",
            "level": "MAIN",
            "from": [7802880, 1280000],
            "to": [14045184, 1280000],
            "layers": [{"thickness": 145920, "function": "core"}],
            "justification": "center",
            "top": {"height": 3840000},
            "name": "Closet wall",
        }
    ]
    assert r.edits[0].changes == ["new wall 'Closet wall' on MAIN, 114 mm thick (an end snapped 73.15 mm onto wall WI1's axis)"]


def test_a_new_element_that_is_not_a_straight_wall_is_reported():
    def chair(f):
        ifcopenshell.api.root.create_entity(f, ifc_class="IfcFurniture", name="Armchair")

    r = roundtrip("three-room-house", chair)
    assert r.batch == []
    assert report(r) == [("unmapped", "IfcFurniture", None, "a new IfcFurniture 'Armchair'")]


# ---------------------------------------------------------------------------- openings


def test_a_wider_door_sets_its_width_once_from_both_the_door_and_its_opening():
    r = roundtrip("three-room-house", lambda f: E.change_door_width(f, "FD", 100))
    assert r.batch == [{"op": "setProperty", "id": "FD", "path": "/width", "value": 1170432 + 128000}]
    assert r.edits[0].changes == ["IfcDoor OverallWidth 914.4 mm → 1014.4 mm", "width 914.4 mm → 1014.4 mm"]
    assert r.report == []


def test_a_door_whose_overall_width_alone_changed_sets_the_width():
    r = roundtrip("three-room-house", lambda f: E.change_door_width(f, "FD", 100, opening_too=False))
    assert r.batch == [{"op": "setProperty", "id": "FD", "path": "/width", "value": 1298432}]


def test_a_door_and_its_opening_that_disagree_are_ambiguous():
    def disagree(f):
        E.change_door_width(f, "FD", 100)
        E.find(f, "FD", "fill").OverallWidth += 50

    r = roundtrip("three-room-house", disagree)
    assert r.batch == []
    assert {x.severity for x in r.report} == {"ambiguous"}
    assert len(r.report) == 2


def test_a_door_given_another_type_changes_its_fill():
    def retype(f):
        ifcopenshell.api.type.assign_type(f, related_objects=[E.find(f, "FRONT", "fill")], relating_type=E.find(f, "DI", cls="IfcDoorType"))

    r = roundtrip("every-mapping", retype)
    assert r.batch == [{"op": "setProperty", "id": "FRONT", "path": "/fill", "value": "DI"}]


def test_a_deleted_window_removes_the_opening():
    r = roundtrip("three-room-house", E.SCENARIOS["delete-window"])
    assert r.batch == [{"op": "removeElement", "id": "KW"}]
    assert r.report == []


def test_a_window_taken_out_of_its_opening_leaves_the_opening_empty_at_its_size():
    r = roundtrip("every-mapping", lambda f: ifcopenshell.api.root.remove_product(f, product=E.find(f, "GW1", "fill")))
    assert r.batch == [
        {"op": "setProperty", "id": "GW1", "path": "/width", "value": 1536000},
        {"op": "setProperty", "id": "GW1", "path": "/height", "value": 1536000},
        {"op": "setProperty", "id": "GW1", "path": "/sill", "value": 1152000},
        {"op": "unsetProperty", "id": "GW1", "path": "/fill"},
    ]


def test_a_deleted_wall_takes_its_openings_with_it():
    r = roundtrip("every-mapping", lambda f: ifcopenshell.api.root.remove_product(f, product=E.find(f, "GAB", cls="IfcWall")))
    assert r.batch == [{"op": "removeElement", "id": "GAB", "cascade": True}]


def test_a_deleted_wall_whose_window_is_still_in_the_file_is_ambiguous():
    def orphan(f):
        w = E.find(f, "GAB", cls="IfcWall")
        for rel in list(w.HasOpenings):
            f.remove(rel)
        f.remove(w)

    r = roundtrip("every-mapping", orphan)
    assert r.batch == []
    assert ("ambiguous", "IfcWall", "GAB", "the wall GAB was deleted but GW1 remain in it") in report(r)


# ---------------------------------------------------------------------------- rooms, slabs, stairs


def test_a_renamed_space_renames_the_room_by_its_name():
    r = roundtrip("three-room-house", E.SCENARIOS["rename-space"])
    assert r.batch == [{"op": "setProperty", "id": "Kitchen", "path": "/name", "value": "Kitchen and pantry"}]
    assert r.report == []


def test_a_space_whose_outline_was_dragged_is_a_note():
    r = roundtrip("three-room-house", lambda f: E.move_product(f, "KIT", "IfcSpace", 100, 0))
    assert r.batch == []
    assert report(r) == [("note", "IfcSpace", "KIT", "the space's outline or height changed")]


def test_a_thicker_slab_sets_its_thickness_and_keeps_its_top():
    r = roundtrip("every-mapping", lambda f: E.thicken_slab(f, "PATIO", 50))
    assert r.batch == [{"op": "setProperty", "id": "PATIO", "path": "/thickness", "value": 128000 + 64000}]


def test_a_raised_slab_sets_its_offset():
    def up(f):
        slab = E.find(f, "STOOP", cls="IfcSlab")
        loc = slab.Representation.Representations[0].Items[0].Position.Location
        loc.Coordinates = (loc.Coordinates[0], loc.Coordinates[1], loc.Coordinates[2] + 25)

    r = roundtrip("every-mapping", up)
    assert r.batch == [{"op": "setProperty", "id": "STOOP", "path": "/offset", "value": 32000}]


def test_a_moved_stair_sets_its_position():
    r = roundtrip("every-mapping", lambda f: E.move_product(f, "ST1", "IfcStair", 500, 0))
    st = payload("every-mapping").document["stairs"]["ST1"]
    assert r.batch == [{"op": "setProperty", "id": "ST1", "path": "/position", "value": [st["position"][0] + 640000, st["position"][1]]}]


# ---------------------------------------------------------------------------- property sets


@pytest.mark.parametrize(
    "fid,cls,pset,props,op",
    [
        ("WN", "IfcWindowType", "Floorspec_ClearOpening", {"ClearWidth": 1000.0}, {"op": "setProperty", "id": "WN", "path": "/clearOpening/width", "value": 1280000}),
        ("OAK", "IfcMaterial", "Floorspec_Material", {"Roughness": 400}, {"op": "setProperty", "id": "OAK", "path": "/roughness", "value": 400}),
        ("KIT", "IfcSpace", "Floorspec_Room", {"Function": "dining"}, {"op": "setProperty", "id": "Kitchen", "path": "/function", "value": "dining"}),
        ("L2", "IfcBuildingStorey", "Floorspec_Level", {"CeilingHeight": 2500.0}, {"op": "setProperty", "id": "L2", "path": "/ceilingHeight", "value": 3200000}),
    ],
)
def test_a_floorspec_property_edited_sets_the_member_it_carries(fid, cls, pset, props, op):
    r = roundtrip("every-mapping", lambda f: E.edit_pset(f, fid, None, pset, props, cls))
    assert r.batch == [op]
    assert r.report == []


def test_a_derived_property_edited_is_reported_not_imported():
    r = roundtrip("every-mapping", lambda f: E.edit_pset(f, "GAB", None, "Pset_WallCommon", {"IsExternal": False}, "IfcWall"))
    assert r.batch == []
    assert report(r) == [("unmapped", "IfcWall", "GAB", "Pset_WallCommon.IsExternal: True → False")]


def test_an_element_copied_from_another_export_is_reported():
    def foreign(f):
        ps = E.pset_of(E.find(f, "GAB", cls="IfcWall"), "Floorspec_Identity")
        ifcopenshell.api.pset.edit_pset(f, pset=ps, properties={"DocumentHash": "0" * 64})

    import ifcopenshell.api.pset  # noqa: F401

    r = roundtrip("every-mapping", foreign)
    assert ("unmapped", "IfcWall", "GAB", f"IfcWall carries the Floorspec identity GAB of another document ({'0' * 12})") in report(r)
    # Not reported as deleted either: it is the same wall, in a file that says it is someone else's.
    assert not [op for op in r.batch if op.get("id") == "GAB"]


# ---------------------------------------------------------------------------- the request and the server


def request_body(name, f):
    return {"format": "floorspec-ifc-import", "version": 1, "payload": raw_payload(name), "ifc": base64.b64encode(f.to_string().encode()).decode(), "name": "edited.ifc"}


def test_the_request_is_checked():
    with pytest.raises(RequestError, match="not floorspec-ifc-import"):
        parse_request({"format": "x"})
    with pytest.raises(RequestError, match="not an IFC file"):
        read_ifc(b"hello")
    with pytest.raises(RequestError, match="zipped"):
        read_ifc(b"PK\x03\x04...")


@pytest.fixture(scope="module")
def url():
    server = serve("127.0.0.1", 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()


def post(url, body):
    req = urllib.request.Request(f"{url}/import", data=json.dumps(body).encode(), method="POST", headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.load(e)


def test_post_import_answers_the_batch_and_the_report(url):
    f = E.reparse(export(payload("three-room-house")))
    E.SCENARIOS["move-wall"](f)
    E.SCENARIOS["brep-wall"](f)
    status, body = post(url, request_body("three-room-house", f))
    assert status == 200
    assert body["format"] == "floorspec-ifc-reconciliation" and body["version"] == 1
    assert body["batch"] == [{"op": "moveWall", "wall": "WW", "by": "300mm"}]
    assert body["edits"][0]["sources"][0]["entity"] == "IfcWall"
    assert [(x["severity"], x["element"]) for x in body["report"]] == [("unmapped", "WI2")]
    assert body["file"]["name"] == "edited.ifc"
    assert body["base"] == body["documentHash"] == payload("three-room-house").hash


def test_post_import_refuses_what_is_not_an_ifc_file(url):
    body = request_body("three-room-house", export(payload("three-room-house")))
    body["ifc"] = base64.b64encode(b"not a file").decode()
    status, answer = post(url, body)
    assert status == 422
    assert "not an IFC file" in answer["error"]


def test_reading_the_same_file_twice_gives_the_same_answer():
    f = E.reparse(export(payload("every-mapping")))
    E.thicken_slab(f, "PATIO", 50)
    E.move_wall(f, "GAB", 100)
    a = reconcile(payload("every-mapping"), E.reparse(f)).view()
    b = reconcile(payload("every-mapping"), E.reparse(f)).view()
    assert a == b
    assert np.isclose(a["file"]["lengthUnitMm"], 1.0)
