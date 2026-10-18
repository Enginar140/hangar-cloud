# Changelog

## 0.1.0 (unreleased)

First version: Hangar's simulations from a browser.

- **3D view drawn by the browser** (Three.js): a bridge reads Gazebo's scene and poses with
  gz-transport and streams them over a WebSocket (~30 Hz). Meshes (DAE, OBJ/MTL, STL, glTF),
  primitives, PBR albedo textures (TGA too), heightmaps with their textures, and hangar-earth
  terrain with exact heights. Follow a vehicle or fit all; labels show mode, armed and altitude.
  New models appear when they are added to the world.
- **Vehicles**: telemetry twice a second; arm, disarm, takeoff, RTL, land and any Hangar command.
- **Scenarios**: load examples or saved ones, edit the YAML, see preflight problems, save.
- **Logs** with level and text filters; problems raise a badge.
- **Connect**: add or remove MAVLink outputs while running (QGroundControl over TCP), and each
  vehicle's free SITL ports.
- **Login with a token** (kept between restarts), `HttpOnly` + `SameSite=Strict` cookie,
  cross-site requests refused, only files of the current scene are served (no hidden folders).
- Verified with Gazebo Harmonic 8.15: a quadcopter (iris with gimbal) taking off from the browser
  next to a Skywalker X8, on a runway world and on a hangar-earth world.
