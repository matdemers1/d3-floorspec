"""D3 Floorspec IFC worker. Phase 0: the process exists and can say it is alive."""

__version__ = "0.1.0"


def health() -> dict[str, str]:
    """What the container healthcheck and the API ask: is this worker alive, and which one is it."""
    return {"status": "ok", "worker": "ifc", "version": __version__}
