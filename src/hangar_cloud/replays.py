"""Recorded runs to play back: replay files (version 1) in the folders given to `serve --replay-dir`,
and Hangar's own runs that recorded their tracks (Hangar 0.3.8 and later).

A replay is named by its path relative to one of those folders (``h8_t7/replay.json.gz``), or
``run:<run folder>`` for a Hangar run. Nothing outside the folders is ever opened.
"""

from __future__ import annotations

import gzip
import json
from pathlib import Path

from hangar import paths
from hangar import track as hangar_track

NAMES = ("replay.json", "replay.json.gz")
MAX_DEPTH = 3  # folders below a replay folder that are searched
MAX_LISTED = 500
MAX_BYTES = 200 * 1024 * 1024


def _is_replay(p: Path) -> bool:
    return p.name in NAMES or p.name.endswith((".replay.json", ".replay.json.gz"))


def _walk(root: Path, depth: int = 0):
    try:
        entries = sorted(root.iterdir())
    except OSError:
        return
    for p in entries:
        if p.is_file() and _is_replay(p):
            yield p
        elif p.is_dir() and not p.is_symlink() and depth < MAX_DEPTH and not p.name.startswith("."):
            yield from _walk(p, depth + 1)


def list_replays(dirs: list[Path]) -> list[dict]:
    """Newest first: files in the replay folders, then Hangar's recorded runs."""
    out = []
    for d in dirs:
        for f in _walk(d):
            st = f.stat()
            rel = f.relative_to(d).as_posix()
            out.append({"id": rel, "name": f.parent.name if f.name in NAMES else f.name.split(".replay")[0],
                        "source": str(d), "size": st.st_size, "time": st.st_mtime})
    runs = paths.runs_dir()
    if runs.is_dir():
        for r in runs.iterdir():
            if r.is_dir() and not r.is_symlink() and hangar_track.has_track(r):
                out.append({"id": f"run:{r.name}", "name": r.name, "source": "hangar", "size": None,
                            "time": r.stat().st_mtime})
    out.sort(key=lambda x: x["time"], reverse=True)
    return out[:MAX_LISTED]


def _inside(path: Path, root: Path) -> bool:
    try:
        return path.resolve().is_relative_to(root.resolve())
    except OSError:
        return False


def resolve(rid: str, dirs: list[Path]) -> Path:
    """The file a replay id names. Raises KeyError for anything that is not one."""
    if rid.startswith("run:"):
        name = rid[4:]
        run = paths.runs_dir() / name
        if not name or "/" in name or name.startswith(".") or not hangar_track.has_track(run):
            raise KeyError(rid)
        return run
    if not rid or rid.startswith("/") or "\\" in rid or any(part in ("", ".", "..") for part in rid.split("/")):
        raise KeyError(rid)
    for d in dirs:
        f = d / rid
        if f.is_file() and _is_replay(f) and _inside(f, d):
            return f
    raise KeyError(rid)


def load(rid: str, dirs: list[Path]) -> bytes:
    """The replay as gzip-compressed JSON (sent as it is, with Content-Encoding: gzip)."""
    p = resolve(rid, dirs)
    if p.is_dir():
        data = hangar_track.build(p)
        return gzip.compress(json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8"), 6)
    if p.stat().st_size > MAX_BYTES:
        raise ValueError("replay file too big")
    raw = p.read_bytes()
    if p.suffix == ".gz":
        text = gzip.decompress(raw)
    else:
        text, raw = raw, gzip.compress(raw, 6)
    try:
        version = json.loads(text).get("version")
    except ValueError as e:
        raise ValueError(f"not a JSON file: {e}") from e
    if version != 1:
        raise ValueError(f"replay format version {version!r}; this server reads version 1")
    return raw


def side_file(rid: str, name: str, dirs: list[Path]) -> Path:
    """A file next to a replay (an event's video): same folder, plain name."""
    p = resolve(rid, dirs)
    folder = p if p.is_dir() else p.parent
    if not name or "/" in name or "\\" in name or name.startswith("."):
        raise KeyError(name)
    f = folder / name
    if not f.is_file() or not _inside(f, folder):
        raise KeyError(name)
    return f
