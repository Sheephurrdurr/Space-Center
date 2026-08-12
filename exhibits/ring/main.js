// =====================================================================
//  exhibits/ring/main.js
//
//  Drives the room. Three jobs:
//    1. Move a visitor around on a floor, in Kerr-Schild coordinates.
//    2. Build the static observer's tetrad at wherever they are standing
//       and hand it to the shader.
//    3. Refuse to put them somewhere no static observer can exist.
//
//  (3) is the only unusual one. In Dive the camera was falling and every
//  position along the trajectory was reachable by construction. Here the
//  visitor chooses, and part of the room is not a place a standing
//  person can be — not because a wall is in the way, but because inside
//  the ergosphere frame dragging is strong enough that "standing still"
//  is not a state the spacetime has. The walk limit is solved from the
//  metric, not authored.
// =====================================================================

import * as THREE from 'three';
import { createRingMaterial } from './RingShader.js';
import {
    A, SPIN, SCENE, UNIT_M, MASS_JUPITER,
    ksR, frameDrag, ergoRadius, buildStaticTetrad, checkTetrad, rightVector,
} from './RingGeodesic.js';

const SKY_URL = '/assets/textures/church_stairway_4k.jpg';

// ── Renderer ────────────────────────────────────────────────────────
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const gl = renderer.getContext();
{
    // Same check Dive makes, same reason: D = r⁴ + a²z² overruns mediump
    // and the failure is NaN, not a slightly worse picture.
    const hp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    if (!hp || hp.precision < 23) {
        showNotice('This device reports no high-precision float in fragment shaders. '
                 + 'The image will be wrong rather than merely slower.', 'warn');
    }
}

const scene3 = new THREE.Scene();
const camera3 = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

// ── Sky ─────────────────────────────────────────────────────────────
// 4096×2048: both powers of two, so unlike Dive's 6000×3000 starfield
// this needs no explicit mipmap generation. Worth stating, because that
// bug cost an afternoon last time and the reason it is absent here is
// the texture's dimensions rather than anything the code does.
const skyTex = new THREE.TextureLoader().load(
    SKY_URL,
    tex => {
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = true;
        tex.needsUpdate = true;
    },
    undefined,
    () => showNotice('The sky texture failed to load. The view through the ring '
                   + 'will be flat white — everything else is unaffected.', 'warn'),
);
skyTex.colorSpace = THREE.SRGBColorSpace;

// ── Material ────────────────────────────────────────────────────────
const mat = createRingMaterial({
    sky: skyTex,
    resolution: { x: canvas.clientWidth || 1280, y: canvas.clientHeight || 720 },
    scene: SCENE,
    spin: SPIN,
    unitM: UNIT_M,
});
scene3.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));

// ── Visitor state ───────────────────────────────────────────────────
// Position is Kerr-Schild (x, y, z) with the spin axis along z, so the
// ring lies in the z = 0 plane and "up" is +z. There is no conversion
// layer: the room is authored in the same coordinates the physics uses.
const eyeZ = SCENE.FLOOR_Z + SCENE.EYE;
const state = {
    pos: new THREE.Vector3(3.0 / UNIT_M, 0, eyeZ),   // 3 m out, facing in
    yaw: Math.PI,      // looking back towards the axis
    pitch: -0.05,
    speed: 1.6 / UNIT_M,   // 1.6 m/s, a slow walk
};

// ── The walk limit ──────────────────────────────────────────────────
// Two candidates, and which one binds depends on the ring's size.
//
//   ERGO   — the ergosphere at eye height. fMax = 0.92 rather than 1.0
//            leaves margin: at f = 1 the tetrad's 1/√(1−f) is singular
//            and the last centimetres before it produce an image
//            dominated by a diverging normalisation, not by geometry.
//   ALTAR  — the pedestal plus a shoulder's clearance. Furniture.
//
// At a 2 m ring the ergosphere wins and the boundary is physics: inside
// it, standing still is not a state the spacetime has. At the 6 cm ring
// this exhibit ships, the ergoregion is a ~5 cm bubble hugging the ring
// plane, far below a standing eye, and the altar wins. Both are computed
// and the larger is used, so the honest answer survives a change of
// scale instead of a comment going stale.
const ERGO_MIN  = ergoRadius(eyeZ, 0.92);
const ALTAR_MIN = SCENE.PED_R + 0.35 / UNIT_M;
const WALK_MIN  = Math.max(ERGO_MIN, ALTAR_MIN);
const ERGO_BINDS = ERGO_MIN > ALTAR_MIN;

console.info(
    `[ring] a/M = ${SPIN}, ring radius ${(A * UNIT_M).toFixed(3)} m, `
  + `M = ${MASS_JUPITER.toFixed(4)} Jupiter masses\n`
  + `[ring] ergosphere at eye height: `
  + (ERGO_MIN > 0 ? `${(ERGO_MIN * UNIT_M).toFixed(3)} m` : 'does not reach eye height')
  + `\n[ring] walk limit rho = ${(WALK_MIN * UNIT_M).toFixed(2)} m `
  + `(${ERGO_BINDS ? 'ergosphere' : 'altar'} is binding); `
  + `closest approach to the ring ${((WALK_MIN - A) * UNIT_M).toFixed(2)} m`
);

// ── Input ───────────────────────────────────────────────────────────
const keys = new Set();
const on = (t, e, f, o) => t.addEventListener(e, f, o);

on(window, 'keydown', e => {
    if (['w', 'a', 's', 'd', 'shift', ' '].includes(e.key.toLowerCase())) e.preventDefault();
    keys.add(e.key.toLowerCase());
});
on(window, 'keyup', e => keys.delete(e.key.toLowerCase()));

let dragging = false, lastX = 0, lastY = 0;
on(canvas, 'pointerdown', e => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
});
on(canvas, 'pointerup', e => {
    dragging = false;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
});
on(canvas, 'pointermove', e => {
    if (!dragging) return;
    state.yaw   -= (e.clientX - lastX) * 0.004;
    state.pitch -= (e.clientY - lastY) * 0.004;
    state.pitch = Math.max(-1.4, Math.min(1.4, state.pitch));
    lastX = e.clientX; lastY = e.clientY;
});

// ── Movement ────────────────────────────────────────────────────────
/**
 * Walk on the floor plane. The vertical coordinate never changes: this
 * is a room, and the visitor has feet.
 *
 * Both limits are clamps on ρ rather than on x and y separately, because
 * both boundaries are circles: the wall, and the ergosphere.
 */
function move(dt) {
    const fwd = [Math.cos(state.yaw), Math.sin(state.yaw), 0];

    // Same definition the tetrad uses. This used to be written out
    // locally as (−sin, cos), which is fwd × up with the sign flipped —
    // so A and D were swapped while the image stayed correct, because
    // the shader takes its right-hand direction from the tetrad and the
    // walking code took it from here.
    const right = rightVector(fwd, [0, 0, 1]);

    let mx = 0, my = 0;
    const run = keys.has('shift') ? 2.2 : 1.0;
    if (keys.has('w')) { mx += fwd[0]; my += fwd[1]; }
    if (keys.has('s')) { mx -= fwd[0]; my -= fwd[1]; }
    if (keys.has('d')) { mx += right[0]; my += right[1]; }
    if (keys.has('a')) { mx -= right[0]; my -= right[1]; }

    const len = Math.hypot(mx, my);
    if (len < 1e-6) return false;

    const step = state.speed * run * dt;
    let nx = state.pos.x + (mx / len) * step;
    let ny = state.pos.y + (my / len) * step;

    const rho = Math.hypot(nx, ny);
    let blocked = false;

    if (rho < WALK_MIN) {
        // Slide along the boundary rather than stopping dead — walking
        // into it should feel like a surface, not like a bug.
        const s = WALK_MIN / Math.max(rho, 1e-9);
        nx *= s; ny *= s; blocked = true;
    } else if (rho > SCENE.WALK_MAX) {
        const s = SCENE.WALK_MAX / rho;
        nx *= s; ny *= s;
    }

    state.pos.x = nx; state.pos.y = ny;
    return blocked;
}

// ── UI ──────────────────────────────────────────────────────────────
const el = id => document.getElementById(id);
function showNotice(msg, kind = 'info') {
    const n = el('notice');
    if (!n) return;
    n.textContent = msg;
    n.className = `notice ${kind}`;
    n.hidden = false;
}

let uiAccum = 0;
function updateReadouts(f, blocked) {
    const rho = Math.hypot(state.pos.x, state.pos.y);
    const toRing = Math.hypot(rho - A, state.pos.z) * UNIT_M;

    const set = (id, v) => { const n = el(id); if (n) n.textContent = v; };
    set('fReadout', f.toFixed(3));
    set('ringReadout', `${toRing.toFixed(2)} m`);
    set('rhoReadout', `${(rho * UNIT_M).toFixed(2)} m`);
    set('utReadout', (1 / Math.sqrt(Math.max(1 - f, 1e-9))).toFixed(3));

    const warn = el('ergoWarn');
    if (warn) {
        // Say the true reason. Claiming the ergosphere stopped you when
        // in fact the altar did would be the exact kind of asserted
        // physics this project keeps deleting.
        if (blocked && !warn.dataset.set) {
            warn.textContent = ERGO_BINDS
                ? 'You cannot go closer. Inside this radius there is no such thing as standing still.'
                : 'The altar is in the way. The ergosphere is smaller than the plinth it sits on.';
            warn.dataset.set = '1';
        }
        warn.hidden = !blocked;
    }
}

// ── Resize ──────────────────────────────────────────────────────────
function resize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    mat.uniforms.uResolution.value.set(w * renderer.getPixelRatio(),
                                       h * renderer.getPixelRatio());
}
on(window, 'resize', resize);
resize();

// ── Startup check ───────────────────────────────────────────────────
// The tetrad is verified once, out loud, for the same reason Dive checks
// it: a nearly-orthonormal tetrad gives a nearly-right image, and that
// is the class of error that survives weeks of looking at it.
{
    const t0 = buildStaticTetrad(
        [state.pos.x, state.pos.y, state.pos.z], [-1, 0, 0], [0, 0, 1]);
    if (t0) {
        const res = checkTetrad([state.pos.x, state.pos.y, state.pos.z], t0);
        const worst = Math.max(...Object.values(res).map(Math.abs));
        console.info(`[ring] tetrad residual (worst of 8): ${worst.toExponential(2)}`);
        if (worst > 1e-8) console.warn('[ring] tetrad is not orthonormal — image will be subtly wrong');
    }
}

// ── Loop ────────────────────────────────────────────────────────────
const clock = new THREE.Clock();
let contextLost = false;

on(canvas, 'webglcontextlost', e => {
    e.preventDefault();
    contextLost = true;
    showNotice('Graphics context lost — waiting for the driver to restore it.', 'warn');
});
on(canvas, 'webglcontextrestored', () => {
    contextLost = false;
    const n = el('notice'); if (n) n.hidden = true;
    resize();
});

function frame() {
    requestAnimationFrame(frame);
    if (contextLost) { clock.getDelta(); return; }

    const dt = Math.min(clock.getDelta(), 0.05);
    const blocked = move(dt);

    const pos = [state.pos.x, state.pos.y, state.pos.z];
    const cp = Math.cos(state.pitch), sp = Math.sin(state.pitch);
    const fwd = [Math.cos(state.yaw) * cp, Math.sin(state.yaw) * cp, sp];

    const tet = buildStaticTetrad(pos, fwd, [0, 0, 1]);
    if (!tet) {
        // Should be unreachable — the walk limit is solved from the same
        // metric. If it ever happens, say so rather than rendering
        // whatever a divide by zero produces.
        showNotice('No static observer exists at this position. '
                 + 'This should not be reachable; please report it.', 'warn');
        return;
    }

    const u = mat.uniforms;
    u.uCamPos.value.set(pos[0], pos[1], pos[2]);
    u.uE0.value.set(tet.e0[1], tet.e0[2], tet.e0[3], tet.e0[0]);
    u.uE1.value.set(tet.e1[1], tet.e1[2], tet.e1[3], tet.e1[0]);
    u.uE2.value.set(tet.e2[1], tet.e2[2], tet.e2[3], tet.e2[0]);
    u.uE3.value.set(tet.e3[1], tet.e3[2], tet.e3[3], tet.e3[0]);
    u.uFobs.value = tet.f;
    u.uTime.value = clock.elapsedTime;

    uiAccum += dt;
    if (uiAccum > 0.1) { updateReadouts(tet.f, blocked); uiAccum = 0; }

    renderer.render(scene3, camera3);
}
frame();

// Console handle, same convention as Dive.
window.ringMat = mat;
window.ringState = state;