"""Health, payload checks, the annex's tables and the geometry helpers."""

import math

import pytest
from shapely.geometry import Polygon

from floorspec_ifc import health
from floorspec_ifc.geometry import Cut, dms, mm, vault_faces, wall_pieces
from floorspec_ifc.mapping import door_hand, door_operation, stair_type, window_operation
from floorspec_ifc.payload import PayloadError, parse

from .conftest import raw_payload


def test_health_reports_ok_and_the_ifcopenshell_it_runs():
    h = health()
    assert h["status"] == "ok" and h["worker"] == "ifc"
    assert h["ifcopenshell"] == "0.8.5"


@pytest.mark.parametrize(
    "change, message",
    [
        (lambda p: p.update(format="other"), "is not floorspec-ifc-payload version 1"),
        (lambda p: p.update(version=2), "is not floorspec-ifc-payload version 1"),
        (lambda p: p.update(hash="abc"), "hash"),
        (lambda p: p.update(document=[]), "the document is not an object"),
        (lambda p: p["derived"].pop("walls"), "the derived walls"),
        (lambda p: p["file"].update(name="../x.ifc"), "plain .ifc name"),
        (lambda p: p["file"].update(timestamp="yesterday"), "timestamp"),
        (lambda p: p.update(design={"OS": 3}), "the design"),
    ],
)
def test_a_payload_the_worker_does_not_read_is_refused_with_a_reason(change, message):
    p = raw_payload("three-room-house")
    change(p)
    with pytest.raises(PayloadError, match=message):
        parse(p)


def test_lengths_convert_to_the_nearest_millimetre_value_and_back_exactly():
    for v in (1, 3, 1279, 128000, 3456000, 246857, -71058900, 2**53 - 1):
        assert round(mm(v) * 1280) == v
    assert mm(1280) == 1.0


def test_latitude_and_longitude_are_degrees_minutes_seconds_and_millionths_with_one_sign():
    assert dms(42360100) == [42, 21, 36, 360000]
    assert dms(-71058900) == [-71, -3, -32, -40000]
    assert dms(0) == [0, 0, 0, 0]


@pytest.mark.parametrize(
    "hinge, swing, hand",
    [(None, None, "RIGHT"), ("start", "right", "RIGHT"), ("end", "right", "LEFT"), ("start", "left", "LEFT"), ("end", "left", "RIGHT")],
)
def test_a_doors_hand_is_seen_along_the_side_it_swings_into(hinge, swing, hand):
    assert door_hand(hinge, swing) == hand


def test_door_operations_by_annex_a():
    assert door_operation("swing", "LEFT") == ("SINGLE_SWING_LEFT", None)
    assert door_operation("doubleSwing", "RIGHT") == ("DOUBLE_DOOR_SINGLE_SWING", None)
    assert door_operation("doubleActing", "RIGHT") == ("DOUBLE_SWING_RIGHT", None)
    assert door_operation("bypassSlide", "LEFT") == ("DOUBLE_DOOR_SLIDING", None)
    assert door_operation("pocket", "LEFT") == ("SLIDING_TO_LEFT", None)
    assert door_operation("surfaceSlide", "RIGHT") == ("SLIDING_TO_RIGHT", None)
    assert door_operation("bifold", "LEFT") == ("FOLDING_TO_LEFT", None)
    assert door_operation("overhead", "LEFT") == ("USERDEFINED", "overhead")
    assert door_operation("cased", "LEFT") == ("USERDEFINED", "cased")
    assert door_operation(None, "LEFT") == ("NOTDEFINED", None)


def test_window_operations_by_annex_a_with_otheroperation_where_core_records_no_hand():
    assert window_operation("fixed") == ("SINGLE_PANEL", [("FIXEDCASEMENT", "MIDDLE")])
    assert window_operation("casement") == ("SINGLE_PANEL", [("OTHEROPERATION", "MIDDLE")])
    assert window_operation("awning") == ("SINGLE_PANEL", [("TOPHUNG", "MIDDLE")])
    assert window_operation("hopper") == ("SINGLE_PANEL", [("BOTTOMHUNG", "MIDDLE")])
    assert window_operation("singleHung") == ("DOUBLE_PANEL_HORIZONTAL", [("FIXEDCASEMENT", "TOP"), ("SLIDINGVERTICAL", "BOTTOM")])
    assert window_operation("doubleHung")[0] == "DOUBLE_PANEL_HORIZONTAL"
    assert window_operation("horizontalSlider")[0] == "DOUBLE_PANEL_VERTICAL"
    assert window_operation("tiltTurn") == ("SINGLE_PANEL", [("OTHEROPERATION", "MIDDLE")])
    assert window_operation("pivot") == ("SINGLE_PANEL", [("OTHEROPERATION", "MIDDLE")])
    assert window_operation(None) == ("NOTDEFINED", [])


def test_stair_forms_by_annex_a():
    assert stair_type(None) == "STRAIGHT_RUN_STAIR"
    assert stair_type({"kind": "lShaped"}) == "QUARTER_TURN_STAIR"
    assert stair_type({"kind": "uShaped"}) == "HALF_TURN_STAIR"
    assert stair_type({"kind": "winder", "angle": "quarter"}) == "QUARTER_WINDING_STAIR"
    assert stair_type({"kind": "winder", "angle": "half"}) == "HALF_WINDING_STAIR"
    assert stair_type({"kind": "spiral"}) == "SPIRAL_STAIR"


def test_a_walls_pieces_are_its_outline_prism_minus_its_openings():
    # A mitred 4 m wall, 200 mm thick, 2700 high; a door from 1000 to 1900 up to 2100, a window
    # from 2500 to 3700 between 900 and 2100.
    outline = [(-100.0, -100.0), (4100.0, -100.0), (3900.0, 100.0), (100.0, 100.0)]
    cuts = [Cut(1000, 1900, 0, 2100), Cut(2500, 3700, 900, 2100)]
    pieces = wall_pieces(outline, cuts, 0.0, 2700.0)
    volume = sum(Polygon(p.outer, p.holes).area * (p.z1 - p.z0) for p in pieces)
    prism = Polygon(outline).area * 2700
    assert volume == pytest.approx(prism - 900 * 200 * 2100 - 1200 * 200 * 1200)
    # Never a piece across a cut, and every piece inside the wall's heights.
    assert all(p.z0 >= 0 and p.z1 <= 2700 for p in pieces)
    door = [p for p in pieces if 1000 <= min(x for x, _ in p.outer) and max(x for x, _ in p.outer) <= 1900]
    assert [(p.z0, p.z1) for p in door] == [(2100, 2700)]


def test_a_vault_falling_both_ways_is_split_at_its_ridge_into_planar_faces():
    room = [[(0.0, 0.0), (4000.0, 0.0), (4000.0, 3000.0), (0.0, 3000.0)]]
    faces = vault_faces(room, [(2000.0, 0.0), (2000.0, 3000.0)], 4, 12, "both", 2700.0)
    assert len(faces) == 2
    zs = sorted({round(z, 6) for outer, _ in faces for _, _, z in outer})
    assert zs == [round(2700 - 2000 * 4 / 12, 6), 2700.0]
    one = vault_faces(room, [(2000.0, 0.0), (2000.0, 3000.0)], 4, 12, "left", 2700.0)
    assert len(one) == 1
    # Falling to the left of a ridge walked north: lower to the west, higher to the east.
    by_x = {round(x): z for x, _, z in one[0][0]}
    assert by_x[0] < 2700 < by_x[4000]
    assert math.isclose(by_x[0], 2700 - 2000 / 3)
