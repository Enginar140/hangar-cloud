"""Parameter descriptions (names, units, ranges, choices) from ArduPilot's published metadata.

They are downloaded only when the user asks, from autotest.ardupilot.org, for the firmware
version the vehicle reports, and kept on disk afterwards.
"""

from __future__ import annotations

import json
import re
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

from hangar import paths

BASE = "https://autotest.ardupilot.org/Parameters"
FIRMWARE = {"copter": "Copter", "plane": "Plane", "rover": "Rover", "boat": "Rover"}
LATEST = {"Copter": "ArduCopter", "Plane": "ArduPlane", "Rover": "Rover"}
MAX_BYTES = 40 * 1024 * 1024
FORMAT = 1  # of the cached files; another one is downloaded again
STABLE = re.compile(r'href="stable-(\d+)\.(\d+)\.(\d+)/"')


def cache_dir() -> Path:
    return paths.data_dir() / "cloud" / "params"


def firmware(vehicle_type: str) -> str:
    try:
        return FIRMWARE[vehicle_type]
    except KeyError:
        raise ValueError(f"no parameter descriptions for {vehicle_type} vehicles") from None


def cache_file(fw: str, version: str | None) -> Path:
    return cache_dir() / f"{fw}-{version or 'latest'}.json"


def cached(vehicle_type: str, version: str | None) -> dict | None:
    f = cache_file(firmware(vehicle_type), version)
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if data.get("format") == FORMAT else None


def pick_version(listing: str, version: str) -> str | None:
    """The published stable release closest to `version` without being newer, same major.minor."""
    want = tuple(int(x) for x in version.split("."))
    found = sorted({tuple(int(x) for x in m) for m in STABLE.findall(listing)})
    same = [v for v in found if v[:2] == want[:2] and v <= want]
    return ".".join(map(str, same[-1])) if same else None


def parse_pdef(xml: bytes) -> dict[str, dict]:
    """apm.pdef.xml as {NAME: {n: title, d: description, u: units, r: [low, high], i: increment,
    v: {value: label}, b: {bit: label}, rb: reboot needed, ro: read-only, vol: changes by itself,
    adv: advanced}}."""
    out: dict[str, dict] = {}
    root = ET.fromstring(xml)
    for p in root.iter("param"):
        name = p.get("name", "").rpartition(":")[2]
        if not name:
            continue
        meta: dict = {"n": p.get("humanName", ""), "d": p.get("documentation", "")}
        if p.get("user") not in (None, "Standard"):
            meta["adv"] = 1
        for f in p.findall("field"):
            key, text = f.get("name"), (f.text or "").strip()
            if key == "Units":
                meta["u"] = text
            elif key == "Range":
                lo, _, hi = text.partition(" ")
                try:
                    meta["r"] = [float(lo), float(hi)]
                except ValueError:
                    pass
            elif key == "Increment":
                try:
                    meta["i"] = float(text)
                except ValueError:
                    pass
            elif key == "RebootRequired" and text == "True":
                meta["rb"] = 1
            elif key == "ReadOnly" and text == "True":
                meta["ro"] = 1
            elif key == "Volatile" and text == "True":
                meta["vol"] = 1
        values = {v.get("code"): (v.text or "").strip() for v in p.iter("value")}
        if values:
            meta["v"] = values
        bits = {b.get("code"): (b.text or "").strip() for b in p.iter("bit")}
        if bits:
            meta["b"] = bits
        out.setdefault(name, meta)  # vehicle-specific entries come first
    return out


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "hangar-cloud"})
    with urllib.request.urlopen(req, timeout=60) as r:  # noqa: S310 (fixed https host)
        data = r.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("parameter list too big")
    return data


def download(vehicle_type: str, version: str | None) -> dict:
    """Fetch, parse and cache. Blocking: run it in a thread."""
    fw = firmware(vehicle_type)
    source, release = f"{BASE}/{LATEST[fw]}/apm.pdef.xml", None
    if version:
        try:
            release = pick_version(_get(f"{BASE}/versioned/{fw}/").decode("utf-8", "replace"), version)
        except OSError:
            release = None
        if release:
            source = f"{BASE}/versioned/{fw}/stable-{release}/apm.pdef.xml"
    params = parse_pdef(_get(source))
    if not params:
        raise ValueError("the downloaded list has no parameters")
    data = {"format": FORMAT, "firmware": fw, "version": version, "release": release or "latest", "source": source,
            "params": params}
    f = cache_file(fw, version)
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    tmp.replace(f)
    return data
