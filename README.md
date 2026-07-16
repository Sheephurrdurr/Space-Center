# Space Center

An interactive 3D center of astrophysics, built as a walkable planet in the browser. No game engine, no build step — just Three.js, vanilla ES modules, and a fair amount of general relativity.

**[→ Visit the Center](https://your-url.netlify.app)**

---

## What's in here

Walk a small rover-droid around a low-poly planet to discover four physically simulated exhibits:

| Exhibit | What it does |
|---|---|
| **Schwarzschild Black Hole** | Real-time ray marching through curved spacetime — every pixel traces a photon along the Schwarzschild geodesic equation. |
| **Kerr Black Hole** | A *rotating* black hole. Full Kerr metric, no approximations — RK4-integrated Hamiltonian geodesics, frame dragging, a Doppler-beamed accretion disk, and the characteristic displaced D-shaped shadow. |
| **NS–BH Merger: Gravitational Waves** | A neutron star spiraling into a black hole, with orbital decay driven by the real Peters & Mathews (1964) quadrupole formula. |
| **NS–BH Merger: Gravitational Lensing** | The same inspiral, this time seen through a ray-marched lens — watch the neutron star distort and vanish behind the event horizon. |

A fifth exhibit slot sits empty, waiting for a probe to fly into a black hole. That's a problem for future me.

## Why it exists

This started as a Three.js learning project — a binary star system, some shaders, a lot of "wait, why is my sphere black." It did not stay small.

## Tech

- **Rendering:** Three.js (self-hosted, no CDN dependency)
- **Physics:** RK4 Hamiltonian geodesic integration (Kerr-Schild form), Peters & Mathews orbital decay, Schwarzschild ray marching in GLSL
- **Everything else:** vanilla JavaScript ES modules, hand-rolled procedural low-poly geometry, no framework, no bundler — it runs directly off static files
- **Physically based rendering** via `MeshStandardMaterial`, hand-tuned lighting (no environment map — deliberately, see: budget)

## Architecture notes

The planet-facing part of the site (`/`) is built around a few core modules:

- `planetMath.js` — single source of truth for the planet's geometry and spherical gravity math (terrain height, tangent-plane projection, surface orientation). Both the mesh and the player controller read from here, so they can never disagree about where the ground is.
- `player.js` / `cameraRig.js` — spherical-gravity character controller and a lazy-follow camera that orbits the planet with the player.
- `droid.js` — the rolling droid you control. Rolling without slipping, animated proceduraly (no rig, no keyframes).
- `interactables.js` — a small proximity/registration system for exhibits. Adding exhibit №6 means adding one `register()` call, nothing else.
- Each exhibit under `/exhibits/*` is its own self-contained Three.js scene with its own shader.

A non-WebGL / reduced-motion fallback lives at `/classic/` — a static, fully navigable 2D version of the space center.

## Running locally

No build step. Any static file server works:

```bash
npx serve
```

Then open the printed `localhost` URL. To test on a phone on the same network, use the printed `Network` address instead.

## Mobile

Touch controls (virtual joystick + tap-to-jump), responsive HUD, and aspect-aware camera FOV are all supported. The Kerr exhibit is *computationally unhinged* (per-pixel RK4 integration, live, in a fragment shader) and is honestly best experienced on desktop — your phone will forgive you for checking out the other three first.

## Status

Actively growing. Current backlog includes: a probe falling into a black hole (physically, not just artistically), audio, and continued mobile performance tuning on the heavier exhibits.

---

Built with more curiosity than sleep.
