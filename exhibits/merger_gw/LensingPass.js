// LensingPass.js
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

export class LensingPass {
    constructor(canvas, starfieldTexture) {

        this.renderTarget = new THREE.WebGLRenderTarget(
            canvas.clientWidth * window.devicePixelRatio,
            canvas.clientHeight * window.devicePixelRatio, 
            {
                depthBuffer: true,
                depthTexture: new THREE.DepthTexture(
                    canvas.clientWidth * window.devicePixelRatio,
                    canvas.clientHeight * window.devicePixelRatio
                )
            }
        );
        
        this.scene = new THREE.Scene();
        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        
        this._buildQuad(canvas, starfieldTexture);
    }
    
    _buildQuad(canvas, starfieldTexture) {
        this.quad = new THREE.Mesh(
            new THREE.PlaneGeometry(2, 2),
            new THREE.ShaderMaterial({
                uniforms: {
                    uStarfield:    { value: starfieldTexture },
                    uSceneTexture: { value: this.renderTarget.texture },
                    uBlackHolePos: { value: new THREE.Vector2(0.5, 0.5) },
                    uLensStrength: { value: 0.01 },
                    uAspect:       { value: canvas.clientWidth / canvas.clientHeight },
                    uDepthTexture:   { value: this.renderTarget.depthTexture },
                    uBlackHoleDepth: { value: 0.5 },
                    uBhRadius:       { value:0.055 },

                    uRippleCenter:  { value: new THREE.Vector2(0.5, 0.5) },
                    uRipplePhase:   { value: 0.0 },
                    uRippleAmp:     { value: 0.0 },    // fysisk: orbit.strainAmplitude() × artistic gain
                    uRippleDensity: { value: 40.0 },   // artistic knob: antal synlige ringe

                    uNsScreenPos: { value: new THREE.Vector2(0.5, 0.5) },
                    uNsAlignment: { value: 0.0 },
                    uNsColor: { value: new THREE.Color(0x66ccff) }

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
                    uniform sampler2D uSceneTexture;
                    uniform vec2 uBlackHolePos;
                    uniform float uLensStrength;
                    uniform float uAspect;
                    uniform float uBhRadius;
                    uniform sampler2D uDepthTexture;
                    uniform float uBlackHoleDepth;

                    uniform vec2 uRippleCenter;
                    uniform float uRipplePhase;
                    uniform float uRippleAmp;
                    uniform float uRippleDensity;

                    uniform vec2 uNsScreenPos;
                    uniform float uNsAlignment;
                    uniform vec3 uNsColor;

                    varying vec2 vUv;

                    void main() {
                        vec2 toBlackHole = uBlackHolePos - vUv;
                        vec2 corrected = vec2(toBlackHole.x * uAspect, toBlackHole.y);
                        float dist = length(corrected);
                        float bhRadius = uBhRadius * uAspect;

                        float blackDisk = 1.0 - smoothstep(bhRadius * 0.95, bhRadius, dist);

                        // ── Bend ──
                        float safeDist = max(dist, 0.12);
                        float bend = uLensStrength / (safeDist * safeDist);
                        bend = min(bend, 0.035);
                        vec2 bendDir = toBlackHole / dist;
                        vec2 bentUv = vUv + bendDir * bend;

                        // ── Photon ring ──
                        float ringInner = bhRadius;
                        float ringOuter = bhRadius * 2.2; // Was 1.35

                        float sharpRing = smoothstep(ringOuter * 0.5, ringInner * 1.05, dist)
                                        * smoothstep(ringInner, ringInner * 1.15, dist);

                        float diffuseGlow = smoothstep(ringOuter, bhRadius, dist) * 0.35;

                        float ring = sharpRing + diffuseGlow;

                        vec4 lensedAtRing = texture2D(uStarfield, bentUv);   // den FAKTISKE bøjede baggrund
                        vec3 ringColor = lensedAtRing.rgb * 3.0;              // magnification-boost — fysisk motiveret, ikke pyntet

                        // NS, hvis den lige er den der bliver linset hen til denne side af ringen
                        vec2 ringDir = -corrected / dist;
                        vec2 toNs = vec2((uNsScreenPos.x - uBlackHolePos.x) * uAspect, uNsScreenPos.y - uBlackHolePos.y);
                        float toNsLen = length(toNs);
                        vec2 nsDir = toNsLen > 0.0001 ? toNs / toNsLen : vec2(0.0);
                        float tint = uNsAlignment * max(dot(ringDir, nsDir), 0.0);
                        ringColor = mix(ringColor, uNsColor * 5.0, tint);

                        vec4 photonGlow = vec4(ringColor, ring * 0.9);

                        // ── Gravitational wave ripples ──
                        vec2 toRippleCenter = uRippleCenter - vUv;
                        vec2 rippleCorrected = vec2(toRippleCenter.x * uAspect, toRippleCenter.y);
                        float rDist = length(rippleCorrected);
                        float ripplePhase = rDist * uRippleDensity - uRipplePhase;
                        float rippleEnvelope = uRippleAmp / (1.0 + rDist * rDist * 8.0);
                        float rippleWave = sin(ripplePhase) * rippleEnvelope;
                        vec2 rippleDir = rDist > 0.0001 ? normalize(toRippleCenter) : vec2(0.0);
                        vec2 finalUv = bentUv + rippleDir * rippleWave;

                        float sceneDepth = texture2D(uDepthTexture, finalUv).r;
                        vec4 bg = texture2D(uStarfield, finalUv);
                        vec4 sceneColor = texture2D(uSceneTexture, finalUv);

                        vec4 sceneOrBg;
                        if (sceneDepth < uBlackHoleDepth - 0.001) {
                            sceneOrBg = mix(bg, sceneColor, sceneColor.a);
                        } else {
                            sceneOrBg = mix(mix(bg, sceneColor, sceneColor.a), photonGlow, photonGlow.a);
                        }

                        gl_FragColor = mix(sceneOrBg, vec4(0.0, 0.0, 0.0, 1.0), blackDisk);
                    }
                `,
                depthWrite: false,
                depthTest: false
            })
        );
        this.scene.add(this.quad);
    }
    
    // Opdater hvor sort hullet er på skærmen
    setBlackHolePos(x, y) {
        this.quad.material.uniforms.uBlackHolePos.value.set(x, y);
    }

    setBlackHoleDepth(camera, worldPos) {
        const ndc = worldPos.clone().project(camera);

        const depth = (ndc.z + 1) / 2;

        this.quad.material.uniforms.uBlackHoleDepth.value = depth;
    }

    setBlackHoleRadius(screenRadius) {
        this.quad.material.uniforms.uBhRadius.value = screenRadius;
    }

    setRipple(x, y, phase, amp) {
        this.quad.material.uniforms.uRippleCenter.value.set(x, y);
        this.quad.material.uniforms.uRipplePhase.value = phase;
        this.quad.material.uniforms.uRippleAmp.value = amp;
    }

    setSourceAlignment(x, y, alignment) {
        this.quad.material.uniforms.uNsScreenPos.value.set(x, y);
        this.quad.material.uniforms.uNsAlignment.value = alignment;
    }

    setDiskSize(innerRatio, outerRatio, bhScreenRadius) {
        this.quad.material.uniforms.uDiskInner.value = bhScreenRadius * innerRatio;
        this.quad.material.uniforms.uDiskOuter.value = bhScreenRadius * outerRatio;
    }
    
    // Kaldes fra animate() — render hele pipelinen
    render(renderer, mainScene, mainCamera) {
        // Pass 1: 3D scene → texture
        renderer.setRenderTarget(this.renderTarget);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        renderer.render(mainScene, mainCamera);

        // Pass 2: lensing shader → skærm
        renderer.setRenderTarget(null);
        renderer.clear();
        renderer.render(this.scene, this.camera);
    }
}