// =====================================================================
// droid.js — en lille rullende kugle-droide med svævende hoved.
//
// Samme kontrakt som Astronaut/AstronautModel: root, update(dt, t,
// speedRatio, grounded), justLanded, justStepped. Tredje udskiftning
// af figuren uden at røre player.js — kontrakten betaler sig igen.
//
// Rulle-matematikken: rulning uden glid kræver vinkel = distance / r.
// Ruller den langsommere, "skøjter" den; hurtigere, og den "spinner".
// =====================================================================
import * as THREE from 'three';
import { PLANET } from './planetMath.js';

const BODY_RADIUS = 0.42;
const HEAD_HOVER = 1.15;      // hovedets hvilehøjde
const STEP_DISTANCE = 1.1;    // meter rullet mellem hvert "fodtrin" (støv)

const SHELL  = new THREE.Color('#e9e9f2');
const DARK   = new THREE.Color('#4a4560');
const ACCENT = new THREE.Color('#ffb454');
const EYE    = new THREE.Color('#5fd3c4');

const LAND_SQUASH_DURATION = 0.18;
const LAND_SQUASH_AMOUNT   = 0.28;

function mat(color, extra = {}) {
    return new THREE.MeshStandardMaterial({
        color, flatShading: true, roughness: 0.8, ...extra,
    });
}

export class Droid {
    constructor() {
        this.root = new THREE.Group();
        this.wasGrounded = true;
        this.landTimer = 0;
        this.justLanded = false;
        this.justStepped = false;
        this.rollDistance = 0; // akkumuleret siden sidste "skridt"

        // --- Krop: rullende kugle -----------------------------------------
        // Kuglen får sin egen gruppe fordi RULLE-rotationen skal ske
        // isoleret — root's rotation styres af player (facing/up).
        this.ball = new THREE.Group();
        this.ball.position.y = BODY_RADIUS;
        this.root.add(this.ball);

        const shell = new THREE.Mesh(
            new THREE.IcosahedronGeometry(BODY_RADIUS, 1), mat(SHELL));
        this.ball.add(shell);

        // "Dæk-bånd" + nitter: asymmetrien der gør rulningen SYNLIG.
        // Samme lektie som hot spot'en på Kerr-disken — symmetrisk
        // geometri der roterer om sin egen akse er usynlig.
        const band = new THREE.Mesh(
            new THREE.TorusGeometry(BODY_RADIUS * 0.98, 0.05, 6, 24), mat(DARK));
        band.rotation.y = Math.PI / 2; // ringens plan = rulle-planet (YZ)
        this.ball.add(band);

        for (let i = 0; i < 4; i++) {
            const stud = new THREE.Mesh(
                new THREE.BoxGeometry(0.09, 0.09, 0.09),
                mat(ACCENT, { emissive: ACCENT, emissiveIntensity: 0.6 }));
            const a = (i / 4) * Math.PI * 2;
            stud.position.set(0,
                Math.cos(a) * BODY_RADIUS * 0.98,
                Math.sin(a) * BODY_RADIUS * 0.98);
            this.ball.add(stud);
        }

        // --- Hoved: svævende kuppel, ruller IKKE med ------------------------
        this.head = new THREE.Group();
        this.head.position.y = HEAD_HOVER;
        this.root.add(this.head);

        const dome = new THREE.Mesh(
            new THREE.SphereGeometry(0.22, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55),
            mat(SHELL));
        dome.scale.y = 0.85;
        this.head.add(dome);

        const eye = new THREE.Mesh(
            new THREE.BoxGeometry(0.2, 0.05, 0.04),
            mat(EYE, { emissive: EYE, emissiveIntensity: 1.6 }));
        eye.position.set(0, 0.07, 0.17);
        this.head.add(eye);

        const brim = new THREE.Mesh(
            new THREE.CylinderGeometry(0.24, 0.26, 0.05, 10), mat(DARK));
        this.head.add(brim);
    }

    update(dt, t, speedRatio, grounded) {
        this.justLanded = grounded && !this.wasGrounded;
        if (this.justLanded) this.landTimer = LAND_SQUASH_DURATION;
        this.wasGrounded = grounded;

        // --- Rulning: vinkel = tilbagelagt distance / radius -----------------
        const speed = speedRatio * PLANET.walkSpeed;
        const dist = speed * dt;
        if (grounded) {
            this.ball.rotation.x += dist / BODY_RADIUS;
            this.rollDistance += dist;
        }

        // "Fodtrin" = hver STEP_DISTANCE meter rullet
        this.justStepped = false;
        if (grounded && this.rollDistance >= STEP_DISTANCE) {
            this.rollDistance = 0;
            this.justStepped = true;
        }

        // --- Hovedet: hover-bob + fremad-hælden ved fart ----------------------
        const hover = Math.sin(t * 2.6) * 0.035;
        this.head.position.y = HEAD_HOVER + hover + speedRatio * 0.04;
        this.head.rotation.x = THREE.MathUtils.lerp(
            this.head.rotation.x, speedRatio * 0.3, 1 - Math.exp(-8 * dt));

        // I luften: hovedet "løfter sig" lidt — læser som et lille hop-udtryk
        const airLift = grounded ? 0 : 0.12;
        this.head.position.y += airLift;

        // --- Landing-squash, uændret opskrift --------------------------------
        this.landTimer = Math.max(0, this.landTimer - dt);
        const squashT = this.landTimer / LAND_SQUASH_DURATION;
        const squash = Math.sin(squashT * Math.PI) * LAND_SQUASH_AMOUNT;
        this.root.scale.set(1 + squash * 0.5, 1 - squash, 1 + squash * 0.5);
    }
}