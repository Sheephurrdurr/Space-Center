// =====================================================================
//  DiveShader.js — what the camera sees
//
//  A per-pixel Kerr raytracer. For every fragment we build a photon in
//  the observer's orthonormal tetrad, flip it past-directed, and
//  integrate it backwards through Kerr spacetime until it either escapes
//  to the sky texture, crosses the accretion disk, or is absorbed.
//
//  Coordinates are Kerr-Schild throughout. They are horizon-penetrating:
//  nothing in the metric blows up at r₊, so exactly the same integrator
//  runs inside and outside the event horizon with no special-casing.
//  That property is the whole reason this exhibit can claim "nothing
//  happens when you cross" and have the image back it up.
//
//  ── Design rules this file follows ─────────────────────────────────
//  1. Everything visible is derived, not painted. There used to be ~240
//     lines of procedural fbm here filling in the dark half of the frame.
//     It looked good and it was invented. It is gone.
//  2. Where an approximation remains, it is named in a comment rather
//     than hidden. See spectralBand() for the big one.
//  3. Nothing keys off the horizon crossing. Visual state is driven by
//     the dark cone (an observable that opens smoothly at the ergosphere)
//     and by uDepth (progress along the trajectory).
//
//  ── Why the interior is not drawn ──────────────────────────────────
//  Measured at r = 0.30 Rs: 55.0% of the observer's sky is real
//  integrated starlight, 23.6% is the dark cone (E_∞ < 0 — no light can
//  reach the eye from those directions at all), and 21.4% is infinitely
//  redshifted. Zero percent runs out of step budget. The raytracer never
//  gave up; the old code simply painted over the half of the image that
//  is black for two good physical reasons.
//
//  What replaced it is one quantity we were already computing per pixel:
//  gShift, the gravitational blueshift. See spectralBand().
// =====================================================================

import * as THREE from 'three';

export function createDiveMaterial({ starfield, noise, rs, spin, width, height,
                                     coldness = 0.45, maxSteps = 900 }) {
    return new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,

        // MAX_STEPS is the loop's compile-time bound. It has to be a
        // #define — GLSL ES will not size a loop from a uniform — but it
        // does not have to be the same number for every preset. Ultra
        // compiles a 280-iteration loop rather than a 900-iteration one
        // it will never finish, which is one less thing for the driver to
        // guess about when it decides how much to unroll. Changing it
        // costs a shader recompile, so main.js only touches it on the
        // quality button, never per frame.
        defines: { MAX_STEPS: maxSteps },

        uniforms: {
            uStarfield:  { value: starfield },

            // 4 octaves of tileable value noise, one per RGBA channel,
            // baked at startup. Replaces 40 procedural hash evaluations
            // per disk crossing with one texture fetch. See makeNoise()
            // in main.js for how the statistics were matched.
            uNoise:      { value: noise },
            uResolution: { value: new THREE.Vector2(width, height) },

            // Camera basis, in Kerr-Schild coordinates (spin along z).
            uCamPos:   { value: new THREE.Vector3(0, 0, 0) },
            uCamFwd:   { value: new THREE.Vector3(0, 0, -1) },
            uCamRight: { value: new THREE.Vector3(1, 0, 0) },
            uCamUp:    { value: new THREE.Vector3(0, 1, 0) },
            uFov:      { value: 62.0 },

            // Direction of "out" — where the universe we left still is.
            // Not normalize(pos): see outAxisFrom() in main.js.
            uOutDir: { value: new THREE.Vector3(1, 0, 0) },

            // Observer's conserved energy A = −u_t. Constant along the
            // geodesic, but the shader cannot derive it without the
            // four-velocity, so main.js sets it once.
            uAobs: { value: 1.0 },

            uRs:        { value: rs },
            uSpin:      { value: spin },
            uTime:      { value: 0.0 },
            uDiskIn:    { value: rs * 1.2 },
            uDiskOut:   { value: rs * 5.5 },
            uColdness:  { value: coldness },

            // Narrative state, all driven from main.js.
            uDraw:  { value: 0.0 },   // dark-cone opening angle, normalised
            uDepth: { value: 0.0 },   // 0 at the horizon → 1 where integration stops
            uBlue:  { value: 0.0 },   // multiplies the real blueshift
            uWhite: { value: 0.0 },   // safety-line white wash, 0 → 1
            uDim:   { value: 1.0 },   // final burn-down, 1 → 0

            // Ring-singularity annotation. 0 = off, which is the default.
            // At 1 it draws a thin neutral contour around the locus, the
            // way a medical viewer outlines a structure that does not
            // itself emit. Honest only if the UI labels it as an overlay:
            // we never reach the ring, and a singularity radiates nothing.
            uRingOverlay: { value: 0.0 },

            // Mean sky colour. Once prefiltering exhausts the mip chain
            // there is no texture left to sample, and this is the right
            // answer rather than a fallback — at g ≈ 2000 the source
            // genuinely is uniform.
            uSkyFlat: { value: new THREE.Vector3(0.052, 0.053, 0.061) },

            uSkySize: { value: 6000.0 },   // texture width, caps the mip level

            // Prefilter strength. This used to exist because texture2D()
            // takes a *bias*: the GPU picked a level from the screen-space
            // uv derivative and ours was added on top, so the number in
            // this uniform was never the number the sampler used. Under
            // GLSL3 the shader calls textureLod() and the level is
            // absolute, so uPrefilter is now an honest multiplier on a
            // quantity we compute ourselves. 1.0 is the baseline; down
            // towards 0.5 if the interior washes out, up towards 1.5 if
            // the shadow edge aliases.
            uPrefilter: { value: 1.0 },

            // Screen-space footprint term, on by default.
            //
            // Going to an absolute LOD means dropping the GPU's own
            // estimate, and that estimate was not worthless — it is the
            // one part of the footprint that is measured per pixel rather
            // than inferred from winding number. So it comes back, but
            // taken from the derivative of the escape *direction* rather
            // than of uv. The uv version had a real bug: u = atan2(...)
            // wraps from 1 to 0 at the anti-meridian, so du/dx jumped to
            // ~1.0 there and the sampler was asked for mip 12.5 — a one
            // pixel wide column of flat grey straight down the starfield
            // wherever that seam was on screen. Direction space has no
            // seam.
            //
            // Set to 0 to go back to inferred-only filtering.
            uFootprint: { value: 1.0 },

            // Mip selection for the disk turbulence. 0 = always level 0,
            // which is what the procedural fbm did (procedural noise has
            // no filtering at all, which is why the outer disk shimmers
            // when the camera moves). 1 = estimate the footprint from
            // path length and let the mip chain do the averaging.
            uDiskLod: { value: 1.0 },

            uMaxSteps: { value: 300.0 },
            uRayStop:  { value: 7.6 },
            uDebug:    { value: 0.0 },

            // Observer tetrad. Four four-vectors, .xyz = space, .w = time.
            uE0: { value: new THREE.Vector4(0,0,0,1) },
            uE1: { value: new THREE.Vector4(1,0,0,0) },
            uE2: { value: new THREE.Vector4(0,1,0,0) },
            uE3: { value: new THREE.Vector4(0,0,1,0) },
        },

        vertexShader: /* glsl */`
            out vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = vec4(position.xy, 0.0, 1.0);
            }
        `,

        fragmentShader: /* glsl */`
            // Three.js prefixes this for a ShaderMaterial already, from
            // renderer.capabilities.precision. It is repeated here because
            // this is not a cosmetic choice: the Kerr metric carries
            // D = r^4 + a^2 z^2, and at r = 160 (ESCAPE_DIST) that is
            // 6.6e8. mediump tops out at 65504, so a fragment shader that
            // silently fell back to mediump would not look slightly worse,
            // it would produce NaN for every ray that got more than about
            // 16 units out. main.js checks the device actually has highp
            // and says so if it does not.
            precision highp float;
            precision highp int;

            out vec4 fragColor;

            uniform sampler2D uStarfield;
            uniform sampler2D uNoise;
            uniform vec2  uResolution;
            uniform vec3  uCamPos, uCamFwd, uCamRight, uCamUp;
            uniform vec3  uOutDir;
            uniform float uAobs;
            uniform float uFov, uRs, uSpin, uTime;
            uniform float uDiskIn, uDiskOut, uColdness;
            uniform float uDraw, uDepth;
            uniform float uBlue, uWhite, uDim;
            in vec2 vUv;

            uniform float uMaxSteps;
            uniform float uRayStop, uDebug;
            uniform float uRingOverlay, uSkySize, uPrefilter;
            uniform float uFootprint, uDiskLod;
            uniform vec3  uSkyFlat;

            uniform vec4 uE0, uE1, uE2, uE3; // .xyz = space, .w = time

            // MAX_STEPS now arrives from material.defines, set per quality
            // preset, so the compiled loop bound and the runtime budget in
            // uMaxSteps agree instead of the second always being smaller
            // than the first. uMaxSteps stays because the adaptive
            // resolution controller can still lower it without a recompile.
            //
            // 900 rather than 384 because of one narrow band. Measured at
            // r = 1.28 Rs, with the camera practically on the prograde
            // photon sphere, a ~10° band of directions costs up to 819
            // steps as rays wind around the hole. At 384 that whole band
            // went black, and that was the jagged edge along the shadow.
            // The loop breaks the moment a ray resolves, so the 95% of
            // pixels that finish in 130–250 steps pay nothing for the
            // higher ceiling.
            #define ESCAPE_DIST 160.0
            #define PI 3.14159265358979

            // World is y-up; Kerr-Schild puts the spin along z. Pure rotation.
            vec3 fromKS(vec3 v) { return vec3(v.x, v.z, -v.y); }

            /**
             * Per-pixel hash, integer.
             *
             * This was fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453),
             * the one everybody uses. It works on desktop and it is not
             * portable: sin() is only required to be accurate to a few ULP
             * over a limited range, and the whole trick depends on the
             * garbage *below* that accuracy. Where the implementation is
             * good the garbage is correlated between neighbouring pixels;
             * where the argument gets large it degrades differently again.
             * Apple Silicon and several mobile parts are the usual places
             * it shows up.
             *
             * The consequence here is milder than it would be in a shading
             * term — this drives a 5% step-length dither, so a correlated
             * hash means neighbouring rays take identical steps and the
             * dither stops doing its job rather than producing a visible
             * pattern of its own. Which is exactly the failure that is hard
             * to notice on the machine you develop on.
             *
             * PCG on the integer pixel coordinate. Same instruction
             * sequence on every GPU, and gl_FragCoord is already the
             * integer we want, so no float->int rounding to get wrong.
             */
            uint pcg(uvec2 v) {
                v = v * uvec2(1597334677u, 3812015801u);
                uint q = (v.x ^ v.y) * 1597334677u;
                return q ^ (q >> 16);
            }
            float pixelHash() {
                return float(pcg(uvec2(gl_FragCoord.xy))) * (1.0 / 4294967296.0);
            }

            vec2 dirToEquirect(vec3 dir) {
                dir = normalize(dir);
                float u = 0.5 + atan(dir.z, dir.x) / (2.0 * PI);
                float v = 0.5 - asin(clamp(dir.y, -1.0, 1.0)) / PI;
                return vec2(u, v);
            }

            /**
             * Sky lookup at an explicit mip level.
             *
             * lod is not a blur effect. When the sky is compressed 680× into
             * one screen pixel (measured), that pixel covers 680× more solid
             * angle than it did in flat space, and a point sample is simply
             * the wrong integral. The average over the footprint is the
             * answer, and a mip level is exactly that average.
             */
            vec3 skyColor(vec3 ksDir, float lod) {
                vec2 uv = dirToEquirect(fromKS(ksDir));
                // textureLod, not texture(uv, bias). The level we pass is
                // a solid angle we computed; adding whatever the hardware
                // guessed on top of it made the number mean nothing, and
                // near the uv seam what it guessed was mip 12.
                vec3 c  = textureLod(uStarfield, uv, lod).rgb;
                float gone = smoothstep(log2(uSkySize) - 3.5, log2(uSkySize) - 0.5, lod);
                return mix(c, uSkyFlat, gone);
            }

            // =========================================================
            //  KERR-SCHILD GEOMETRY
            // =========================================================

            /**
             * Kerr-Schild radius. Note r != length(x): surfaces of constant
             * r are oblate spheroids. Solved as a quadratic in r².
             */
            float ksR(vec3 x, float a) {
                float rho2 = dot(x, x);
                float b    = rho2 - a * a;
                float r2   = 0.5 * (b + sqrt(b * b + 4.0 * a * a * x.z * x.z));
                return sqrt(max(r2, 1e-6));
            }

            /**
             * The entire Kerr metric, as g = eta + f (l ⊗ l).
             *
             * r, D and W are carried along because the analytic gradient in
             * dpdl() needs all three and recomputing them costs another sqrt.
             */
            struct Metric {
                float r;   // Kerr-Schild radius
                float f;   // scalar potential, 2M r³ / D
                vec3  l;   // principal null direction (unit, spatially)
                float D;   // r⁴ + a²z²
                float W;   // r² + a²
            };

            Metric metricAt(vec3 x) {
                float M  = 0.5 * uRs;
                float a  = uSpin * M;
                float r  = ksR(x, a);
                float r2 = r * r;

                Metric m;
                m.r = r;
                m.D = r2 * r2 + a * a * x.z * x.z;
                m.W = r2 + a * a;
                m.f = 2.0 * M * r2 * r / m.D;
                m.l = vec3((r * x.x + a * x.y) / m.W,
                           (r * x.y - a * x.x) / m.W,
                           x.z / r);
                return m;
            }

            /** H = ½ g^{μν} p_μ p_ν. Light: H = 0. Kept for diagnostics. */
            float hamiltonian(vec3 x, vec3 p, float pt) {
                Metric m = metricAt(x);
                float  S = dot(m.l, p) - pt;
                return 0.5 * (-pt * pt + dot(p, p) - m.f * S * S);
            }

            /** dx/dλ = ∂H/∂p. Trivial: H is quadratic in p. */
            vec3 dxdl(vec3 x, vec3 p, float pt) {
                Metric m = metricAt(x);
                return p - m.f * (dot(m.l, p) - pt) * m.l;
            }

            /**
             * dp/dλ = −∂H/∂x, in closed form.
             *
             * This used to be a central difference: six hamiltonian() calls
             * per evaluation, four evaluations per RK4 step, so 28 metric
             * evaluations per step against the 4 it takes now. It was the
             * single largest cost in the shader and it dominated the frame.
             *
             * It was also the least accurate part. Against a converged
             * reference, the old eps = 0.01 difference was off by 4.4% at
             * r = 0.275 Rs — the closest approach, where the geometry varies
             * fastest over that epsilon. The closed form agrees with a
             * refined difference to ~1e-5 everywhere, which is the
             * difference's own truncation error rather than ours.
             *
             * Derivation. With H = ½(−p_t² + p·p − f S²) and S = l·p − p_t,
             * only f and l depend on x, so
             *
             *     −∂H/∂x = ½ S² ∇f + f S ∇(l·p)
             *
             * and both gradients reduce to ∇r plus bookkeeping. Differ-
             * entiating the defining relation r⁴ − (ρ²−a²)r² − a²z² = 0,
             *
             *     ∇r = (r³x, r³y, r z (r²+a²)) / D,    D = r⁴ + a²z²
             *
             * f = 2M r³/D gives ∇f directly, and l has a closed-form
             * Jacobian whose contraction with p collapses to one scalar C
             * times ∇r plus a residual term.
             */
            vec3 dpdl(vec3 x, Metric m, vec3 p, float pt) {
                float M  = 0.5 * uRs;
                float a  = uSpin * M;
                float r  = m.r;
                float r2 = r * r, r3 = r2 * r;
                float az = a * x.z;
                float iD = 1.0 / m.D;

                // ∇r
                vec3 gr = vec3(r3 * x.x, r3 * x.y, r * x.z * m.W) * iD;

                // ∇f. The z term is the part that does not travel through ∇r,
                // and it is why the gradient is not simply radial off-plane.
                float gf = 2.0 * M * r2 * (3.0 * az * az - r2 * r2) * iD * iD;
                vec3  gF = gf * gr - vec3(0.0, 0.0, 4.0 * M * a * a * x.z * r3 * iD * iD);

                // ∇(l·p)
                float Q = p.x * x.x + p.y * x.y;      // radial part in the plane
                float L = p.x * x.y - p.y * x.x;      // −L_z, the frame-dragging part
                float C = Q / m.W - 2.0 * r * (r * Q + a * L) / (m.W * m.W) - p.z * x.z / r2;
                vec3  gL = C * gr + vec3((p.x * r - p.y * a) / m.W,
                                         (p.x * a + p.y * r) / m.W,
                                          p.z / r);

                float S = dot(m.l, p) - pt;
                return 0.5 * S * S * gF + m.f * S * gL;
            }

            struct Deriv { vec3 dx; vec3 dp; };

            /** Both halves of Hamilton's equations from one metric evaluation. */
            Deriv derivAt(vec3 x, Metric m, vec3 p, float pt) {
                Deriv d;
                d.dx = p - m.f * (dot(m.l, p) - pt) * m.l;
                d.dp = dpdl(x, m, p, pt);
                return d;
            }

            Deriv deriv(vec3 x, vec3 p, float pt) {
                return derivAt(x, metricAt(x), p, pt);
            }

            // =========================================================
            //  ACCRETION DISK
            // =========================================================

            /**
             * Four octaves of value noise, in one fetch.
             *
             * This was five octaves of procedural value noise: 4 hash
             * evaluations per octave, 20 per fbm, and diskPattern() calls
             * fbm twice for the cross-fade, so 40 hashes every time a ray
             * crossed the equator. A ray that winds around the hole crosses
             * two or three times. That was ~500 ALU sitting inside the
             * raymarching loop, which is the most expensive place in the
             * whole shader to put anything.
             *
             * The four channels of uNoise hold the same field at 8, 16, 32
             * and 64 cells across the tile, each with its own seed, baked
             * with the same hash and the same smoothstep interpolant the
             * procedural version used. One fetch gives all four octaves
             * because they share a uv.
             *
             * Two things changed and both were measured over the actual
             * disk domain (r from ISCO to 5.5 Rs, all angles, 200k samples):
             *
             *   lacunarity 2.1 -> 2.0, forced, because a tileable field
             *   needs each octave to be an integer number of cells per
             *   tile. The octaves are decorrelated by seed instead of by
             *   the old p*2.1 + 17.3 shuffle.
             *
             *   five octaves -> four. The fifth carried amplitude 1/32.
             *
             *   old:  mean 0.4825  sd 0.1234
             *   new:  mean 0.4837  sd 0.1204
             *
             * The mad below pins the second to the first exactly, so the
             * disk's brightness and contrast are unchanged rather than
             * approximately unchanged. (For the record: the old comment on
             * diskSample() claimed this had a mean near 0.25. It does not
             * and never did — it is 0.48, so sw averages 1.22, not 0.9.
             * Nothing is broken, the number in the comment was just wrong,
             * and it is corrected there.)
             */
            #define NOISE_TILE 8.0

            float fbmLod(vec2 p, float lod) {
                vec4 o = textureLod(uNoise, p * (1.0 / NOISE_TILE), lod);
                float v = dot(o, vec4(0.5, 0.25, 0.125, 0.0625));
                return v * 1.0241 - 0.0126;
            }

            /**
             * Turbulence, advected at the local orbital rate and cross-faded
             * between two offset copies so it never visibly loops.
             *
             * The noise-space ring radius has to grow with r. When it did not,
             * the whole circumference of the disk was mapped onto the same
             * small circle regardless of physical size, so the outer disk had
             * the same number of cells as the inner one.
             */
            float diskPattern(float r, float ang, float Om, float lod) {
                float SPEED = 14.0, T = 3.0;
                float t1 = mod(uTime, T), t2 = mod(uTime + 0.5*T, T);
                float w  = abs(t1 / T * 2.0 - 1.0);
                float p1 = ang - Om * t1 * SPEED, p2 = ang - Om * t2 * SPEED;

                float ringNoise = 1.6 + 0.14 * r;
                vec2 q1 = vec2(r*1.1, 0.0) + ringNoise * vec2(cos(p1), sin(p1));
                vec2 q2 = vec2(r*1.1, 0.0) + ringNoise * vec2(cos(p2), sin(p2));
                return mix(fbmLod(q1, lod), fbmLod(q2, lod), w);
            }

            /**
             * Disk emission and opacity where a ray crosses the equator.
             *
             * g packs Doppler beaming and gravitational redshift into one
             * number, computed from the photon's conserved E and L_z. It is a
             * ratio of two quantities that both scale with the photon's affine
             * normalisation, so it is insensitive to the fact that we rescale p.
             */
            vec4 diskSample(vec3 xc, vec3 p, float pt, float lod) {
                float M = 0.5 * uRs;
                float a = uSpin * M;
                float r = ksR(xc, a);
                if (r < uDiskIn || r > uDiskOut) return vec4(0.0);

                float Om = sqrt(M) / (pow(r, 1.5) + a * sqrt(M));
                float ut = 1.0 / sqrt(max(1.0 - 3.0*M/r + 2.0*a*sqrt(M)/pow(r,1.5), 0.02));

                // We trace *backwards* from the tetrad, so these photons are
                // past-directed: pt > 0 and E = −pt < 0. g itself is invariant
                // under flipping (p, pt) — E and L_z both flip and the signs
                // cancel — but the max(..., 0.05) guard below is not, and with
                // E < 0 it clamped the denominator for every disk pixel, pinning
                // g at its floor. Effect: no beaming at all, plus a constant
                // 0.4³ ≈ 0.064 dimming of the whole disk. Hence the explicit sign.
                float sgn = pt > 0.0 ? -1.0 : 1.0;
                float E   = -sgn * pt;
                float Lz  = sgn * (xc.x * p.y - xc.y * p.x);
                float g   = E / max(ut * (E - Om * Lz), 0.05);

                // R0 is where the disk reads as fully white-hot. The steep
                // exponent is what produces a white inner edge and an orange
                // outer one rather than a single flat tone.
                float R0   = uRs * 1.5;
                float heat = pow(R0 / r, 1.5) * sqrt(max(1.0 - sqrt(uDiskIn / r), 0.0));

                // diskPattern() has a measured mean of 0.4831 over this
                // domain, so sw averages 1.22 and ranges roughly 0.7-1.7.
                // (An earlier comment here said the mean was 0.25 and that
                // these constants were chosen to land sw near 0.9. That was
                // never true of the code as written; the number is measured
                // now rather than remembered.)
                float ang = atan(xc.y, xc.x);
                float sw  = 0.50 + 1.5 * diskPattern(r, ang, Om, lod);

                vec3 hotCol  = mix(vec3(1.00,0.97,0.90), vec3(1.00,0.72,0.36), uColdness);
                vec3 coolCol = mix(vec3(1.00,0.60,0.26), vec3(0.96,0.36,0.11), uColdness);
                vec3 col = mix(coolCol, hotCol, clamp(heat, 0.0, 1.0));
                float lum = (0.40 + 3.0 * heat) * sw;

                // Beaming. g sits below 1 nearly everywhere because gravitational
                // redshift drags the whole disk down regardless of which way the
                // gas moves, and cubed that is a flat 2–3× dimming. GAIN restores
                // the level without touching contrast: the approaching/receding
                // ratio stays at the real ~10:1, only the zero point is chosen.
                const float GAIN = 0.6;
                lum *= GAIN * pow(clamp(g, 0.40, 2.4), 3.0);
                col  = mix(col * vec3(1.22,0.80,0.60), col * vec3(0.86,0.95,1.35),
                           smoothstep(0.8, 1.3, g));

                float edge = smoothstep(uDiskIn, uDiskIn*1.15, r)
                           * (1.0 - smoothstep(uDiskOut*0.88, uDiskOut, r));

                return vec4(col * lum * edge, 0.9 * edge);
            }

            // =========================================================
            //  THE SPECTRUM
            // =========================================================
            //
            // This one function replaces everything that used to be painted.
            //
            // Blueshift does not tint light blue. It moves the entire spectrum
            // up in frequency by a factor g. The eye sees 400–700 nm and
            // nothing else, so what you are actually looking at is the source's
            // spectrum at 400/g to 700/g nm. At g = 10 that is near-IR, at
            // g = 100 far-IR, at g = 2000 the microwave background.
            //
            // Three consequences, none of them chosen:
            //
            //   Stars go out long before the sky goes dark. They leave the
            //   passband from the top. There is still light — it is a different
            //   set of sources with a different pattern.
            //
            //   Structure disappears before brightness does. The far-IR sky is
            //   dust glow, not point sources: smoother, more diffuse. At
            //   microwave it is uniform to one part in 10⁵. That is why the
            //   band drives lod as well as tint, and lod is the more important
            //   of the two.
            //
            //   The ending is daylight. A blackbody stays a blackbody under
            //   Doppler shift, just hotter: 2.725 K × 1900 = 5180 K, which is
            //   the colour of sunlight. The screen goes white on its own.
            //
            // ── Where this is an approximation ─────────────────────────────
            // We have one optical 6000×3000 texture and no IR, microwave or
            // radio sky to look up. The MECHANISM is right — which band sits in
            // the visible when, how much structure survives, what colour it is.
            // The CONTENT is approximate: the real IR sky is not a blurred copy
            // of the optical one. A much smaller lie than procedural fbm, but a
            // lie, and it is written down here rather than hidden.
            struct Band { vec3 tint; float lod; };

            Band spectralBand(float g) {
                float s = log2(max(g, 1e-3)) * 0.30103;   // log10(g)

                //   s ≈ 0.0  optical, unchanged
                //   s ≈ 0.3  g = 2, the blue you expect
                //   s ≈ 1.0  g = 10, near-IR: warm
                //   s ≈ 2.0  g = 100, far-IR: deep amber
                //   s ≈ 3.3  g = 2000, CMB: 5180 K, flat daylight
                //   s > 3.6  radio, faint and violet
                vec3 c = vec3(1.0);
                c = mix(c, vec3(0.68, 0.84, 1.34), smoothstep(0.00, 0.42, s));
                c = mix(c, vec3(1.34, 0.86, 0.56), smoothstep(0.42, 1.15, s));
                c = mix(c, vec3(1.38, 0.74, 0.38), smoothstep(1.15, 2.10, s));
                c = mix(c, vec3(1.00, 0.955, 0.90), smoothstep(2.10, 3.30, s));
                c = mix(c, vec3(0.62, 0.55, 0.86), smoothstep(3.55, 4.40, s));

                Band b;
                b.tint = c;
                b.lod  = smoothstep(0.35, 3.20, s) * (log2(uSkySize) - 0.2);
                return b;
            }

            // =========================================================
            //  ANNOTATION
            // =========================================================

            /**
             * Contour around the ring singularity's locus: z = 0, x² + y² = a².
             * Real geometry — a ring, not a point.
             *
             * Constant width on purpose. An earlier version grew wider and 14×
             * brighter with depth, which made it read as a light source being
             * approached. It is not one: we never reach it, it emits nothing,
             * and no photon in this scene originates there. It is a line drawn
             * on top of the image, and it is off by default.
             */
            float ringContour(vec3 x, vec3 dir, float a) {
                if (abs(dir.z) < 1e-4) return 0.0;
                float t = -x.z / dir.z;
                if (t < 0.0) return 0.0;
                vec3 q = x + t * dir;
                float d = abs(length(q.xy) - a);
                float w = 0.035 * a;
                return exp(-(d*d) / (w*w)) / (1.0 + 0.02 * t * t);
            }

            /**
             * Everything that is NOT raytraced, in one place, so it is obvious
             * how little is left. Currently: one contour, disabled by default.
             *
             * dir is the *un-aberrated* view direction. Aberration squeezes all
             * pixels into a fraction of a degree near the end, and an annotation
             * that followed it would collapse to a point. The physics must
             * aberrate; the signage must stay readable.
             */
            vec3 annotate(vec3 x, vec3 dir, vec3 base) {
                float w = uRingOverlay * clamp(uDraw, 0.0, 1.0);
                if (w < 0.002) return base;
                float a = uSpin * 0.5 * uRs;
                float ring = ringContour(x, dir, a);
                return base + vec3(0.85, 0.88, 0.95) * ring * w * 0.35;
            }

            // =========================================================
            void main() {

                vec2 ndc = vUv * 2.0 - 1.0;
                ndc.x *= uResolution.x / uResolution.y;
                float halfFovTan = tan(radians(uFov * 0.5));

                // Angular size of one pixel, before lensing. Used for
                // texture footprints, not for physics.
                float pixAng = 2.0 * halfFovTan / max(uResolution.y, 1.0);

                // Direction to this pixel, in the camera's own frame.
                vec3 nl = normalize(vec3(ndc.x * halfFovTan,
                                         ndc.y * halfFovTan, 1.0));

                float M = 0.5 * uRs;
                float a = uSpin * M;

                // Same pixel without aberration. Used only by annotate().
                vec3 dirLocal = normalize(nl.x * uCamRight + nl.y * uCamUp + nl.z * uCamFwd);

                // The photon the observer sees is incoming, so we follow it
                // backwards in time: k = −e0 + n·(e1,e2,e3). The minus on e0
                // is what makes it past-directed. Nothing here is guessed.
                vec4 k = -uE0 + nl.x * uE1 + nl.y * uE2 + nl.z * uE3;

                vec3 x = uCamPos;

                // Lower the index: the integrator works with p_μ, not p^μ.
                Metric m0 = metricAt(x);
                float  Lk = k.w + dot(m0.l, k.xyz);
                float  pt = -k.w + m0.f * Lk;
                vec3   p  = k.xyz + m0.f * Lk * m0.l;

                // ── Affine normalisation ────────────────────────────────
                // A null geodesic is the same curve under any rescaling of its
                // parameter, so (p, pt) may be multiplied by anything. Without
                // this, |p| carries the camera's boost: down at r ≈ 0.3 Rs it
                // was ~90 for some pixels and ~20 for others, so the |p|² safety
                // limit below fired at different *geometric* places depending on
                // the observer's speed. The shadow edge then moved with the boost
                // instead of with the geometry, and that was the image pulsing in
                // size on the way down. With |p| = 1 for every pixel, the limit
                // means what it should: "this ray is diverging".
                float sc = 1.0 / max(length(p), 1e-6);
                p  *= sc;
                pt *= sc;

                // The photon is past-directed, so E_∞ for the forward-directed
                // photon is +pt. pt <= 0 means negative energy at infinity, and
                // there is no negative-energy light in the exterior universe. In
                // the maximally extended solution that light comes from a white
                // hole, which a collapse-formed black hole does not have. Black,
                // for free.
                //
                // The boundary pt = 0 is a cone, cos θ = A / sqrt(A² − 1 + f).
                // It opens at the ergosphere (f = 1) and grows towards 90°.
                // It never closes the universe down to a small circle: you lose
                // just under a third of the sky on the way in, no more.
                bool noSource = (pt <= 0.0);

                // Diagnostic code. Free in normal operation (written, read only
                // in the debug branch) and the only way to tell apart four
                // outcomes that are all black pixels:
                //   1 = no source. E_∞ ≤ 0, the real dark cone.
                //   2 = |p|² diverged. Infinitely redshifted — the shadow.
                //   3 = ray reached uRayStop.
                //   4 = step budget ran out without resolving.
                float why = noSource ? 1.0 : 4.0;

                // g = E_observed / E_infinity. E_obs is 1 before normalisation
                // (that is the definition of the tetrad), E_∞ is |p_t|. Note the
                // sign: light catching up with a falling observer from behind
                // gets *redder*, not bluer.
                //
                // The ceiling was 2.8, then 12, then 15. It is 6000 now, and that
                // is not an indulgence — the low ceiling cut the story in half.
                // At the cone's edge E_∞ → 0 and g → ∞, and the whole spectral
                // cascade lives at that upper end: g ≈ 10 near-IR, 100 far-IR,
                // 2000 the microwave background. Capped at 15 we never got past
                // "slightly blue" and the rest had to be painted on.
                float gShift = clamp(sc / max(abs(pt), 1e-6), 0.05, 6000.0);

                // ── The cone as a continuous quantity ───────────────────
                // The underlying scalar is smooth everywhere:
                //     E_∞(n) = A + n·B,   |B|² = A² − 1 + f
                // running from A−|B| on the cone axis, through exactly zero at
                // the rim, to A+|B| at the centre of the window out. Normalising
                // by (|B|−A) gives a coordinate that is 1 mid-cone and 0 at the
                // rim at any depth. Measured along this trajectory:
                //     r/Rs 0.900 → cone 19.3°, |B|−A = 0.057
                //     r/Rs 0.763 → cone 30.3°, |B|−A = 0.151   (horizon)
                //     r/Rs 0.590 → cone 41.2°, |B|−A = 0.314
                //     r/Rs 0.300 → cone 57.9°, |B|−A = 0.841
                float Einf  = pt / max(sc, 1e-12);
                float Bmag  = sqrt(max(uAobs * uAobs - 1.0 + m0.f, 0.0));
                float coneS = -Einf / max(Bmag - uAobs, 1e-4);

                // ── Disk fade ───────────────────────────────────────────
                // Must multiply emission AND opacity. When it only scaled
                // emission, the disk kept full alpha while its light dropped to
                // 30% — it stopped being a source and became a pure absorber, an
                // invisible object shadowing the sky behind it. That was the
                // dotted dark arc: the equator crossing is detected per step, so
                // a ray running nearly parallel to the plane registers a sign
                // flip on some steps and not others.
                float diskFade = mix(1.0, 0.30,
                                     smoothstep(0.10, 0.85, clamp(uDepth, 0.0, 1.0)));

                bool escaped = false, dead = noSource;
                int steps = 0;

                vec3 outD = p, emission = vec3(0.0);
                float trans = 1.0;

                // ── Winding ─────────────────────────────────────────────
                // A ray that wraps once around the hole gives the primary image
                // of the sky; twice, the secondary; and so on, stacked ever
                // tighter against the shadow edge. Specific intensity is
                // invariant along a null geodesic, so the secondary image is
                // exactly as bright as the primary — not fainter, just squeezed,
                // by up to 680× (measured). There is nothing to draw. There is
                // only something not to destroy, and you avoid destroying it by
                // sampling the sky over the right footprint instead of at a point.
                float swept = 0.0;

                // Coordinate distance travelled. One add per step. Used only
                // to size the disk's texture footprint: a turbulence cell
                // 40 units away covers far less of the screen than the same
                // cell at 5 units, and level 0 is the wrong sample for it.
                // Not proper distance — it does not need to be, it is a
                // footprint estimate and it is clamped.
                float pathLen = 0.0;
                vec3  prevDir = vec3(0.0);
                bool  hasPrev = false;

                // ── Loop invariants, hoisted ────────────────────────────
                // All three of these were being recomputed up to 900 times per
                // pixel for no reason. The jitter hash in particular depends
                // only on the pixel.
                float jitterFar = 0.95 + 0.1 * pixelHash();
                float pMax2     = mix(1.0e4, 4.0e3, smoothstep(0.20, 0.80, clamp(uDepth, 0.0, 1.0)));
                float bandLo    = uRs * 0.6, bandMid = uRs * 1.0;
                float bandHi    = uRs * 1.6, bandOut = uRs * 4.0;

                Metric m = m0;   // metric at the current x, carried across the step

                for (int i = 0; i < MAX_STEPS; i++) {
                    if (dead || float(i) >= uMaxSteps) break;

                    steps++;

                    // m.r is the loop's radius test as well as the geometry for
                    // this step's k1 — one metric evaluation serving both.
                    float r = m.r;
                    if (r < uRayStop) { dead = true; why = 3.0; break; }

                    // Rays asymptotically approaching the horizon make |p|
                    // diverge. They came from the infinite past and are
                    // infinitely redshifted, i.e. black. Without this the
                    // Hamiltonian runs to 1e57 and everything goes NaN.
                    //
                    // The limit decides which rays are declared dead, i.e. the
                    // shadow's edge — a change in the *image*. It therefore
                    // hangs on uDepth and moves well inside, not on the horizon
                    // crossing where nothing is allowed to happen.
                    if (dot(p, p) > pMax2) { dead = true; why = 2.0; break; }

                    Deriv k1 = derivAt(x, m, p, pt);

                    // sqrt(2(1−cos θ)) instead of acos. For small θ,
                    // 1 − cos θ ≈ θ²/2, and the steps are small by construction.
                    // One sqrt instead of one acos, in a loop that runs up to 900×.
                    vec3 dirNow = normalize(k1.dx + 1e-9);
                    if (hasPrev) swept += sqrt(2.0 * max(1.0 - dot(dirNow, prevDir), 0.0));
                    prevDir = dirNow; hasPrev = true;

                    if (r > ESCAPE_DIST || (r > uRs * 8.0 && dot(k1.dx, x) > 0.0)) {
                        escaped = true; why = 0.0; outD = k1.dx; break;
                    }

                    float jitter = r > bandOut ? jitterFar : 1.0;

                    // ── Step length ─────────────────────────────────────
                    // The intent is that dl·|dx| is the physical distance the ray
                    // moves. |p| is normalised to 1 at the camera and the camera
                    // is deeply boosted, so out in flat space |p| is around 0.02;
                    // an old floor of 0.25 in this denominator meant each step
                    // advanced a twelfth of what the formula thought.
                    float sp   = max(length(k1.dx), 1e-4);
                    float want = min(1.1 * clamp(r / (uRs * 1.5), 0.3, 8.0) * jitter, 0.5 * r);

                    // Tightening near the photon sphere. Removing that floor also
                    // removed the accidental brake it placed exactly where rays
                    // wind many times around the hole, and a narrow band inside
                    // the shadow started leaking rays that should not escape —
                    // salt grains in the black. Not the jitter: one over-long RK4
                    // step flinging a spiralling ray out along a tangent.
                    //
                    // Measured with 420 directions through the shadow edge: the
                    // leak vanishes at K = 2, K = 3 leaves margin, and deep inside
                    // it costs 195 steps against 131. Weighting by uRs/r alone
                    // does not work — that is 3.6 down at r = 0.275 Rs where there
                    // is no problem at all, and it strangles the whole interior.
                    float band = (1.0 - smoothstep(bandHi, bandOut, r))
                               * smoothstep(bandLo, bandMid, r);
                    want /= (1.0 + 3.0 * band);

                    pathLen += want;

                    float dl = want / sp;

                    Deriv k2 = deriv(x + 0.5*dl*k1.dx, p + 0.5*dl*k1.dp, pt);
                    Deriv k3 = deriv(x + 0.5*dl*k2.dx, p + 0.5*dl*k2.dp, pt);
                    Deriv k4 = deriv(x + dl*k3.dx,     p + dl*k3.dp,     pt);

                    vec3 x0 = x;
                    x += dl/6.0 * (k1.dx + 2.0*k2.dx + 2.0*k3.dx + k4.dx);
                    p += dl/6.0 * (k1.dp + 2.0*k2.dp + 2.0*k3.dp + k4.dp);

                    // Refresh once per step, reused by the next iteration's
                    // radius test and k1.
                    m = metricAt(x);

                    if (x0.z * x.z < 0.0) {
                        float tC = x0.z / (x0.z - x.z);

                        // Footprint of one screen pixel at this distance,
                        // converted to texels of uNoise. pixAng is radians
                        // per pixel; 1.1 is d(noise coordinate)/d(radius)
                        // from diskPattern's q = vec2(r*1.1, 0) + ...; and
                        // 64 is texels per noise unit — a 512 texture over
                        // NOISE_TILE = 8 units.
                        //
                        // This has to be an explicit level. An implicit one
                        // — texture() without a lod — is undefined inside
                        // divergent control flow, and this is as divergent
                        // as control flow gets: the four pixels of a quad
                        // are on different iterations of the loop and quite
                        // possibly on different sides of the disk.
                        float texels  = pathLen * pixAng * 1.1 * 64.0;
                        float dLod    = uDiskLod * clamp(log2(max(texels, 1.0)), 0.0, 8.0);

                        vec4  d  = diskSample(mix(x0, x, tC), p, pt, dLod);
                        emission += trans * d.rgb * diskFade;
                        trans    *= (1.0 - d.a * diskFade);
                        if (trans < 0.02) break;
                    }
                }

                // ── How far up the spectrum are we? ─────────────────────
                // uBlue is not an effect layered on top. It multiplies g, i.e.
                // the blueshift itself, and colour, structure and brightness all
                // follow from there. One number drives the ending and it is a
                // physical one.
                //
                // boost is the uniform part: the same factor for every pixel. It
                // carries the spectrum forward. It says nothing about how the
                // image is distributed and therefore must not decide brightness
                // — see the exponent below.
                // ── Why boost is exponential and not linear ──
                // The cascade is logarithmic in g: g ≈ 2 is the blue you
                // expect, 10 near-IR, 100 far-IR, 2000 the microwave
                // background. A linear ramp therefore spends its entire
                // range inside the top decade.
                //
                // Measured, with the camera parked at r = 0.275 Rs and the
                // sky window filling the frame, median gShift = 0.614:
                //
                //   uBlue    1 + 320·uBlue → gEff     10^(3.5·uBlue) → gEff
                //   0.10        33    20.3  near-IR       2.2     1.4  optical
                //   0.30        97    59.6  far-IR       11.2     6.9  near-IR
                //   0.50       161    98.8  far-IR       56.2    34.5  far-IR
                //   0.85       273   167.6  far-IR      944.1   579.6  CMB
                //   1.00       321   197.1  far-IR     3162.3  1941.5  CMB
                //
                // The linear law jumps straight to far-IR at the very start
                // of the finale and then sits there: the median pixel tops
                // out at g = 197, so it never reaches the microwave band at
                // all. Only 39% of the frame got there, and the white ending
                // was therefore still being delivered by the uWhite wash —
                // asserted, which is the exact thing this rewrite exists to
                // remove. With 10^(3.5·uBlue) the median pixel lands at 1942
                // and 100% of the frame reaches daylight on its own.
                float boost = pow(10.0, uBlue * 3.5);
                float gEff  = clamp(gShift * boost, 0.05, 6000.0);
                Band  band  = spectralBand(gEff);

                // ── Prefiltering ────────────────────────────────────────
                // Two independent reasons to sample wider, so they add.
                //
                //   band.lod — the source genuinely has less structure in the
                //     band now sitting in the visible. Dust glow rather than
                //     point sources, and eventually a background uniform to one
                //     part in 10⁵.
                //
                //   orderLod — the sky is folded several times into the same
                //     pixel. The first wrap is the primary image; everything
                //     beyond it is a repeat, equally bright and exponentially
                //     thinner. A point sample there is simply wrong.
                //
                // The threshold is measured, not guessed. It was going to be a
                // fixed 0.70 turns until the distribution of swept over the whole
                // sky showed the baseline moves sharply with depth — even a
                // "direct" ray bends a lot down here:
                //
                //   r/Rs     median    p95      fraction over 0.70
                //   1.050     0.24     0.82          7.5%
                //   0.763     0.37     1.05         16.4%
                //   0.500     0.52     1.28         29.2%
                //   0.300     0.84     1.66         67.2%
                //
                // A fixed 0.70 would prefilter two thirds of the entire sky at
                // 0.30 Rs — precisely the washout we are trying to avoid. The
                // threshold has to track the baseline so it keeps catching the
                // tail rather than the middle; 0.75 + 0.55·uDepth sits around
                // p85–p90 all the way down.
                float order    = swept / (2.0 * PI);
                float thr      = 0.75 + 0.55 * clamp(uDepth, 0.0, 1.0);
                float orderLod = clamp((order - thr) * 1.8, 0.0, 4.0);

                //   dirLod — the measured term. How much the escape
                //     direction changes between this pixel and its
                //     neighbours, i.e. the actual solid angle this pixel
                //     collects, in radians; times uSkySize/2pi to get
                //     texels. Where the sky is magnified this is negative
                //     and gets clamped away; where it is compressed by a
                //     winding it is the sharpest estimate we have, because
                //     it does not care *why* the compression happened.
                //
                //     dFdx here and not inside the loop: derivatives need
                //     uniform control flow, and by this point the loop is
                //     over for every pixel in the quad. Across the shadow
                //     edge a neighbour may be dead and its outD arbitrary,
                //     which pushes this term up for one pixel. That is the
                //     right sign — the edge is exactly where a wider
                //     footprint helps.
                // Normalise first, then differentiate: the length of a
                // difference between unit vectors is the angle between
                // them, in radians, to first order. Differentiating outD
                // itself would fold in the variation of |p|, which is
                // large and has nothing to do with solid angle.
                vec3  nOut   = normalize(outD + 1e-9);
                float solid  = max(length(dFdx(nOut)), length(dFdy(nOut)));
                float dirLod = uFootprint
                             * clamp(log2(max(solid * uSkySize / (2.0 * PI), 1e-6)),
                                     0.0, 5.0);

                // uPrefilter scales the two inferred terms and not the
                // measured one. dirLod is an observation about this pixel;
                // there is nothing in it to tune.
                float lod      = min(dirLod + (band.lod + orderLod) * uPrefilter,
                                     log2(uSkySize));

                vec3 bg = vec3(0.0);
                bool sawSky = false;
                if (escaped) {
                    bg = skyColor(outD, lod);
                    sawSky = true;
                } else if (!dead) {
                    // A ray that merely ran out of budget only counts as sky if
                    // it is far out AND heading outwards. Sampling its
                    // instantaneous direction wherever it happened to stop gave
                    // neighbouring pixels nearly the same direction, i.e. a
                    // hugely magnified smeared Milky Way with a vertical step
                    // edge exactly where the budget expired.
                    vec3 dOut = dxdl(x, p, pt);
                    if (ksR(x, a) > uRs * 4.0 && dot(dOut, x) > 0.0) {
                        bg = skyColor(dOut, lod);
                        sawSky = true;
                    }
                }

                // ── Spectrum, not a tint ────────────────────────────────
                // Bolometrically the exponent is g⁴, since specific intensity is
                // invariant and the bandwidth stretches with it. 2.0 keeps the
                // cascade readable, and the *order* in which parts of the sky
                // burn out is unchanged because that is set by g, not by the
                // exponent.
                //
                // The divisor is the part that broke the first version. Written
                // as pow(gEff, 2.0) alone, gEff contains boost, and boost reaches
                // 321 — so 10⁵ applied to every pixel at once. A sky texel of
                // 0.03 landed between 300 and 30,000, the tonemapper saturates at
                // 1.85, and the whole window went pure white in a single frame.
                // The error was conceptual: boost's job is to carry the spectrum
                // forward, not to set brightness. A factor uniform across the
                // image cannot by definition carry information about the image.
                //
                // So it is divided back out, but not entirely, so the ending
                // still brightens. With boost = 10^(3.5·uBlue) the surviving
                // factor is exactly
                //
                //     gShift² · 10^(3.5·(2 − e)·uBlue)
                //
                // for divisor exponent e, which makes e a direct choice of how
                // much the finale gains. It was 1.6, and that turned out to be
                // far too much division. Traced through the tonemapper with a
                // fully prefiltered sky (uSkyFlat, luminance 0.053) and the
                // median in-window gShift of 0.614:
                //
                //     e      L_in     L_out     result
                //     1.60   0.49     0.672     dim
                //     1.45   1.63     1.215     bright
                //     1.25   8.15     1.675     white
                //     1.10  27.30     1.794     white, with headroom wasted
                //
                // At 1.6 the cascade's own terminus was a dim amber, and the
                // white ending was coming from the uWhite wash after all — the
                // asserted ending this whole rewrite exists to remove, still
                // there, just better disguised. 1.25 is the smallest value that
                // saturates on its own, so the wash goes back to being what it
                // is supposed to be: unused.
                //
                // Contrast *within* the frame is untouched either way — that
                // comes from gShift, which varies genuinely across the screen.
                // The rim, at gShift 7.64, reaches L_out = 1.83 well before the
                // bulk does, so the burn-out still spreads outward from where
                // the geometry says it should.
                bg *= pow(gEff, 2.0) / pow(boost, 1.25);
                bg *= band.tint;

                // Cone rim, antialiased. coneS passes smoothly through zero
                // exactly at the rim — we had the number all along and were not
                // using it. Without this the transition is a jump from a
                // saturated value to exactly zero, which at one ray per pixel is
                // a jagged diagonal. ±0.03 is under a degree: an antialiasing
                // width, not an effect.
                bg *= smoothstep(0.03, -0.03, coneS);

                vec3 col = emission + trans * bg;

                // Everything not raytraced, one call, last.
                col = annotate(uCamPos, dirLocal, col);

                // ── Debug view ──────────────────────────────────────────
                // Non-sky pixels are dark and cold, sky pixels are light. The
                // point is that it must be readable from a screenshot without a
                // colour picker — an earlier version used order/3 in the red
                // channel for sky, and with a median order of ~0.4 down here that
                // is red ≈ 0.13 against 0.16 for "no source". Two shades of dark
                // red side by side, indistinguishable, showing sky and cone in
                // the same colour.
                //
                // Sky channels, once past the 0.30 floor that guarantees every
                // sky pixel outranks every non-sky one:
                //   red   — image order, saturating at 1.5 turns
                //   green — spectral band, log10(g) over 0..3.3. Rising green
                //           means the cascade is running. Inside, g ≈ 1, so green
                //           should be near zero there.
                //   blue  — total prefiltering, in mip levels over 0..6
                if (uDebug > 0.5) {
                    if (!sawSky) {
                        vec3 d = vec3(0.11, 0.015, 0.015);                        // cone
                        if (why > 1.5 && why < 2.5) d = vec3(0.015, 0.02, 0.13);  // shadow
                        if (why > 2.5 && why < 3.5) d = vec3(0.015, 0.11, 0.03);  // uRayStop
                        if (why > 3.5)              d = vec3(0.55, 0.42, 0.0);    // out of steps
                        fragColor = vec4(d, 1.0);
                        return;
                    }
                    float ordC = clamp(order / 1.5, 0.0, 1.0);
                    float spec = clamp(log2(max(gEff, 1e-3)) * 0.30103 / 3.3, 0.0, 1.0);
                    float pf   = clamp(lod / 6.0, 0.0, 1.0);
                    fragColor = vec4(0.30 + 0.70 * vec3(ordC, spec, pf), 1.0);
                    return;
                }

                // ── Hue-preserving tonemap ──────────────────────────────
                // Per-channel Reinhard compresses the brightest channel hardest,
                // so everything bright slides towards white. That is exactly where
                // colour carries meaning here: the magnified core IS dark red —
                // the solid angle behind us is blown up 12.5× by aberration and
                // the same Doppler factor 0.283 is the redshift, so more
                // magnification means redder. Per-channel washed that relationship
                // out and left a white disk.
                //
                // So: compress luminance, scale colour by the same factor. Hue
                // survives. Only if a single channel still overflows do we let go
                // and let it head for white, which beats clipping to a wrong hue.
                float Lin = dot(col, vec3(0.2126, 0.7152, 0.0722));
                float Lot = Lin / (Lin + 0.85) * 1.85;
                vec3  cc  = col * (Lot / max(Lin, 1e-5));
                float ov  = max(cc.r, max(cc.g, cc.b));
                col = mix(cc, vec3(Lot), smoothstep(1.0, 1.6, ov));

                // ── The ending, derived rather than asserted ────────────
                // uWhite used to be the whole ending: a white sheet pulled across
                // the frame with a hint of blue so it read as blueshift. That was
                // the point where the exhibit stopped being physics.
                //
                // It is not needed now. uBlue multiplies g, g drives the spectral
                // cascade, and the cascade's terminus IS uniform white. The sheet
                // stays only as a safety line, at a quarter of its old weight and
                // at 5180 K instead of blue. If the cascade does its job you
                // cannot see it.
                col = mix(col, vec3(1.00, 0.955, 0.90),
                          0.25 * clamp(uWhite, 0.0, 1.0));

                col *= clamp(uDim, 0.0, 1.0);

                fragColor = vec4(col, 1.0);
            }
        `,
        depthWrite: false,
        depthTest:  false,
    });
}