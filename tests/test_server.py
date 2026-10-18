"""The web app without a simulation: login, file access, scenarios, URIs."""

import json

import pytest
from fastapi.testclient import TestClient

from hangar_cloud.server import create_app
from hangar_cloud.session import Session, resolve_uri, with_terrain_heights

TOKEN = "secret-token"
ORIGIN = {"Origin": "http://testserver"}


@pytest.fixture
def session(tmp_path, monkeypatch):
    for var in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"):
        monkeypatch.setenv(var, str(tmp_path / var.lower()))
    from hangar.settings import Settings

    return Session(Settings(), gz_python=None)


@pytest.fixture
def client(session):
    c = TestClient(create_app(session, TOKEN))
    c.cookies.set("hangar_cloud", TOKEN)
    return c


def scene_line(models):
    return json.dumps({"t": "scene", "world": "w", "scene": {"name": "w", "models": models, "lights": []}})


def mesh_model(path):
    return {"id": 1, "name": "plane", "static": False, "pose": [0] * 6 + [1], "models": [],
            "links": [{"id": 2, "name": "l", "pose": [0] * 6 + [1], "visuals": [
                {"id": 3, "name": "v", "pose": [0] * 6 + [1], "scale": [1, 1, 1], "transparency": 0, "material": None,
                 "geometry": {"kind": "mesh", "file": str(path), "scale": [1, 1, 1]}}]}]}


def test_login_with_the_token(session):
    c = TestClient(create_app(session, TOKEN))
    assert c.get("/api/info").status_code == 401
    assert "Paste the token" in c.get("/").text  # login page instead of the app
    assert c.get("/?token=wrong", follow_redirects=False).status_code == 403
    r = c.get(f"/?token={TOKEN}", follow_redirects=False)
    assert r.status_code == 303 and "httponly" in r.headers["set-cookie"].lower()
    assert c.get("/api/info").status_code == 200  # the cookie works from now on
    assert "Hangar Cloud" in c.get("/").text


def test_cross_site_posts_are_refused(client):
    assert client.post("/api/stop", headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.post("/api/stop", headers=ORIGIN).status_code == 200


def test_only_files_of_the_scene_are_served(client, session, tmp_path):
    model = tmp_path / "models" / "plane"
    (model / "meshes").mkdir(parents=True)
    (model / "materials" / "textures").mkdir(parents=True)
    (model / "model.config").write_text("<model/>")
    (model / "meshes" / "wing.dae").write_text("<COLLADA/>")
    (model / "materials" / "textures" / "wing.png").write_bytes(b"png")
    (model / ".git").mkdir()
    (model / ".git" / "config").write_text("secret")
    (tmp_path / "private.txt").write_text("no")
    session.scene = scene_line([mesh_model(model / "meshes" / "wing.dae")])

    assert client.get(f"/files{model}/meshes/wing.dae").text == "<COLLADA/>"
    assert client.get(f"/files{model}/materials/textures/wing.png").status_code == 200  # next to the mesh
    assert client.get(f"/files{model}/.git/config").status_code == 404
    assert client.get(f"/files{tmp_path}/private.txt").status_code == 404
    assert client.get(f"/files{model}/../../private.txt").status_code == 404
    session.scene = None
    assert client.get(f"/files{model}/meshes/wing.dae").status_code == 404


def test_uris_resolve_like_gazebo(tmp_path):
    (tmp_path / "a").mkdir()
    (tmp_path / "b" / "x8" / "meshes").mkdir(parents=True)
    (tmp_path / "b" / "x8" / "meshes" / "wing.dae").write_text("")
    roots = [str(tmp_path / "a"), str(tmp_path / "b")]
    assert resolve_uri("model://x8/meshes/wing.dae", roots) == str(tmp_path / "b" / "x8" / "meshes" / "wing.dae")
    assert resolve_uri("file:///tmp/x.dae", roots) == "/tmp/x.dae"
    assert resolve_uri("model://missing/x.dae", roots) == "model://missing/x.dae"


def test_hangar_earth_terrain_gets_exact_heights(tmp_path):
    (tmp_path / "terrain.png").write_bytes(b"")
    (tmp_path / "hangar-earth.json").write_text(json.dumps({"heights": {"file": "heights.u16", "n": 513}}))
    terrain = {"id": 1, "name": "terrain", "static": True, "pose": [0] * 6 + [1], "models": [],
               "links": [{"id": 2, "name": "l", "pose": [0] * 6 + [1], "visuals": [
                   {"id": 3, "name": "v", "geometry": {"kind": "heightmap", "file": str(tmp_path / "terrain.png"),
                                                       "size": [1000, 1000, 50], "pos": [0, 0, 0], "textures": []}}]}]}
    msg = with_terrain_heights(json.loads(scene_line([terrain])))
    h = msg["scene"]["models"][0]["links"][0]["visuals"][0]["geometry"]["heights"]
    assert h == {"file": str(tmp_path / "heights.u16"), "n": 513, "scale": 0.1}


def test_scenarios_apply_save_and_list(client):
    bad = client.post("/api/scenario", json={"yaml": "vehicles: [{model: x, wings: 3}]"}, headers=ORIGIN)
    assert bad.status_code == 400
    ok = client.post("/api/scenario", json={"yaml": "name: t\nvehicles: [{model: 'sitl:copter'}]"}, headers=ORIGIN)
    assert ok.status_code == 200 and any("arducopter" in e for e in ok.json()["errors"])  # no SITL in tests
    assert client.post("/api/scenario/save", json={"name": "../x"}, headers=ORIGIN).status_code == 400
    assert client.post("/api/scenario/save", json={"name": "mine"}, headers=ORIGIN).json() == {"id": "saved:mine"}
    info = client.get("/api/info").json()
    assert "saved:mine" in [s["id"] for s in info["scenarios"]] and info["scenario"]["id"] == "saved:mine"
    assert client.post("/api/scenario/load", json={"id": "example:quickstart"}, headers=ORIGIN).status_code == 200


def test_websocket_says_hello(client, session):
    session.scene = scene_line([])
    with client.websocket_connect("/ws", headers=ORIGIN) as ws:
        hello = json.loads(ws.receive_text())
        assert hello["t"] == "hello" and hello["state"] == "idle"
        assert json.loads(ws.receive_text())["t"] == "scene"  # the 3D view of a running sim, at once
        session.hub.publish({"t": "log", "line": {"text": "hi"}})
        assert json.loads(ws.receive_text())["line"]["text"] == "hi"


def test_websocket_needs_the_cookie(session):
    c = TestClient(create_app(session, TOKEN))
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect) as e:
        with c.websocket_connect("/ws") as ws:
            ws.receive_text()
    assert e.value.code == 4401


def test_browser_camera_mount():
    from types import SimpleNamespace

    from hangar.scenario import VehicleSpec

    from hangar_cloud.session import view_camera

    plane = SimpleNamespace(camera_pose=[0.7, 0, 0.05, 0, 0, 0])
    v = SimpleNamespace(spec=VehicleSpec(model="x8"), model=plane)
    assert view_camera(v) == {"pose": [0.7, 0, 0.05, 0, 0, 0], "hfov_deg": 60.0, "width": 1280, "height": 720}
    v = SimpleNamespace(spec=VehicleSpec(model="x8", camera={"pose": [0, 0, -0.1, 0, 90, 0], "fov": 80}), model=plane)
    assert view_camera(v)["pose"] == [0, 0, -0.1, 0, 90, 0] and view_camera(v)["hfov_deg"] == 80  # looks down
    v = SimpleNamespace(spec=VehicleSpec(model="boat"), model=SimpleNamespace(camera_pose=None))
    assert view_camera(v)["pose"][:3] == [0.3, 0.0, 0.05]  # the nose, by default


def test_parameters_api(client, session, monkeypatch):
    from types import SimpleNamespace

    assert client.get("/api/vehicles/quad/params").status_code == 400  # nothing running

    class Link:
        params = {"WP_SPD": 5.0, "ARMING_CHECK": 1.0}
        param_count, params_complete, params_changed = 2, True, 3
        telemetry = SimpleNamespace(version="4.7.2")

        def param_is_int(self, name):
            return name == "ARMING_CHECK"

        async def set_param(self, name, value):
            self.params[name.upper()] = value
            return value

    v = SimpleNamespace(name="quad", link=Link(), model=SimpleNamespace(type="copter"))
    monkeypatch.setattr(session, "sup", SimpleNamespace(vehicle=lambda n: v))
    r = client.get("/api/vehicles/quad/params").json()
    assert r["params"] == {"ARMING_CHECK": [1.0, True], "WP_SPD": [5.0, False]} and r["version"] == "4.7.2"
    assert client.post("/api/vehicles/quad/params", json={"name": "wp_spd", "value": 8}, headers=ORIGIN).json() == \
        {"name": "WP_SPD", "value": 8.0}
    assert client.get("/api/vehicles/quad/params/meta").json() is None  # not downloaded yet


def test_start_says_why_it_cannot(client, session):
    session.set_scenario("vehicles: [{model: no_such_model}]")
    r = client.post("/api/start", headers=ORIGIN)
    assert r.status_code == 400 and "unknown model 'no_such_model'" in r.json()["detail"]
    assert session.sup is None  # nothing was started


def test_gazebo_runs_without_a_window_and_examples_load(session):
    assert session.scenario_id == "example:quickstart"  # no Gazebo bindings here: built-in physics
    session.load("example:runway-3d")  # the cloud's own example
    assert session.scenario.world == "skywalker_x8_runway"
    session.set_scenario("world: w\nvehicles: [{model: sitl:plane}]")
    assert session._running_scenario().headless and not session.scenario.headless
    session.gazebo_window = True
    assert not session._running_scenario().headless


def test_scenario_from_the_form(client, session):
    data = {"name": "form", "world": "skywalker_x8_runway", "outputs": ["udp:127.0.0.1:14551"],
            "vehicles": [{"model": "sitl:copter", "name": "c1", "params": {"SIM_WIND_SPD": 3}},
                         {"model": "sitl:plane", "name": "p1", "pose": [10, 0, 0, 0, 0, 90], "params": {}}]}
    r = client.post("/api/scenario", json={"data": data}, headers=ORIGIN)
    assert r.status_code == 200, r.text
    sc = session.scenario
    assert [v.name for v in sc.vehicles] == ["c1", "p1"] and sc.vehicles[0].params == {"SIM_WIND_SPD": 3}
    assert not sc.vehicles[0].placed and sc.vehicles[1].placed
    back = client.get("/api/info").json()["scenario"]["data"]
    assert back["vehicles"][0] == {"model": "sitl:copter", "name": "c1", "params": {"SIM_WIND_SPD": 3}}
    assert back["vehicles"][1]["pose"] == [10, 0, 0, 0, 0, 90] and back["outputs"] == ["udp:127.0.0.1:14551"]
    bad = client.post("/api/scenario", json={"data": {"vehicles": [{"model": "x", "pose": [1, 2]}]}}, headers=ORIGIN)
    assert bad.status_code == 400
    assert client.post("/api/vehicles/c1/restart", headers=ORIGIN).status_code == 400  # nothing running
    info = client.get("/api/info").json()["catalog"]
    assert {"name", "type", "gazebo", "camera", "description"} <= set(info["models"][0])
