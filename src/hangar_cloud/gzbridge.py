"""Gazebo -> JSON lines on stdout: the scene once, then poses and statistics.

Runs with the Python that has Gazebo's bindings (python3-gz-transport13 on
Ubuntu), which is often not the Python the server runs in. That is why it is a
separate process with no imports beyond the standard library and Gazebo.

    {"t": "scene", "world": "...", "scene": {...}}     whenever the scene changes
    {"t": "poses", "p": [[id, x, y, z, qx, qy, qz, qw], ...]}   changed entities, up to RATE Hz
    {"t": "removed", "ids": [...]}
    {"t": "stats", "rtf": 0.98, "sim": 12.3, "paused": false}
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import threading
import time

from gz.msgs10.empty_pb2 import Empty
from gz.msgs10.pose_v_pb2 import Pose_V
from gz.msgs10.scene_pb2 import Scene
from gz.msgs10.uint32_v_pb2 import UInt32_V
from gz.msgs10.world_stats_pb2 import WorldStatistics
from gz.transport13 import Node

SCENE_SERVICE = re.compile(r"^/world/([^/]+)/scene/info$")
GEOMETRY = {0: "box", 1: "cylinder", 2: "sphere", 3: "plane", 5: "heightmap", 6: "mesh", 10: "cone",
            14: "capsule", 15: "ellipsoid"}


_out = threading.Lock()


def emit(obj: dict) -> None:
    line = json.dumps(obj, separators=(",", ":")) + "\n"
    with _out:  # transport threads emit too; lines must not interleave
        sys.stdout.write(line)
        sys.stdout.flush()


def vec(v) -> list[float]:
    return [round(v.x, 4), round(v.y, 4), round(v.z, 4)]


def pose(p) -> list[float]:
    o = p.orientation
    return vec(p.position) + [round(o.x, 5), round(o.y, 5), round(o.z, 5), round(o.w if o.w or o.x or o.y or o.z
                                                                                    else 1.0, 5)]


def color(c, present: bool) -> list[float] | None:
    return [round(c.r, 3), round(c.g, 3), round(c.b, 3), round(c.a, 3)] if present else None


def geometry(g) -> dict | None:
    kind = GEOMETRY.get(g.type)
    if kind == "box":
        return {"kind": kind, "size": vec(g.box.size)}
    if kind in ("cylinder", "capsule", "cone"):
        src = getattr(g, kind)
        return {"kind": kind, "radius": src.radius, "length": src.length}
    if kind == "sphere":
        return {"kind": kind, "radius": g.sphere.radius}
    if kind == "ellipsoid":
        return {"kind": kind, "radii": vec(g.ellipsoid.radii)}
    if kind == "plane":
        return {"kind": kind, "normal": vec(g.plane.normal), "size": [g.plane.size.x, g.plane.size.y]}
    if kind == "mesh":
        m = g.mesh
        return {"kind": kind, "file": m.filename, "scale": vec(m.scale) if m.HasField("scale") else [1, 1, 1],
                "submesh": m.submesh or None, "center": m.center_submesh}
    if kind == "heightmap":
        h = g.heightmap
        return {"kind": kind, "file": h.filename, "size": vec(h.size), "pos": vec(h.origin),
                "textures": [{"diffuse": t.diffuse, "normal": t.normal, "size": t.size} for t in h.texture]}
    return None


def material(m) -> dict:
    out = {"diffuse": color(m.diffuse, m.HasField("diffuse")),
           "ambient": color(m.ambient, m.HasField("ambient")),
           "emissive": color(m.emissive, m.HasField("emissive")),
           "double_sided": m.double_sided}
    if m.HasField("pbr"):
        p = m.pbr
        out.update(albedo_map=p.albedo_map or None, normal_map=p.normal_map or None,
                   metalness=p.metalness, roughness=p.roughness)
    return out


def visual(v) -> dict:
    return {"id": v.id, "name": v.name, "pose": pose(v.pose),
            "scale": vec(v.scale) if v.HasField("scale") else [1, 1, 1],
            "geometry": geometry(v.geometry), "material": material(v.material) if v.HasField("material") else None,
            "transparency": round(v.transparency, 3), "cast_shadows": v.cast_shadows}


def camera(sensor) -> dict | None:
    """A camera on a link, so the browser can show its view (Gazebo need not render it)."""
    if not sensor.HasField("camera"):
        return None
    c = sensor.camera
    return {"id": sensor.id, "name": sensor.name, "pose": pose(sensor.pose), "hfov": round(c.horizontal_fov, 4),
            "width": c.image_size.x, "height": c.image_size.y,
            "near": round(c.near_clip, 3) or 0.1, "far": round(c.far_clip, 1) or 1000.0}


def model(m) -> dict:
    return {"id": m.id, "name": m.name, "static": m.is_static, "pose": pose(m.pose),
            "links": [{"id": lk.id, "name": lk.name, "pose": pose(lk.pose),
                       "visuals": [visual(v) for v in lk.visual],
                       "cameras": [c for c in (camera(x) for x in lk.sensor) if c]} for lk in m.link],
            "models": [model(n) for n in m.model]}


def scene(s) -> dict:
    return {"name": s.name, "ambient": color(s.ambient, s.HasField("ambient")),
            "background": color(s.background, s.HasField("background")),
            "models": [model(m) for m in s.model],
            "lights": [{"name": li.name, "type": li.type, "pose": pose(li.pose), "direction": vec(li.direction),
                        "diffuse": color(li.diffuse, li.HasField("diffuse")), "intensity": li.intensity,
                        "cast_shadows": li.cast_shadows} for li in s.light]}


def find_world(node: Node, timeout: float) -> str | None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        for service in node.service_list():
            m = SCENE_SERVICE.match(service)
            if m:
                return m.group(1)
        time.sleep(0.5)
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeout", type=float, default=120, help="seconds to wait for a world")
    ap.add_argument("--rate", type=float, default=30, help="pose updates per second")
    args = ap.parse_args()

    node = Node()
    world = find_world(node, args.timeout)
    if world is None:
        emit({"t": "error", "text": "no Gazebo world found (is Gazebo running in this GZ_PARTITION?)"})
        return 1
    lock = threading.Lock()
    latest: dict[int, list[float]] = {}
    changed: set[int] = set()
    rescan = threading.Event()
    rescan.set()

    def on_poses(msg) -> None:
        with lock:
            for p in msg.pose:
                latest[p.id] = [p.id, *pose(p)]
                changed.add(p.id)

    def on_stats(msg) -> None:
        emit({"t": "stats", "rtf": round(msg.real_time_factor, 3),
              "sim": round(msg.sim_time.sec + msg.sim_time.nsec / 1e9, 2), "paused": msg.paused})

    def on_removed(msg) -> None:
        emit({"t": "removed", "ids": list(msg.data)})

    base = f"/world/{world}"
    topics = [(Pose_V, f"{base}/dynamic_pose/info", on_poses),
              (Scene, f"{base}/scene/info", lambda msg: rescan.set()),  # a model was added
              (UInt32_V, f"{base}/scene/deletion", on_removed),
              (WorldStatistics, f"{base}/stats", on_stats)]  # the world publishes this at ~5 Hz

    def subscribe(on: bool) -> None:
        for msg_type, topic, callback in topics:
            if on:
                node.subscribe(msg_type, topic, callback)
            else:
                node.unsubscribe(topic)

    # A request made while subscription callbacks run can stall until it times out (the
    # callbacks and the waiting request contend for the interpreter), so ask with no
    # subscriptions active: first before subscribing, later with them paused.
    subscribed = False
    period = 1 / args.rate
    while True:
        if rescan.is_set():
            if subscribed:
                subscribe(False)
            ok, sc = node.request(f"{base}/scene/info", Empty(), Empty, Scene, 10000)
            if ok:
                rescan.clear()
                emit({"t": "scene", "world": world, "scene": scene(sc)})
            elif not any(SCENE_SERVICE.match(s) and SCENE_SERVICE.match(s).group(1) == world
                         for s in node.service_list()):
                emit({"t": "error", "text": "the Gazebo world is gone"})
                return 0
            subscribe(True)
            subscribed = True
        time.sleep(period)
        with lock:
            batch = [latest[i] for i in changed]
            changed.clear()
        if batch:
            emit({"t": "poses", "p": batch})


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (BrokenPipeError, KeyboardInterrupt):
        sys.exit(0)
