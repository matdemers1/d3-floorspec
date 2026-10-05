"""The HTTP interface the Node worker calls, and the command line."""

import json
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path

import ifcopenshell
import pytest

from floorspec_ifc.server import serve

from .conftest import raw_payload


@pytest.fixture(scope="module")
def url():
    server = serve("127.0.0.1", 0)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()


def post(url, body: bytes, content_type="application/json"):
    req = urllib.request.Request(f"{url}/export", data=body, method="POST", headers={"Content-Type": content_type})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def test_health(url):
    with urllib.request.urlopen(f"{url}/health") as r:
        assert json.load(r)["status"] == "ok"


def test_export_answers_the_file_with_its_summary(url, tmp_path):
    status, headers, body = post(url, json.dumps(raw_payload("p5-systems-demo")).encode())
    assert status == 200
    assert headers["Content-Type"] == "application/x-step"
    summary = json.loads(headers["X-Floorspec-Ifc-Summary"])
    assert summary["schema"] == "IFC4" and summary["view"] == "ReferenceView_V1.2"
    assert summary["validation"] == {"errors": 0}
    assert summary["entities"]["IfcBuildingElementProxy"] == 27
    (tmp_path / "x.ifc").write_bytes(body)
    assert ifcopenshell.open(str(tmp_path / "x.ifc")).by_type("IfcProject")[0].Name == "Phase 5 demo house"


def test_a_payload_it_does_not_read_is_a_422_with_the_reason(url):
    p = raw_payload("three-room-house")
    p["version"] = 9
    status, _, body = post(url, json.dumps(p).encode())
    assert status == 422
    assert json.loads(body) == {"error": "the payload is not floorspec-ifc-payload version 1"}
    status, _, body = post(url, b"{not json")
    assert status == 400


def test_anything_else_is_not_found(url):
    with pytest.raises(urllib.error.HTTPError) as e:
        urllib.request.urlopen(f"{url}/nothing")
    assert e.value.code == 404


def test_the_command_line_exports_and_checks_a_file(tmp_path):
    root = Path(__file__).resolve().parent.parent
    src = root / "tests" / "fixtures" / "three-room-house.payload.json"
    out = tmp_path / "three.ifc"
    run = subprocess.run([sys.executable, "-m", "floorspec_ifc", "export", str(src), str(out)], cwd=root, capture_output=True, text=True)
    assert run.returncode == 0, run.stderr
    check = subprocess.run([sys.executable, "-m", "floorspec_ifc", "check", str(out)], cwd=root, capture_output=True, text=True)
    assert check.returncode == 0, check.stderr
    assert json.loads(check.stdout)["validation"] == {"errors": 0}
