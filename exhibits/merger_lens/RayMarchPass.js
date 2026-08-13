// =====================================================================
//  exhibits/merger_lens/RayMarchPass.js
//
//  Per-pixel Schwarzschild null-geodesic ray marching. Every fragment is a
//  photon traced backwards from the camera until it either escapes to the
//  starfield, lands on the neutron star, or falls through the horizon.
//
//  ── The geodesic ──────────────────────────────────────────────────────
//
//  d²r/dλ² = −(3/2)·Rs·h²·r / r⁵,   h = |r × v|
//
//  This is not an approximation with the Newtonian term left out, which is
//  what the previous comment in this file claimed. It is the exact null
//  geodesic equation. Binet's relation turns the Schwarzschild photon orbit
//  equation u'' + u = (3/2)Rs·u² into a central force f = −(3/2)Rs·h²/r⁴,
//  and there is no 1/r² term to add — that term belongs to massive particles.
//  Adding one is what produced the dark concentric rings during development.
//  Verified numerically against an independent RK4 integration of the orbit
//  equation: agreement to better than 0.05° over the whole useful range.
//
//  ── The step policy ───────────────────────────────────────────────────
//
//  dt = min(Δφ·r²/h, ¼·r)
//
//  Since dφ/dλ = h/r², the first term is a constant ANGULAR step: the ray
//  advances the same number of degrees around the hole every iteration,
//  which is what a central-force orbit actually needs. The second term caps
//  the step in the far field, where the path is straight and the only
//  requirement is not to leap past the hole.
//
//  The previous policy interpolated between a fixed 3.0 far and 0.08 near.
//  Measured against a converged reference, it produced up to 9.5° of error
//  in the recovered sky direction, and — worse — every ray with an impact
//  parameter between 1.00 and 1.08 b_crit exhausted the 300-step budget.
//  Those rays fell out of the loop still holding their INITIAL background
//  sample, so an 11-pixel-wide annulus exactly where the photon ring belongs
//  was being drawn with undeflected sky. The feature the exhibit is named
//  for was the one thing not being rendered.
//
//  With the angular policy nothing starves: the worst case resolves in 237
//  steps against a budget of 256, and typical rays cost 29–90 steps, which
//  is fewer than before. Better and cheaper, which is rare enough to note.
//
//  ── The shadow edge ───────────────────────────────────────────────────
//
//  There is no analytic b < b_crit branch any more. Capture is decided by
//  the same integration that draws everything else, so the shadow boundary
//  and the lensed sky can't disagree — and they did disagree: the flat-space
//  impact parameter measured from a camera at 16 Rs underestimates the
//  conserved one, putting the analytic cutoff about 1.2% inside where the
//  marcher actually captures. The edge is antialiased by supersampling only
//  the fragments that straddle it, sized from the real pixel footprint.
// =====================================================================

import * as THREE from 'three';

export class RayMarchPass {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {THREE.Texture} starfieldTexture Equirectangular sky.
     * @param {THREE.Texture} nsTexture        Equirectangular neutron star surface.
     */
    constructor(canvas, starfieldTexture, nsTexture) {
        this.scene = new THREE.Scene();
        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this._buildQuad(canvas, starfieldTexture, nsTexture);
    }

    _buildQuad(canvas, starfieldTexture, nsTexture) {
        this.quad = new THREE.Mesh(
            new THREE.PlaneGeometry(2, 2),
            new THREE.ShaderMaterial({
                uniforms: {
                    uStarfield: { value: starfieldTexture },
                    uNsTexture: { value: nsTexture || starfieldTexture },

                    // Camera basis, world space
                    uCamPos:   { value: new THREE.Vector3() },
                    uCamRight: { value: new THREE.Vector3() },
                    uCamUp:    { value: new THREE.Vector3() },
                    uCamFwd:   { value: new THREE.Vector3() },
                    uFovTan:   { value: Math.tan(THREE.MathUtils.degToRad(60) * 0.5) },
                    uAspect:   { value: canvas.clientWidth / canvas.clientHeight },
                    uResY:     { value: canvas.clientHeight },

                    // Black hole
                    uBhPos: { value: new THREE.Vector3() },
                    uRs:    { value: 10.0 },

                    // Neutron star, as a tidally deformed ellipsoid
                    uNsPos:     { value: new THREE.Vector3() },
                    uNsFrame:   { value: new THREE.Matrix3() },       // columns = local axes
                    uNsSemi:    { value: new THREE.Vector3(8.1, 8.1, 8.1) },
                    uNsSpin:    { value: 0.0 },
                    uNsVisible: { value: 1.0 },

                    // Relativistic photometry of the star
                    uNsBeta:      { value: new THREE.Vector3() },     // v/c, world space
                    uNsGravShift: { value: 1.0 },                     // √(f_ns / f_cam)
                    uNsEmission:  { value: 1.4 },

                    // Display transform. Doppler beaming spans a range of about
                    // sixteen to one across the star, so the raw radiance clips
                    // badly without one. This is a display step, not physics.
                    uExposure: { value: 1.0 },
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
                    uniform sampler2D uNsTexture;

                    uniform vec3  uCamPos;
                    uniform vec3  uCamRight;
                    uniform vec3  uCamUp;
                    uniform vec3  uCamFwd;
                    uniform float uFovTan;
                    uniform float uAspect;
                    uniform float uResY;

                    uniform vec3  uBhPos;
                    uniform float uRs;

                    uniform vec3  uNsPos;
                    uniform mat3  uNsFrame;
                    uniform vec3  uNsSemi;
                    uniform float uNsSpin;
                    uniform float uNsVisible;

                    uniform vec3  uNsBeta;
                    uniform float uNsGravShift;
                    uniform float uNsEmission;
                    uniform float uExposure;

                    varying vec2 vUv;

                    #define MAX_STEPS   256
                    #define DPHI        0.05    // radians of orbit per step, near field
                    #define R_FRAC      0.25    // fraction of r per step, far field
                    #define ESCAPE_MULT 40.0    // escape radius, in units of Rs
                    #define PI          3.14159265358979

                    vec2 dirToEquirect(vec3 dir) {
                        dir = normalize(dir);
                        return vec2(
                            0.5 + atan(dir.z, dir.x) / (2.0 * PI),
                            0.5 - asin(clamp(dir.y, -1.0, 1.0)) / PI
                        );
                    }

                    // Exact null geodesic acceleration. See the header.
                    vec3 geodesicAccel(vec3 relPos, vec3 vel) {
                        float r = length(relPos);
                        if (r < 0.001) return vec3(0.0);
                        vec3  h  = cross(relPos, vel);
                        float r5 = r * r * r * r * r;
                        return -1.5 * uRs * dot(h, h) / r5 * relPos;
                    }

                    // ── Neutron star, as an ellipsoid ────────────────────────────
                    // The star is stretched along the line to the black hole by the
                    // tidal field. Testing a ray against it is the same sphere test
                    // as before, done in a frame where the ellipsoid is a unit
                    // sphere: rotate into the local axes, divide by the semi-axes.

                    /** @return t in [0,1] along the segment, or -1 for a miss. */
                    float nsSegmentHit(vec3 ro, vec3 seg) {
                        if (uNsVisible < 0.5) return -1.0;
                        vec3 lo = ((ro - uNsPos) * uNsFrame) / uNsSemi;
                        vec3 ld = (seg * uNsFrame) / uNsSemi;

                        float A = dot(ld, ld);
                        float B = 2.0 * dot(lo, ld);
                        float C = dot(lo, lo) - 1.0;
                        float disc = B * B - 4.0 * A * C;
                        if (disc < 0.0 || A < 1e-9) return -1.0;

                        float sq = sqrt(disc);
                        float t1 = (-B - sq) / (2.0 * A);
                        float t2 = (-B + sq) / (2.0 * A);
                        if (t1 >= 0.0 && t1 <= 1.0) return t1;
                        if (t2 >= 0.0 && t2 <= 1.0) return t2;
                        return -1.0;
                    }

                    /**
                     * Surface colour at a point on the star, with the two shifts a
                     * photon actually picks up on its way here.
                     *
                     * Doppler: the star is orbiting at a fair fraction of c — 0.24
                     * at the start of the run, 0.32 by the plunge — so the limb
                     * coming toward you is beamed and blueshifted and the receding
                     * one is dimmed and reddened. Observed intensity goes as the
                     * fourth power of the Doppler factor, which at these speeds is
                     * a contrast of more than ten to one across the disc. It is not
                     * a stylistic choice; leaving it out was the stylistic choice.
                     *
                     * Gravitational: light climbing out of the hole's well arrives
                     * redder, by √(f(r_star)/f(r_camera)). Passed in as one number
                     * since it does not vary across the star.
                     *
                     * @param world     Hit position, world space.
                     * @param marchDir  Direction the BACKWARD ray was travelling.
                     */
                    vec3 nsSurface(vec3 world, vec3 marchDir) {
                        vec3 local = (world - uNsPos) * uNsFrame;

                        // Undeformed surface direction, so the texture does not
                        // smear as the ellipsoid stretches.
                        vec3 dirW = normalize(uNsFrame * (local / uNsSemi));

                        // The star's own rotation, about the orbital axis. The tidal
                        // bulge stays pointed at the hole while the surface turns
                        // through it — the star is not tidally locked, an inspiral
                        // is far too short for that.
                        float c = cos(uNsSpin), s = sin(uNsSpin);
                        vec3 dirSpun = vec3(c * dirW.x - s * dirW.z, dirW.y, s * dirW.x + c * dirW.z);

                        vec3 albedo = texture2D(uNsTexture, dirToEquirect(dirSpun)).rgb;

                        // The photon travelled from the star to the camera, which is
                        // the direction opposite to our backward march.
                        vec3 toObserver = -normalize(marchDir);
                        float beta2 = clamp(dot(uNsBeta, uNsBeta), 0.0, 0.9801);
                        float gamma = inversesqrt(1.0 - beta2);
                        float doppler = 1.0 / max(gamma * (1.0 - dot(uNsBeta, toObserver)), 1e-3);

                        float shift = doppler * uNsGravShift;
                        float boost = pow(shift, 4.0);

                        // A blueshifted blackbody moves power toward the blue end and
                        // a redshifted one toward the red. Approximated as a tint
                        // rather than an actual spectral integration.
                        vec3 tint = shift > 1.0
                            ? mix(vec3(1.0), vec3(0.72, 0.85, 1.25), clamp(shift - 1.0, 0.0, 1.0))
                            : mix(vec3(1.0), vec3(1.30, 0.62, 0.34), clamp(1.0 - shift, 0.0, 1.0));

                        return albedo * uNsEmission * boost * tint;
                    }

                    // ── The march ────────────────────────────────────────────────

                    /**
                     * Trace one photon backwards. Returns its colour.
                     * Three ways out: the star, the horizon, or the sky.
                     */
                    vec3 trace(vec3 rayDir) {
                        vec3 pos = uCamPos;
                        vec3 vel = normalize(rayDir);

                        float h = length(cross(pos - uBhPos, vel));
                        float escapeR = uRs * ESCAPE_MULT;

                        for (int i = 0; i < MAX_STEPS; i++) {
                            vec3  relPos = pos - uBhPos;
                            float r = length(relPos);

                            // Through the horizon. No colour comes back from here.
                            if (r < uRs * 1.02) return vec3(0.0);

                            // Escaped: read the sky in the direction the photon came from.
                            if (r > escapeR && dot(vel, relPos) > 0.0) {
                                return texture2D(uStarfield, dirToEquirect(vel)).rgb;
                            }

                            float dt = min(DPHI * r * r / max(h, 1e-6), R_FRAC * r);

                            // RK4 on (pos, vel). Euler was adequate in the far field
                            // and visibly not adequate near the photon ring, where a
                            // ray winds through a full revolution.
                            vec3 p1 = vel,                    v1 = geodesicAccel(relPos, vel);
                            vec3 p2 = vel + v1 * (dt * 0.5),  v2 = geodesicAccel(pos + p1 * (dt * 0.5) - uBhPos, vel + v1 * (dt * 0.5));
                            vec3 p3 = vel + v2 * (dt * 0.5),  v3 = geodesicAccel(pos + p2 * (dt * 0.5) - uBhPos, vel + v2 * (dt * 0.5));
                            vec3 p4 = vel + v3 * dt,          v4 = geodesicAccel(pos + p3 * dt - uBhPos,         vel + v3 * dt);

                            vec3 dPos = (p1 + 2.0 * p2 + 2.0 * p3 + p4) * (dt / 6.0);

                            // Did this segment cross the star? The segment can be long
                            // in the far field, so test the whole chord rather than
                            // sampling its endpoints.
                            float tHit = nsSegmentHit(pos, dPos);
                            if (tHit >= 0.0) {
                                return nsSurface(pos + dPos * tHit, vel);
                            }

                            pos += dPos;
                            vel += (v1 + 2.0 * v2 + 2.0 * v3 + v4) * (dt / 6.0);
                        }

                        // Budget exhausted. Measured never to happen with this step
                        // policy — the worst case resolves in 237 of 256 steps — but
                        // if it ever does, a ray still winding this deep is one that
                        // was about to be captured, so black is the honest answer
                        // rather than a stale background sample.
                        return vec3(0.0);
                    }

                    void main() {
                        vec2 ndc = vUv * 2.0 - 1.0;
                        ndc.x *= uAspect;

                        vec3 rayDir = normalize(
                            uCamFwd + ndc.x * uFovTan * uCamRight + ndc.y * uFovTan * uCamUp
                        );

                        // How close is this fragment to the shadow's edge? The impact
                        // parameter is the perpendicular distance from the hole to the
                        // ray, and b_crit = √27·M is where capture begins.
                        float b = length(cross(uCamPos - uBhPos, rayDir));
                        float bCrit = sqrt(27.0) * uRs * 0.5;

                        // One pixel, expressed in the same units as b. The edge is a
                        // discontinuity in the output, so it aliases unless the
                        // fragments that straddle it are supersampled — and only
                        // those, which is well under 1% of the frame.
                        float distToBh = length(uCamPos - uBhPos);
                        float pixelB = distToBh * uFovTan * 2.0 / uResY;

                        // One call site only. Four separate trace() calls would let
                        // the compiler inline four copies of a 256-iteration loop.
                        float edge = step(abs(b - bCrit), 2.5 * pixelB);
                        float px = uFovTan * 2.0 / uResY;
                        int samples = edge > 0.5 ? 4 : 1;

                        vec3 sum = vec3(0.0);
                        for (int s = 0; s < 4; s++) {
                            if (s >= samples) break;
                            float ang = (float(s) + 0.5) * 1.5707963;
                            vec2 off = vec2(cos(ang), sin(ang)) * 0.35 * px * edge;
                            sum += trace(normalize(rayDir + uCamRight * off.x + uCamUp * off.y));
                        }

                        vec3 radiance = sum / float(samples) * uExposure;

                        // Extended Reinhard, so beamed highlights roll off instead
                        // of clipping to white. Applied to radiance, once, at the
                        // end — not folded into any of the physics above.
                        vec3 mapped = radiance * (1.0 + radiance / 9.0) / (1.0 + radiance);

                        gl_FragColor = vec4(mapped, 1.0);
                    }
                `,
                depthWrite: false,
                depthTest: false,
            })
        );
        this.scene.add(this.quad);
    }

    // ── Uniform setters ──────────────────────────────────────────────────

    /** Copies the camera's world basis into the shader. */
    updateCamera(camera) {
        const u = this.quad.material.uniforms;
        u.uCamPos.value.copy(camera.position);

        const fwd = new THREE.Vector3();
        camera.getWorldDirection(fwd);
        u.uCamFwd.value.copy(fwd);

        const right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize();
        u.uCamRight.value.copy(right);
        u.uCamUp.value.copy(new THREE.Vector3().crossVectors(right, fwd));

        u.uFovTan.value = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
        u.uAspect.value = camera.aspect;
    }

    setBhWorld(worldPos, rs) {
        const u = this.quad.material.uniforms;
        u.uBhPos.value.copy(worldPos);
        u.uRs.value = rs;
    }

    /**
     * Place and shape the neutron star.
     *
     * @param {THREE.Vector3} worldPos  Centre of the star.
     * @param {THREE.Matrix3} frame     Columns are the ellipsoid's local axes,
     *                                  the first pointing at the black hole.
     * @param {THREE.Vector3} semiAxes  Semi-axis lengths along those axes.
     */
    setNsGeometry(worldPos, frame, semiAxes) {
        const u = this.quad.material.uniforms;
        u.uNsPos.value.copy(worldPos);
        u.uNsFrame.value.copy(frame);
        u.uNsSemi.value.copy(semiAxes);
    }

    /**
     * @param {THREE.Vector3} beta      Star's velocity as a fraction of c.
     * @param {number} gravShift        √(f(r_star)/f(r_camera)).
     * @param {number} spin             Rotation angle about the orbital axis.
     */
    setNsPhotometry(beta, gravShift, spin) {
        const u = this.quad.material.uniforms;
        u.uNsBeta.value.copy(beta);
        u.uNsGravShift.value = gravShift;
        u.uNsSpin.value = spin;
    }

    setNsVisible(visible) {
        this.quad.material.uniforms.uNsVisible.value = visible ? 1.0 : 0.0;
    }

    setExposure(value) {
        this.quad.material.uniforms.uExposure.value = value;
    }

    setSize(width, height) {
        const u = this.quad.material.uniforms;
        u.uAspect.value = width / height;
        u.uResY.value = height;
    }

    /**
     * Draw. There is no scene pass and no render target: this shader is the
     * whole image. The previous version rendered the Three.js scene into a
     * depth-buffered target every frame and then never sampled it — both
     * meshes had colorWrite off and neither uSceneTexture nor uDepthTexture
     * appeared anywhere in the fragment program. A full-resolution pass plus
     * a depth texture, discarded, sixty times a second.
     */
    render(renderer, mainCamera) {
        this.updateCamera(mainCamera);
        renderer.setRenderTarget(null);
        renderer.clear();
        renderer.render(this.scene, this.camera);
    }

    dispose() {
        this.quad.geometry.dispose();
        this.quad.material.dispose();
    }
}