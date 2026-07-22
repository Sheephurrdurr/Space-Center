import * as THREE from 'three';
import { BlackHole } from './BlackHole.js';
import { LensingPass } from './LensingPass.js';
import { BinaryOrbit, timeScaleForDuration } from './OrbitalPhysics.js';
import { wireMathPanel } from '../../shared/exhibitCommon.js';

const bhScreenPos = new THREE.Vector3();
const bhWorldPos = new THREE.Vector3();

const nsWorldPos = new THREE.Vector3();
const nsScreenPos = new THREE.Vector3();

const canvas = document.getElementById('solarCanvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setSize(canvas.clientWidth, canvas.clientHeight);
renderer.setPixelRatio(window.devicePixelRatio);

// ── Fysisk system ──
const massBH = 5;
const massNS = 1.4;
const R_s_BH = 2 * massBH;       // = 10
const R_s_NS = 2 * massNS;       // = 2.8
const nsRadius = 2.9 * R_s_NS;   // ≈ 8.1

const TOY_TIME_TO_SECONDS = (R_s_BH * 1474) / 3e8; // R_s_BH=10 toy-units, 1 toy-unit = 1474 m, c = 3e8 m/s → ≈ 4.91e-5 s, quick maths. 

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, canvas.clientWidth / canvas.clientHeight, 0.1, 2000);
camera.position.set(0, 20, 170);
camera.lookAt(0, 0, 0);

const loader = new THREE.TextureLoader();
const starfieldTexture = loader.load('/../assets/textures/starfield_4k.jpg');
const lensingPass = new LensingPass(canvas, starfieldTexture);

const barycenter = new THREE.Object3D(); // statisk container, fysikken styrer positionerne
scene.add(barycenter);

const neutronStarTexture = loader.load('/assets/textures/neutron_star.jpg');

const neutronStar = new THREE.Mesh(
    new THREE.SphereGeometry(nsRadius, 32, 32),
    new THREE.MeshStandardMaterial({ map: neutronStarTexture, emissiveMap: neutronStarTexture, emissive: 0xffffff, emissiveIntensity: 1.0 })
);

barycenter.add(neutronStar);
neutronStar.add(new THREE.PointLight(0xffaa33, 900, 1500));

const blackHole = new BlackHole({ radius: R_s_BH });
barycenter.add(blackHole.group);

scene.add(new THREE.AmbientLight(0xffffff, 0.08));

const clock = new THREE.Clock();
let elapsed = 0;
let paused = false;

wireMathPanel();

const pauseBtn = document.getElementById('pauseBtn');
const restartBtn = document.getElementById('restartBtn');

pauseBtn.addEventListener('click', () => {
    paused = !paused;
    if (!paused) clock.getDelta();
    const icon = pauseBtn.querySelector('.btn-icon');
    const label = pauseBtn.querySelector('.btn-label');
    if (icon) icon.textContent = paused ? '▶' : '⏸';
    if (label) label.textContent = paused ? 'Play' : 'Pause';
});

restartBtn.addEventListener('click', resetOrbit);

const orbit = new BinaryOrbit({
    massStar: massNS,
    massBH: massBH,
    separation: 100,
    timeScale: 1
});

orbit.timeScale = timeScaleForDuration(orbit, 10);

function resetOrbit() {
    orbit.a = 100;
    orbit.phase = 0;
    orbit.merged = false;
    orbit.ringdownTime = 0;
    orbit.ringdownPhase = 0;
    orbit.timeScale = timeScaleForDuration(orbit, 10);

    neutronStar.scale.setScalar(1);
    neutronStar.visible = true;

    elapsed = 0;
    clock.getDelta(); // tøm akkumuleret tid
}
document.getElementById("restartBtn").addEventListener("click", resetOrbit);

function updatePanel() {
    const status = orbit.merged ? "MERGED" : "INSPIRALING";

    document.getElementById('statusReadout').textContent = status;

    if (!mathPanel.classList.contains('hidden') && !orbit.merged) {
        const m1 = orbit.m1.toFixed(1);
        const m2 = orbit.m2.toFixed(1);
        const mtot = orbit.totalMass.toFixed(1);
        const a = orbit.a.toFixed(2);
        const dadt = orbit.orbitalDecayRate().toFixed(6);
        const K = (64/5) * orbit.m1 * orbit.m2 * orbit.totalMass;
        const tRemain = Math.max(orbit.a**4 - orbit.mergerRadius**4, 0) / (4 * K);
        const tRemainMs = (tRemain * TOY_TIME_TO_SECONDS * 1000).toFixed(3);
        const fgw = (orbit.gwAngularFrequency() / (2 * Math.PI * TOY_TIME_TO_SECONDS)).toFixed(0);

        document.getElementById('mathSubstituted').textContent =
            `-(64/5) × ${m1} × ${m2} × ${mtot} / ${a}³`;
        document.getElementById('mathDadt').textContent = dadt;
        document.getElementById('mathTmerge').textContent = tRemainMs;
        document.getElementById('mathFgw').textContent = fgw;
    }

    if (orbit.merged) {
        document.getElementById('sepReadout').textContent = '—';
        document.getElementById('freqReadout').textContent = '—';
    } else {
        const gwFreqHz = orbit.gwAngularFrequency() / (2 * Math.PI * TOY_TIME_TO_SECONDS);
        document.getElementById('sepReadout').textContent = (orbit.a * 1.48).toFixed(1) + ' km';
        document.getElementById('freqReadout').textContent = gwFreqHz.toFixed(0) + ' Hz';
    }

    const restartBtn = document.getElementById('restartBtn');
    if (orbit.merged && orbit.ringdownEnvelope(1.0) < 0.01) {
        restartBtn.classList.remove('hidden');
    } else {
        restartBtn.classList.add('hidden');
    }
}

function animate() {
    requestAnimationFrame(animate);

    if(paused) return;
    const resetBtn = document.getElementById("resetBtn");

    const dt = clock.getDelta();
    elapsed += dt;
    orbit.step(dt);

    if(orbit.merged && orbit.ringdownEnvelope(1.0) < 0.01) {
        restartBtn.style.display = "block";
    }
    else {
        restartBtn.style.display = "none";
    }

    const pos = orbit.getPositions();
    neutronStar.position.set(pos.star.x, 0, pos.star.z);

    neutronStar.getWorldPosition(nsWorldPos);
    nsScreenPos.copy(nsWorldPos).project(camera);

    const camToNS = camera.position.distanceTo(nsWorldPos);
    const camToBH = camera.position.distanceTo(bhWorldPos);
    const isBehind = camToNS > camToBH ? 1.0 : 0.0;

    const screenDist = Math.hypot(nsScreenPos.x - bhScreenPos.x, nsScreenPos.y - bhScreenPos.y);
    const closeness = THREE.MathUtils.clamp(1.0 - screenDist / 0.3, 0, 1); // 0.3 = tuning-knob

    const nsAlignment = orbit.merged ? 0.0 : isBehind * closeness;

    lensingPass.setSourceAlignment(
        nsScreenPos.x * 0.5 + 0.5,
        nsScreenPos.y * 0.5 + 0.5,
        nsAlignment
    );

    if (orbit.merged) {
        const fade = orbit.ringdownEnvelope(1.0);
        neutronStar.scale.setScalar(Math.max(fade, 0.0001));
        neutronStar.visible = fade > 0.01;
    }

    blackHole.group.position.set(pos.blackHole.x, 0, pos.blackHole.z);

    neutronStar.rotation.y += 0.002;

    blackHole.getWorldPosition(bhWorldPos);
    bhScreenPos.copy(bhWorldPos).project(camera);
    lensingPass.setBlackHolePos(bhScreenPos.x * 0.5 + 0.5, bhScreenPos.y * 0.5 + 0.5);
    lensingPass.setBlackHoleDepth(camera, bhWorldPos);
    lensingPass.setBlackHoleRadius(blackHole.getScreenRadius(camera));

    const disruptR = orbit.tidalDisruptionRadius(nsRadius);
    const status = orbit.merged ? "MERGED" : orbit.a <= disruptR ? "DISRUPTION" : "inspiraling";

    // ── Ripple wiring ──
    const observerDistance = camera.position.length();
    const rippleAmpGain = 3.0;

    const gwPhase = orbit.merged ? orbit.ringdownPhase : 2 * orbit.phase;
    const envelope = orbit.ringdownEnvelope();
    const rippleAmp = orbit.strainAmplitude(observerDistance) * rippleAmpGain * envelope;
    const originScreen = new THREE.Vector3(0, 0, 0).project(camera);

    lensingPass.setRipple(
        originScreen.x * 0.5 + 0.5,
        originScreen.y * 0.5 + 0.5,
        gwPhase,
        rippleAmp,
    );

    updatePanel();

    lensingPass.render(renderer, scene, camera);
}
animate();