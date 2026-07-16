// =====================================================================
// main.js — composition root. Det eneste sted alt kender til alt.
//
// Bemærk mønstret: hver klasse/factory får sine afhængigheder GIVET
// (scene, camera, player...) i stedet for selv at opsnuse dem globalt.
// Dependency Injection uden en container — samme princip som i .NET,
// bare håndholdt.
// =====================================================================
import * as THREE from 'three';
import { createPlanet } from './planet.js';
import { createSpace } from './space.js';
import { Controls } from './controls.js';
import { Player } from './player.js';
import { CameraRig } from './cameraRig.js';
import { InteractableSystem, registerExhibits, buildPathMarkers, buildNavMenu } from './interactables.js';

// --- Setup ---------------------------------------------------------------
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#07070f');

const camera = new THREE.PerspectiveCamera(
    50, window.innerWidth / window.innerHeight, 0.1, 2000);

// --- Verden -----------------------------------------------------------------
scene.add(createPlanet());
createSpace(scene);

const env = createSpace(scene);

const controls = new Controls();
const player = new Player(scene);
const rig = new CameraRig(camera, player);

// Milestone 2: exhibit-monumenter med proximity-detection.
// main.js beslutter HVILKE exhibits der findes (registerExhibits),
// systemet håndterer resten. Nye exhibits tilføjes i interactables.js
// uden at røre noget her.
const interactables = new InteractableSystem(scene, player);
registerExhibits(interactables);

buildPathMarkers(scene);

buildNavMenu(interactables);

// --- Loop -------------------------------------------------------------------
const clock = new THREE.Clock();

renderer.setAnimationLoop(() => {
    // Clamp dt: hvis fanen har været i baggrunden, kan dt blive kæmpe,
    // og så tunnelerer spilleren gennem planeten. Fysik hader store dt.
    const dt = Math.min(clock.getDelta(), 0.05);

    player.update(dt, controls, camera);
    rig.update(dt);

    // Skygge-kassen følger spilleren: lys-positionen er kun et anker
    // for skygge-kameraet — retningen (sunDir) er det der betyder noget.
    env.key.position.copy(player.position).addScaledVector(env.sunDir, 60);
    env.key.target.position.copy(player.position);
    interactables.update(dt, clock.elapsedTime);

    renderer.render(scene, camera);
});

// --- Resize -------------------------------------------------------------------
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- HUD: fade hint ud når spilleren har lært at gå -----------------------------
let hasMoved = false;
window.addEventListener('keydown', (e) => {
    if (!hasMoved && ['KeyW', 'KeyA', 'KeyS', 'KeyD',
        'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        hasMoved = true;
        setTimeout(() => {
            document.getElementById('hint')?.classList.add('fade');
        }, 4000);
    }
});

// Touch-enheder: byt tastatur-hintet ud med touch-instruktioner
const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
const hintEl = document.getElementById('hint');
if (coarsePointer && hintEl) {
    hintEl.innerHTML = 'Venstre side — bevæg <span class="hint-sep">·</span> Højre side — hop';
    hintEl.classList.add('touch');
    // Fade når spilleren har prøvet det (spejler keyboard-logikken)
    window.addEventListener('touchstart', () => {
        setTimeout(() => hintEl.classList.add('fade'), 5000);
    }, { once: true });
}

Promise.all([
    document.fonts.ready,
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
]).then(() => {
    const loader = document.getElementById('loader');
    loader.classList.add('fade-out');
    setTimeout(() => loader.remove(), 900);
});