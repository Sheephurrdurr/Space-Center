import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

export class RayMarchPass {
    constructor(canvas, starfieldTexture, nsTexture) {
        const w = canvas.clientWidth  * window.devicePixelRatio;
        const h = canvas.clientHeight * window.devicePixelRatio;

        this.renderTarget = new THREE.WebGLRenderTarget(w, h, {
            depthBuffer:  true,
            depthTexture: new THREE.DepthTexture(w, h)
        });

        this.scene  = new THREE.Scene();
        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this._buildQuad(canvas, starfieldTexture, nsTexture);
    }

    _buildQuad(canvas, starfieldTexture, nsTexture) {
        this.quad = new THREE.Mesh(
            new THREE.PlaneGeometry(2, 2),
            new THREE.ShaderMaterial({
                uniforms: {
                    // Texturer
                    uStarfield:    { value: starfieldTexture },
                    uNsTexture:    { value: nsTexture || starfieldTexture }, // fallback så shaderen ikke fejler før tekstur er loaded
                    uSceneTexture: { value: this.renderTarget.texture },
                    uDepthTexture: { value: this.renderTarget.depthTexture },

                    // Kamera — world space basis-vektorer
                    uCamPos:   { value: new THREE.Vector3() },
                    uCamRight: { value: new THREE.Vector3() },
                    uCamUp:    { value: new THREE.Vector3() },
                    uCamFwd:   { value: new THREE.Vector3() },
                    uFovTan:   { value: Math.tan(THREE.MathUtils.degToRad(60) * 0.5) },
                    uAspect:   { value: canvas.clientWidth / canvas.clientHeight },

                    // Sort hul — world space
                    uBhPos: { value: new THREE.Vector3() },
                    uRs:    { value: 10.0 },

                    // Neutronstjerne — world space (NYT)
                    uNsPos:    { value: new THREE.Vector3() },
                    uNsRadius: { value: 8.1 },
                    uNsIsBehind: { value: 0.0 }
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
                    uniform sampler2D uNsTexture;
                    uniform sampler2D uSceneTexture;
                    uniform sampler2D uDepthTexture;

                    uniform vec3  uCamPos;
                    uniform vec3  uCamRight;
                    uniform vec3  uCamUp;
                    uniform vec3  uCamFwd;
                    uniform float uFovTan;
                    uniform float uAspect;

                    uniform vec3  uBhPos;
                    uniform float uRs;

                    uniform vec3  uNsPos;
                    uniform float uNsRadius;
                    uniform float uNsIsBehind;


                    varying vec2 vUv;

                    #define MAX_STEPS   300
                    #define ESCAPE_DIST 600.0

                    vec2 dirToEquirect(vec3 dir) {
                        dir = normalize(dir);
                        float u = 0.5 + atan(dir.z, dir.x) / (2.0 * 3.14159265358979);
                        float v = 0.5 - asin(clamp(dir.y, -1.0, 1.0)) / 3.14159265358979;
                        return vec2(u, v);
                    }

                    // Original simpel formel — det der virkede i test.html
                    // Kun den relativistiske korrektion, ingen Newtonsk led
                    // (det var kombinationen der gav de mørke koncentriske ringe)
                    vec3 geodesicAccel(vec3 relPos, vec3 vel) {
                        float r = length(relPos);
                        if (r < 0.001) return vec3(0.0);
                        vec3  h  = cross(relPos, vel);
                        float h2 = dot(h, h);
                        float r2 = r * r;
                        float r5 = r2 * r2 * r;
                        return -1.5 * uRs * h2 / r5 * relPos;
                    }

                    void main() {
                        // ── Kamera-basis ──────────────────────────────────────────────
                        vec2 ndc = vUv * 2.0 - 1.0;
                        ndc.x *= uAspect;
                        vec3 rayDir = normalize(
                            uCamFwd
                            + ndc.x * uFovTan * uCamRight
                            + ndc.y * uFovTan * uCamUp
                        );

                        // ── Analytisk shadow check ────────────────────────────────────
                        float b      = length(cross(uCamPos - uBhPos, rayDir));
                        float b_crit = sqrt(27.0) * uRs * 0.5;

                      if (b < b_crit) {
                        // Strålen ender i skyggen — MEN neutronstjernen kan stå FORAN
                        // det sorte hul og blokere for udsynet til skyggen.
                        // Lige-linje test er fin her: lys fra NS foran BH bøjes næsten ikke.
                        vec3  f    = uCamPos - uNsPos;
                        float bq   = 2.0 * dot(f, rayDir);
                        float c    = dot(f, f) - uNsRadius * uNsRadius;
                        float disc = bq * bq - 4.0 * c;

                        if (disc >= 0.0) {
                            float tNs = (-bq - sqrt(disc)) * 0.5;                 // afstand til NS-overfladen
                            float tBh = dot(uBhPos - uCamPos, rayDir);            // afstand til BH langs strålen

                            if (tNs > 0.0 && tNs < tBh) {                          // NS er tættere på end BH
                                vec3 hitPos   = uCamPos + rayDir * tNs;
                                vec3 nsNormal = normalize(hitPos - uNsPos);
                                gl_FragColor = vec4(texture2D(uNsTexture, dirToEquirect(nsNormal)).rgb * 1.4, 1.0);
                                return;
                            }
                        }

                        gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
                        return;
                    }

                        // ── Two-phase Euler ray march ─────────────────────────────────
                        vec3 pos     = uCamPos;
                        vec3 vel     = rayDir;
                        vec3 bgColor = texture2D(uStarfield, dirToEquirect(vel)).rgb;
                        bool hitNs   = false;

                        for (int i = 0; i < MAX_STEPS; i++) {
                            vec3 posBeforeStep = pos;   // gem position FØR step — bruges til NS-test

                            vec3  relPos = pos - uBhPos;
                            float r      = length(relPos);

                            if (r > ESCAPE_DIST) {
                                bgColor = texture2D(uStarfield, dirToEquirect(vel)).rgb;
                                break;
                            }

                            if (r > uRs * 6.0 && dot(vel, relPos) > 0.0) {
                                bgColor = texture2D(uStarfield, dirToEquirect(vel)).rgb;
                                break;
                            }

                            // Two-phase step — stor langt fra, lille tæt på
                            float nearZone = smoothstep(uRs * 6.0, uRs * 1.5, r);
                            float dt       = mix(3.0, 0.08, nearZone);

                            // Simpel Euler — det der faktisk virkede
                            vec3 accel = geodesicAccel(relPos, vel);
                            vel += accel * dt;
                            pos += vel   * dt;

                            // ── NS ray-sphere intersection ────────────────────────────
                            // Test om strålen krydsede NS-sfæren i dette step.
                            // Vi tester linjestykket fra posBeforeStep til pos —
                            // det er en standard "ray vs sphere" test fra raytracing.
                            // Diskriminanten (disc) afgør om linjen overhovedet rammer sfæren.
                            // Samme matematik som bruges i Unity/Unreal's physics raycasts.
                            vec3  segDir = pos - posBeforeStep;
                            vec3  f      = posBeforeStep - uNsPos;
                            float a      = dot(segDir, segDir);
                            float bq     = 2.0 * dot(f, segDir);
                            float c      = dot(f, f) - uNsRadius * uNsRadius;
                            float disc   = bq * bq - 4.0 * a * c;

                            if (disc >= 0.0 && a > 0.0001) {
                                float sq   = sqrt(disc);
                                float tHit1 = (-bq - sq) / (2.0 * a);
                                float tHit2 = (-bq + sq) / (2.0 * a);
                                float tHit  = (tHit1 >= 0.0 && tHit1 <= 1.0) ? tHit1
                                            : (tHit2 >= 0.0 && tHit2 <= 1.0) ? tHit2 : -1.0;

                                if (tHit >= 0.0) {
                                    vec3 hitPos   = posBeforeStep + segDir * tHit;
                                    vec3 nsNormal = normalize(hitPos - uNsPos);
                                    // Sample NS-texturen via equirectangular projektion af normalen
                                    // Det er samme trick som vi bruger til starfield —
                                    // normalvektoren peger ud fra NS-centrum, og vi slår texturen
                                    // op i den retning, præcis som en spherical UV-mapping
                                    bgColor = texture2D(uNsTexture, dirToEquirect(nsNormal)).rgb * 1.4;
                                    hitNs   = true;
                                    break;
                                }
                            }
                        }

                        // ── Escaped ray: rammer den bøjede stråle NS'en længere fremme? ──
                        // Strålen er sluppet fri af det sorte hul, men kan stadig ramme
                        // neutronstjernen — det er dét lys der danner de sekundære billeder
                        // og Einstein-ringen. Samme ray-sphere matematik som i loopet,
                        // men med en uendelig stråle (fra pos, i retning vel) i stedet
                        // for et kort linjestykke.
                        if (!hitNs) {
                            vec3  d    = normalize(vel);
                            vec3  f    = pos - uNsPos;
                            float bq   = 2.0 * dot(f, d);
                            float c    = dot(f, f) - uNsRadius * uNsRadius;
                            float disc = bq * bq - 4.0 * c;

                            if (disc >= 0.0) {
                                float sq   = sqrt(disc);
                                float tHit = (-bq - sq) * 0.5;          // nærmeste skæring
                                if (tHit < 0.0) tHit = (-bq + sq) * 0.5; // vi er evt. inde i sfæren

                                if (tHit >= 0.0) {
                                    vec3 hitPos   = pos + d * tHit;
                                    vec3 nsNormal = normalize(hitPos - uNsPos);
                                    bgColor = texture2D(uNsTexture, dirToEquirect(nsNormal)).rgb * 1.4;
                                    hitNs   = true;
                                }
                            }
                        }

                    

                        gl_FragColor = vec4(bgColor, 1.0);
                    }
                `,
                depthWrite: false,
                depthTest:  false,
            })
        );
        this.scene.add(this.quad);
    }

    updateCamera(camera) {
        const u = this.quad.material.uniforms;
        u.uCamPos.value.copy(camera.position);

        const fwd = new THREE.Vector3();
        camera.getWorldDirection(fwd);
        u.uCamFwd.value.copy(fwd);

        const right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize();
        u.uCamRight.value.copy(right);

        const up = new THREE.Vector3().crossVectors(right, fwd);
        u.uCamUp.value.copy(up);

        u.uFovTan.value = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
        u.uAspect.value = camera.aspect;
    }

    setBhWorld(worldPos, rs) {
        this.quad.material.uniforms.uBhPos.value.copy(worldPos);
        this.quad.material.uniforms.uRs.value = rs;
    }

    setNsIsBehind(value) {
        this.quad.material.uniforms.uNsIsBehind.value = value;
    }

    setNsWorld(worldPos, radius) {
        this.quad.material.uniforms.uNsPos.value.copy(worldPos);
        this.quad.material.uniforms.uNsRadius.value = radius;
    }

    render(renderer, mainScene, mainCamera) {
        this.updateCamera(mainCamera);

        renderer.setRenderTarget(this.renderTarget);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        renderer.render(mainScene, mainCamera);

        renderer.setRenderTarget(null);
        renderer.clear();
        renderer.render(this.scene, this.camera);
    }
}