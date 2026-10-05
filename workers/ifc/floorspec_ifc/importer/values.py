"""Base units, lengths as the Ops reference grammar writes them, and the property-set dictionary.

The tolerance rule (FLR-T-9.5): an IFC value is a double in the file's unit, from our exact
conversion. A value is **unchanged** when it rounds to the same integer base units as the export
wrote; otherwise the edit is the new value, rounded once to base units (ties to even).
"""

from __future__ import annotations

from fractions import Fraction
from typing import Any, Callable

BASE_PER_MM = 1280
BASE2_PER_M2 = (BASE_PER_MM * 1000) ** 2
LAYER_FUNCTIONS = ("core", "substrate", "insulation", "membrane", "airGap", "finish")


def base(mm: float) -> int:
    """Millimetres to base units, rounded once, ties to even."""
    return int(round(mm * BASE_PER_MM))


def length(b: int) -> str:
    """Base units as an exact metric length of the reference grammar (Ops 3.1): ``"300mm"``.

    1/1280 mm has a finite decimal expansion (1280 = 2⁸·5), so every integer is written exactly.
    """
    f = Fraction(abs(b), BASE_PER_MM)
    whole, rest = divmod(f.numerator, f.denominator)
    text = str(whole)
    if rest:
        digits = ""
        while rest:
            rest *= 10
            d, rest = divmod(rest, f.denominator)
            digits += str(d)
        text += "." + digits
    return f"{'-' if b < 0 else ''}{text}mm"


def mm_text(b: int | None) -> str:
    """Base units for a person: millimetres, to two decimals where needed."""
    if b is None:
        return "nothing"
    v = b / BASE_PER_MM
    return f"{v:.2f}".rstrip("0").rstrip(".") + " mm"


# ---------------------------------------------------------------------------- property sets

Converter = Callable[[Any, "Units"], Any]


class Units:
    """How one file's values convert: millimetres per length unit, m² per area unit, the angle unit."""

    def __init__(self, length_mm: float, area_m2: float, angle: str):
        self.length_mm = length_mm
        self.area_m2 = area_m2
        self.angle = angle

    def degrees(self, v: float) -> float:
        import math

        return v if "DEGREE" in self.angle else math.degrees(v)


def _len(v: Any, u: Units) -> int:
    return base(float(v) * u.length_mm)


def _area(v: Any, u: Units) -> int:
    return int(round(float(v) * u.area_m2 * BASE2_PER_M2))


def _angle(v: Any, u: Units) -> int:
    return int(round(u.degrees(float(v)) * 1_000_000))


def _int(v: Any, u: Units) -> int:
    return int(v)


def _str(v: Any, u: Units) -> str:
    return str(v)


def _pairs(v: Any, u: Units) -> list[list[int]]:
    vals = [_len(x, u) for x in (v or [])]
    return [vals[i : i + 2] for i in range(0, len(vals) - 1, 2)]


CONVERT: dict[str, Converter] = {"len": _len, "area": _area, "angle": _angle, "int": _int, "str": _str, "id": _str, "pairs": _pairs}

# (kind group, part group) → property set → property → (JSON Pointer in the element, converter).
# A property that is not here is derived or read-only: a change to it is reported, never imported.
_OPENING = {
    "Floorspec_Opening": {
        "Wall": ("/wall", "id"),
        "Offset": ("/offset", "len"),
        "Fill": ("/fill", "id"),
        "Width": ("/width", "len"),
        "Height": ("/height", "len"),
        "Sill": ("/sill", "len"),
        "Hinge": ("/hinge", "str"),
        "Swing": ("/swing", "str"),
    },
}
_CLEAR = {"Floorspec_ClearOpening": {"ClearWidth": ("/clearOpening/width", "len"), "ClearHeight": ("/clearOpening/height", "len"), "ClearArea": ("/clearOpening/area", "area")}}

PSETS: dict[tuple[str, str | None], dict[str, dict[str, tuple[str, str]]]] = {
    ("opening", None): {**_OPENING, **_CLEAR},
    ("opening", "fill"): dict(_CLEAR),
    ("wall", None): {"Floorspec_Wall": {"Type": ("/type", "id"), "Justification": ("/justification", "str")}},
    ("wall", "region"): {
        "Floorspec_Finish": {"From": ("{region}/from", "len"), "To": ("{region}/to", "len"), "Bottom": ("{region}/bottom", "len"), "Top": ("{region}/top", "len")}
    },
    ("room", None): {"Floorspec_Room": {"Function": ("/function", "str"), "Brief": ("/brief", "id")}},
    ("room", "floor"): {"Floorspec_Floor": {"Offset": ("/floor/offset", "len"), "Thickness": ("/floor/thickness", "len")}},
    ("room", "ceiling"): {
        "Floorspec_Ceiling": {
            "Form": ("/ceiling/kind", "str"),
            "Height": ("/ceiling/height", "len"),
            "Border": ("/ceiling/border", "len"),
            "Depth": ("/ceiling/depth", "len"),
            "Ridge": ("/ceiling/ridge", "pairs"),
            "PitchRise": ("/ceiling/pitch/rise", "int"),
            "PitchRun": ("/ceiling/pitch/run", "int"),
            "Slopes": ("/ceiling/slopes", "str"),
        }
    },
    ("slab", None): {"Floorspec_Slab": {"Purpose": ("/purpose", "str"), "Thickness": ("/thickness", "len"), "Offset": ("/offset", "len")}},
    ("level", None): {"Floorspec_Level": {"Height": ("/height", "len"), "FloorThickness": ("/floorThickness", "len"), "CeilingHeight": ("/ceilingHeight", "len")}},
    ("material", None): {"Floorspec_Material": {"Metallic": ("/metallic", "int"), "Roughness": ("/roughness", "int"), "Colour": ("/color", "str")}},
    ("type", None): {
        "Floorspec_Type": {"Operation": ("/operation", "str"), "Width": ("/width", "len"), "Height": ("/height", "len"), "Sill": ("/sill", "len")},
        **_CLEAR,
    },
    ("roof", None): {
        "Floorspec_Roof": {
            "PitchRise": ("/pitch/rise", "int"),
            "PitchRun": ("/pitch/run", "int"),
            "Overhang": ("/overhang", "len"),
            "Height": ("/height", "len"),
            "Thickness": ("/thickness", "len"),
        }
    },
    ("stair", None): {
        "Floorspec_Stair": {
            "To": ("/to", "id"),
            "Width": ("/width", "len"),
            "Tread": ("/tread", "len"),
            "Risers": ("/risers", "int"),
            "MaxRiser": ("/maxRiser", "len"),
            "Rotation": ("/rotation", "angle"),
            "PositionX": ("/position/0", "len"),
            "PositionY": ("/position/1", "len"),
            "Form": ("/form/kind", "str"),
            "Turn": ("/form/turn", "str"),
            "RisersBeforeTurn": ("/form/risersBeforeTurn", "int"),
            "Gap": ("/form/gap", "len"),
            "Angle": ("/form/angle", "str"),
            "Winders": ("/form/winders", "int"),
            "Diameter": ("/form/diameter", "len"),
            "Sweep": ("/form/sweep", "angle"),
        }
    },
    ("stair", "handrail"): {"Pset_RailingCommon": {"Height": ("/handrail/height", "len")}},
    ("programItem", None): {
        "Floorspec_Program": {
            "Function": ("/function", "str"),
            "Count": ("/count", "int"),
            "TargetArea": ("/targetArea", "area"),
            "MinArea": ("/minArea", "area"),
            "Level": ("/level", "id"),
        }
    },
    ("site", None): {"Floorspec_Site": {"TrueNorth": ("/trueNorth", "angle")}},
    ("extension", None): {"Floorspec_Host": {"Offset": ("/host/offset", "len"), "Height": ("/host/height", "len"), "Side": ("/host/side", "str")}},
}

IGNORED_PSETS = {"Floorspec_Identity", "Floorspec_Graph"}
"""Read elsewhere: the identity is the key, and the graph is read as junction positions."""


def groups(kind: str, part: str | None) -> tuple[str, str | None]:
    """The dictionary's key for an identity's kind and part."""
    k = "extension" if ":" in kind else kind
    if part is None:
        return (k, None)
    if part.startswith("handrail:"):
        return (k, "handrail")
    if ":region:" in part:
        return (k, "region")
    return (k, part)
