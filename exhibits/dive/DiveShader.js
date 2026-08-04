// =====================================================================
// exhibits/dive/DiveShader.js. Explore at your own peril
//
// To renderere i én shader, krydsfadet af uInside:
//
//   UDENFOR  — Kerr-geodæter per pixel. Samme Hamilton-maskine som
//              Kerr_finalBoss, men med relativistisk aberration oveni,
//              fordi kameraet nu bevæger sig hurtigt. Det er aberrationen
//              der får himlen til at klumpe sig forud og skyggen til at
//              SKRUMPE på vej ind, i stedet for at sluge synsfeltet.
//
//   INDENFOR — fortolkning. Der findes ingen statisk observatør indenfor
//              horisonten at trace baglæns fra, så baglæns-raytracing
//              holder op med at betyde noget. Det der er
//              tilbage af ægte fysik derinde er geometrien: hvor ringen
//              ligger, hvilken vej "ud" er, og at alt lys udefra bliver
//              blåforskudt og klemt sammen. Resten er tegnet.
//
//   BEYOND   — det univers på den anden side af ormehullet. Genereres
//              proceduralt som en funktion af RETNING, ikke af skærm-
//              koordinater. Det er hele forskellen mellem "et sted" og
//              "et klistermærke på linsen": et fladt billede følger med
//              når man drejer kameraet, et retningsfelt gør ikke.
// =====================================================================

import * as THREE from 'three';

export function createDiveMaterial({ starfield, rs, spin, width, height, coldness = 0.45 }) {
    return new THREE.ShaderMaterial({
        uniforms: {
            uStarfield:  { value: starfield },
            uResolution: { value: new THREE.Vector2(width, height) },

            // Kamera — alt sammen i Kerr-Schild-koordinater (spin om z).
            uCamPos:   { value: new THREE.Vector3(0, 0, 0) },
            uCamFwd:   { value: new THREE.Vector3(0, 0, -1) },
            uCamRight: { value: new THREE.Vector3(1, 0, 0) },
            uCamUp:    { value: new THREE.Vector3(0, 1, 0) },
            uFov:      { value: 62.0 },

            // Kameraets koordinat-3-hastighed. Driver aberrationen.
            uVel: { value: new THREE.Vector3(0, 0, 0) },

            // Retningen "ud" — dér hvor universet vi forlod ligger.
            uOutDir: { value: new THREE.Vector3(1, 0, 0) },

            uRs:        { value: rs },
            uSpin:      { value: spin },
            uTime:      { value: 0.0 },
            uDiskIn:    { value: rs * 1.2 },
            uDiskOut:   { value: rs * 5.5 },
            uColdness:  { value: coldness },

            // ── Fortællings-uniforms ──
            uInside:  { value: 0.0 },  // 0 udenfor, 1 helt over i interiøret
            uDepth:   { value: 0.0 },  // 0 ved horisont → 1 ved ringen
            uPass:    { value: 0.0 },  // ringpassagen, 0 → 1
            uFlash:   { value: 0.0 },  // hvidt glimt i selve passagen

            uMaxSteps: { value: 260.0 },
            uRayStop: { value: 7.6 },
            uDebug: { value: 0.0 },

            // Hvor langt vi er fløjet ind i det nye univers.
            uBeyondTravel: { value: 0.0 },

            // tetrad arms or directions. Or whatever. 
            uE0: { value: new THREE.Vector4(0,0,0,1) },
            uE1: { value: new THREE.Vector4(1,0,0,0) },
            uE2: { value: new THREE.Vector4(0,1,0,0) },
            uE3: { value: new THREE.Vector4(0,0,1,0) },
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
            uniform vec3  uCamPos, uCamFwd, uCamRight, uCamUp;
            uniform vec3  uVel, uOutDir;
            uniform float uFov, uRs, uSpin, uTime;
            uniform float uDiskIn, uDiskOut, uColdness;
            uniform float uInside, uDepth, uPass, uFlash;
            uniform float uBeyondTravel;
            varying vec2 vUv;

            uniform float uMaxSteps;
            uniform float uRayStop, uDebug;

            uniform vec4 uE0, uE1, uE2, uE3; // .xyz = space, .w = time. Spacetime 

            #define MAX_STEPS   260
            #define ESCAPE_DIST 160.0
            #define PI 3.14159265358979

            // Verden har y opad; Kerr-Schild har spin om z. Ren rotation.
            vec3 fromKS(vec3 v) { return vec3(v.x, v.z, -v.y); }

            vec2 dirToEquirect(vec3 dir) {
                dir = normalize(dir);
                float u = 0.5 + atan(dir.z, dir.x) / (2.0 * PI);
                float v = 0.5 - asin(clamp(dir.y, -1.0, 1.0)) / PI;
                return vec2(u, v);
            }

            vec3 skyColor(vec3 ksDir) {
                return texture2D(uStarfield, dirToEquirect(fromKS(ksDir))).rgb;
            }

            // ── Kerr-Schild ────────────────────────────────────────────
            float ksR(vec3 x, float a) {
                float rho2 = dot(x, x);
                float b    = rho2 - a * a;
                float r2   = 0.5 * (b + sqrt(b * b + 4.0 * a * a * x.z * x.z));
                return sqrt(max(r2, 1e-6));
            }

            struct Metric { float f; vec3 l; };

            Metric metricAt(vec3 x) {
                float M  = 0.5 * uRs;
                float a  = uSpin * M;
                float r  = ksR(x, a);
                float r2 = r * r;
                Metric m;
                m.f = 2.0 * M * r2 * r / (r2 * r2 + a * a * x.z * x.z);
                m.l = vec3((r * x.x + a * x.y) / (r2 + a * a),
                           (r * x.y - a * x.x) / (r2 + a * a),
                           x.z / r);
                return m;
            }

            float hamiltonian(vec3 x, vec3 p, float pt) {
                Metric m = metricAt(x);
                float  S = dot(m.l, p) - pt;
                return 0.5 * (-pt * pt + dot(p, p) - m.f * S * S);
            }

            vec3 dxdl(vec3 x, vec3 p, float pt) {
                Metric m = metricAt(x);
                float  S = dot(m.l, p) - pt;
                return p - m.f * S * m.l;
            }

            vec3 dpdl(vec3 x, vec3 p, float pt) {
                const float eps = 0.01;
                vec3 g;
                g.x = hamiltonian(x + vec3(eps,0.0,0.0), p, pt) - hamiltonian(x - vec3(eps,0.0,0.0), p, pt);
                g.y = hamiltonian(x + vec3(0.0,eps,0.0), p, pt) - hamiltonian(x - vec3(0.0,eps,0.0), p, pt);
                g.z = hamiltonian(x + vec3(0.0,0.0,eps), p, pt) - hamiltonian(x - vec3(0.0,0.0,eps), p, pt);
                return -g / (2.0 * eps);
            }

            struct Deriv { vec3 dx; vec3 dp; };
            Deriv deriv(vec3 x, vec3 p, float pt) {
                Deriv d; d.dx = dxdl(x,p,pt); d.dp = dpdl(x,p,pt); return d;
            }

            // ── Støj ───────────────────────────────────────────────────
            float hash21(vec2 p) {
                p = fract(p * vec2(123.34, 456.21));
                p += dot(p, p + 45.32);
                return fract(p.x * p.y);
            }

            // 3D-udgaven. Tre tal ind, tre tilfældige tal ud — men altid
            // DE SAMME tre for det samme input. Det er hele pointen med
            // en hash: den lader os "huske" en galakses egenskaber uden
            // at gemme dem nogen steder. Vi genberegner dem hver frame.
            vec3 hash33(vec3 p) {
                p = fract(p * vec3(0.1031, 0.1030, 0.0973));
                p += dot(p, p.yxz + 33.33);
                return fract((p.xxy + p.yxx) * p.zyx);
            }

            float vnoise(vec2 p) {
                vec2 i = floor(p), f = fract(p);
                f = f * f * (3.0 - 2.0 * f);
                return mix(mix(hash21(i), hash21(i+vec2(1.0,0.0)), f.x),
                           mix(hash21(i+vec2(0.0,1.0)), hash21(i+vec2(1.0,1.0)), f.x), f.y);
            }

            float fbm(vec2 p) {
                float v = 0.0, a = 0.5;
                for (int i = 0; i < 5; i++) { v += a * vnoise(p); p = p * 2.1 + 17.3; a *= 0.5; }
                return v;
            }

            float diskPattern(float r, float ang, float Om) {
                float SPEED = 14.0, T = 3.0;
                float t1 = mod(uTime, T), t2 = mod(uTime + 0.5*T, T);
                float w  = abs(t1 / T * 2.0 - 1.0);
                float p1 = ang - Om * t1 * SPEED, p2 = ang - Om * t2 * SPEED;

                // Radius i STØJ-koordinater voksede før ikke med r — hele
                // skivens omkreds blev presset ned på samme lille cirkel
                // uanset fysisk størrelse, så tæt på kameraet dækkede en
                // håndfuld støjceller hele vejen rundt. Nu vokser cirklen
                // med r, så flere celler kommer i spil jo større omkredsen
                // faktisk er — det er den der giver den finkornede,
                // fotografiske tekstur i stedet for bløde klatter.
                float ringNoise = 1.6 + 0.14 * r;
                vec2 q1 = vec2(r*1.1, 0.0) + ringNoise * vec2(cos(p1), sin(p1));
                vec2 q2 = vec2(r*1.1, 0.0) + ringNoise * vec2(cos(p2), sin(p2));
                return mix(fbm(q1), fbm(q2), w);
            }

            // ── Akkretionsskiven ───────────────────────────────────────
            // g-faktoren pakker Doppler beaming OG gravitationel
            // rødforskydning i ét tal, regnet direkte ud af fotonens
            // bevarede E og Lz.
            vec4 diskSample(vec3 xc, vec3 p, float pt) {
                float M = 0.5 * uRs;
                float a = uSpin * M;
                float r = ksR(xc, a);
                if (r < uDiskIn || r > uDiskOut) return vec4(0.0);

                float Om = sqrt(M) / (pow(r, 1.5) + a * sqrt(M));
                float ut = 1.0 / sqrt(max(1.0 - 3.0*M/r + 2.0*a*sqrt(M)/pow(r,1.5), 0.02));

                float E  = -pt;
                float Lz = xc.x * p.y - xc.y * p.x;
                float g  = E / max(ut * (E - Om * Lz), 0.05);

                float R0   = uRs * 1.5;
                float heat = pow(R0 / r, 1.5) * sqrt(max(1.0 - sqrt(uDiskIn / r), 0.0));

                float ang = atan(xc.y, xc.x);
                float sw  = 0.45 + 1.1 * diskPattern(r, ang, Om);

                vec3 hotCol  = mix(vec3(1.0,0.93,0.78), vec3(1.0,0.55,0.20), uColdness);
                vec3 coolCol = mix(vec3(1.0,0.35,0.08), vec3(0.75,0.15,0.03), uColdness);
                vec3 col = mix(coolCol, hotCol, clamp(heat, 0.0, 1.0));
                float lum = (0.25 + 2.6 * heat) * sw;

                lum *= pow(clamp(g, 0.35, 2.2), 3.0);
                col  = mix(col * vec3(1.25,0.75,0.55), col * vec3(0.85,0.95,1.35),
                           smoothstep(0.8, 1.3, g));

                float edge = smoothstep(uDiskIn, uDiskIn*1.15, r)
                           * (1.0 - smoothstep(uDiskOut*0.75, uDiskOut, r));

                // was "return vec4(col * lum * edge, 0.9 * edge);", disable the disk for testing
                return vec4(0.0);
            }

            // =========================================================
            //  DET NYE UNIVERS - Efter singulariteten
            // =========================================================
            //
            // Ét lag galakser, fordelt på en kugleskal i afstanden R.
            //
            // Opskriften er den samme som al proceduel gitterstøj, og
            // det er værd at kende, for den dukker op overalt:
            //
            //   1. Tag punktet, gang op med scale, og floor() det.
            //      Nu har du et heltals-CELLE-id.
            //   2. Hash celle-id'et. Nu har du tilfældige, men STABILE
            //      egenskaber for lige præcis den celle.
            //   3. Læg ét objekt i cellen, jitret med hash-værdien så
            //      gitteret ikke kan ses.
            //   4. Kig også i nabocellerne, for objektet i naboen kan
            //      godt række ind over grænsen til din egen.
            //
            // Trin 4 er 3×3×3 = 27 opslag. Det lyder dyrt, men husk at
            // hele raymarch-loopet (260 RK4-skridt) er slået fra her
            // inde, så vi har rigeligt budget.
            vec3 galaxyShell(vec3 dir, vec3 camOff, float R, float scale, float seed) {
                // HER ligger parallaksen. camOff er kameraets forskydning.
                // For en nær skal (lille R) flytter den samme forskydning
                // synsretningen meget; for en fjern skal næsten intet.
                // Det er præcis sådan dybde ser ud i virkeligheden.
                vec3 hit  = normalize(camOff + dir * R);

                vec3 p    = hit * scale;
                vec3 base = floor(p);
                vec3 acc  = vec3(0.0);

                for (int i = -1; i <= 1; i++)
                for (int j = -1; j <= 1; j++)
                for (int k = -1; k <= 1; k++) {
                    vec3 cell = base + vec3(float(i), float(j), float(k));
                    vec3 h1 = hash33(cell + seed);

                    // Langt fra alle celler indeholder en galakse. Uden
                    // det her bliver himlen en jævn grød i stedet for
                    // spredte objekter med tomrum imellem.
                    if (h1.x > 0.5) continue;

                    vec3 h2 = hash33(cell + seed + 19.73);

                    // Galaksens position: cellens midte, jitret, og så
                    // projiceret tilbage ud på kugleskallen.
                    vec3 g  = normalize(cell + 0.5 + (h2 - 0.5) * 0.85) * scale;
                    vec3 gd = normalize(g);

                    // Tangentplan ved galaksen, så den kan få en FORM.
                    // Uden det her er hver galakse en rund klat, og runde
                    // klatter ligner stjerner, ikke galakser.
                    vec3 t1 = normalize(cross(gd, vec3(0.0, 0.0, 1.0)) + vec3(1e-4, 1e-4, 0.0));
                    vec3 t2 = cross(gd, t1);

                    vec3 d3 = p - g;
                    vec2 q  = vec2(dot(d3, t1), dot(d3, t2));

                    // Tilfældig rotation i planet
                    float ang = h1.y * 6.28318;
                    float ca = cos(ang), sa = sin(ang);
                    q = vec2(q.x * ca - q.y * sa, q.x * sa + q.y * ca);

                    // Inklination: en skive set skråt fra er en ellipse.
                    // Divisionen presser den ene akse sammen, så vi får
                    // alt fra flad kant-på-streg til rund face-on skive.
                    q.y /= mix(0.16, 1.0, h1.z);

                    float size = mix(0.09, 0.38, h2.x * h2.x);
                    float d    = length(q) / size;
                    if (d > 2.5) continue;

                    // Kerne + halo. To gaussere med vidt forskellig
                    // bredde er nok til at det ligner et objekt med
                    // en lysende midte i stedet for en tåge.
                    float halo = exp(-d * d * 2.0);
                    float core = exp(-d * d * 24.0);

                    // Rødforskydning. Det her er faktisk hvad et ægte
                    // deep field VISER: de fjerneste galakser er rødere
                    // og svagere, fordi lyset er strakt af universets
                    // udvidelse undervejs. Indholdet er opdigtet — men
                    // statistikken er rigtig.
                    float z   = h2.y;
                    vec3  col = mix(vec3(0.62, 0.78, 1.00),
                                    vec3(1.00, 0.52, 0.28), z);

                    acc += col * (halo * 0.5 + core * 2.0) * mix(1.0, 0.22, z);
                }
                return acc;
            }

            // Tre skaller i forskellig afstand. Det er dybden.
            vec3 deepField(vec3 dir, vec3 camOff) {
                vec3 col = vec3(0.0);
                col += galaxyShell(dir, camOff, 12.0, 30.0,  3.00) * 1.00;
                col += galaxyShell(dir, camOff, 34.0, 46.0, 17.00) * 0.55;
                col += galaxyShell(dir, camOff, 90.0, 70.0, 41.00) * 0.28;

                // De uopløste. I et ægte deep field er der aldrig helt
                // sort mellem galakserne — der er bare flere, for små
                // til at skille ad.
                col += vec3(0.018, 0.022, 0.040);
                return col;
            }

            // =========================================================
            //  INTERIØRET
            // =========================================================

            // Ringsingulariteten er ægte geometri: cirklen z = 0,
            // x² + y² = a². Ikke et punkt — en ring. Det er DEN detalje
            // der gør et roterende sort hul mærkeligere end et statisk.
            float ringGlow(vec3 x, vec3 dir, float a) {
                if (abs(dir.z) < 1e-4) return 0.0;
                float t = -x.z / dir.z;
                if (t < 0.0) return 0.0;
                vec3 q = x + t * dir;
                float d = abs(length(q.xy) - a);
                float w = 0.10 * a * (1.0 - 0.75 * uDepth);   // skarpere jo tættere
                return exp(-(d*d) / (w*w + 1e-6)) / (1.0 + 0.02 * t * t);
            }

            // Stablede spøgelsesbilleder af det univers man forlod.
            // Samme idé som fotonring-stigen udenfor: lys der har viklet
            // sig rundt n gange, hver kopi svagere end den før.
            vec3 layeredSky(vec3 dir, vec3 outDir, float depth) {
                vec3 acc = vec3(0.0);
                float w = 1.0;
                for (int k = 0; k < 4; k++) {
                    float bend = float(k) * (0.22 + 0.5 * depth);
                    vec3 d = normalize(mix(dir, outDir, clamp(bend, 0.0, 0.92)));
                    acc += w * skyColor(d);
                    w *= 0.34;
                }
                return acc;
            }

            vec3 interior(vec3 x, vec3 dir) {
                float M = 0.5 * uRs;
                float a = uSpin * M;
                vec3 outDir = normalize(uOutDir);

                float mu = dot(dir, outDir);          // 1 = kigger "op", tilbage mod universet
                float depth = clamp(uDepth, 0.0, 1.0);

                // ── Vinduet ud ──
                // Universet udenfor klemmes sammen til en plet i den
                // udadgående retning, og den plet skrumper. Det her er
                // den ene ting ved interiøret der IKKE er opfundet:
                // udsigten ud bliver smallere og blåere, hele vejen ned.
                float aperture = mix(0.15, 0.93, depth * depth);
                float win = smoothstep(aperture, min(aperture + 0.20, 0.999), mu);

                // Komprimér himlen ind i vinduet, så hele udsigten
                // stadig er dér — bare mast sammen.
                float squeeze = mix(1.0, 7.0, depth);
                vec3 sampleDir = normalize(mix(outDir, dir, 1.0 / squeeze));
                vec3 sky = layeredSky(sampleDir, outDir, depth);

                // Blåforskydning: alt udefra rammer os hårdere jo dybere vi er.
                vec3 blue = vec3(0.55, 0.82, 1.6);
                sky *= mix(vec3(1.0), blue, depth) * (1.0 + 5.0 * depth);

                vec3 col = sky * win;

                // ── Foldet rumtid ──
                // Strømmende filamenter omkring faldretningen. Ren tegning,
                // men den bevæger sig som noget der bliver trukket forbi.
                //
                // Bemærk: INGEN atan2 her. En tidligere version brugte
                // atan(dot(dir,ay), dot(dir,ax)) som støjkoordinat, men
                // atan2 springer fra +π til −π, og fbm() er ikke periodisk —
                // så præcis dér hvor vinklen hopper 2π, hopper støjen også,
                // brat. Det gav en synlig søm tværs over billedet. Ved at
                // bruge de rå basis-komponenter (rene kartesiske tal, ingen
                // wrap) forsvinder sømmen, fordi der ikke er noget spring
                // at ramme.
                vec3 ax = normalize(cross(outDir, vec3(0.0, 0.0, 1.0)) + vec3(1e-3));
                vec3 ay = normalize(cross(outDir, ax));
                vec2  pl = vec2(dot(dir, ax), dot(dir, ay));
                float rad = acos(clamp(mu, -1.0, 1.0));

                // Roter selve planet med tiden i stedet for at skubbe til en
                // vinkel-skalar — det er det der giver "strømningen", uden
                // at genindføre en wrap-diskontinuitet.
                float spin = uTime * (0.6 + 1.8 * depth);
                float cs = cos(spin), sn = sin(spin);
                vec2 pr = vec2(pl.x * cs - pl.y * sn, pl.x * sn + pl.y * cs);

                float flow = fbm(pr * 2.6 + vec2(0.0, rad * 3.4))
                           * fbm(pr * 5.3 + vec2(9.0, rad * 7.0) - uTime * 0.4);
                float streak = pow(clamp(flow, 0.0, 1.0), 1.6) * (0.25 + 1.3 * depth);

                vec3 foldA = vec3(0.28, 0.14, 0.55);   // violet, højt oppe
                vec3 foldB = vec3(0.20, 0.75, 1.00);   // cyan, dybt nede
                col += mix(foldA, foldB, depth) * streak * (1.0 - win);

                // ── Ringen ──
                float ring = ringGlow(x, dir, a);
                vec3 ringCol = mix(vec3(1.0, 0.72, 0.30), vec3(0.85, 0.95, 1.0), depth);
                col += ringCol * ring * (0.6 + 14.0 * depth * depth);

                // Den vej kameraet faktisk VENDER under passagen. Kameraet
                // ser mod origo, og uOutDir peger fra origo ud mod kameraet,
                // så synsretningen er den modsatte. Uden det her ville det
                // nye univers åbne sig bag ryggen på publikum.
                vec3 viewDir = -outDir;

                // ── Den anden side ──
                if (uPass > 0.0) {
                    float p = clamp(uPass, 0.0, 1.0);

                    // Ormehullets hals: en kegle der vokser fra ingenting
                    // til hele himlen. Tjek yderpunkterne — det er den
                    // eneste måde ikke at vende fortegnet forkert:
                    //   p = 0 → smoothstep(1.2, 0.8, mu), og mu ≤ 1 → 0
                    //   p = 1 → smoothstep(-0.8, -1.2, mu)          → 1
                    float W = 0.12;
                    float t = mix(1.0 + W, 0.30 - W, p);
                    float newSky = smoothstep(t - W, t + W, dot(dir, viewDir));

                    vec3 df = deepField(dir, viewDir * uBeyondTravel);

                    // Amber-gløden sidder nu i selve keglens KANT og
                    // rejser udad med den, i stedet for at ligge som et
                    // jævnt lag over hele billedet. rim er størst dér hvor
                    // newSky er halvvejs, altså præcis på overgangen.
                    float rim  = newSky * (1.0 - newSky) * 4.0;
                    float glow = 1.0 - smoothstep(0.0, 0.75, p);
                    df += vec3(1.0, 0.62, 0.22) * rim
                        * (0.35 + 1.6 * pow(clamp(flow, 0.0, 1.0), 1.2)) * glow;

                    col = mix(col, df, newSky);
                }

                // ── Udkastningen ──
                // Et hvidt hul er tidsomvendingen af et sort: intet kan
                // komme IND, alt bevæger sig UDAD. Derfor stråler fra
                // centrum og udefter, ikke et jævnt blitz.
                //
                // Før hang det her på vUv, altså på skærmen. Så sad
                // strålerne fast på linsen når man bevægede musen. Nu er
                // qrad vinkelafstanden fra synsretningen og qang vinklen
                // i den samme basis som foldene bruger — begge dele er
                // bundet til VERDEN, så strålerne bliver liggende hvor
                // de hører til når kameraet drejer.
                float qrad = acos(clamp(dot(dir, viewDir), -1.0, 1.0)) * 2.2;
                float qang = atan(pl.y, pl.x);

                // Vinklen ganges OP, radius ned. Det gør støjen tæt i
                // vinkel og udstrakt i radius — og dét er hvad der laver
                // stråler i stedet for klatter.
                float rays = fbm(vec2(qang * 3.2, qrad * 0.5 - uTime * 1.4));
                rays = pow(clamp(rays, 0.0, 1.0), 1.8);

                float core  = exp(-qrad * qrad * 2.2);
                float burst = core + rays * smoothstep(0.1, 1.1, qrad) * 0.8;

                col += vec3(1.0, 0.97, 0.92) * uFlash * (1.5 + 3.5 * burst);

                return col;
            }

            // =========================================================
            void main() {

                vec2 ndc = vUv * 2.0 - 1.0;
                ndc.x *= uResolution.x / uResolution.y;
                float halfFovTan = tan(radians(uFov * 0.5));

                // Retningen mod pixlen, målt i kameraets egen ramme.
                vec3 nl = normalize(vec3(ndc.x * halfFovTan,
                                         ndc.y * halfFovTan, 1.0));

                vec3 col = vec3(0.0);
                {
                    float M  = 0.5 * uRs;
                    float a  = uSpin * M;

                    // Fotonen observatøren ser, kommer imod os. Vi følger den bagud
                    // i tiden, altså vender vi den om: k = -e0 + n·(e1,e2,e3).
                    // Minusset på e0 ER "fortidsrettet". Intet at gætte.
                    vec4 k = -uE0 + nl.x * uE1 + nl.y * uE2 + nl.z * uE3;

                    vec3  x  = uCamPos;

                    // Sænk indekset: integratoren regner med p_mu, ikke p^mu.
                    Metric m0 = metricAt(x);
                    float  Lk = k.w + dot(m0.l, k.xyz);
                    float  pt = -k.w + m0.f * Lk;
                    vec3   p  = k.xyz + m0.f * Lk * m0.l;

                    bool escaped = false, dead = false;
                    int steps = 0;

                    vec3 outD = p, emission = vec3(0.0);
                    float trans = 1.0;
                    

                    for (int i = 0; i < MAX_STEPS; i++) {
                        if (float(i) >= uMaxSteps) break;

                        steps++;

                        float r = ksR(x, a);
                        if (r < uRayStop) { dead = true; break; } // was "r < rH * 1.005", changed to "r < 0.5 * M"... and then to r < uRayStop

                        // Stråler der asymptotisk nærmer sig horisonten får
                        // |p| til at eksplodere. De kom fra det uendeligt
                        // fjerne fortid og er uendeligt rødforskudte, altså
                        // sorte. Uden det her driver H til 1e57 og man får NaN.
                        if (dot(p, p) > 1.0e4) { dead = true; break; }

                        Deriv k1 = deriv(x, p, pt);

                        if (r > ESCAPE_DIST || (r > uRs * 8.0 && dot(k1.dx, x) < 0.0)) {
                            escaped = true; outD = k1.dx; break;
                        }

                       float jitter = r > uRs * 4.0
                            ? 0.95 + 0.1 * fract(sin(dot(nl.xy, vec2(12.9898,78.233))) * 43758.5453)
                            : 1.0;

                        float dl = 1.1 * clamp(r / (uRs * 1.5), 0.3, 8.0) * jitter
                                 / max(length(k1.dx), 0.25);

                        Deriv k2 = deriv(x + 0.5*dl*k1.dx, p + 0.5*dl*k1.dp, pt);
                        Deriv k3 = deriv(x + 0.5*dl*k2.dx, p + 0.5*dl*k2.dp, pt);
                        Deriv k4 = deriv(x + dl*k3.dx,     p + dl*k3.dp,     pt);

                        vec3 x0 = x;
                        x += dl/6.0 * (k1.dx + 2.0*k2.dx + 2.0*k3.dx + k4.dx);
                        p += dl/6.0 * (k1.dp + 2.0*k2.dp + 2.0*k3.dp + k4.dp);

                        if (x0.z * x.z < 0.0) {
                            float tC = x0.z / (x0.z - x.z);
                            vec4  d  = diskSample(mix(x0, x, tC), p, pt);
                            emission += trans * d.rgb;
                            trans    *= (1.0 - d.a);
                            if (trans < 0.02) break;
                        }
                    }

                    vec3 bg = vec3(0.0);
                    if (!dead) {
                        // Løb den tør for skridt tæt på hullet, ved vi ikke
                        // hvor den ville ende. So black it is.
                        if (!escaped && ksR(x, a) < uRs * 2.0) {
                            bg = vec3(0.0);
                        } else {
                            if (!escaped) outD = dxdl(x, p, pt);
                            bg = skyColor(outD);
                        }
                    }

                    col = emission + trans * bg;

                    if (uDebug > 0.5) {
                        float fr = float(steps) / uMaxSteps;
                        gl_FragColor = vec4(fr, fr * fr, 1.0 - fr, 1.0);
                        return;
                    }
                }

                col = col / (col + vec3(0.85)) * 1.85;
                gl_FragColor = vec4(col, 1.0);
            }
        `,
        depthWrite: false,
        depthTest:  false,
    });
}