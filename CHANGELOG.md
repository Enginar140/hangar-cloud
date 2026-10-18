# Changelog

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
