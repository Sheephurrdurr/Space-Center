import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

export class StarfieldGenerator {
    constructor(renderer, width = 4096, height = 2048) {
        this.renderer = renderer;
        this.width = width;
        this.height = height;
    }

    generate() {
        // Render target der fungerer som vores "canvas"
        const target = new THREE.WebGLRenderTarget(this.width, this.height, {
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            format: THREE.RGBAFormat,
            type: THREE.UnsignedByteType,
        });

        const scene  = new THREE.Scene();
        const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

        const material = new THREE.ShaderMaterial({
            uniforms: {
                uResolution: { value: new THREE.Vector2(this.width, this.height) },
                uSeed:       { value: Math.random() * 1000.0 },
            },
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = vec4(position.xy, 0.0, 1.0);
                }
            `,
            fragmentShader: `
                uniform vec2  uResolution;
                uniform float uSeed;
                varying vec2  vUv;

                // ── Hash-funktioner ───────────────────────────────────────────
                // Tager en 2D koordinat, returnerer pseudo-tilfældig float.
                // Du kender disse fra fBm-implementeringen i museet.
                float hash(vec2 p) {
                    p = fract(p * vec2(234.34, 435.345) + uSeed);
                    p += dot(p, p + 34.23);
                    return fract(p.x * p.y);
                }

                // 3D hash — til at placere stjerner i 3D-rum
                // Returnerer 3 uafhængige tilfældige tal for ét input
                vec3 hash3(vec3 p) {
                    p = fract(p * vec3(443.8975, 397.2973, 491.1871));
                    p += dot(p, p.yxz + 19.19);
                    return fract(vec3(
                        p.x * p.y,
                        p.y * p.z,
                        p.z * p.x
                    ));
                }

                // ── fBm til Mælkevejen ────────────────────────────────────────
                // Du kender dette fra museet! Samme teknik, anden kontekst.
                float noise(vec2 p) {
                    vec2 i = floor(p);
                    vec2 f = fract(p);
                    vec2 u = f * f * (3.0 - 2.0 * f);
                    return mix(
                        mix(hash(i), hash(i + vec2(1,0)), u.x),
                        mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x),
                        u.y
                    );
                }

                float fbm(vec2 p) {
                    float v = 0.0, a = 0.5;
                    for (int i = 0; i < 6; i++) {
                        v += a * noise(p);
                        p *= 2.0; a *= 0.5;
                    }
                    return v;
                }

                // ── Konverter equirectangular UV → 3D retning ─────────────────
                // Det er den inverse af dirToEquirect() i ray marcheren.
                // UV (0-1) → sfærisk koordinat → kartesisk vektor
                vec3 uvToDir(vec2 uv) {
                    float phi   = (uv.x - 0.5) * 2.0 * 3.14159265;   // -π til π
                    float theta = (0.5 - uv.y) * 3.14159265;           // -π/2 til π/2
                    return vec3(
                        cos(theta) * cos(phi),
                        sin(theta),
                        cos(theta) * sin(phi)
                    );
                }

                // ── Placer stjerner via "cell-based" tilfældig fordeling ──────
                // Idéen: del himmelkuglen op i celler.
                // I hver celle: placer én stjerne på en tilfældig position.
                // Det giver en jævn men ikke-grid-agtig fordeling.
                float starField(vec3 dir, float cellCount, float brightness) {
                    // Find "celle-koordinater" for denne retning
                    // Ikke ægte sfærisk celleinddeling (det er komplekst),
                    // men en approksimation via UV — god nok for stjerner
                    vec2 uv = vec2(
                        atan(dir.z, dir.x) / (2.0 * 3.14159265) + 0.5,
                        asin(clamp(dir.y, -1.0, 1.0)) / 3.14159265 + 0.5
                    );

                    vec2 cell      = floor(uv * cellCount);
                    vec2 cellLocal = fract(uv * cellCount);

                    float result = 0.0;

                    // Check nuværende celle og naboer (3×3 grid)
                    // så stjerner tæt på cellegrænser ikke klippes
                    for (int dy = -1; dy <= 1; dy++) {
                        for (int dx = -1; dx <= 1; dx++) {
                            vec2 neighborCell = cell + vec2(dx, dy);
                            vec3 rnd = hash3(vec3(neighborCell, cellCount));

                            // Stjernen sidder på en tilfældig position i cellen
                            vec2 starPos = vec2(rnd.x, rnd.y);
                            float dist   = length(cellLocal - starPos - vec2(dx, dy));

                            // Størrelse og lysstyrke varierer
                            float size   = 0.002 + rnd.z * 0.004;
                            float glow   = smoothstep(size * 2.0, 0.0, dist);
                            result      += glow * brightness * (0.5 + rnd.z * 0.5);
                        }
                    }
                    return result;
                }

                void main() {
                    vec3 dir = uvToDir(vUv);

                    // ── Lag 1: Mange svage baggrundssstjerner ───────────────
                    float stars = starField(dir, 300.0, 0.6);   // 300×300 celler
                    stars      += starField(dir, 180.0, 0.5);   // andet lag
                    stars      += starField(dir, 80.0,  0.8);   // lyse stjerner
                    stars      += starField(dir, 30.0,  1.2);   // meget lyse

                    // ── Lag 2: Mælkevejen via fBm ───────────────────────────
                    // Mælkevejen er et bånd langs ækvator (Y ≈ 0).
                    // Vi bruger dir.y som "afstand fra galaktisk plan"
                    // og fBm til at give båndet tekstur.
                    float galacticLat = abs(dir.y);  // 0 = galaktisk plan, 1 = pol
                    float bandWidth   = 0.25;         // hvor bredt båndet er
                    float band = smoothstep(bandWidth, 0.0, galacticLat);

                    // fBm-tekstur langs galaktisk plan
                    vec2 milkyUv = vec2(
                        atan(dir.z, dir.x) / (2.0 * 3.14159265),
                        dir.y
                    );
                    float milkyNoise = fbm(milkyUv * 4.0 + 0.5);
                    float milkyWay   = band * milkyNoise * 0.12;

                    // ── Lag 3: Subtil farvevariation ────────────────────────
                    // Stjerner er ikke perfekt hvide —
                    // varme (rødlige) og kolde (blålige) stjerner blandes
                    float colorVar = hash(vUv * 100.0 + uSeed);
                    vec3 starColor = mix(
                        vec3(0.8, 0.9, 1.0),    // kold blå
                        vec3(1.0, 0.9, 0.7),    // varm gul
                        colorVar
                    );

                    // Mælkevejen er lidt varmere (støv og gas)
                    vec3 milkyColor = vec3(0.75, 0.70, 0.65);

                    vec3 finalColor = stars * starColor + milkyWay * milkyColor;

                    gl_FragColor = vec4(finalColor, 1.0);
                }
            `,
            depthWrite: false,
            depthTest:  false,
        });

        // Render til target — kører kun ÉN gang
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
        scene.add(quad);

        this.renderer.setRenderTarget(target);
        this.renderer.render(scene, camera);
        this.renderer.setRenderTarget(null);

        // Ryd op — vi behøver ikke scenen/materialet mere
        material.dispose();
        quad.geometry.dispose();

        // Returner texturen — den lever i GPU-memory
        return target.texture;
    }
}