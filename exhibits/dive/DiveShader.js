// =====================================================================
// exhibits/dive/DiveShader.js. Explore at your own peril
//
// Raytrace på hele "rejsen", via ortonormal tetrade (kind of a reference frame).
// Tetraden fungerer lidt som et sæt øjne, der giver mulighed for at trace baglæns fra dem.
// Det er ret smart, fordi der inden for horizonten ikke findes nogen statisk observatør. Cuz everything has to move.
//
// ── Hvad der er skåret væk ───────────────────────────────────────────
// Der lå cirka halvfems linjer GLSL her der lavede et nyt univers:
// galaxyShell() lagde proceduregenererede galakser ud på tre
// kugleskaller, deepField() stablede dem, og en voksende kegle
// erstattede den gamle himmel med den nye under ringpassagen.
// Alt sammen pænt. Alt sammen opdigtet.
//
// Det er væk, fordi faldet ikke længere når frem til ringen. Den indre
// horisont ved r₋ = 0.4732 M er ustabil (mass inflation), og geodæten
// stopper 16% udenfor den. Så i stedet for at fabrikere en passage
// gennem noget der lukker sig, ender exhibittet i det der faktisk sker
// på vej derned: blåforskydningen.
//
// uBlue forstærker den ægte gShift, og fordi vægten er smoothstep på
// gShift selv, tænder randen af den mørke kegle FØRST — dét er stedet
// hvor E_uendelig går mod nul og g mod uendelig. Effekten starter altså
// hvor fysikken siger den skal, og bliver først kunstnerisk når uWhite
// lægger tæppet over.
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

            // Retningen "ud" — dér hvor universet vi forlod ligger.
            uOutDir: { value: new THREE.Vector3(1, 0, 0) },

            // Observatørens bevarede energi A = −u_t. Konstant langs
            // geodæten, men shaderen kan ikke selv regne den ud — den
            // kræver firehastigheden. Sættes fra main.js.
            uAobs: { value: 1.0 },

            uRs:        { value: rs },
            uSpin:      { value: spin },
            uTime:      { value: 0.0 },
            uDiskIn:    { value: rs * 1.2 },
            uDiskOut:   { value: rs * 5.5 },
            uColdness:  { value: coldness },

            // ── Fortællings-uniforms ──
            // uDraw hed uInside og hang på horisontkrydset. Nu hænger den
            // på den mørke kegles åbningsvinkel, som begynder ved
            // ergosfæren og vokser glat forbi horisonten uden knæk.
            // Vægter KUN tegningen.
            uDraw:  { value: 0.0 },
            uDepth: { value: 0.0 },  // 0 ved horisont → 1 hvor integrationen stopper

            // ── Slutningen ──
            uBlue:  { value: 0.0 },   // forstærkning af den ægte blåforskydning
            uWhite: { value: 0.0 },   // hvidt tæppe ovenpå, 0 → 1
            uDim:   { value: 1.0 },   // udbrænding bagefter, 1 → 0

            uMaxSteps: { value: 300.0 },

            uRayStop:  { value: 7.6 },
            uDebug:    { value: 0.0 },

            // Tetraden. Fire firevektorer: .xyz = rum, .w = tid.
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
            uniform vec3  uOutDir;
            uniform float uAobs;
            uniform float uFov, uRs, uSpin, uTime;
            uniform float uDiskIn, uDiskOut, uColdness;
            uniform float uDraw, uDepth;
            uniform float uBlue, uWhite, uDim;
            varying vec2 vUv;

            uniform float uMaxSteps;
            uniform float uRayStop, uDebug;

            uniform vec4 uE0, uE1, uE2, uE3; // .xyz = rum, .w = tid

            // 384 var nok overalt undtagen ét sted: båndet langs
            // skyggekanten hvor stråler wrapper rundt om fotonsfæren.
            // Målt ved r = 1.28 Rs, hvor kameraet står praktisk talt PÅ
            // den prograde fotonsfære: et 10 graders bånd hvor den
            // dyreste stråle bruger 819 skridt. Med 384 blev hele båndet
            // sort, og det er den takkede kant langs skyggen.
            //
            // Loopet brydes så snart strålen slipper ud, så de 95% af
            // pixels der klarer sig på 130-250 skridt betaler ingenting
            // for det højere loft. Det er kun båndet der koster, og det
            // er præcis dér man vil betale.
            #define MAX_STEPS   900
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
                // uanset fysisk størrelse. Nu vokser cirklen med r, så
                // flere celler kommer i spil jo større omkredsen faktisk er.
                float ringNoise = 1.6 + 0.14 * r;
                vec2 q1 = vec2(r*1.1, 0.0) + ringNoise * vec2(cos(p1), sin(p1));
                vec2 q2 = vec2(r*1.1, 0.0) + ringNoise * vec2(cos(p2), sin(p2));
                return mix(fbm(q1), fbm(q2), w);
            }

            // ── Akkretionsskiven ───────────────────────────────────────
            // g-faktoren pakker Doppler beaming OG gravitationel
            // rødforskydning i ét tal, regnet direkte ud af fotonens
            // bevarede E og Lz. Bemærk at den er et FORHOLD mellem to
            // størrelser der begge skalerer med fotonens affine
            // normering — så den er ligeglad med at vi normerer p.
            vec4 diskSample(vec3 xc, vec3 p, float pt) {
                float M = 0.5 * uRs;
                float a = uSpin * M;
                float r = ksR(xc, a);
                if (r < uDiskIn || r > uDiskOut) return vec4(0.0);

                float Om = sqrt(M) / (pow(r, 1.5) + a * sqrt(M));
                float ut = 1.0 / sqrt(max(1.0 - 3.0*M/r + 2.0*a*sqrt(M)/pow(r,1.5), 0.02));

                // ── Fortegnet. Det her var fejlen ──
                // Kerr-exhibittet skyder fotoner FREMAD fra kameraet og
                // løser pt med minus-roden, så pt < 0 og E = -pt > 0.
                // Her tracer vi BAGLÆNS fra tetraden: k = -e0 + n·e_i.
                // Den foton er fortidsrettet, så pt > 0 og E blev NEGATIV.
                //
                // g er i sig selv invariant under et samlet fortegnsskift
                // af (p, pt) — både E og Lz vender, og de to minusser går
                // ud med hinanden. Men max(..., 0.05) i nævneren er ikke
                // invariant: med E < 0 blev hele nævneren negativ, blev
                // klemt op på 0.05, og g endte på sit gulv 0.40 for HVER
                // eneste pixel i skiven.
                //
                // Konsekvensen var to ting på én gang: ingen beaming
                // overhovedet (deraf ingen hvidglødende side), og en fast
                // dæmpning på clamp(0.40)³ ≈ 0.064 gange GAIN, plus at
                // Doppler-farven altid landede på den røde ende.
                float sgn = pt > 0.0 ? -1.0 : 1.0;   // gør fotonen fremadrettet
                float E   = -sgn * pt;
                float Lz  = sgn * (xc.x * p.y - xc.y * p.x);
                float g   = E / max(ut * (E - Om * Lz), 0.05);

                // R0 er den radius hvor "heat" passerer 1, altså hvor
                // skiven regnes som fuldt hvidglødende. Samme profil som
                // Kerr-exhibittet nu: den stejlere eksponent er dét der
                // giver den hvide inderkant og den orange yderkant i
                // stedet for én jævn tone hele vejen ud.
                float R0   = uRs * 1.5;
                float heat = pow(R0 / r, 1.5) * sqrt(max(1.0 - sqrt(uDiskIn / r), 0.0));

                // diskPattern() har middelværdi omkring 0.25, ikke 0.5 —
                // fbm af value noise lander lavere end man tror. Med
                // 0.45 + 1.1·p gav den derfor en gennemsnitlig faktor på
                // 0.72, altså en skjult 28% dæmpning af hele skiven.
                // Nu ligger middelværdien omkring 0.9 og udsvinget er
                // større, så turbulensen faktisk kan ses.
                float ang = atan(xc.y, xc.x);
                float sw  = 0.50 + 1.5 * diskPattern(r, ang, Om);

                // uColdness = 0 er en hvidglødende skive, 1 er en
                // udbrændt rød. Begge endepunkter er varmet op: coolCol's
                // kolde ende var (0.75,0.15,0.03), som er mere tørt blod
                // end glødende metal. Nu er selv den kolde ende orange.
                vec3 hotCol  = mix(vec3(1.00,0.97,0.90), vec3(1.00,0.72,0.36), uColdness);
                vec3 coolCol = mix(vec3(1.00,0.60,0.26), vec3(0.96,0.36,0.11), uColdness);
                vec3 col = mix(coolCol, hotCol, clamp(heat, 0.0, 1.0));
                float lum = (0.40 + 3.0 * heat) * sw;

                // ── Beaming ──
                // g ligger under 1 næsten overalt, fordi den gravitationelle
                // rødforskydning trækker hele skiven ned uanset hvilken vej
                // gassen bevæger sig. I tredje potens blev det en konstant
                // dæmpning på 2-3x oven i alting.
                //
                // GAIN sætter niveauet tilbage uden at røre kontrasten.
                // Forholdet mellem den kommende og den vigende side er
                // stadig det ægte, omkring 10:1 — det er kun nulpunktet
                // der er valgt. Det her er lysstyrkeknappen.
                const float GAIN = 0.6;
                lum *= GAIN * pow(clamp(g, 0.40, 2.4), 3.0);
                // Doppler-farven. Den vigende side må gerne rødne, men
                // den skal ikke slukkes: 0.75/0.55 på g og b trak den ned
                // i det bordeaux igen. Mildere nu.
                col  = mix(col * vec3(1.22,0.80,0.60), col * vec3(0.86,0.95,1.35),
                           smoothstep(0.8, 1.3, g));

                // Ydrekanten faded fra 0.75·uDiskOut, altså over den
                // yderste fjerdedel. Sammen med den stejle heat gjorde
                // det hele den ydre ring til en mørk brun bræmme.
                float edge = smoothstep(uDiskIn, uDiskIn*1.15, r)
                           * (1.0 - smoothstep(uDiskOut*0.88, uDiskOut, r));

                return vec4(col * lum * edge, 0.9 * edge);
            }

            // =========================================================
            //  TEGNINGEN OVENPÅ
            // =========================================================

            // Ringsingulariteten er ægte geometri: cirklen z = 0,
            // x² + y² = a². Ikke et punkt — en ring. Vi når den aldrig,
            // men vi kan se den nedefra og ind gennem de sidste sekunder.
            float ringGlow(vec3 x, vec3 dir, float a) {
                if (abs(dir.z) < 1e-4) return 0.0;
                float t = -x.z / dir.z;
                if (t < 0.0) return 0.0;
                vec3 q = x + t * dir;
                float d = abs(length(q.xy) - a);
                float w = 0.10 * a * (1.0 - 0.75 * uDepth);   // skarpere jo tættere
                return exp(-(d*d) / (w*w + 1e-6)) / (1.0 + 0.02 * t * t);
            }

            /**
             * Alt det der ER tegnet, lagt OVEN PÅ det raytracede billede.
             *
             * base er pixlens fysiske svar. Den bliver aldrig kastet væk,
             * kun lagt til.
             *
             * dir er den ikke-aberrerede synsretning (kameraets egen basis).
             * Det er med vilje: aberrationen presser alle pixels ned i en
             * brøkdel af en grad tæt på slutningen, og tegnede elementer der
             * fulgte MED den ville kollapse til ét punkt. Fysikken skal
             * aberrere. Pynten skal kunne ses.
             */
            vec3 interiorFX(vec3 x, vec3 dir, vec3 base,
                            float coneS, float notSky) {
                float M = 0.5 * uRs;
                float a = uSpin * M;
                vec3 outDir  = normalize(uOutDir);
                float depth  = clamp(uDepth, 0.0, 1.0);
                float w      = clamp(uDraw,  0.0, 1.0);

                vec3 col = base;

                // ── Hvor må der overhovedet tegnes? ──
                // Luminans alene duer ikke som maske. Stjernehimlen er
                // MØRK i tal — typisk 0.02-0.05 — og bliver først lys af
                // tonemapperen bagefter. Så "dark" stod på ~0.95 selv midt
                // i vinduet ud til universet, og både ringen og folderne
                // sivede henover det.
                //
                // Masken kom før fra ét flag: "blev der samplet en himmel
                // her?". Det slog to helt forskellige slags mørke sammen.
                //
                //   coneMask — strålen har NEGATIV energi i uendelig. Der
                //     findes intet ydre univers i den retning, uanset hvor
                //     man står. Det er den ægte mørke kegle, og det er dér
                //     folderne hører hjemme. Den findes fra ergosfæren.
                //
                //   killMask — strålen løb ind i uRayStop. Udenfor er det
                //     bare hullets skygge, og en skygge skal være SORT.
                //     Dybt inde er det derimod det ukendte, og dér må
                //     folderne godt brede sig ind over.
                //
                // Sammenblandingen var grunden til at tegningen skulle
                // gates på horisonten: uden den ville folderne have malet
                // hen over skyggen udefra. Med de to skilt ad kan
                // keglemasken stå helt uden gate, og horisonten mister sin
                // sidste rolle i billedet.
                float lum  = dot(base, vec3(0.299, 0.587, 0.114));
                float dark = 1.0 - smoothstep(0.015, 0.30, lum);

                // ── Keglen, blødt ──────────────────────────────────────
                // coneMask var et ja/nej: pt <= 0. Som maske gav den
                // folderne en matematisk perfekt cirkel som kant, og en
                // perfekt cirkel med tekstur indeni og sort udenfor er
                // ikke en kegle — det er et koøje. Kanten kom fra en if,
                // ikke fra fysikken.
                //
                // coneS er den samme kegle som et kontinuert tal:
                // 1 på kegleaksen, 0 præcis på randen, negativ udenfor.
                // To ting bruger den.
                //
                //   coneEdge — randen fjedret over ±0.12. Det er 4-6
                //     grader; nok til at kanten ikke kan aflæses, lidt
                //     nok til at folderne bliver hvor de hører hjemme.
                //
                //   coneCore — tætheden INDE i keglen. Uden den var der
                //     stadig et spring: fuld tekstur helt ud til fjeren
                //     og ingenting bagefter. Med den tynder folderne ud
                //     hele vejen mod randen, og der er ingen kant tilbage.
                float coneEdge = smoothstep(-0.12, 0.12, coneS);
                float coneCore = pow(clamp(coneS, 0.0, 1.0), 0.6);

                // ── Den sorte ring, og hvorfor den var der ──────────
                // Keglens tætheds-taper (coneCore) og skyggen udenfor var
                // to SEPARATE led der stødte op mod hinanden i stedet for
                // at overlappe: killMask indeholdt !noSource, så skyggen
                // kunne per konstruktion aldrig nå ind i keglen, mens
                // coneCore gik mod nul netop dér. Resultatet var et bælte
                // langs keglens rand hvor ingen af dem var store — sort,
                // med lyse folder på begge sider. Det er ringen.
                //
                // To ting retter det. notSky er nu KUN "strålen så ikke
                // himlen", altså sand også inde i keglen. Og taperen
                // forsvinder i takt med at skyggen tænder: når hele den
                // ikke-himmel-agtige himmel alligevel er dækket, er der
                // ingen cirkel at skjule, og så skal der ikke tones ned
                // mod noget som helst.
                float shadow = notSky * smoothstep(0.20, 0.65, depth);
                float coneW  = coneEdge * mix(coneCore, 1.0, shadow);
                float mask   = max(coneEdge, shadow) * dark;
                float foldW  = max(coneW,    shadow) * dark;

                // ── Foldet rumtid ──
                // Aksen er keglens egen, altså -outDir. Universet ligger
                // om outDir; det vi ikke kan se ligger modsat.
                vec3  axis = -outDir;
                float mu   = dot(dir, axis);          // 1 i keglens midte
                vec3 ax = normalize(cross(axis, vec3(0.0, 0.0, 1.0)) + vec3(1e-3));
                vec3 ay = normalize(cross(axis, ax));

                // Den gamle vec2(dot(dir,ax), dot(dir,ay)) er en flad
                // projektion: dens længde er sin(vinkel), så den mætter
                // ved 90° og FOLDER tilbage bagefter — to forskellige
                // retninger fik samme koordinat. Oveni lå acos(mu) som et
                // rent radialt offset i støjen, og et radialt offset er
                // per konstruktion koncentriske ringe. De to sammen ER
                // linsen man kan se i billedet.
                //
                // Stereografisk fra modpolen i stedet: konform, monoton,
                // |st| = tan(vinkel/2), og ingen radial koordinat nogen
                // steder. Ved keglens rand på 58° er |st| kun 0.55, så
                // frekvensen i vinkel holder sig i ro hele vejen ud.
                // Faktoren 9 er ikke pynt. |st| topper på tan(58°/2) =
                // 0.55 ved den dybeste kegle, så uden den ser fbm under
                // halvanden celle hen over HELE synsfeltet, og folderne
                // bliver til én stor klat. Med 9 er der 6-8 celler, og det
                // er dét der giver struktur uden at aliasere.
                vec2 st = vec2(dot(dir, ax), dot(dir, ay)) * (9.0 / max(1.0 + mu, 0.35));

                // Drift i stedet for rotation. En rotation om kegleaksen
                // er også en cirkelbevægelse, og øjet læser den som en
                // iris der drejer. En skæv translation gør samme arbejde
                // uden at udpege et centrum.
                vec2 drift = vec2(0.13, -0.08) * uTime * (0.35 + 0.9 * depth);

                // Domain warp: en lav frekvens forskyder opslaget i en høj.
                // Det er dét der gør skyer til FOLDER — uden den er det
                // klatter, med den følger strukturen sine egne kanter.
                // Det er også erstatningen for den radiale koordinat: den
                // gamle detalje kom næsten udelukkende fra acos(mu), altså
                // fra ringene. Fjerner man dem uden at give noget igen,
                // bliver interiøret til grød.
                vec2 warp = vec2(fbm(st * 0.55 + drift),
                                 fbm(st * 0.55 + 31.7 - drift)) - 0.5;

                // Skæv skala på de to akser: flader og folder, ikke pletter.
                float flow = fbm(vec2(st.x * 0.70, st.y * 3.20) + warp * 3.0 + drift)
                           * fbm(vec2(st.x * 1.61, st.y * 2.40) - warp * 2.1 + 11.0 - drift * 1.4);
                float streak = pow(clamp(flow, 0.0, 1.0), 1.5) * (0.30 + 1.4 * depth);

                vec3 foldA = vec3(0.28, 0.14, 0.55);   // violet, højt oppe
                vec3 foldB = vec3(0.20, 0.75, 1.00);   // cyan, dybt nede

                // Folderne bliver hvidere i takt med uBlue. De er tegnede,
                // men de skal ikke stå tilbage som farvede striber mens
                // alt andet brænder ud — så ville det tegnede være det
                // sidste man ser, og det er præcis den forkerte pointe.
                vec3 foldCol = mix(mix(foldA, foldB, depth),
                                   vec3(0.72, 0.86, 1.00), clamp(uBlue, 0.0, 1.0));
                col += foldCol * streak * w * foldW * (1.0 + 2.2 * uBlue);

                // ── Ringen ──
                // To spærrer, og de er der begge af en grund.
                //
                // depthGate: ringen tændes først et stykke inde.
                //
                // mask: ringGlow() er et rent skæringspunkt mellem en
                // stråle og et plan. Den ved intet om hvad der ellers
                // ligger i den retning, så uden masken skærer den lige
                // igennem stjernehimlen som om den lå foran.
                float depthGate = smoothstep(0.10, 0.45, depth);
                float ring = ringGlow(x, dir, a);
                col += mix(vec3(1.0, 0.72, 0.30), vec3(0.85, 0.95, 1.0), depth)
                     * ring * w * depthGate * mask * (0.6 + 14.0 * depth * depth);

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

                float M = 0.5 * uRs;
                float a = uSpin * M;

                // Den samme pixel, men uden aberration. Bruges kun af
                // tegningen — se kommentaren over interiorFX().
                vec3 dirLocal = normalize(nl.x * uCamRight + nl.y * uCamUp + nl.z * uCamFwd);

                // Fotonen observatøren ser, kommer imod os. Vi følger den
                // bagud i tiden, altså vender vi den om: k = -e0 + n·(e1,e2,e3).
                // Minusset på e0 ER "fortidsrettet". Intet at gætte.
                vec4 k = -uE0 + nl.x * uE1 + nl.y * uE2 + nl.z * uE3;

                // Strålerne udgår fra kameraet. Punktum. Der var engang en
                // separat uRayPos her, fordi den håndlagte ringpassage førte
                // kameraet gennem ringens åbning hvor Kerr-Schild-r er
                // eksakt nul — altså ind i strålernes egen dødszone, hvor
                // hver eneste stråle døde på skridt nul og skærmen blev
                // sort. Uden passagen er kameraet altid et sted hvor der
                // findes en gyldig observatør, og så er der intet at fryse.
                vec3 x = uCamPos;

                // Sænk indekset: integratoren regner med p_mu, ikke p^mu.
                Metric m0 = metricAt(x);
                float  Lk = k.w + dot(m0.l, k.xyz);
                float  pt = -k.w + m0.f * Lk;
                vec3   p  = k.xyz + m0.f * Lk * m0.l;

                // ── Affin normering. Vigtigere end den ser ud ──
                // En lysbane er den samme kurve uanset hvordan man skalerer
                // sin parameter, så p og pt må ganges med hvad som helst.
                // Det udnytter vi: uden normering vokser |p| med kameraets
                // boost — nede ved r ≈ 0.3 Rs er |p| omkring 90 for nogle
                // pixels og 20 for andre. Så rammer nogle stråler
                // sikkerhedsgrænsen |p|² > 1e4 med det samme og andre gør
                // ikke, og grænsen mellem "sort" og "himmel" flytter sig
                // med observatørens boost i stedet for med geometrien.
                // DET var billedet der pulserede i størrelse på vej ned.
                // Med |p| = 1 for hver eneste pixel betyder grænsen igen
                // det den skal: "denne stråle er ved at eksplodere".
                float sc = 1.0 / max(length(p), 1e-6);
                p  *= sc;
                pt *= sc;
                // Fotonen er fortidsrettet, så E_∞ for den fremadrettede
                // foton er +pt her. pt <= 0 betyder negativ energi i
                // uendelig, og der findes ikke negativ-energi-lys ude i
                // det ydre univers. I den maksimalt udvidede løsning kommer
                // den slags fra et hvidt hul, og det har et hul dannet ved
                // kollaps ikke. Altså sort, gratis.
                //
                // Randen pt = 0 er en kegle:
                //     cos θ = A / sqrt(A² − 1 + f)
                // A er observatørens egen bevarede energi, f er KS-
                // potentialet. Keglen åbner sig først ved ergosfæren
                // (f = 1) og vokser mod 90° når f → uendelig. Den lukker
                // ALDRIG universet ned til en lille cirkel: man mister
                // knap en tredjedel af himlen på vejen ned, ikke mere.
                bool noSource = (pt <= 0.0);

                // g = E_observeret / E_uendelig. E_obs er 1 før normeringen
                // (det er definitionen af tetraden), E_∞ er |p_t|. g < 1 er
                // rødforskydning. Bemærk fortegnet: lys der indhenter en
                // faldende observatør bagfra bliver RØDERE, ikke blåere.
                //
                // Loftet var 2.8, så 12. Nu 15, fordi slutningen hænger
                // på netop den øvre ende: randen af den mørke kegle er dér
                // hvor E_uendelig går mod nul og g mod uendelig — det
                // klareste sted på hele himlen. Tonemapperen tager toppen,
                // så loftet koster ikke noget andre steder.
                float gShift = clamp(sc / max(abs(pt), 1e-6), 0.10, 15.0);

                // ── Keglen som et kontinuert tal ──────────────────────
                // Den underliggende størrelse er glat overalt:
                //     E_∞(n) = A + n·B,   |B|² = A² − 1 + f
                // E_∞ løber fra A−|B| på kegleaksen, gennem NUL præcis på
                // randen, op til A+|B| midt i vinduet ud. Normeret med
                // (|B|−A) bliver det en koordinat der er 1 i keglens midte
                // og 0 på randen — uanset hvor dybt vi er. Målt langs
                // netop denne bane:
                //     r/Rs 0.900 → kegle 19.3°, |B|−A = 0.057
                //     r/Rs 0.763 → kegle 30.3°, |B|−A = 0.151
                //     r/Rs 0.590 → kegle 41.2°, |B|−A = 0.314
                //     r/Rs 0.300 → kegle 57.9°, |B|−A = 0.841
                // Normeringen er dét der gør konstanterne i interiorFX
                // gyldige hele vejen ned i stedet for kun ét sted.
                float Einf  = pt / max(sc, 1e-12);
                float Bmag  = sqrt(max(uAobs * uAobs - 1.0 + metricAt(uCamPos).f, 0.0));
                float coneS = -Einf / max(Bmag - uAobs, 1e-4);

                bool escaped = false, dead = noSource;
                int steps = 0;

                vec3 outD = p, emission = vec3(0.0);
                float trans = 1.0;

                for (int i = 0; i < MAX_STEPS; i++) {
                    if (dead || float(i) >= uMaxSteps) break;

                    steps++;

                    float r = ksR(x, a);
                    if (r < uRayStop) { dead = true; break; }

                    // Stråler der asymptotisk nærmer sig horisonten får
                    // |p| til at eksplodere. De kom fra det uendeligt
                    // fjerne fortid og er uendeligt rødforskudte, altså
                    // sorte. Uden det her driver H til 1e57 og man får NaN.
                    // Grænsen hang på uInside og faldt derfor 1e4 → 2e3
                    // henover selve horisontkrydset. Den afgør hvilke
                    // stråler der erklæres døde, altså skyggens kant — og
                    // det er en ændring i BILLEDET, lige dér hvor der ikke
                    // må ske noget. Nu hænger den på uDepth og rykker sig
                    // først et godt stykke inde, hvor strålerne faktisk
                    // begynder at eksplodere.
                    if (dot(p, p) > mix(1.0e4, 4.0e3, smoothstep(0.20, 0.80, clamp(uDepth, 0.0, 1.0)))) { dead = true; break; }

                    Deriv k1 = deriv(x, p, pt);

                    if (r > ESCAPE_DIST || (r > uRs * 8.0 && dot(k1.dx, x) > 0.0)) {
                        escaped = true; outD = k1.dx; break;
                    }

                    float jitter = r > uRs * 4.0
                        ? 0.95 + 0.1 * fract(sin(dot(nl.xy, vec2(12.9898,78.233))) * 43758.5453)
                        : 1.0;

                    // ── Skridtlængden. Her lå den halve skærm ──
                    // Meningen med formlen er at dl · |dx| ER den fysiske
                    // afstand strålen flytter sig. Men |p| normeres til 1
                    // ved kameraet, og kameraet er dybt boostet — ude i det
                    // flade rum er |p| nede omkring 0.02. Gulvet på 0.25 i
                    // nævneren betød så at hvert skridt kun rykkede
                    // 0.02/0.25 = en tolvtedel af det formlen troede.
                    float sp   = max(length(k1.dx), 1e-4);
                    float want = min(1.1 * clamp(r / (uRs * 1.5), 0.3, 8.0) * jitter, 0.5 * r);

                    // ── Opstramning omkring fotonsfæren ──
                    // At fjerne gulvet på 0.25 fjernede også den bremse det
                    // uforvarende lagde netop dér hvor stråler wrapper mange
                    // gange rundt om hullet. Resultatet var et smalt bånd
                    // inde i skyggen hvor stråler slap ud som ikke burde:
                    // saltkorn i det sorte. Ikke jitteren — den ændrer
                    // ingenting; det er ét for langt RK4-skridt der smider
                    // en spiralerende stråle ud ad en tangent.
                    //
                    // Båndet er målt: 420 retninger gennem skyggekanten,
                    // og lækagen forsvinder ved K = 2. Med K = 3 er der
                    // margin, og dybt inde koster den kun 195 skridt mod 131.
                    // uRs/r alene duer ikke som vægt — den er 3.6 nede ved
                    // r = 0.275 Rs, hvor der slet ikke ER et problem, og
                    // kvæler hele interiøret.
                    float band = (1.0 - smoothstep(uRs * 1.6, uRs * 4.0, r))
                               * smoothstep(uRs * 0.6, uRs * 1.0, r);
                    want /= (1.0 + 3.0 * band);

                    float dl   = want / sp;

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

                // Skivens nedtoning hang også på uInside · uDepth, altså
                // med et produkt der forlod nul præcis ved krydset. uDepth
                // alene, forsinket, gør det samme uden at markere noget.
                emission *= mix(1.0, 0.30, smoothstep(0.10, 0.85, clamp(uDepth, 0.0, 1.0)));

                vec3 bg = vec3(0.0);
                bool sawSky = false;
                if (escaped) {
                    bg = skyColor(outD);
                    sawSky = true;
                } else if (!dead) {
                    // Her lå fejlen. Den gamle kode samplede himlen på
                    // strålens ØJEBLIKKELIGE retning uanset hvor strålen
                    // var, hvis bare r > 2·Rs. Nede ved 0.34 Rs løb næsten
                    // alle stråler tør midt i en hård krumning, og så fik
                    // nabopixels næsten samme retning: en kæmpeforstørret,
                    // udsmurt mælkevej med en lodret trappekant, dér hvor
                    // skridtbudgettet slap op.
                    //
                    // Nu skal strålen være langt ude OG på vej udad for at
                    // tælle. Alt andet er sort, og så er det interiorFX()
                    // der tegner folder ovenpå, som den skal.
                    vec3 dOut = dxdl(x, p, pt);
                    if (ksR(x, a) > uRs * 4.0 && dot(dOut, x) > 0.0) {
                        bg = skyColor(dOut);
                        sawSky = true;
                    }
                }

                // Doppler + gravitationel forskydning på himlen.
                // Bolometrisk skulle det være g⁴. Det ville slukke
                // interiøret helt, så eksponenten er skruet ned:
                // korrekt fysik, kunstnerisk skala.
                bg *= pow(gShift, 1.1);
                bg *= mix(vec3(1.35, 0.86, 0.58), vec3(1.0), smoothstep(0.55, 1.0, gShift));
                bg  = mix(bg, bg * vec3(0.70, 0.86, 1.35), smoothstep(1.0, 1.9, gShift));

                // ── Blåforskydningen løber løbsk ──
                // Det her er den ægte effekt, skruet op — ikke en ny effekt.
                // Vægten er smoothstep på gShift SELV, så de pixels der
                // allerede er mest blåforskudte tænder først, og det er
                // præcis randen af den mørke kegle: dér hvor E_uendelig går
                // mod nul. Randen brænder altså ud indefra og udefter, i
                // den rækkefølge geometrien bestemmer.
                //
                // Fysikken bag: nærmer man sig den indre horisont, ankommer
                // hele det ydre univers' fremtid komprimeret ind i endelig
                // egentid. Divergensen er ægte. Kurven er vores.
                if (uBlue > 0.0) {
                    float rim = smoothstep(0.9, 2.8, gShift);
                    bg *= 1.0 + uBlue * (1.6 + 30.0 * rim);
                    bg  = mix(bg, bg * vec3(0.66, 0.83, 1.50), uBlue * (0.35 + 0.65 * rim));
                }

                vec3 col = emission + trans * bg;

                if (uDraw > 0.002) {
                    // De to slags mørke, holdt adskilt. noSource er den
                    // fysiske kegle; killMask er alt andet der endte sort.
                    // notSky, ikke killMask: keglen er også "ikke himmel",
                    // og det er dét der lukker hullet ved dens rand.
                    col = interiorFX(uCamPos, dirLocal, col, coneS,
                                     sawSky ? 0.0 : 1.0);
                }

                if (uDebug > 0.5) {
                    float fr = float(steps) / uMaxSteps;
                    gl_FragColor = vec4(fr, fr * fr, 1.0 - fr, 1.0);
                    return;
                }

                // ── Tonemap, hue-bevarende ──
                // Reinhard pr. kanal komprimerer den lyseste kanal hårdest,
                // så alt lyst glider mod hvidt. Det er præcis dér farven
                // betyder noget her: den forstørrede kerne ER mørkerød —
                // rumvinklen bagud er blæst op 12.5 gange af aberrationen,
                // og den samme Doppler-faktor 0.283 er rødforskydningen.
                // Jo mere forstørret, jo rødere. Pr. kanal vaskede den
                // sammenhæng væk og efterlod en hvid skive.
                //
                // Så: komprimér LUMINANSEN, og skalér farven med samme
                // faktor. Hue overlever. Kun hvis en enkelt kanal alligevel
                // løber over, giver vi slip og lader den gå mod hvid —
                // ellers ville den klippe til en forkert farve i stedet.
                float Lin = dot(col, vec3(0.2126, 0.7152, 0.0722));
                float Lot = Lin / (Lin + 0.85) * 1.85;
                vec3  cc  = col * (Lot / max(Lin, 1e-5));
                float ov  = max(cc.r, max(cc.g, cc.b));
                col = mix(cc, vec3(Lot), smoothstep(1.0, 1.6, ov));

                // ── Slutningen, efter tonemap ──
                // Tæppet lægges HER med vilje. Gik det ind før tonemapperen,
                // ville den komprimere det tilbage mod grå og man ville
                // aldrig nå ren udbrænding. Farven er en anelse blå, så
                // det læses som blåforskydning og ikke som en fade-to-white.
                col = mix(col, vec3(0.88, 0.93, 1.00), clamp(uWhite, 0.0, 1.0));

                // Og så slukker den. Hvid → sort, mens teksten kommer op.
                col *= clamp(uDim, 0.0, 1.0);

                gl_FragColor = vec4(col, 1.0);
            }
        `,
        depthWrite: false,
        depthTest:  false,
    });
}