// =====================================================================
// space.js — starfield, sol og belysning.
// =====================================================================
import * as THREE from 'three';

/** Tilfældigt punkt i en kugleskal mellem rMin og rMax. */
function shellPoint(rMin, rMax) {
    const u = Math.random() * 2 - 1;
    const theta = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const r = rMin + Math.random() * (rMax - rMin);
    return [s * Math.cos(theta) * r, s * Math.sin(theta) * r, u * r];
}

function makeStars(count, size, color, opacity) {
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        const [x, y, z] = shellPoint(400, 900);
        positions[i * 3] = x;
        positions[i * 3 + 1] = y;
        positions[i * 3 + 2] = z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return new THREE.Points(geo, new THREE.PointsMaterial({
        color, size, opacity, transparent: true,
        sizeAttenuation: false, // stjerner er "uendeligt" langt væk
        depthWrite: false,
    }));
}

export function createSpace(scene) {
    // To lag stjerner: mange små + få store og klare
    scene.add(makeStars(3500, 1.4, 0xbcbcd8, 0.7));
    scene.add(makeStars(300, 2.6, 0xffffff, 0.95));
    scene.add(makeStars(120, 2.2, 0x9fd8ff, 0.9)); // kølige blå accenter

    // --- Solen -----------------------------------------------------------
    const sunDir = new THREE.Vector3(1, 0.55, 0.65).normalize();

    const sun = new THREE.Mesh(
        new THREE.SphereGeometry(9, 16, 12),
        new THREE.MeshBasicMaterial({ color: 0xfff3d6 }));
    sun.position.copy(sunDir).multiplyScalar(600);
    scene.add(sun);

    // Glow
    const glow = new THREE.Mesh(
        new THREE.SphereGeometry(16, 16, 12),
        new THREE.MeshBasicMaterial({
            color: 0xffdf9e, transparent: true, opacity: 0.22,
        }));
    glow.position.copy(sun.position);
    scene.add(glow);

    // --- Lys ----------------------------------------------------------------
    const key = new THREE.DirectionalLight(0xfff0dd, 2.4);
    key.position.copy(sunDir).multiplyScalar(100);
    scene.add(key);

    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    const s = 18; // halv bredde af skygge-kassen
    key.shadow.camera.left = -s; key.shadow.camera.right = s;
    key.shadow.camera.top = s;   key.shadow.camera.bottom = -s;
    key.shadow.camera.near = 10; key.shadow.camera.far = 150;
    key.shadow.normalBias = 0.06; // mod "shadow acne" på low-poly facetter
    scene.add(key.target);

    // Hemisphere: kold rum-blå ovenfra, violet reflektion "nedefra".
    scene.add(new THREE.HemisphereLight(0x35355e, 0x241f38, 0.85));
    scene.add(new THREE.AmbientLight(0x1c1c2e, 0.6));

    return { key, sunDir };
}
