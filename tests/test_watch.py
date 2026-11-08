"""Watching a run another program started: read-only, follows it until it ends."""

import asyncio
import json
import subprocess
import sys

import pytest
from pymavlink.dialects.v20 import ardupilotmega as mav

from hangar_cloud import watch


@pytest.fixture
def env(tmp_path, monkeypatch):
    for var in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"):
        monkeypatch.setenv(var, str(tmp_path / var.lower()))
    monkeypatch.setattr(watch, "CHECK_EVERY", 0.1)
    return tmp_path


async def _monitor(received: list):
    """A vehicle's monitor port, as Hangar's router offers it."""
    enc = mav.MAVLink(None, srcSystem=1, srcComponent=1)

    async def client(reader, writer):
        async def talk():
            while True:
                writer.write(enc.heartbeat_encode(mav.MAV_TYPE_QUADROTOR, mav.MAV_AUTOPILOT_ARDUPILOTMEGA,
                                                  1, 0, 3).pack(enc))
                writer.write(enc.global_position_int_encode(0, 400000000, 290000000, 100000, 12500,
                                                            0, 0, 0, 9000).pack(enc))
                await asyncio.sleep(0.1)

        task = asyncio.create_task(talk())
        try:
            while data := await reader.read(4096):
                received.append(data)
        finally:
            task.cancel()

    return await asyncio.start_server(client, "127.0.0.1", 0)


def test_watch_a_run_until_it_ends(env):
    from hangar import registry
    from hangar.settings import Settings
    from hangar.supervisor import SupervisorError

    from hangar_cloud.session import Session

    run_dir = env / "run"
    run_dir.mkdir()
    (run_dir / "scenario.yaml").write_text("name: duel\nvehicles: [{model: sitl:copter, name: a}]\n")
    other = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])

    async def main():
        received: list = []
        server = await _monitor(received)
        port = server.sockets[0].getsockname()[1]
        registry.active_dir().mkdir(parents=True, exist_ok=True)
        (registry.active_dir() / f"{other.pid}-run.json").write_text(json.dumps({
            "pid": other.pid, "proc_start": registry.process_start(other.pid), "run": "run",
            "run_dir": str(run_dir), "state": "running", "started": 1, "owner": "savasan:t7",
            "scenario": "duel", "world": None,
            "vehicles": [{"name": "a", "model": "sitl:copter", "type": "copter", "sysid": 1,
                          "mavlink": "tcp:127.0.0.1:5760", "monitor": f"tcp:127.0.0.1:{port}"}]}))

        session = Session(Settings(), gz_python=None)
        watching = await session.attach("latest")
        assert watching == {"run": "run", "owner": "savasan:t7", "pid": other.pid, "scenario": "duel"}
        await asyncio.sleep(0.6)
        [v] = session.vehicles()
        assert v["status"] == "online" and v["telemetry"]["alt_rel"] == 12.5
        assert session.snapshot()["watching"]["run"] == "run"
        with pytest.raises(SupervisorError, match="read-only"):
            await session.command("a", "arm")
        with pytest.raises(SupervisorError, match="read-only"):
            await session.set_param("a", "SIM_WIND_SPD", 3)
        with pytest.raises(SupervisorError):
            await session.start()

        other.kill()
        other.wait()
        for _ in range(30):
            await asyncio.sleep(0.1)
            if session.state.value == "idle":
                break
        assert session.state.value == "idle" and session.watching is None
        await session.close()
        server.close()

    try:
        asyncio.run(main())
    finally:
        other.kill()
        other.wait()


def test_attach_explains_what_is_missing(env):
    from hangar.supervisor import SupervisorError

    with pytest.raises(SupervisorError, match="no Hangar run is going on"):
        watch.find_run("latest")
