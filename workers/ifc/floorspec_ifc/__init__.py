"""D3 Floorspec IFC worker: Floorspec designs to IFC4 ADD2 TC1 Reference View through IfcOpenShell.

A separate process and image, because IfcOpenShell is LGPL (FLR architecture): the Node worker
derives the document with the engine and sends the payload here over HTTP (``server.py``).
"""

__version__ = "0.2.0"


def health() -> dict[str, str]:
    """What the container healthcheck and the API ask: is this worker alive, and which one is it."""
    import ifcopenshell

    return {"status": "ok", "worker": "ifc", "version": __version__, "ifcopenshell": ifcopenshell.version}
