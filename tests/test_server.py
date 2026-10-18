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
