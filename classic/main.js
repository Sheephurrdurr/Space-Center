import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

// ── Scene setup ──
const canvas = document.getElementById('starfield');
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();

// Camera is orthographic, cuz we dont want no perspective distortion
const camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    2000
);
camera.position.z = 1;

// ── Nebula baggrund ──────────────────────────────────────────
// En fuld-skærms quad med en fBm-shader.
// Den ligger "foran" kameraet men bag alt andet via renderOrder.

const nebulaGeo = new THREE.PlaneGeometry(2, 2);
const nebulaMat = new THREE.ShaderMaterial({
    uniforms: {
        uTime:       { value: 0 },
        uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
    },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            // Placer quad'en direkte foran kameraet uanset kamerabevægelse
            gl_Position = vec4(position.xy, 1.0, 1.0);
        }
    `,
    fragmentShader: `
        uniform float uTime;
        uniform vec2  uResolution;
        varying vec2  vUv;

        // ── Hash-funktion ─────────────────────────────────────────────
        // Tag en 2D-koordinat, returner et pseudo-tilfældigt tal (0-1).
        // Dette er IKKE kryptografisk tilfældigt — det er bare en funktion
        // der ser tilfældig ud for øjet. sin() + store tal = kaotisk output.
        float hash(vec2 p) {
            p = fract(p * vec2(234.34, 435.345));
            p += dot(p, p + 34.23);
            return fract(p.x * p.y);
        }

        // ── Value noise ───────────────────────────────────────────────
        // Tag en kontinuert 2D-position, returner et glat tal (0-1).
        // Princippet: del koordinaten op i en "celle" (floor) og en
        // "position inden i cellen" (fract). Sample hash i cellens
        // hjørner og interpoler glat imellem dem.
        float noise(vec2 p) {
            vec2 i = floor(p);   // celle-koordinat (heltal)
            vec2 f = fract(p);   // position inden i celle (0-1)

            // smoothstep på f → kubisk interpolation i stedet for lineær
            // Lineær: synlige "kanter" mellem celler
            // Kubisk: helt glat overgang
            vec2 u = f * f * (3.0 - 2.0 * f);   // smoothstep

            // Sample tilfældig værdi i cellens 4 hjørner
            float a = hash(i);
            float b = hash(i + vec2(1.0, 0.0));
            float c = hash(i + vec2(0.0, 1.0));
            float d = hash(i + vec2(1.0, 1.0));

            // Bilineær interpolation med smooth weights
            return mix(
                mix(a, b, u.x),
                mix(c, d, u.x),
                u.y
            );
        }

        // ── Fractional Brownian Motion ────────────────────────────────
        // Læg 5 lag noise ovenpå hinanden.
        // Hvert lag: dobbelt frekvens (octave×2), halvt bidrag (amp×0.5)
        // Resultat: organiske former med finere og finere detaljer
        float fbm(vec2 p) {
            float value = 0.0;
            float amplitude = 0.5;    // starter med halvt bidrag
            float frequency = 1.0;

            for (int i = 0; i < 5; i++) {
                value     += amplitude * noise(p * frequency);
                frequency *= 2.0;     // dobbelt frekvens næste lag
                amplitude *= 0.5;     // halvt bidrag næste lag
            }
            return value;
        }

        void main() {
            // Aspect-korrigerede UV-koordinater
            vec2 uv = vUv;
            uv.x *= uResolution.x / uResolution.y;

            // Meget langsom bevægelse — nebula'en "driver" umærkeligt
            float t = uTime * 0.008;

            // To lag fBm forskudt fra hinanden → mere organisk end ét lag
            float n1 = fbm(uv * 1.8 + vec2(t * 0.3, t * 0.2));
            float n2 = fbm(uv * 2.4 + vec2(-t * 0.15, t * 0.25) + n1 * 0.4);
            // n1 bruges til at forskyde n2's koordinater — det kaldes
            // "domain warping" og er grunden til at nebula-former ser
            // organiske ud i stedet for bare bløde cirkler

            float n = fbm(uv * 1.2 + n1 * 0.5 + n2 * 0.3);

            // ── Farvepalette ──────────────────────────────────────────
            // Tre ankerpunkter — blandes baseret på noise-værdien
            vec3 deepSpace  = vec3(0.024, 0.031, 0.059);  // #060810
            vec3 purpleNeb  = vec3(0.12,  0.04,  0.22);   // dybt lilla
            vec3 blueNeb    = vec3(0.03,  0.07,  0.20);   // kold blå

            // mix() er lineær interpolation: mix(a, b, t) = a*(1-t) + b*t
            vec3 color = mix(deepSpace, purpleNeb, smoothstep(0.4, 0.7, n));
            color      = mix(color,     blueNeb,   smoothstep(0.6, 0.9, n) * 0.5);

            // Gradient der fader til sort i midten og langs kanter
            // så den ikke overdøver exhibit-kortene
            float vignette = 1.0 - smoothstep(0.3, 1.4, length(vUv - 0.5) * 2.0);

            // Lav samlet opacity — subtil, ikke dominerende
            float alpha = smoothstep(0.38, 0.65, n) * 0.55 * vignette;

            gl_FragColor = vec4(color, alpha);
        }
    `,
    transparent: true,
    depthWrite: false,
    depthTest:  false,
});

const nebula = new THREE.Mesh(nebulaGeo, nebulaMat);
nebula.renderOrder = -1;   // render FØR stjernerne
scene.add(nebula);

// ── Particle geometry ──
// BufferGeometry sends raw data to the GPU via THREE.js
// Build Float32Array with x,y,z for each star
const STAR_COUNT = 12000;
const positions = new Float32Array(STAR_COUNT * 3);
const sizes     = new Float32Array(STAR_COUNT);     // star size

for (let i = 0; i < STAR_COUNT; i++) {
    // Spread out the stars across a sphere, around the camera
    // using rejection method for uniform spherical distribution
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.acos(2 * Math.random() - 1);
    const r     = 800 + Math.random() * 200;   // radius — far behind anything else

    positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);  // x
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);  // y
    positions[i * 3 + 2] = r * Math.cos(phi);                     // z

    // star sizes vary
    sizes[i] = Math.random() < 0.02
        ? Math.random() * 2.5 + 1.5    // 2% are "bright" stars
        : Math.random() * 0.8 + 0.2;   // rest are just dots
}

const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
geometry.setAttribute('size',     new THREE.BufferAttribute(sizes,     1));

// ── Custom shader material ──
const starMaterial = new THREE.ShaderMaterial({
    uniforms: {
        uTime: { value: 0 }
    },
    vertexShader: `
        attribute float size;
        varying float vSize;

        void main() {
            vSize = size;
            vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);

            // gl_PointSize sets the size in pixels for a particle
            gl_PointSize = size * (300.0 / -mvPosition.z);
            gl_Position  = projectionMatrix * mvPosition;
        }
    `,
    fragmentShader: `
        varying float vSize;

        void main() {
            // gl_PointCoord is the UV-coordinate inside a particle (0-1)
            // Creates a neat circle
            vec2 center = gl_PointCoord - 0.5;
            float dist  = length(center);

            if (dist > 0.5) discard;   // screw anything outside the circle

            // smooth af edge
            float alpha = 1.0 - smoothstep(0.1, 0.5, dist);

            // Nerdy subtle color variation, according to size
            // Big Stars: Yellow'ish
            // Small: Little more blue
            vec3 warmColor = vec3(1.0,  0.97, 0.88);
            vec3 coldColor = vec3(0.88, 0.93, 1.0);
            vec3 color = mix(coldColor, warmColor, clamp(vSize / 3.0, 0.0, 1.0));

            gl_FragColor = vec4(color, alpha * 0.35);
        }
    `,
    transparent: true,
    depthWrite:  false,   // particle doesnt write to depthBuffer
    blending:    THREE.AdditiveBlending,  // brighter overlap = more glow
});

const starField = new THREE.Points(geometry, starMaterial);
scene.add(starField);

// ── Meget langsom rotation ──
// Throwing in some subtle movement to give a more "I'm in space" vibe
const clock = new THREE.Clock();

function animate() {
    requestAnimationFrame(animate);
    const t = clock.getElapsedTime();

    // Rotate slowly around y axis
    starField.rotation.y = t * 0.003;
    starField.rotation.x = Math.sin(t * 0.0001) * 0.02;  // kind of a breath'y effect
    nebulaMat.uniforms.uTime.value       = t;
    nebulaMat.uniforms.uResolution.value.set(window.innerWidth, window.innerHeight);
    starMaterial.uniforms.uTime.value = t;

    renderer.render(scene, camera);
}
animate();

// ── Resize ──
window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    nebulaMat.uniforms.uResolution.value.set(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
});