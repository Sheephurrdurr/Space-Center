// =====================================================================
// Planetens geometri og fysik.
//
// Både planet-meshen (planet.js) og spilleren (player.js) bruger de
// samme funktioner her. 
// =====================================================================
import * as THREE from 'three';

export const PLANET = {
    radius: 30,        // "havniveau" i meter
    gravity: 16,       // m/s² mod centrum. Low gravity cuz tiny planet
    walkSpeed: 6,
    sprintFactor: 1.7,
    jumpSpeed: 8,

    // Terræn-noise (bruges af BÅDE mesh og collision)
    terrainAmp: 1.1,   // max højdeforskel over/under radius
    terrainFreq: 2.6,  // hvor "store" kontinenterne er
};

// ---------------------------------------------------------------------
// Retninger og projektioner
// ---------------------------------------------------------------------

/** "Op" på en planet = væk fra centrum. Så simpelt er det. */
export function surfaceUp(position, target = new THREE.Vector3()) {
    return target.copy(position).normalize();
}

/**
 * Projicér en vektor ned i tangentplanet (fjern komponenten langs up).
 *   v_tangent = v - up * (v · up)
 */
export function projectOnTangent(vec, up, target = new THREE.Vector3()) {
    return target.copy(vec).addScaledVector(up, -vec.dot(up));
}

const _right = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _m = new THREE.Matrix4();

/**
 * Byg en rotation hvor objektets +Y peger langs `up` og +Z langs
 * `forward` (projiceret i tangentplanet). Three.js er højrehåndet,
 * så right = up × forward giver X = Y × Z.
 */
export function tangentBasisQuaternion(up, forward, target = new THREE.Quaternion()) {
    projectOnTangent(forward, up, _fwd).normalize();
    _right.crossVectors(up, _fwd).normalize();
    _m.makeBasis(_right, up, _fwd);
    return target.setFromRotationMatrix(_m);
}

// ---------------------------------------------------------------------
// Terræn: deterministisk 3D value noise + fBm
// ---------------------------------------------------------------------

function hash3(x, y, z) {
    const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453123;
    return n - Math.floor(n); // fract()
}

function smooth(t) {
    return t * t * (3 - 2 * t); // smoothstep giver blødere interpolation end lineær
}

/** Trilineært interpoleret value noise, output ca. [0,1]. */
function valueNoise(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = smooth(x - xi), yf = smooth(y - yi), zf = smooth(z - zi);

    // 8 hjørner af gitter-cellen
    const c000 = hash3(xi, yi, zi),     c100 = hash3(xi + 1, yi, zi);
    const c010 = hash3(xi, yi + 1, zi), c110 = hash3(xi + 1, yi + 1, zi);
    const c001 = hash3(xi, yi, zi + 1), c101 = hash3(xi + 1, yi, zi + 1);
    const c011 = hash3(xi, yi + 1, zi + 1), c111 = hash3(xi + 1, yi + 1, zi + 1);

    const x00 = c000 + (c100 - c000) * xf;
    const x10 = c010 + (c110 - c010) * xf;
    const x01 = c001 + (c101 - c001) * xf;
    const x11 = c011 + (c111 - c011) * xf;

    const y0 = x00 + (x10 - x00) * yf;
    const y1 = x01 + (x11 - x01) * yf;

    return y0 + (y1 - y0) * zf;
}

/** Fractal Brownian motion (fBm) = læg oktaver af noise ovenpå hinanden. */
function fbm(x, y, z, octaves = 4) {
    let sum = 0, amp = 0.5, freq = 1, norm = 0;
    for (let i = 0; i < octaves; i++) {
        sum += valueNoise(x * freq + i * 17.3, y * freq, z * freq) * amp;
        norm += amp;
        amp *= 0.5;
        freq *= 2.1;
    }
    return sum / norm; // ~[0,1]
}

/**
 * Terrænhøjde (afvigelse fra radius) i en given retning fra centrum.
 * `dir` SKAL være normaliseret.
 */
export function surfaceHeight(dir) {
    const f = PLANET.terrainFreq;
    const n = fbm(dir.x * f, dir.y * f, dir.z * f); // [0,1]
    return (n - 0.5) * 2 * PLANET.terrainAmp;       // [-amp, +amp]
}

/** Afstand fra centrum til jordoverfladen i retning `dir`. */
export function groundRadiusAt(dir) {
    return PLANET.radius + surfaceHeight(dir);
}
