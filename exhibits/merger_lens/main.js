import * as THREE from 'three';
import { BlackHole } from './BlackHole.js';
import { RayMarchPass } from './RayMarchPass.js';
import { BinaryOrbit, timeScaleForDuration } from './OrbitalPhysics.js';

// ── Vectors til world/screen position tracking ──
const bhWorldPos  = new THREE.Vector3();
const nsWorldPos  = new THREE.Vector3();

// ── Renderer ──
const canvas = document.getElementById('solarCanvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setSize(canvas.clientWidth, canvas.clientHeight);
renderer.setPixelRatio(window.devicePixelRatio);

// ── Fysisk system ──
const massBH = 5;
const massNS = 1.4;
const RS     = 2 * massBH;       // = 10
const R_s_BH = 2 * massBH;       // = 10
const R_s_NS = 2 * massNS;       // = 2.8
const nsRadius = 2.9 * R_s_NS;   // ≈ 8.1
const TOY_TIME_TO_SECONDS = 1474 / 3e8;

// ── Scene + kamera ──
const scene  = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, canvas.clientWidth / canvas.clientHeight, 0.1, 2000);
camera.position.set(0, 30, 160);
camera.lookAt(0, 0, 0);

const BASE_FOV = 60; 

function onResize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const aspect = w / h;
    camera.fov = aspect < 1 ? BASE_FOV / aspect : BASE_FOV;
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    camera.lookAt(0, 0, 0);
}
window.addEventListener('resize', onResize);
onResize(); // kør én gang med det samme, i stedet for de statiske linjer du har nu


// ── State ──
const clock = new THREE.Clock();
let elapsed = 0;
let paused  = false;

// ── Module-scope variabler (sættes i init) ──
let rayMarchPass;
let neutronStar;
let blackHole;
let barycenter;
let orbit;
let mathPanel;

// ── Reset ──
function resetOrbit() {
    orbit.a           = 100;
    orbit.phase       = Math.PI * 0.5;
    orbit.merged      = false;
    orbit.ringdownTime  = 0;
    orbit.ringdownPhase = 0;
    orbit.timeScale   = timeScaleForDuration(orbit, 10);

    neutronStar.scale.setScalar(1);
    neutronStar.visible = true;
    elapsed = 0;
    clock.getDelta();
}

// ── Panel update ──
function updatePanel() {
    document.getElementById('statusReadout').textContent =
        orbit.merged ? 'MERGED' : 'INSPIRALING';

    if (!mathPanel.classList.contains('hidden') && !orbit.merged) {
        const K        = (64/5) * orbit.m1 * orbit.m2 * orbit.totalMass;
        const tRemain  = Math.max(orbit.a**4 - orbit.mergerRadius**4, 0) / (4 * K);
        const fgw      = orbit.gwAngularFrequency() / (2 * Math.PI * TOY_TIME_TO_SECONDS);

        document.getElementById('mathSubstituted').textContent =
            `-(64/5) × ${orbit.m1.toFixed(1)} × ${orbit.m2.toFixed(1)} × ${orbit.totalMass.toFixed(1)} / ${orbit.a.toFixed(2)}³`;
        document.getElementById('mathDadt').textContent    = orbit.orbitalDecayRate().toFixed(6);
        document.getElementById('mathTmerge').textContent  = (tRemain * TOY_TIME_TO_SECONDS * 1000).toFixed(3);
        document.getElementById('mathFgw').textContent     = fgw.toFixed(0);
    }

    if (orbit.merged) {
        document.getElementById('sepReadout').textContent  = '—';
        document.getElementById('freqReadout').textContent = '—';
    } else {
        const gwFreqHz = orbit.gwAngularFrequency() / (2 * Math.PI * TOY_TIME_TO_SECONDS);
        document.getElementById('sepReadout').textContent  = (orbit.a * 1.48).toFixed(1) + ' km';
        document.getElementById('freqReadout').textContent = gwFreqHz.toFixed(0) + ' Hz';
    }

    const restartBtn = document.getElementById('restartBtn');
    const showRestart = orbit.merged && orbit.ringdownEnvelope(1.0) < 0.01;
    restartBtn.classList.toggle('hidden', !showRestart);
}

// ── Init (async pga. EXR loader) ──
async function init() {
    const loader = new THREE.TextureLoader();
    const starfieldTexture = await loader.loadAsync('/assets/textures/starfield_4k.jpg')
    starfieldTexture.minFilter = THREE.LinearFilter;
    starfieldTexture.magFilter = THREE.LinearFilter;

    const neutronStarTexture = loader.load('/assets/textures/neutron_star.jpg');

    rayMarchPass = new RayMarchPass(canvas, starfieldTexture, neutronStarTexture);

    barycenter = new THREE.Object3D();
    scene.add(barycenter);

    neutronStar = new THREE.Mesh(
        new THREE.SphereGeometry(nsRadius, 32, 32),
        new THREE.MeshStandardMaterial({
            colorWrite: false,
            depthWrite: true
        })
    );
    barycenter.add(neutronStar);
    neutronStar.add(new THREE.PointLight(0xffaa33, 900, 1500));

    blackHole = new BlackHole({ radius: R_s_BH });
    barycenter.add(blackHole.group);

    scene.add(new THREE.AmbientLight(0xffffff, 0.08));

    orbit = new BinaryOrbit({ massStar: massNS, massBH, separation: 100, timeScale: 1 });
    orbit.phase     = Math.PI * 0.5;   // start 90° inde — NS passerer foran BH tidligt
    orbit.timeScale = timeScaleForDuration(orbit, 10);

    const physicalSeconds = orbit.physicalTimeToMerge() * TOY_TIME_TO_SECONDS;
    document.getElementById("slowmoReadout").textContent = 
        "~" + (10 / physicalSeconds).toFixed(0) + "×";
    // Event listeners
    mathPanel = document.getElementById('mathPanel');

    document.getElementById('mathBtn').addEventListener('click', () => {
        mathPanel.classList.toggle('hidden');
        const label = document.getElementById('mathBtn').querySelector('.btn-label');
        if (label) label.textContent = mathPanel.classList.contains('hidden') ? 'Math' : 'Close';
    });

    document.getElementById('pauseBtn').addEventListener('click', () => {
        paused = !paused;
        if (!paused) clock.getDelta();
        const btn   = document.getElementById('pauseBtn');
        const icon  = btn.querySelector('.btn-icon');
        const label = btn.querySelector('.btn-label');
        if (icon)  icon.textContent  = paused ? '▶' : '⏸';
        if (label) label.textContent = paused ? 'Play' : 'Pause';
    });

    document.getElementById('restartBtn').addEventListener('click', resetOrbit);

    animate();
}

// ── Animate ──
function animate() {
    requestAnimationFrame(animate);
    if (paused) return;

    const dt = clock.getDelta();
    elapsed += dt;
    orbit.step(dt);

    // Opdater positioner
    const pos = orbit.getPositions();
    neutronStar.position.set(pos.star.x,      0, pos.star.z);
    blackHole.group.position.set(pos.blackHole.x, 0, pos.blackHole.z);

    // World + screen positions
    blackHole.getWorldPosition(bhWorldPos);
    neutronStar.getWorldPosition(nsWorldPos);

    // Er NS bag BH set fra kameraet? (bruges i shadow-branchen i shaderen)
    const camToNS  = camera.position.distanceTo(nsWorldPos);
    const camToBH  = camera.position.distanceTo(bhWorldPos);
    const isBehind = camToNS > camToBH ? 1.0 : 0.0;

    rayMarchPass.setNsIsBehind(isBehind);
    
    // NS merger fade
    const currentNsRadius = orbit.merged
        ? nsRadius * Math.max(orbit.ringdownEnvelope(1.0), 0.0001)
        : nsRadius;

    if (orbit.merged) {
        const scale = Math.max(orbit.ringdownEnvelope(1.0), 0.0001);
        neutronStar.scale.setScalar(scale);
        neutronStar.visible = scale > 0.01;
    }
    
    neutronStar.rotation.y += 0.002;

    // Shader uniforms
    rayMarchPass.setBhWorld(bhWorldPos, RS);
    rayMarchPass.setNsWorld(nsWorldPos, currentNsRadius);
    rayMarchPass.render(renderer, scene, camera);
    updatePanel();
}

init();