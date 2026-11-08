"""Watching a Hangar run that another program started (`hangar up`, the TUI, a script).

Nothing is sent to it: telemetry comes from each vehicle's read-only monitor port (Hangar drops
whatever arrives there), and the 3D view reads Gazebo like it does for our own runs. A Watcher
looks enough like a Supervisor for the session: vehicles with links, logs, state, home.
"""

from __future__ import annotations

import asyncio
import time
from collections import deque
from pathlib import Path

from hangar import registry
from hangar.catalog import Catalog, VehicleModel
from hangar.mavlink import VehicleLink
from hangar.ports import PortPlan
from hangar.scenario import Scenario
from hangar.settings import Settings
from hangar.supervisor import LogLine, SimState, Supervisor, SupervisorError, VehicleRuntime

CHECK_EVERY = 2.0  # how often to see whether the run is still going on


class WatchedVehicle(VehicleRuntime):
    @property
    def status(self) -> str:
        if self.link and self.link.telemetry.alive:
            return "online"
        if self.link and self.link.telemetry.connected:
            return "silent"
        return "booting"


def find_run(run: str) -> dict:
    """An active run by its name (or the start of it), "latest" for the newest one."""
    runs = registry.active_runs()
    if not runs:
        raise SupervisorError("no Hangar run is going on")
    if run in ("", "latest"):
        return runs[-1]
    hits = [r for r in runs if r.get("run") == run] or [r for r in runs if str(r.get("run", "")).startswith(run)]
    if len(hits) != 1:
        names = ", ".join(r.get("run", "?") for r in runs)
        raise SupervisorError(f"no single run matches '{run}' (going on: {names})")
    return hits[0]


class Watcher:
    watching = True

    def __init__(self, entry: dict, settings: Settings, on_state=None, on_log=None):
        self.entry = entry
        self.on_state, self.on_log = on_state, on_log
        cfg = Path(entry.get("config") or "")
        self.settings = Settings.load(cfg) if cfg.is_file() else settings  # the run's own models
        self.catalog = Catalog(self.settings)
        self.run_dir = Path(entry["run_dir"])
        try:
            self.scenario = Scenario.load(self.run_dir / "scenario.yaml")
        except (OSError, ValueError) as e:
            raise SupervisorError(f"cannot read the run's scenario: {e}") from e
        self._helper = Supervisor(self.scenario, self.settings, self.catalog)  # never started
        self._helper.run_dir = self.run_dir
        self.state = SimState.STARTING
        self.started_at: float | None = entry.get("running_since") or entry.get("started")
        self.logs: deque[LogLine] = deque(maxlen=3000)
        self.vehicles: list[WatchedVehicle] = []
        self._task: asyncio.Task | None = None

        missing = [v["name"] for v in entry.get("vehicles", []) if not v.get("monitor")]
        if missing:
            raise SupervisorError(f"{', '.join(missing)} has no monitor port (started with Hangar older "
                                  "than 0.3.7, or with `monitor: false`)")
        poses = self.scenario.placed_poses()
        planned = {p.name: p for p in PortPlan.build(self.scenario, {}, {}).vehicles}
        by_name = {v.name: (v, p) for v, p in zip(self.scenario.vehicles, poses, strict=True)}
        for ev in entry.get("vehicles", []):
            spec, pose = by_name.get(ev["name"], (None, [0.0] * 6))
            if spec is None:
                continue
            model = self.catalog.get(spec.model) or VehicleModel(
                ev.get("model") or spec.model, ev.get("type") or "plane", "gazebo" if entry.get("world") else "builtin")
            host, _, port = ev["monitor"].removeprefix("tcp:").rpartition(":")
            ports = planned[ev["name"]]
            v = WatchedVehicle(spec, model, ports, self.run_dir / ev["name"], pose=pose)
            v.link = VehicleLink(ev["name"], ev.get("sysid") or ports.sysid, int(port), [],
                                 on_text=self._vehicle_text, host=host or "127.0.0.1")
            self.vehicles.append(v)

    # --- the parts of Supervisor the session uses ---------------------------

    @property
    def uses_gazebo(self) -> bool:
        return bool(self.entry.get("world"))

    def gazebo_env(self) -> dict[str, str]:
        return self._helper.gazebo_env()

    def home(self):
        return self._helper.home()

    def sim_speed(self) -> float | None:
        speeds = [v.link.telemetry.sim_speed for v in self.vehicles if v.link and v.link.telemetry.sim_speed]
        return min(speeds) if speeds else None

    def vehicle(self, name: str):
        for v in self.vehicles:
            if v.name == name:
                return v
        raise SupervisorError(f"no vehicle named {name}")

    def log(self, source: str, text: str, level: str = "info") -> None:
        line = LogLine(time.time(), source, level, text)
        self.logs.append(line)
        if self.on_log:
            self.on_log(line)

    def _vehicle_text(self, name: str, level: str, text: str) -> None:
        if text.startswith(("waiting for SITL", "connected to tcp")):
            text = text.replace("SITL", "the monitor port")
        self.log(name, text, level)

    def _set_state(self, state: SimState) -> None:
        self.state = state
        if self.on_state:
            self.on_state(state)

    # --- running ----------------------------------------------------------

    async def start(self) -> None:
        e = self.entry
        self.log("cloud", f"watching {e.get('run')} ({e.get('owner') or 'unknown owner'}, pid {e.get('pid')}): "
                          "read-only, commands are off", "event")
        for v in self.vehicles:
            await v.link.start()
        self._set_state(SimState.RUNNING)
        self._task = asyncio.create_task(self._follow())

    async def _follow(self) -> None:
        """Until the run ends (or we are told to stop)."""
        key = (self.entry.get("pid"), self.entry.get("run_dir"))
        while True:
            await asyncio.sleep(CHECK_EVERY)
            alive = any((r.get("pid"), r.get("run_dir")) == key for r in await asyncio.to_thread(registry.active_runs))
            if not alive:
                self.log("cloud", "the run ended", "event")
                await self._close()
                return

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            self._task = None
        await self._close()

    async def _close(self) -> None:
        if self.state == SimState.IDLE:
            return
        self._set_state(SimState.STOPPING)
        await asyncio.gather(*(v.link.stop() for v in self.vehicles if v.link), return_exceptions=True)
        self._set_state(SimState.IDLE)
