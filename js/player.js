// =====================================================================
// player.js — character controlleren. Og spherical gravity delen
//
// Kernen i hver update:
//   1. up = normalize(position)                    ← "op" afhænger af hvor du står
//   2. bevægelsesretning = kamera-input projiceret i tangentplanet
//   3. flyt: tangent-hastighed + vertikal hastighed (hop/gravity) langs up
//   4. ground check mod groundRadiusAt() — SAMME funktion som meshen bruger
//   5. orientér astronauten så +Y = up og +Z = facing
// =====================================================================
import * as THREE from 'three';
import {
    PLANET, surfaceUp, projectOnTangent,
    tangentBasisQuaternion, groundRadiusAt,
} from './planetMath.js';
import { Droid } from './droid.js';
import { DustEmitter } from './dust.js';

// Genbrugte vektorer så vi ikke allokerer i game-loopet (GC-venligt —
// tænk på det som at undgå unødige `new` i en hot path i C#).
const _up = new THREE.Vector3();
const _camFwd = new THREE.Vector3();
const _gravDir = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class Player {
    constructor(scene) {
        this.astronaut = new Droid(); // It's a droid, but it was an astronaut at some point. Sue me.
        scene.add(this.astronaut.root);

        this.astronaut.root.traverse((o) => { if (o.isMesh) o.castShadow = true; });

        // Spawn - somewhere. Just with math. 
        const spawnDir = new THREE.Vector3(0.25, 1, 0.4).normalize();
        this.position = this.astronaut.root.position;
        this.position.copy(spawnDir).multiplyScalar(groundRadiusAt(spawnDir) + 0.5);

        // Facing: en vilkårlig tangent-retning til at starte med
        this.facing = projectOnTangent(new THREE.Vector3(0, 0, -1), spawnDir)
            .normalize();

        this.verticalSpeed = 0;
        this.grounded = false;
        this.speedRatio = 0; // til animation

        this.dust = new DustEmitter(scene);
    }

    update(dt, controls, camera) {
        const up = surfaceUp(this.position, _up);

        // --- 1) Input → retning i tangentplanet -------------------------
        // Kameraets forward peger delvist ned i planeten; projektionen
        // giver os "fremad langs jorden".
        camera.getWorldDirection(_camFwd);
        projectOnTangent(_camFwd, up, _camFwd);
        if (_camFwd.lengthSq() < 1e-6) _camFwd.copy(this.facing); // edge case
        _camFwd.normalize();
        _camRight.crossVectors(_camFwd, up); // højre = frem × op

        _wish.set(0, 0, 0)
            .addScaledVector(_camFwd, controls.forward)
            .addScaledVector(_camRight, controls.right);

        const moving = _wish.lengthSq() > 1e-6;
        if (moving) _wish.normalize();

        const speed = PLANET.walkSpeed * (controls.sprint ? PLANET.sprintFactor : 1);

        // --- 2) Hop og gravity -------------------------------------------
        if (this.grounded && controls.consumeJump()) {
            this.verticalSpeed = PLANET.jumpSpeed;
            this.grounded = false;
        }
        if (!this.grounded) {
            this.verticalSpeed -= PLANET.gravity * dt;
        }

        // --- 3) Flyt -------------------------------------------------------
        this.position.addScaledVector(_wish, moving ? speed * dt : 0);
        this.position.addScaledVector(up, this.verticalSpeed * dt);

        // --- 4) Ground check ------------------------------------------------
        surfaceUp(this.position, up);
        const groundR = groundRadiusAt(up);
        const height = this.position.length() - groundR;

        if (this.verticalSpeed <= 0 && height <= 0.25) {
            // Snap til jorden (håndterer også at gå op/ned ad skråninger)
            this.position.setLength(groundR);
            this.verticalSpeed = 0;
            this.grounded = true;

        } else if (height > 0.25) {
            this.grounded = false;
        }
        
        // --- 5) Orientering ---------------------------------------------------
        // Facing skal re-projiceres: tangentplanet har drejet sig under os.
        projectOnTangent(this.facing, up, this.facing).normalize();
        if (moving) {
            // Drej blødt mod bevægelsesretningen
            this.facing.lerp(_wish, 1 - Math.exp(-12 * dt)).normalize();
            projectOnTangent(this.facing, up, this.facing).normalize();
        }
        tangentBasisQuaternion(up, this.facing, _q);
        this.astronaut.root.quaternion.slerp(_q, 1 - Math.exp(-20 * dt));

        // --- 6) Animation ------------------------------------------
        const targetRatio = moving ? (controls.sprint ? 1.5 : 1) : 0;
        this.speedRatio = THREE.MathUtils.lerp(
            this.speedRatio, targetRatio, 1 - Math.exp(-10 * dt));
        this.astronaut.update(dt, performance.now() / 1000, this.speedRatio, this.grounded);
            
        if (this.astronaut.justLanded) {
            this.dust.burst(this.position, up, 14);
        }
        if (this.astronaut.justStepped) {
            this.dust.burst(this.position, up, 5);
        }

        _gravDir.copy(up).multiplyScalar(-1);
        this.dust.update(dt, _gravDir);
    }
}
