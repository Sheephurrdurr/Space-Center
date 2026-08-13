// =====================================================================
//  Dive — composition root
//
//  Three modules, three questions:
//    DiveGeodesic  — WHERE the camera is. A timelike geodesic.
//    DiveShader    — WHAT the camera sees. A per-pixel Kerr raytracer.
//    main.js       — WHEN. All pacing, all phases, all DOM.
//
//  The trajectory is integrated once at startup and stored as a table, so
//  playback is a lookup and the tempo can be changed without touching the
//  physics. That is "correct physics, artistic scale" expressed as an
//  architectural decision: the path is true, the tempo is not.
//
//  ── About the ending ───────────────────────────────────────────────
//  There used to be a hand-authored ring passage here — the camera lifted
//  above the ring plane, guided through the opening, and a procedurally
//  generated universe of galaxies opened up on the far side. It is gone,
//  and that is an improvement.
//
//  The reason is the inner horizon. For a = 0.85M, r₋ = 0.4732 M.
//  Everything falling in after the observer, plus the entire future
//  history of the exterior universe, arrives at that surface compressed
//  into one finite proper time and infinitely blueshifted. Poisson and
//  Israel called it mass inflation (1990): the effective mass diverges
//  exponentially and the Cauchy horizon becomes a genuinely singular
//  surface rather than a door.
//
//  The geodesic stops at 0.55 M — 16% OUTSIDE r₋. The integrator gives up
//  exactly where the theory says it should, and the fall never reaches a
//  passage that is not there anyway. So the exhibit ends where the
//  mathematics ends: in the blueshift. See the long note in DiveShader.
// =====================================================================

import * as THREE from 'three';
import { DiveGeodesic, ksR, buildTetrad, dotG, solvePtAt } from './DiveGeodesic.js';
import { createDiveMaterial } from './DiveShader.js';
import { wireMathPanel, observeCanvasResize } from '/shared/exhibitCommon.js';

// ── The hole ──────────────────────────────────────────────────────────
// Sagittarius A*, our local supermassive black hole.
const BH_MASS   = 5.0;              // geometric toy units
const RS        = 2.0 * BH_MASS;    // = 10
const SPIN      = 0.85;             // a/M
const MSUN      = 4.3e6;            // Sgr A*

// 0 = white hot, 1 = burnt-out red. The Kerr exhibit's Sgr A* preset is
// 0.45; this sits lower because we get much closer and want to see the
// white inner edge on the way down.
const COLDNESS  = 0.30;

// Conversion from toy units to reality.
const SOLAR_RS_KM   = 2.953;
const SOLAR_TIME_S  = 4.925e-6;
const RS_METERS     = SOLAR_RS_KM * 1000 * MSUN;
const TOY_METERS    = RS_METERS / RS;                 // 1 toy length, in metres
const TOY_SECONDS   = SOLAR_TIME_S * MSUN / BH_MASS;  // 1 toy time, in seconds
const C = 299792458;

// Inner horizon r₋ = M − sqrt(M² − a²). Read-only: the trajectory never
// reaches it. 2.3661 for a = 0.85M, against a stop at 2.75.
const R_INNER = BH_MASS - Math.sqrt(Math.max(BH_MASS * BH_MASS - Math.pow(SPIN * BH_MASS, 2), 0));

// ── Timeline, in wall-clock seconds ───────────────────────────────────
// T_FALL is the entire motion, start to stopping point, as one continuous
// segment. It used to be three (approach / crossing / interior) and that
// split is what caused the stutter — see makePacing() below.
const T_FALL  = 39.5;   // from r = 6 Rs down to where the equations stop
const T_WHITE = 8.0;    // the spectrum is pushed out of the visible band
const T_PLATE = 8.0;    // burn-down, black, and an explanation
const T_TOTAL = T_FALL + T_WHITE + T_PLATE;

// ── Renderer ──────────────────────────────────────────────────────────
const canvas   = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(canvas.clientWidth, canvas.clientHeight);

// ── Every listener goes through here ──────────────────────────────────
// Not because this page leaks — it cannot; see the lifecycle section at
// the bottom of the file for why — but because the moment teardown exists
// at all, a hand-maintained list of removals starts drifting from the list
// of additions the first time somebody adds a listener and forgets. One
// registry, and the two lists cannot disagree.
const _listeners = [];
function on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    _listeners.push([target, type, fn, opts]);
    return fn;
}

// ── Precision is load-bearing ─────────────────────────────────────────
// Three.js picks the fragment precision from what the device reports and
// writes it into the shader prefix. If a device cannot do highp in the
// fragment stage it silently gets mediump, whose largest finite value is
// 65504 — and the Kerr metric carries D = r⁴ + a²z², which is 6.6e8 at
// ESCAPE_DIST. That is not "slightly worse", it is NaN for every ray more
// than about 16 units out, i.e. an entirely black screen.
//
// Every WebGL2 implementation is required to support highp in fragment
// shaders, so this should never fire. It is here because if it ever does,
// the failure mode is a black screen with no error, and half an hour of
// looking in the wrong place.
if (renderer.capabilities.precision !== 'highp') {
    console.warn('[dive] fragment precision is "' + renderer.capabilities.precision +
                 '", not highp. The Kerr metric will overflow. Expect black or NaN.');
}

// A coarse pointer means a phone or tablet: a tile-based GPU with no
// cooling headroom, where the High preset is not a choice anyone would want
// made for them. It is still reachable from the button.
const COARSE_POINTER = window.matchMedia('(pointer: coarse)').matches;

// ── Quality presets ───────────────────────────────────────────────────
// Declared up here, ahead of the material, only because `steps` is now a
// compile-time #define as well as a uniform and we would rather compile
// the right shader once than compile a 900-step one and immediately
// replace it. Everything that *uses* these lives at the bottom of the
// file, with the frame pacing.
const QUALITY = [
    { label: '◑ High',  base: () => Math.min(window.devicePixelRatio, 1.25), steps: 900, fps: 60 },
    { label: '◐ Eco',   base: () => 0.70,                                    steps: 420, fps: 45 },
    { label: '○ Ultra', base: () => 0.45,                                    steps: 280, fps: 30 },
];
let qIndex = COARSE_POINTER ? 1 : 0;

const scene       = new THREE.Scene();
const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const SKY_URL = '/assets/textures/starfield_4k.jpg';

const starfield = new THREE.TextureLoader().load(SKY_URL,
    tex => {
        // ── uSkySize, measured rather than typed ──
        // It caps the mip level the shader is allowed to ask for, and it
        // used to be the literal 6000 written by hand — sitting four lines
        // away from a file called starfield_4k. One of those two numbers
        // was wrong and nothing in the code could tell you which. Read it
        // off the decoded image instead and the question stops existing:
        // whatever is actually on disk IS the ceiling, forever.
        //
        // It matters by about half a mip level either way, which is the
        // difference between the last decade of the cascade resolving and
        // going flat grey early.
        const w = tex.image && tex.image.width;
        if (w > 0) material.uniforms.uSkySize.value = w;
        needsRender = true;
    },
    undefined,
    () => {
        // A 404 here used to be silent and catastrophic: Three binds its
        // 1x1 white placeholder for a texture that never arrived, so the
        // sky comes back as uniform white at full brightness — every ray
        // that escapes returns maximum energy, the tone mapping gives up,
        // and the exhibit shows a white rectangle with no error anywhere.
        //
        // 12k procedural stars is not the NASA map, but it is the right
        // shape: dark background, point sources, correct solid-angle
        // distribution. The lensing, the aberration and the cascade all
        // still read.
        console.warn('[dive] sky texture failed to load:', SKY_URL);
        const fb = makeFallbackSky();
        material.uniforms.uStarfield.value = fb;
        material.uniforms.uSkySize.value = fb.image.width;
        showNotice('Sky texture unavailable — showing a synthetic star field.', 'warn');
        needsRender = true;
    });

// Default anisotropy is 1, i.e. none. Invisible in the Kerr exhibit
// because that camera is stationary, but here aberration distorts the sky
// differently per pixel, every frame.
starfield.anisotropy = renderer.capabilities.getMaxAnisotropy();

// ── Mipmaps, and why they are load-bearing ──
// The shader samples the sky at an explicit mip level. That is not a blur
// effect: once a ray has wound twice around the hole, ONE screen pixel
// covers hundreds of times more sky than it did in flat space — measured
// up to 680×. Point-sampling there is wrong; the mean over the footprint
// is the answer, and a mip level is that mean.
//
// The texture is 6000×3000, not a power of two. Under WebGL1 that would
// mean no mipmaps AND no RepeatWrapping. Under WebGL2 both are legal, and
// Three.js runs WebGL2 — so it works, but the entire prefiltering scheme
// depends on it.
starfield.generateMipmaps = true;
starfield.minFilter = THREE.LinearMipmapLinearFilter;
starfield.magFilter = THREE.LinearFilter;

// wrapS MUST wrap: u = atan2(...)/2π + 0.5 crosses the 0/1 seam every time
// the camera looks towards −x. With ClampToEdge the GPU never blends
// u ≈ 0 against u ≈ 1 across that seam.
starfield.wrapS = THREE.RepeatWrapping;
starfield.wrapT = THREE.ClampToEdgeWrapping;

/**
 * Four octaves of tileable value noise, packed one per RGBA channel.
 *
 * The disk turbulence used to be evaluated procedurally: 4 hash lookups
 * per octave, 5 octaves, and two cross-faded copies, so 40 hashes every
 * time a ray crossed the equatorial plane — inside the raymarching loop,
 * which is the worst place in the shader to put anything. A ray that
 * winds around the hole crosses two or three times.
 *
 * Baking it costs one texture fetch instead, and 512² × 4 channels here
 * at startup. That is ~40 ms once, done while the geodesic table is being
 * built anyway.
 *
 * ── Why it can be baked at all ────────────────────────────────────
 * Value noise on an integer lattice is tileable if the hash is taken
 * modulo the lattice period. Each channel gets 8·2^k cells across the
 * tile — 8, 16, 32, 64 — so octave k is periodic over exactly one tile
 * and all four share a uv. The interpolant is the same smoothstep the
 * shader used, so the field is the same field.
 *
 * ── What changed, and what it cost ────────────────────────────────
 * Lacunarity had to go from 2.1 to 2.0 (a tileable octave has to be an
 * integer number of cells), and the octaves are decorrelated by seed
 * rather than by the old `p = p*2.1 + 17.3` shuffle. The fifth octave,
 * amplitude 1/32, is dropped.
 *
 * Measured over the real disk domain, 200k samples:
 *     procedural   mean 0.4825   sd 0.1234
 *     baked        mean 0.4837   sd 0.1204
 * The shader applies `v*1.0241 - 0.0126` to close that, so the disk's
 * brightness and contrast are identical rather than nearly identical.
 *
 * Also checked: angular autocorrelation around the disk at four radii,
 * looking for the tell-tale peak of a repeating tile. Peak spurious
 * correlation is 0.17–0.38, against 0.21–0.32 for the procedural version.
 * Same range — the tiling is not visible because a ring of radius ~9 in
 * noise space does not close on an 8-unit torus.
 */
function makeNoiseTexture(N = 512, tile = 8) {
    // The same hash the shader used, so the statistics carry over.
    const fract = x => x - Math.floor(x);
    function hash21(px, py) {
        let x = fract(px * 123.34), y = fract(py * 456.21);
        const d = x * (x + 45.32) + y * (y + 45.32);
        x += d; y += d;
        return fract(x * y);
    }
    const smooth = f => f * f * (3 - 2 * f);

    const data = new Uint8Array(N * N * 4);
    for (let k = 0; k < 4; k++) {
        const F = tile << k;

        // Lattice values first. Interpolating from a small table is what
        // makes this 40 ms instead of 4 s: 4096 hashes total rather than
        // one per texel per corner.
        const lat = new Float32Array(F * F);
        for (let j = 0; j < F; j++)
            for (let i = 0; i < F; i++)
                lat[j * F + i] = hash21(i + (k + 1) * 37, j + (k + 1) * 91);

        const sc = F / N;
        for (let j = 0; j < N; j++) {
            const py = j * sc, jy = Math.floor(py), fy = smooth(py - jy);
            const j0 = jy % F, j1 = (jy + 1) % F;
            for (let i = 0; i < N; i++) {
                const px = i * sc, ix = Math.floor(px), fx = smooth(px - ix);
                const i0 = ix % F, i1 = (ix + 1) % F;
                const a = lat[j0 * F + i0], b = lat[j0 * F + i1];
                const c = lat[j1 * F + i0], d = lat[j1 * F + i1];
                const t = a + (b - a) * fx, u = c + (d - c) * fx;
                data[(j * N + i) * 4 + k] = ((t + (u - t) * fy) * 255 + 0.5) | 0;
            }
        }
    }

    const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;

    // NoColorSpace, explicitly. These are four independent scalar fields,
    // not a picture. An sRGB decode would bend every one of them and the
    // measured mean above would stop being true.
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    return tex;
}

/**
 * A synthetic equirectangular sky, for when the real one does not arrive.
 *
 * Stars are placed uniform in cos(theta), not uniform in v. Uniform in v
 * looks correct in the texture and is wrong on the sphere: equirectangular
 * mapping stretches hardest at the poles, so equal spacing in v piles stars
 * up exactly where each texel covers the least sky. Uniform in cos(theta)
 * is uniform on the sphere, which is what a star field is.
 *
 * Brightness is rnd^3.2 — a few bright, a long faint tail. The real
 * distribution is a luminosity function and this is not it, but the visual
 * property that matters is that the eye finds a handful of anchors to track
 * the lensing by, and a flat distribution gives it none.
 */
function makeFallbackSky(W = 1024, H = 512) {
    const data = new Uint8Array(W * H * 4);
    // Not black. The mip chain converges on uSkyFlat as prefiltering
    // exhausts it, so start near that value rather than at zero, or the
    // last decade of the cascade steps down in brightness for no reason.
    for (let i = 0; i < W * H; i++) {
        data[i * 4] = 8; data[i * 4 + 1] = 9; data[i * 4 + 2] = 14; data[i * 4 + 3] = 255;
    }

    // Seeded LCG rather than Math.random: a fallback that looks different
    // on every reload is a fallback nobody can file a bug against.
    let seed = 20240613;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

    for (let n = 0; n < 12000; n++) {
        const x = Math.min(W - 1, (rnd() * W) | 0);
        const y = Math.min(H - 1, ((Math.acos(2 * rnd() - 1) / Math.PI) * H) | 0);
        const v = 40 + Math.pow(rnd(), 3.2) * 215;
        const t = 0.5 + 0.5 * rnd();          // crude stand-in for colour temperature
        const i4 = (y * W + x) * 4;
        data[i4]     = Math.min(255, data[i4]     + v * (0.75 + 0.25 * t));
        data[i4 + 1] = Math.min(255, data[i4 + 1] + v);
        data[i4 + 2] = Math.min(255, data[i4 + 2] + v * (1.15 - 0.25 * t));
    }

    const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
    // Same sampler setup as the real sky, including the wrapS = Repeat that
    // the u = 0/1 seam depends on.
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.colorSpace = starfield.colorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    tex.needsUpdate = true;
    return tex;
}

const noiseTex = makeNoiseTexture();

const material = createDiveMaterial({
    starfield,
    noise: noiseTex,
    rs: RS,
    spin: SPIN,
    width: canvas.clientWidth,
    height: canvas.clientHeight,
    coldness: COLDNESS,
    maxSteps: QUALITY[qIndex].steps,
});
const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
scene.add(quad);

/** ISCO — the disk's inner edge (Bardeen, Press & Teukolsky 1972). */
function iscoRadius(a) {
    const M  = BH_MASS;
    const Z1 = 1 + Math.cbrt(1 - a*a) * (Math.cbrt(1 + a) + Math.cbrt(1 - a));
    const Z2 = Math.sqrt(3*a*a + Z1*Z1);
    return M * (3 + Z2 - Math.sqrt(Math.max((3 - Z1) * (3 + Z1 + 2*Z2), 0)));
}
material.uniforms.uDiskIn.value  = iscoRadius(SPIN);
material.uniforms.uDiskOut.value = RS * 5.5;

// Texture width; the shader uses log2 of it as the mip ceiling. Set it
// wrong and we either prefilter too little (aliased noise) or too much
// (flat grey long before the source is actually uniform).
material.uniforms.uSkySize.value = 6000.0;

// Prefilter strength. 1.0 is the baseline; down towards 0.5 if the
// interior washes out, up towards 1.5 if the shadow edge aliases.
//
// This means something different than it used to. The shader now calls
// textureLod(), so the level it asks for is the level it gets. Before, it
// called texture2D() with the value as a *bias* on top of whatever the
// hardware derived from the uv derivative — and at the u = 0/1 seam of the
// equirectangular map that derivative jumps to ~1.0, i.e. mip 12.5, i.e. a
// one-pixel column of flat grey down the starfield. The measured term is
// back in the shader, taken from the derivative of the escape direction
// instead, which has no seam.
material.uniforms.uPrefilter.value = 1.0;

// Screen-space footprint term, 0 to disable and fall back to inferred-only
// filtering (spectral band + winding order).
material.uniforms.uFootprint.value = 1.0;

// Mip selection for the disk turbulence, 0 to pin it to level 0. Level 0
// is what the procedural version effectively did — procedural noise has no
// filtering, which is why the outer disk shimmers under motion.
material.uniforms.uDiskLod.value = 1.0;

// Ring annotation: 0 = off. It was a golden, growing, 14× amplified light
// source in the middle of the frame, and not one photon from it exists —
// we never reach it, and a singularity emits nothing. See DiveShader.
material.uniforms.uRingOverlay.value = 0.0;

// =====================================================================
//  The trajectory — computed once, used for the rest of the run
// =====================================================================

/**
 * Integrates the whole fall and stores it as a table of snapshots.
 *
 * Sample density is driven by MOTION, not by proper time. That matters
 * more than it looks: with a fixed τ step of 0.01·r, two neighbouring
 * samples sat 39% of r apart down at r ≈ 0.33 Rs and the momentum changed
 * 27% between them. The path curves hard there, so a straight line between
 * two samples cuts the corner — the camera's speed dipped between samples
 * and recovered at the next one. One soft pulse per sample.
 *
 * Criterion now: store a snapshot when position has moved 1.5% of r, or
 * momentum has changed by 1.5%. That gives ~2000 samples placed where
 * something is happening. The integration work is unchanged; only how
 * often we look at the result.
 */
function buildTrajectory() {
    // z0 = 4 puts the start slightly out of the equatorial plane. Without
    // it the disk is seen exactly edge-on the whole way down; with a tilt
    // the path swings through the plane and the disk opens up en route.
    const g = new DiveGeodesic({
        M: BH_MASS, spin: SPIN, r0: 60, angMom: 13, inward: 0.02, z0: 4.0,
    });

    const rH = g.horizon;
    const samples = [];
    let horizonIndex = -1;

    const push = () => {
        const v = g.velocity();
        samples.push({
            x: g.pos.x, y: g.pos.y, z: g.pos.z,
            px: g.mom.x, py: g.mom.y, pz: g.mom.z,
            vx: v.x, vy: v.y, vz: v.z,
            r: g.r, tau: g.tau, t: g.coordTime, tBL,
            H: g.hamiltonianCheck(),
        });
    };

    // ── The distant observer's clock ──
    // g.coordTime is KERR-SCHILD time, which is horizon-penetrating:
    // measured, it reads 546.8 just before the crossing and 616 where
    // integration ends. Perfectly smooth. It does NOT diverge, and the
    // panel used to claim it did by printing '→ ∞' as a literal string.
    //
    // The clock that actually diverges is Boyer-Lindquist time — the
    // coordinate an observer infinitely far away would use. One transform
    // connects them:
    //
    //     dt_BL = dt_KS − (2Mr / Δ) dr,      Δ = r² − 2Mr + a²
    //
    // Δ has a root exactly at r₊, so the integral goes logarithmically to
    // infinity on the way in. Measured: 354 at 1.05 Rs, 601 at 0.80 Rs,
    // 678 at 0.7640 Rs and still climbing. That is the number the panel
    // shows now, and it runs away on its own without anyone writing it.
    //
    // Inside, Boyer-Lindquist does not exist at all — Δ changes sign. So
    // we stop accumulating there, and the panel says why.
    let tBL = 0;
    let rPrev = g.r, tKSPrev = g.coordTime;
    const AA = SPIN * BH_MASS;

    push();
    let last = samples[0];
    let guard = 0;
    while (g.valid && guard++ < 400000) {
        // Never request a step much larger than the one the integrator
        // would take itself, or we store a single snapshot of something
        // that contained hundreds of substeps.
        g.advance(Math.min(Math.max(1e-5, 0.01 * g.r), 0.75 * g.suggestedStep()));

        // Trapezoid on (2Mr/Δ)dr, only while both endpoints are outside.
        const rNow = g.r;
        if (rNow > rH * 1.000001 && rPrev > rH * 1.000001) {
            const rm = 0.5 * (rNow + rPrev);
            const Delta = rm * rm - 2 * BH_MASS * rm + AA * AA;
            tBL += (g.coordTime - tKSPrev) - (2 * BH_MASS * rm / Delta) * (rNow - rPrev);
        }
        rPrev = rNow; tKSPrev = g.coordTime;

        const dx = g.pos.x - last.x, dy = g.pos.y - last.y, dz = g.pos.z - last.z;
        const dp = Math.hypot(g.mom.x - last.px, g.mom.y - last.py, g.mom.z - last.pz);
        const pm = Math.hypot(last.px, last.py, last.pz);
        const tol = 0.015 * Math.max(g.r, 0.35);

        if (!g.valid || dx*dx + dy*dy + dz*dz >= tol*tol || dp >= 0.015 * Math.max(pm, 0.3)) {
            push();
            last = samples[samples.length - 1];
        }
    }
    if (samples[samples.length - 1] !== last) push();

    for (let i = 0; i < samples.length; i++) {
        if (samples[i].r <= rH) { horizonIndex = i; break; }
    }

    // Visual progression: linear in log(r). Equal steps in log r correspond
    // roughly to equal steps in "how much bigger the hole looks now", which
    // is the scale the eye actually experiences.
    //
    // runningMin rather than r itself is a guard against a non-monotonic
    // path — a plunge with enough angular momentum can have outward
    // excursions, and playback must never run backwards. Probed for these
    // initial conditions: r is strictly monotonic, 0 of 1962 steps outward,
    // so the guard costs nothing and protects against a future angMom edit.
    const r0 = samples[0].r;
    const rEnd = samples[samples.length - 1].r;
    const span = Math.log(r0) - Math.log(rEnd);
    let runningMin = r0;
    for (const s of samples) {
        runningMin = Math.min(runningMin, s.r);
        s.v = (Math.log(r0) - Math.log(runningMin)) / span;
    }

    // With these initial conditions the path always crosses. The fallback
    // exists so a future angMom change yields a strange exhibit rather than
    // a white screen and a TypeError.
    if (horizonIndex < 0) {
        console.warn('[dive] trajectory never reached the horizon — check angMom');
        horizonIndex = samples.length - 1;
    }

    return { samples, horizonIndex, rH, vHorizon: samples[horizonIndex].v, pt: g.pt };
}

// If the integrator throws, module evaluation stops here and every line
// below it — including the one that wires up the notice element — never
// runs. So this one failure has to reach the DOM directly, or the visitor
// gets a black rectangle and no way to tell it apart from a slow load.
let traj;
try {
    traj = buildTrajectory();
} catch (err) {
    const n = document.getElementById('notice');
    if (n) {
        n.textContent = 'The trajectory could not be integrated. The exhibit cannot start.';
        n.className = 'notice visible warn';
    }
    throw err;
}
material.uniforms.uRayStop.value = traj.rH * 1.005;

// ── The dark cone ─────────────────────────────────────────────────────
// The same number the shader decides every pixel with, computed once for
// the whole frame so the panel can display it.
//   E = A + n·B for a photon in direction n
//   |B|² = A² − 1 + f      (because ∂_t·∂_t = −1 + f)
// E changes sign on the cone cos θ = A/|B|, which only exists where f > 1,
// i.e. inside the ergosphere.
const A_OBS = -traj.pt;   // the observer's conserved energy, −u_t

// The shader needs the same A to turn the dark cone into a continuous
// quantity instead of a yes/no. It is conserved along the geodesic, so it
// is set once.
material.uniforms.uAobs.value = A_OBS;

function darkConeDeg(pos) {
    const a  = SPIN * BH_MASS;
    const r  = ksR(pos.x, pos.y, pos.z, a);
    const r2 = r * r;
    const f  = 2 * BH_MASS * r2 * r / (r2 * r2 + a * a * pos.z * pos.z);
    const B2 = A_OBS * A_OBS - 1 + f;
    if (B2 <= A_OBS * A_OBS) return 0;
    return Math.acos(Math.min(1, A_OBS / Math.sqrt(B2))) * 180 / Math.PI;
}

/**
 * Catmull-Rom in Hermite form, with unevenly spaced knots.
 *
 * The difference from linear interpolation is that this curve knows its
 * own SLOPE at the endpoints — the tangent is estimated from the
 * neighbours on either side. A straight line between two points on a
 * curved path cuts the corner; a curve that starts and ends pointing the
 * right way does not.
 */
function hermite(p0, p1, p2, p3, v0, v1, v2, v3, t) {
    const h  = v2 - v1;
    const m1 = (v2 - v0) > 1e-12 ? (p2 - p0) / (v2 - v0) * h : (p2 - p1);
    const m2 = (v3 - v1) > 1e-12 ? (p3 - p1) / (v3 - v1) * h : (p2 - p1);
    const t2 = t * t, t3 = t2 * t;
    return (2*t3 - 3*t2 + 1) * p1 + (t3 - 2*t2 + t) * m1
         + (-2*t3 + 3*t2) * p2 + (t3 - t2) * m2;
}

// Scratch objects for sampleAt(). Allocating four objects per frame is not
// expensive, but it is garbage on a 60 Hz loop for no reason, and GC pauses
// are exactly the kind of thing that reads as a stutter.
const _sPos   = new THREE.Vector3();
const _sVel   = new THREE.Vector3();
const _sMom   = { x: 0, y: 0, z: 0 };
const _sFrame = { pos: { x: 0, y: 0, z: 0 }, mom: _sMom, pt: 0 };
const _sample = { pos: _sPos, vel: _sVel, r: 0, tau: 0, t: 0, H: 0, tBL: 0, frame: _sFrame };

/** Looks up the trajectory at visual progression v ∈ [0,1], interpolated. */
function sampleAt(v) {
    const S = traj.samples;
    v = Math.max(0, Math.min(1, v));
    // Binary search — s.v is monotonically increasing by construction.
    let lo = 0, hi = S.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (S[mid].v <= v) lo = mid; else hi = mid;
    }
    const P = S[Math.max(0, lo - 1)], a = S[lo], b = S[hi], Q = S[Math.min(S.length - 1, hi + 1)];
    const f = b.v > a.v ? (v - a.v) / (b.v - a.v) : 0;
    const L = k => hermite(P[k], a[k], b[k], Q[k], P.v, a.v, b.v, Q.v, f);

    _sPos.set(L('x'), L('y'), L('z'));
    _sVel.set(L('vx'), L('vy'), L('vz'));
    _sMom.x = L('px'); _sMom.y = L('py'); _sMom.z = L('pz');

    _sample.r = L('r'); _sample.tau = L('tau'); _sample.t = L('t'); _sample.H = L('H');
    // tBL grows logarithmically towards infinity. Hermite can overshoot on
    // a curve that steep, so clamp it between its two neighbours.
    _sample.tBL = Math.max(a.tBL, Math.min(b.tBL, L('tBL')));

    _sFrame.pos.x = _sPos.x; _sFrame.pos.y = _sPos.y; _sFrame.pos.z = _sPos.z;
    // Interpolated pair + locally re-solved pt = smooth AND valid.
    _sFrame.pt = solvePtAt(_sFrame.pos, _sMom, BH_MASS, SPIN * BH_MASS);

    return _sample;
}

// =====================================================================
//  Pacing
// =====================================================================

const clamp01   = u => Math.max(0, Math.min(1, u));

function smoothstep(e0, e1, x) {
    const u = clamp01((x - e0) / (e1 - e0));
    return u * u * (3 - 2 * u);
}

/** Perlin's smootherstep. C² at both ends, where smoothstep is only C¹. */
function smootherstep(e0, e1, x) {
    const u = clamp01((x - e0) / (e1 - e0));
    return u * u * u * (u * (u * 6 - 15) + 10);
}

/**
 * ── Why the pacing is one curve and not three ────────────────────────
 *
 * The fall used to be spliced from three separately eased segments:
 *   approach   v = easeInOut(t/22) · vH
 *   crossing   v = vH + linear
 *   interior   v = vH + easeInOut(...)
 *
 * Every segment matched its neighbour in VALUE, so the position was
 * continuous and nothing looked broken in code review. The DERIVATIVE did
 * not match, and the derivative is the thing you see. Probed dv/dt across
 * the seams:
 *
 *     t = 21.5   0.00276     approach easing out towards zero
 *     t = 22.0   0.00946     crossing starts at constant speed  ← jump up
 *     t = 25.0   0.00946
 *     t = 26.0   0.00304     interior easeInOut starts at zero  ← 3× drop
 *     t = 27.5   0.01216     and recovers
 *
 * Two discontinuities, both inside the horizon-crossing window: the camera
 * decelerated to a near-stop, jumped, then stalled again and picked back
 * up. Exactly the "small stops on the way from Falling to Inside".
 *
 * The fix is structural rather than a tuned fudge. Instead of splicing
 * eased positions, define a SPEED profile that is smooth and strictly
 * positive, then integrate it. Continuity of v and of dv/dt is then
 * guaranteed by construction, not by matching constants by hand.
 *
 * The profile: ease up over the first 14%, hold, ease down to rest over
 * the last 20%. Built from smootherstep, so speed is C² and progress is
 * C³ — there is no seam left to find.
 *
 * The end taper going all the way to zero is deliberate and physical: the
 * trajectory table genuinely ends at r = 0.275 Rs, so the camera has to
 * arrive at rest rather than hit a wall.
 */
function fallSpeed(u) {
    const rampIn  = 0.12 + 0.88 * smootherstep(0.00, 0.14, u);
    const rampOut = 1 - smootherstep(0.80, 1.00, u);
    return rampIn * rampOut;
}

/**
 * Normalised integral of fallSpeed, tabulated at load.
 *
 * Sampling is uniform in u, so the lookup is a direct index with a lerp —
 * no inversion needed. 1024 entries puts the piecewise-linear error about
 * six orders of magnitude below anything visible.
 */
const PACE_N = 1024;
const PACE = (() => {
    const c = new Float64Array(PACE_N + 1);
    let acc = 0, prev = fallSpeed(0);
    for (let i = 1; i <= PACE_N; i++) {
        const s = fallSpeed(i / PACE_N);
        acc += 0.5 * (prev + s);
        c[i] = acc;
        prev = s;
    }
    for (let i = 0; i <= PACE_N; i++) c[i] /= acc;
    return c;
})();

function fallProgress(u) {
    const f = clamp01(u) * PACE_N;
    const i = Math.min(PACE_N - 1, Math.floor(f));
    return PACE[i] + (PACE[i + 1] - PACE[i]) * (f - i);
}

/**
 * Translates wall-clock seconds into (visual progression, phase params).
 * All pacing lives here.
 *
 * The three ending parameters:
 *   blue  — multiplies g directly, i.e. the blueshift itself. Not an
 *           overlay: the shader derives colour, structure and brightness
 *           from g, so one number drives the whole ending. Because it is a
 *           MULTIPLIER the ordering is preserved exactly — the pixels that
 *           were already most blueshifted stay most blueshifted, and that
 *           is the rim of the dark cone, where E_∞ → 0. The rim burns out
 *           first because the geometry says so.
 *
 *           The curve is steep on purpose. The cascade is logarithmic in
 *           g — two decades between "blue" and near-IR, three more to
 *           microwave — so a linear fade would spend half its time doing
 *           nothing and the rest doing everything.
 *   white — a safety line, no longer the ending itself.
 *   dim   — the burn-down afterwards. White → black, then the text.
 */
function timeline(t) {
    let v, phase = 'falling', blue = 0, white = 0, dim = 1, plate = 0;

    if (t < T_FALL) {
        const u = t / T_FALL;
        v = fallProgress(u);
        // Starts while there is still motion. If it waited for the fall to
        // finish, the camera would stand still for eight seconds while only
        // brightness changed, and that reads as a fade rather than an event.
        // smoothstep is flat at u = 1, so it hands over to the branch below
        // with matching slope.
        blue = 0.10 * smoothstep(0.88, 1.0, u);

    } else if (t < T_FALL + T_WHITE) {
        const u = (t - T_FALL) / T_WHITE;
        phase = 'cauchy';
        v = 1;
        // Exponent > 1: slow at first, then it runs away. That is the shape
        // of mass inflation, not a linear ramp. Also flat at u = 0, so it
        // continues the branch above without a kink.
        //
        // It used to be 2.4, which was compensating for a boost law that was
        // linear in uBlue. The shader's boost is exponential now — uBlue is
        // effectively a count of decades — so most of the shaping has moved
        // where it belongs and this only has to supply the acceleration.
        // At 2.4 the first half of the finale would cover 0.6 decades and the
        // second half 2.6; at 1.3 it is closer to even, which is what lets
        // each band actually be seen on the way past.
        blue  = 0.10 + 0.90 * Math.pow(u, 1.3);
        // The wash arrives late and weak. The cascade reaches white on its
        // own; this only guarantees a clean handover to the plate.
        white = Math.pow(clamp01((u - 0.66) / 0.34), 2.0);

    } else {
        const u = clamp01((t - T_FALL - T_WHITE) / T_PLATE);
        phase = 'end';
        v = 1; blue = 1; white = 1;
        dim   = 1 - smoothstep(0.03, 0.30, u);
        plate = smoothstep(0.34, 0.52, u);
    }

    return { v, blue, white, dim, plate, phase };
}

// =====================================================================
//  What used to happen at the horizon
// =====================================================================
//
// The exhibit's whole claim is that NOTHING happens at the horizon. And
// yet the crossing was the most eventful cut in the animation. Not because
// the physics changed — the raymarch does exactly the same thing on both
// sides, there is no special-casing anywhere — but because four AUTHORED
// things all hung off vHorizon:
//
//     1. a forced 180° turn over 3.5 s, keyed to the crossing
//     2. uInside, which switched on all the drawing
//     3. the mode label, announcing "Crossing the horizon"
//     4. the |p|² death limit in the shader, 1e4 → 2e3
//
// Item 2 no longer exists as a problem: there is no drawing left to switch
// on. The others were moved.
//
// The fix is not to remove the signal — then the visitor never knows when
// they crossed and the point evaporates. The fix is to move it from the
// IMAGE to the INSTRUMENTS. The numbers may shout. The picture may not blink.
//
// So everything visual now hangs on the dark cone instead, and the cone is
// a real physical quantity that knows nothing about the horizon. It first
// exists where f > 1, i.e. at the ERGOSPHERE, 31% further out. Measured
// along this exact trajectory:
//
//     r/Rs = 1.000  (ergosphere)    cone =  0.4°
//     r/Rs = 0.900                  cone = 19.3°
//     r/Rs = 0.763  (HORIZON)       cone = 30.3°   ← nothing special
//     r/Rs = 0.600                  cone = 40.6°
//     r/Rs = 0.275  (stop)          cone = 59.4°
//
// Smooth throughout. There is no kink at 30.3°, and that is the point: the
// transition now spans ~14 seconds with the crossing in the middle of it,
// where nobody notices.
//
// These constants now gate only the ring contour, which is off by default.
// They stay because they are the right fade-in IF it is switched on: it
// should not pop, it should arrive with the cone like everything else.
const CONE_DRAW_LO =  5.0;   // contour begins to fade in (r ≈ 0.993 Rs)
const CONE_DRAW_HI = 35.0;   // fully faded in (r ≈ 0.70 Rs)

/**
 * Mode label, with no "you just crossed" announcement. "Falling" holds all
 * the way through the horizon and only changes once the cone is well open
 * — long afterwards, and for a different reason.
 */
function phaseLabel(phase, coneDeg) {
    if (phase === 'cauchy') return 'Blueshift — spectrum shifting out of sight';
    if (phase === 'end')    return '';
    return coneDeg > 42 ? 'Inside' : 'Falling';
}

// =====================================================================
//  Camera orientation
// =====================================================================

const SPIN_AXIS = new THREE.Vector3(0, 0, 1);  // Kerr-Schild: spin about z

// Look state. yaw/pitch are measured against the CAMERA'S rest frame, i.e.
// against the hole, not against the world. yaw = 0 is "hole centred",
// yaw = π is "hole behind you".
let lookYaw = 0, lookPitch = 0;        // smoothed; what the shader sees
let targetYaw = 0, targetPitch = 0;    // where input is pointing

const PITCH_LIMIT = 1.40;   // ~80°, keeps us off the equirect poles
const DRAG_SPEED  = 0.005;  // radians per pixel
const KEY_SPEED   = 1.6;    // radians per second
const SMOOTH_RATE = 9.0;    // how fast look catches up with target

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _velDir = new THREE.Vector3();
const _qYaw   = new THREE.Quaternion();
const _qPitch = new THREE.Quaternion();

// The rest frame — the un-rotated basis. The tetrad is seeded with THIS,
// never with the rotated one. See the note above orientCamera().
const _baseR = new THREE.Vector3();
const _baseU = new THREE.Vector3();
const _baseF = new THREE.Vector3();

// The rotation as plain numbers in that basis: _lookM[i] is the i-th
// rotated axis written in (baseR, baseU, baseF). Nine numbers, and they
// are a genuine rotation matrix because both bases are orthonormal.
const _lookM = [[1,0,0], [0,1,0], [0,0,1]];

/**
 * Builds the camera basis in two stages: first the rest direction (inward,
 * blended with the direction of motion), then the user's rotation on top.
 *
 * ── Why the rotation no longer lives here ──
 * The old version rotated _fwd/_right/_up as ordinary arrows in KS
 * coordinates and passed them on as seeds to buildTetrad(). But Gram-
 * Schmidt straightens seeds against the metric AND the observer's
 * four-velocity, and that straightening is not a rotation. It squeezes
 * directions together forward and stretches them backward — that is
 * aberration, the same effect that turns the sky into a cone.
 *
 * The consequence was that the handle sat in coordinate space while the
 * image lives in the observer's eye, with a lens in between. Measured at
 * r = 0.275 Rs: 5° of mouse movement turned the view between 0.85° and
 * 28.47° depending on where in the sweep you were. A factor of 33.6.
 * Outside the horizon the ratio was 1.1, which is why it only felt broken
 * in there.
 *
 * Now the rest frame is built here and the rotation is delivered
 * separately as _lookM, applied to the tetrad's three spatial legs — inside
 * the observer's own orthonormal basis, where a rotation is a rotation.
 * 5° of mouse gives 5° of view, everywhere.
 */
function orientCamera(pos, vel) {
    // ── 1. Rest frame ──
    _baseF.copy(pos).normalize().multiplyScalar(-1);
    if (vel.lengthSq() > 1e-9) {
        _velDir.copy(vel).normalize();
        _baseF.addScaledVector(_velDir, 0.35).normalize();
    }

    // cross(fwd, spin axis) is zero if the two are parallel, and then the
    // whole basis becomes NaN — black screen, no console error. Guard it.
    _baseR.crossVectors(_baseF, SPIN_AXIS);
    if (_baseR.lengthSq() < 1e-12) _baseR.set(1, 0, 0);
    _baseR.normalize();
    _baseU.crossVectors(_baseR, _baseF).normalize();

    // ── 2. Rotate the frame ──
    // Two hand-authored motions used to live here and both are gone.
    //
    // One was a forced 180° turn over ~14 s, keyed to the cone angle. Well
    // meant — inside, the fall direction is dark and everything left to see
    // is behind you — but it fought the user's own input. You turned one
    // way and the camera quietly pulled another, and there was no telling
    // which motion was yours.
    //
    // The other was two sine waves rocking the frame a couple of degrees to
    // make it feel alive. That is film grammar, not physics, and it does the
    // same damage to the sense of control.
    //
    // Everything that moves the camera now comes either from the user or
    // from the geodesic. There is no third source. "Look back" still does
    // 180° on one press, and R resets — but those are chosen.
    _fwd.copy(_baseF); _right.copy(_baseR); _up.copy(_baseU);

    // Yaw about _up, which is built from the spin axis, so roll can never
    // creep in: the horizon stays level for free. Negative because positive
    // yaw should mean "look right".
    _qYaw.setFromAxisAngle(_up, -lookYaw);
    _fwd.applyQuaternion(_qYaw);
    _right.applyQuaternion(_qYaw);

    // Pitch about the NEW right axis. Rotations do not commute; using the
    // old axis here gives a skewed composition that looks like gimbal lock
    // at large angles but is a different bug entirely.
    _qPitch.setFromAxisAngle(_right, lookPitch);
    _fwd.applyQuaternion(_qPitch);

    _up.crossVectors(_right, _fwd).normalize();

    // ── 3. Write the rotation down as nine numbers ──
    // No sign-and-handedness derivation: just project each rotated axis onto
    // the un-rotated basis. Both are orthonormal, so the result IS the
    // rotation matrix and can be applied straight to the tetrad.
    _lookM[0][0] = _right.dot(_baseR); _lookM[0][1] = _right.dot(_baseU); _lookM[0][2] = _right.dot(_baseF);
    _lookM[1][0] = _up.dot(_baseR);    _lookM[1][1] = _up.dot(_baseU);    _lookM[1][2] = _up.dot(_baseF);
    _lookM[2][0] = _fwd.dot(_baseR);   _lookM[2][1] = _fwd.dot(_baseU);   _lookM[2][2] = _fwd.dot(_baseF);
}

/**
 * Applies the rotation to the tetrad's spatial legs.
 *
 * e0 is untouched — turning your head does not change your motion. The
 * other three are mixed with an orthogonal matrix, the only operation that
 * preserves <e_i, e_j> = δ_ij exactly. It is still a tetrad afterwards, to
 * the eleven decimals checkTetrad() measures.
 */
function rotateTetrad(tet, Mx) {
    const mix = m => {
        const o = [0, 0, 0, 0];
        for (let c = 0; c < 4; c++)
            o[c] = m[0] * tet[1][c] + m[1] * tet[2][c] + m[2] * tet[3][c];
        return o;
    };
    return [tet[0], mix(Mx[0]), mix(Mx[1]), mix(Mx[2])];
}

// =====================================================================
//  Is there anything to see ahead?
// =====================================================================
//
// At the end of the fall the view down the fall direction is completely
// black, and a visitor who never turns around watches the entire spectral
// cascade happen on an empty screen. Traced at r = 0.275 Rs, sweeping yaw:
//
//     yaw     fraction of screen with a source     median gShift
//       0°       0%                                    —
//      45°       3%                                  9.614   ← the cone rim
//      90°      47%                                  1.306
//     150°     100%                                  0.614
//     180°     100%                                  0.437
//
// Not a bug in the physics — nothing does reach you from ahead — but a bug
// in the exhibit, because the one derived thing the ending has to show is
// invisible by default. The response stays on the instrument side: the Look
// back button lights up. No text over the image, and the camera never moves
// on its own.
//
// ── Two cheaper tests that both failed ─────────────────────────────
// 1. The dark cone (p_t <= 0). Wrong quantity. The cone is where light
//    cannot exist; the SHADOW — rays that carry positive energy and still
//    fall in — is much wider, and the shadow is what you see. A cone test
//    called four of nine sample points "has a source" at yaw = 0, where the
//    traced screen is 0% sky.
//
// 2. A measured shadow half-angle about the B axis, interpolated by depth.
//    Agreed with a traced sweep 19 times out of 28. It fails because the
//    Kerr shadow is not axisymmetric about B — frame dragging makes it
//    D-shaped — so no single half-angle describes it. Tabulated, the angle
//    to B does not separate the two cases at all: at r = 0.275 Rs, yaw = 0
//    is dark at 140° while yaw = 60° has sky at 150°.
//
// So it is measured directly, by tracing. Fifteen rays on a coarse grid,
// three times a second, and only below r ≈ 1.2 Rs where the frame can be
// fully dark at all. Against a full 23×13 traced sweep over five depths,
// eight yaw angles and two pitch angles: agreement 79 of 80, at 1.7 ms per
// evaluation, i.e. about half a percent of one core.
//
// The cost of doing it this way is a second copy of the integrator, in JS,
// which has to stay in step with the GLSL one. That is a real liability and
// it is the reason the two cheaper tests were tried first.

const DARK_PROBE_INTERVAL = 1 / 3;   // seconds between evaluations
const DARK_PROBE_MIN_V    = 0.45;    // above r ≈ 1.2 Rs the frame is never dark
const DARK_PROBE_STEPS    = 600;

// Normalised screen taps: 5 across, 3 down, inside the frame rather than on
// its exact edge so a single corner pixel cannot decide the answer.
const DARK_TAPS = [];
for (const ty of [-0.85, 0, 0.85]) for (const tx of [-0.9, -0.45, 0, 0.45, 0.9]) DARK_TAPS.push(tx, ty);

let darkProbeAcc = DARK_PROBE_INTERVAL;
let frameIsDark  = false;

// Scratch, module-level, so a probe pass allocates nothing.
const _pm = { r: 0, f: 0, lx: 0, ly: 0, lz: 0, D: 0, W: 0 };
const _pk = new Float64Array(24);   // k1..k4, each (dx, dp)

/** Metric plus the two extra terms the analytic gradient needs. */
function probeMetric(x, y, z) {
    const aa = SPIN * BH_MASS;
    const r  = ksR(x, y, z, aa), r2 = r * r;
    _pm.r = r;
    _pm.D = r2 * r2 + aa * aa * z * z;
    _pm.W = r2 + aa * aa;
    _pm.f = 2 * BH_MASS * r2 * r / _pm.D;
    _pm.lx = (r * x + aa * y) / _pm.W;
    _pm.ly = (r * y - aa * x) / _pm.W;
    _pm.lz = z / r;
}

/** Hamilton's equations, same closed form as DiveShader's derivAt/dpdl. */
function probeDeriv(x, y, z, px, py, pz, pt, out, o) {
    const M = BH_MASS, aa = SPIN * M;
    probeMetric(x, y, z);
    const r = _pm.r, r2 = r * r, r3 = r2 * r, az = aa * z, iD = 1 / _pm.D, W = _pm.W;
    const S = _pm.lx * px + _pm.ly * py + _pm.lz * pz - pt;

    out[o]     = px - _pm.f * S * _pm.lx;
    out[o + 1] = py - _pm.f * S * _pm.ly;
    out[o + 2] = pz - _pm.f * S * _pm.lz;

    const grx = r3 * x * iD, gry = r3 * y * iD, grz = r * z * W * iD;
    const gf  = 2 * M * r2 * (3 * az * az - r2 * r2) * iD * iD;
    const gFx = gf * grx, gFy = gf * gry;
    const gFz = gf * grz - 4 * M * aa * aa * z * r3 * iD * iD;

    const Q = px * x + py * y, L = px * y - py * x;
    const C = Q / W - 2 * r * (r * Q + aa * L) / (W * W) - pz * z / r2;
    const gLx = C * grx + (px * r - py * aa) / W;
    const gLy = C * gry + (px * aa + py * r) / W;
    const gLz = C * grz + pz / r;

    const h = 0.5 * S * S, fS = _pm.f * S;
    out[o + 3] = h * gFx + fS * gLx;
    out[o + 4] = h * gFy + fS * gLy;
    out[o + 5] = h * gFz + fS * gLz;
}

/** One ray. True if it escapes to the sky. Mirrors the shader's main loop. */
function probeRay(x, y, z, px, py, pz, pt, rayStop, pMax2) {
    for (let i = 0; i < DARK_PROBE_STEPS; i++) {
        probeDeriv(x, y, z, px, py, pz, pt, _pk, 0);
        const r = _pm.r;
        if (r < rayStop) return false;
        if (px*px + py*py + pz*pz > pMax2) return false;
        if (r > 160 || (r > RS * 8 && _pk[0]*x + _pk[1]*y + _pk[2]*z > 0)) return true;

        const sp = Math.max(Math.hypot(_pk[0], _pk[1], _pk[2]), 1e-4);
        let want = Math.min(1.1 * Math.min(Math.max(r / (RS * 1.5), 0.3), 8.0), 0.5 * r);
        want /= 1 + 3 * (1 - smoothstep(RS*1.6, RS*4.0, r)) * smoothstep(RS*0.6, RS*1.0, r);
        const dl = want / sp;

        probeDeriv(x + 0.5*dl*_pk[0], y + 0.5*dl*_pk[1], z + 0.5*dl*_pk[2],
                   px + 0.5*dl*_pk[3], py + 0.5*dl*_pk[4], pz + 0.5*dl*_pk[5], pt, _pk, 6);
        probeDeriv(x + 0.5*dl*_pk[6], y + 0.5*dl*_pk[7], z + 0.5*dl*_pk[8],
                   px + 0.5*dl*_pk[9], py + 0.5*dl*_pk[10], pz + 0.5*dl*_pk[11], pt, _pk, 12);
        probeDeriv(x + dl*_pk[12], y + dl*_pk[13], z + dl*_pk[14],
                   px + dl*_pk[15], py + dl*_pk[16], pz + dl*_pk[17], pt, _pk, 18);

        const w = dl / 6;
        x  += w * (_pk[0]  + 2*_pk[6]  + 2*_pk[12] + _pk[18]);
        y  += w * (_pk[1]  + 2*_pk[7]  + 2*_pk[13] + _pk[19]);
        z  += w * (_pk[2]  + 2*_pk[8]  + 2*_pk[14] + _pk[20]);
        px += w * (_pk[3]  + 2*_pk[9]  + 2*_pk[15] + _pk[21]);
        py += w * (_pk[4]  + 2*_pk[10] + 2*_pk[16] + _pk[22]);
        pz += w * (_pk[5]  + 2*_pk[11] + 2*_pk[17] + _pk[23]);
    }
    // Out of budget: only counts as sky if far out and heading outwards,
    // which is the same rule the shader applies.
    probeDeriv(x, y, z, px, py, pz, pt, _pk, 0);
    return _pm.r > RS * 4 && _pk[0]*x + _pk[1]*y + _pk[2]*z > 0;
}

/** True when not one of the taps finds a source. */
function probeFrameDark(view, pos, fovDeg, aspect, rayStop, pMax2) {
    const halfTan = Math.tan(fovDeg * 0.5 * Math.PI / 180);
    probeMetric(pos.x, pos.y, pos.z);
    const f = _pm.f, lx = _pm.lx, ly = _pm.ly, lz = _pm.lz;

    for (let t = 0; t < DARK_TAPS.length; t += 2) {
        const nx = DARK_TAPS[t] * aspect * halfTan, ny = DARK_TAPS[t + 1] * halfTan;
        const inv = 1 / Math.hypot(nx, ny, 1);
        const n0 = nx * inv, n1 = ny * inv, n2 = inv;

        // k = −e0 + n·(e1,e2,e3), exactly as the shader builds it.
        let kt = -view[0][0], kx = -view[0][1], ky = -view[0][2], kz = -view[0][3];
        kt += n0*view[1][0] + n1*view[2][0] + n2*view[3][0];
        kx += n0*view[1][1] + n1*view[2][1] + n2*view[3][1];
        ky += n0*view[1][2] + n1*view[2][2] + n2*view[3][2];
        kz += n0*view[1][3] + n1*view[2][3] + n2*view[3][3];

        const Lk = kt + lx*kx + ly*ky + lz*kz;
        let pt = -kt + f * Lk;
        let px = kx + f * Lk * lx, py = ky + f * Lk * ly, pz = kz + f * Lk * lz;
        if (pt <= 0) continue;                       // inside the cone, no source

        const sc = 1 / Math.max(Math.hypot(px, py, pz), 1e-6);
        px *= sc; py *= sc; pz *= sc; pt *= sc;

        if (probeRay(pos.x, pos.y, pos.z, px, py, pz, pt, rayStop, pMax2)) return false;
    }
    return true;
}

// ── The "out" direction, done properly ───────────────────────────────
// uOutDir used to be normalize(pos): "away from the centre". That holds for
// an observer falling straight in. This one is not — with angMom 13 and
// frame dragging she is whipped around, and down at r = 0.275 Rs the radial
// direction sits 118° away from where the universe actually is.
//
// The right quantity is B: the part of the time-translation vector ∂/∂t
// that points somewhere in HER space. Everything outside the hole is at
// rest relative to ∂/∂t, so B is by definition the way "out" lies. The dark
// cone sits opposite, about −B.
const _XI = [1, 0, 0, 0];

function outAxisFrom(framePos, tet, into) {
    const aa = SPIN * BH_MASS;
    const xu = dotG(framePos, BH_MASS, aa, _XI, tet[0]);   // = −A, the observer's energy
    const B  = [_XI[0] + xu * tet[0][0], _XI[1] + xu * tet[0][1],
                _XI[2] + xu * tet[0][2], _XI[3] + xu * tet[0][3]];
    // Components along the UN-rotated legs, to match the basis below.
    const b1 = dotG(framePos, BH_MASS, aa, B, tet[1]);
    const b2 = dotG(framePos, BH_MASS, aa, B, tet[2]);
    const b3 = dotG(framePos, BH_MASS, aa, B, tet[3]);
    const n  = Math.hypot(b1, b2, b3);
    if (!(n > 1e-9)) return;      // B = 0 exactly at the turning point. Keep the last.
    into.set(0, 0, 0)
        .addScaledVector(_baseR, b1 / n)
        .addScaledVector(_baseU, b2 / n)
        .addScaledVector(_baseF, b3 / n)
        .normalize();
}

// ── Drag ──────────────────────────────────────────────────────────────
// Drag sets the target directly from a pixel delta. No integration: the
// mouse reports how far it moved, not how fast.
let dragging = false, lastX = 0, lastY = 0;

on(canvas, 'pointerdown', e => {
    dragging = true;
    lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
});

on(canvas, 'pointermove', e => {
    if (!dragging) return;
    // "Grab the sky": drag right and the sky follows right, so you turn
    // left. Flip the signs for the FPS feel.
    targetYaw   -= (e.clientX - lastX) * DRAG_SPEED;
    targetPitch += (e.clientY - lastY) * DRAG_SPEED;
    targetPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, targetPitch));
    lastX = e.clientX; lastY = e.clientY;
});

const endDrag = e => {
    dragging = false;
    if (e.pointerId !== undefined) canvas.releasePointerCapture?.(e.pointerId);
};
on(canvas, 'pointerup', endDrag);
on(canvas, 'pointercancel', endDrag);

// ── Keyboard ──────────────────────────────────────────────────────────
// Keys describe a RATE, not a position, so we track what is held down and
// integrate in the loop where dt is available. Otherwise the turn speed
// would depend on framerate and on the browser's key-repeat interval — two
// things you do not control.
const held = new Set();
const LOOK_KEYS = {
    KeyW: 'up', ArrowUp: 'up',
    KeyS: 'down', ArrowDown: 'down',
    KeyA: 'left', ArrowLeft: 'left',
    KeyD: 'right', ArrowRight: 'right',
};

// e.code is PHYSICAL key position, not the character. That is why WASD
// works on Danish, German and French layouts without special-casing.
on(window, 'keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const dir = LOOK_KEYS[e.code];
    if (dir) { held.add(dir); e.preventDefault(); return; }  // stop arrow-key scroll
    if (e.code === 'KeyB') turn180();
    if (e.code === 'KeyR') { targetYaw = 0; targetPitch = 0; }
});
on(window, 'keyup', e => {
    const dir = LOOK_KEYS[e.code];
    if (dir) held.delete(dir);
});
// Switch tabs mid-press and keyup never arrives. Without this the camera
// keeps turning when you come back.
on(window, 'blur', () => held.clear());

function turn180() {
    // Pick the sign that lands closest to zero, so two presses return to the
    // starting point instead of accumulating in one direction.
    targetYaw += Math.abs(targetYaw + Math.PI) <= Math.abs(targetYaw - Math.PI)
        ? Math.PI : -Math.PI;
    targetPitch = 0;
}

/** Called every frame, including while the fall is paused. */
function updateLook(dt) {
    const rate = KEY_SPEED * dt;
    if (held.has('left'))  targetYaw   -= rate;
    if (held.has('right')) targetYaw   += rate;
    if (held.has('up'))    targetPitch += rate;
    if (held.has('down'))  targetPitch -= rate;
    targetPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, targetPitch));

    // Exponential smoothing, done properly. The classic
    // "look += (target − look) * 0.12" hides an assumption that dt is
    // constant — at 144 Hz it converges twice as fast as at 72.
    // exp(−rate·dt) is the analytic solution and behaves the same everywhere.
    const k = 1 - Math.exp(-SMOOTH_RATE * dt);
    const dy = (targetYaw - lookYaw) * k;
    const dp = (targetPitch - lookPitch) * k;
    lookYaw += dy;
    lookPitch += dp;

    // Anything that changes the image has to say so, or the idle-skip below
    // will hold a stale frame on screen.
    if (Math.abs(dy) > 1e-6 || Math.abs(dp) > 1e-6) needsRender = true;
}

// =====================================================================
//  Readouts
// =====================================================================

function fmtLength(m) {
    const km = m / 1000;
    if (km < 1e6) return km.toFixed(0) + ' km';
    const au = km / 1.496e8;
    if (au < 1) return (km / 1e6).toFixed(1) + ' mio. km';
    return au.toFixed(2) + ' AU';
}

function fmtDuration(s) {
    if (s < 90) return s.toFixed(1) + ' s';
    if (s < 5400) return (s / 60).toFixed(1) + ' min';
    if (s < 172800) return (s / 3600).toFixed(1) + ' h';
    return (s / 86400).toFixed(1) + ' d';
}

/**
 * Tidal acceleration across 2 metres, in g.
 *
 * a ≈ 2GM·Δr/r³, which scales as 1/M² at the horizon — the whole reason a
 * supermassive hole is so gentle. For Sgr A* it is around 10⁻⁴ g at the
 * crossing. You feel literally nothing. It only climbs in the last seconds.
 */
function tidalG(rToy) {
    const dr = 2 / TOY_METERS;                            // 2 m in toy units
    const aGeom = 2 * BH_MASS * dr / Math.pow(rToy, 3);   // 1/toy-length
    const aSI = aGeom / TOY_METERS * C * C;
    return aSI / 9.81;
}

const el = id => document.getElementById(id);

const dom = {
    dist:    el('distReadout'),
    proper:  el('properReadout'),
    speed:   el('speedReadout'),
    ham:     el('hamReadout'),
    mode:    el('modeLabel'),
    panel:   el('mathPanel'),
    r:       el('rReadout'),
    alt:     el('altReadout'),
    coord:   el('coordReadout'),
    tidal:   el('tidalReadout'),
    cone:    el('coneReadout'),
    inner:   el('innerReadout'),
    fps:     el('fpsReadout'),
    restart: el('restartBtn'),
    pause:   el('pauseBtn'),
    eco:     el('ecoBtn'),
    turn:    el('turnBtn'),
    plate:   el('endPlate'),
    notice:  el('notice'),
};

on(dom.turn, 'click', turn180);

/**
 * Writes text only when it actually changed.
 *
 * Assigning textContent invalidates layout even when the string is
 * identical, and there are ten of these. At 60 Hz that is 600 forced style
 * recalculations a second running alongside a fullscreen raytracer — small
 * per call, but it lands on the main thread in bursts and reads as jitter.
 */
function setText(node, str) {
    if (node && node.__last !== str) { node.__last = str; node.textContent = str; }
}

/**
 * H at the bottom of the panel — the only readout on the page that shows an
 * ERROR.
 *
 * The number should read −1/2 forever. It does, to six decimals, all the
 * way through the horizon. Then it starts to drift. Measured:
 *
 *     r = 1.933 M   |H + ½| passes 1e-7
 *     r = 0.764 M   ..................  1e-6      ← amber lights here
 *     r = 0.600 M   ..................  1e-5
 *     r = 0.550 M   H = −0.4999865, and we stop
 *
 * And here is the number that matters: halve the step and the drift does
 * not shrink. Over four refinements the maximum lands at 1.42, 1.60, 1.61,
 * 1.62 · 10⁻⁵ — it converges to a FLOOR rather than to zero. Numerical
 * error does the opposite; it halves when you halve the step. That is what
 * shows this is the geometry and not the code.
 *
 * Which is why it is on screen. The visitor should see the last digits
 * start to move, just before everything goes white.
 */
function updateReadouts(s, phase, coneDeg, speedFrac) {
    setText(dom.dist,   (s.r / RS).toFixed(3) + '× Rs');
    setText(dom.proper, fmtDuration(s.tau * TOY_SECONDS));
    setText(dom.speed,  (speedFrac * 100).toFixed(1) + '% c');
    setText(dom.mode,   phaseLabel(phase, coneDeg));

    // ── Here, and only here, does it say the horizon was crossed ──
    // The radius readout changes colour as it passes 1.000× Rs. That is
    // all. No text, no transition in the image, no camera move. The
    // instrument knows; the view does not.
    dom.dist.classList.toggle('crossed', s.r < traj.rH);
    dom.mode.style.opacity = phase === 'end' ? '0' : '1';

    const drift = Math.abs(s.H + 0.5);
    setText(dom.ham, s.H.toFixed(7));
    dom.ham.classList.toggle('drifting', drift > 1e-6);

    // The panel is hidden most of the time.
    if (dom.panel.classList.contains('hidden')) return;

    setText(dom.r,   s.r.toFixed(3));
    setText(dom.alt, fmtLength(s.r * TOY_METERS));
    // Boyer-Lindquist, not Kerr-Schild. See the note in buildTrajectory().
    // It grows towards infinity on its own on the way in, and ceases to
    // exist inside — there is no distant observer left to refer to.
    setText(dom.coord, s.r > traj.rH ? fmtDuration(s.tBL * TOY_SECONDS) : 'diverged');

    const tg = tidalG(Math.max(s.r, 0.4));
    setText(dom.tidal, tg < 0.01 ? tg.toExponential(1) : tg.toFixed(2));

    const cone = darkConeDeg(s.pos);
    setText(dom.cone, cone < 0.05 ? '0 — whole sky' : cone.toFixed(1));

    // Distance to the inner horizon, in units of itself. Never goes below
    // 1.000. That is the whole point.
    setText(dom.inner, (s.r / R_INNER).toFixed(3));

    setText(dom.fps, fpsShown.toFixed(0) + ' fps · ' + Math.round(resScale * 100) + '%');
}

// =====================================================================
//  Controls
// =====================================================================

let elapsed = 0;
let paused  = false;
let lastTet = null;
let needsRender = true;
const _outAxis = new THREE.Vector3(1, 0, 0);

wireMathPanel();

/**
 * Back to the top of the fall.
 *
 * The heading reset is the part that was missing. elapsed went to zero but
 * lookYaw did not, so the next visitor inherited wherever the last one left
 * the camera — and since the interesting half of the ending is behind you,
 * "Fall again" quite often started facing backwards out of a hole that was
 * still 60 Rs away. Both the target and the smoothed value are set, so it
 * snaps instead of swinging through 180 degrees while the fall is already
 * under way.
 *
 * frameIsDark has to go too. It is only re-evaluated three times a second
 * and only below v = 0.45, so a stale true would leave "Look back" lit for
 * the first eighteen seconds of a fall where there is nothing behind you.
 */
function restartFall() {
    elapsed = 0;
    paused = false;
    dom.pause.innerHTML = '<span>⏸</span> Pause';
    dom.pause.classList.remove('active');

    lookYaw = targetYaw = 0;
    lookPitch = targetPitch = 0;
    held.clear();

    frameIsDark = false;
    darkProbeAcc = DARK_PROBE_INTERVAL;
    dom.turn.classList.remove('active');

    idleSince = performance.now();
    resetAdaptive();          // give the GPU its resolution back for a new run
    needsRender = true;
}

on(dom.restart, 'click', restartFall);

on(dom.pause, 'click', () => {
    paused = !paused;
    dom.pause.innerHTML = paused ? '<span>▶</span> Resume' : '<span>⏸</span> Pause';
    dom.pause.classList.toggle('active', paused);
    needsRender = true;
});

// =====================================================================
//  Quality, frame pacing and thermal behaviour
// =====================================================================
//
// ── Why there is a frame cap at all ────────────────────────────────
// This is a fullscreen raytracer that integrates up to MAX_STEPS RK4 steps
// per pixel — 900 on High. Left uncapped it will render as fast as the display allows, so on
// a 165 or 240 Hz monitor a fast GPU does three to four times the work
// nobody can see, at full power draw, for the entire duration. That is how
// you get a high-end card sitting at 68 °C rendering a black hole.
//
// The exhibit is an animation with no input latency requirements beyond
// looking around, so 60 fps is indistinguishable from 240 here and costs a
// quarter of the energy. The cap is the single largest thermal win
// available and it costs nothing visually.
//
// ── Why the resolution ratchets down and not up ────────────────────
// The obvious controller — scale down when slow, back up when fast —
// oscillates as soon as there is a frame cap, because a capped frame time
// is indistinguishable from a comfortable one. It would then resize the
// framebuffer every second or two, and each resize reallocates render
// targets: a hitch, caused by the thing meant to prevent hitches.
//
// So it ratchets: down freely, up only after a sustained comfortable spell,
// at most twice per run, and never faster than once every 6 seconds. It
// resets on "Fall again", which is also the only moment where a resolution
// change is guaranteed to be invisible.
// QUALITY and qIndex are declared near the top of the file — see the note
// there about the compile-time step count.
//
// Discrete ladder. Continuous scaling sounds nicer but every distinct value
// is another framebuffer reallocation, and five rungs is plenty of range.
const RES_LADDER = [1.00, 0.85, 0.72, 0.60, 0.50];
let resStep = 0;
let resScale = 1.0;
let recoveries = 0;
let sinceResChange = 0;
let comfortableFor = 0;
let frameAvg = 1 / 60;
let fpsShown = 60;

const _bufSize = new THREE.Vector2();

function applyResolution() {
    resScale = RES_LADDER[resStep];
    renderer.setPixelRatio(QUALITY[qIndex].base() * resScale);
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);

    // The drawing buffer, not the CSS box. Only the aspect ratio mattered
    // when this uniform was used for ndc alone, and the two agree on that.
    // The shader now also derives an angular pixel size from it for texture
    // footprints, and there the difference is the pixel ratio — up to 1.25
    // on High and 0.45 on Ultra, i.e. nearly 3× out either way.
    renderer.getDrawingBufferSize(_bufSize);
    material.uniforms.uResolution.value.copy(_bufSize);
    needsRender = true;
}

function resetAdaptive() {
    resStep = 0; recoveries = 0; sinceResChange = 0; comfortableFor = 0;
    frameAvg = 1 / QUALITY[qIndex].fps;
    applyResolution();
}

function applyQuality() {
    const q = QUALITY[qIndex];
    material.uniforms.uMaxSteps.value = q.steps;

    // The loop bound is a #define, so lowering it is a recompile. Worth it
    // on Ultra — the driver no longer has to reason about a 900-iteration
    // loop that will always exit at 280 — and it costs nothing here,
    // because changing preset already reallocates the framebuffer. Guarded
    // so that pressing the button without changing the value is free.
    if (material.defines.MAX_STEPS !== q.steps) {
        material.defines.MAX_STEPS = q.steps;
        material.needsUpdate = true;
    }
    dom.eco.innerHTML = `<span>${q.label.charAt(0)}</span> ${q.label.slice(2)}`;
    dom.eco.classList.toggle('active', qIndex > 0);
    resetAdaptive();
}

on(dom.eco, 'click', () => {
    qIndex = (qIndex + 1) % QUALITY.length;   // % makes it wrap
    applyQuality();
});

/**
 * @param renderDt  seconds between the last two RENDERED frames
 * @param budget    the frame cap interval we are aiming for
 */
function adaptResolution(renderDt, budget) {
    // Smoothed, so one long frame (tab switch, shader compile, texture
    // upload) cannot drag the resolution down on its own.
    frameAvg += (renderDt - frameAvg) * 0.10;
    sinceResChange += renderDt;
    fpsShown += (1 / Math.max(renderDt, 1e-4) - fpsShown) * 0.10;

    if (sinceResChange < 1.0) return;

    // 1.25 rather than 1.0: rAF quantises to display refresh, so a frame
    // that just misses the cap lands a whole refresh interval late through
    // no fault of ours.
    if (frameAvg > budget * 1.25 && resStep < RES_LADDER.length - 1) {
        resStep++; sinceResChange = 0; comfortableFor = 0;
        applyResolution();
        return;
    }

    // Recovery. Deliberately hard to trigger: we are capped, so "fast
    // enough" is the normal state and cannot be read as headroom on its own.
    // Requiring a long uninterrupted comfortable spell plus a hard cap on
    // the number of attempts is what keeps this from becoming a cycle.
    if (frameAvg < budget * 1.05) comfortableFor += renderDt; else comfortableFor = 0;
    if (comfortableFor > 6.0 && resStep > 0 && recoveries < 2) {
        resStep--; recoveries++; sinceResChange = 0; comfortableFor = 0;
        applyResolution();
    }
}

applyQuality();

window.diveMat = material;   // so the console can reach the uniforms

// ── Debug ─────────────────────────────────────────────────────────────
// Switched on from the console: diveMat.uniforms.uDebug.value = 1
// Not a keyboard shortcut — the arrow keys drive the camera, and an exhibit
// that reacts to stray keystrokes in front of an audience is a problem.
//
// Colours: dark red = no source (the cone), dark blue = infinitely
// redshifted (the shadow), dark green = reached uRayStop, amber = ran out
// of steps. Real sky is bright: R = image order, G = spectral band,
// B = prefiltering.

// Stop burning frames when nobody is looking. requestAnimationFrame already
// halts on a hidden tab in most browsers, but not when the canvas is merely
// scrolled out of view, and it does not stop the clock from accumulating a
// huge dt on return.
let visible = true;
on(document, 'visibilitychange', () => {
    visible = !document.hidden;
    if (visible) { clock.getDelta(); needsRender = true; }
});

// Same problem, different cause: a full page with the exhibit above the
// fold and prose below it never hides the tab, so visibilitychange never
// fires — the canvas just keeps raytracing at full resolution under
// somebody who has scrolled on to read. That is heat and fan noise on a
// laptop and, on a weak/integrated GPU, exactly the kind of sustained load
// that takes the tab down. IntersectionObserver is the only reliable
// signal for "off-screen but tab still visible".
let onScreen = true;
const intersectionObserver = new IntersectionObserver(
    ([entry]) => {
        onScreen = entry.isIntersecting;
        // Mirrors the visibilitychange handler above: drop the delta that
        // built up while off-screen so returning doesn't hand the timeline
        // one huge dt, and force one repaint so the frame on screen again
        // isn't a stale one from before it scrolled away.
        if (onScreen) { clock.getDelta(); needsRender = true; }
    },
    { threshold: 0 }   // fire as soon as even 1px is on/off screen
);
intersectionObserver.observe(canvas);

// =====================================================================
//  Loop
// =====================================================================

const clock = new THREE.Clock();

let frameAcc = 0;
let lastRenderAt = performance.now();
let plateShown = false;

// Loop state. rafId exists so teardown can stop the loop; running exists so
// the loop can stop ITSELF, which is the only way to guarantee no frame is
// half-executed when the context goes away underneath it.
let rafId = 0;
let running = true;
let contextLost = false;

// ── The kiosk loop ────────────────────────────────────────────────────
// Off on the public web, deliberately. The end plate is six paragraphs and
// restarting under somebody at paragraph four is worse than leaving it up
// forever. In a gallery the opposite is true: an exhibit that ends and
// stays ended spends the afternoon showing a wall of text to a room. So it
// is a URL flag — /exhibits/dive/?kiosk — and the timeout is measured from
// the last time anyone touched anything, not from when the plate appeared.
const KIOSK = new URLSearchParams(location.search).has('kiosk');
const KIOSK_IDLE_RESTART = 75;   // seconds of no input, on the plate
let idleSince = performance.now();

function animate() {
    if (!running) { rafId = 0; return; }
    rafId = requestAnimationFrame(animate);
    if (!visible || !onScreen) return;

    // The context is gone and Three is refusing to draw. Keep draining the
    // clock: it is a wall-clock clock and it does not know that, so a
    // fifteen-second driver reset would otherwise be handed to the timeline
    // in one delta the moment the pixels come back.
    if (contextLost) { clock.getDelta(); return; }

    const raw = clock.getDelta();
    const dt  = Math.min(raw, 1 / 15);   // clamp, so a stall does not teleport us

    updateLook(dt);

    // Simulation time advances on EVERY tick, not only on rendered ones.
    // When frames were skipped for the cap, the skipped dt used to be thrown
    // away, so the fall ran slow and unevenly in the capped quality modes.
    //
    // Clamped at T_TOTAL rather than left running: past the end the image is
    // a static black plate, and continuing to redraw it is pure heat.
    if (!paused && elapsed < T_TOTAL) {
        elapsed = Math.min(elapsed + dt, T_TOTAL);
        needsRender = true;
    }

    // ── Frame cap ──
    const budget = 1 / QUALITY[qIndex].fps;
    frameAcc += dt;
    if (frameAcc < budget * 0.92) return;   // 0.92: never skip a frame we could have made
    frameAcc = 0;

    // Nothing moved and nothing changed — hold the last frame. Matters for a
    // kiosk left on the end plate, or paused.
    if (!needsRender) return;
    needsRender = false;

    const now = performance.now();
    // Interval between RENDERED frames, which is what both the resolution
    // controller and the dark probe want — not the tick dt, which does not
    // count the frames skipped by the cap.
    const renderDt = Math.min((now - lastRenderAt) / 1000, 0.5);
    lastRenderAt = now;
    adaptResolution(renderDt, budget);

    const tl = timeline(elapsed);
    const s  = sampleAt(tl.v);

    // The cone now drives only the mode label and the ring contour's fade-in.
    // It used to steer the camera; that rotation is gone.
    const coneNow = darkConeDeg(s.pos);
    const draw    = smoothstep(CONE_DRAW_LO, CONE_DRAW_HI, coneNow);

    orientCamera(s.pos, s.vel);

    const u = material.uniforms;

    // ── The tetrad ──
    // Seeded with the camera's own axes, so e1, e2, e3 ARE right/up/forward.
    // It is valid the whole way now. The old freeze logic existed only
    // because the ring passage had no four-velocity to build an observer
    // from; without the passage there is no frame where the tetrad is not real.
    try {
        lastTet = buildTetrad(s.frame.pos, s.frame.mom, s.frame.pt,
            BH_MASS, SPIN * BH_MASS,
            [[_baseR.x,_baseR.y,_baseR.z], [_baseU.x,_baseU.y,_baseU.z], [_baseF.x,_baseF.y,_baseF.z]]);
        outAxisFrom(s.frame.pos, lastTet, _outAxis);
    } catch (err) {
        // Degenerate seed. The previous tetrad is one frame old, which is
        // infinitely better than a black screen.
        if (!lastTet) throw err;
    }

    // The rotation is applied HERE, not in the seeds. That is the whole fix.
    const view = rotateTetrad(lastTet, _lookM);

    // Packed as (space, time); the tetrad stores [t, x, y, z].
    const pack = (e, v) => v.set(e[1], e[2], e[3], e[0]);
    pack(view[0], u.uE0.value);
    pack(view[1], u.uE1.value);
    pack(view[2], u.uE2.value);
    pack(view[3], u.uE3.value);

    u.uCamPos.value.copy(s.pos);
    u.uCamFwd.value.copy(_fwd);
    u.uCamRight.value.copy(_right);
    u.uCamUp.value.copy(_up);
    u.uOutDir.value.copy(_outAxis);
    u.uTime.value   = elapsed;
    u.uDraw.value   = draw;
    u.uBlue.value   = tl.blue;
    u.uWhite.value  = tl.white;
    u.uDim.value    = tl.dim;

    // ── Where rays die ──
    // Outside: just inside the horizon, so asymptotic rays are not integrated
    // forever. Inside: all the way to 0.5 M, where backward tracing still
    // means something in Kerr-Schild.
    //
    // The handover MUST be gradual. When it was a hard switch, the limit sat
    // at rH·1.005 while the camera itself had already dropped below it — so
    // every ray started inside its own death zone and died at step zero. That
    // gave a completely black image in the narrow band r ∈ (0.7634, 0.7672)·Rs,
    // exactly where the light vanished and returned a moment later.
    //
    // The band used to be [1.00, 1.10]·rH, i.e. finishing PRECISELY at the
    // horizon. It is [0.55, 1.45]·rH now, symmetric about it, so the handover
    // is well underway before the crossing and only completes some way inside.
    // Same endpoints, no event in the middle.
    const stopHi = traj.rH * 1.005;
    const stopLo = 0.5 * BH_MASS;
    const wStop  = clamp01((traj.rH * 1.45 - s.r) / (traj.rH * 0.90));
    u.uRayStop.value = stopHi + (stopLo - stopHi) * (wStop * wStop * (3 - 2 * wStop));

    // Depth: 0 at the horizon, 1 where integration stops.
    u.uDepth.value = clamp01((traj.vHorizon === 1) ? 0
        : (tl.v - traj.vHorizon) / (1 - traj.vHorizon));

    // Light up "Look back" when there is genuinely nothing to see ahead.
    darkProbeAcc += renderDt;
    if (darkProbeAcc >= DARK_PROBE_INTERVAL) {
        darkProbeAcc = 0;
        frameIsDark = tl.v > DARK_PROBE_MIN_V && probeFrameDark(
            view, s.pos, u.uFov.value,
            canvas.clientWidth / Math.max(canvas.clientHeight, 1),
            u.uRayStop.value,
            10000 + (4000 - 10000) * smoothstep(0.20, 0.80, u.uDepth.value));
    }
    dom.turn.classList.toggle('active', frameIsDark && tl.plate < 0.5);

    updateReadouts(s, tl.phase, coneNow, Math.min(s.vel.length(), 0.999));

    // The text plate. Class toggle rather than inline opacity, so CSS owns
    // the transition and prefers-reduced-motion can switch it off.
    const wantPlate = tl.plate > 0.5;
    if (wantPlate !== plateShown) {
        plateShown = wantPlate;
        dom.plate.classList.toggle('visible', wantPlate);
    }

    // "Fall again" appears with the text, not once the whole timeline has
    // run out.
    dom.restart.classList.toggle('hidden', tl.plate <= 0.5);

    if (KIOSK && wantPlate && (now - idleSince) > KIOSK_IDLE_RESTART * 1000) restartFall();

    renderer.render(scene, orthoCamera);
}

const resizeHandle = observeCanvasResize(canvas, (w, h) => {
    renderer.setSize(w, h);
    renderer.getDrawingBufferSize(_bufSize);
    material.uniforms.uResolution.value.copy(_bufSize);
    needsRender = true;
});

// =====================================================================
//  Lifecycle
// =====================================================================
//
// ── On the leak that is not one ────────────────────────────────────
// The standing note on this file is that it leaks the GPU: no dispose()
// on the geometry, the material or the two textures, no
// removeEventListener anywhere, and a debug reference parked on window.
// Every one of those is a true description of the code, and none of them
// leaked anything, because this exhibit is a DOCUMENT and not a component.
// index.html loads main.js once, with <script type="module">. There is no
// unmount, no route change, no second instance. The only way out of this
// page is a navigation, and a navigation takes the context, the canvas,
// the module and every listener attached to it. A leak needs something to
// accumulate against; the page itself is the lifetime, so there is
// nothing for a second copy to sit beside.
//
// Two things are nevertheless worth having, and neither is the leak.
//
// ── 1. Context loss ────────────────────────────────────────────────
// This is the real one. A driver reset, a laptop switching GPUs, a phone
// under thermal pressure, or simply too many live WebGL contexts, and the
// browser takes the context away from a page that is otherwise perfectly
// alive. Without a handler the canvas goes black and stays black — no
// error, no recovery, and on a kiosk nobody notices until someone walks
// past at closing time.
//
// Three.js does most of the work: WebGLRenderer listens for both events
// itself, refuses to draw while lost, and re-initialises its GL state on
// restore, re-uploading textures and geometry lazily. What it cannot know
// is anything about OUR clock or OUR pixel ratio, so that is what the
// handlers below deal with. preventDefault is the load-bearing line: skip
// it and the browser never fires the restore event at all.
//
// ── 2. Context budget ──────────────────────────────────────────────
// Chrome allows something like sixteen live WebGL contexts per process and
// silently kills the oldest when a seventeenth asks. Back/forward cached
// pages keep theirs. A visitor walking dive -> kerr -> merger -> back ->
// forward through a series of exhibits is exactly the traffic pattern that
// spends them, and the symptom is a context-lost event on a page the
// visitor is looking at. Releasing on a real unload — but NOT on a
// bfcache suspend, where the page is expected to come back intact — is
// what keeps that budget honest. That is the only sense in which the
// dispose() calls below are about memory at all.

let noticeTimer = 0;

function showNotice(text, kind) {
    if (!dom.notice) return;
    clearTimeout(noticeTimer);
    dom.notice.textContent = text;
    dom.notice.classList.toggle('warn', kind === 'warn');
    dom.notice.classList.add('visible');
}

function hideNotice(afterMs = 0) {
    if (!dom.notice) return;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => dom.notice.classList.remove('visible'), afterMs);
}

on(canvas, 'webglcontextlost', e => {
    // Without this the event is advisory and the context is gone for good.
    e.preventDefault();
    contextLost = true;
    showNotice('Graphics context lost — waiting for the driver to restore it.', 'warn');
});

on(canvas, 'webglcontextrestored', () => {
    contextLost = false;
    hideNotice(2500);
    showNotice('Graphics context restored.');
    clock.getDelta();          // drop everything that accumulated while dead
    material.needsUpdate = true;
    applyResolution();         // pixel ratio and uResolution, from scratch
    needsRender = true;
});

// Idle tracking for the kiosk loop. On window rather than the canvas: a
// visitor reading the end plate and pressing Math has interacted, even
// though they never touched the picture.
const markActive = () => { idleSince = performance.now(); };
on(window, 'pointerdown', markActive, { passive: true });
on(window, 'keydown',     markActive, { passive: true });
on(window, 'wheel',       markActive, { passive: true });

/**
 * Full teardown. Exported so a future shell can call it; also wired to a
 * real page unload below.
 *
 * The order is deliberate. Stop the loop first, or a frame in flight can
 * touch a material that has just been disposed and the console fills with
 * GL warnings that look like the actual bug. Listeners next, so nothing
 * can schedule new work. Only then the GPU objects, and the renderer last,
 * because disposing it invalidates everything that was uploaded through it.
 */
export function disposeDive() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;

    for (const [target, type, fn, opts] of _listeners) target.removeEventListener(type, fn, opts);
    _listeners.length = 0;

    // observeCanvasResize is shared code and may hand back a ResizeObserver,
    // an unsubscribe function, or nothing at all. Handle all three rather
    // than depending on which it is today.
    if (typeof resizeHandle === 'function') resizeHandle();
    else if (resizeHandle && typeof resizeHandle.disconnect === 'function') resizeHandle.disconnect();

    intersectionObserver.disconnect();

    // traverse rather than a hand-written list: the scene has one mesh
    // today and this stays correct if it ever has two.
    scene.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose();
        const mat = obj.material;
        if (mat) (Array.isArray(mat) ? mat : [mat]).forEach(x => x.dispose());
    });

    // uStarfield is not necessarily `starfield` — it is the fallback if the
    // real map never arrived. Dispose both; a double dispose is a no-op.
    for (const tex of [starfield, noiseTex, material.uniforms.uStarfield.value]) {
        if (tex && typeof tex.dispose === 'function') tex.dispose();
    }

    renderer.dispose();
    // Hands the context back now instead of whenever the GC gets round to
    // the canvas. This is the line that matters for the context budget.
    renderer.forceContextLoss();

    window.diveMat = null;
}

on(window, 'pagehide', e => {
    // persisted means bfcache: the page is frozen, not destroyed, and is
    // expected to come back with its context intact. Disposing here would
    // turn a working back button into a black screen.
    if (e.persisted) { running = false; return; }
    disposeDive();
});

on(window, 'pageshow', e => {
    if (!e.persisted) return;
    running = true;
    clock.getDelta();
    needsRender = true;
    if (!rafId) rafId = requestAnimationFrame(animate);
});

animate();