// =====================================================================
// exhibits/dive/main.js — composition root.
//
// Rollefordelingen:
//   DiveGeodesic  — HVOR kameraet er. Tidsagtig geodæt.
//   DiveShader    — HVAD kameraet ser.
//   main.js       — HVORNÅR. Al pacing, alle faser, alt DOM.
//
// Selve banen beregnes ÉN gang ved opstart og gemmes som en tabel.
// Så er afspilningen bare opslag, og vi kan skrue på tempoet uden at
// røre fysikken. Det er hele "correct physics, artistic scale" i én
// arkitektonisk beslutning: banen er sand, tempoet er .. ikke.
// =====================================================================

import * as THREE from 'three';
import { DiveGeodesic, ksR, buildTetrad, checkTetrad, dotG, solvePtAt } from './DiveGeodesic.js';
import { createDiveMaterial } from './DiveShader.js';
import { wireMathPanel, observeCanvasResize } from '/shared/exhibitCommon.js';

// ── Hullet ────────────────────────────────────────────────────────────
// Sagittarius A* stats. Our local super massive black hole
const BH_MASS   = 5.0;              // geometriske toy-units
const RS        = 2.0 * BH_MASS;    // = 10
const SPIN      = 0.85;             // a/M
const MSUN      = 4.3e6;            // Sgr A*
const COLDNESS  = 0.45;

// Omregning fra toy-units til virkeligheden
const SOLAR_RS_KM   = 2.953;
const SOLAR_TIME_S  = 4.925e-6;
const RS_METERS     = SOLAR_RS_KM * 1000 * MSUN;
const TOY_METERS    = RS_METERS / RS;              // 1 toy-length i meter
const TOY_SECONDS   = SOLAR_TIME_S * MSUN / BH_MASS; // 1 toy-tid i sekunder
const C = 299792458;

// ── Tidslinje (vægursekunder) ─────────────────────────────────────────
const T_APPROACH = 22.0;   // udefra og ind mod horisonten
const T_CROSS    = 3.5;    // selve passagen af horisonten
const T_INTERIOR = 12.0;   // ned mod ring singulariteten
const T_RING     = 2.5;    // ringpassagen
const T_BEYOND   = 11.0;   // den anden side
const T_TOTAL    = T_APPROACH + T_CROSS + T_INTERIOR + T_RING + T_BEYOND;

// ── Renderer ──────────────────────────────────────────────────────────
const canvas   = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
const coarse   = window.matchMedia('(pointer: coarse)').matches;
renderer.setPixelRatio(coarse ? 0.75 : Math.min(window.devicePixelRatio, 2));
renderer.setSize(canvas.clientWidth, canvas.clientHeight);

const scene       = new THREE.Scene();
const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const starfield = new THREE.TextureLoader().load('/assets/textures/starfield_4k.jpg');

// Standard er anisotropy = 1, altså ingen. Det er usynligt i Kerr-exhibittet,
// fordi det kamera hænger stille, men her forvrænger aberrationen himlen
// retningsafhængigt, forskelligt fra pixel til pixel, hele tiden.
starfield.anisotropy = renderer.capabilities.getMaxAnisotropy();

// wrapS SKAL wrappe — u = atan2(...)/2π + 0.5 går igennem 0/1-grænsen hver
// gang kameraet kigger mod −x. Med standard ClampToEdge blander GPU'en
// aldrig u≈0 med u≈1 ved bilineær filtrering hen over den grænse
starfield.wrapS = THREE.RepeatWrapping;
starfield.wrapT = THREE.ClampToEdgeWrapping;

const material = createDiveMaterial({
    starfield,
    beyondSky: null,        // fyldes ud når (og hvis) filen lander
    rs: RS,
    spin: SPIN,
    width: canvas.clientWidth,
    height: canvas.clientHeight,
    coldness: COLDNESS,
});
scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));

window.mat = material; // remove after debugging

// ISCO — skivens inderkant (Bardeen, Press & Teukolsky 1972)
function iscoRadius(a) {
    const M  = BH_MASS;
    const Z1 = 1 + Math.cbrt(1 - a*a) * (Math.cbrt(1 + a) + Math.cbrt(1 - a));
    const Z2 = Math.sqrt(3*a*a + Z1*Z1);
    return M * (3 + Z2 - Math.sqrt(Math.max((3 - Z1) * (3 + Z1 + 2*Z2), 0)));
}
material.uniforms.uDiskIn.value  = iscoRadius(SPIN);
material.uniforms.uDiskOut.value = RS * 5.5;

// =====================================================================
//  Banen — beregnes én gang, bruges resten af livet
// =====================================================================

/**
 * Integrerer hele faldet og gemmer det som en tabel af snapshots.
 *
 * Sampling-tætheden følger r: langt ude ændrer udsigten sig langsomt,
 * tæt på ændrer den sig voldsomt. Ensartede τ-skridt ville give hundredvis
 * af næsten identiske frames i starten og en håndfuld dér hvor det gælder.
 */
function buildTrajectory() {
    // z0 = 4: lidt ud af ækvatorplanet. Uden det ser man skiven eksakt
    // fra kanten hele vejen ned. Med hældning  svinger banen gennem planet, og skiven åbner sig undervejs.
    const g = new DiveGeodesic({
        M: BH_MASS, spin: SPIN, r0: 60, angMom: 13, inward: 0.02, z0: 4.0,
    });

    const rH = g.horizon;
    const samples = [];
    let horizonIndex = -1;

    const push = () => {
        const v = g.velocity();
        samples.push({
            x: g.pos.x, y: g.pos.y, z: g.pos.z,
            px: g.mom.x, py: g.mom.y, pz: g.mom.z,
            vx: v.x, vy: v.y, vz: v.z,
            r: g.r, tau: g.tau, t: g.coordTime,
        });
    };

    push();                                   // startpunktet
    let guard = 0;
    while (g.valid && guard++ < 100000) {
        g.advance(Math.max(0.002, 0.01 * g.r));

        // Første sample der ligger inde i horisonten. Indekset er
        // samples.length netop nu, fordi push() lægger den bagerst.
        if (horizonIndex < 0 && g.r <= rH) horizonIndex = samples.length;

        push();
    }

    // Visuel progression: lineær i log(r). Lige store skridt i log r
    // svarer nogenlunde til lige store skridt i "hvor meget større ser
    // hullet ud nu", hvilket er den skala øjet faktisk oplever.
    const r0 = samples[0].r;
    const rEnd = samples[samples.length - 1].r;
    const span = Math.log(r0) - Math.log(rEnd);
    let runningMin = r0;
    for (const s of samples) {
        runningMin = Math.min(runningMin, s.r);
        s.v = (Math.log(r0) - Math.log(runningMin)) / span;
    }

    // Med de valgte startbetingelser krydser banen altid. Faldback'en er
    // der for at en fremtidig justering af angMom giver et mærkeligt
    // exhibit i stedet for en hvid skærm og en TypeError.
    if (horizonIndex < 0) {
        console.warn('[dive] banen nåede aldrig horisonten — tjek angMom');
        horizonIndex = samples.length - 1;
    }

    return { samples, horizonIndex, rH, vHorizon: samples[horizonIndex].v, pt: g.pt };
}

const traj = buildTrajectory();
material.uniforms.uRayStop.value = traj.rH * 1.005;

/** Slår op i banen ved visuel progression v ∈ [0,1], med interpolation. */
function sampleAt(v) {
    const S = traj.samples;
    v = Math.max(0, Math.min(1, v));
    // Binærsøgning — s.v er monotont voksende pr. konstruktion.
    let lo = 0, hi = S.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (S[mid].v <= v) lo = mid; else hi = mid;
    }
    const a = S[lo], b = S[hi];
    const f = b.v > a.v ? (v - a.v) / (b.v - a.v) : 0;
    const L = (p, q) => p + (q - p) * f;

    const pos = new THREE.Vector3(L(a.x,b.x), L(a.y,b.y), L(a.z,b.z));
    const mom = { x: L(a.px,b.px), y: L(a.py,b.py), z: L(a.pz,b.pz) };

    return {
        pos,
        vel: new THREE.Vector3(L(a.vx,b.vx), L(a.vy,b.vy), L(a.vz,b.vz)),
        r: L(a.r, b.r), tau: L(a.tau, b.tau), t: L(a.t, b.t),
        // Interpoleret par + lokalt løst pt = glat OG gyldigt.
        frame: { pos: { x: pos.x, y: pos.y, z: pos.z }, mom,
                 pt: solvePtAt({ x: pos.x, y: pos.y, z: pos.z }, mom, BH_MASS, SPIN * BH_MASS) },
    };
}

// =====================================================================
//  Fase-logik
// =====================================================================

const easeInOut = u => u < 0.5 ? 2*u*u : 1 - Math.pow(-2*u + 2, 2) / 2;
const clamp01    = u => Math.max(0, Math.min(1, u));

/**
 * Oversætter vægursekunder til (visuel progression, faseparametre).
 * Al pacing bor her.
 */
function timeline(t) {
    const vH = traj.vHorizon;
    let v, pass = 0, flash = 0, ringS = -1, phase = 'approach';

    if (t < T_APPROACH) {
        // Udefra og ind. Easing, så starten er rolig og slutningen haster.
        v = easeInOut(t / T_APPROACH) * vH;

    } else if (t < T_APPROACH + T_CROSS) {
        const u = (t - T_APPROACH) / T_CROSS;
        phase = 'crossing';
        v = vH + u * (1 - vH) * 0.10;

    } else if (t < T_APPROACH + T_CROSS + T_INTERIOR) {
        const u = (t - T_APPROACH - T_CROSS) / T_INTERIOR;
        phase = 'interior';
        v = vH + (0.10 + 0.90 * easeInOut(u)) * (1 - vH);

    } else {
        // Ring og beyond deler én kurve. Ellers står kameraet stille i
        // elleve sekunder mens kun støjen bevæger sig, og det føles dødt.
        v = 1;
        const tR = t - T_APPROACH - T_CROSS - T_INTERIOR;

        // Passagen selv er hurtig, den anden side er langsom. To forskellige
        // hastigheder på den samme s, delt ved gennemslaget.
        if (tR < T_RING) {
            phase = 'ring';
            ringS = RING_CROSS_S * easeInOut(clamp01(tR / T_RING));
        } else {
            phase = 'beyond';
            const u = clamp01((tR - T_RING) / T_BEYOND);
            ringS = RING_CROSS_S + (1 - RING_CROSS_S) * easeInOut(u);
        }

        // Paletten vender omkring gennemslaget
        pass  = smoothstep(RING_CROSS_S - 0.06, RING_CROSS_S + 0.14, ringS);
         // Asymmetrisk: eksplosivt ind, langsomt ud. En udkastning har
        // hård attack og lang decay — et blitz har begge dele lige hurtigt.
        const d = ringS - RING_CROSS_S;
        flash = d < 0
            ? Math.exp(-Math.pow(d / 0.020, 2.0))
            : Math.exp(-d / 0.16);
    }

    // ── Hvornår skifter vi renderer? ──
    // Det her hænger bevidst på POSITION og ikke på fasen. Grunden er
    // konkret: raymarchen dropper enhver stråle der kommer inden for
    // rH·1.005, så et kryds der ligger helt inde ved horisonten ville
    // fade fra ren sort over i interiøret. Ved at binde fadet til v
    // begynder det mens der stadig er noget at se, og de sidste
    // stjerner bliver hængende ind i overgangen.
    const BAND = 0.05;
    const inside = smoothstep(vH - BAND, vH + BAND, v);

    return { v, inside, pass, flash, ringS, phase };
}

function smoothstep(e0, e1, x) {
    const u = clamp01((x - e0) / (e1 - e0));
    return u * u * (3 - 2 * u);
}

// =====================================================================
//  Ringpassagen — den eneste kamerabevægelse på siden der IKKE er fysik
// =====================================================================
//
// Geodæten stopper ved r = 0.55 M, og den peger på det tidspunkt næsten
// rent tangentialt: kameraet piskes rundt om ringen, ikke ind gennem den.
// Så en simpel forlængelse af banen ville føre væk. Passagen er derfor "håndlavet".
//
// Kurven er sat i cylinderkoordinater omkring spin-aksen, fordi ringen
// er defineret i netop de koordinater (z = 0, ρ = a). Det gør nøglerne
// læsbare: "løft op over ringen, ind over midten, ned gennem hullet."
// ρ er en FAKTOR af hvor geodæten slap. z og φ er absolutte tilføjelser.
// Geodætens sidste z er -0.18, altså praktisk talt i ringens plan, så
// nøgle 0 starter bare i z = 0 og springet er usynligt.
const RING_KEYS = [
    // s      ρ-faktor   z      Δφ
    [0.00,     1.000,   0.00,  0.00],   // hvor geodæten slap
    [0.30,     0.614,   1.90,  0.70],   // op over ringens plan, og indad
    [0.55,     0.139,   0.00,  1.35],   // gennem åbningen i midten
    [1.00,     0.515,  -4.20,  2.10],   // væk, på den anden side
];
const RING_CROSS_S = 0.55;   // hvor z = 0 passeres. Glimtet ligger her.

// Passagen starter præcis dér hvor geodæten holder op.
const ringAnchor = (() => {
    const last = traj.samples[traj.samples.length - 1];
    return {
        rho: Math.hypot(last.x, last.y),
        phi: Math.atan2(last.y, last.x),
    };
})();

const _ringPos = new THREE.Vector3();

/** Position langs den scriptede passage, s ∈ [0,1]. */
function ringPath(s) {
    s = clamp01(s);
    let i = 0;
    while (i < RING_KEYS.length - 2 && s > RING_KEYS[i + 1][0]) i++;
    const A = RING_KEYS[i], B = RING_KEYS[i + 1];
    const u = (s - A[0]) / (B[0] - A[0]);
    const e = u * u * (3 - 2 * u);           // smoothstep mellem nøgler

    const rho = ringAnchor.rho * (A[1] + (B[1] - A[1]) * e);
    const z   = A[2] + (B[2] - A[2]) * e;
    const phi = ringAnchor.phi + (A[3] + (B[3] - A[3]) * e);

    return _ringPos.set(rho * Math.cos(phi), rho * Math.sin(phi), z);
}

const PHASE_LABEL = {
    approach: 'Falling',
    crossing: 'Crossing the horizon',
    interior: 'Inside',
    ring:     'The ring',
    beyond:   'Beyond',
};

// =====================================================================
//  Kamera-orientering
// =====================================================================

const SPIN_AXIS = new THREE.Vector3(0, 0, 1);  // Kerr-Schild: spin om z

// Kigge-tilstand. yaw/pitch måles i forhold til KAMERAETS hvileramme —
// altså i forhold til hullet, ikke i forhold til verden. yaw = 0 er
// "hullet i midten", yaw = π er "hullet i ryggen".
let lookYaw = 0, lookPitch = 0;        // udglattet, det shaderen ser
let targetYaw = 0, targetPitch = 0;    // hvor input peger hen

const PITCH_LIMIT = 1.40;   // ~80°. Se note om equirect-poler nedenfor.
const DRAG_SPEED  = 0.005;  // radianer pr. pixel
const KEY_SPEED   = 1.6;    // radianer pr. sekund
const SMOOTH_RATE = 9.0;    // hvor hurtigt look indhenter target

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _velDir = new THREE.Vector3();
const _qYaw   = new THREE.Quaternion();
const _qPitch = new THREE.Quaternion();

/**
 * Bygger kamerabasen i to trin: først hvileretningen (indad, blandet med
 * bevægelsesretningen), så brugerens drejning oveni.
 *
 * Den gamle version lagde en skaleret vektor til _fwd og normaliserede.
 * Det er en småvinkel-approksimation, og den kan aldrig komme forbi 90°
 * uanset hvad man fodrer den. Quaternionerne her er ægte rotationer og
 * er lige glade med om vinklen er 0.2 eller 12.
 */
function orientCamera(pos, vel, driftT) {
    // ── 1. Hvilerammen ──
    _fwd.copy(pos).normalize().multiplyScalar(-1);
    if (vel.lengthSq() > 1e-9) {
        _velDir.copy(vel).normalize();
        _fwd.addScaledVector(_velDir, 0.35).normalize();
    }

    // cross(fwd, spinakse) er nul hvis de to er parallelle, og så bliver
    // hele basen NaN — sort skærm, ingen fejl i konsollen. Gardér.
    _right.crossVectors(_fwd, SPIN_AXIS);
    if (_right.lengthSq() < 1e-12) _right.set(1, 0, 0);
    _right.normalize();
    _up.crossVectors(_right, _fwd).normalize();

    // ── 2. Drej rammen ──
    const yaw   = lookYaw   + Math.sin(driftT * 0.21) * 0.045;
    const pitch = lookPitch + Math.cos(driftT * 0.17) * 0.030;

    // Yaw om _up, som er bygget ud fra spin-aksen. Derfor kan der aldrig
    // snige sig roll ind: horisonten bliver vandret gratis.
    // Minus, fordi positiv yaw skal betyde "kig til højre".
    _qYaw.setFromAxisAngle(_up, -yaw);
    _fwd.applyQuaternion(_qYaw);
    _right.applyQuaternion(_qYaw);

    // Pitch om den NYE right-akse. Rotationer kommuterer ikke — bruger du
    // den gamle akse her, får du en skæv sammensætning der ligner gimbal
    // lock ved store vinkler, men er en helt anden fejl.
    _qPitch.setFromAxisAngle(_right, pitch);
    _fwd.applyQuaternion(_qPitch);

    _up.crossVectors(_right, _fwd).normalize();
}

// ── Drag ──────────────────────────────────────────────────────────────
// Drag sætter target DIREKTE ud fra en pixelforskel. Ingen integration:
// musen fortæller os hvor langt den flyttede sig, ikke hvor hurtigt.
let dragging = false, lastX = 0, lastY = 0;

canvas.addEventListener('pointerdown', e => {
    dragging = true;
    lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', e => {
    if (!dragging) return;
    // "Grib himlen": træk til højre, og himlen følger med til højre,
    // altså drejer man mod venstre. Byt fortegn hvis du vil have FPS-følelsen.
    targetYaw   -= (e.clientX - lastX) * DRAG_SPEED;
    targetPitch += (e.clientY - lastY) * DRAG_SPEED;
    targetPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, targetPitch));
    lastX = e.clientX; lastY = e.clientY;
});

const endDrag = e => {
    dragging = false;
    if (e.pointerId !== undefined) canvas.releasePointerCapture?.(e.pointerId);
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// ── Tastatur ──────────────────────────────────────────────────────────
// Tasterne beskriver en HASTIGHED, ikke en position. Derfor holder vi
// bare styr på hvad der er trykket ned, og integrerer i loopet hvor vi
// har fat i dt. Ellers ville drejehastigheden afhænge af framerate og
// af hvor hurtigt browseren gentager keydown — to ting man ikke styrer.
const held = new Set();
const LOOK_KEYS = {
    KeyW: 'up', ArrowUp: 'up',
    KeyS: 'down', ArrowDown: 'down',
    KeyA: 'left', ArrowLeft: 'left',
    KeyD: 'right', ArrowRight: 'right',
};

// e.code er FYSISK tastplacering, ikke tegnet. Det er derfor WASD virker
// på dansk, tysk og fransk tastatur uden at vi rører ved noget.
window.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const dir = LOOK_KEYS[e.code];
    if (dir) { held.add(dir); e.preventDefault(); return; }  // stop piletast-scroll
    if (e.code === 'KeyB') turn180();
    if (e.code === 'KeyR') { targetYaw = 0; targetPitch = 0; }
});
window.addEventListener('keyup', e => {
    const dir = LOOK_KEYS[e.code];
    if (dir) held.delete(dir);
});
// Skifter man fane midt i et tryk, kommer keyup aldrig. Uden det her
// bliver kameraet ved med at dreje når man kommer tilbage.
window.addEventListener('blur', () => held.clear());

// ── 180° ──────────────────────────────────────────────────────────────
function turn180() {
    // Vælg det fortegn der lander tættest på nul, så to tryk fører
    // tilbage til udgangspunktet i stedet for at akkumulere i én retning.
    targetYaw += Math.abs(targetYaw + Math.PI) <= Math.abs(targetYaw - Math.PI)
        ? Math.PI : -Math.PI;
    targetPitch = 0;
}

/** Kaldes hver frame, også når faldet er sat på pause. */
function updateLook(dt) {
    const rate = KEY_SPEED * dt;
    if (held.has('left'))  targetYaw   -= rate;
    if (held.has('right')) targetYaw   += rate;
    if (held.has('up'))    targetPitch += rate;
    if (held.has('down'))  targetPitch -= rate;
    targetPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, targetPitch));

    // Eksponentiel udglatning, gjort rigtigt. Det klassiske
    // "look += (target - look) * 0.12" har en skjult antagelse om at dt
    // er konstant — på 144 Hz indhenter den dobbelt så hurtigt som på 72.
    // exp(-rate·dt) er den analytiske løsning og opfører sig ens overalt.
    const k = 1 - Math.exp(-SMOOTH_RATE * dt);
    lookYaw   += (targetYaw   - lookYaw)   * k;
    lookPitch += (targetPitch - lookPitch) * k;
}

// =====================================================================
//  Aflæsninger
// =====================================================================

function fmtLength(m) {
    const km = m / 1000;
    if (km < 1e6) return km.toFixed(0) + ' km';
    const au = km / 1.496e8;
    if (au < 1) return (km / 1e6).toFixed(1) + ' mio. km';
    return au.toFixed(2) + ' AU';
}

function fmtDuration(s) {
    if (s < 90) return s.toFixed(1) + ' s';
    if (s < 5400) return (s / 60).toFixed(1) + ' min';
    if (s < 172800) return (s / 3600).toFixed(1) + ' h';
    return (s / 86400).toFixed(1) + ' d';
}

/**
 * Tidevandsacceleration hen over 2 meter, i g.
 *
 * a ≈ 2GM·Δr/r³. Skalerer med 1/M² ved horisonten, hvilket er hele
 * grunden til at et supermassivt hul er så mildt: for Sgr A* er tallet
 * her omkring 10⁻⁴ g når man passerer horisonten. Man mærker bogstaveligt
 * talt ingenting. Det er først helt nede ved ringen det løber løbsk.
 */
function tidalG(rToy) {
    const dr = 2 / TOY_METERS;                       // 2 m i toy-units
    const aGeom = 2 * BH_MASS * dr / Math.pow(rToy, 3);   // 1/toy-length
    const aSI = aGeom / TOY_METERS * C * C;
    return aSI / 9.81;
}

const el = id => document.getElementById(id);

// Slå op ÉN gang. 
const dom = {
    dist:    el('distReadout'),
    proper:  el('properReadout'),
    speed:   el('speedReadout'),
    mode:    el('modeLabel'),
    panel:   el('mathPanel'),
    r:       el('rReadout'),
    alt:     el('altReadout'),
    coord:   el('coordReadout'),
    tidal:   el('tidalReadout'),
    restart: el('restartBtn'),
    pause:   el('pauseBtn'),
    eco:     el('ecoBtn'),
    turn: el('turnBtn'),
};

dom.turn.addEventListener('click', turn180);

function updateReadouts(s, phase, speedFrac) {
    dom.dist.textContent   = (s.r / RS).toFixed(3) + '× Rs';
    dom.proper.textContent = fmtDuration(s.tau * TOY_SECONDS);
    dom.speed.textContent  = (speedFrac * 100).toFixed(1) + '% c';
    dom.mode.textContent   = PHASE_LABEL[phase];

    // Panelet er skjult det meste af tiden.
    if (dom.panel.classList.contains('hidden')) return;

    dom.r.textContent     = s.r.toFixed(3);
    dom.alt.textContent   = fmtLength(s.r * TOY_METERS);
    dom.coord.textContent = phase === 'approach'
        ? fmtDuration(s.t * TOY_SECONDS)
        : '→ ∞';

    const tg = tidalG(Math.max(s.r, 0.4));
    dom.tidal.textContent = tg < 0.01 ? tg.toExponential(1) : tg.toFixed(2);
}

// =====================================================================
//  Kontroller
// =====================================================================

let elapsed = 0;
let paused  = false;

wireMathPanel();

dom.restart.addEventListener('click', () => {
    elapsed = 0;
    paused = false;
    dom.pause.innerHTML = '<span>⏸</span> Pause';
    dom.pause.classList.remove('active');
});

dom.pause.addEventListener('click', () => {
    paused = !paused;
    dom.pause.innerHTML = paused ? '<span>▶</span> Resume' : '<span>⏸</span> Pause';
    dom.pause.classList.toggle('active', paused);
});

// Settings for the quality of the exhibit. So it doesn't torch your device
const QUALITY = [
    { label: '◑ High',  ratio: () => Math.min(window.devicePixelRatio, 1.25), steps: 260, minFrame: 0 },
    { label: '◐ Eco',   ratio: () => 0.70,                                 steps: 170, minFrame: 0 },
    { label: '○ Ultra', ratio: () => 0.45,                                 steps: 100, minFrame: 1/30 },
];
let qIndex = 0;

function applyQuality() {
    const q = QUALITY[qIndex];
    renderer.setPixelRatio(q.ratio());
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    material.uniforms.uResolution.value.set(canvas.clientWidth, canvas.clientHeight);
    material.uniforms.uMaxSteps.value = q.steps;
    dom.eco.innerHTML = `<span>${q.label.charAt(0)}</span> ${q.label.slice(2)}`;
    dom.eco.classList.toggle('active', qIndex > 0);
}

dom.eco.addEventListener('click', () => {
    qIndex = (qIndex + 1) % QUALITY.length;   // % gør at den ruller rundt
    applyQuality();
});

applyQuality();

// ── Adaptiv opløsning ─────────────────────────────────────────────────
// Spidsbelastningen i fotonringen kan ikke regnes væk, men den kan
// fordeles: færre pixels netop dér, flere igen bagefter. Målet er
// konstant FRAMETID, ikke konstant opløsning.
let dynScale = 1.0;
let frameAvg = 1 / 60;

function adaptQuality(dt) {
    // Glidende gennemsnit. Én enkelt lang frame (fanebladsskift,
    // shader-kompilering) skal ikke rive opløsningen ned.
    frameAvg += (dt - frameAvg) * 0.08;

    const target = 1 / 45;
    let next = dynScale;
    if      (frameAvg > target * 1.20) next *= 0.95;   // ned hurtigt
    else if (frameAvg < target * 0.70) next *= 1.02;   // op langsomt

    next = Math.max(0.45, Math.min(1.0, next));

    // Skift kun ved mærkbar forskel. setSize genallokerer buffere,
    // og at gøre det hver frame er værre end problemet.
    if (Math.abs(next - dynScale) < 0.01) return;
    dynScale = next;
    renderer.setPixelRatio(QUALITY[qIndex].ratio() * dynScale);
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
}


// =====================================================================
//  Loop
// =====================================================================

const clock = new THREE.Clock();

let frameAcc = 0;

function animate() {
    requestAnimationFrame(animate);

    const raw = clock.getDelta();
    const dt = Math.min(raw, 1/20);

    adaptQuality(dt);
    updateLook(dt);

    // Rendering droppes, men input og tid opdateres stadig
    const minFrame = QUALITY[qIndex].minFrame;
    if (minFrame > 0) {
        frameAcc += dt;
        if (frameAcc < minFrame) return;
        frameAcc = 0;
    }

    if (!paused) elapsed += dt;

    const looped = Math.min(elapsed, T_TOTAL);
    const tl = timeline(looped);
    const s  = sampleAt(tl.v);

    if (Math.floor(elapsed * 4) !== window._lastLog) {
        window._lastLog = Math.floor(elapsed * 4);
        console.log(
            'r/Rs', (s.r / RS).toFixed(3),
            'v', tl.v.toFixed(3),
            'vH', traj.vHorizon.toFixed(3),
            'inside', tl.inside.toFixed(3)
        );
    }


    // Efter geodætens sidste punkt overtager den håndlagte kurve.
    if (tl.ringS >= 0) {
        s.pos.copy(ringPath(tl.ringS));

        // r er stadig veldefineret for en vilkårlig position — det er bare
        // en koordinat. Så aflæsningen kan følge med, selvom BANEN ikke
        // længere er en geodæt. Og den gør noget interessant: inde i
        // ringens åbning (z = 0, ρ < a) er r eksakt nul.
        s.r = ksR(s.pos.x, s.pos.y, s.pos.z, SPIN * BH_MASS);

        // Aberrationen tones ud sammen med farten. Vi har ikke længere
        // en fysisk hastighed at aberrere efter, så at lade den stå ville
        // være at lade som om vi stadig regnede på noget.
        s.vel.multiplyScalar(Math.max(0, 1 - tl.ringS * 1.6));
    }

    orientCamera(s.pos, s.vel, elapsed);

    const u = material.uniforms;

    // Tetraden seedes med kameraets egne akser, så e1,e2,e3 ER højre/op/frem.
    const tet = buildTetrad(s.frame.pos, s.frame.mom, s.frame.pt, BH_MASS, SPIN * BH_MASS,
        [[_right.x,_right.y,_right.z], [_up.x,_up.y,_up.z], [_fwd.x,_fwd.y,_fwd.z]]);

    // Pakkes som (rum, tid). Tetraden har [t,x,y,z].
    const pack = (e, v) => v.set(e[1], e[2], e[3], e[0]);
    pack(tet[0], u.uE0.value);
    pack(tet[1], u.uE1.value);
    pack(tet[2], u.uE2.value);
    pack(tet[3], u.uE3.value);

    u.uCamPos.value.copy(s.pos);
    u.uCamFwd.value.copy(_fwd);
    u.uCamRight.value.copy(_right);
    u.uCamUp.value.copy(_up);
    u.uVel.value.copy(s.vel);
    u.uOutDir.value.copy(s.pos).normalize();
    u.uTime.value  = elapsed;
    u.uInside.value = 0; // Was tl.inside; changed to 0 for testing
    u.uPass.value   = tl.pass;
    u.uFlash.value  = tl.flash;

    u.uRayStop.value = s.r < traj.rH ? 0.5 * BH_MASS : traj.rH * 1.005;

    // Dybde: 0 ved horisonten, 1 ved ringen
    u.uDepth.value = clamp01((traj.vHorizon === 1) ? 0
        : (tl.v - traj.vHorizon) / (1 - traj.vHorizon));

    updateReadouts(s, tl.phase, Math.min(s.vel.length(), 0.999));

    dom.restart.classList.toggle('hidden', elapsed < T_TOTAL);

    renderer.render(scene, orthoCamera);
}

observeCanvasResize(canvas, (w, h) => {
    renderer.setSize(w, h);
    material.uniforms.uResolution.value.set(w, h);
});


setInterval(() => console.log('fps', (1/frameAvg).toFixed(0), 'scale', dynScale.toFixed(2)), 500);

animate();