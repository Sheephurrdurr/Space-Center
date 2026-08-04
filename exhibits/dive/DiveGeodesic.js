// =====================================================================
// exhibits/dive/DiveGeodesic.js
//
// Kameraets EGEN bane. Ikke en animation, ikke en Bézier-kurve — en
// rigtig tidsagtig geodæt integreret gennem Kerr-rumtiden.
//
// Pointen: shaderen i Kerr_finalBoss integrerer LYSETS baner (H = 0).
// Præcis den samme Hamilton-maskine beskriver også en partikel MED
// masse — eneste forskel er at H = -1/2 i stedet for 0. Så i stedet
// for at finde på en kamerabevægelse, lader vi kameraet falde.
//
// Og fordi vi regner i Kerr-Schild-koordinater, gælder integrationen
// stadig efter horisonten. KS-koordinater er "horizon-penetrating" —
// de har ingen singularitet ved r+, kun ved den ægte ringsingularitet.
// Kameraets position inde i hullet er derfor lige så rigtig som
// udenfor. Det er kun LYSET vi må fortolke os frem til derinde.
// =====================================================================

/**
 * Kerr-Schild-radius. Bemærk: r er IKKE length(x). Flader af konstant
 * r er fladtrykte ellipsoider. Løses som en andengradsligning i r².
 */
export function ksR(x, y, z, a) {
    const rho2 = x * x + y * y + z * z;
    const b = rho2 - a * a;
    const r2 = 0.5 * (b + Math.sqrt(b * b + 4 * a * a * z * z));
    return Math.sqrt(Math.max(r2, 1e-9));
}

/** Ydre horisont, r+ = M + sqrt(M² - a²) */
export function outerHorizon(M, a) {
    return M + Math.sqrt(Math.max(M * M - a * a, 0));
}

/**
 * Metrikken kogt ned til ét tal og én vektor: g = eta + f (l ⊗ l).
 * Det er hele Kerr-geometrien, i fire linjer.
 */
function metricAt(x, y, z, M, a) {
    const r = ksR(x, y, z, a);
    const r2 = r * r;
    const f = (2 * M * r2 * r) / (r2 * r2 + a * a * z * z);
    const den = r2 + a * a;
    return {
        f,
        lx: (r * x + a * y) / den,
        ly: (r * y - a * x) / den,
        lz: z / r,
    };
}

/**
 * H = 1/2 g^{μν} p_μ p_ν.
 * Lys: H = 0. Masse (m = 1): H = -1/2. Samme funktion, andet tal.
 */
function hamiltonian(x, y, z, px, py, pz, pt, M, a) {
    const m = metricAt(x, y, z, M, a);
    const S = m.lx * px + m.ly * py + m.lz * pz - pt;
    return 0.5 * (-pt * pt + (px * px + py * py + pz * pz) - m.f * S * S);
}

export class DiveGeodesic {
    /**
     * @param {number} M          masse i geometriske enheder (Rs = 2M)
     * @param {number} spin       a/M, 0..1
     * @param {number} r0         startradius
     * @param {number} angMom     specifikt drejningsmoment L_z.
     *                            Under ISCO-værdien (2√3·M for a=0) findes
     *                            der ingen stabil bane — så plunger den.
     * @param {number} inward     lille indadgående startimpuls
     */
    constructor({ M = 5, spin = 0.85, r0 = 60, angMom = 14, inward = 0.02, z0 = 0 } = {}) {
        this.M = M;
        this.a = spin * M;

        // Start på +x-aksen, eventuelt løftet z0 ud af ækvatorplanet.
        // z0 != 0 giver en bane der svinger gennem planet på vej ned —
        // stadig en helt almindelig geodæt, bare ikke en ækvatorial en.
        this.pos = { x: r0, y: 0, z: z0 };

        // L_z = x·p_y - y·p_x. På +x-aksen er det bare r0·p_y.
        this.mom = { x: -inward, y: angMom / r0, z: 0 };

        this.tau = 0;       // egentid — den ur-tid rejsende selv mærker
        this.coordTime = 0; // koordinattid — divergerer ved horisonten

        // Sættes til false når vi når så tæt på ringen at ligningerne
        // ikke længere kan følge med. Derfra overtager fortolkningen.
        this.valid = true;

         this.pt = this._solvePt();

        if (!Number.isFinite(this.pt)) {
            throw new Error('[dive] pt kunne ikke løses — tjek startbetingelser'); 
        }

    }

    /** Hvor tæt på ringen integrationen holder. Fundet empirisk, ikke gættet. */
    static R_STOP_FACTOR = 0.55;

    /** dx/dλ = ∂H/∂p — analytisk, den er nem at differentiere i p. */
    _dxdl(x, y, z, px, py, pz) {
        const m = metricAt(x, y, z, this.M, this.a);
        const S = m.lx * px + m.ly * py + m.lz * pz - this.pt;
        return {
            x: px - m.f * S * m.lx,
            y: py - m.f * S * m.ly,
            z: pz - m.f * S * m.lz,
        };
    }

    /**
     * dp/dλ = -∂H/∂x — central differens. Mål H to steder, tag hældningen.
     *
     * Epsilon skalerer MED r. En fast epsilon på 1e-3 er fin ved r = 60,
     * men tæt på ringen ændrer metrikken sig så voldsomt over den afstand
     * at "hældningen" bliver ren støj. Relativ epsilon holder præcisionen
     * konstant hele vejen ned.
     */
    _dpdl(x, y, z, px, py, pz) {
        const r = ksR(x, y, z, this.a);
        const e = Math.min(1e-2, Math.max(1e-7, r * 1e-4));
        const H = (dx, dy, dz) =>
            hamiltonian(x + dx, y + dy, z + dz, px, py, pz, this.pt, this.M, this.a);
        return {
            x: -(H(e, 0, 0) - H(-e, 0, 0)) / (2 * e),
            y: -(H(0, e, 0) - H(0, -e, 0)) / (2 * e),
            z: -(H(0, 0, e) - H(0, 0, -e)) / (2 * e),
        };
    }

    _deriv(s) {
        return {
            dx: this._dxdl(s.x, s.y, s.z, s.px, s.py, s.pz),
            dp: this._dpdl(s.x, s.y, s.z, s.px, s.py, s.pz),
        };
    }

    /**
     * Ét RK4-skridt i egentid. Samme integrator som fotonerne i shaderen,
     * bare på CPU'en — der er kun én af den her bane, så det koster intet.
     */
    step(dTau) {
        const s0 = {
            x: this.pos.x, y: this.pos.y, z: this.pos.z,
            px: this.mom.x, py: this.mom.y, pz: this.mom.z,
        };
        const shift = (s, d, h) => ({
            x: s.x + h * d.dx.x, y: s.y + h * d.dx.y, z: s.z + h * d.dx.z,
            px: s.px + h * d.dp.x, py: s.py + h * d.dp.y, pz: s.pz + h * d.dp.z,
        });

        const k1 = this._deriv(s0);
        const k2 = this._deriv(shift(s0, k1, dTau * 0.5));
        const k3 = this._deriv(shift(s0, k2, dTau * 0.5));
        const k4 = this._deriv(shift(s0, k3, dTau));

        const w = dTau / 6;
        this.pos.x += w * (k1.dx.x + 2 * k2.dx.x + 2 * k3.dx.x + k4.dx.x);
        this.pos.y += w * (k1.dx.y + 2 * k2.dx.y + 2 * k3.dx.y + k4.dx.y);
        this.pos.z += w * (k1.dx.z + 2 * k2.dx.z + 2 * k3.dx.z + k4.dx.z);
        this.mom.x += w * (k1.dp.x + 2 * k2.dp.x + 2 * k3.dp.x + k4.dp.x);
        this.mom.y += w * (k1.dp.y + 2 * k2.dp.y + 2 * k3.dp.y + k4.dp.y);
        this.mom.z += w * (k1.dp.z + 2 * k2.dp.z + 2 * k3.dp.z + k4.dp.z);

        this.tau += dTau;
        this.coordTime += dTau * this.dtdl();
    }

    /**
     * Rykker banen dTau frem i egentid, opdelt i så mange RK4-substeps
     * som geometrien kræver.
     *
     * Hvorfor: ét fast skridt der er fint ved r = 60 sprænger fuldstændig
     * ved r = 5. Rumtiden krummer hårdere jo længere ind man kommer, så
     * skridtet skal skrumpe i takt. Uden det her flyver kameraet ud i
     * r = 10^7 et par tiendedele efter horisonten — set med egne øjne.
     *
     * Kriteriet er det samme som shaderen bruger på fotonerne: skridtet
     * skaleres med r og divideres med hvor hurtigt tilstanden bevæger sig.
     */
    advance(dTau) {
        if (!this.valid) return;

        let remaining = dTau;
        let guard = 0;
        while (remaining > 1e-12 && guard++ < 512) {
            const d = this._dxdl(this.pos.x, this.pos.y, this.pos.z,
                this.mom.x, this.mom.y, this.mom.z);
            const speed = Math.hypot(d.x, d.y, d.z);
            const r = this.r;

            // Skridtet skal være en lille brøkdel af den afstand hvorover
            // geometrien ændrer sig — og den skala ER r. Faktoren 0.02 er
            // fundet ved at skrue ned indtil H holdt sig på -1/2 hele vejen
            // ind til ringen, ikke ved at gætte.
            const h = Math.min(
                remaining,
                Math.max(1e-7, Math.min(0.05, 0.02 * r / Math.max(speed, 1e-3)))
            );
            this.step(h);
            remaining -= h;

            // ── Her stopper fysikken, og det er ikke en bug ──
            // Tæt på ringen divergerer krumningen ægte. |p| er allerede
            // over 1000 her, og H begynder at drive fra -1/2 uanset hvor
            // små skridt man tager — det er ikke integratoren der giver
            // op, det er singulariteten der er ægte.
            //
            // Kerr-Schild-koordinater kan i øvrigt kun repræsentere r >= 0.
            // Den berømte "negativ-r-region" på den anden side af ringen
            // ligger på et andet ark af løsningen, som de her koordinater
            // slet ikke dækker. Så: vi integrerer så langt som der ER
            // matematik, og fortolker resten.
            if (this.r < DiveGeodesic.R_STOP_FACTOR * this.M) {
                this.valid = false;
                break;
            }
        }
    }

    /**
     * Massekravet H = -1/2 er en andengradsligning i pt. ABC-formlen igen,
     * men med et ekstra +1 under roden i forhold til lysets version.
     * Minus-roden = fremad i tid.
     */
    _solvePt() {
        const { x, y, z } = this.pos;
        const p = this.mom;
        const m = metricAt(x, y, z, this.M, this.a);
        const L = m.lx * p.x + m.ly * p.y + m.lz * p.z;
        const p2 = p.x * p.x + p.y * p.y + p.z * p.z;
        // disc = (1+f)|p|² - f L²  + (1+f)   ← det sidste led er massen
        const disc = (1 + m.f) * p2 - m.f * L * L + (1 + m.f);
        return (m.f * L - Math.sqrt(Math.max(disc, 0))) / (1 + m.f);
    }

    /** dt/dλ = ∂H/∂pt. Den her eksploderer ved horisonten — det er meningen. */
    dtdl() {
        const m = metricAt(this.pos.x, this.pos.y, this.pos.z, this.M, this.a);
        const S = m.lx * this.mom.x + m.ly * this.mom.y + m.lz * this.mom.z - this.pt;
        return -this.pt + m.f * S;
    }

    /** Kerr-Schild-radius lige nu. */
    get r() {
        return ksR(this.pos.x, this.pos.y, this.pos.z, this.a);
    }

    get horizon() {
        return outerHorizon(this.M, this.a);
    }

    /**
     * Koordinat-3-hastigheden, dx/dt. Bruges til relativistisk aberration
     * i shaderen: når man falder hurtigt, klumper himlen sig sammen forud.
     */
    velocity() {
        const d = this._dxdl(this.pos.x, this.pos.y, this.pos.z,
            this.mom.x, this.mom.y, this.mom.z);
        const dt = this.dtdl();
        // Nær horisonten går dt/dλ mod uendelig, så v går mod 0 i
        // koordinater. Vi clamper for at holde aberrationen visuelt i live —
        // det er et bevidst kunstnerisk greb, ikke en fejl.
        const s = 1 / Math.max(Math.abs(dt), 1e-4);
        return { x: d.x * s, y: d.y * s, z: d.z * s };
    }

    /**
     * Bevaret størrelse til sanity-check: H skal blive ved med at være
     * -1/2 hele vejen ned. Hvis den driver, er skridtet for stort.
     */
    hamiltonianCheck() {
        return hamiltonian(
            this.pos.x, this.pos.y, this.pos.z,
            this.mom.x, this.mom.y, this.mom.z,
            this.pt, this.M, this.a);
    }
}

// =====================================================================
//  Tetraden — fire stive linealer i et gummirum
// =====================================================================

/**
 * Prikprodukt mellem to firevektorer, målt med Kerr-metrikken.
 * Format: [t, x, y, z].
 */
export function dotG(pos, M, a, A, B) {
    const m = metricAt(pos.x, pos.y, pos.z, M, a);
    const lA = A[0] + m.lx * A[1] + m.ly * A[2] + m.lz * A[3];
    const lB = B[0] + m.lx * B[1] + m.ly * B[2] + m.lz * B[3];
    return -A[0] * B[0]
         + A[1] * B[1] + A[2] * B[2] + A[3] * B[3]
         + m.f * lA * lB;
}

/** Observatørens firehastighed. H = -1/2 garanterer at u·u = -1. */
export function fourVelocity(pos, mom, pt, M, a) {
    const m = metricAt(pos.x, pos.y, pos.z, M, a);
    const S = m.lx * mom.x + m.ly * mom.y + m.lz * mom.z - pt;
    return [
        -pt + m.f * S,
        mom.x - m.f * S * m.lx,
        mom.y - m.f * S * m.ly,
        mom.z - m.f * S * m.lz,
    ];
}

/**
 * Løser H = -1/2 for pt i et vilkårligt (pos, mom)-par.
 *
 * Hvorfor det er nødvendigt: to punkter PÅ en geodæt opfylder begge
 * H = -1/2, men punktet midt imellem dem gør ikke — ligesom midtpunktet
 * mellem to punkter på en cirkel ikke ligger på cirklen. Tæt på ringen
 * krummer banen så hårdt at et interpoleret par giver H = 34 i stedet
 * for -1/2, og så er tetraden bygget på noget der ikke er en observatør.
 *
 * Ved at løse pt lokalt får vi et par der ER gyldigt. Det er ikke helt
 * den samme observatør som geodætens, men forskellen er mindre end
 * afstanden mellem to samples, og den er GLAT.
 */
export function solvePtAt(pos, mom, M, a) {
    const m = metricAt(pos.x, pos.y, pos.z, M, a);
    const L = m.lx * mom.x + m.ly * mom.y + m.lz * mom.z;
    const p2 = mom.x * mom.x + mom.y * mom.y + mom.z * mom.z;
    const disc = (1 + m.f) * p2 - m.f * L * L + (1 + m.f);
    return (m.f * L - Math.sqrt(Math.max(disc, 0))) / (1 + m.f);
}

/**
 * Gram-Schmidt: tag tre skæve retninger, træk de dele ud af dem der
 * peger langs noget vi allerede har, og normalisér. Klassisk lineær
 * algebra, eneste særhed er at e0 har længde -1 i stedet for +1.
 */
export function buildTetrad(pos, mom, pt, M, a,
                            seeds = [[1,0,0], [0,1,0], [0,0,1]]) {
    const dot = (A, B) => dotG(pos, M, a, A, B);
    const add = (A, B, s) => [A[0]+s*B[0], A[1]+s*B[1], A[2]+s*B[2], A[3]+s*B[3]];

    const e0 = fourVelocity(pos, mom, pt, M, a);
    const basis = [e0];

    for (const s of seeds) {
        const seed = [0, s[0], s[1], s[2]];
        // e0·e0 = -1, så fortegnet vender i forhold til de andre
        let v = add(seed, e0, dot(e0, seed));
        for (let k = 1; k < basis.length; k++) {
            v = add(v, basis[k], -dot(basis[k], v));
        }
        const n2 = dot(v, v);
        
        if (!(n2 > 1e-9)) {
            // Degenereret seed. At springe over ville give et array på tre,
            // og så krakker pack() langt væk herfra med en ubrugelig besked.
            // Bedre: fejl her, hvor årsagen er.
            throw new Error('[dive] tetrad degenereret ved r=' +
                ksR(pos.x, pos.y, pos.z, a).toFixed(3));
        }
        const q = 1 / Math.sqrt(n2);
        basis.push([v[0]*q, v[1]*q, v[2]*q, v[3]*q]);
    }
    return basis;
}

/** De ti tal der beviser at tetraden er en tetrade. */
export function checkTetrad(pos, M, a, tet) {
    const want = [-1, 1, 1, 1];
    let worst = 0;
    for (let i = 0; i < 4; i++)
        for (let j = i; j < 4; j++) {
            const got = dotG(pos, M, a, tet[i], tet[j]);
            const exp = i === j ? want[i] : 0;
            worst = Math.max(worst, Math.abs(got - exp));
        }
    return worst;
}