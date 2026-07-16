// =====================================================================
// planet.js — bygger den low-poly planet.
//
// Trick til low-poly look: toNonIndexed() dublerer vertices så hver
// trekant har sine egne. Dermed giver computeVertexNormals() én
// normal PER FACE i stedet for glatte, delte normaler → facetteret look.
// =====================================================================
import * as THREE from 'three';
import { PLANET, surfaceHeight, groundRadiusAt } from './planetMath.js';

// Paletten matcher museets galleri-æstetik: støvet violet i tre toner.
const COLORS = {
    low:  new THREE.Color('#3b3550'),
    mid:  new THREE.Color('#5a5374'),
    high: new THREE.Color('#8b84ab'),
    rock: new THREE.Color('#6c6584'),
    crystal: new THREE.Color('#5fd3c4'),
};

export function createPlanet() {
    const group = new THREE.Group();

    // --- Selve planeten -------------------------------------------------
    // detail=4 → 5120 trekanter. Nok til at ligne en verden, få nok til
    // at hver facet kan ses.
    let geo = new THREE.IcosahedronGeometry(PLANET.radius, 4).toNonIndexed(); // the number is basically the poly count knob here
    const pos = geo.attributes.position;
    const v = new THREE.Vector3();

    // 1) Displace hver vertex langs sin retning fra centrum.
    //    Dublerede vertices har samme position → samme dir → samme højde,
    //    så der opstår ingen sprækker mellem trekanter.
    for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).normalize();
        v.multiplyScalar(groundRadiusAt(v));
        pos.setXYZ(i, v.x, v.y, v.z);
    }

    // 2) Farv per face ud fra gennemsnitshøjden af facens 3 vertices.
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3();

    for (let i = 0; i < pos.count; i += 3) {
        a.fromBufferAttribute(pos, i);
        b.fromBufferAttribute(pos, i + 1);
        d.fromBufferAttribute(pos, i + 2);
        const avgH = (a.length() + b.length() + d.length()) / 3 - PLANET.radius;

        // t: 0 = dybeste dal, 1 = højeste top
        const t = THREE.MathUtils.clamp(
            (avgH / PLANET.terrainAmp) * 0.5 + 0.5, 0, 1);

        if (t < 0.5) c.copy(COLORS.low).lerp(COLORS.mid, t * 2);
        else         c.copy(COLORS.mid).lerp(COLORS.high, (t - 0.5) * 2);

        // Lidt per-face variation så fladerne ikke er kliniske
        const jitter = (Math.sin(i * 12.9898) * 43758.5453 % 1) * 0.06 - 0.03;
        c.offsetHSL(0, 0, jitter);

        for (let j = 0; j < 3; j++) {
            colors[(i + j) * 3]     = c.r;
            colors[(i + j) * 3 + 1] = c.g;
            colors[(i + j) * 3 + 2] = c.b;
        }
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const planetMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        vertexColors: true,
        flatShading: true,
        roughness: 0.95,
        metalness: 0.0,
    }));
    group.add(planetMesh);

    planetMesh.receiveShadow = true;

    // --- Props: sten og krystaller --------------------------------------
    // Uden ting på overfladen kan man ikke SE at man bevæger sig.
    group.add(scatterRocks(60));
    group.add(scatterCrystals(14));

    return group;
}

/** Ensartet tilfældigt punkt på en kugles overflade. */
function randomDir() {
    const u = Math.random() * 2 - 1;          // cos(phi), uniformt
    const theta = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    return new THREE.Vector3(s * Math.cos(theta), s * Math.sin(theta), u);
}

/** Placér en mesh på overfladen, med +Y langs up og tilfældig drejning. */
function placeOnSurface(mesh, dir, sink = 0.15) {
    mesh.position.copy(dir).multiplyScalar(groundRadiusAt(dir) - sink);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    mesh.rotateY(Math.random() * Math.PI * 2);
}

function scatterRocks(count) {
    const rocks = new THREE.Group();
    const geo = new THREE.IcosahedronGeometry(1, 0); // detail 0 = kantet klump
    const mat = new THREE.MeshStandardMaterial({
        color: COLORS.rock, flatShading: true, roughness: 1,
    });

    for (let i = 0; i < count; i++) {
        const rock = new THREE.Mesh(geo, mat);
        const s = 0.25 + Math.random() * 0.9;
        rock.scale.set(s * (0.7 + Math.random() * 0.6), s, s * (0.7 + Math.random() * 0.6));
        placeOnSurface(rock, randomDir(), 0.2 * s);
        rocks.add(rock);
    }
    rocks.castShadow = true;
    return rocks;
}

function scatterCrystals(count) {
    const crystals = new THREE.Group();
    const geo = new THREE.OctahedronGeometry(0.5, 0);
    const mat = new THREE.MeshStandardMaterial({
        color: COLORS.crystal,
        emissive: COLORS.crystal,
        emissiveIntensity: 0.55,
        flatShading: true,
        roughness: 0.3,
    });

    for (let i = 0; i < count; i++) {
        const crystal = new THREE.Mesh(geo, mat);
        crystal.scale.set(0.6, 1.4 + Math.random() * 1.2, 0.6);
        placeOnSurface(crystal, randomDir(), -0.2); // stikker OP af jorden
        crystal.rotateX((Math.random() - 0.5) * 0.5); // let hældning
        crystals.add(crystal);
    }
    crystals.castShadow = true;
    return crystals;
}
