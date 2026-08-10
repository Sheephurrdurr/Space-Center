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
//
// ── Om slutningen ────────────────────────────────────────────────────
// Der lå engang en håndlagt ringpassage her: kameraet blev løftet op
// over ringens plan, ført ind gennem åbningen, og på den anden side
// åbnede der sig et nyt univers af proceduregenererede galakser.
// Den er væk, og det er en forbedring.
//
// Grunden er den indre horisont. For a = 0.85M ligger r₋ = 0.4732 M.
// Alt hvad der falder ind efter observatøren — plus hele det ydre
// univers' fremtidige historie — ankommer til den flade komprimeret
// ind i én endelig egentid, uendeligt blåforskudt. Poisson & Israel
// kaldte det mass inflation (1990): den effektive masse divergerer
// eksponentielt, og Cauchy-horisonten bliver en ægte singulær flade
// i stedet for en dør.
//
// Geodæten stopper ved 0.55 M. Det er 16% UDENFOR r₋. Integratoren
// giver altså op præcis dér hvor fysikken siger den skal, og faldet
// når aldrig frem til den passage der alligevel ikke er der.
// Så exhibittet ender hvor matematikken ender: i blåforskydningen.
// =====================================================================

import * as THREE from 'three';
import { DiveGeodesic, ksR, buildTetrad, dotG, solvePtAt } from './DiveGeodesic.js';
import { createDiveMaterial } from './DiveShader.js';
import { wireMathPanel, observeCanvasResize } from '/shared/exhibitCommon.js';

// ── Hullet ────────────────────────────────────────────────────────────
// Sagittarius A* stats. Our local super massive black hole
const BH_MASS   = 5.0;              // geometriske toy-units
const RS        = 2.0 * BH_MASS;    // = 10
const SPIN      = 0.85;             // a/M
const MSUN      = 4.3e6;            // Sgr A*
// 0 = hvidglødende, 1 = udbrændt rød.
//
// Var oppe på 0.75 for at redde en skive der så mørk bordeaux ud. Den
// årsag var aldrig farven — det var fortegnsfejlen på g i diskSample(),
// som låste beamingen på sit gulv og dæmpede ALT med en faktor 15.
// Med den fejl væk skal paletten tilbage i den varme ende, ellers er
// skiven bare en lys udgave af den samme brune.
//
// Kerr-exhibittets Sgr A*-preset står på 0.45. Her ligger den lidt
// under, fordi vi kommer meget tættere på og gerne vil se den hvide
// inderkant på vej ned.
const COLDNESS  = 0.30;

// Omregning fra toy-units til virkeligheden
const SOLAR_RS_KM   = 2.953;
const SOLAR_TIME_S  = 4.925e-6;
const RS_METERS     = SOLAR_RS_KM * 1000 * MSUN;
const TOY_METERS    = RS_METERS / RS;              // 1 toy-length i meter
const TOY_SECONDS   = SOLAR_TIME_S * MSUN / BH_MASS; // 1 toy-tid i sekunder
const C = 299792458;

// Indre horisont, r₋ = M − sqrt(M² − a²). Bruges kun til aflæsning:
// banen når den aldrig. = 2.3661 for a = 0.85M, mens vi stopper ved 2.75.
const R_INNER = BH_MASS - Math.sqrt(Math.max(BH_MASS * BH_MASS - Math.pow(SPIN * BH_MASS, 2), 0));

// ── Tidslinje (vægursekunder) ─────────────────────────────────────────
const T_APPROACH = 22.0;   // udefra og ind mod horisonten
const T_CROSS    = 3.5;    // selve passagen af horisonten
const T_INTERIOR = 14.0;   // ned mod dér hvor ligningerne holder op
const T_WHITE    = 8.0;    // blåforskydningen løber løbsk
const T_PLATE    = 8.0;    // udbrænding, sort, og en forklaring
const T_TOTAL = T_APPROACH + T_CROSS + T_INTERIOR + T_WHITE + T_PLATE;

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
    rs: RS,
    spin: SPIN,
    width: canvas.clientWidth,
    height: canvas.clientHeight,
    coldness: COLDNESS,
});
scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));

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
 * Sampling-tætheden styres af BEVÆGELSEN, ikke af egentiden. Det er en
 * vigtigere detalje end den ser ud, for det var her billedet "hoppede"
 * på vej ned:
 *
 * Med et fast τ-skridt på 0.01·r lå to nabo-samples 39% af r fra hinanden
 * nede ved r ≈ 0.33 Rs, og impulsen ændrede sig 27% imellem dem. Banen
 * krummer hårdt dér, så den rette linje mellem to samples skærer genvej
 * inden om den rigtige kurve. Kameraets fart dykkede altså en smule midt
 * mellem hvert sample og kom op igen ved næste — én blød puls pr. sample,
 * og fordi de sidste samples strakte sig over flere sekunders afspilning,
 * blev det til en langsom, tydelig pumpen i billedet.
 *
 * Kriteriet nu: gem et snapshot når positionen har flyttet sig 1.5% af r,
 * eller impulsen har ændret sig 1.5%. Det giver ~8000 samples, og de
 * ligger dér hvor der SKER noget. Integrationsarbejdet er uændret — det
 * er kun hvor tit vi kigger på resultatet der ændrer sig.
 *
 * H gemmes med. Ikke til fysikken — til publikum. Se noten ved
 * updateReadouts().
 */
function buildTrajectory() {
    // z0 = 4: lidt ud af ækvatorplanet. Uden det ser man skiven eksakt
    // fra kanten hele vejen ned. Med hældning svinger banen gennem planet,
    // og skiven åbner sig undervejs.
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
            r: g.r, tau: g.tau, t: g.coordTime, tBL,
            H: g.hamiltonianCheck(),
        });
    };

    // ── Den fjerne observatørs ur ──
    // g.coordTime er KERR-SCHILD-tid, og den er horizon-penetrating:
    // målt går den 546.8 lige før krydset og 616 ved integrationens
    // ophør. Fuldstændig glat. Den DIVERGERER IKKE, og panelet plejede
    // at påstå at den gjorde ved at skrive '→ ∞' som en tekststreng.
    //
    // Uret der faktisk divergerer er Boyer-Lindquist-tid, altså den
    // koordinat en observatør uendeligt langt væk selv ville bruge.
    // De to hænger sammen med én transformation:
    //
    //     dt_BL = dt_KS − (2Mr / Δ) dr,      Δ = r² − 2Mr + a²
    //
    // Δ har en rod præcis ved r₊, så integralet går logaritmisk mod
    // uendelig på vej ind. Målt: 354 ved 1.05 Rs, 601 ved 0.80 Rs,
    // 678 ved 0.7640 Rs og stadig stigende. Det er dét tal panelet
    // viser nu, og det løber selv løbsk uden at nogen skriver det.
    //
    // Indenfor findes Boyer-Lindquist slet ikke — Δ skifter fortegn.
    // Så vi holder op med at akkumulere dér, og panelet siger hvorfor.
    let tBL = 0;
    let rPrev = g.r, tKSPrev = g.coordTime;
    const AA = SPIN * BH_MASS;

    push();                                   // startpunktet
    let last = samples[0];
    let guard = 0;
    while (g.valid && guard++ < 400000) {
        // Bed aldrig om et skridt der er meget større end det integratoren
        // selv ville tage. Ellers gemmer vi ét snapshot af noget der
        // indeholdt hundredvis af substeps.
        g.advance(Math.min(Math.max(1e-5, 0.01 * g.r), 0.75 * g.suggestedStep()));

        // Trapez på (2Mr/Δ)dr, kun så længe begge endepunkter er udenfor.
        const rNow = g.r;
        if (rNow > rH * 1.000001 && rPrev > rH * 1.000001) {
            const rm = 0.5 * (rNow + rPrev);
            const Delta = rm * rm - 2 * BH_MASS * rm + AA * AA;
            tBL += (g.coordTime - tKSPrev) - (2 * BH_MASS * rm / Delta) * (rNow - rPrev);
        }
        rPrev = rNow; tKSPrev = g.coordTime;

        const dx = g.pos.x - last.x, dy = g.pos.y - last.y, dz = g.pos.z - last.z;
        const dp = Math.hypot(g.mom.x - last.px, g.mom.y - last.py, g.mom.z - last.pz);
        const pm = Math.hypot(last.px, last.py, last.pz);
        const tol = 0.015 * Math.max(g.r, 0.35);

        if (!g.valid || dx*dx + dy*dy + dz*dz >= tol*tol || dp >= 0.015 * Math.max(pm, 0.3)) {
            push();
            last = samples[samples.length - 1];
        }
    }
    if (samples[samples.length - 1] !== last) push();

    // Første sample der ligger inde i horisonten.
    for (let i = 0; i < samples.length; i++) {
        if (samples[i].r <= rH) { horizonIndex = i; break; }
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

// ── Den mørke kegle ──
// Samme tal som shaderen afgør hver pixel med, bare regnet én gang
// for hele billedet så panelet kan vise det.
//   E = A + n·B  for en foton set i retningen n
//   |B|² = A² − 1 + f      (fordi ∂_t·∂_t = −1 + f)
// E skifter fortegn på keglen cos θ = A/|B|. Findes kun når f > 1,
// altså inde i ergosfæren.
const A_OBS = -traj.pt;   // observatørens bevarede energi, −u_t

// Shaderen skal bruge den samme A til at gøre den mørke kegle til et
// KONTINUERT tal i stedet for et ja/nej. Den er bevaret langs banen, så
// den sættes én gang. Se noten ved coneS i DiveShader.
material.uniforms.uAobs.value = A_OBS;

function darkConeDeg(pos) {
    const a  = SPIN * BH_MASS;
    const r  = ksR(pos.x, pos.y, pos.z, a);
    const r2 = r * r;
    const f  = 2 * BH_MASS * r2 * r / (r2 * r2 + a * a * pos.z * pos.z);
    const B2 = A_OBS * A_OBS - 1 + f;
    if (B2 <= A_OBS * A_OBS) return 0;
    return Math.acos(Math.min(1, A_OBS / Math.sqrt(B2))) * 180 / Math.PI;
}

/**
 * Catmull-Rom i Hermite-form, med ujævnt fordelte knuder.
 *
 * Forskellen fra lineær interpolation er at kurven her kender sin egen
 * HÆLDNING i endepunkterne — tangenten estimeres fra naboerne på hver
 * side. En ret linje mellem to punkter på en krum bane skærer indenom;
 * en kurve der starter og slutter med den rigtige retning gør ikke.
 * Det er den samme idé som at tegne en blød streg gennem punkter i
 * stedet for at forbinde dem med en lineal.
 */
function hermite(p0, p1, p2, p3, v0, v1, v2, v3, t) {
    const h  = v2 - v1;
    const m1 = (v2 - v0) > 1e-12 ? (p2 - p0) / (v2 - v0) * h : (p2 - p1);
    const m2 = (v3 - v1) > 1e-12 ? (p3 - p1) / (v3 - v1) * h : (p2 - p1);
    const t2 = t * t, t3 = t2 * t;
    return (2*t3 - 3*t2 + 1) * p1 + (t3 - 2*t2 + t) * m1
         + (-2*t3 + 3*t2) * p2 + (t3 - t2) * m2;
}

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
    const P = S[Math.max(0, lo - 1)], a = S[lo], b = S[hi], Q = S[Math.min(S.length - 1, hi + 1)];
    const f = b.v > a.v ? (v - a.v) / (b.v - a.v) : 0;
    const L = k => hermite(P[k], a[k], b[k], Q[k], P.v, a.v, b.v, Q.v, f);

    const pos = new THREE.Vector3(L('x'), L('y'), L('z'));
    const mom = { x: L('px'), y: L('py'), z: L('pz') };

    return {
        pos,
        vel: new THREE.Vector3(L('vx'), L('vy'), L('vz')),
        r: L('r'), tau: L('tau'), t: L('t'), H: L('H'),
        // tBL vokser logaritmisk mod uendelig. Hermite kan overskyde på
        // så stejl en kurve, så vi klemmer den ind mellem sine to naboer.
        tBL: Math.max(a.tBL, Math.min(b.tBL, L('tBL'))),
        // Interpoleret par + lokalt løst pt = glat OG gyldigt.
        frame: { pos: { x: pos.x, y: pos.y, z: pos.z }, mom,
                 pt: solvePtAt({ x: pos.x, y: pos.y, z: pos.z }, mom, BH_MASS, SPIN * BH_MASS) },
    };
}

// =====================================================================
//  Fase-logik
// =====================================================================

const easeInOut = u => u < 0.5 ? 2*u*u : 1 - Math.pow(-2*u + 2, 2) / 2;
const clamp01   = u => Math.max(0, Math.min(1, u));

function smoothstep(e0, e1, x) {
    const u = clamp01((x - e0) / (e1 - e0));
    return u * u * (3 - 2 * u);
}

/**
 * Oversætter vægursekunder til (visuel progression, faseparametre).
 * Al pacing bor her.
 *
 * De tre slut-parametre:
 *   blue  — hvor hårdt blåforskydningen skrues op. Rammer den ALLEREDE
 *           blåforskudte rand af den mørke kegle først, fordi shaderen
 *           vægter effekten med gShift. Det er den ægte effekt, forstærket.
 *   white — det hvide tæppe ovenpå. Det er dér det holder op med at
 *           være fysik og bliver fortælling.
 *   dim   — udbrændingen bagefter. Hvid → sort, og så kommer teksten.
 */
function timeline(t) {
    const vH = traj.vHorizon;
    let v, phase = 'approach', blue = 0, white = 0, dim = 1, plate = 0;

    const tI = T_APPROACH + T_CROSS;
    const tW = tI + T_INTERIOR;
    const tP = tW + T_WHITE;

    if (t < T_APPROACH) {
        // Udefra og ind. Easing, så starten er rolig og slutningen haster.
        v = easeInOut(t / T_APPROACH) * vH;

    } else if (t < tI) {
        const u = (t - T_APPROACH) / T_CROSS;
        phase = 'crossing';
        v = vH + u * (1 - vH) * 0.10;

    } else if (t < tW) {
        const u = (t - tI) / T_INTERIOR;
        phase = 'interior';
        v = vH + (0.10 + 0.90 * easeInOut(u)) * (1 - vH);
        // Effekten begynder MENS der stadig er bevægelse. Ellers står
        // kameraet stille i otte sekunder mens kun lysstyrken ændrer sig,
        // og så føles det som en fade i stedet for som en begivenhed.
        blue = 0.30 * smoothstep(0.76, 1.0, u);

    } else if (t < tP) {
        const u = (t - tW) / T_WHITE;
        phase = 'cauchy';
        v = 1;
        // Eksponent > 1: langsomt i starten, så løber det fra én. Det er
        // formen på mass inflation, ikke en lineær optoning.
        blue  = 0.30 + 0.70 * Math.pow(u, 1.8);
        white = Math.pow(clamp01((u - 0.42) / 0.58), 2.2);

    } else {
        const u = clamp01((t - tP) / T_PLATE);
        phase = 'end';
        v = 1; blue = 1; white = 1;
        // Hvid → sort over godt to sekunder. Teksten kommer bagefter,
        // på sort, så den ikke skal kæmpe med udbrændingen.
        dim   = 1 - smoothstep(0.03, 0.30, u);
        plate = smoothstep(0.34, 0.52, u);
    }

    return { v, blue, white, dim, plate, phase };
}

// =====================================================================
//  Det der plejede at ske ved horisonten
// =====================================================================
//
// Hele exhibittets påstand er at der IKKE sker noget ved horisonten.
// Og alligevel var krydset det mest begivenhedsrige klip i hele
// animationen. Ikke fordi fysikken skiftede — raymarchen laver præcis
// det samme på begge sider, der er ingen special-casing nogen steder —
// men fordi fire FORFATTEDE ting alle sammen hang på vH:
//
//     1. 180°-svinget, over 3.5 sekunder, keyet direkte til krydset
//     2. uInside, der tændte al tegningen
//     3. mode-label, der annoncerede "Crossing the horizon"
//     4. |p|²-dødsgrænsen i shaderen, 1e4 → 2e3
//
// Løsningen er ikke at fjerne signalet — så ved publikum ikke hvornår
// de krydsede, og pointen forsvinder. Løsningen er at flytte det fra
// BILLEDET til INSTRUMENTERNE. Tallene må gerne skrige. Billedet må
// ikke blinke.
//
// Så alt visuelt hænger nu på den mørke kegle i stedet, og keglen er
// et ægte fysisk tal der ikke ved noget om horisonten. Den findes først
// når f > 1, altså ved ERGOSFÆREN, som ligger 31% udenfor. Målt langs
// præcis denne bane:
//
//     r/Rs = 1.000  (ergosfære)    kegle =  0.4°
//     r/Rs = 0.900                 kegle = 19.3°
//     r/Rs = 0.763  (HORISONT)     kegle = 30.3°   ← intet særligt
//     r/Rs = 0.600                 kegle = 40.6°
//     r/Rs = 0.275  (stop)         kegle = 59.4°
//
// Glat hele vejen igennem. Der er ingen knæk ved 30.3°, og det er
// netop pointen: overgangen strækker sig nu over ~14 sekunder og
// krydset ligger midt i den, hvor ingen lægger mærke til det.
const CONE_DRAW_LO =  5.0;   // tegningen begynder at tone ind (r ≈ 0.993 Rs)
const CONE_DRAW_HI = 35.0;   // fuldt tændt (r ≈ 0.70 Rs)
const CONE_LOOK_LO =  8.0;   // svinget begynder (r ≈ 0.985 Rs, t ≈ 16 s)
const CONE_LOOK_HI = 45.0;   // svinget færdigt (r ≈ 0.52 Rs, t ≈ 31 s)

/**
 * Mode-label, uden nogen "du krydsede nu"-annoncering.
 * "Falling" holder hele vejen gennem horisonten og skifter først når
 * keglen er godt åben — altså længe efter, og af en anden grund.
 */
function phaseLabel(phase, coneDeg) {
    if (phase === 'cauchy') return 'Blueshift — integration halted';
    if (phase === 'end')    return '';
    return coneDeg > 42 ? 'Inside' : 'Falling';
}

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

// Hvilerammen — den udrejede base. Tetraden seedes med DEN, aldrig med
// den drejede. Se den lange note over orientCamera().
const _baseR = new THREE.Vector3();
const _baseU = new THREE.Vector3();
const _baseF = new THREE.Vector3();

// Drejningen, udtrykt som rene tal i basen: _lookM[i] er den i'te drejede
// akse skrevet i (baseR, baseU, baseF). Ni tal, og de er en ægte
// rotationsmatrix fordi begge baser er ortonormale.
const _lookM = [[1,0,0], [0,1,0], [0,0,1]];

/**
 * Bygger kamerabasen i to trin: først hvileretningen (indad, blandet med
 * bevægelsesretningen), så brugerens drejning oveni.
 *
 * ── Hvorfor drejningen ikke længere lever her ──
 * Den gamle version drejede _fwd/_right/_up som almindelige pile i
 * KS-koordinater og sendte dem videre som seeds til buildTetrad(). Men
 * Gram-Schmidt retter seeds op i forhold til metrikken OG observatørens
 * firehastighed, og den opretning er ikke en rotation. Den klemmer
 * retningerne sammen fremad og strækker dem bagud — det er aberration,
 * den samme der gør himlen til en kegle i kapitel 03.
 *
 * Konsekvensen var at håndtaget sad i koordinatrummet mens billedet lever
 * i observatørens øje, med en linse imellem. Målt ved r = 0.275 Rs:
 * 5° musebevægelse drejede synsretningen mellem 0.85° og 28.47° alt efter
 * hvor man stod i omdrejningen. Faktor 33.6. Udenfor horisonten var
 * forholdet 1.1, og DERFOR føltes det kun i stykker derinde.
 *
 * Nu bygges hvilerammen her, og drejningen leveres separat som _lookM.
 * Den bliver lagt på tetradens tre rumlige ben i stedet — altså inde i
 * observatørens egen ortonormale base, hvor en rotation er en rotation.
 * 5° mus giver 5° syn, overalt. Og fordi seeds nu er rent geometriske,
 * er de også glatte: ingen Gram-Schmidt-spring når man drejer forbi en
 * retning hvor to seeds var ved at blive parallelle.
 */
function orientCamera(pos, vel, driftT, lookBack) {
    // ── 1. Hvilerammen ──
    _baseF.copy(pos).normalize().multiplyScalar(-1);
    if (vel.lengthSq() > 1e-9) {
        _velDir.copy(vel).normalize();
        _baseF.addScaledVector(_velDir, 0.35).normalize();
    }

    // cross(fwd, spinakse) er nul hvis de to er parallelle, og så bliver
    // hele basen NaN — sort skærm, ingen fejl i konsollen. Gardér.
    _baseR.crossVectors(_baseF, SPIN_AXIS);
    if (_baseR.lengthSq() < 1e-12) _baseR.set(1, 0, 0);
    _baseR.normalize();
    _baseU.crossVectors(_baseR, _baseF).normalize();

    // ── 2. Drej rammen ──
    // lookBack er fortællingens egen drejning: 0 = kig ind mod hullet,
    // 1 = kig tilbage ad den vej vi kom. Den lægges oveni brugerens yaw,
    // så man altid kan dreje sig fri af den. Grunden til at den findes
    // er fysisk: indenfor horisonten er der SORT fremad — hver eneste
    // stråle bagud i tiden ender i singulariteten. Alt der er tilbage at
    // se ligger bagude, i vinduet der lukker sig. Så det er dér vi kigger.
    const yaw   = lookYaw   + Math.PI * lookBack + Math.sin(driftT * 0.21) * 0.045;
    const pitch = lookPitch + Math.cos(driftT * 0.17) * 0.030;

    _fwd.copy(_baseF); _right.copy(_baseR); _up.copy(_baseU);

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

    // ── 3. Skriv drejningen ned som ni tal ──
    // Ingen udledning med fortegn og håndethed: bare projicér hver drejet
    // akse ned på den udrejede base. Begge er ortonormale, så resultatet
    // ER rotationsmatricen, og den kan ganges direkte på tetraden.
    _lookM[0][0] = _right.dot(_baseR); _lookM[0][1] = _right.dot(_baseU); _lookM[0][2] = _right.dot(_baseF);
    _lookM[1][0] = _up.dot(_baseR);    _lookM[1][1] = _up.dot(_baseU);    _lookM[1][2] = _up.dot(_baseF);
    _lookM[2][0] = _fwd.dot(_baseR);   _lookM[2][1] = _fwd.dot(_baseU);   _lookM[2][2] = _fwd.dot(_baseF);
}

/**
 * Lægger drejningen på tetradens rumlige ben.
 *
 * e0 røres ikke — observatøren bevæger sig ikke af at dreje hovedet.
 * De tre andre blandes med en ortogonal matrix, og det er den eneste
 * operation der bevarer <e_i, e_j> = delta_ij eksakt. Tetraden er stadig
 * en tetrade bagefter, til de elleve decimaler checkTetrad() måler.
 */
function rotateTetrad(tet, Mx) {
    const mix = m => {
        const o = [0, 0, 0, 0];
        for (let c = 0; c < 4; c++)
            o[c] = m[0] * tet[1][c] + m[1] * tet[2][c] + m[2] * tet[3][c];
        return o;
    };
    return [tet[0], mix(Mx[0]), mix(Mx[1]), mix(Mx[2])];
}

// ── Retningen "ud", gjort rigtigt ────────────────────────────────────
// uOutDir var normalize(pos): "væk fra hullets centrum". Det holder for
// en observatør der falder lige ned. Denne her gør ikke — med angMom 13
// og frame dragging piskes hun rundt, og nede ved r = 0.275 Rs ligger
// den radiale retning 118° fra det sted hvor universet faktisk står.
//
// Det rigtige tal er B: den del af tidstranslations-vektoren d/dt der
// peger et sted hen i HENDES rum. Alt uden for hullet står stille i
// forhold til d/dt, så B er per definition den vej "derud" ligger.
// Den mørke kegle sidder modsat, om -B.
const _XI = [1, 0, 0, 0];

function outAxisFrom(framePos, tet, into) {
    const aa = SPIN * BH_MASS;
    const xu = dotG(framePos, BH_MASS, aa, _XI, tet[0]);   // = -A, observatørens energi
    const B  = [_XI[0] + xu * tet[0][0], _XI[1] + xu * tet[0][1],
                _XI[2] + xu * tet[0][2], _XI[3] + xu * tet[0][3]];
    // Komponenterne langs de UDREJEDE ben, så de matcher basen nedenfor.
    const b1 = dotG(framePos, BH_MASS, aa, B, tet[1]);
    const b2 = dotG(framePos, BH_MASS, aa, B, tet[2]);
    const b3 = dotG(framePos, BH_MASS, aa, B, tet[3]);
    const n  = Math.hypot(b1, b2, b3);
    if (!(n > 1e-9)) return;      // B = 0 præcis i vendepunktet. Behold sidste.
    into.set(0, 0, 0)
        .addScaledVector(_baseR, b1 / n)
        .addScaledVector(_baseU, b2 / n)
        .addScaledVector(_baseF, b3 / n)
        .normalize();
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
 * talt ingenting. Det er først helt nede i de sidste sekunder det stiger.
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
    ham:     el('hamReadout'),
    mode:    el('modeLabel'),
    panel:   el('mathPanel'),
    r:       el('rReadout'),
    alt:     el('altReadout'),
    coord:   el('coordReadout'),
    tidal:   el('tidalReadout'),
    cone:    el('coneReadout'),
    inner:   el('innerReadout'),
    restart: el('restartBtn'),
    pause:   el('pauseBtn'),
    eco:     el('ecoBtn'),
    turn:    el('turnBtn'),
    plate:   el('endPlate'),
};

dom.turn.addEventListener('click', turn180);

/**
 * H i bundlinjen — den eneste aflæsning på siden der viser en FEJL.
 *
 * Tallet skal stå på -1/2 for evigt. Det gør det også, i seks decimaler,
 * hele vejen ned gennem horisonten. Så begynder det at glide. Målt:
 *
 *     r = 1.933 M   |H + ½| passerer 1e-7
 *     r = 0.764 M   ................. 1e-6      ← her tændes amber
 *     r = 0.600 M   ................. 1e-5
 *     r = 0.550 M   H = -0.4999865, og der stopper vi
 *
 * Og her er det tal der betyder noget: halvér skridtet, og driften
 * bliver ikke mindre. Over fire opløsninger lander maksimum på
 * 1.42, 1.60, 1.61, 1.62 · 10⁻⁵. Den konvergerer mod et GULV i stedet
 * for mod nul. Numerisk fejl gør det modsatte — den halveres når man
 * halverer skridtet. Det er dét tal der viser at det ikke er koden.
 *
 * Derfor står det på skærmen. Publikum skal se de sidste cifre gå i
 * gang, lige inden skærmen bliver hvid.
 */
function updateReadouts(s, phase, coneDeg, speedFrac) {
    dom.dist.textContent   = (s.r / RS).toFixed(3) + '× Rs';
    dom.proper.textContent = fmtDuration(s.tau * TOY_SECONDS);
    dom.speed.textContent  = (speedFrac * 100).toFixed(1) + '% c';
    dom.mode.textContent   = phaseLabel(phase, coneDeg);

    // ── Her, og kun her, står der at horisonten blev krydset ──
    // Radius-aflæsningen skifter farve når den passerer 1.000× Rs.
    // Det er alt. Ingen tekst, ingen overgang i billedet, ingen
    // kamerabevægelse. Instrumentet ved det; udsigten gør ikke.
    dom.dist.classList.toggle('crossed', s.r < traj.rH);
    dom.mode.style.opacity = phase === 'end' ? '0' : '1';

    const drift = Math.abs(s.H + 0.5);
    dom.ham.textContent = s.H.toFixed(7);
    dom.ham.classList.toggle('drifting', drift > 1e-6);

    // Panelet er skjult det meste af tiden.
    if (dom.panel.classList.contains('hidden')) return;

    dom.r.textContent     = s.r.toFixed(3);
    dom.alt.textContent   = fmtLength(s.r * TOY_METERS);
    // Boyer-Lindquist, ikke Kerr-Schild. Se noten i buildTrajectory().
    // Den vokser af sig selv mod uendelig på vej ind, og ophører med at
    // eksistere indenfor — der er ingen fjern observatør tilbage at
    // referere til.
    dom.coord.textContent = s.r > traj.rH
        ? fmtDuration(s.tBL * TOY_SECONDS)
        : 'diverged';

    const tg = tidalG(Math.max(s.r, 0.4));
    dom.tidal.textContent = tg < 0.01 ? tg.toExponential(1) : tg.toFixed(2);

    const cone = darkConeDeg(s.pos);
    dom.cone.textContent = cone < 0.05 ? '0 — hele himlen' : cone.toFixed(1);

    // Afstanden til den indre horisont, i enheder af den selv.
    // Går aldrig under 1.000. Det er hele pointen.
    dom.inner.textContent = (s.r / R_INNER).toFixed(3);
}

// =====================================================================
//  Kontroller
// =====================================================================

let elapsed = 0;
let paused  = false;
let lastTet = null;
const _outAxis = new THREE.Vector3(1, 0, 0);

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
// Med den strammere skridtregel omkring fotonsfæren bruger den dyreste
// stråle 241 skridt ved r = 0.275 Rs (målt, ikke gættet). 260 er altså
// gulvet hvis billedet skal være helt uden sorte huller.
const QUALITY = [
    { label: '◑ High',  ratio: () => Math.min(window.devicePixelRatio, 1.25), steps: 900, minFrame: 0 },
    { label: '◐ Eco',   ratio: () => 0.70,                                 steps: 420, minFrame: 0 },
    { label: '○ Ultra', ratio: () => 0.45,                                 steps: 280, minFrame: 1/30 },
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

window.diveMat = material;   // så konsollen kan nå uniformene

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
let plateShown = false;

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

    // Én måling, tre brugere. Keglen er den eneste ting der bestemmer
    // hvornår kameraet vender sig og hvornår tegningen kommer på.
    const coneNow = darkConeDeg(s.pos);
    const lookBack = smoothstep(CONE_LOOK_LO, CONE_LOOK_HI, coneNow);
    const draw     = smoothstep(CONE_DRAW_LO, CONE_DRAW_HI, coneNow);

    orientCamera(s.pos, s.vel, elapsed, lookBack);

    const u = material.uniforms;

    // ── Tetraden ──
    // Seedes med kameraets egne akser, så e1,e2,e3 ER højre/op/frem.
    // Den er gyldig hele vejen nu. Den gamle fryse-logik var kun der
    // fordi ringpassagen ikke havde nogen firehastighed at bygge en
    // observatør ud af; uden passagen er der ingen frame hvor tetraden
    // ikke er ægte.
    try {
        lastTet = buildTetrad(s.frame.pos, s.frame.mom, s.frame.pt,
            BH_MASS, SPIN * BH_MASS,
            [[_baseR.x,_baseR.y,_baseR.z], [_baseU.x,_baseU.y,_baseU.z], [_baseF.x,_baseF.y,_baseF.z]]);
        outAxisFrom(s.frame.pos, lastTet, _outAxis);
    } catch (err) {
        // Degenereret seed. Den forrige tetrade er en frame gammel,
        // og det er uendeligt meget bedre end en sort skærm.
        if (!lastTet) throw err;
    }

    // Drejningen lægges på HER, ikke i seedsne. Det er hele fixet.
    const view = rotateTetrad(lastTet, _lookM);

    // Pakkes som (rum, tid). Tetraden har [t,x,y,z].
    const pack = (e, v) => v.set(e[1], e[2], e[3], e[0]);
    pack(view[0], u.uE0.value);
    pack(view[1], u.uE1.value);
    pack(view[2], u.uE2.value);
    pack(view[3], u.uE3.value);

    u.uCamPos.value.copy(s.pos);
    u.uCamFwd.value.copy(_fwd);
    u.uCamRight.value.copy(_right);
    u.uCamUp.value.copy(_up);
    u.uOutDir.value.copy(_outAxis);
    u.uTime.value   = elapsed;
    u.uDraw.value   = draw;
    u.uBlue.value   = tl.blue;
    u.uWhite.value  = tl.white;
    u.uDim.value    = tl.dim;

    // ── Hvor strålerne dør ──
    // Udenfor: lidt inden for horisonten, så asymptotiske stråler ikke
    // integreres i en uendelighed. Indenfor: helt ned til 0.5 M, hvor
    // baglæns-tracing stadig betyder noget i Kerr-Schild.
    //
    // Skiftet SKAL være glidende. Da det var et hårdt spring, lå
    // grænsen på rH·1.005 mens kameraet selv var nået ned under den —
    // altså startede hver eneste stråle inde i sin egen dødszone og
    // døde på skridt nul. Det gav et helt sort billede i det smalle
    // bånd r ∈ (0.7634, 0.7672)·Rs, præcis dér hvor lyset forsvandt
    // og kom igen et øjeblik senere.
    // Båndet lå før på [1.00, 1.10]·rH, altså færdigt PRÆCIS ved
    // horisonten. Nu ligger det på [0.55, 1.45]·rH, symmetrisk omkring
    // den, så skiftet er godt i gang før krydset og først færdigt et
    // stykke inde. Samme endepunkter, ingen begivenhed i midten.
    const stopHi = traj.rH * 1.005;
    const stopLo = 0.5 * BH_MASS;
    const wStop  = clamp01((traj.rH * 1.45 - s.r) / (traj.rH * 0.90));
    u.uRayStop.value = stopHi + (stopLo - stopHi) * (wStop * wStop * (3 - 2 * wStop));

    // Dybde: 0 ved horisonten, 1 dér hvor integrationen holder op.
    u.uDepth.value = clamp01((traj.vHorizon === 1) ? 0
        : (tl.v - traj.vHorizon) / (1 - traj.vHorizon));

    updateReadouts(s, tl.phase, coneNow, Math.min(s.vel.length(), 0.999));

    // Tekstpladen. Klassetoggle i stedet for inline opacity, så CSS
    // ejer transitionen og prefers-reduced-motion kan slå den fra.
    const wantPlate = tl.plate > 0.5;
    if (wantPlate !== plateShown) {
        plateShown = wantPlate;
        dom.plate.classList.toggle('visible', wantPlate);
    }

    // "Fall again" kommer op sammen med teksten, ikke først når
    // hele tidslinjen er brugt op.
    dom.restart.classList.toggle('hidden', tl.plate <= 0.5);

    renderer.render(scene, orthoCamera);
}

observeCanvasResize(canvas, (w, h) => {
    renderer.setSize(w, h);
    material.uniforms.uResolution.value.set(w, h);
});


animate();