from floorspec_ifc import health


def test_health_reports_ok():
    assert health() == {"status": "ok", "worker": "ifc", "version": "0.1.0"}
