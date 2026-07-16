// =====================================================================
// Low poly astronaut built from primitives.
//
// Structure (a small scene-graph-hierachy):
//   root (fødder i y=0, kigger mod +Z)
//   ├── bodyGroup          ← bobber ved idle, hælder fremad ved gang
//   │   ├── torso, backpack, helmet, visor, chestLight
//   │   ├── armL/armR      ← grupper med pivot i skulderen
//   └── legL/legR          ← grupper med pivot i hoften
//
// All animation is procedural: sin-waves driven by a walk phase.
// Just math and pivots all the way down.
// =====================================================================
import * as THREE from 'three';

const SUIT   = new THREE.Color('#e9e9f2');
const DARK   = new THREE.Color('#4a4560');
const VISOR  = new THREE.Color('#1c1a2e');
const ACCENT = new THREE.Color('#ffb454');

// Hoftehøjde er drejepunktet for et forlæns-læn. Alt i body-gruppen
// er positioneret RELATIVT til denne, så body kan rotere om hoften i
// stedet for om jorden. Ben-pivoterne bruger samme konstant, så de to
// aldrig kan drive fra hinanden.
const HIP_HEIGHT = 0.82;
const LAND_SQUASH_DURATION = 0.18;
const LAND_SQUASH_AMOUNT = 0.28;

function mat(color, extra = {}) {
    return new THREE.MeshStandardMaterial({
        color, flatShading: true, roughness: 0.8, ...extra,
    });
}

export class Astronaut {
    constructor() {
        this.root = new THREE.Group();
        this.walkPhase = 0;

        this.wasGrounded = true;
        this.landTimer = 0;
        this.justLanded = false;
        this.justStepped = false;
        this.lastSwing = 0;

        // --- Krop --------------------------------------------------------
        this.body = new THREE.Group();
        this.root.add(this.body);

        const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.38, 4, 8), mat(SUIT));
        torso.position.y = 1.18 - HIP_HEIGHT;
        torso.scale.z = 0.85;
        this.body.add(torso);

        const backpack = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.46, 0.22), mat(DARK));
        backpack.position.set(0, 1.24 - HIP_HEIGHT, -0.28);
        this.body.add(backpack);

        const neckRing = new THREE.Mesh(
            new THREE.CylinderGeometry(0.17, 0.19, 0.09, 10), mat(DARK));
        neckRing.position.y = 1.58 - HIP_HEIGHT;
        this.body.add(neckRing);

        const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 10), mat(SUIT));
        helmet.position.y = 1.75 - HIP_HEIGHT;
        this.body.add(helmet);

        const visorGeo = new THREE.SphereGeometry(0.295, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.35);
        visorGeo.rotateX(Math.PI / 2);
        const visor = new THREE.Mesh(visorGeo, new THREE.MeshStandardMaterial({
            color: '#e8b84f',
            roughness: 0.25,
            metalness: 0.15,
            emissive: '#8a5f16',
            emissiveIntensity: 0.55,
        }));
        visor.position.y = 1.75 - HIP_HEIGHT; // identisk med hjelmens position
        this.body.add(visor);

        const chestLight = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.04),
            mat(ACCENT, { emissive: ACCENT, emissiveIntensity: 0.9 }));
        chestLight.position.set(0.1, 1.3 - HIP_HEIGHT, 0.24);
        this.body.add(chestLight);

        // --- Arme og ben: grupper så pivot sidder i leddet -----------------
        this.armL = this.#limb(0.09, 0.42, SUIT);
        this.armL.position.set(0.34, 1.42 - HIP_HEIGHT, 0);
        this.armR = this.#limb(0.09, 0.42, SUIT);
        this.armR.position.set(-0.34, 1.42 - HIP_HEIGHT, 0);
        this.body.add(this.armL, this.armR);

        this.legL = this.#limb(0.11, 0.5, SUIT);
        this.legL.position.set(0.14, HIP_HEIGHT, 0);
        this.legR = this.#limb(0.11, 0.5, SUIT);
        this.legR.position.set(-0.14, HIP_HEIGHT, 0);
        this.root.add(this.legL, this.legR);
    }

    /** A limb = gruppe (pivot i leddet) med en kapsel hængende nedenunder.*/ 
    #limb(radius, length, color) {
        const group = new THREE.Group();
        const mesh = new THREE.Mesh(
            new THREE.CapsuleGeometry(radius, length, 4, 6), mat(color));
        mesh.position.y = -(length / 2 + radius); // hæng under pivot
        group.add(mesh);
        return group;
    }

    /**
     * @param dt          delta-tid
     * @param t           samlet tid (til idle-bob)
     * @param speedRatio  0 = står stille, 1 = fuld gang, >1 = sprint
     * @param grounded    står vi på jorden?
     */
    update(dt, t, speedRatio, grounded) {
        this.justLanded = grounded && !this.wasGrounded;
        if (this.justLanded) this.landTimer = LAND_SQUASH_DURATION;
        this.wasGrounded = grounded;

        // Walk-cyklussens hastighed følger farten
        this.walkPhase += dt * 9 * speedRatio;

        const swing = grounded
            ? Math.sin(this.walkPhase) * 0.75 * Math.min(speedRatio, 1.3)
            : 0.35; // i luften: frys i en lille "hop-pose"
        
        this.justStepped = grounded && speedRatio > 0.3
            && Math.sign(swing) !== Math.sign(this.lastSwing);

        this.lastSwing = swing;

        // Ben og arme svinger modsat hinanden
        this.legL.rotation.x = swing;
        this.legR.rotation.x = -swing;
        this.armL.rotation.x = -swing * 0.6;
        this.armR.rotation.x = swing * 0.6;

        if (!grounded) {
            // Hop-pose: begge arme lidt ud til siden
            this.armL.rotation.z = -0.5;
            this.armR.rotation.z = 0.5;
        } else {
            this.armL.rotation.z = -0.08;
            this.armR.rotation.z = 0.08;
        }

        // Idle-bob (vejrtrækning) + fremad-hældning når man går
        const idleBob = Math.sin(t * 2.2) * 0.015;
        const walkBob = Math.abs(Math.sin(this.walkPhase)) * 0.05 * Math.min(speedRatio, 1);
        this.body.position.y = HIP_HEIGHT + idleBob + walkBob;
        this.body.rotation.x = THREE.MathUtils.lerp(
            this.body.rotation.x, speedRatio * 0.18, 1 - Math.exp(-8 * dt));

        this.landTimer = Math.max(0, this.landTimer - dt);
        const squashT = this.landTimer / LAND_SQUASH_DURATION; // 1 -> 0
        const squash = Math.sin(squashT * Math.PI) * LAND_SQUASH_AMOUNT;
        this.root.scale.set(1 + squash * 0.5, 1 -squash, 1 + squash * 0.5);
    }
}
