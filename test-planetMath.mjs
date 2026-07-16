// Hurtig sanity-test af planetMath — kør med: node test-planetMath.mjs
import * as THREE from 'three';
import {
    PLANET, surfaceUp, projectOnTangent,
    tangentBasisQuaternion, surfaceHeight, groundRadiusAt,
} from './js/planetMath.js';

let failures = 0;
function assert(name, cond) {
    console.log(`${cond ? '  ✓' : '  ✗ FAIL'}  ${name}`);
    if (!cond) failures++;
}

console.log('planetMath sanity tests\n');

// 1) surfaceUp er altid en enhedsvektor der peger væk fra centrum
const p = new THREE.Vector3(13, -22, 7);
const up = surfaceUp(p);
assert('surfaceUp har længde 1', Math.abs(up.length() - 1) < 1e-9);
assert('surfaceUp er parallel med position', up.dot(p.clone().normalize()) > 0.999999);

// 2) Tangent-projektion: resultatet skal være VINKELRET på up.
//    dot(tangent, up) == 0 er hele pointen med projektionen.
for (let i = 0; i < 100; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(Math.random() * 10);
    const u = new THREE.Vector3().randomDirection();
    const t = projectOnTangent(v, u);
    if (Math.abs(t.dot(u)) > 1e-9) {
        assert(`projectOnTangent ortogonal (iteration ${i})`, false);
        break;
    }
    if (i === 99) assert('projectOnTangent ⊥ up i 100 tilfældige tilfælde', true);
}

// 3) Basis-quaternion: skal give et ortonormalt koordinatsystem
//    hvor lokal +Y lander på up.
const fwd = new THREE.Vector3(0.3, 0.8, -0.2);
const q = tangentBasisQuaternion(up, fwd);
const localY = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
const localZ = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
assert('quaternion mapper +Y → up', localY.distanceTo(up) < 1e-6);
assert('quaternion holder forward i tangentplanet', Math.abs(localZ.dot(up)) < 1e-6);

// 4) Determinisme: samme retning → samme terrænhøjde, hver gang.
//    (Det er kontrakten mellem mesh og collision.)
const dir = new THREE.Vector3(0.5, 0.6, -0.62).normalize();
assert('surfaceHeight er deterministisk',
    surfaceHeight(dir) === surfaceHeight(dir.clone()));

// 5) Terrænet holder sig inden for den lovede amplitude
let min = Infinity, max = -Infinity;
for (let i = 0; i < 5000; i++) {
    const d = new THREE.Vector3().randomDirection();
    const h = surfaceHeight(d);
    min = Math.min(min, h);
    max = Math.max(max, h);
}
assert(`terræn i [-amp, +amp] (målt: ${min.toFixed(2)} .. ${max.toFixed(2)})`,
    min >= -PLANET.terrainAmp && max <= PLANET.terrainAmp);
assert('terrænet varierer faktisk (ikke fladt)', max - min > 0.5);

// 6) groundRadiusAt ≈ radius ± amp
const gr = groundRadiusAt(dir);
assert('groundRadiusAt i fornuftigt interval',
    gr > PLANET.radius - PLANET.terrainAmp - 1e-9 &&
    gr < PLANET.radius + PLANET.terrainAmp + 1e-9);

console.log(failures === 0 ? '\nAlle tests grønne 🚀' : `\n${failures} test(s) fejlede`);
process.exit(failures === 0 ? 0 : 1);
