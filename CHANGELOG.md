# Changelog

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
