"""The web app: REST for actions, one WebSocket for everything that changes."""

from __future__ import annotations

import asyncio
import contextlib
import gzip
import hmac
import json
import secrets
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from hangar import __version__ as hangar_version
from hangar.mavlink import CommandError
from hangar.supervisor import SupervisorError
from pydantic import BaseModel

from . import __version__
from .session import Session, list_scenarios

WEB = Path(__file__).with_name("web")
COOKIE = "hangar_cloud"


class ScenarioText(BaseModel):
    yaml: str


class ScenarioRef(BaseModel):
    id: str


class SaveAs(BaseModel):
    name: str


class Command(BaseModel):
    line: str


class ParamSet(BaseModel):
    name: str
    value: float


class Output(BaseModel):
    url: str
    scope: str = "*"


def create_app(session: Session, token: str) -> FastAPI:
    app = FastAPI(title="Hangar Cloud", version=__version__, docs_url=None, redoc_url=None, openapi_url=None)
    files = SceneFiles()

    def authorised(cookie: str | None) -> bool:
        return bool(cookie) and hmac.compare_digest(cookie, token)

    @app.middleware("http")
    async def guard(request: Request, call_next):
        path = request.url.path
        given = request.query_params.get("token")
        if given is not None:
            if not hmac.compare_digest(given, token):
                return Response("wrong token", status_code=403)
            resp = RedirectResponse(path if path != "/login" else "/", status_code=303)
            resp.set_cookie(COOKIE, token, httponly=True, samesite="strict", max_age=30 * 86400,
                            secure=request.url.scheme == "https")
            return resp
        if not authorised(request.cookies.get(COOKIE)):
            if path == "/":
                return FileResponse(WEB / "login.html")
            if path in ("/style.css", "/favicon.svg"):
                return await call_next(request)
            return JSONResponse({"error": "not logged in"}, status_code=401)
        if request.method != "GET" and not _same_origin(request.headers):
            return JSONResponse({"error": "cross-site request"}, status_code=403)
        return await call_next(request)

    def fail(e: Exception) -> HTTPException:
        return HTTPException(400, str(e) or "no such vehicle")

    @app.get("/api/info")
    async def info():
        return {"version": __version__, "hangar": hangar_version, "scenarios": list_scenarios(),
                "models": sorted(session.catalog.vehicles), "worlds": sorted(session.catalog.worlds),
                **session.snapshot()}

    @app.post("/api/scenario")
    async def set_scenario(body: ScenarioText):
        if session.busy:
            raise HTTPException(409, "stop the simulation first")
        try:
            session.set_scenario(body.yaml)
        except Exception as e:  # yaml or validation
            raise fail(e) from e
        return {"ok": True, **session.preflight()}

    @app.post("/api/scenario/load")
    async def load(body: ScenarioRef):
        if session.busy:
            raise HTTPException(409, "stop the simulation first")
        try:
            session.load(body.id)
        except (KeyError, OSError, ValueError) as e:
            raise fail(e) from e
        return {"ok": True, **session.preflight()}

    @app.post("/api/scenario/save")
    async def save(body: SaveAs):
        try:
            return {"id": session.save(body.name)}
        except (ValueError, OSError) as e:
            raise fail(e) from e

    @app.get("/api/preflight")
    async def preflight():
        return session.preflight()

    @app.post("/api/start")
    async def start():
        try:
            await session.start()
        except SupervisorError as e:
            raise fail(e) from e
        return {"ok": True}

    @app.post("/api/stop")
    async def stop():
        await session.stop()
        return {"ok": True}

    @app.post("/api/vehicles/{name}/command")
    async def command(name: str, body: Command):
        try:
            return {"result": await session.command(name, body.line)}
        except (SupervisorError, CommandError) as e:
            raise fail(e) from e

    @app.get("/api/vehicles/{name}/params")
    async def params(name: str):
        try:
            return session.params(name)
        except SupervisorError as e:
            raise fail(e) from e

    @app.post("/api/vehicles/{name}/params/fetch")
    async def fetch_params(name: str):
        try:
            return await session.fetch_params(name)
        except (SupervisorError, CommandError) as e:
            raise fail(e) from e

    @app.post("/api/vehicles/{name}/params")
    async def set_param(name: str, body: ParamSet):
        try:
            return {"name": body.name.upper(), "value": await session.set_param(name, body.name, body.value)}
        except (SupervisorError, CommandError) as e:
            raise fail(e) from e

    @app.get("/api/vehicles/{name}/params/meta")
    async def param_meta(name: str, request: Request):
        try:
            data = await session.param_meta(name)
        except (SupervisorError, ValueError) as e:
            raise fail(e) from e
        return _json(data, request)  # null: not downloaded yet

    @app.post("/api/vehicles/{name}/params/meta")
    async def download_param_meta(name: str, request: Request):
        try:
            return _json(await session.param_meta(name, download=True), request)
        except (SupervisorError, ValueError, OSError) as e:
            raise HTTPException(502 if isinstance(e, OSError) else 400, f"download failed: {e}") from e

    @app.post("/api/outputs")
    async def add_output(body: Output):
        try:
            await session.add_output(body.url, body.scope)
        except (SupervisorError, ValueError, StopIteration) as e:
            raise fail(e) from e
        return {"ok": True}

    @app.post("/api/outputs/remove")
    async def remove_output(body: Output):
        try:
            await session.remove_output(body.url, body.scope)
        except (SupervisorError, StopIteration) as e:
            raise fail(e) from e
        return {"ok": True}

    @app.get("/files/{path:path}")
    async def scene_file(path: str):
        f = files.resolve("/" + path, session.scene)
        if f is None:
            raise HTTPException(404, "not part of the scene")
        return FileResponse(f, headers={"Cache-Control": "private, max-age=3600"})

    @app.websocket("/ws")
    async def ws(socket: WebSocket):
        if not authorised(socket.cookies.get(COOKIE)) or not _same_origin(socket.headers):
            await socket.close(code=4401)
            return
        await socket.accept()
        q = session.hub.connect()
        try:
            await socket.send_text(json.dumps({"t": "hello", **session.snapshot()}))
            if session.scene:
                await socket.send_text(session.scene)
            sender = asyncio.create_task(_pump(socket, q))
            with contextlib.suppress(WebSocketDisconnect):
                while True:
                    await socket.receive_text()  # the browser only listens; this notices it leaving
            sender.cancel()
        finally:
            session.hub.disconnect(q)

    app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
    return app


def _json(data: dict | None, request: Request) -> Response:
    """Big JSON (parameter descriptions are over a megabyte) compressed when the browser accepts it."""
    body = json.dumps(data, separators=(",", ":")).encode()
    if "gzip" in request.headers.get("accept-encoding", ""):
        return Response(gzip.compress(body, 6), media_type="application/json",
                        headers={"Content-Encoding": "gzip", "Vary": "Accept-Encoding"})
    return Response(body, media_type="application/json")


async def _pump(socket: WebSocket, q: asyncio.Queue[str]) -> None:
    with contextlib.suppress(WebSocketDisconnect, RuntimeError):
        while True:
            await socket.send_text(await q.get())


def _same_origin(headers) -> bool:
    origin = headers.get("origin")
    if not origin:
        return True  # not a browser (curl, scripts): the token cookie is still required
    return urlparse(origin).netloc == headers.get("host")


class SceneFiles:
    """Only files the current scene uses, and the model folders they belong to (textures sit next to meshes)."""

    def __init__(self) -> None:
        self._scene: str | None = None
        self._roots: list[Path] = []

    def resolve(self, path: str, scene: str | None) -> Path | None:
        if scene is not self._scene:
            self._scene, self._roots = scene, sorted(_roots(scene)) if scene else []
        try:
            f = Path(path).resolve(strict=True)
        except (OSError, RuntimeError):
            return None
        for root in self._roots:
            if f.is_file() and f.is_relative_to(root):
                hidden = any(part.startswith(".") for part in f.relative_to(root).parts)
                return None if hidden else f
        return None


def _roots(scene_line: str) -> set[Path]:
    roots: set[Path] = set()
    for file in scene_files(json.loads(scene_line)["scene"]):
        p = Path(file)
        if not p.is_absolute():
            continue
        try:
            p = p.resolve()
        except (OSError, RuntimeError):
            continue
        roots.add(_model_root(p))
    return roots


def _model_root(f: Path) -> Path:
    """The Gazebo model folder (with model.config) a mesh belongs to, else the file's own folder."""
    for d in list(f.parents)[:4]:
        if (d / "model.config").exists():
            return d
    return f.parent


def scene_files(scene: dict) -> list[str]:
    out: list[str] = []

    def walk(m: dict) -> None:
        for link in m["links"]:
            for v in link["visuals"]:
                g = v.get("geometry") or {}
                if g.get("file"):
                    out.append(g["file"])
                for t in g.get("textures", []):
                    out.extend(x for x in (t.get("diffuse"), t.get("normal")) if x)
                mat = v.get("material") or {}
                out.extend(x for x in (mat.get("albedo_map"), mat.get("normal_map")) if x)
        for n in m["models"]:
            walk(n)

    for m in scene["models"]:
        walk(m)
    return out


def new_token() -> str:
    return secrets.token_urlsafe(24)
