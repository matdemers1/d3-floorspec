import json
from pathlib import Path

import pytest

from floorspec_ifc.export import export
from floorspec_ifc.payload import parse

FIXTURES = Path(__file__).parent / "fixtures"
NAMES = ["three-room-house", "l-stair-hip-roof", "p5-systems-demo", "every-mapping"]


def raw_payload(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.payload.json").read_text())


@pytest.fixture(scope="session")
def exported():
    """Each fixture's payload and the file exported from it, once per session."""
    out = {}
    for name in NAMES:
        p = parse(raw_payload(name))
        out[name] = (p, export(p))
    return out
