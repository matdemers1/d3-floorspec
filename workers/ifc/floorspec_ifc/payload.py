"""The payload the Node worker sends (apps/worker/src/export/ifc/index.ts writes it).

The engine evaluated and derived the document already; the payload carries the design's view, its
derived values and the version's facts. It is data from another process, so its shape is checked
before anything reads it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

FORMAT = "floorspec-ifc-payload"
VERSION = 1
HASH = re.compile(r"^[0-9a-f]{64}$")
TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


class PayloadError(ValueError):
    """The payload is not one this worker reads; the message says why, for the job's error."""


@dataclass(frozen=True)
class Payload:
    hash: str
    document: dict[str, Any]
    derived: dict[str, Any]
    design: dict[str, str]
    name: str
    timestamp: str
    version_seq: int | None
    engine_version: str
    core_version: str


def _obj(v: Any, what: str) -> dict[str, Any]:
    if not isinstance(v, dict):
        raise PayloadError(f"{what} is not an object")
    return v


def parse(raw: Any) -> Payload:
    p = _obj(raw, "the payload")
    if p.get("format") != FORMAT or p.get("version") != VERSION:
        raise PayloadError(f"the payload is not {FORMAT} version {VERSION}")
    h = p.get("hash")
    if not isinstance(h, str) or not HASH.match(h):
        raise PayloadError("the payload's hash is not a 64-character content hash")
    document = _obj(p.get("document"), "the document")
    if not isinstance(document.get("floorspec"), str):
        raise PayloadError("the document declares no Floorspec version")
    _obj(document.get("project"), "the document's project")
    derived = _obj(p.get("derived"), "the derived values")
    for member in ("walls", "rooms", "openings"):
        _obj(derived.get(member), f"the derived {member}")
    design = _obj(p.get("design", {}), "the design")
    if not all(isinstance(k, str) and isinstance(v, str) for k, v in design.items()):
        raise PayloadError("the design maps option sets to options by ID")
    f = _obj(p.get("file"), "the file facts")
    name = f.get("name")
    if not isinstance(name, str) or not name.endswith(".ifc") or "/" in name or len(name) > 200:
        raise PayloadError("the file's name is not a plain .ifc name")
    ts = f.get("timestamp")
    if not isinstance(ts, str) or not TIMESTAMP.match(ts):
        raise PayloadError("the file's timestamp is not an ISO 8601 UTC time to the second")
    seq = f.get("versionSeq")
    if seq is not None and not isinstance(seq, int):
        raise PayloadError("the version's number is not an integer")
    engine = _obj(p.get("engine", {}), "the engine facts")
    return Payload(
        hash=h,
        document=document,
        derived=derived,
        design=dict(design),
        name=name,
        timestamp=ts,
        version_seq=seq,
        engine_version=str(engine.get("version", "")),
        core_version=str(engine.get("core", "")),
    )
