// =====================================================================
// astronautModel.js, GLB astronaut.
//
// Samme offentlige interface som Astronaut (root, update, justLanded,
// justStepped), på den måde skal player.js kun ændre ÉN import-linje.
//
// GLB'en indeholder 5 navngivne meshes (body, armL/R, legL/R) splittet
// offline. Her re-parenter vi dem i pivot-grupper ved leddene, så det
// eksisterende procedurale animationssystem kan drive dem.
// =====================================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const SCALE = 0.42;          // model er 4.02 høj → ~1.69 i verden
const HIP_Y = 1.55;          // led-positioner i MODEL-enheder
const PIVOTS = {
    legL: new THREE.Vector3(-0.30, HIP_Y, 0.15),
    legR: new THREE.Vector3( 0.30, HIP_Y, 0.15),
    armL: new THREE.Vector3(-0.72, 2.79, 0.13),
    armR: new THREE.Vector3( 0.72, 2.79, 0.13),
};

const LAND_SQUASH_DURATION = 0.18;
const LAND_SQUASH_AMOUNT   = 0.28;

export class AstronautModel {
    constructor() {
        this.root = new THREE.Group();
        this.walkPhase = 0;
        this.wasGrounded = true;
        this.landTimer = 0;
        this.justLanded = false;
        this.justStepped = false;
        this.lastSwing = 0;

        // Alt indhold lever i model-enheder inde i en skalerings-gruppe
        this.scaler = new THREE.Group();
        this.scaler.scale.setScalar(SCALE);
        this.root.add(this.scaler);

        // body-gruppen har pivot i hoften
        this.body = new THREE.Group();
        this.body.position.y = HIP_Y;
        this.scaler.add(this.body);

        // Limb pivot-grupper er tomme indtil GLB'en er loadet
        this.limbs = {};
        for (const [name, pivot] of Object.entries(PIVOTS)) {
            const g = new THREE.Group();
            g.position.copy(pivot);
            if (name.startsWith('arm')) {
                // Arme hører til overkroppen -> skal følge dens hælden.
                // body har pivot i hoften, så armens position angives
                // RELATIVT til hoften:
                g.position.y -= HIP_Y;
                this.body.add(g);
            } else {
                this.scaler.add(g);
            }
            this.limbs[name] = g;
        }

        new GLTFLoader().load('models/Astronaut_rigged.glb', (gltf) => {
            // Saml FØRST alle meshes, re-parent BAGEFTER. Lad være at ændre
            // scene-grafen midt i en traverse, fordi add() fjerner objektet fra dets
            // gamle forælder, og så springer iterationen søskende over. Lesson learned. The hard way.
            const meshes = [];
            gltf.scene.traverse((obj) => {
                if (obj.isMesh) meshes.push(obj);
            });

            for (const obj of meshes) {
                obj.material.roughness = 0.85;

                if (obj.name === 'body') {
                    obj.position.y = -HIP_Y;
                    this.body.add(obj);
                } else if (this.limbs[obj.name]) {
                    obj.position.copy(PIVOTS[obj.name]).negate();
                    this.limbs[obj.name].add(obj);
                }
            }
        });
    }

    update(dt, t, speedRatio, grounded) {
        this.justLanded = grounded && !this.wasGrounded;
        if (this.justLanded) this.landTimer = LAND_SQUASH_DURATION;
        this.wasGrounded = grounded;

        this.walkPhase += dt * 9 * speedRatio;

        const swing = grounded
            ? Math.sin(this.walkPhase) * 0.65 * Math.min(speedRatio, 1.3)
            : 0.35;

        this.justStepped = grounded && speedRatio > 0.3
            && Math.sign(swing) !== Math.sign(this.lastSwing);
        this.lastSwing = swing;

        this.limbs.legL.rotation.x = swing;
        this.limbs.legR.rotation.x = -swing;
        this.limbs.armL.rotation.x = -swing * 0.55;
        this.limbs.armR.rotation.x = swing * 0.55;

        // Idle-bob + fremad-hælden. Bob er i MODEL-enheder,
        // så verdens-værdien divideres med SCALE
        const idleBob = Math.sin(t * 2.2) * 0.015 / SCALE;
        const walkBob = Math.abs(Math.sin(this.walkPhase)) * 0.05 / SCALE
            * Math.min(speedRatio, 1);
        this.body.position.y = HIP_Y + idleBob + walkBob;
        this.body.rotation.x = THREE.MathUtils.lerp(
            this.body.rotation.x, speedRatio * 0.15, 1 - Math.exp(-8 * dt));

        this.landTimer = Math.max(0, this.landTimer - dt);
        const squashT = this.landTimer / LAND_SQUASH_DURATION;
        const squash = Math.sin(squashT * Math.PI) * LAND_SQUASH_AMOUNT;
        this.root.scale.set(1 + squash * 0.5, 1 - squash, 1 + squash * 0.5);
    }
}