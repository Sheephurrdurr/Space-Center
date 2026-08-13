// =====================================================================
//  exhibits/merger_gw/LensingPass.js
//
//  Screen-space post pass. Two things happen here:
//
//   1. Lensing. A 1/r² deflection of the background, a photon ring, and a
//      hard black disk. This is an ANALYTIC APPROXIMATION, not integrated
//      null geodesics — the Kerr and Dive exhibits do the real thing per
//      pixel; this one does not, because the subject here is the orbit,
//      not the optics. Stated plainly rather than implied.
//
//   2. Gravitational waves, as two separate effects:
//        - the inspiral train: a standing radial oscillation whose
//          amplitude is the real quadrupole strain
//        - the merger burst: a single outgoing pulse released at the
//          moment the horizons join
//
//      Both displace the sampling coordinate, which is the honest way to
//      draw a metric perturbation: the background does not move, the
//      distance to it does.
// =====================================================================

import * as THREE from 'three';

export class LensingPass {
    constructor(canvas, starfieldTexture) {
        const w = canvas.clientWidth * window.devicePixelRatio;
        const h = canvas.clientHeight * window.devicePixelRatio;

        this.renderTarget = new THREE.WebGLRenderTarget(w, h, {
            depthBuffer: true,
            depthTexture: new THREE.DepthTexture(w, h),
        });

        this.scene = new THREE.Scene();
        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

        this._buildQuad(canvas, starfieldTexture);
    }

    _buildQuad(canvas, starfieldTexture) {
        this.quad = new THREE.Mesh(
            new THREE.PlaneGeometry(2, 2),
            new THREE.ShaderMaterial({
                uniforms: {
                    uStarfield:      { value: starfieldTexture },
                    uSceneTexture:   { value: this.renderTarget.texture },
                    uDepthTexture:   { value: this.renderTarget.depthTexture },

                    uBlackHolePos:   { value: new THREE.Vector2(0.5, 0.5) },
                    uBlackHoleDepth: { value: 0.5 },
                    uBhRadius:       { value: 0.055 },
                    uLensStrength:   { value: 0.01 },
                    uAspect:         { value: canvas.clientWidth / canvas.clientHeight },

                    // ── Inspiral wave train ──
                    uRippleCenter:   { value: new THREE.Vector2(0.5, 0.5) },
                    uRipplePhase:    { value: 0.0 },
                    uRippleAmp:      { value: 0.0 },   // strainAmplitude() × gain
                    uRippleDensity:  { value: 40.0 },  // artistic: visible rings on screen

                    // ── Merger burst: one outgoing pulse ──
                    uBurstRadius:    { value: -1.0 },  // < 0 disables
                    uBurstAmp:       { value: 0.0 },
                    uBurstWidth:     { value: 0.09 },

                    // ── Companion alignment, for lensed tinting of the ring ──
                    uNsScreenPos:    { value: new THREE.Vector2(0.5, 0.5) },
                    uNsAlignment:    { value: 0.0 },
                    uNsColor:        { value: new THREE.Color(0x66ccff) },
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
                    uniform sampler2D uSceneTexture;
                    uniform sampler2D uDepthTexture;

                    uniform vec2  uBlackHolePos;
                    uniform float uBlackHoleDepth;
                    uniform float uBhRadius;
                    uniform float uLensStrength;
                    uniform float uAspect;

                    uniform vec2  uRippleCenter;
                    uniform float uRipplePhase;
                    uniform float uRippleAmp;
                    uniform float uRippleDensity;

                    uniform float uBurstRadius;
                    uniform float uBurstAmp;
                    uniform float uBurstWidth;

                    uniform vec2  uNsScreenPos;
                    uniform float uNsAlignment;
                    uniform vec3  uNsColor;

                    varying vec2 vUv;

                    void main() {
                        vec2  toBlackHole = uBlackHolePos - vUv;
                        vec2  corrected   = vec2(toBlackHole.x * uAspect, toBlackHole.y);
                        float dist        = length(corrected);
                        float bhRadius    = uBhRadius * uAspect;

                        float blackDisk = 1.0 - smoothstep(bhRadius * 0.95, bhRadius, dist);

                        // ── Deflection ──
                        float safeDist = max(dist, 0.12);
                        float bend     = min(uLensStrength / (safeDist * safeDist), 0.035);
                        vec2  bendDir  = toBlackHole / max(dist, 1e-5);
                        vec2  bentUv   = vUv + bendDir * bend;

                        // ── Photon ring ──
                        float ringInner = bhRadius;
                        float ringOuter = bhRadius * 2.2;

                        float sharpRing = smoothstep(ringOuter * 0.5, ringInner * 1.05, dist)
                                        * smoothstep(ringInner, ringInner * 1.15, dist);
                        float diffuseGlow = smoothstep(ringOuter, bhRadius, dist) * 0.35;
                        float ring = sharpRing + diffuseGlow;

                        // The ring shows the actual bent background, magnified — not paint.
                        vec3 ringColor = texture2D(uStarfield, bentUv).rgb * 3.0;

                        // If the companion is currently being lensed onto this side of
                        // the ring, tint it with the companion's own light.
                        vec2  ringDir = -corrected / max(dist, 1e-5);
                        vec2  toNs    = vec2((uNsScreenPos.x - uBlackHolePos.x) * uAspect,
                                              uNsScreenPos.y - uBlackHolePos.y);
                        float toNsLen = length(toNs);
                        vec2  nsDir   = toNsLen > 0.0001 ? toNs / toNsLen : vec2(0.0);
                        float tint    = uNsAlignment * max(dot(ringDir, nsDir), 0.0);
                        ringColor     = mix(ringColor, uNsColor * 5.0, tint);

                        vec4 photonGlow = vec4(ringColor, ring * 0.9);

                        // ── Gravitational waves ──
                        vec2  toCenter     = uRippleCenter - vUv;
                        vec2  rippleCorr   = vec2(toCenter.x * uAspect, toCenter.y);
                        float rDist        = length(rippleCorr);
                        vec2  rippleDir    = rDist > 0.0001 ? normalize(toCenter) : vec2(0.0);

                        // Inspiral train. 1/(1 + r²) falloff stands in for the
                        // 1/r amplitude decay of a real wave plus the projection
                        // of a 3D wavefront onto the screen plane.
                        float trainPhase    = rDist * uRippleDensity - uRipplePhase;
                        float trainEnvelope = uRippleAmp / (1.0 + rDist * rDist * 8.0);
                        float train         = sin(trainPhase) * trainEnvelope;

                        // Merger burst: a single bipolar pulse expanding outward.
                        // Shaped like the derivative of a Gaussian, so it is a
                        // compression followed by a rarefaction rather than a
                        // one-sided shove.
                        float burst = 0.0;
                        if (uBurstRadius >= 0.0) {
                            float s = (rDist - uBurstRadius) / uBurstWidth;
                            burst = uBurstAmp * s * exp(-s * s) * 2.0;
                        }

                        float displace = train + burst;
                        vec2  finalUv  = bentUv + rippleDir * displace;

                        // ── Composite ──
                        float sceneDepth = texture2D(uDepthTexture, finalUv).r;
                        vec4  bg         = texture2D(uStarfield, finalUv);
                        vec4  sceneColor = texture2D(uSceneTexture, finalUv);

                        vec4 sceneOrBg;
                        if (sceneDepth < uBlackHoleDepth - 0.001) {
                            sceneOrBg = mix(bg, sceneColor, sceneColor.a);
                        } else {
                            sceneOrBg = mix(mix(bg, sceneColor, sceneColor.a),
                                            photonGlow, photonGlow.a);
                        }

                        // Wave crests brighten slightly. A real wave does not emit
                        // light, but it does magnify what is behind it — this is
                        // that magnification, cheaply: where the mapping compresses,
                        // more background arrives per pixel.
                        float crest = abs(displace) * 45.0;
                        sceneOrBg.rgb += vec3(0.55, 0.72, 1.0) * crest * (1.0 - blackDisk);

                        gl_FragColor = mix(sceneOrBg, vec4(0.0, 0.0, 0.0, 1.0), blackDisk);
                    }
                `,
                depthWrite: false,
                depthTest: false,
            })
        );
        this.scene.add(this.quad);
    }

    // ── Uniform setters ──────────────────────────────────────────────────

    /** @param {number} x @param {number} y Screen position in [0,1]. */
    setBlackHolePos(x, y) {
        this.quad.material.uniforms.uBlackHolePos.value.set(x, y);
    }

    /** Writes the hole's depth so foreground geometry is not eaten by the ring. */
    setBlackHoleDepth(camera, worldPos) {
        const ndc = worldPos.clone().project(camera);
        this.quad.material.uniforms.uBlackHoleDepth.value = (ndc.z + 1) / 2;
    }

    /** @param {number} screenRadius Horizon radius as a fraction of screen height. */
    setBlackHoleRadius(screenRadius) {
        this.quad.material.uniforms.uBhRadius.value = screenRadius;
    }

    /** Inspiral wave train. @param {number} amp Strain × artistic gain. */
    setRipple(x, y, phase, amp) {
        const u = this.quad.material.uniforms;
        u.uRippleCenter.value.set(x, y);
        u.uRipplePhase.value = phase;
        u.uRippleAmp.value = amp;
    }

    /**
     * Merger burst.
     * @param {number} radius Current pulse radius in aspect-corrected screen units.
     *                        Pass a negative value to disable.
     * @param {number} amp    Peak displacement.
     * @param {number} [width] Pulse thickness.
     */
    setBurst(radius, amp, width) {
        const u = this.quad.material.uniforms;
        u.uBurstRadius.value = radius;
        u.uBurstAmp.value = amp;
        if (width !== undefined) u.uBurstWidth.value = width;
    }

    /** Where the companion is on screen, and how strongly it is being lensed. */
    setSourceAlignment(x, y, alignment) {
        const u = this.quad.material.uniforms;
        u.uNsScreenPos.value.set(x, y);
        u.uNsAlignment.value = alignment;
    }

    /** Keeps the aspect-correction honest after a resize. */
    setSize(width, height, pixelRatio = window.devicePixelRatio) {
        this.renderTarget.setSize(width * pixelRatio, height * pixelRatio);
        this.quad.material.uniforms.uAspect.value = width / height;
    }

    /**
     * Render the whole pipeline: scene to texture, then the post pass to screen.
     */
    render(renderer, mainScene, mainCamera) {
        renderer.setRenderTarget(this.renderTarget);
        renderer.setClearColor(0x000000, 0);
        renderer.clear();
        renderer.render(mainScene, mainCamera);

        renderer.setRenderTarget(null);
        renderer.clear();
        renderer.render(this.scene, this.camera);
    }

    dispose() {
        this.renderTarget.dispose();
        this.quad.geometry.dispose();
        this.quad.material.dispose();
    }
}