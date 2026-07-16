import * as THREE from 'three';

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(canvas.clientWidth, canvas.clientHeight);
renderer.setPixelRatio(window.devicePixelRatio);

const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const scene = new THREE.Scene();

const loader = new THREE.TextureLoader();
const starfield = loader.load('/assets/textures/starfield_4k.jpg');

const BH_MASS = 5.0;
const RS      = 2.0 * BH_MASS;

let cameraMode   = 'auto';
let camTheta     = 0.0;
let camPhi       = 0.15;
let camRadius    = RS * 15;
let targetRadius = RS * 15;
const CAM_MIN    = RS * 6.5;
const CAM_MAX    = RS * 18;

const material = new THREE.ShaderMaterial({
    uniforms: {
        uStarfield:  { value: starfield },
        uResolution: { value: new THREE.Vector2(canvas.clientWidth, canvas.clientHeight) },
        uCamPos:     { value: new THREE.Vector3(0, 0, RS * 15) },
        uCamTarget:  { value: new THREE.Vector3(0, 0, 0) },
        uFov:        { value: 50.0 },
        uRs:         { value: RS },
        uBhPos:      { value: new THREE.Vector3(0, 0, 0) },
    },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = vec4(position.xy, 0.0, 1.0);
        }
    `,
    fragmentShader: `
        uniform sampler2D uStarfield;
        uniform vec2  uResolution;
        uniform vec3  uCamPos;
        uniform vec3  uCamTarget;
        uniform float uFov;
        uniform float uRs;
        uniform vec3  uBhPos;
        varying vec2 vUv;

        #define MAX_STEPS   300
        #define ESCAPE_DIST 500.0

        vec2 dirToEquirect(vec3 dir) {
            dir = normalize(dir);
            float u = 0.5 + atan(dir.z, dir.x) / (2.0 * 3.14159265358979);
            float v = 0.5 - asin(clamp(dir.y, -1.0, 1.0)) / 3.14159265358979;
            return vec2(u, v);
        }

        void main() {
            vec3 forward = normalize(uCamTarget - uCamPos);
            vec3 right   = normalize(cross(forward, vec3(0.0, 1.0, 0.0)));
            vec3 up      = cross(right, forward);

            vec2 ndc = vUv * 2.0 - 1.0;
            ndc.x *= uResolution.x / uResolution.y;

            float halfFovTan = tan(radians(uFov * 0.5));
            vec3 rayDir = normalize(
                forward
                + ndc.x * halfFovTan * right
                + ndc.y * halfFovTan * up
            );

            float b      = length(cross(uCamPos - uBhPos, rayDir));
            float b_crit = sqrt(27.0) * uRs * 0.5;

            if (b < b_crit) {
                gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
                return;
            }

            vec3 pos     = uCamPos;
            vec3 vel     = rayDir;
            vec3 bgColor = texture2D(uStarfield, dirToEquirect(vel)).rgb;

            for (int i = 0; i < MAX_STEPS; i++) {
                vec3  toCenter = pos - uBhPos;
                float r        = length(toCenter);

                if (r > ESCAPE_DIST) {
                    bgColor = texture2D(uStarfield, dirToEquirect(vel)).rgb;
                    break;
                }

                if (r > uRs * 6.0 && dot(vel, toCenter) > 0.0) {
                    bgColor = texture2D(uStarfield, dirToEquirect(vel)).rgb;
                    break;
                }

                vec3  h    = cross(toCenter, vel);
                float h2   = dot(h, h);
                float r2   = r * r;
                float r5   = r2 * r2 * r;

                vec3 accel = -1.5 * uRs * h2 / r5 * toCenter;

                // Some jitter to break the circular geometry
                float jitter = 0.95 + 0.1 * fract(
                    sin(dot(rayDir.xy, vec2(12.9898, 78.233))) * 43758.5453
                );
                float step = 0.8 * clamp(r / (uRs * 2.5), 0.5, 5.0) * jitter;

                vel += accel * step;
                pos += vel   * step;
            }

            float deflection    = 1.0 - dot(normalize(vel), normalize(rayDir));
            float magnification = 1.0 + pow(deflection, 2.0) * 1.5;
            bgColor             = min(bgColor * magnification, vec3(1.8));

            gl_FragColor = vec4(bgColor, 1.0);
        }
    `,
    depthWrite: false,
    depthTest:  false,
});

const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
scene.add(quad);

// ── Event Handlers ──
let isDragging = false;
let lastMouseX = 0;
let lastMouseY = 0;
const ROTATE_SPEED = 0.005;

canvas.addEventListener('mousedown', e => {
    if (cameraMode !== 'freelook') return;
    isDragging = true;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    canvas.style.cursor = 'grabbing';
});

canvas.addEventListener('mousemove', e => {
    if (!isDragging) return;
    camTheta -= (e.clientX - lastMouseX) * ROTATE_SPEED;
    camPhi   += (e.clientY - lastMouseY) * ROTATE_SPEED;
    camPhi    = Math.max(-Math.PI * 0.45, Math.min(Math.PI * 0.45, camPhi));
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
});

canvas.addEventListener('mouseup',    () => { isDragging = false; canvas.style.cursor = cameraMode === 'freelook' ? 'grab' : 'default'; });
canvas.addEventListener('mouseleave', () => { isDragging = false; });
canvas.addEventListener('wheel', e => {
    if (cameraMode !== 'freelook') return;
    e.preventDefault();
    targetRadius += e.deltaY * 0.05;
    targetRadius = Math.max(CAM_MIN, Math.min(CAM_MAX, targetRadius));
}, { passive: false });

// ── Camera Movement State machine ──
function setMode(mode) {
    cameraMode = mode;
    document.getElementById('orbitBtn').classList.toggle('active',    mode === 'auto');
    document.getElementById('diveBtn').classList.toggle('active',     mode === 'dive');
    document.getElementById('freelookBtn').classList.toggle('active', mode === 'freelook');
    const labels = { auto: 'Orbiting', dive: 'Diving in', freelook: 'Exploring' };
    document.getElementById('modeLabel').textContent = labels[mode];

    if (mode === 'freelook') {
        targetRadius = CAM_MAX;
        canvas.style.cursor = 'grab';
    } else {
        canvas.style.cursor = 'default';
    }
}

document.getElementById('mathBtn').addEventListener('click',     () => document.getElementById('mathPanel').classList.toggle('hidden'));
document.getElementById('orbitBtn').addEventListener('click',    () => setMode('auto'));
document.getElementById('diveBtn').addEventListener('click',     () => setMode('dive'));
document.getElementById('freelookBtn').addEventListener('click', () => setMode('freelook'));

document.querySelector('.math-close').addEventListener('click', () => {
    document.querySelector('.math-panel').classList.add('hidden');
});

// ── Animate ──
const clock  = new THREE.Clock();
const camPos = new THREE.Vector3();

function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getDelta();

    if (cameraMode === 'auto') {
        camTheta += dt * 0.12;

    } else if (cameraMode === 'dive') {
        camTheta     += dt * 0.25;
        targetRadius -= dt * RS * 0.8;
        targetRadius  = Math.max(CAM_MIN, targetRadius);

        if (targetRadius <= CAM_MIN) {
            cameraMode = 'closeorbit';
            document.getElementById('orbitBtn').classList.remove('active');
            document.getElementById('diveBtn').classList.remove('active');
            document.getElementById('freelookBtn').classList.remove('active');
            document.getElementById('modeLabel').textContent = 'Up close';
            canvas.style.cursor = 'default';
        }

    } else if (cameraMode === 'closeorbit') {
        camTheta += dt * 0.25;
    }

    camRadius += (targetRadius - camRadius) * 0.04;

    camPos.set(
        Math.cos(camPhi) * Math.cos(camTheta) * camRadius,
        Math.sin(camPhi) * camRadius,
        Math.cos(camPhi) * Math.sin(camTheta) * camRadius
    );

    material.uniforms.uCamPos.value.copy(camPos);

    document.getElementById('distReadout').textContent = (camRadius / RS).toFixed(1) + '× Rs';
    document.getElementById('elevReadout').textContent = (camPhi * 180 / Math.PI).toFixed(1) + '°';

    if (!document.getElementById('mathPanel').classList.contains('hidden')) {
        document.getElementById('shadowReadout').textContent  = (Math.sqrt(27) * BH_MASS).toFixed(1);
        document.getElementById('camDistReadout').textContent = (camRadius / RS).toFixed(1);
        document.getElementById('camPhiReadout').textContent  = (camPhi * 180 / Math.PI).toFixed(1);
    }

    renderer.render(scene, orthoCamera);
}

animate();

// ── Resize ──
window.addEventListener('resize', () => {
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    material.uniforms.uResolution.value.set(canvas.clientWidth, canvas.clientHeight);
});

document.querySelectorAll('*').forEach(el => {
    if (el.scrollWidth > document.documentElement.clientWidth) {
        console.log(el.tagName, el.className, el.scrollWidth + 'px');
    }
});