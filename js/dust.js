// =====================================================================
// Billigt partikel-støv ved fodtrin og landing.
//
// THREE.Points med en fast pulje af positioner i en BufferAttribute.
// =====================================================================
import * as THREE from 'three';

const POOL_SIZE = 120;
const LIFETIME = 0.55;
const PARKED_Y = -9999; // gemmested for "døde" partikler. Far, far away.

export class DustEmitter {
    constructor(scene) {
        this.positions = new Float32Array(POOL_SIZE * 3);
        this.velocities = [];
        this.life = new Float32Array(POOL_SIZE);
        this.cursor = 0; // round-robin pointer ind i puljen

        for (let i = 0; i < POOL_SIZE; i++) {
            this.positions[i * 3 + 1] = PARKED_Y;
            this.velocities.push(new THREE.Vector3());
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
        this.points = new THREE.Points(geo, new THREE.PointsMaterial({
            color: 0xcfc9e0, size: 0.06, sizeAttenuation: true,
            transparent: true, opacity: 0.65, depthWrite: false,
        }));
        scene.add(this.points);

        this.points.frustumCulled = false; // Stop frustum culling my dust, you ass
    }

    /** Spyt `count` støvkorn ud fra `origin`, langs overfladens `up`. */
    burst(origin, up, count) {
        const tangentA = new THREE.Vector3()
            .crossVectors(up, new THREE.Vector3(0, 1, 0.001)).normalize();
        const tangentB = new THREE.Vector3().crossVectors(up, tangentA).normalize();

        for (let n = 0; n < count; n++) {
            const i = this.cursor;
            this.cursor = (this.cursor + 1) % POOL_SIZE;

            this.positions[i * 3] = origin.x;
            this.positions[i * 3 + 1] = origin.y;
            this.positions[i * 3 + 2] = origin.z;
            this.life[i] = LIFETIME;

            const angle = Math.random() * Math.PI * 2;
            const spread = 0.6 + Math.random() * 0.8;
            this.velocities[i]
                .copy(tangentA).multiplyScalar(Math.cos(angle) * spread)
                .addScaledVector(tangentB, Math.sin(angle) * spread)
                .addScaledVector(up, 1.2 + Math.random() * 0.8);
        }
    }

    update(dt, gravityDir) {
        const pos = this.positions;
        for (let i = 0; i < POOL_SIZE; i++) {
            if (this.life[i] <= 0) continue;
            this.life[i] -= dt;

            const v = this.velocities[i];
            v.addScaledVector(gravityDir, 6 * dt);

            pos[i * 3]     += v.x * dt;
            pos[i * 3 + 1] += v.y * dt;
            pos[i * 3 + 2] += v.z * dt;

            if (this.life[i] <= 0) pos[i * 3 + 1] = PARKED_Y;
        }
        this.points.geometry.attributes.position.needsUpdate = true;
    }
}