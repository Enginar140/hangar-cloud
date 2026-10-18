"""hangar-cloud serve: the web app on this machine."""

from __future__ import annotations

import argparse
import asyncio
import ipaddress
import os
import socket
import sys
from pathlib import Path

from hangar import paths
from hangar.settings import Settings

from . import __version__


def token_file() -> Path:
    return paths.data_dir() / "cloud" / "token"


def load_token(given: str | None, renew: bool) -> str:
    from .server import new_token

    if given:
        return given
    f = token_file()
    if f.exists() and not renew:
        token = f.read_text(encoding="utf-8").strip()
        if token:
            return token
    token = new_token()
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(token + "\n", encoding="utf-8")
    os.chmod(f, 0o600)
    return token


def addresses(host: str) -> list[str]:
    """Addresses a browser can use to reach host."""
    if host not in ("0.0.0.0", "::"):
        return [host]
    found = ["127.0.0.1"]
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))  # no packet is sent; picks the outgoing interface
            found.append(s.getsockname()[0])
    except OSError:
        pass
    return found


def is_loopback(host: str) -> bool:
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host == "localhost"


def cmd_serve(args) -> int:
    import uvicorn

    from .server import create_app
    from .session import Session, find_gz_python

    settings = Settings.load()
    gz_python = find_gz_python(args.gz_python)
    token = load_token(args.token, args.new_token)
    session = Session(settings, gz_python)
    app = create_app(session, token)

    print(f"hangar-cloud {__version__}")
    if not gz_python:
        print("  3D view: off (no Python with Gazebo's bindings; on Ubuntu: sudo apt install python3-gz-transport13)")
    if not is_loopback(args.host):
        print("  listening on all interfaces: anyone who can reach this port needs the token;")
        print("  put HTTPS in front of it (see the README) before exposing it to the internet")
    for a in addresses(args.host):
        print(f"  open  http://{a}:{args.port}/?token={token}")

    config = uvicorn.Config(app, host=args.host, port=args.port, log_level="warning", ws_max_size=1 << 20,
                            proxy_headers=True, forwarded_allow_ips=args.trusted_proxy or "127.0.0.1")
    server = uvicorn.Server(config)

    async def run() -> None:
        try:
            await server.serve()
        finally:
            await session.close()

    asyncio.run(run())
    return 0


def cmd_token(args) -> int:
    print(load_token(None, args.new))
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="hangar-cloud", description=__doc__)
    p.add_argument("--version", action="version", version=f"hangar-cloud {__version__}")
    sub = p.add_subparsers(dest="cmd")
    s = sub.add_parser("serve", help="run the web app")
    s.add_argument("--host", default="127.0.0.1", help="address to listen on (0.0.0.0: every interface)")
    s.add_argument("--port", type=int, default=8080)
    s.add_argument("--token", help="login token (default: a random one, kept in the data folder)")
    s.add_argument("--new-token", action="store_true", help="make a new token; old links stop working")
    s.add_argument("--gz-python", help="Python with Gazebo's bindings, for the 3D view (default: found)")
    s.add_argument("--trusted-proxy", help="address of the HTTPS proxy in front of this server")
    t = sub.add_parser("token", help="print the login token")
    t.add_argument("--new", action="store_true", help="make a new one")
    args = p.parse_args(argv)
    if args.cmd == "serve":
        return cmd_serve(args)
    if args.cmd == "token":
        return cmd_token(args)
    p.print_help(sys.stderr)
    return 2
