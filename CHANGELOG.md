# Changelog

## 0.2.6 (2026-11-08)

- **Replays**: play recorded runs back in the 3D view and on the map with a time bar (×0.25 to
  ×16, seek, event to event), the paths flown, zones (boundary and no-fly, from their time on),
  the selected vehicle's recorded values and event videos. Hangar's own runs (Hangar 0.3.8) are
  listed by themselves; replay files from other programs come from `serve --replay-dir DIR`.
  Links: `/?replay=<id>&t=<seconds>`. The replay format (version 1) is in the README.
- API: `GET /api/replays`, `GET /api/replay?id=`, `GET /api/replay/file` (videos, with seeking).

## 0.2.5 (2026-11-08)

- **Watch a run started elsewhere** (needs Hangar 0.3.7's monitor ports): the 3D view, the map,
  telemetry and the vehicles' messages of a simulation another program runs, read-only. The
  empty view lists the runs going on with a *Watch* button; `/?attach=latest` (or a run name) opens
  one from a link; `POST /api/attach` for scripts. Commands, parameters and outputs are off while
  watching; *Stop watching* leaves the run alone. The page goes back to idle when the run ends.
- The login link keeps its other query parameters (`?token=…&attach=…`).
- The Gazebo bridge exits when the server is killed, instead of staying behind.

## 0.2.4 (2026-11-08)

- **One simulation at a time** (Hangar 0.3.6): while another Hangar run is going on on the
  machine, *Start* names it and does not start. Runs started here are shown as `hangar-cloud` in
  `hangar status`.
- **Scripts**: the API takes the token as `Authorization: Bearer`, and **`GET /api/status`** gives
  the state, the run, the vehicles and every Hangar run on the machine.
- The preflight check no longer reports the running simulation's own ports while it runs.

## 0.2.3 (2026-10-18)

- **Scenario form**: edit the scenario without YAML: name, speed, world, start location, and the
  vehicles: add, copy, remove, model (Gazebo or built-in physics), name, position and heading
  (empty: placed automatically), a camera stream, parameters. Fields the form does not show
  (outputs, camera details) are kept; the YAML editor is still there for them.
- **Restart** button on a vehicle whose SITL exited (crashed or killed), while the simulation runs.

## 0.2.2 (2026-10-18)

- **A Gazebo example opens by default** (`runway-3d`: a fixed-wing and a gimbal quadcopter on a
  runway) when its world and models are installed, instead of the built-in-physics quickstart
  that has nothing to show in 3D.
- Vehicles with ArduPilot's built-in physics (`sitl:` models): the 3D view says why it is empty,
  with buttons for the map and for the Gazebo example.
- Gazebo always runs without its own window (nobody sits at a server's screen);
  `serve --gazebo-window` keeps a scenario's own choice.

## 0.2.1 (2026-10-18)

- **Start says why it cannot start**: preflight errors (a busy port, an unknown model) come back
  to the page at once instead of only in the log, and the 3D view is not cleared by a failed start.
- Uses Hangar 0.3.4: a SITL already running on the machine no longer blocks the start; the
  simulation moves to the first free instance.
- Errors of background tasks go to the log instead of an unhandled traceback.

## 0.2.0 (2026-10-18)

- **Map** (*Map* switch or `M`, Leaflet): vehicles with heading, altitude and path on
  OpenStreetMap or satellite imagery, home, follow, fit. **Click to fly a vehicle there**
  (GUIDED reposition). Works for vehicles without Gazebo too.
- **Parameter editor** (*Parameters* tab): reads every parameter, search, edit with Enter,
  lists for choices, checkboxes for bitmasks, a range check, "changed" filter that also catches
  changes from a ground station, save and load `.param` files (Mission Planner, MAVProxy and QGC
  formats) with a diff before applying. *Get descriptions* downloads ArduPilot's parameter
  documentation for the vehicle's firmware version once and keeps it.
- Uses Hangar 0.3.3 (parameter download, `goto`, firmware version, `first_instance`).
- **Vehicle cameras drawn by the browser**: a window over the 3D view shows the selected vehicle's
  camera, from its Gazebo camera sensor (following the gimbal) or, without one, from where Hangar
  mounts cameras. Fill the view, save a PNG, or take frames for your own processing with
  `hangar.grabFrame()`. The server renders and encodes nothing for it. Checked against Gazebo's
  own camera images from the same moment.
- Huge flat surfaces (a runway plane over a 10 km grass plane) are split into smaller triangles,
  and stacked layers are spread apart, so the right one shows from every angle.
- Meshes are drawn one-sided like Gazebo; the sky always fits inside a camera's far plane;
  `cast_shadows` from the SDF is honoured.

## 0.1.0 (2026-10-18)

First version: Hangar's simulations from a browser.

- **3D view drawn by the browser** (Three.js): a bridge reads Gazebo's scene and poses with
  gz-transport and streams them over a WebSocket (~30 Hz). Meshes (DAE, OBJ/MTL, STL, glTF),
  primitives, PBR albedo textures (TGA too), heightmaps with their textures, and hangar-earth
  terrain with exact heights. Sky, horizon fog and shadows; a color and a flight trail per
  vehicle; click a vehicle to select it. Camera modes Free, Follow, Chase and Top (keys 1-4),
  a compass and an instrument panel for the selected vehicle. New models appear when they are
  added to the world.
- **Vehicles**: a card each, updated twice a second (altitude, speed, heading, battery, pre-arm,
  GPS, sim speed); the vehicle's own flight modes in a list, arm/disarm, takeoff to a typed
  altitude, RTL, land and any Hangar command. The top bar shows sim speed, vehicles online and
  run time. Works on phones too.
- **Scenarios**: load examples or saved ones, edit the YAML, see preflight problems, save.
- **Logs** with level and text filters; problems raise a badge.
- **Connect**: add or remove MAVLink outputs while running (QGroundControl over TCP), and each
  vehicle's free SITL ports.
- **Login with a token** (kept between restarts), `HttpOnly` + `SameSite=Strict` cookie,
  cross-site requests refused, only files of the current scene are served (no hidden folders).
- Verified with Gazebo Harmonic 8.15: a quadcopter (iris with gimbal) taking off from the browser
  next to a Skywalker X8, on a runway world and on a hangar-earth world.
