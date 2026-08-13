// =====================================================================
//  exhibits/merger_gw/main.js
//
//  A neutron star falls into a black hole. Three acts, and the exhibit
//  now shows all three:
//
//    1. INSPIRAL — Peters (1964) quadrupole decay, from a = 70 down to
//       the innermost stable circular orbit at 6M = 38.4.
//    2. PLUNGE   — below the ISCO there is no orbit left. A Schwarzschild
//       geodesic carries the star through 607 degrees, roughly one and
//       three quarter final revolutions, while the tidal field stretches
//       it from 5% to 48% elongation.
//    3. RINGDOWN — the horizon absorbs the star, grows by 23%, and rings
//       at the l = m = 2 quasi-normal frequency of the remnant.
//
//  What this exhibit deliberately does NOT show:
//
//    - Tidal disruption. Measured: the tidal radius is 12.4 against a
//      contact radius of 18.1, so the star reaches the horizon intact.
//      For a 1.4 M☉ star of realistic radius falling into a NON-SPINNING
//      5 M☉ hole, that is the correct answer. Spin would change it.
//    - Any flash of light at merger. No disruption means no ejecta, no
//      kilonova, no electromagnetic counterpart. The merger's signature
//      is geometric: the horizon gets bigger and spacetime rings. Adding
//      a flash would be asserting an event that does not happen.
//
//  The black hole is Schwarzschild. The remnant of any merger is a Kerr
//  hole — the fit below gives a/M = 0.50 — and that spin is used for the
//  ringdown frequency but is not rendered. Stated, not hidden.
// =====================================================================

import * as THREE from 'three';
import { BlackHole } from '../../shared/BlackHole.js';
import { LensingPass } from './LensingPass.js';
import { BinaryOrbit, timeScaleForInitialRate } from './OrbitalPhysics.js';
import { wireMathPanel } from '../../shared/exhibitCommon.js';

// ── The binary ───────────────────────────────────────────────────────
const MASS_BH = 5.0;                       // M☉, geometric toy units
const MASS_NS = 1.4;
const R_S_BH = 2 * MASS_BH;                // horizon radius, 10 toy units
const R_S_NS = 2 * MASS_NS;
const NS_RADIUS = 2.9 * R_S_NS;            // 8.12 toy ≈ 12 km, realistic
const CONTACT_RADIUS = R_S_BH + NS_RADIUS; // 18.12 — surfaces touch

const START_SEPARATION = 70;

// 1 toy length = 1474 m (half a solar Schwarzschild radius), so 1 toy time
// is the light-crossing time of that distance.
const TOY_KM = 1.474;
const TOY_TIME_TO_SECONDS = (R_S_BH * 1474) / 3e8;   // ≈ 4.91e-5 s

// ── Pacing (see OrbitalPhysics.effectiveTimeScale for why) ───────────
const INITIAL_REV_PER_SEC = 0.8;   // apparent orbital rate at the start
const PACING_EXPONENT = 0.75;      // timeScale ∝ (a/a₀)^p
const PLUNGE_PACING = 2.0;         // extra slow motion below the ISCO
const RINGDOWN_PACING = 3.0;       // extra slow motion after merger
// Measured result: 9.5 s inspiral, 2.0 s plunge, 2.3 s ringdown, 13.8 s total,
// never exceeding 7.6 degrees of orbit per frame at 60 fps.

// ── Artistic gains, all of them declared here and nowhere else ───────
const TIDAL_GAIN = 1.25;      // ε is real; this scales it for legibility
const TIDAL_MAX = 0.75;       // clamp, so the ellipsoid stays a star not a noodle
const REDSHIFT_EXPONENT = 2.0;// true value is 4; softened so the star stays visible
const RIPPLE_GAIN = 3.0;      // strain × this = screen displacement
const BURST_GAIN = 26.0;      // merger pulse, relative to peak strain
const BURST_SPEED = 1.15;     // screen units per second — NOT the speed of light,
                              // the scene has no light-travel-time correction
const BURST_FALLOFF = 0.55;   // pulse amplitude decay with radius
const SHAKE_GAIN = 34.0;      // camera displacement from the passing wave
const ABSORB_SECONDS = 0.32;  // horizon crossing, wall clock

// ── Renderer ─────────────────────────────────────────────────────────
const canvas = document.getElementById('solarCanvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setSize(canvas.clientWidth, canvas.clientHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, canvas.clientWidth / canvas.clientHeight, 0.1, 2000);
const CAMERA_HOME = new THREE.Vector3(0, 20, 170);
const CAMERA_FOV = 60;
camera.position.copy(CAMERA_HOME);
camera.lookAt(0, 0, 0);

const clock = new THREE.Clock();
let paused = false;
let visible = true;
let onScreen = true;

// ── Scratch vectors, allocated once ──────────────────────────────────
const bhWorldPos = new THREE.Vector3();
const bhScreenPos = new THREE.Vector3();
const nsWorldPos = new THREE.Vector3();
const nsScreenPos = new THREE.Vector3();
const originScreen = new THREE.Vector3();

// ── Module state ─────────────────────────────────────────────────────
let lensingPass, orbit, neutronStar, tidalFrame, blackHole, mathPanel, restartBtn;
let nsBaseEmissive;
let burstRadius = -1;
let absorbTime = 0;
let readouts = {};

/**
 * Some BlackHole implementations already fold group.scale into
 * getScreenRadius(); some do not. If the photon ring ends up twice the size of
 * the disk after merger, flip this to true.
 */
const BH_SCREEN_RADIUS_TRACKS_SCALE = false;

// =====================================================================
//  Setup
// =====================================================================

async function init() {
    const loader = new THREE.TextureLoader();
    const [starfieldTexture, neutronStarTexture] = await Promise.all([
        loader.loadAsync('/assets/textures/starfield_4k.jpg'),
        loader.loadAsync('/assets/textures/neutron_star.jpg'),
    ]);

    const barycenter = new THREE.Object3D();
    scene.add(barycenter);

    lensingPass = new LensingPass(canvas, starfieldTexture);

    // The tidal frame carries the star's position and its tidal deformation.
    // The mesh inside it carries the star's own rotation, so the bulge stays
    // pointed at the hole while the surface turns through it — which is the
    // non-synchronised case, and the right one: tidal locking is far too slow
    // to establish itself during an inspiral this short.
    tidalFrame = new THREE.Object3D();
    barycenter.add(tidalFrame);

    neutronStar = new THREE.Mesh(
        new THREE.SphereGeometry(NS_RADIUS, 48, 48),
        new THREE.MeshStandardMaterial({
            map: neutronStarTexture,
            emissiveMap: neutronStarTexture,
            emissive: 0xffffff,
            emissiveIntensity: 1.0,
        })
    );
    tidalFrame.add(neutronStar);

    nsBaseEmissive = neutronStar.material.emissive.clone();
    neutronStar.add(new THREE.PointLight(0xffaa33, 900, 1500));

    blackHole = new BlackHole({ radius: R_S_BH, colorWrite: true });
    barycenter.add(blackHole.group);

    scene.add(new THREE.AmbientLight(0xffffff, 0.08));

    orbit = new BinaryOrbit({
        massStar: MASS_NS,
        massBH: MASS_BH,
        separation: START_SEPARATION,
        pacingExponent: PACING_EXPONENT,
        plungePacing: PLUNGE_PACING,
        ringdownPacing: RINGDOWN_PACING,
        contactRadius: CONTACT_RADIUS,
    });
    orbit.timeScale = timeScaleForInitialRate(orbit, INITIAL_REV_PER_SEC);

    cacheReadouts();
    mathPanel = wireMathPanel();
    wireControls();
    wireVisibility();

    animate();
}

function cacheReadouts() {
    const id = (x) => document.getElementById(x);
    readouts = {
        status: id('statusReadout'),
        sep: id('sepReadout'),
        freq: id('freqReadout'),
        compression: id('compressionReadout'),
        tidal: id('tidalReadout'),
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
        if (!paused) clock.getDelta();          // drop the accumulated pause
        const icon = pauseBtn.querySelector('.btn-icon');
        const label = pauseBtn.querySelector('.btn-label');
        if (icon) icon.textContent = paused ? '▶' : '⏸';
        if (label) label.textContent = paused ? 'Play' : 'Pause';
    });
}

/**
 * Stop rendering when nobody is looking.
 *
 * visibilitychange only fires when the whole tab hides. It does nothing when
 * the canvas is simply scrolled off the top of a long page, which is what
 * happens the moment someone reads the text below — so the exhibit keeps
 * rendering at full rate behind them. An IntersectionObserver covers that case.
 */
function wireVisibility() {
    document.addEventListener('visibilitychange', () => {
        visible = !document.hidden;
        if (visible) clock.getDelta();
    });

    const io = new IntersectionObserver(
        ([entry]) => {
            onScreen = entry.isIntersecting;
            if (onScreen) clock.getDelta();
        },
        { threshold: 0 }
    );
    io.observe(canvas);

    const ro = new ResizeObserver(() => {
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        lensingPass.setSize(w, h, Math.min(window.devicePixelRatio, 2));
    });
    ro.observe(canvas);
}

function resetOrbit() {
    orbit.reset();
    orbit.timeScale = timeScaleForInitialRate(orbit, INITIAL_REV_PER_SEC);

    burstRadius = -1;
    absorbTime = 0;

    tidalFrame.scale.setScalar(1);
    neutronStar.scale.setScalar(1);
    neutronStar.visible = true;
    neutronStar.material.emissiveIntensity = 1.0;
    neutronStar.material.emissive.copy(nsBaseEmissive);

    blackHole.group.scale.setScalar(1);
    camera.position.copy(CAMERA_HOME);
    camera.fov = CAMERA_FOV;
    camera.updateProjectionMatrix();
    camera.lookAt(0, 0, 0);

    lensingPass.setBurst(-1, 0);
    clock.getDelta();
}

// =====================================================================
//  Per-frame updates
// =====================================================================

/**
 * Point the tidal frame at the black hole and stretch it along that line.
 *
 * The ellipsoid is volume-conserving: the long axis grows by (1 + ε) and the
 * two short axes shrink by 1/√(1 + ε), so the star deforms rather than
 * inflating. lookAt with world up = +Y gives a rotation purely about Y,
 * because both bodies stay in the orbital plane — which leaves the star's own
 * spin axis where it belongs.
 *
 * @param {number} epsilon Fractional elongation, already gained and clamped.
 */
function applyTidalDeformation(epsilon) {
    tidalFrame.lookAt(bhWorldPos);
    const shortAxis = 1 / Math.sqrt(1 + epsilon);
    tidalFrame.scale.set(shortAxis, shortAxis, 1 + epsilon);
}

/**
 * Dim and redden the star as its light climbs out of the well.
 * @param {number} g Redshift factor √(1 − 2M/r), in [0, 1].
 */
function applyRedshift(g) {
    const dim = Math.pow(g, REDSHIFT_EXPONENT);
    neutronStar.material.emissiveIntensity = Math.max(dim, 0.06);
    // Toward deep orange-red as g falls: the blue end leaves the visible band first.
    neutronStar.material.emissive.copy(nsBaseEmissive).lerp(
        new THREE.Color(0xff5522), Math.min(1 - g, 0.85)
    );
}

/**
 * The merger itself: the star crosses the horizon and the horizon grows.
 *
 * Nothing lights up. The star is absorbed over a third of a second, sliding
 * into the hole rather than fading on the spot, and the horizon expands by
 * the mass it just swallowed minus the 3.8% radiated away.
 *
 * @param {number} dt Wall-clock delta.
 */
function updateMerger(dt) {
    absorbTime = Math.min(absorbTime + dt, ABSORB_SECONDS);
    const s = absorbTime / ABSORB_SECONDS;
    const ease = s * s * (3 - 2 * s);

    // Slide the star into the hole and shrink it out of existence.
    tidalFrame.position.lerp(bhWorldPos, ease);
    neutronStar.scale.setScalar(Math.max(1 - ease, 0.0001));
    neutronStar.visible = ease < 0.995;

    // Horizon growth, on the same easing: R_s ∝ M_final.
    const growth = 1 + (orbit.horizonGrowthFactor() - 1) * ease;
    blackHole.group.scale.setScalar(growth);
    return growth;
}

/**
 * The outgoing merger pulse and the shove it gives the camera.
 * @param {number} dt Wall-clock delta.
 */
function updateBurst(dt) {
    if (burstRadius < 0) return 0;

    burstRadius += BURST_SPEED * dt;
    if (burstRadius > 2.6) {
        burstRadius = -1;
        lensingPass.setBurst(-1, 0);
        return 0;
    }

    const amp = orbit.peakStrain * BURST_GAIN * Math.exp(-burstRadius / BURST_FALLOFF);
    lensingPass.setBurst(burstRadius, amp);
    return amp;
}

/**
 * Camera response to the passing wave.
 *
 * The camera sits in the strain field like everything else, so it moves.
 * The displacement is proportional to the wave amplitude at the origin and
 * oscillates at the ringdown frequency — a real quadrupole wave stretches one
 * transverse axis while squeezing the other, which is what the two opposed
 * sine terms below are doing.
 */
function updateCameraShake(burstAmp) {
    const wobble = burstAmp * SHAKE_GAIN;
    const phase = orbit.ringdownPhase;

    camera.position.set(
        CAMERA_HOME.x + Math.sin(phase) * wobble,
        CAMERA_HOME.y - Math.sin(phase) * wobble,
        CAMERA_HOME.z
    );
    camera.fov = CAMERA_FOV + Math.cos(phase) * wobble * 0.35;
    camera.updateProjectionMatrix();
    camera.lookAt(0, 0, 0);
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

    if (orbit.merged) {
        text(readouts.sep, '—');
        text(readouts.freq, orbit.ringdownComplete
            ? '—'
            : (orbit.ringdownAngularFrequency() / (2 * Math.PI * TOY_TIME_TO_SECONDS)).toFixed(0) + ' Hz');
        text(readouts.tidal, '—');
    } else {
        const gwFreqHz = orbit.gwAngularFrequency() / (2 * Math.PI * TOY_TIME_TO_SECONDS);
        text(readouts.sep, (orbit.a * TOY_KM).toFixed(1) + ' km');
        text(readouts.freq, gwFreqHz.toFixed(0) + ' Hz');
        text(readouts.tidal, (orbit.tidalEllipticity(NS_RADIUS) * 100).toFixed(1) + ' %');
    }

    text(readouts.compression, '~' + Math.round(orbit.timeCompression() / 10) * 10 + '×');

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

    const dt = Math.min(clock.getDelta(), 1 / 20);   // survive a stalled tab
    const wasMerged = orbit.merged;

    orbit.step(dt);

    // Capture the strain at the instant the horizons join — this is what the
    // burst amplitude is scaled from, rather than a number picked by hand.
    if (orbit.merged && !wasMerged) {
        orbit.peakStrain = orbit.strainAmplitude(camera.position.length());
        burstRadius = 0;
    }

    // ── Positions ──
    const pos = orbit.getPositions();
    tidalFrame.position.set(pos.star.x, 0, pos.star.z);
    blackHole.group.position.set(pos.blackHole.x, 0, pos.blackHole.z);

    blackHole.getWorldPosition(bhWorldPos);
    tidalFrame.getWorldPosition(nsWorldPos);

    neutronStar.rotation.y += 0.6 * dt;

    // ── Tides and redshift ──
    let horizonGrowth = 1;
    if (!orbit.merged) {
        const epsilon = Math.min(orbit.tidalEllipticity(NS_RADIUS) * TIDAL_GAIN, TIDAL_MAX);
        applyTidalDeformation(epsilon);
        applyRedshift(orbit.redshiftFactor());
    } else {
        horizonGrowth = updateMerger(dt);
    }

    // ── Screen-space bookkeeping ──
    bhScreenPos.copy(bhWorldPos).project(camera);
    nsScreenPos.copy(nsWorldPos).project(camera);

    lensingPass.setBlackHolePos(bhScreenPos.x * 0.5 + 0.5, bhScreenPos.y * 0.5 + 0.5);
    lensingPass.setBlackHoleDepth(camera, bhWorldPos);
    lensingPass.setBlackHoleRadius(
        blackHole.getScreenRadius(camera) * (BH_SCREEN_RADIUS_TRACKS_SCALE ? 1 : horizonGrowth)
    );

    // Is the star currently behind the hole, and close to it on screen? If so
    // its light is being lensed around the ring, and the ring picks up its colour.
    const camToNS = camera.position.distanceTo(nsWorldPos);
    const camToBH = camera.position.distanceTo(bhWorldPos);
    const screenDist = Math.hypot(nsScreenPos.x - bhScreenPos.x, nsScreenPos.y - bhScreenPos.y);
    const closeness = THREE.MathUtils.clamp(1 - screenDist / 0.3, 0, 1);
    const alignment = orbit.merged ? 0 : (camToNS > camToBH ? 1 : 0) * closeness;

    lensingPass.setSourceAlignment(nsScreenPos.x * 0.5 + 0.5, nsScreenPos.y * 0.5 + 0.5, alignment);

    // ── Waves ──
    const observerDistance = camera.position.length();
    const envelope = orbit.ringdownEnvelope();
    const gwPhase = orbit.merged ? orbit.ringdownPhase : 2 * orbit.phase;
    const rippleAmp = orbit.merged
        ? orbit.peakStrain * RIPPLE_GAIN * envelope
        : orbit.strainAmplitude(observerDistance) * RIPPLE_GAIN;

    originScreen.set(0, 0, 0).project(camera);
    lensingPass.setRipple(
        originScreen.x * 0.5 + 0.5,
        originScreen.y * 0.5 + 0.5,
        gwPhase,
        rippleAmp
    );

    const burstAmp = updateBurst(dt);
    if (orbit.merged) updateCameraShake(burstAmp);

    updatePanel();
    lensingPass.render(renderer, scene, camera);
}

init();