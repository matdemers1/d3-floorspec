"""Annex A of Floorspec Core: the names a Floorspec kind or enumeration takes in IFC4 (ADD2 TC1).

These tables are the annex's, transcribed; the exporter only looks them up.
"""

from __future__ import annotations

VIEW_DEFINITION = "ViewDefinition [ReferenceView_V1.2]"
"""The FILE_DESCRIPTION of an IFC4 ADD2 TC1 Reference View 1.2 file."""

SCHEMA = "IFC4"

ROOF_TYPES = {"flat": "FLAT_ROOF", "shed": "SHED_ROOF", "gable": "GABLE_ROOF", "hip": "HIP_ROOF"}

STAIR_TYPES = {"straight": "STRAIGHT_RUN_STAIR", "lShaped": "QUARTER_TURN_STAIR", "uShaped": "HALF_TURN_STAIR", "spiral": "SPIRAL_STAIR"}
WINDER_STAIR_TYPES = {"quarter": "QUARTER_WINDING_STAIR", "half": "HALF_WINDING_STAIR"}


def stair_type(form: dict | None) -> str:
    kind = (form or {}).get("kind", "straight")
    if kind == "winder":
        return WINDER_STAIR_TYPES.get(form.get("angle", ""), "NOTDEFINED")  # type: ignore[union-attr]
    return STAIR_TYPES.get(kind, "NOTDEFINED")


def door_operation(operation: str | None, hand: str) -> tuple[str, str | None]:
    """IfcDoorTypeOperationEnum for a Core door operation and a hand ("LEFT" or "RIGHT").

    Returns the enumeration value and, for USERDEFINED, the UserDefinedOperationType.
    """
    if operation is None:
        return "NOTDEFINED", None
    table = {
        "swing": f"SINGLE_SWING_{hand}",
        "doubleSwing": "DOUBLE_DOOR_SINGLE_SWING",
        "doubleActing": f"DOUBLE_SWING_{hand}",
        "bypassSlide": "DOUBLE_DOOR_SLIDING",
        "pocket": f"SLIDING_TO_{hand}",
        "surfaceSlide": f"SLIDING_TO_{hand}",
        "bifold": f"FOLDING_TO_{hand}",
    }
    if operation in table:
        return table[operation], None
    if operation in ("overhead", "cased"):
        return "USERDEFINED", operation
    return "NOTDEFINED", None


# Core 0.3 records no casement's or tilt-turn's hand and no pivot's axis (8.4), so a core-only
# exporter writes OTHEROPERATION where the hand or the axis decides the value. A horizontal
# slider's second panel may be fixed or sliding; Core does not say which, and which one is fixed is
# a hand, so both panels are written SLIDINGHORIZONTAL.
WINDOW_OPERATIONS: dict[str, tuple[str, list[tuple[str, str]]]] = {
    "fixed": ("SINGLE_PANEL", [("FIXEDCASEMENT", "MIDDLE")]),
    "casement": ("SINGLE_PANEL", [("OTHEROPERATION", "MIDDLE")]),
    "awning": ("SINGLE_PANEL", [("TOPHUNG", "MIDDLE")]),
    "hopper": ("SINGLE_PANEL", [("BOTTOMHUNG", "MIDDLE")]),
    "singleHung": ("DOUBLE_PANEL_HORIZONTAL", [("FIXEDCASEMENT", "TOP"), ("SLIDINGVERTICAL", "BOTTOM")]),
    "doubleHung": ("DOUBLE_PANEL_HORIZONTAL", [("SLIDINGVERTICAL", "TOP"), ("SLIDINGVERTICAL", "BOTTOM")]),
    "horizontalSlider": ("DOUBLE_PANEL_VERTICAL", [("SLIDINGHORIZONTAL", "LEFT"), ("SLIDINGHORIZONTAL", "RIGHT")]),
    "tiltTurn": ("SINGLE_PANEL", [("OTHEROPERATION", "MIDDLE")]),
    "pivot": ("SINGLE_PANEL", [("OTHEROPERATION", "MIDDLE")]),
}


def window_operation(operation: str | None) -> tuple[str, list[tuple[str, str]]]:
    """IfcWindowTypePartitioningEnum and each panel's (IfcWindowPanelOperationEnum, IfcWindowPanelPositionEnum)."""
    if operation is None:
        return "NOTDEFINED", []
    return WINDOW_OPERATIONS.get(operation, ("NOTDEFINED", []))


def door_hand(hinge: str | None, swing: str | None) -> str:
    """The IFC4 hand of a door: LEFT or RIGHT, seen along the door's local +y — the side it swings into.

    The door's local x runs along the wall when it swings to the wall's left, against it when it
    swings to the right, so its +y always points where the leaf opens; looking along +y, the hand
    is the side of the jamb the leaf hangs from. Core's defaults: hinge "start", swing "right".
    """
    hinge = hinge or "start"
    swing = swing or "right"
    if swing == "left":
        return "LEFT" if hinge == "start" else "RIGHT"
    return "LEFT" if hinge == "end" else "RIGHT"


SLAB_PURPOSE_LANDING = "landing"
