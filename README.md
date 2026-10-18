# Hangar Cloud

**English** · [Türkçe](README.tr.md)

Run [Hangar](https://github.com/Enginar140/hangar)'s ArduPilot SITL + Gazebo simulations on a
Linux machine (a home server, a lab PC or a small VPS) and use them from a browser on any computer,
including Windows: a live **3D view**, vehicle telemetry and commands, scenarios, logs, and
a map, a parameter editor, and connection details for QGroundControl or Mission Planner.

![A quadcopter in flight, seen from behind in the browser](docs/images/chase.jpg)

> **Status: early.** One user at a time. The 3D view, browser-drawn cameras, the map, parameters,
> commands, scenarios, logs and MAVLink outputs work. Missions and Gazebo's own camera streams are
> next (see [Roadmap](#roadmap)).

## How it works

```
Browser (Windows, Mac, Linux, tablet)            Linux machine
  3D view (Three.js) ◄── WebSocket ─────────  hangar-cloud
  vehicles, commands, logs ◄─ HTTP ─────────    ├─ Hangar: Gazebo + ArduPilot SITLs + MAVLink router
                                                └─ Gazebo bridge: scene and poses (gz-transport)
QGroundControl / scripts ◄──── MAVLink TCP ───  outputs you add in the Connect tab
```

- **The 3D view is drawn by your browser, not by the server.** A small bridge reads the scene
  (models, meshes, terrain) and the poses from Gazebo and sends them over a WebSocket, about 30
  times a second. Three.js draws them on your computer's GPU. Gazebo itself runs headless on the
  server, so a machine without a graphics card is fine for this.
- Meshes (`.dae`, `.obj`, `.stl`, `.gltf`), textures and terrain are loaded from the server.
  The server only sends files that belong to the current scene.
- Worlds from [hangar-earth](https://github.com/Enginar140/hangar-earth) show their real
  terrain and satellite imagery, with the exact heights Gazebo uses.
- Everything else (starting Gazebo and the SITLs, ports, MAVLink) is Hangar's own code, so a
  scenario behaves the same in the terminal UI and in the browser.

| | |
|---|---|
| ![A fixed-wing and a quadcopter on a runway, with the quadcopter's path](docs/images/overview.jpg) | ![The same page on a phone](docs/images/phone.jpg) |

## Requirements

On the Linux machine:

- **Hangar** set up, so `hangar doctor` is happy: ArduPilot SITL, Gazebo Harmonic and the
  vehicle models. See [Hangar's install guide](https://github.com/Enginar140/hangar#install).
- **Gazebo's Python bindings** for the 3D view. They come with Gazebo Harmonic on Ubuntu
  (`python3-gz-transport13`). Without them everything else still works; the page says the 3D view
  is off.
- [uv](https://docs.astral.sh/uv/).

On your computer: a current browser with WebGL (Chrome, Edge, Firefox, Safari).

## Install and run

```bash
uv tool install git+https://github.com/Enginar140/hangar-cloud
hangar-cloud serve
```

It prints a link with a login token:

```
hangar-cloud 0.2.3
  open  http://127.0.0.1:8080/?token=6vQ...
```

The token is kept in `~/.local/share/hangar/cloud/token` and survives restarts.
`hangar-cloud token` prints it, and `hangar-cloud token --new` replaces it (old links stop working).

### Reaching it from another computer

Pick one:

- **SSH tunnel** (nothing to open, works for a VPS):
  `ssh -L 8080:localhost:8080 you@server`, then open `http://localhost:8080/?token=...` on
  your computer. On Windows, `ssh` is built into PowerShell.
- **Home network**: `hangar-cloud serve --host 0.0.0.0` and open `http://<server-ip>:8080/?token=...`.
- **VPN** ([Tailscale](https://tailscale.com) or WireGuard): the server gets a private address
  that only your devices can reach. This is also the safest way to connect QGroundControl.
- **HTTPS on the internet**: keep `serve` on `127.0.0.1` and put a reverse proxy in front.
  With [Caddy](https://caddyserver.com) and a domain name, this `Caddyfile` is enough (Caddy
  gets the certificate itself):

  ```
  sim.example.com {
      reverse_proxy 127.0.0.1:8080
  }
  ```

### Keep it running

A systemd user service starts it with the machine:

```ini
# ~/.config/systemd/user/hangar-cloud.service
[Unit]
Description=Hangar Cloud

[Service]
ExecStart=%h/.local/bin/hangar-cloud serve
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now hangar-cloud
loginctl enable-linger $USER   # keep running after you log out
```

## Using it

- **Start / Stop** at the top. The bar shows the simulation speed (×1 = real time); ArduPilot
  needs a while of *simulated* time before it can arm, so a slow simulation takes longer.
- **Vehicles**: a card per vehicle with altitude, speed, heading, battery, pre-arm state, GPS and
  sim speed. Pick the flight mode from the vehicle's own list, arm or disarm, take off to the
  altitude you type, RTL, land, and use the command line for anything else:
  `param set WP_SPD 8`, `goto -35.3620 149.1652 40`.
- **3D view**: drag to orbit, right-drag to pan, scroll to zoom. Click a vehicle (or its label or
  card) to select it; the panel at the top shows its altitude, speed, climb, heading and battery.
  Camera modes: **Free**, **Follow** (orbit around the vehicle as it moves), **Chase** (behind it)
  and **Top** (from above, north up); keys `1`-`4`, `Esc` for free. Each vehicle has its own
  color and leaves a **trail** of where it flew (*Trails* switches them off, the bin clears them).
  *Fit* shows all vehicles.
- **Camera**: the selected vehicle's camera in a window over the 3D view (`C`); it can fill the
  view (`F`) and save the picture as PNG. See [Vehicle cameras](#vehicle-cameras-drawn-by-your-browser).
- **Map** (the *Map* switch at the top left, or `M`): every vehicle with its heading, altitude and
  path, on OpenStreetMap or satellite imagery. **Click the map to fly a vehicle there**: pick the
  vehicle and the altitude, *Fly here* (it switches to GUIDED; the same as `goto LAT LON ALT` on
  the command line). *Follow* keeps the selected vehicle in the middle. Vehicles without Gazebo
  show up here too.
- **Parameters**: every parameter of the vehicle, read when you open the tab. Search by name, or
  by description once you press *Get descriptions* (ArduPilot's list for the vehicle's firmware
  version, downloaded from autotest.ardupilot.org once and kept). Edit a value and press Enter;
  choices and bitmasks get a list and checkboxes, values outside the usual range ask first.
  *changed* shows what changed since reading (also changes made by a ground station). *Save*
  downloads a `.param` file; *Load* compares one with the vehicle and applies the differences.
- **Scenario**: load a saved or example scenario (`runway-3d` is the Gazebo one; `sitl:` models
  such as in `quickstart` use ArduPilot's built-in physics and show only on the map). Edit it as a
  **form**: the world, the start location, and the vehicles (*+ Add vehicle*, copy, remove; model,
  name, position, a camera stream, parameters). Or as **YAML** for everything else (the same format
  as [Hangar's](https://github.com/Enginar140/hangar#scenario-files)). *Apply*, then *Start*; save it
  under a name. Problems are shown before you start. If a vehicle's SITL exits, its card gets a
  **Restart** button.
- **Logs**: everything Hangar logs, including each vehicle's messages (PreArm failures, mode
  changes), with filters.
- **Connect**: MAVLink outputs, changed while running. To use QGroundControl or Mission Planner
  on Windows, add `tcpin:0.0.0.0:5790` and connect to TCP `server:5790`. Each vehicle also has two
  free SITL ports for your own scripts (listed there).

| | |
|---|---|
| ![The map: a quadcopter's path and the fly-here box](docs/images/map.jpg) | ![The parameter editor with descriptions](docs/images/params.jpg) |

### Next to another SITL

A scenario starts its SITLs at instance 0 (MAVLink on `tcp:5760`). If another SITL already runs on
the machine, the preflight check names the busy ports; add `first_instance: 3` (any free number)
to the scenario and every port moves by 10 per instance.

## Vehicle cameras, drawn by your browser

![A quadcopter's gimbal camera over the 3D view](docs/images/camera-pip.jpg)

Gazebo renders a camera on the server, encodes it to H.264 and streams it: that costs the server
a GPU and CPU time, and is the most common reason a simulation runs slower than real time. Hangar
Cloud can instead **draw the camera's view in your browser**, from the same scene it already
shows in 3D:

- A model with a camera sensor (the iris gimbal, or one Hangar added with `camera:`) uses that
  sensor's position, field of view and resolution, and follows the gimbal as ArduPilot moves it.
- A model without one gets a camera where Hangar would mount one (its `camera_pose`, or the
  scenario's `camera.pose` and `camera.fov`), marked *browser only*.

![Gazebo's camera and the browser's, at the same moment](docs/images/camera-compare.jpg)

The picture is the same view as Gazebo's, but drawn by Three.js: lighting, sky and materials
look a little different, and there is no image noise or lens distortion. It exists only in your
browser, so programs on the server (OpenCV, ROS, the autopilot) do not see it; for those, keep
using [Hangar's camera streams](https://github.com/Enginar140/hangar#cameras).

To process the picture in the browser, for example with OpenCV.js or TensorFlow.js:

```js
// in the browser's console, or a script you load into the page
hangar.cameras('quad')                  // [{name: 'camera', width: 640, height: 480}, ...]
const img = hangar.grabFrame('quad')    // ImageData of the first camera
const img2 = hangar.grabFrame('quad', 1, 1280)   // second camera, at most 1280 px wide
```

## Security

The token gives full control of the simulations on the machine: treat it like a password.
The login cookie is `HttpOnly` and `SameSite=Strict`, and requests from other sites are refused.
Use HTTPS (or an SSH tunnel or VPN) whenever the connection leaves your own network, and do not
open MAVLink ports to the internet; a VPN is the right tool for those.

## Roadmap

1. **Gazebo's own camera streams in the browser** with WebRTC (through
   [MediaMTX](https://github.com/bluenviron/mediamtx)), and RTSP for OpenCV on other computers.
   The browser-drawn camera is already there.
2. **Missions** on the map: download, draw, upload; geofence and rally points.
3. **Docker image** with Gazebo, ArduPilot and the models, one command to run on a VPS or on
   Windows (Docker Desktop with WSL2).
4. More than one user, each with their own simulations.

## Licenses

Hangar Cloud is [MIT](LICENSE). It bundles [three.js](https://threejs.org) (MIT,
[license](src/hangar_cloud/web/vendor/three/LICENSE)) and [Leaflet](https://leafletjs.com) (BSD-2-Clause,
[license](src/hangar_cloud/web/vendor/leaflet/LICENSE)). Map tiles come from
[OpenStreetMap](https://www.openstreetmap.org/copyright) and Esri World Imagery straight to your
browser, with their attribution on the map; parameter descriptions come from ArduPilot's
autotest server when you ask for them. It installs nothing else by itself:
ArduPilot (GPL-3.0), Gazebo (Apache-2.0) and the vehicle models come through Hangar, which asks
before downloading anything and shows each license. ArduPilot and Gazebo run as separate programs.
If you offer a server like this to other people, check the licenses of the models and worlds you
show; some example models do not state one.

## Development

```bash
git clone https://github.com/Enginar140/hangar-cloud && cd hangar-cloud
uv sync
uv run pytest -q
uv run ruff check src tests scripts
uv run hangar-cloud serve
```

The browser code is plain ES modules with no build step: edit `src/hangar_cloud/web/*.js` and
reload the page.
