"""One simulation at a time, run by Hangar's Supervisor, watched by any number of browser tabs."""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from dataclasses import asdict
from pathlib import Path

from hangar import paths
from hangar.catalog import Catalog
from hangar.scenario import Scenario
from hangar.settings import Settings
from hangar.supervisor import LogLine, SimState, Supervisor, SupervisorError

from . import params as param_meta

BRIDGE = Path(__file__).with_name("gzbridge.py")
TELEMETRY_EVERY = 0.5  # seconds
KIND = re.compile(r'^\{"t":"(\w+)"')
LINE_LIMIT = 64 * 1024 * 1024  # a big city's scene is one JSON line
EXAMPLES = Path(__file__).with_name("scenarios")


def find_gz_python(preferred: str | None = None) -> str | None:
    """A Python that can import Gazebo's bindings (they come with Gazebo, for the system Python)."""
    candidates = [preferred] if preferred else ["/usr/bin/python3", shutil.which("python3"), sys.executable]
    for exe in candidates:
        if not exe:
            continue
        try:
            ok = subprocess.run([exe, "-I", "-c", "import gz.transport13, gz.msgs10"],
                                capture_output=True, timeout=20).returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            ok = False
        if ok:
            return exe
    return None


class Hub:
    """Fan-out of events to the connected browsers. A slow tab loses messages, never blocks the sim."""

    def __init__(self) -> None:
        self.clients: set[asyncio.Queue[str]] = set()

    def connect(self) -> asyncio.Queue[str]:
        q: asyncio.Queue[str] = asyncio.Queue(maxsize=2000)
        self.clients.add(q)
        return q

    def disconnect(self, q: asyncio.Queue[str]) -> None:
        self.clients.discard(q)

    def publish(self, msg: dict | str) -> None:
        text = msg if isinstance(msg, str) else json.dumps(msg, separators=(",", ":"))
        for q in self.clients:
            if q.full():
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            q.put_nowait(text)


def scenario_dirs() -> list[tuple[str, Path]]:
    return [("saved", paths.data_dir() / "cloud" / "scenarios"),
            ("example", EXAMPLES),
            ("example", paths.package_data() / "scenarios")]


def list_scenarios() -> list[dict]:
    out = []
    last = paths.state_dir() / "last-scenario.yaml"
    if last.exists():
        out.append({"id": "last", "name": "last scenario of the terminal UI", "kind": "last"})
    for kind, d in scenario_dirs():
        for f in sorted(d.glob("*.yaml")) if d.is_dir() else []:
            out.append({"id": f"{kind}:{f.stem}", "name": f.stem, "kind": kind})
    return out


def scenario_path(sid: str) -> Path:
    if sid == "last":
        return paths.state_dir() / "last-scenario.yaml"
    kind, _, name = sid.partition(":")
    if not name or "/" in name or name.startswith("."):
        raise KeyError(sid)
    dirs = [d for k, d in scenario_dirs() if k == kind]
    for d in dirs:
        if (d / f"{name}.yaml").exists():
            return d / f"{name}.yaml"
    if dirs:
        return dirs[0] / f"{name}.yaml"
    raise KeyError(sid)


class Session:
    def __init__(self, settings: Settings, gz_python: str | None, gazebo_window: bool = False) -> None:
        self.settings = settings
        self.catalog = Catalog(settings)
        self.gz_python = gz_python
        self.hub = Hub()
        self.gazebo_window = gazebo_window
        self.scenario_id = self.default_scenario()
        self.scenario: Scenario = Scenario.load(scenario_path(self.scenario_id))
        self.sup: Supervisor | None = None
        self.scene: str | None = None  # last scene message, for tabs that connect later
        self.stats: dict | None = None
        self._bridge: asyncio.subprocess.Process | None = None
        self._tasks: set[asyncio.Task] = set()
        self._telemetry: asyncio.Task | None = None

    # --- scenario --------------------------------------------------------

    def default_scenario(self) -> str:
        """The Gazebo example when its world and models are here (the 3D view is the point),
        else ArduPilot's built-in physics."""
        sc = Scenario.load(EXAMPLES / "runway-3d.yaml")
        ok = self.gz_python and sc.world in self.catalog.worlds and \
            all(self.catalog.get(v.model) for v in sc.vehicles)
        return "example:runway-3d" if ok else "example:quickstart"

    def _running_scenario(self) -> Scenario:
        """Gazebo runs without its own window: nobody sits at a server's screen, and the page
        shows the scene. `serve --gazebo-window` keeps the scenario's choice."""
        if self.gazebo_window or self.scenario.headless:
            return self.scenario
        return self.scenario.model_copy(update={"headless": True})

    @property
    def state(self) -> SimState:
        return self.sup.state if self.sup else SimState.IDLE

    @property
    def busy(self) -> bool:
        return self.state in (SimState.STARTING, SimState.RUNNING, SimState.STOPPING)

    def set_scenario(self, text: str, sid: str | None = None) -> Scenario:
        import yaml

        sc = Scenario.model_validate(yaml.safe_load(text) or {})
        self.scenario, self.scenario_id = sc, sid or "edited"
        self.hub.publish({"t": "scenario", "id": self.scenario_id, "yaml": sc.dump()})
        return sc

    def load(self, sid: str) -> Scenario:
        return self.set_scenario(scenario_path(sid).read_text(encoding="utf-8"), sid)

    def save(self, name: str) -> str:
        if not name or "/" in name or name.startswith("."):
            raise ValueError("bad name")
        d = scenario_dirs()[0][1]
        d.mkdir(parents=True, exist_ok=True)
        self.scenario.save(d / f"{name}.yaml")
        self.scenario_id = f"saved:{name}"
        return self.scenario_id

    def preflight(self) -> dict:
        pf = Supervisor(self._running_scenario(), self.settings, self.catalog).preflight()
        return {"errors": pf.errors, "warnings": pf.warnings}

    # --- running ---------------------------------------------------------

    def _on_log(self, line: LogLine) -> None:
        self.hub.publish({"t": "log", "line": _log(line)})

    def _on_state(self, state: SimState) -> None:
        self.hub.publish({"t": "state", "state": state.value})
        if state == SimState.RUNNING:
            self._spawn(self._run_bridge())

    def _spawn(self, coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._done)
        return task

    def _done(self, task: asyncio.Task) -> None:
        self._tasks.discard(task)
        if task.cancelled():
            return
        e = task.exception()
        # a failed start is already in the simulation's log; anything else should be seen too
        if e is not None and not isinstance(e, SupervisorError) and self.sup:
            self.sup.log("cloud", f"{type(e).__name__}: {e}", "error")

    async def start(self) -> None:
        if self.busy:
            raise SupervisorError(f"simulation is {self.state.value}")
        sup = Supervisor(self._running_scenario(), self.settings, self.catalog, on_log=self._on_log,
                         on_state=self._on_state)
        pf = await asyncio.to_thread(sup.preflight)
        if pf.errors:  # say why right away instead of only in the log
            raise SupervisorError("; ".join(pf.errors))
        self.scene = self.stats = None
        self.hub.publish({"t": "scene_clear"})
        self.sup = sup
        if self._telemetry is None or self._telemetry.done():
            self._telemetry = self._spawn(self._send_telemetry())
        self._spawn(self.sup.start())

    async def stop(self) -> None:
        await self._stop_bridge()
        if self.sup and self.state != SimState.IDLE:
            await self.sup.stop()

    def _vehicle(self, vehicle: str):
        if not self.sup:
            raise SupervisorError("nothing is running")
        v = self.sup.vehicle(vehicle)
        if not v.link:
            raise SupervisorError(f"{vehicle} has no MAVLink connection yet")
        return v

    async def command(self, vehicle: str, line: str) -> str:
        return await self._vehicle(vehicle).link.run(line)

    # --- parameters ----------------------------------------------------------

    def params(self, vehicle: str) -> dict:
        v = self._vehicle(vehicle)
        link = v.link
        return {"vehicle": v.name, "type": v.model.type, "version": link.telemetry.version,
                "count": link.param_count, "complete": link.params_complete, "changed": link.params_changed,
                "params": {n: [x, link.param_is_int(n)] for n, x in sorted(link.params.items())}}

    async def fetch_params(self, vehicle: str) -> dict:
        await self._vehicle(vehicle).link.fetch_params()
        return self.params(vehicle)

    async def set_param(self, vehicle: str, name: str, value: float) -> float:
        return await self._vehicle(vehicle).link.set_param(name, value)

    async def param_meta(self, vehicle: str, download: bool = False) -> dict | None:
        """Descriptions for the vehicle's firmware: from the cache, or downloaded when asked."""
        v = self._vehicle(vehicle)
        version = v.link.telemetry.version
        data = param_meta.cached(v.model.type, version)
        if data is None and download:
            data = await asyncio.to_thread(param_meta.download, v.model.type, version)
        return data

    async def add_output(self, url: str, scope: str) -> None:
        if not self.sup:
            raise SupervisorError("nothing is running")
        await self.sup.add_output(url, scope)

    async def remove_output(self, url: str, scope: str) -> None:
        if not self.sup:
            raise SupervisorError("nothing is running")
        await self.sup.remove_output(url, scope)

    # --- telemetry ---------------------------------------------------------

    def vehicles(self) -> list[dict]:
        if not self.sup:
            return []
        out = []
        for v in self.sup.vehicles:
            tel = asdict(v.link.telemetry) if v.link else {}
            tel.pop("last_heartbeat", None)
            modes = v.link.mode_names() if v.link and v.link.telemetry.mav_type is not None else []
            link = v.link
            params = {"have": len(link.params), "count": link.param_count, "changed": link.params_changed} \
                if link else None
            out.append({"name": v.name, "model": v.spec.model, "sysid": v.ports.sysid, "status": v.status,
                        "kind": v.model.type, "modes": modes, "view": view_camera(v), "params": params,
                        "gazebo": v.model.needs_gazebo, "pose": v.pose, "telemetry": tel,
                        "script_ports": [v.ports.serial1, v.ports.serial2]})
        return out

    def snapshot(self) -> dict:
        sup = self.sup
        scenario = {"id": self.scenario_id, "name": self.scenario.name, "yaml": self.scenario.dump()}
        return {"state": self.state.value, "scenario": scenario,
                "vehicles": self.vehicles(), "sim_speed": sup.sim_speed() if sup else None,
                "logs": [_log(x) for x in list(sup.logs)[-500:]] if sup else [],
                "gazebo_view": bool(self.gz_python), "stats": self.stats,
                "outputs": {"*": list(self.scenario.outputs),
                            **{v.name: list(v.outputs) for v in self.scenario.vehicles if v.name and v.outputs}},
                "started_at": sup.started_at if sup else None,
                "home": _home(sup or Supervisor(self.scenario, self.settings, self.catalog))}

    async def _send_telemetry(self) -> None:
        while True:
            await asyncio.sleep(TELEMETRY_EVERY)
            if self.sup and self.hub.clients:
                self.hub.publish({"t": "vehicles", "vehicles": self.vehicles(), "sim_speed": self.sup.sim_speed()})

    # --- Gazebo -> browser ---------------------------------------------------

    async def _run_bridge(self) -> None:
        sup = self.sup
        if not (sup and sup.uses_gazebo and self.gz_python):
            return
        await self._stop_bridge()
        env = sup.gazebo_env()
        proc = await asyncio.create_subprocess_exec(
            self.gz_python, "-I", str(BRIDGE), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env=env, limit=LINE_LIMIT, start_new_session=True)
        self._bridge = proc
        self._spawn(self._bridge_errors(proc))
        assert proc.stdout
        while True:
            try:
                raw = await proc.stdout.readline()
            except ValueError:  # a line over LINE_LIMIT
                sup.log("cloud", "the Gazebo scene is too big to show", "warning")
                break
            if not raw:
                break
            text = raw.decode("utf-8", "replace").rstrip("\n")
            m = KIND.match(text)
            kind = m.group(1) if m else ""
            if kind == "scene":
                text = self.scene = json.dumps(self.prepare_scene(json.loads(text)), separators=(",", ":"))
            elif kind == "stats":
                self.stats = json.loads(text)
            elif kind == "error":
                sup.log("cloud", json.loads(text)["text"], "warning")
            self.hub.publish(text)
        await proc.wait()

    def resource_paths(self) -> list[str]:
        sup = self.sup or Supervisor(self.scenario, self.settings, self.catalog)
        return [p for p in sup.gazebo_env().get("GZ_SIM_RESOURCE_PATH", "").split(os.pathsep) if p]

    def prepare_scene(self, msg: dict) -> dict:
        return with_terrain_heights(resolve_uris(msg, self.resource_paths()))

    async def _bridge_errors(self, proc: asyncio.subprocess.Process) -> None:
        assert proc.stderr
        async for raw in proc.stderr:
            line = raw.decode("utf-8", "replace").rstrip()
            if line and self.sup:
                self.sup.log("cloud", f"3D view: {line}", "warning")

    async def _stop_bridge(self) -> None:
        proc, self._bridge = self._bridge, None
        if proc and proc.returncode is None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                return
            try:
                await asyncio.wait_for(proc.wait(), 5)
            except TimeoutError:
                os.killpg(proc.pid, signal.SIGKILL)

    async def close(self) -> None:
        await self.stop()
        for t in list(self._tasks):
            t.cancel()


def _home(sup: Supervisor) -> dict | None:
    try:
        h = sup.home()
    except Exception:  # an unfinished scenario
        return None
    return {"lat": h.lat, "lon": h.lon, "alt": h.alt, "heading": h.heading}


def view_camera(v) -> dict:
    """Where the browser puts a vehicle's camera when the model has no camera sensor:
    the scenario's camera settings, else the model's usual mount, else the nose."""
    from hangar.scenario import CameraSpec

    spec = v.spec.camera or CameraSpec()
    pose = spec.pose or v.model.camera_pose or [0.3, 0.0, 0.05, 0.0, 10.0, 0.0]
    pose = list(pose) + [0.0] * (6 - len(pose))
    return {"pose": pose, "hfov_deg": spec.fov, "width": spec.width, "height": spec.height}


def _visuals(msg: dict):
    def walk(m: dict):
        for link in m["links"]:
            yield from link["visuals"]
        for n in m["models"]:
            yield from walk(n)

    for m in msg["scene"]["models"]:
        yield from walk(m)


def resolve_uri(uri: str, resource_paths: list[str]) -> str:
    """model://name/rest and file:// URIs as plain paths, the way Gazebo finds them."""
    if uri.startswith("file://"):
        return uri[7:]
    if uri.startswith("model://"):
        name, _, rest = uri[8:].partition("/")
        for root in resource_paths:
            candidate = Path(root) / name / rest
            if candidate.exists():
                return str(candidate)
    return uri


def resolve_uris(msg: dict, resource_paths: list[str]) -> dict:
    for v in _visuals(msg):
        g = v.get("geometry") or {}
        if g.get("file"):
            g["file"] = resolve_uri(g["file"], resource_paths)
        for t in g.get("textures", []):
            for key in ("diffuse", "normal"):
                if t.get(key):
                    t[key] = resolve_uri(t[key], resource_paths)
        mat = v.get("material") or {}
        for key in ("albedo_map", "normal_map"):
            if mat.get(key):
                mat[key] = resolve_uri(mat[key], resource_paths)
    return msg


def with_terrain_heights(msg: dict) -> dict:
    """Point heightmaps made by hangar-earth at their exact heights (16-bit PNGs lose
    precision in a browser canvas, which reads 8 bits per channel)."""

    def walk(m: dict) -> None:
        for link in m["links"]:
            for v in link["visuals"]:
                g = v.get("geometry") or {}
                if g.get("kind") == "heightmap" and g.get("file"):
                    meta = Path(g["file"]).with_name("hangar-earth.json")
                    try:
                        h = json.loads(meta.read_text(encoding="utf-8"))["heights"]
                        g["heights"] = {"file": str(meta.with_name(h["file"])), "n": int(h["n"]), "scale": 0.1}
                    except (OSError, ValueError, KeyError, TypeError):
                        pass
        for n in m["models"]:
            walk(n)

    for m in msg["scene"]["models"]:
        walk(m)
    return msg


def _log(line: LogLine) -> dict:
    return {"time": line.time, "source": line.source, "level": line.level, "text": line.text,
            "clock": time.strftime("%H:%M:%S", time.localtime(line.time))}
