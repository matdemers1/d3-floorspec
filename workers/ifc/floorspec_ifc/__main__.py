"""Run the IFC worker. Phase 0 has no jobs to take, so it idles until stopped."""

import json
import signal
import sys
import threading

from . import health


def main() -> int:
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    print(json.dumps({"msg": "ifc worker started; no job kinds are registered yet", **health()}), flush=True)
    stop.wait()
    return 0


if __name__ == "__main__":
    if sys.argv[1:] == ["health"]:
        print(json.dumps(health()))
        sys.exit(0)
    sys.exit(main())
