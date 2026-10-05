"""The IFC worker's command line.

    python -m floorspec_ifc                       serve on IFC_WORKER_HOST:IFC_WORKER_PORT (127.0.0.1:3410)
    python -m floorspec_ifc serve [--host H] [--port P]
    python -m floorspec_ifc health                ask the running server; exit 0 when it is healthy
    python -m floorspec_ifc export PAYLOAD OUT    a payload file to an IFC file ("-" for stdin, stdout)
    python -m floorspec_ifc check FILE.ifc        validate an IFC file; print its summary
    python -m floorspec_ifc samples [DIR]         the sample IFCs from tests/fixtures (default samples/)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path


def _health(port: int) -> int:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=4) as r:
            body = json.load(r)
    except Exception as e:
        print(json.dumps({"status": "down", "error": str(e)}))
        return 1
    print(json.dumps(body))
    return 0 if body.get("status") == "ok" else 1


def _export(src: str, out: str) -> int:
    from .server import render

    raw = json.load(sys.stdin if src == "-" else open(src, encoding="utf-8"))
    data, facts, _ = render(raw)
    if out == "-":
        sys.stdout.buffer.write(data)
    else:
        Path(out).write_bytes(data)
        print(json.dumps(facts), file=sys.stderr)
    return 0


def _check(path: str) -> int:
    import ifcopenshell

    from .check import problems
    from .export import summary

    f = ifcopenshell.open(path)
    errors = problems(f)
    print(json.dumps(summary(f, len(errors)), indent=2))
    for e in errors[:20]:
        print(json.dumps(e, default=str), file=sys.stderr)
    return 1 if errors else 0


def _samples(target: str) -> int:
    here = Path(__file__).resolve().parent.parent / "tests" / "fixtures"
    out = Path(target)
    out.mkdir(parents=True, exist_ok=True)
    for src in sorted(here.glob("*.payload.json")):
        dest = out / src.name.replace(".payload.json", ".ifc")
        _export(str(src), str(dest))
        print(dest)
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="python -m floorspec_ifc")
    sub = parser.add_subparsers(dest="command")
    s = sub.add_parser("serve")
    s.add_argument("--host")
    s.add_argument("--port", type=int)
    sub.add_parser("health")
    e = sub.add_parser("export")
    e.add_argument("payload")
    e.add_argument("out")
    c = sub.add_parser("check")
    c.add_argument("file")
    m = sub.add_parser("samples")
    m.add_argument("dir", nargs="?", default="samples")
    args = parser.parse_args(argv)
    port = int(os.environ.get("IFC_WORKER_PORT", "3410"))
    if args.command in (None, "serve"):
        from .server import main as serve

        given = getattr(args, "port", None)
        return serve(getattr(args, "host", None), port if given is None else given)
    if args.command == "health":
        return _health(port)
    if args.command == "export":
        return _export(args.payload, args.out)
    if args.command == "check":
        return _check(args.file)
    return _samples(args.dir)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
