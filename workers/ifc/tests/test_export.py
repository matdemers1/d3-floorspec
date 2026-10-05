"""The exported files: valid IFC4, Annex A's classes and relationships, Floorspec IDs, geometry.

Four payloads, committed in fixtures/ and kept equal to what the engine derives by the Node test
apps/worker/test/ifc.test.ts: the three-room house, the two-storey house with an L stair and a hip
roof, the P5 systems demo (four official extensions) and every-mapping, which has one of each
thing Annex A maps.
"""

import json
import math
from collections import Counter

import ifcopenshell
import ifcopenshell.util.element as elements
import ifcopenshell.util.unit as units
import pytest

from floorspec_ifc.check import boxes, problems
from floorspec_ifc.export import export
from floorspec_ifc.geometry import mm
from floorspec_ifc.mapping import door_hand
from floorspec_ifc.payload import parse

from .conftest import NAMES, raw_payload

TOL = 0.01  # millimetres: the kernel works in doubles; the engine's values are exact


def identity(e):
    return elements.get_pset(e, "Floorspec_Identity") or {}


def by_id(f, kind, part=None):
    out = {}
    for e in f.by_type("IfcRoot"):
        i = identity(e)
        if i.get("Kind") == kind and i.get("Part") == part:
            out[i["ID"]] = e
    return out


@pytest.mark.parametrize("name", NAMES)
def test_the_file_is_ifc4_reference_view_with_no_schema_or_rule_errors(exported, name):
    p, f = exported[name]
    assert f.schema == "IFC4"
    assert f.header.file_description.description == ("ViewDefinition [ReferenceView_V1.2]",)
    assert f.header.file_name.name == p.name
    assert f.header.file_name.time_stamp == p.timestamp
    assert problems(f) == []
    assert problems(f, express_rules=True) == []


@pytest.mark.parametrize("name", NAMES)
def test_the_same_payload_gives_the_same_bytes(exported, name):
    p, f = exported[name]
    assert export(parse(raw_payload(name))).to_string() == f.to_string()


@pytest.mark.parametrize("name", NAMES)
def test_every_element_carries_its_floorspec_id_kind_and_the_documents_hash(exported, name):
    p, f = exported[name]
    products = [e for e in f.by_type("IfcProduct")]
    assert products
    for e in [*products, *f.by_type("IfcTypeObject"), f.by_type("IfcProject")[0]]:
        i = identity(e)
        assert i.get("ID"), f"{e.is_a()} {e.Name} has no Floorspec ID"
        assert i["DocumentHash"] == p.hash
        assert i["Kind"]
    gids = [e.GlobalId for e in f.by_type("IfcRoot")]
    assert len(gids) == len(set(gids))
    doc = p.document
    expected = {
        "wall": set(p.derived["walls"]),
        "opening": set(p.derived["openings"]),
        "room": set(p.derived["rooms"]),
        "level": set(doc.get("levels", {})),
        "separator": set(doc.get("separators", {})),
        "slab": set(p.derived.get("slabs", {})),
        "roof": set(p.derived.get("roofs", {})),
        "stair": set(p.derived.get("stairs", {})),
        "type": set(doc.get("types", {})),
    }
    for kind, ids in expected.items():
        assert set(by_id(f, kind)) == ids, kind


@pytest.mark.parametrize("name", NAMES)
def test_units_are_millimetres_and_square_metres_and_north_is_the_sites(exported, name):
    p, f = exported[name]
    project = f.by_type("IfcProject")[0]
    assert units.get_project_unit(f, "LENGTHUNIT").Prefix == "MILLI"
    assert units.get_project_unit(f, "AREAUNIT").Name == "SQUARE_METRE"
    assert units.get_project_unit(f, "PLANEANGLEUNIT").Name == "DEGREE"
    north = project.RepresentationContexts[0].TrueNorth.DirectionRatios
    theta = math.radians((p.document.get("site") or {}).get("trueNorth", 0) / 1e6)
    assert north == pytest.approx((-math.sin(theta), math.cos(theta)))
    site = f.by_type("IfcSite")
    assert bool(site) == ("site" in p.document)


@pytest.mark.parametrize("name", NAMES)
def test_spatial_structure_storeys_hold_their_elements(exported, name):
    p, f = exported[name]
    storeys = by_id(f, "level")
    for lid, s in storeys.items():
        assert s.Elevation == pytest.approx(mm(p.document["levels"][lid]["elevation"]))
    for wid, w in by_id(f, "wall").items():
        assert elements.get_container(w) == storeys[p.document["walls"][wid]["level"]]
    for rid, s in by_id(f, "room").items():
        assert elements.get_aggregate(s) == storeys[p.document["rooms"][rid]["level"]]
        area = elements.get_pset(s, "Qto_SpaceBaseQuantities")["NetFloorArea"]
        assert area == pytest.approx(float(p.derived["rooms"][rid]["area"]) / 1280e3**2)


@pytest.mark.parametrize("name", NAMES)
def test_each_opening_voids_its_wall_and_holds_its_door_or_window(exported, name):
    p, f = exported[name]
    walls = by_id(f, "wall")
    fills = by_id(f, "opening", "fill")
    types = p.document.get("types", {})
    for oid, op in by_id(f, "opening").items():
        o = p.document["openings"][oid]
        assert op.is_a("IfcOpeningElement")
        assert op.VoidsElements[0].RelatingBuildingElement == walls[o["wall"]]
        kind = types.get(o.get("fill", ""), {}).get("kind")
        if kind is None:
            assert not op.HasFillings
            continue
        filled = op.HasFillings[0].RelatedBuildingElement
        assert filled == fills[oid]
        assert filled.is_a("IfcDoor" if kind == "doorType" else "IfcWindow")
        assert elements.get_type(filled) == by_id(f, "type")[o["fill"]]
        if kind == "doorType" and types[o["fill"]].get("operation") == "swing":
            assert filled.OperationType == f"SINGLE_SWING_{door_hand(o.get('hinge'), o.get('swing'))}"


@pytest.mark.parametrize("name", NAMES)
def test_geometry_matches_what_the_engine_derived(exported, name):
    """The kernel's world boxes of walls, slabs, roofs, stairs and extension elements against the
    engine's exact values, within a hundredth of a millimetre."""
    p, f = exported[name]
    box = boxes(f)
    d = p.derived

    def check(e, lo, hi):
        got = box[e.GlobalId]
        assert got[0] == pytest.approx(lo, abs=TOL), e.Name
        assert got[1] == pytest.approx(hi, abs=TOL), e.Name

    fills = d.get("junctionFills", {})
    for wid, w in by_id(f, "wall").items():
        dw = d["walls"][wid]
        pts = [dw[k] for k in ("startRight", "endRight", "endLeft", "startLeft")]
        if not elements.get_pset(w, "Floorspec_Graph").get("JunctionFills"):
            check(w, (mm(min(x for x, _ in pts)), mm(min(y for _, y in pts)), mm(dw["baseElevation"])), (mm(max(x for x, _ in pts)), mm(max(y for _, y in pts)), mm(dw["topElevation"])))
        else:
            for jid in elements.get_pset(w, "Floorspec_Graph")["JunctionFills"]:
                pts += fills[jid]
            got = box[w.GlobalId]
            assert got[0][0] == pytest.approx(mm(min(x for x, _ in pts)), abs=TOL)
            assert got[1][1] == pytest.approx(mm(max(y for _, y in pts)), abs=TOL)
    for kind, derived in (("slab", d.get("slabs", {})), ("stair", {k: v for k, v in d.get("stairs", {}).items()})):
        for fid, e in by_id(f, kind).items():
            b = derived[fid]["box"]
            if kind == "stair":
                # A stair with flights has no body of its own: its parts' boxes make its box.
                parts = [x for x in elements.get_parts(e) if not x.is_a("IfcRailing")] or [e]
                lo = [min(box[x.GlobalId][0][i] for x in parts) for i in range(3)]
                hi = [max(box[x.GlobalId][1][i] for x in parts) for i in range(3)]
                assert lo == pytest.approx([mm(v) for v in b["min"]], abs=TOL)
                # The box reaches the head's floor; the treads stop a riser below it.
                steps = derived[fid].get("steps")
                top = steps[-1]["top"] if steps else b["max"][2]
                assert hi == pytest.approx([mm(b["max"][0]), mm(b["max"][1]), mm(top)], abs=TOL)
            else:
                check(e, [mm(v) for v in b["min"]], [mm(v) for v in b["max"]])
    for fid, roof in by_id(f, "roof").items():
        dr = d["roofs"][fid]
        parts = elements.get_parts(roof)
        if dr.get("surface"):
            b = dr["surface"]["box"]
            lo = [min(box[x.GlobalId][0][i] for x in parts) for i in range(3)]
            hi = [max(box[x.GlobalId][1][i] for x in parts) for i in range(3)]
            # With a thickness the faces are the roof's top, and the engine's box reaches down by it.
            assert lo == pytest.approx([mm(v) for v in b["min"]], abs=TOL)
            assert hi == pytest.approx([mm(v) for v in b["max"]], abs=TOL)
    for eid, fb in d.get("fallbacks", {}).items():
        proxy = next(e for e in f.by_type("IfcBuildingElementProxy") if identity(e)["ID"] == eid)
        xs, ys = [x for x, _ in fb["footprint"]], [y for _, y in fb["footprint"]]
        check(proxy, (mm(min(xs)), mm(min(ys)), mm(fb["bottom"])), (mm(max(xs)), mm(max(ys)), mm(fb["top"])))


def test_walls_have_layer_sets_left_to_right_from_the_left_face(exported):
    p, f = exported["l-stair-hip-roof"]
    wall = by_id(f, "wall")["GAB"]
    usage = elements.get_material(wall)
    assert usage.is_a("IfcMaterialLayerSetUsage")
    assert usage.LayerSetDirection == "AXIS2" and usage.DirectionSense == "NEGATIVE"
    layers = usage.ForLayerSet.MaterialLayers
    assert [l.Material.Name for l in layers] == ["Lap siding", "Framing", "Paint · warm white"]
    total = sum(l.LayerThickness for l in layers)
    assert usage.OffsetFromReferenceLine == pytest.approx(total / 2)
    assert elements.get_type(wall).Name == "Exterior wall"
    # The wall type owns the layer set; the usage points at it.
    assert elements.get_material(elements.get_type(wall)) == usage.ForLayerSet
    graph = elements.get_pset(wall, "Floorspec_Graph")
    assert (graph["StartJunction"], graph["EndJunction"]) == ("GA", "GB")
    connections = [r for r in f.by_type("IfcRelConnectsPathElements") if wall in (r.RelatingElement, r.RelatedElement)]
    assert {r.Name for r in connections} == {"GA", "GB"}


def test_rooms_have_boundaries_floors_and_ceilings(exported):
    p, f = exported["l-stair-hip-roof"]
    spaces = by_id(f, "room")
    living = spaces["LIV"]
    bounded = {identity(r.RelatedBuildingElement)["ID"] for r in living.BoundedBy if r.RelatedBuildingElement.is_a("IfcWall")}
    assert bounded == {"GAB", "GBF", "GEA", "GEF"}
    virtual = [r for r in spaces["LOFT"].BoundedBy if r.PhysicalOrVirtualBoundary == "VIRTUAL"]
    assert {identity(r.RelatedBuildingElement)["ID"] for r in virtual} == {"S1", "S2", "S3"}
    # Level 2 declares a floor thickness: its rooms' floors are slabs; level 1's are coverings.
    assert by_id(f, "room", "floor")["LOFT"].is_a("IfcSlab")
    assert by_id(f, "room", "floor")["LIV"].is_a("IfcCovering")
    ceiling = by_id(f, "room", "ceiling")["LIV"]
    assert ceiling.PredefinedType == "CEILING"
    assert ceiling in [c for r in living.HasCoverings for c in r.RelatedCoverings]


def test_roof_faces_are_roof_slabs_aggregated_by_the_roof(exported):
    p, f = exported["l-stair-hip-roof"]
    roof = by_id(f, "roof")["RF"]
    assert roof.PredefinedType == "HIP_ROOF"
    faces = elements.get_parts(roof)
    assert len(faces) == 4 and all(s.is_a("IfcSlab") and s.PredefinedType == "ROOF" for s in faces)
    assert {elements.get_pset(s, "Floorspec_RoofFace")["Edge"] for s in faces} == {0, 1, 2, 3}
    assert all(s.Representation.Representations[0].RepresentationType == "SurfaceModel" for s in faces)


def test_an_l_stair_has_two_flights_and_a_landing(exported):
    p, f = exported["l-stair-hip-roof"]
    stair = by_id(f, "stair")["ST1"]
    assert stair.PredefinedType == "QUARTER_TURN_STAIR"
    parts = elements.get_parts(stair)
    flights = [x for x in parts if x.is_a("IfcStairFlight")]
    landings = [x for x in parts if x.is_a("IfcSlab")]
    assert [(x.NumberOfRisers, x.NumberOfTreads) for x in flights] == [(7, 6), (7, 6)]
    assert [x.PredefinedType for x in landings] == ["LANDING"]
    common = elements.get_pset(stair, "Pset_StairCommon")
    assert common["NumberOfRiser"] == 14 and common["RiserHeight"] == pytest.approx(3456000 / 14 / 1280, abs=1e-3)
    assert elements.get_container(stair) is not None and not any(x.ContainedInStructure for x in parts)


def test_extension_elements_are_proxies_hosted_as_their_hosts_say(exported):
    p, f = exported["p5-systems-demo"]
    proxies = f.by_type("IfcBuildingElementProxy")
    assert len(proxies) == len(p.derived["fallbacks"]) == 27
    doc_elements = {}
    for ext, data in p.document["extensions"].items():
        for coll, els in data.get("collections", {}).items():
            for eid, el in els.items():
                doc_elements[eid] = (ext, coll, el)
    counts = Counter()
    for proxy in proxies:
        eid = identity(proxy)["ID"]
        ext, coll, el = doc_elements[eid]
        assert proxy.ObjectType == f"{ext}:{coll}" and identity(proxy)["Kind"] == f"{ext}:{coll}"
        mode = (el.get("host") or {}).get("mode", "free")
        counts[mode] += 1
        container = elements.get_container(proxy)
        if mode == "surface":
            assert container.is_a("IfcSpace") and identity(container)["ID"] == el["host"]["room"]
        else:
            assert container.is_a("IfcBuildingStorey")
        if mode == "wallFace":
            hosts = [r.RelatingElement for r in proxy.ConnectedFrom if r.is_a("IfcRelConnectsElements")]
            assert [identity(h)["ID"] for h in hosts] == [el["host"]["wall"]]
            assert proxy.ObjectPlacement.PlacementRelTo == hosts[0].ObjectPlacement
    assert counts["wallFace"] > 0


def test_every_mapping(exported):
    """One of each remaining thing Annex A maps, in the every-mapping fixture."""
    p, f = exported["every-mapping"]
    project = f.by_type("IfcProject")[0]
    assert project.Name == "Every IFC mapping"
    assert elements.get_pset(project, "Floorspec_Design") == {"OS": "OPA", "id": elements.get_pset(project, "Floorspec_Design")["id"]}
    site = f.by_type("IfcSite")[0]
    assert tuple(site.RefLatitude) == (42, 21, 36, 360000) and tuple(site.RefLongitude) == (-71, -3, -32, -40000)

    # Materials: a surface style with the colour, a texture, a library reference.
    oak = next(m for m in f.by_type("IfcMaterial") if m.Name == "White oak strip")
    style = oak.HasRepresentation[0].Representations[0].Items[0].Styles[0]
    assert style.is_a("IfcSurfaceStyle") and style.Side == "POSITIVE"
    textures = [s for s in style.Styles if s.is_a("IfcSurfaceStyleWithTextures")][0].Textures
    assert textures[0].URLReference == "textures/white-oak.png" and textures[0].Mode == "DIFFUSE"
    assert textures[0].TextureTransform.Scale == pytest.approx(97536 / 1280)
    assert elements.get_pset(oak, "Floorspec_Material")["Roughness"] == 620
    roof_mat = next(m for m in f.by_type("IfcMaterial") if m.Name == "Asphalt shingle")
    ref = roof_mat.HasExternalReferences[0].RelatingReference
    assert ref.Identification == "asphalt-shingle" and ref.ReferencedLibrary.Location == "https://library.floorspec.org/materials"
    ext_type = by_id(f, "type")["EXT"]
    assert ext_type.HasAssociations and any(r.is_a("IfcRelAssociatesLibrary") for r in ext_type.HasAssociations)

    # Door and window types: operations, panels, clear openings, overrides on the occurrence.
    types = by_id(f, "type")
    assert types["DE"].OperationType == "SINGLE_SWING_RIGHT"
    assert types["DI"].OperationType == "SLIDING_TO_RIGHT"
    assert types["WN"].PartitioningType == "DOUBLE_PANEL_HORIZONTAL"
    panels = [ps for ps in types["WN"].HasPropertySets if ps.is_a("IfcWindowPanelProperties")]
    assert [(x.OperationType, x.PanelPosition) for x in panels] == [("SLIDINGVERTICAL", "TOP"), ("SLIDINGVERTICAL", "BOTTOM")]
    assert [x.OperationType for x in types["WC"].HasPropertySets if x.is_a("IfcWindowPanelProperties")] == ["OTHEROPERATION"]
    assert elements.get_pset(types["DE"], "Floorspec_ClearOpening")["ClearWidth"] == pytest.approx(810)
    assert elements.get_pset(types["WN"], "Floorspec_ClearOpening")["ClearArea"] == pytest.approx(901120000000 / 1280e3**2)
    fills = by_id(f, "opening", "fill")
    assert fills["FRONT"].OperationType == "SINGLE_SWING_RIGHT"  # hinge end, swing left
    assert fills["KITD"].OperationType == "SLIDING_TO_RIGHT"
    assert elements.get_pset(fills["GW2"], "Floorspec_ClearOpening")["ClearWidth"] == pytest.approx(1300000 / 1280)
    hole = by_id(f, "opening")["HOLE"]
    assert not hole.HasFillings

    # Ceilings: tray and vault surfaces; the room's floor with a declared thickness is a slab
    # with its finish covering it.
    tray = by_id(f, "room", "ceiling")["KIT"]
    assert elements.get_pset(tray, "Floorspec_Ceiling")["Form"] == "tray"
    vault = by_id(f, "room", "ceiling")["BED"]
    assert elements.get_pset(vault, "Floorspec_Ceiling")["Low"] == pytest.approx(6037333 / 1280)
    box = boxes(f)
    assert box[vault.GlobalId][0][2] == pytest.approx(6037333 / 1280, abs=0.01)
    assert box[tray.GlobalId][1][2] == pytest.approx(3264000 / 1280, abs=0.01)
    loft_floor = by_id(f, "room", "floor")["LOFT"]
    assert loft_floor.is_a("IfcSlab")
    finish = by_id(f, "room", "floorFinish")["LOFT"]
    assert finish.CoversElements[0].RelatingBuildingElement == loft_floor
    assert elements.get_material(finish).Name == "White oak strip"
    assert by_id(f, "room", "wallFinish")["LIV"].PredefinedType == "CLADDING"

    # Wall face finishes: the whole face and a region.
    region = by_id(f, "wall", "finish:right:region:0")["GCD"]
    assert region.ObjectType == "region" and region.PredefinedType == "CLADDING"
    assert elements.get_pset(region, "Floorspec_Finish")["From"] == pytest.approx(500)
    assert region.CoversElements[0].RelatingBuildingElement == by_id(f, "wall")["GCD"]
    assert elements.get_material(region).Name == "Accent tile"

    # Slabs: a patio in the chosen option, and a landing.
    slabs = by_id(f, "slab")
    assert slabs["PATIO"].PredefinedType == "FLOOR" and slabs["PATIO"].ObjectType == "patio"
    assert slabs["STOOP"].PredefinedType == "LANDING"
    assert elements.get_material(slabs["STOOP"]).Name == "Concrete"

    # A roof with a thickness: closed breps.
    faces = elements.get_parts(by_id(f, "roof")["RF"])
    assert all(s.Representation.Representations[0].RepresentationType == "Brep" for s in faces)

    # Handrails on both sides of the stair.
    rails = [x for x in elements.get_parts(by_id(f, "stair")["ST1"]) if x.is_a("IfcRailing")]
    assert sorted(identity(r)["Part"] for r in rails) == ["handrail:left", "handrail:right"]
    assert all(elements.get_pset(r, "Pset_RailingCommon")["Height"] == pytest.approx(850) for r in rails)

    # The program: a space type per item, assigned to the rooms whose brief names it, with the
    # adjacency on the type of `a`.
    kitchen = f.by_type("IfcSpaceType")
    item = next(t for t in kitchen if identity(t)["ID"] == "PK")
    assert item.ElementType == "kitchen" and item.PredefinedType == "USERDEFINED"
    assert [identity(s)["ID"] for s in elements.get_types(item)] == ["KIT"]
    adjacency = elements.get_pset(item, "Floorspec_Adjacency")
    assert adjacency["Required"] == ["PL"] and adjacency["RequiredWeights"] == [8]
    assert elements.get_pset(next(t for t in kitchen if identity(t)["ID"] == "PB"), "Floorspec_Adjacency")["ForbiddenWeights"] == [5]
    declared = f.by_type("IfcRelDeclares")[0].RelatedDefinitions
    assert item in declared and types["EXT"] in declared


def test_a_document_hash_is_carried_unchanged(exported):
    p, f = exported["three-room-house"]
    hashes = {elements.get_pset(e, "Floorspec_Identity")["DocumentHash"] for e in f.by_type("IfcProduct")}
    assert hashes == {p.hash}
    assert json.loads(json.dumps(p.hash)) == p.hash
