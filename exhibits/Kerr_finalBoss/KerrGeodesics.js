import * as THREE from 'three';

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(canvas.clientWidth, canvas.clientHeight);
// This amount of computation is kinda unhinged, so if it's too bad turn it down to 1 (from 2).
const coarse = window.matchMedia('(pointer: coarse)').matches;
renderer.setPixelRatio(coarse ? 0.75 : Math.min(window.devicePixelRatio, 2));

const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const scene = new THREE.Scene();

const loader = new THREE.TextureLoader();
const starfield = loader.load('/assets/textures/starfield_4k.jpg');

const BH_MASS = 5.0;
const RS      = 2.0 * BH_MASS;

let spin = 0.85;

// ISCO er den inderste stabile kredsbane (Bardeen, Press & Teukolsky 1972).
// Spin 0 -> 6M (= 3 Rs). Spin 1 -> 1M. Skivens inderkant foelger den.
function iscoRadius(a) {
    const M  = RS / 2;
    const Z1 = 1 + Math.cbrt(1 - a * a) * (Math.cbrt(1 + a) + Math.cbrt(1 - a));
    const Z2 = Math.sqrt(3 * a * a + Z1 * Z1);
    return M * (3 + Z2 - Math.sqrt(Math.max((3 - Z1) * (3 + Z1 + 2 * Z2), 0)));
}

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
        uSpin:       { value: spin },
        uTime:       { value: 0.0 },
        uDiskIn:     { value: iscoRadius(spin) },
        uDiskOut:    { value: RS * 5.5 },
        uBackground: { value: 0.0 },
        uColdness:   { value: 0.0 },
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
        uniform float uSpin;
        uniform float uTime;
        uniform float uDiskIn;
        uniform float uDiskOut;
        uniform float uBackground;
        uniform float uColdness;
        uniform vec3  uBhPos;
        varying vec2 vUv;

        #define MAX_STEPS   400
        #define ESCAPE_DIST 400.0

        vec2 dirToEquirect(vec3 dir) {
            dir = normalize(dir);
            float u = 0.5 + atan(dir.z, dir.x) / (2.0 * 3.14159265358979);
            float v = 0.5 - asin(clamp(dir.y, -1.0, 1.0)) / 3.14159265358979;
            return vec2(u, v);
        }

        // ── Baggrund: stjernehimmel eller debug-grid ───────────────
        // Grid'et er lensing-fysikerens proevebillede: naar man
        // kender moensteret, kan man SE praecis hvor meget hver del
        // af himlen er blevet flyttet, straekt og foldet.
        vec3 skyColor(vec3 dir) {
            vec2 uv = dirToEquirect(dir);
            if (uBackground < 0.5) {
                return texture2D(uStarfield, uv).rgb;
            }
            // Skaktern + farve efter laengdegrad, saa man kan se
            // hvilken del af himlen hver pixel er hentet fra
            float cells = mod(floor(uv.x * 24.0) + floor(uv.y * 12.0), 2.0);
            vec3  hue   = 0.5 + 0.5 * cos(6.28318 * (uv.x + vec3(0.0, 0.33, 0.67)));
            vec3  base  = mix(hue * 0.22, hue * 0.9, cells);
            // hvid aekvatorlinje som reference
            float eq = smoothstep(0.010, 0.0, abs(uv.y - 0.5));
            return base + vec3(eq * 0.8);
        }

        // ── Koordinatskift ─────────────────────────────────────────
        // Verden har y opad; Kerr-Schild-formlerne har spin om z.
        // Ren rotation (90° om x-aksen), så håndetheden bevares.
        vec3 toKS(vec3 v)   { return vec3(v.x, -v.z,  v.y); }
        vec3 fromKS(vec3 v) { return vec3(v.x,  v.z, -v.y); }

        // ── Kerr-Schild r ──────────────────────────────────────────
        // OBS: r er IKKE length(x)! I Kerr-Schild-koordinater er r
        // defineret implicit af metrikken — flader af konstant r er
        // fladtrykte ellipsoider, ikke kugler. Løses som en
        // andengradsligning i r².
        float ksR(vec3 x, float a) {
            float rho2 = dot(x, x);
            float b    = rho2 - a * a;
            float r2   = 0.5 * (b + sqrt(b * b + 4.0 * a * a * x.z * x.z));
            return sqrt(max(r2, 1e-6));
        }

        // ── Metrikken ──────────────────────────────────────────────
        // Kerr-Schild: g = eta + f * (l kryds l).
        // Hele Kerr-geometrien er kogt ned til ét tal f(x) og
        // én vektor l(x). Det her er "opslaget": hvor krum er
        // rumtiden lige her?
        struct Metric {
            float f;
            vec3  l;
        };

        Metric metricAt(vec3 x) {
            float M  = 0.5 * uRs;
            float a  = uSpin * M;
            float r  = ksR(x, a);
            float r2 = r * r;

            Metric m;
            m.f = 2.0 * M * r2 * r / (r2 * r2 + a * a * x.z * x.z);
            m.l = vec3(
                (r * x.x + a * x.y) / (r2 + a * a),
                (r * x.y - a * x.x) / (r2 + a * a),
                x.z / r
            );
            return m;
        }

        // ── Hamiltonfunktionen ─────────────────────────────────────
        // H = 1/2 * g^{mu nu} p_mu p_nu. For lys er H = 0 altid.
        // pt er tids-komponenten af momentum — konstant, fordi
        // metrikken ikke afhænger af tid (energibevarelse!).
        float hamiltonian(vec3 x, vec3 p, float pt) {
            Metric m = metricAt(x);
            float  S = dot(m.l, p) - pt;
            return 0.5 * (-pt * pt + dot(p, p) - m.f * S * S);
        }

        // dx/dlambda = dH/dp — analytisk (nem at differentiere i p)
        vec3 dxdl(vec3 x, vec3 p, float pt) {
            Metric m = metricAt(x);
            float  S = dot(m.l, p) - pt;
            return p - m.f * S * m.l;
        }

        // dp/dlambda = -dH/dx — numerisk central differens.
        // Bogstaveligt talt: mål H i to nabopunkter, tag hældningen.
        vec3 dpdl(vec3 x, vec3 p, float pt) {
            const float eps = 0.01;
            vec3 g;
            g.x = hamiltonian(x + vec3(eps, 0.0, 0.0), p, pt)
                - hamiltonian(x - vec3(eps, 0.0, 0.0), p, pt);
            g.y = hamiltonian(x + vec3(0.0, eps, 0.0), p, pt)
                - hamiltonian(x - vec3(0.0, eps, 0.0), p, pt);
            g.z = hamiltonian(x + vec3(0.0, 0.0, eps), p, pt)
                - hamiltonian(x - vec3(0.0, 0.0, eps), p, pt);
            return -g / (2.0 * eps);
        }

        // ── Samlet afledning af tilstanden (x, p) ──────────────────
        // RK4 skal kunne sposrge "hvor peger systemet hen?" ved
        // vilkaarlige proevepunkter, saa vi pakker begge afledte
        // sammen i en struct.
        struct Deriv {
            vec3 dx;
            vec3 dp;
        };

        Deriv deriv(vec3 x, vec3 p, float pt) {
            Deriv d;
            d.dx = dxdl(x, p, pt);
            d.dp = dpdl(x, p, pt);
            return d;
        }

        // ── Startbetingelse ────────────────────────────────────────
        // Vi kender fotonens retning (p) men mangler pt. Kravet
        // H = 0 er en andengradsligning i pt — ABC-formlen, bare
        // i en shader. Minus-roden giver et foton der bevæger sig
        // fremad i tid.
        float solvePt(vec3 x, vec3 p) {
            Metric m    = metricAt(x);
            float  L    = dot(m.l, p);
            float  disc = (1.0 + m.f) * dot(p, p) - m.f * L * L;
            return (m.f * L - sqrt(max(disc, 0.0))) / (1.0 + m.f);
        }

        // ── Procedural stoej til skivens gas ───────────────────────
        float hash21(vec2 p) {
            p = fract(p * vec2(123.34, 456.21));
            p += dot(p, p + 45.32);
            return fract(p.x * p.y);
        }

        float vnoise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            return mix(
                mix(hash21(i),                  hash21(i + vec2(1.0, 0.0)), f.x),
                mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
                f.y);
        }

        // Fraktal stoej: 4 lag oven paa hinanden, hver dobbelt saa fin
        float fbm(vec2 p) {
            float v = 0.0;
            float a = 0.5;
            for (int i = 0; i < 4; i++) {
                v += a * vnoise(p);
                p  = p * 2.1 + 17.3;
                a *= 0.5;
            }
            return v;
        }

        // Gas-moenster der roterer Keplersk UDEN at vinde sig selv op
        // i spiraler (= barber pole-fixet): to kopier med forskudt
        // nulstilling krydsfades — et "flow map". Cirkel-indlejringen
        // (cos, sin) goer stoejen periodisk i vinkel, saa der ikke er
        // en soem ved ang = ±pi.
        float diskPattern(float r, float ang, float Om) {
            float SPEED = 14.0;   // visuel fart-knap
            float T     = 3.0;    // sekunder mellem re-sync
            float t1 = mod(uTime, T);
            float t2 = mod(uTime + 0.5 * T, T);
            float w  = abs(t1 / T * 2.0 - 1.0);

            float p1 = ang - Om * t1 * SPEED;
            float p2 = ang - Om * t2 * SPEED;

            vec2 q1 = vec2(r * 1.1, 0.0) + 2.4 * vec2(cos(p1), sin(p1));
            vec2 q2 = vec2(r * 1.1, 0.0) + 2.4 * vec2(cos(p2), sin(p2));

            return mix(fbm(q1), fbm(q2), w);
        }

        // ── Accretion disk ─────────────────────────────────────────
        // Kaldes naar et ray krydser aekvatorplanet. Returnerer
        // (farve, alpha). Fysikken: gassen kredser Keplersk, og
        // g-faktoren pakker Doppler beaming OG gravitationel
        // roedforskydning i ET tal — beregnet direkte fra fotonens
        // bevarede stoerrelser E og Lz. Hamilton betaler sig hjem her.
        vec4 diskSample(vec3 xc, vec3 p, float pt) {
            float M = 0.5 * uRs;
            float a = uSpin * M;
            float r = ksR(xc, a);
            if (r < uDiskIn || r > uDiskOut) return vec4(0.0);

            // Keplersk vinkelhastighed for prograde kredsloeb
            float Om = sqrt(M) / (pow(r, 1.5) + a * sqrt(M));
            float ut = 1.0 / sqrt(max(
                1.0 - 3.0 * M / r + 2.0 * a * sqrt(M) / pow(r, 1.5), 0.02));

            // Fotonens bevarede stoerrelser
            float E  = -pt;
            float Lz = xc.x * p.y - xc.y * p.x;

            // g = modtaget/udsendt frekvens
            float g = E / max(ut * (E - Om * Lz), 0.05);

            // Temperatur: FAST skala (spin-uafhaengig!) gange
            // Shakura-Sunyaev-faktoren (1 - sqrt(r_in/r)), som faar
            // emissionen til at doe ud praecis ved inderkanten og
            // toppe lige udenfor — som i en rigtig skive.
            float R0   = uRs * 1.5;
            float heat = pow(R0 / r, 1.5)
                       * sqrt(max(1.0 - sqrt(uDiskIn / r), 0.0));

            // Turbulente filamenter i Keplersk rotation — azimutalt
            // udtvaeret (motion blur-look), radialt detaljeret.
            float ang = atan(xc.y, xc.x);
            float sw  = 0.45 + 1.1 * diskPattern(r, ang, Om);

            // Farvetemperatur: T ~ M^(-1/4). Smaa huller = hvidgloedende,
            // giganter = dybere orange/roed. uColdness saettes af presets.
            vec3 hotCol  = mix(vec3(1.0, 0.93, 0.78), vec3(1.0, 0.55, 0.20), uColdness);
            vec3 coolCol = mix(vec3(1.0, 0.35, 0.08), vec3(0.75, 0.15, 0.03), uColdness);
            vec3 col = mix(coolCol, hotCol, clamp(heat, 0.0, 1.0));
            float lum = (0.25 + 2.6 * heat) * sw;

            // Beaming: intensitet ~ g^3. Den side der kommer imod
            // dig, gloeder — den side der flygter, daemper.
            lum *= pow(clamp(g, 0.35, 2.2), 3.0);
            // og et let farvetraek: blaahvid ved blueshift, roed ved redshift
            col = mix(col * vec3(1.25, 0.75, 0.55),
                      col * vec3(0.85, 0.95, 1.35),
                      smoothstep(0.8, 1.3, g));

            // bloede kanter mod inder- og yderrand
            float edge = smoothstep(uDiskIn, uDiskIn * 1.15, r)
                       * (1.0 - smoothstep(uDiskOut * 0.75, uDiskOut, r));

            return vec4(col * lum * edge, 0.9 * edge);
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

            float M  = 0.5 * uRs;
            float a  = uSpin * M;
            float rH = M + sqrt(max(M * M - a * a, 0.0));

            // Skift til Kerr-Schild-koordinater
            vec3  x  = toKS(uCamPos - uBhPos);
            vec3  p  = toKS(rayDir);
            float pt = solvePt(x, p);   // beregnes EN gang, bevares for evigt

            bool escaped  = false;
            bool captured = false;
            vec3 outDir   = p;
            vec3 emission = vec3(0.0);   // opsamlet lys fra skiven
            float trans   = 1.0;         // hvor meget baggrund slipper igennem

            for (int i = 0; i < MAX_STEPS; i++) {
                float r = ksR(x, a);

                if (r < rH * 1.005) { captured = true; break; }

                Deriv k1 = deriv(x, p, pt);

                if (r > ESCAPE_DIST || (r > uRs * 8.0 && dot(k1.dx, x) > 0.0)) {
                    escaped = true;
                    outDir  = k1.dx;
                    break;
                }

                float jitter = r > uRs * 4.0
                    ? 0.95 + 0.1 * fract(
                          sin(dot(rayDir.xy, vec2(12.9898, 78.233))) * 43758.5453
                      )
                    : 1.0;

                // RK4 taaler ~3x laengere steps end Euler ved samme
                // noejagtighed — det er DET der giver fotonerne raad
                // til flere omloeb inden for step-budgettet.
                float dl = 1.1 * clamp(r / (uRs * 2.5), 0.3, 8.0) * jitter
                         / max(length(k1.dx), 0.25);

                // Klassisk RK4: smag paa haeldningen fire steder hen
                // over steppet og tag et vaegtet gennemsnit, i stedet
                // for blindt at foelge haeldningen fra startpunktet.
                Deriv k2 = deriv(x + 0.5 * dl * k1.dx, p + 0.5 * dl * k1.dp, pt);
                Deriv k3 = deriv(x + 0.5 * dl * k2.dx, p + 0.5 * dl * k2.dp, pt);
                Deriv k4 = deriv(x + dl * k3.dx,       p + dl * k3.dp,       pt);

                vec3 x0 = x;
                x += dl / 6.0 * (k1.dx + 2.0 * k2.dx + 2.0 * k3.dx + k4.dx);
                p += dl / 6.0 * (k1.dp + 2.0 * k2.dp + 2.0 * k3.dp + k4.dp);

                // ── Krydsede vi skivens plan (z = 0)? ──
                // Fortegnsskift paa z mellem foer og efter steppet
                // fanger krydsningen uanset steplaengde.
                if (x0.z * x.z < 0.0) {
                    float tC = x0.z / (x0.z - x.z);
                    vec4  d  = diskSample(mix(x0, x, tC), p, pt);
                    emission += trans * d.rgb;
                    trans    *= (1.0 - d.a);
                    if (trans < 0.02) break;   // skiven er uigennemsigtig nok
                }
            }

            // Klassifikation:
            //  - captured -> sort (gennem horisonten)
            //  - escaped  -> stjernehimmel i flugtretningen
            //  - loeb toer for steps (kredsede naer foton-orbits)
            //    -> sample himlen i NUVAERENDE retning. Glat-men-lidt-
            //       forkert slaar stoejende-sort: den aegte graensezone
            //       ER uendeligt fine ringbilleder af himlen.
            vec3 bgColor = vec3(0.0);
            if (!captured) {
                if (!escaped) outDir = dxdl(x, p, pt);
                vec3 worldDir = fromKS(outDir);
                bgColor = skyColor(worldDir);
                float deflection    = 1.0 - dot(normalize(worldDir), rayDir);
                float magnification = 1.0 + pow(deflection, 2.0) * 1.5;
                bgColor = min(bgColor * magnification, vec3(1.8));
            }

            gl_FragColor = vec4(emission + trans * bgColor, 1.0);
        }
    `,
    depthWrite: false,
    depthTest:  false,
});

const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
scene.add(quad);

// ── Spin slider ──
const spinSlider  = document.getElementById('spinSlider');
const spinReadout = document.getElementById('spinReadout');

function outerHorizon(a) {
    return (RS / 2) * (1 + Math.sqrt(Math.max(1 - a * a, 0)));
}

function updateSpinReadouts() {
    spinReadout.textContent = spin.toFixed(2);
    const rPlus = outerHorizon(spin);
    document.getElementById('horizonReadout').textContent = rPlus.toFixed(1);
    document.getElementById('horizonRsReadout').textContent =
        (rPlus / RS).toFixed(2) + '× Rs';
}

spinSlider.addEventListener('input', () => {
    spin = parseFloat(spinSlider.value);
    material.uniforms.uSpin.value   = spin;
    material.uniforms.uDiskIn.value = iscoRadius(spin);
    updateSpinReadouts();
    updateMassReadouts();
});

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

// ── Baggrunds-toggle (kraever en #bgBtn knap i HTML'en, se chat) ──
const bgBtn = document.getElementById('bgBtn');
if (bgBtn) {
    bgBtn.addEventListener('click', () => {
        const gridOn = material.uniforms.uBackground.value > 0.5;
        material.uniforms.uBackground.value = gridOn ? 0.0 : 1.0;
        bgBtn.classList.toggle('active', !gridOn);
    });
}

// ── Pause: GPU'en faar helt fri ──
let paused = false;
const pauseBtn = document.getElementById('pauseBtn');
if (pauseBtn) {
    pauseBtn.addEventListener('click', () => {
        paused = !paused;
        pauseBtn.classList.toggle('active', paused);
        pauseBtn.innerHTML = paused ? '<span>▶</span>' : '<span>⏸</span>';
    });
}

// ── Eco: halv render-oploesning (kvart GPU-arbejde), reversibelt ──
const ecoBtn = document.getElementById('ecoBtn');
if (ecoBtn) {
    ecoBtn.addEventListener('click', () => {
        const ecoOn = renderer.getPixelRatio() > 1.0;   // taender eco hvis vi koerer hoejt nu
        renderer.setPixelRatio(ecoOn ? 1.0 : Math.min(window.devicePixelRatio, 2.0));
        renderer.setSize(canvas.clientWidth, canvas.clientHeight);
        ecoBtn.classList.toggle('active', ecoOn);
    });
}

// ── Masse-presets ────────────────────────────────────────────────
// Fysikken er skala-fri, saa geometrien roeres IKKE. Det eneste der
// aendrer sig: skivens farvetemperatur, og hvad tallene betyder i
// virkelige enheder.
const SOLAR_RS_KM  = 2.953;      // Schwarzschild-radius for 1 solmasse
const SOLAR_TIME_S = 4.925e-6;   // GM_sol/c^3 — den geometriske tidsenhed
const KM_PER_AU    = 1.496e8;

// Raekkefoelgen SKAL matche knapperne i HTML'en
const MASS_PRESETS = [
    { name: '5 M☉',    msun: 5,      coldness: 0.0  },
    { name: 'Sgr A*',  msun: 4.3e6,  coldness: 0.45 },
    { name: 'M87*',    msun: 6.5e9,  coldness: 0.7  },
    { name: 'TON 618', msun: 6.6e10, coldness: 0.85 },
];
let currentPreset = MASS_PRESETS[0];

function fmtLength(km) {
    if (km < 1e6) return km.toFixed(1) + ' km';
    const au = km / KM_PER_AU;
    if (au < 0.1) return (km / 1e6).toFixed(1) + ' mio. km';
    return au >= 100 ? Math.round(au) + ' AU' : au.toFixed(2) + ' AU';
}

function fmtTime(s) {
    if (s < 1e-3)   return (s * 1e6).toFixed(0) + ' µs';
    if (s < 1)      return (s * 1e3).toFixed(1) + ' ms';
    if (s < 120)    return s.toFixed(1) + ' s';
    if (s < 7200)   return (s / 60).toFixed(1) + ' min';
    if (s < 172800) return (s / 3600).toFixed(1) + ' t';
    if (s < 2 * 365.25 * 86400) return (s / 86400).toFixed(0) + ' d';
    return (s / (365.25 * 86400)).toFixed(1) + ' år';
}

function updateMassReadouts() {
    const el = document.getElementById('scaleReadout');
    if (!el) return;
    const rsKm = SOLAR_RS_KM * currentPreset.msun;
    // Omloebstid ved skivens inderkant: 2π(r^1.5 + a) i M-enheder,
    // ganget med den fysiske tidsenhed GM/c³ for den valgte masse.
    const rM         = iscoRadius(spin) / (RS / 2);
    const periodGeom = 2 * Math.PI * (Math.pow(rM, 1.5) + spin);
    const periodS    = periodGeom * SOLAR_TIME_S * currentPreset.msun;
    el.textContent = 'Rs ' + fmtLength(rsKm) + ' · orbit ' + fmtTime(periodS);
}

const massWrap = document.getElementById('massPresets');
if (massWrap) {
    massWrap.querySelectorAll('.mass-btn').forEach((btn, i) => {
        btn.addEventListener('click', () => {
            currentPreset = MASS_PRESETS[i];
            material.uniforms.uColdness.value = currentPreset.coldness;
            massWrap.querySelectorAll('.mass-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            updateMassReadouts();
        });
    });
}

// ── Animate ──
const clock  = new THREE.Clock();
const camPos = new THREE.Vector3();
let simTime  = 0;

function animate() {
    requestAnimationFrame(animate);
    const dt = clock.getDelta();   // kaldes OGSAA under pause — ellers
    if (paused) return;            // teleporterer kameraet ved resume
    simTime += dt;

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
    material.uniforms.uTime.value = simTime;

    document.getElementById('distReadout').textContent = (camRadius / RS).toFixed(1) + '× Rs';
    document.getElementById('elevReadout').textContent = (camPhi * 180 / Math.PI).toFixed(1) + '°';

    if (!document.getElementById('mathPanel').classList.contains('hidden')) {
        document.getElementById('camDistReadout').textContent = (camRadius / RS).toFixed(1);
        document.getElementById('camPhiReadout').textContent  = (camPhi * 180 / Math.PI).toFixed(1);
    }

    renderer.render(scene, orthoCamera);
}

updateSpinReadouts();
updateMassReadouts();
animate();

// ── Resize ──
window.addEventListener('resize', () => {
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    material.uniforms.uResolution.value.set(canvas.clientWidth, canvas.clientHeight);
});