// =====================================================================
//  exhibits/merger_lens/main.js
//
//  The same binary as exhibit 001, drawn by integrating photons instead of
//  approximating them. OrbitalPhysics.js is shared verbatim between the two
//  so the physics cannot drift apart; everything below is about geometry
//  and photometry, which is where this exhibit differs.
//
//  Three things this version does that the previous one did not:
//
//    - Doppler beaming. The star orbits at 0.24 c at the start of the run
//      and 0.32 c by the plunge. Observed intensity goes as the fourth
//      power of the Doppler factor, which is a contrast of better than ten
//      to one between the approaching and receding limb. It was missing,
//      and it is the largest single visual effect in the exhibit.
//    - Tidal deformation. The star is an ellipsoid stretched along the line
//      to the hole, by the ellipticity derived in OrbitalPhysics, and the
//      ray marcher intersects the ellipsoid rather than a sphere.
//    - The plunge. Below the innermost stable circular orbit the star stops
//      orbiting and falls, on a geodesic, for one and three quarter final
//      revolutions — which is when the lensing gets interesting, and which
//      the previous version skipped entirely by declaring merger at 6M.
//
//  There is no Three.js scene any more. Both bodies were meshes with
//  colorWrite off, rendered into a depth-buffered target every frame that
//  the fragment shader never sampled. The shader is the whole image.
// =====================================================================

import * as THREE from 'three';
import { RayMarchPass } from './RayMarchPass.js';
import { BinaryOrbit, timeScaleForInitialRate } from './OrbitalPhysics.js';
import { wireMathPanel, observeCanvasResize, fitPerspectiveFov } from '../../shared/exhibitCommon.js';

// ── The binary ───────────────────────────────────────────────────────
const MASS_BH = 5.0;
const MASS_NS = 1.4;
const R_S_BH = 2 * MASS_BH;                 // horizon radius, 10 toy units
const NS_RADIUS = 2.9 * (2 * MASS_NS);      // 8.12 toy ≈ 12 km
const CONTACT_RADIUS = R_S_BH + NS_RADIUS;  // 18.12 — surfaces touch
const START_SEPARATION = 70;

// 1 toy length = GM☉/c² = 1474 m, so 1 toy time is its light-crossing time.
//
// NOTE for exhibits/merger_gw: that file has (R_s * 1474)/3e8, which is the
// crossing time of TEN toy units, not one. Its frequency readouts are a
// factor of ten low and its time-to-merger a factor of ten long. The
// constant below is the correct one.
const TOY_KM = 1.474;
const TOY_TIME_TO_SECONDS = 1474 / 3e8;     // ≈ 4.913e-6 s

// ── Pacing (see OrbitalPhysics.effectiveTimeScale) ───────────────────
const INITIAL_REV_PER_SEC = 0.8;
const PACING_EXPONENT = 0.75;
const PLUNGE_PACING = 2.0;
const RINGDOWN_PACING = 3.0;

// ── Artistic gains, all declared here ────────────────────────────────
const TIDAL_GAIN = 1.25;
const TIDAL_MAX = 0.75;
const NS_SPIN_RATE = 0.6;      // rad/s of wall clock, for the surface texture
const ABSORB_SECONDS = 0.35;
const SHAKE_GAIN = 2.2;        // camera displacement at merger, toy units

// A per-pixel geodesic marcher at devicePixelRatio 2 is four times the work
// of ratio 1 for no visible gain at this scale. Capped, and disclosed.
const MAX_PIXEL_RATIO = 1.5;
const TARGET_FPS = 60;

// ── Renderer ─────────────────────────────────────────────────────────
const canvas = document.getElementById('solarCanvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

const BASE_FOV = 60;
const camera = new THREE.PerspectiveCamera(BASE_FOV, canvas.clientWidth / canvas.clientHeight, 0.1, 2000);
const CAMERA_HOME = new THREE.Vector3(0, 30, 160);
camera.position.copy(CAMERA_HOME);
camera.lookAt(0, 0, 0);

const clock = new THREE.Clock();
let paused = false;
let visible = true;
let onScreen = true;
let frameAccumulator = 0;

// ── Scratch, allocated once ──────────────────────────────────────────
const bhPos = new THREE.Vector3();
const nsPos = new THREE.Vector3();
const nsBeta = new THREE.Vector3();
const axisToBh = new THREE.Vector3();
const axisUp = new THREE.Vector3(0, 1, 0);
const axisThird = new THREE.Vector3();
const nsFrame = new THREE.Matrix3();
const nsSemi = new THREE.Vector3();

// ── State ────────────────────────────────────────────────────────────
let rayMarchPass, orbit, mathPanel, restartBtn;
let nsSpin = 0;
let absorbTime = 0;
let readouts = {};

// =====================================================================
//  Setup
// =====================================================================

async function init() {
    const loader = new THREE.TextureLoader();

    const starfieldTexture = await loader.loadAsync('/assets/textures/starfield_4k.jpg');
    starfieldTexture.minFilter = THREE.LinearFilter;
    starfieldTexture.magFilter = THREE.LinearFilter;
    starfieldTexture.wrapS = THREE.RepeatWrapping;

    const neutronStarTexture = await loader.loadAsync('/assets/textures/neutron_star.jpg');
    neutronStarTexture.minFilter = THREE.LinearFilter;
    neutronStarTexture.magFilter = THREE.LinearFilter;
    neutronStarTexture.wrapS = THREE.RepeatWrapping;

    rayMarchPass = new RayMarchPass(canvas, starfieldTexture, neutronStarTexture);

    orbit = new BinaryOrbit({
        massStar: MASS_NS,
        massBH: MASS_BH,
        separation: START_SEPARATION,
        pacingExponent: PACING_EXPONENT,
        plungePacing: PLUNGE_PACING,
        ringdownPacing: RINGDOWN_PACING,
        contactRadius: CONTACT_RADIUS,
    });
    // Start a quarter turn in, so the star crosses behind the hole early.
    orbit.phase = Math.PI * 0.5;
    orbit.timeScale = timeScaleForInitialRate(orbit, INITIAL_REV_PER_SEC);

    cacheReadouts();
    mathPanel = wireMathPanel();
    wireControls();
    wireVisibility();

    observeCanvasResize(canvas, (w, h) => {
        camera.fov = fitPerspectiveFov(w / h, BASE_FOV);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        camera.lookAt(0, 0, 0);
        renderer.setSize(w, h, false);
        rayMarchPass.setSize(
            w * Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO),
            h * Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO)
        );
    });

    animate();
}

function cacheReadouts() {
    const id = (x) => document.getElementById(x);
    readouts = {
        status: id('statusReadout'),
        sep: id('sepReadout'),
        freq: id('freqReadout'),
        slowmo: id('slowmoReadout'),
        tidal: id('tidalReadout'),
        beta: id('betaReadout'),
        substituted: id('mathSubstituted'),
        dadt: id('mathDadt'),
        tmerge: id('mathTmerge'),
        fgw: id('mathFgw'),
    };
}

function wireControls() {
    restartBtn = document.getElementById('restartBtn');
    restartBtn.addEventListener('click', resetOrbit);

    const pauseBtn = document.getElementById('pauseBtn');
    pauseBtn.addEventListener('click', () => {
        paused = !paused;
        if (!paused) clock.getDelta();
        const icon = pauseBtn.querySelector('.btn-icon');
        const label = pauseBtn.querySelector('.btn-label');
        if (icon) icon.textContent = paused ? '▶' : '⏸';
        if (label) label.textContent = paused ? 'Play' : 'Pause';
    });
}

/**
 * Stop marching when nobody is looking.
 *
 * visibilitychange only fires when the tab hides. It does nothing when the
 * canvas scrolls off a long page, which is what happens the moment a reader
 * reaches the text below — and a per-pixel geodesic marcher left running
 * behind the reader is exactly the load that crashed a browser during Dive
 * development. The IntersectionObserver covers that case.
 */
function wireVisibility() {
    document.addEventListener('visibilitychange', () => {
        visible = !document.hidden;
        if (visible) clock.getDelta();
    });

    const io = new IntersectionObserver(([entry]) => {
        onScreen = entry.isIntersecting;
        if (onScreen) clock.getDelta();
    }, { threshold: 0 });
    io.observe(canvas);
}

function resetOrbit() {
    orbit.reset();
    orbit.phase = Math.PI * 0.5;
    orbit.timeScale = timeScaleForInitialRate(orbit, INITIAL_REV_PER_SEC);

    nsSpin = 0;
    absorbTime = 0;
    rayMarchPass.setNsVisible(true);

    camera.position.copy(CAMERA_HOME);
    camera.lookAt(0, 0, 0);
    clock.getDelta();
}

// =====================================================================
//  Geometry and photometry of the star
// =====================================================================

/**
 * Build the ellipsoid frame for the tidally deformed star.
 *
 * The long axis points at the black hole; the other two are the orbital
 * axis and their cross product. Both bodies stay in the y = 0 plane, so
 * world up is already perpendicular to the long axis and no orthogonalising
 * is needed. The ellipsoid conserves volume: (1 + ε) along the long axis,
 * 1/√(1 + ε) on the other two.
 *
 * @param {number} epsilon Fractional elongation, already gained and clamped.
 */
function buildEllipsoid(epsilon) {
    axisToBh.subVectors(bhPos, nsPos);

    // At the end of the absorption the star's centre reaches the hole's and
    // the separation vector goes to zero. Normalising that is a NaN, and a
    // NaN in the frame matrix turns the whole star into a black fragment.
    if (axisToBh.lengthSq() < 1e-8) axisToBh.set(1, 0, 0);
    axisToBh.normalize();

    axisThird.crossVectors(axisToBh, axisUp).normalize();

    // Columns are the local axes, so (v * frame) in GLSL gives local coords.
    nsFrame.set(
        axisToBh.x, axisUp.x, axisThird.x,
        axisToBh.y, axisUp.y, axisThird.y,
        axisToBh.z, axisUp.z, axisThird.z
    );

    const shortAxis = NS_RADIUS / Math.sqrt(1 + epsilon);
    nsSemi.set(NS_RADIUS * (1 + epsilon), shortAxis, shortAxis);
}

/**
 * The star's velocity, as a fraction of c.
 *
 * Tangential from the orbit, radial from the decay — in geometric units the
 * speed and the velocity in units of c are the same number, which is one of
 * the conveniences of G = c = 1. At the start of the run this is 0.24; by
 * contact it is past 0.3, which is why the beaming is so pronounced.
 */
function updateBeta() {
    const d1 = orbit.a * (orbit.m2 / orbit.totalMass);      // star's orbital radius
    const omega = orbit.currentAngularVelocity();
    const drdt = orbit.plunging ? orbit.plungeRadialVelocity() : orbit.orbitalDecayRate();
    const vRadial = drdt * (orbit.m2 / orbit.totalMass);

    const c = Math.cos(orbit.phase);
    const s = Math.sin(orbit.phase);

    nsBeta.set(
        -s * omega * d1 + c * vRadial,
        0,
        c * omega * d1 + s * vRadial
    );
}

/**
 * Gravitational shift of the star's light on its way to the camera:
 * √(f(r_star) / f(r_camera)), both distances measured from the hole.
 *
 * Including the camera's own position matters less than it looks — the
 * camera sits at 16 Rs where f is 0.94 — but leaving it out would mean
 * quietly claiming the observer is at infinity.
 */
function gravitationalShift() {
    const fStar = Math.max(1 - R_S_BH / orbit.a, 1e-4);
    const fCam = Math.max(1 - R_S_BH / camera.position.distanceTo(bhPos), 1e-4);
    return Math.sqrt(fStar / fCam);
}

// =====================================================================
//  Instrument panel
// =====================================================================

function phaseLabel() {
    if (orbit.merged) return orbit.ringdownComplete ? 'MERGED' : 'RINGDOWN';
    if (orbit.plunging) return 'PLUNGE';
    return 'INSPIRALING';
}

function updatePanel() {
    const text = (el, v) => { if (el) el.textContent = v; };

    text(readouts.status, phaseLabel());
    text(readouts.slowmo, '~' + Math.round(orbit.timeCompression() / 10) * 10 + '×');

    if (orbit.merged) {
        text(readouts.sep, '—');
        text(readouts.freq, orbit.ringdownComplete
            ? '—'
            : (orbit.ringdownAngularFrequency() / (2 * Math.PI * TOY_TIME_TO_SECONDS)).toFixed(0) + ' Hz');
        text(readouts.tidal, '—');
        text(readouts.beta, '—');
    } else {
        text(readouts.sep, (orbit.a * TOY_KM).toFixed(1) + ' km');
        text(readouts.freq, (orbit.gwAngularFrequency() / (2 * Math.PI * TOY_TIME_TO_SECONDS)).toFixed(0) + ' Hz');
        text(readouts.tidal, (orbit.tidalEllipticity(NS_RADIUS) * 100).toFixed(1) + ' %');
        text(readouts.beta, nsBeta.length().toFixed(3) + ' c');
    }

    if (mathPanel && !mathPanel.classList.contains('hidden')) updateMathPanel();

    restartBtn.classList.toggle('hidden', !orbit.ringdownComplete);
}

function updateMathPanel() {
    const text = (el, v) => { if (el) el.textContent = v; };

    if (orbit.merged) {
        text(readouts.substituted, 'Peters no longer applies — the orbit has ended.');
        text(readouts.dadt, '—');
        text(readouts.tmerge, '0.000');
        text(readouts.fgw, (orbit.ringdownAngularFrequency() / (2 * Math.PI * TOY_TIME_TO_SECONDS)).toFixed(0));
        return;
    }

    if (orbit.plunging) {
        text(readouts.substituted, 'Below the ISCO: plunge geodesic, E and L conserved.');
        text(readouts.dadt, orbit.plungeRadialVelocity().toFixed(6));
        text(readouts.tmerge, '0.000');
        text(readouts.fgw, (orbit.gwAngularFrequency() / (2 * Math.PI * TOY_TIME_TO_SECONDS)).toFixed(0));
        return;
    }

    const K = (64 / 5) * orbit.m1 * orbit.m2 * orbit.totalMass;
    const tRemain = Math.max(orbit.a ** 4 - orbit.mergerRadius ** 4, 0) / (4 * K);

    text(readouts.substituted,
        `-(64/5) × ${orbit.m1.toFixed(1)} × ${orbit.m2.toFixed(1)} × ${orbit.totalMass.toFixed(1)} / ${orbit.a.toFixed(2)}³`);
    text(readouts.dadt, orbit.orbitalDecayRate().toFixed(6));
    text(readouts.tmerge, (tRemain * TOY_TIME_TO_SECONDS * 1000).toFixed(3));
    text(readouts.fgw, (orbit.gwAngularFrequency() / (2 * Math.PI * TOY_TIME_TO_SECONDS)).toFixed(0));
}

// =====================================================================
//  Frame loop
// =====================================================================

function animate() {
    requestAnimationFrame(animate);
    if (paused || !visible || !onScreen) return;

    const dt = Math.min(clock.getDelta(), 1 / 20);

    // Frame cap. Per-pixel geodesic marching will happily saturate a GPU at
    // whatever rate the display allows; on a 120 Hz panel that is twice the
    // heat for no extra information.
    frameAccumulator += dt;
    if (frameAccumulator < 1 / TARGET_FPS) return;
    const frameDt = frameAccumulator;
    frameAccumulator = 0;

    orbit.step(frameDt);
    nsSpin += NS_SPIN_RATE * frameDt;

    const pos = orbit.getPositions();
    bhPos.set(pos.blackHole.x, 0, pos.blackHole.z);
    nsPos.set(pos.star.x, 0, pos.star.z);

    updateBeta();

    // ── The hole ──
    let horizonRadius = R_S_BH;

    if (orbit.merged) {
        absorbTime = Math.min(absorbTime + frameDt, ABSORB_SECONDS);
        const s = absorbTime / ABSORB_SECONDS;
        const ease = s * s * (3 - 2 * s);

        // The star slides through the horizon rather than fading where it is.
        nsPos.lerp(bhPos, ease);
        const shrink = Math.max(1 - ease, 0.0001);
        buildEllipsoid(0);
        nsSemi.multiplyScalar(shrink);
        rayMarchPass.setNsVisible(ease < 0.995);

        // The horizon grows by the mass it swallowed, less the 3.8% radiated.
        horizonRadius = R_S_BH * (1 + (orbit.horizonGrowthFactor() - 1) * ease);

        // A shove from the wave, decaying with the ringdown.
        const wobble = SHAKE_GAIN * orbit.ringdownEnvelope();
        camera.position.set(
            CAMERA_HOME.x + Math.sin(orbit.ringdownPhase) * wobble,
            CAMERA_HOME.y - Math.sin(orbit.ringdownPhase) * wobble,
            CAMERA_HOME.z
        );
        camera.lookAt(0, 0, 0);
    } else {
        const epsilon = Math.min(orbit.tidalEllipticity(NS_RADIUS) * TIDAL_GAIN, TIDAL_MAX);
        buildEllipsoid(epsilon);
        rayMarchPass.setNsVisible(true);
    }

    rayMarchPass.setBhWorld(bhPos, horizonRadius);
    rayMarchPass.setNsGeometry(nsPos, nsFrame, nsSemi);
    rayMarchPass.setNsPhotometry(nsBeta, gravitationalShift(), nsSpin);

    updatePanel();
    rayMarchPass.render(renderer, camera);
}

init();