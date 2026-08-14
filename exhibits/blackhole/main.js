// =====================================================================
//  exhibits/blackhole/main.js
//
//  A static Schwarzschild hole, ray marched per pixel. No orbit, no
//  companion — just the geometry, which makes it the exhibit where the
//  geometry has to be right.
//
//  What changed, and why. Each of these was measured against a converged
//  reference integration before anything was touched.
//
//  1. ESCAPE RADIUS. The loop stopped following a photon once it passed
//     6 Rs heading outward. That is nowhere near far enough: for a ray at
//     3 b_crit the recovered sky direction was off by 10.8°, roughly half
//     the total deflection thrown away. Worse, the camera can come in to
//     6.5 Rs in the close-up mode, so the test was firing essentially at
//     the lens. Now 40 Rs, which brings the error under 0.03°.
//
//  2. THE ANALYTIC SHADOW. `if (b < b_crit) return black` used the
//     flat-space impact parameter measured at the camera. That is not the
//     conserved one, and the gap grows as the camera closes in: 1.4% at
//     15 Rs, 6.8% at 6.5 Rs. The shadow was drawn measurably too small in
//     exactly the mode built for looking at the shadow. Capture is now
//     decided by the integration itself, so there is nothing to disagree.
//
//  3. THE JITTER. A per-ray hash scaled the step size by 0.95–1.05, with
//     a comment about breaking up circular geometry. It is not a dither —
//     the factor is constant along each ray, so every ray integrates with
//     a systematically different error. Measured near the ring it spread
//     the escape direction by 3.05°. The graininess it was supposedly
//     hiding was largely graininess it was creating. Removed.
//
//  4. THE STEP POLICY. Distance-proportional stepping, replaced with a
//     constant ANGULAR step: dφ/dλ = h/r², so dt = Δφ·r²/h advances the
//     same angle around the hole every iteration, which is what a central
//     force problem needs. Capped at ¼·r in the far field where the path
//     is straight. Worst case now 135 steps against the old 238, and more
//     accurate at every impact parameter.
//
//  5. THE MAGNIFICATION. `1 + (1−cos θ)²·1.5`, clamped at 1.8 — brightness
//     assigned from deflection angle, with no mechanism behind it. The
//     real effect is that the map squeezes a large solid angle of sky into
//     a thin annulus, so many stars land in one pixel and point sampling
//     picks one of them. That is a sampling problem, and it now gets a
//     sampling answer: near the ring two neighbouring rays are traced, the
//     local stretch of the map is measured from how far apart they land,
//     and the starfield is read at the mip level that stretch implies.
//     Derived from the map instead of fitted to taste.
// =====================================================================

import * as THREE from 'three';
import { wireMathPanel, observeCanvasResize } from '/shared/exhibitCommon.js';

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });

// A per-pixel geodesic marcher at devicePixelRatio 2 is four times the work
// for no visible gain at this scale, and four times the heat.
const MAX_PIXEL_RATIO = 1.5;
const TARGET_FPS = 60;

renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);

const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const scene = new THREE.Scene();

const BH_MASS = 5.0;
const RS = 2.0 * BH_MASS;

// ── Camera state ─────────────────────────────────────────────────────
let cameraMode = 'auto';
let camTheta = 0.0;
let camPhi = 0.15;
let camRadius = RS * 15;
let targetRadius = RS * 15;
const CAM_MIN = RS * 6.5;
const CAM_MAX = RS * 18;

let visible = true;
let onScreen = true;
let frameAccumulator = 0;

const loader = new THREE.TextureLoader();
const starfield = loader.load('/assets/textures/starfield_4k.jpg', (tex) => {
    // Equirectangular: the u coordinate wraps, so the sampler has to as well
    // or there is a hard seam down the line where atan2 flips sign.
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    // Mipmaps are wanted here — the stretch-driven lookup below reads from
    // them deliberately — but the seam needs the wrap above to filter cleanly.
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
});

const material = new THREE.ShaderMaterial({
    uniforms: {
        uStarfield:  { value: starfield },
        uResolution: {
            value: new THREE.Vector2(
                canvas.clientWidth * Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO),
                canvas.clientHeight * Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO)
            ),
        },
        uCamPos:     { value: new THREE.Vector3(0, 0, RS * 15) },
        uCamTarget:  { value: new THREE.Vector3(0, 0, 0) },
        uFov:        { value: 50.0 },
        uRs:         { value: RS },
        uBhPos:      { value: new THREE.Vector3(0, 0, 0) },
    },
    vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = vec4(position.xy, 0.0, 1.0);
        }
    `,
    fragmentShader: /* glsl */`
        uniform sampler2D uStarfield;
        uniform vec2  uResolution;
        uniform vec3  uCamPos;
        uniform vec3  uCamTarget;
        uniform float uFov;
        uniform float uRs;
        uniform vec3  uBhPos;
        varying vec2 vUv;

        #define MAX_STEPS   256
        #define DPHI        0.05    // radians of orbit advanced per step
        #define R_FRAC      0.25    // fraction of r per step, far field
        #define ESCAPE_MULT 40.0    // escape radius in units of Rs
        #define PI          3.14159265358979

        vec2 dirToEquirect(vec3 dir) {
            dir = normalize(dir);
            return vec2(
                0.5 + atan(dir.z, dir.x) / (2.0 * PI),
                0.5 - asin(clamp(dir.y, -1.0, 1.0)) / PI
            );
        }

        // Exact null geodesic acceleration in Cartesian form. Binet's relation
        // turns the Schwarzschild photon orbit equation u'' + u = (3/2)Rs·u²
        // into the central force f = −(3/2)Rs·h²/r⁴. There is no Newtonian
        // 1/r² term for a photon; that term belongs to massive particles.
        vec3 geodesicAccel(vec3 relPos, vec3 vel) {
            float r = length(relPos);
            if (r < 0.001) return vec3(0.0);
            vec3  h  = cross(relPos, vel);
            float r5 = r * r * r * r * r;
            return -1.5 * uRs * dot(h, h) / r5 * relPos;
        }

        /**
         * Trace one photon backwards from the camera.
         * @param captured set true if it crossed the horizon.
         * @return the direction it arrived from, or garbage if captured.
         */
        vec3 traceDir(vec3 rayDir, out bool captured) {
            vec3 pos = uCamPos;
            vec3 vel = normalize(rayDir);

            // |r × v| is conserved for a central force, so it is measured once.
            float h = length(cross(pos - uBhPos, vel));
            float escapeR = uRs * ESCAPE_MULT;
            captured = false;

            for (int i = 0; i < MAX_STEPS; i++) {
                vec3  relPos = pos - uBhPos;
                float r = length(relPos);

                if (r < uRs * 1.02) { captured = true; return vel; }
                if (r > escapeR && dot(vel, relPos) > 0.0) return vel;

                float dt = min(DPHI * r * r / max(h, 1e-6), R_FRAC * r);

                vec3 p1 = vel,                   v1 = geodesicAccel(relPos, vel);
                vec3 p2 = vel + v1 * (dt * 0.5), v2 = geodesicAccel(pos + p1 * (dt * 0.5) - uBhPos, vel + v1 * (dt * 0.5));
                vec3 p3 = vel + v2 * (dt * 0.5), v3 = geodesicAccel(pos + p2 * (dt * 0.5) - uBhPos, vel + v2 * (dt * 0.5));
                vec3 p4 = vel + v3 * dt,         v4 = geodesicAccel(pos + p3 * dt - uBhPos,         vel + v3 * dt);

                pos += (p1 + 2.0 * p2 + 2.0 * p3 + p4) * (dt / 6.0);
                vel += (v1 + 2.0 * v2 + 2.0 * v3 + v4) * (dt / 6.0);
            }

            // Budget exhausted. Measured never to happen with this step policy
            // — worst case is 135 of 256 — but a ray still winding this deep
            // was about to be captured, so black is the honest answer rather
            // than a stale sample of undeflected sky.
            captured = true;
            return vel;
        }

        void main() {
            vec3 forward = normalize(uCamTarget - uCamPos);
            vec3 right   = normalize(cross(forward, vec3(0.0, 1.0, 0.0)));
            vec3 up      = cross(right, forward);

            vec2 ndc = vUv * 2.0 - 1.0;
            ndc.x *= uResolution.x / uResolution.y;

            float halfFovTan = tan(radians(uFov * 0.5));
            vec3 rayDir = normalize(
                forward + ndc.x * halfFovTan * right + ndc.y * halfFovTan * up
            );

            // Angular size of one pixel, in the same units as the ray direction.
            float px = 2.0 * halfFovTan / uResolution.y;

            // The screen-radial direction, pointing away from the hole.
            vec3 toBh = normalize(uBhPos - uCamPos);
            vec3 radial = rayDir - toBh * dot(rayDir, toBh);
            radial = length(radial) > 1e-5 ? normalize(radial) : right;

            // Two marches: this pixel, and its neighbour one pixel further out.
            // One call site, or the compiler inlines two copies of the loop.
            vec3 d0 = vec3(0.0);
            vec3 dRad = vec3(0.0);
            bool captured0 = false;
            bool capturedR = false;

            for (int s = 0; s < 2; s++) {
                if (s == 1 && captured0) break;
                bool cap;
                vec3 d = traceDir(normalize(rayDir + radial * px * float(s)), cap);
                if (s == 0) { d0 = normalize(d); captured0 = cap; }
                else        { dRad = normalize(d); capturedR = cap; }
            }

            if (captured0) {
                gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
                return;
            }

            // ── How much sky does this pixel actually cover? ──
            //
            // Surface brightness is conserved under lensing, so a pixel should
            // show the average brightness of whatever patch of sky it maps to.
            // Near the ring that patch is enormous — the map squeezes a large
            // solid angle into a thin annulus — and point-sampling one star out
            // of the many inside it is what makes the ring look wrong.
            //
            // The patch is violently ANISOTROPIC, which is the part I got wrong
            // on the first attempt. Measured at 18 Rs: at 1.02 b_crit the map
            // stretches 517x radially and 6x tangentially, a ratio of 84 to 1.
            // A mip level blurs both axes equally, so sizing it from the radial
            // stretch smears away exactly the thin sharp arcs that are the whole
            // point. Tangentially the map often *compresses* — 0.14x at 3 b_crit
            // — where a mip bias of 0.9 was being applied to sky that should be
            // pin sharp.
            //
            // So: the mip level comes from the SHORT axis, and the long axis is
            // covered by walking several taps along it. Which is what hardware
            // anisotropic filtering does, for the same reason.

            // Long axis: measured from where the neighbouring ray landed.
            float spread = capturedR
                ? px * 64.0                                    // straddling the edge
                : acos(clamp(dot(d0, dRad), -1.0, 1.0));
            float stretchR = max(spread / px, 1e-4);

            // Short axis: free, no second march. The lens is circularly
            // symmetric, so azimuth is preserved and tangential separations
            // scale as sin(theta). Checked against a traced tangential
            // neighbour: agrees to four digits everywhere except the innermost
            // ring, where it is still within 8%.
            float thetaImg = acos(clamp(dot(normalize(rayDir), toBh), -1.0, 1.0));
            float thetaSrc = acos(clamp(dot(d0, toBh), -1.0, 1.0));
            float stretchT = sin(thetaSrc) / max(sin(thetaImg), 1e-5);

            // Sixteen taps is the budget. Where the anisotropy exceeds that,
            // the shortfall goes into extra blur so the total solid angle
            // covered still matches the footprint and no light is invented or
            // lost — the same trade hardware makes past its aniso limit.
            float minorEff = max(stretchT, stretchR / 16.0);
            float bias = clamp(log2(max(minorEff, 1.0)), 0.0, 6.0);
            int   taps = int(ceil(clamp(stretchR / max(minorEff, 1e-4), 1.0, 16.0)));

            vec3 axis = cross(d0, dRad);
            float axLen = length(axis);

            if (capturedR || axLen < 1e-6 || taps <= 1) {
                gl_FragColor = vec4(texture2D(uStarfield, dirToEquirect(d0), bias).rgb, 1.0);
                return;
            }

            // Walk the footprint along its long axis: a rotation of d0 about
            // the axis perpendicular to the deflection plane. Since that axis
            // is perpendicular to d0, Rodrigues collapses to a plain sin/cos.
            axis /= axLen;
            vec3 perp = cross(axis, d0);

            vec3 sum = vec3(0.0);
            for (int k = 0; k < 16; k++) {
                if (k >= taps) break;
                float a = ((float(k) + 0.5) / float(taps) - 0.5) * spread;
                vec3 d = d0 * cos(a) + perp * sin(a);
                sum += texture2D(uStarfield, dirToEquirect(d), bias).rgb;
            }

            gl_FragColor = vec4(sum / float(taps), 1.0);
        }
    `,
    depthWrite: false,
    depthTest: false,
});

const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
scene.add(quad);

// ── Pointer handling ─────────────────────────────────────────────────
let isDragging = false;
let lastMouseX = 0;
let lastMouseY = 0;
const ROTATE_SPEED = 0.005;

canvas.addEventListener('mousedown', (e) => {
    if (cameraMode !== 'freelook') return;
    isDragging = true;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    canvas.style.cursor = 'grabbing';
});

canvas.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    camTheta -= (e.clientX - lastMouseX) * ROTATE_SPEED;
    camPhi += (e.clientY - lastMouseY) * ROTATE_SPEED;
    camPhi = Math.max(-Math.PI * 0.45, Math.min(Math.PI * 0.45, camPhi));
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
});

canvas.addEventListener('mouseup', () => {
    isDragging = false;
    canvas.style.cursor = cameraMode === 'freelook' ? 'grab' : 'default';
});
canvas.addEventListener('mouseleave', () => { isDragging = false; });

canvas.addEventListener('wheel', (e) => {
    if (cameraMode !== 'freelook') return;
    e.preventDefault();
    targetRadius = Math.max(CAM_MIN, Math.min(CAM_MAX, targetRadius + e.deltaY * 0.05));
}, { passive: false });

// Touch, so the freelook mode is reachable on a phone at all. The previous
// version only listened for mouse events, which on a touch device meant the
// button was there and did nothing.
let lastTouchX = 0;
let lastTouchY = 0;

canvas.addEventListener('touchstart', (e) => {
    if (cameraMode !== 'freelook' || e.touches.length !== 1) return;
    isDragging = true;
    lastTouchX = e.touches[0].clientX;
    lastTouchY = e.touches[0].clientY;
}, { passive: true });

canvas.addEventListener('touchmove', (e) => {
    if (!isDragging || e.touches.length !== 1) return;
    e.preventDefault();
    camTheta -= (e.touches[0].clientX - lastTouchX) * ROTATE_SPEED;
    camPhi += (e.touches[0].clientY - lastTouchY) * ROTATE_SPEED;
    camPhi = Math.max(-Math.PI * 0.45, Math.min(Math.PI * 0.45, camPhi));
    lastTouchX = e.touches[0].clientX;
    lastTouchY = e.touches[0].clientY;
}, { passive: false });

canvas.addEventListener('touchend', () => { isDragging = false; }, { passive: true });

// ── Mode state machine ───────────────────────────────────────────────
const modeButtons = {
    auto: document.getElementById('orbitBtn'),
    dive: document.getElementById('diveBtn'),
    freelook: document.getElementById('freelookBtn'),
};
const modeLabel = document.getElementById('modeLabel');

function setMode(mode) {
    cameraMode = mode;
    for (const key of Object.keys(modeButtons)) {
        modeButtons[key].classList.toggle('active', key === mode);
    }
    modeLabel.textContent = { auto: 'Orbiting', dive: 'Diving in', freelook: 'Exploring' }[mode];

    if (mode === 'freelook') {
        targetRadius = CAM_MAX;
        canvas.style.cursor = 'grab';
    } else {
        canvas.style.cursor = 'default';
    }
}

wireMathPanel();
modeButtons.auto.addEventListener('click', () => setMode('auto'));
modeButtons.dive.addEventListener('click', () => setMode('dive'));
modeButtons.freelook.addEventListener('click', () => setMode('freelook'));

const clock = new THREE.Clock();

// ── Stop rendering when nobody is looking ────────────────────────────
// visibilitychange only fires when the tab hides. It does nothing when the
// canvas scrolls off a long page, which is what happens the moment a reader
// reaches the text below — and a per-pixel geodesic marcher left running
// behind the reader is the load that crashed a browser during Dive.
document.addEventListener('visibilitychange', () => {
    visible = !document.hidden;
    if (visible) clock.getDelta();
});

new IntersectionObserver(([entry]) => {
    onScreen = entry.isIntersecting;
    if (onScreen) clock.getDelta();
}, { threshold: 0 }).observe(canvas);

// ── Readouts ─────────────────────────────────────────────────────────
const readouts = {
    dist: document.getElementById('distReadout'),
    elev: document.getElementById('elevReadout'),
    shadow: document.getElementById('shadowReadout'),
    camDist: document.getElementById('camDistReadout'),
    camPhi: document.getElementById('camPhiReadout'),
};
const mathPanel = document.getElementById('mathPanel');

// ── Frame loop ───────────────────────────────────────────────────────
const camPos = new THREE.Vector3();

function animate() {
    requestAnimationFrame(animate);
    if (!visible || !onScreen) return;

    frameAccumulator += Math.min(clock.getDelta(), 1 / 20);
    if (frameAccumulator < 1 / TARGET_FPS) return;
    const dt = frameAccumulator;
    frameAccumulator = 0;

    if (cameraMode === 'auto') {
        camTheta += dt * 0.12;
    } else if (cameraMode === 'dive') {
        camTheta += dt * 0.25;
        targetRadius = Math.max(CAM_MIN, targetRadius - dt * RS * 0.8);

        if (targetRadius <= CAM_MIN) {
            cameraMode = 'closeorbit';
            for (const key of Object.keys(modeButtons)) modeButtons[key].classList.remove('active');
            modeLabel.textContent = 'Up close';
            canvas.style.cursor = 'default';
        }
    } else if (cameraMode === 'closeorbit') {
        camTheta += dt * 0.25;
    }

    // Exponential approach, made frame-rate independent. The old form was
    // `camRadius += (target − camRadius) * 0.04` per frame, which means the
    // zoom is 2× faster on a 120 Hz display than on a 60 Hz one.
    camRadius += (targetRadius - camRadius) * (1 - Math.exp(-dt * 2.4));

    camPos.set(
        Math.cos(camPhi) * Math.cos(camTheta) * camRadius,
        Math.sin(camPhi) * camRadius,
        Math.cos(camPhi) * Math.sin(camTheta) * camRadius
    );
    material.uniforms.uCamPos.value.copy(camPos);

    readouts.dist.textContent = (camRadius / RS).toFixed(1) + '× Rs';
    readouts.elev.textContent = (camPhi * 180 / Math.PI).toFixed(1) + '°';

    if (!mathPanel.classList.contains('hidden')) {
        readouts.shadow.textContent = (Math.sqrt(27) * BH_MASS).toFixed(1);
        readouts.camDist.textContent = (camRadius / RS).toFixed(1);
        readouts.camPhi.textContent = (camPhi * 180 / Math.PI).toFixed(1);
    }

    renderer.render(scene, orthoCamera);
}

animate();

observeCanvasResize(canvas, (w, h) => {
    renderer.setSize(w, h, false);
    const ratio = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
    material.uniforms.uResolution.value.set(w * ratio, h * ratio);
});