"""The ``POST /import`` request: what the server sends to reconcile one IFC file.

    {
      "format": "floorspec-ifc-import", "version": 1,
      "payload": { ...the export payload of the version the file came from (payload.py)... },
      "ifc": "<the file's bytes, base64>",
      "name": "the-file.ifc"
    }

The server finds the version by the file's ``DocumentHash`` and builds its payload exactly as an
export does, so the export written again here is the file the person downloaded, element for element.
"""

from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
from typing import Any

import ifcopenshell

from ..payload import Payload, PayloadError, parse

FORMAT = "floorspec-ifc-import"
VERSION = 1
MAX_IFC_BYTES = 48 * 1024 * 1024


class RequestError(ValueError):
    """The request or its file cannot be read; the message is for a person."""


@dataclass(frozen=True)
class ImportRequest:
    payload: Payload
    ifc: bytes
    name: str


def parse_request(raw: Any) -> ImportRequest:
    if not isinstance(raw, dict) or raw.get("format") != FORMAT or raw.get("version") != VERSION:
        raise RequestError(f"the request is not {FORMAT} version {VERSION}")
    try:
        payload = parse(raw.get("payload"))
    except PayloadError as e:
        raise RequestError(f"the original version's payload: {e}") from e
    data = raw.get("ifc")
    if not isinstance(data, str) or not data:
        raise RequestError("the request carries no IFC file")
    try:
        ifc = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError) as e:
        raise RequestError("the IFC file is not base64") from e
    if len(ifc) > MAX_IFC_BYTES:
        raise RequestError(f"the IFC file is larger than {MAX_IFC_BYTES // (1024 * 1024)} MB")
    name = raw.get("name")
    if not isinstance(name, str) or not name or len(name) > 200:
        name = "upload.ifc"
    return ImportRequest(payload, ifc, name)


def read_ifc(data: bytes) -> ifcopenshell.file:
    """An IFC-SPF file's bytes, parsed; anything else is a RequestError that says so."""
    head = data[:64].lstrip()
    if head.startswith(b"PK"):
        raise RequestError("the file is a zipped IFC (.ifczip); unzip it and send the .ifc")
    if not head.startswith(b"ISO-10303-21"):
        raise RequestError("the file is not an IFC file (STEP physical file, ISO-10303-21)")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        text = data.decode("latin-1")
    try:
        f = ifcopenshell.file.from_string(text)
    except Exception as e:  # IfcOpenShell raises its own kinds for a file it cannot parse
        raise RequestError(f"the IFC file could not be read ({type(e).__name__}: {str(e)[:160]})") from e
    if f.schema not in ("IFC4", "IFC4X3", "IFC4X3_ADD2"):
        raise RequestError(f"the file is {f.schema}; a round trip reads IFC4 (the schema it was exported in)")
    return f
