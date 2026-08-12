// =====================================================================
//  RingShader.js — a room with a naked singularity in it
//
//  Per-pixel raytracer through overextremal Kerr (a > M). For every
//  fragment: build a photon in the static observer's orthonormal
//  tetrad, flip it past-directed, and integrate it backwards until it
//  hits a surface of the room, reaches the ring, or passes through the
//  ring's opening onto the r < 0 sheet and out to the sky texture.
//
//  ── Design rules, inherited from Dive ───────────────────────────────
//  1. Everything visible is derived, not painted. The ring is not drawn.
//     A singularity radiates nothing, so it is rendered as the absence
//     of any ray that reaches it — you see it only by what it does to
//     the room behind it. That is the whole exhibit.
//  2. Approximations are named where they live, not hidden. There are
//     two, both in the lighting: see shadowMarch() and shiftTint().
//  3. Nothing keys off a special radius. There is no horizon to key off.
//
//  ── The one genuinely new mechanism ─────────────────────────────────
//  r is signed. Crossing the disc ρ < a at z = 0 flips the sign, which
//  flips f, which reverses the geometry's pull. That branch is the
//  maximal extension of the Kerr solution, not an effect: the sky seen
//  through the ring is a different sheet of the same spacetime.
//
//  ── Verified before it was written ──────────────────────────────────
//  This file is a transcription of probe/ring_render_probe.js, which
//  renders the same algorithm in Node to a PNG. Two things were found
//  there and fixed there rather than here:
//    • curvature-driven step length tunnels straight through a 0.4 m
//      column — the step is capped by distance to geometry as well
//      (ring_pillar_probe.js: 0.6 cm hit accuracy, 3–4 extra steps)
//    • a distance-threshold surface test loses grazing rays as speckle;
//      sign change across the step plus bisection catches all of them
// =====================================================================

import * as THREE from 'three';

export function createRingMaterial({ sky, resolution, scene, spin, unitM,
                                     maxSteps = 1200 }) {
    return new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,

        // Compile-time loop bound.
        //
        // Was 420, and the debug pass came back magenta (why = 4) in a
        // halo around the ring: not chaotic scattering, just starvation.
        // Measured over a 1100-ray fan aimed at the altar
        // (ring_budget_probe.js):
        //
        //     budget  420 → 74 rays starved, 27 reached the far sheet
        //     budget 1200 → 25 starved,      36 reached it
        //     budget 4000 →  4 starved,      39 reached it
        //
        // Mean cost only goes 117 → 149 steps, because the expense is
        // concentrated in the narrow bundle that threads near the ring;
        // every other pixel finishes long before the ceiling and pays
        // nothing for it.
        //
        // A step rule scaling with distance to the ring locus instead of
        // with r was tried and is worse: it takes coarse steps across
        // the disc, the z-crossing test then places the crossing point
        // badly, and the through-ring view disappears completely
        // (39 → 0 rays reaching the far sheet). The small steps near
        // r = 0 are not waste; they are what resolves the crossing.
        defines: { MAX_STEPS: maxSteps },

        uniforms: {
            uSky:        { value: sky },
            uResolution: { value: new THREE.Vector2(resolution.x, resolution.y) },

            // Static observer's tetrad, in Kerr-Schild coordinates
            // (spin along z). .xyz = space, .w = time.
            uE0: { value: new THREE.Vector4(1, 0, 0, 0) },
            uE1: { value: new THREE.Vector4(1, 0, 0, 0) },
            uE2: { value: new THREE.Vector4(0, 1, 0, 0) },
            uE3: { value: new THREE.Vector4(0, 0, 1, 0) },

            uCamPos: { value: new THREE.Vector3(0, 0, 0) },
            uFov:    { value: 68.0 },

            uSpin: { value: spin },
            uTime: { value: 0.0 },

            // f at the observer. Needed for the gravitational shift, and
            // the shader must not recompute it: main.js already has it
            // from the tetrad it built, and two derivations of one
            // number is how they drift apart.
            uFobs: { value: 0.0 },

            // Room, in geometric units.
            uFloorZ: { value: scene.FLOOR_Z },
            uCeilZ:  { value: scene.CEIL_Z },
            uRoomR:  { value: scene.ROOM_R },
            uColR:   { value: scene.COL_R },
            uColTh:  { value: scene.COL_TH },
            uColN:   { value: scene.COL_N },
            uPedR:   { value: scene.PED_R },
            uPedZ:   { value: scene.PED_Z },

            uUnitM:  { value: unitM },   // metres per unit, for the SDF epsilon

            // Key light. A single direction standing in for the high
            // window; the room has no other source.
            uLightDir: { value: new THREE.Vector3(0.42, 0.66, 0.62).normalize() },

            uMaxSteps: { value: maxSteps },
            uRayStop:  { value: 0.015 },
            uExposure: { value: 1.0 },

            // Blueshift strength. 1.0 is the physical value. Kept as a
            // uniform because it is the first thing to turn down if the
            // ring's surroundings blow out on a bright display, and
            // turning it down is an honest exposure choice rather than a
            // change to the physics.
            uShift: { value: 1.0 },

            // Diagnostic overlay: 0 off, 1 tints pixels by how they
            // terminated. Switched on from the console.
            uDebug: { value: 0.0 },
        },

        vertexShader: /* glsl */`
            out vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = vec4(position.xy, 0.0, 1.0);
            }
        `,

        fragmentShader: /* glsl */`
            // Same reasoning as Dive: D = r⁴ + a²z² and the room runs to
            // hundreds of M, so mediump would produce NaN rather than
            // merely looking worse. main.js verifies the device has highp.
            precision highp float;
            precision highp int;

            out vec4 fragColor;
            in vec2 vUv;

            uniform sampler2D uSky;
            uniform vec2  uResolution;
            uniform vec4  uE0, uE1, uE2, uE3;
            uniform vec3  uCamPos, uLightDir;
            uniform float uFov, uSpin, uTime, uFobs;
            uniform float uFloorZ, uCeilZ, uRoomR, uColR, uColTh, uColN;
            uniform float uPedR, uPedZ, uUnitM;
            uniform float uMaxSteps, uRayStop, uExposure, uShift, uDebug;

            #define PI 3.14159265358979
            #define M_MASS 1.0

            // =========================================================
            //  GEOMETRY OF SPACETIME
            // =========================================================

            struct Metric { float r; float f; vec3 l; float D; float W; };

            /** Kerr-Schild radius, unsigned. Constant-r surfaces are oblate. */
            float ksR(vec3 x, float a) {
                float b  = dot(x, x) - a * a;
                float r2 = 0.5 * (b + sqrt(b * b + 4.0 * a * a * x.z * x.z));
                return sqrt(max(r2, 1e-12));
            }

            /**
             * g = η + f (l ⊗ l), with r carrying a sign.
             *
             * side = +1 is our sheet. side = −1 is the continuation
             * through the ring, where r < 0 makes f < 0 and the geometry
             * repels. Passing the sign in rather than deriving it here is
             * deliberate: the sign is a property of the ray's history,
             * not of the point, and two rays through the same point can
             * be on different sheets.
             */
            Metric metricAt(vec3 x, float side) {
                float a  = uSpin * M_MASS;
                float r  = side * ksR(x, a);
                float r2 = r * r;

                Metric m;
                m.r = r;
                m.D = max(r2 * r2 + a * a * x.z * x.z, 1e-12);
                m.W = r2 + a * a;
                m.f = 2.0 * M_MASS * r2 * r / m.D;
                m.l = vec3((r * x.x + a * x.y) / m.W,
                           (r * x.y - a * x.x) / m.W,
                           x.z / (abs(r) < 1e-9 ? 1e-9 : r));
                return m;
            }

            /** dx/dλ = ∂H/∂p. Trivial — H is quadratic in p. */
            vec3 dxdl(Metric m, vec3 p, float pt) {
                return p - m.f * (dot(m.l, p) - pt) * m.l;
            }

            /**
             * dp/dλ = −∂H/∂x, closed form, ported unchanged from Dive.
             * Valid for negative r as written: nothing in the derivation
             * assumed a sign, only that D > 0.
             */
            vec3 dpdl(vec3 x, Metric m, vec3 p, float pt) {
                float a  = uSpin * M_MASS;
                float r  = m.r, r2 = r * r, r3 = r2 * r;
                float az = a * x.z;
                float iD = 1.0 / m.D;

                vec3 gr = vec3(r3 * x.x, r3 * x.y, r * x.z * m.W) * iD;

                float gf = 2.0 * M_MASS * r2 * (3.0 * az * az - r2 * r2) * iD * iD;
                vec3  gF = gf * gr - vec3(0.0, 0.0,
                           4.0 * M_MASS * a * a * x.z * r3 * iD * iD);

                float Q = p.x * x.x + p.y * x.y;
                float L = p.x * x.y - p.y * x.x;
                float rr = (abs(r) < 1e-9) ? 1e-9 : r;
                float C = Q / m.W - 2.0 * r * (r * Q + a * L) / (m.W * m.W)
                        - p.z * x.z / max(r2, 1e-12);
                vec3  gL = C * gr + vec3((p.x * r - p.y * a) / m.W,
                                         (p.x * a + p.y * r) / m.W,
                                          p.z / rr);

                float S = dot(m.l, p) - pt;
                return 0.5 * S * S * gF + m.f * S * gL;
            }

            struct Deriv { vec3 dx; vec3 dp; };

            Deriv derivAt(vec3 x, Metric m, vec3 p, float pt) {
                Deriv d;
                d.dx = dxdl(m, p, pt);
                d.dp = dpdl(x, m, p, pt);
                return d;
            }
            Deriv deriv(vec3 x, vec3 p, float pt, float side) {
                return derivAt(x, metricAt(x, side), p, pt);
            }

            // =========================================================
            //  GEOMETRY OF THE ROOM
            // =========================================================

            /**
             * Scene SDF. Positive in free air. .x = distance, .y = id:
             * 1 floor, 2 ceiling, 3 wall, 4 column, 5 pedestal.
             *
             * The room is closed, which is what lets the sky texture mean
             * something: the only way a ray reaches it is through the
             * ring.
             */
            vec2 sdfScene(vec3 x) {
                float rho = length(x.xy);

                float d = x.z - uFloorZ; float id = 1.0;
                float dc = uCeilZ - x.z;   if (dc < d) { d = dc; id = 2.0; }
                float dw = uRoomR - rho;   if (dw < d) { d = dw; id = 3.0; }

                // Colonnade by angular folding: one column, repeated.
                float sec = 2.0 * PI / uColN;
                float ang = atan(x.y, x.x);
                float a2  = ang - sec * floor(ang / sec + 0.5);
                vec2  cp  = vec2(rho * cos(a2), rho * sin(a2));
                float dcol = length(cp - vec2(uColR, 0.0)) - uColTh;
                if (dcol < d) { d = dcol; id = 4.0; }

                // Pedestal, a capped cylinder from the floor to PED_Z.
                float pz = 0.5 * (uFloorZ + uPedZ);
                float ph = 0.5 * (uPedZ - uFloorZ);
                vec2  q  = vec2(rho - uPedR, abs(x.z - pz) - ph);
                float dped = min(max(q.x, q.y), 0.0) + length(max(q, 0.0));
                if (dped < d) { d = dped; id = 5.0; }

                return vec2(d, id);
            }

            vec3 sdfNormal(vec3 x) {
                // Epsilon in metres, converted to units, so it does not
                // silently change meaning if the ring size is retuned.
                float e = 0.002 / uUnitM;
                vec2 h = vec2(e, 0.0);
                return normalize(vec3(
                    sdfScene(x + h.xyy).x - sdfScene(x - h.xyy).x,
                    sdfScene(x + h.yxy).x - sdfScene(x - h.yxy).x,
                    sdfScene(x + h.yyx).x - sdfScene(x - h.yyx).x));
            }

            /**
             * Integer-ish hash for material variation. Deliberately not
             * the fract(sin(...)) one: Dive was bitten by that on Apple
             * silicon, where the garbage below sin()'s guaranteed
             * accuracy is correlated between neighbours. This drives
             * plank-to-plank colour, so a correlated hash would show up
             * as visible banding rather than as a subtle failure.
             */
            float hash11(float p) {
                p = fract(p * 0.1031);
                p *= p + 33.33;
                p *= p + p;
                return fract(p);
            }

            vec3 albedoOf(vec3 x, float id) {
                if (id < 1.5) {
                    // Floorboards. Plank width and the grain are authored
                    // surface finish, not derived from anything — the same
                    // status as choosing a colour. Named as such rather
                    // than dressed up: nothing about the physics says how
                    // wide a plank is.
                    float plankW = 0.18 / uUnitM;
                    float band   = floor(x.y / plankW);
                    float shade  = 0.82 + 0.18 * hash11(band * 3.7);
                    float grain  = 0.94 + 0.06 * sin(x.x * (9.0 / uUnitM) + band * 2.3);
                    float seam   = smoothstep(0.0, 0.012 / uUnitM,
                                   abs(fract(x.y / plankW) - 0.5) * plankW);
                    return vec3(0.30, 0.205, 0.125) * shade * grain * (0.55 + 0.45 * seam);
                }
                if (id < 2.5) {
                    // Timber ceiling, boards running radially.
                    float ang = atan(x.y, x.x);
                    float b = floor(ang * 9.0 / PI);
                    return vec3(0.26, 0.20, 0.155) * (0.85 + 0.15 * hash11(b * 5.1));
                }
                if (id < 3.5) {
                    // Whitewashed block wall. Faint horizontal courses so
                    // the eye has something to measure the lensing against.
                    float course = floor((x.z - uFloorZ) / (0.42 / uUnitM));
                    float mott = 0.96 + 0.04 * hash11(course * 2.1 + floor(atan(x.y, x.x) * 6.0));
                    float line = smoothstep(0.0, 0.02 / uUnitM,
                                 abs(fract((x.z - uFloorZ) / (0.42 / uUnitM)) - 0.5) * (0.42 / uUnitM));
                    return vec3(0.76, 0.745, 0.71) * mott * (0.88 + 0.12 * line);
                }
                if (id < 4.5) {
                    // Column: subtle vertical fluting.
                    float ang = atan(x.y, x.x) * 40.0;
                    float flute = 0.93 + 0.07 * cos(ang);
                    return vec3(0.80, 0.785, 0.75) * flute;
                }
                return vec3(0.20, 0.195, 0.19);   // dark pedestal stone
            }

            /**
             * Ambient occlusion from the SDF. Five taps along the normal:
             * where the field falls short of the distance stepped, there
             * is geometry nearby stealing sky.
             *
             * This is what was missing before. The old shading had a flat
             * 0.22 ambient everywhere, which is why floor, wall, column
             * and ceiling all landed on the same grey and the room read
             * as unpainted clay: no corner was darker than any face.
             */
            float ambientOcclusion(vec3 x, vec3 n) {
                float occ = 0.0, sca = 1.0;
                for (int i = 1; i <= 5; i++) {
                    float h = 0.02 * float(i) * float(i) / uUnitM;
                    float d = sdfScene(x + n * h).x;
                    occ += (h - d) * sca;
                    sca *= 0.72;
                }
                return clamp(1.0 - 1.4 * occ, 0.0, 1.0);
            }

            /**
             * APPROXIMATION, NAMED: shadow rays travel in straight lines.
             *
             * They should follow geodesics like everything else. They do
             * not, because a second full integration per pixel roughly
             * doubles the frame cost to move a shadow edge by less than a
             * pixel: every surface in this room sits at f < 0.02, where
             * the deflection over a 10 m path is far below the width of
             * the penumbra. The one place it would show is a shadow cast
             * across the altar from within a few cm of the ring, and
             * nothing in the room is that close.
             *
             * The penumbra itself is the standard distance-field trick:
             * how near the ray passed to an occluder stands in for the
             * light's angular size. Also an approximation, and also not
             * physics — but it is the difference between a room and a
             * diagram.
             */
            float shadowMarch(vec3 x, vec3 n) {
                float t = 0.03 / uUnitM;
                float tMax = 18.0 / uUnitM;
                float res = 1.0;
                for (int i = 0; i < 40; i++) {
                    float d = sdfScene(x + n * 0.001 / uUnitM + uLightDir * t).x;
                    if (d < 0.0002 / uUnitM) return 0.0;
                    res = min(res, 9.0 * d / t);
                    t += clamp(d, 0.01 / uUnitM, 0.6 / uUnitM);
                    if (t > tMax) break;
                }
                return clamp(res, 0.0, 1.0);
            }

            /**
             * Hemisphere ambient: light from the ceiling half is warmer
             * and dimmer than from the floor half, because in this room
             * the bright thing is a high window and the floor is dark
             * wood. Cheap, and it separates surfaces by orientation,
             * which a constant cannot do.
             */
            vec3 ambientLight(vec3 n) {
                vec3 up   = vec3(0.30, 0.32, 0.38);   // cool, from the window wall
                vec3 down = vec3(0.11, 0.09, 0.07);   // warm bounce off the boards
                return mix(down, up, n.z * 0.5 + 0.5);
            }

            vec3 shadeSurface(vec3 x, float id) {
                vec3 n = sdfNormal(x);
                vec3 alb = albedoOf(x, id);

                float occ = ambientOcclusion(x, n);
                float ndl = max(dot(n, uLightDir), 0.0);
                float sh  = ndl > 0.0 ? shadowMarch(x, n) : 0.0;

                // Key light. One direction, standing in for the high
                // window; the room has no other source.
                vec3 direct = vec3(1.06, 1.00, 0.92) * ndl * sh * 1.35;

                // Specular, Blinn-Phong rather than a full GGX: the
                // floor is the only surface polished enough to matter and
                // it is seen at grazing angles, where the two agree.
                vec3 viewDir = normalize(uCamPos - x);
                vec3 h = normalize(uLightDir + viewDir);
                float gloss = (id < 1.5) ? 48.0 : (id < 3.5 ? 12.0 : 20.0);
                float kspec = (id < 1.5) ? 0.16 : 0.04;
                float spec = pow(max(dot(n, h), 0.0), gloss) * kspec * sh;

                return alb * (direct + ambientLight(n) * occ) + vec3(spec);
            }

            // =========================================================
            //  SKY (the r < 0 sheet, seen through the ring)
            // =========================================================

            vec2 dirToEquirect(vec3 dir) {
                dir = normalize(dir);
                // Spin is along z here, so z is the pole — not y as in Dive.
                float u = 0.5 + atan(dir.y, dir.x) / (2.0 * PI);
                float v = 0.5 - asin(clamp(dir.z, -1.0, 1.0)) / PI;
                return vec2(u, v);
            }

            // =========================================================
            //  GRAVITATIONAL SHIFT
            // =========================================================

            /**
             * Static-to-static shift. Both ends of the light path are at
             * rest, so the ratio is exact and cheap:
             *
             *     E_obs / E_emit = √(1 − f_emit) / √(1 − f_obs)
             *
             * The observer stands deeper in the well than the walls do,
             * so light falling inwards to the eye arrives BLUER — the
             * opposite sign to the intuition built by Dive, where the
             * camera was the thing falling.
             */
            float shiftFactor(float fEmit) {
                return sqrt(max(1.0 - fEmit, 1e-6)) / sqrt(max(1.0 - uFobs, 1e-6));
            }

            /**
             * APPROXIMATION, NAMED: the tint is a two-point interpolation,
             * not a spectrum.
             *
             * Doing this properly means integrating a blackbody against
             * colour matching functions, which is what Dive's spectral
             * cascade does — justified there because the cascade WAS the
             * ending. Here the shift stays within a factor of ~3 across
             * the whole room, so the honest content is "bluer and
             * brighter towards the ring", and this delivers exactly that
             * without claiming a spectrum it did not compute.
             */
            vec3 shiftTint(vec3 col, float g) {
                float gg = mix(1.0, g, uShift);
                vec3  warm = vec3(1.06, 0.99, 0.92);
                vec3  cool = vec3(0.88, 0.96, 1.12);
                vec3  hue  = mix(warm, cool, clamp(log2(gg) * 0.5 + 0.5, 0.0, 1.0));
                // Specific intensity goes as g⁴; clamped, because the
                // point is the trend, not a bloom-out at the altar.
                return col * hue * clamp(pow(gg, 4.0), 0.25, 6.0);
            }

            // =========================================================
            //  MAIN
            // =========================================================

            void main() {
                vec2 ndc = vUv * 2.0 - 1.0;
                float aspect = uResolution.x / uResolution.y;
                float halfTan = tan(radians(uFov) * 0.5);

                vec3 nl = normalize(vec3(ndc.x * halfTan * aspect,
                                         ndc.y * halfTan, 1.0));

                float a = uSpin * M_MASS;

                // Past-directed photon in the observer's frame:
                // k = −e0 + n·(e1,e2,e3). The minus on e0 is what makes
                // it past-directed. Nothing here is guessed.
                vec4 k = -uE0 + nl.x * uE1 + nl.y * uE2 + nl.z * uE3;

                vec3  x    = uCamPos;
                float side = 1.0;

                // Lower the index: the integrator works with p_μ.
                Metric m0 = metricAt(x, side);
                float  Lk = k.w + dot(m0.l, k.xyz);
                float  pt = -k.w + m0.f * Lk;
                vec3   p  = k.xyz + m0.f * Lk * m0.l;

                // Affine normalisation. Same reason as Dive: without it
                // the divergence limit fires at different geometric
                // places for different pixels.
                float sc = 1.0 / max(length(p), 1e-9);
                p *= sc; pt *= sc;

                vec3  col   = vec3(0.0);
                float why   = 4.0;          // 0 hit, 1 ring, 2 sky, 3 diverge, 4 budget
                float prevZ = x.z;
                float escapeR = uRoomR * 6.0;

                for (int i = 0; i < MAX_STEPS; i++) {
                    if (float(i) >= uMaxSteps) break;

                    float rAbs = ksR(x, a);

                    // The ring itself. A singularity emits nothing, so
                    // this is black — and it is the only black in the
                    // room that means something.
                    if (rAbs < uRayStop) { col = vec3(0.0); why = 1.0; break; }

                    vec2 g0 = sdfScene(x);

                    // Already inside a surface (can happen on the first
                    // step if the camera grazes one).
                    if (side > 0.0 && g0.x <= 0.0) {
                        col = shadeSurface(x, g0.y); why = 0.0; break;
                    }

                    // Off the r<0 sheet there is no room, only sky.
                    if (side < 0.0 && rAbs > escapeR) {
                        Metric me = metricAt(x, side);
                        vec3 d = dxdl(me, p, pt);
                        col = texture(uSky, dirToEquirect(d)).rgb;
                        why = 2.0; break;
                    }

                    Metric m = metricAt(x, side);
                    Deriv  k1 = derivAt(x, m, p, pt);
                    float  sp = max(length(k1.dx), 1e-8);

                    // ── Step length ─────────────────────────────────
                    // Two independent caps. The first is curvature: the
                    // geometry varies on the scale of r. The second is
                    // the sphere-trace coupling — without it a single
                    // step jumps clean over a 0.4 m column out where the
                    // curvature cap has grown to several units, and the
                    // column simply is not drawn. Measured in
                    // ring_pillar_probe.js: 0.6 cm hit accuracy at a
                    // cost of 3–4 extra steps, and those steps are only
                    // spent by rays that are actually near something.
                    float want = min(0.25 * max(rAbs, 0.02), uRoomR * 0.12);
                    if (side > 0.0) want = min(want, max(0.9 * g0.x, 0.004));
                    float dl = want / sp;

                    Deriv k2 = deriv(x + 0.5*dl*k1.dx, p + 0.5*dl*k1.dp, pt, side);
                    Deriv k3 = deriv(x + 0.5*dl*k2.dx, p + 0.5*dl*k2.dp, pt, side);
                    Deriv k4 = deriv(x + dl*k3.dx,     p + dl*k3.dp,     pt, side);

                    vec3 x0 = x;
                    x += dl/6.0 * (k1.dx + 2.0*k2.dx + 2.0*k3.dx + k4.dx);
                    p += dl/6.0 * (k1.dp + 2.0*k2.dp + 2.0*k3.dp + k4.dp);

                    // ── Surface crossing ────────────────────────────
                    // Sign change across the step, then bisection. A
                    // distance-threshold test instead of this loses every
                    // ray that steps over a surface and lands beyond it,
                    // which at grazing incidence is most of them — and it
                    // reads as speckle rather than as a missing wall,
                    // which is why it looks like noise and not like a bug.
                    vec2 g1 = sdfScene(x);
                    if (side > 0.0 && g0.x > 0.0 && g1.x <= 0.0) {
                        float lo = 0.0, hi = 1.0;
                        for (int b = 0; b < 12; b++) {
                            float mid = 0.5 * (lo + hi);
                            if (sdfScene(mix(x0, x, mid)).x > 0.0) lo = mid; else hi = mid;
                        }
                        vec3 hp = mix(x0, x, hi);
                        col = shadeSurface(hp, sdfScene(hp).y);
                        why = 0.0; break;
                    }

                    // ── The disc, and the other sheet ───────────────
                    // Crossing z = 0 inside ρ < a passes THROUGH the
                    // ring's opening and onto the r < 0 sheet. Outside
                    // ρ = a the same plane is ordinary empty space and
                    // nothing happens. This is the maximal extension of
                    // the Kerr solution, not an effect: the view through
                    // the ring is a different sheet of this spacetime.
                    if ((prevZ > 0.0) != (x.z > 0.0)) {
                        float t = prevZ / (prevZ - x.z);
                        vec2  c = mix(x0.xy, x.xy, t);
                        if (dot(c, c) < a * a) side = -side;
                    }
                    prevZ = x.z;

                    if (dot(p, p) > 1.0e8) { col = vec3(0.0); why = 3.0; break; }
                }

                // Gravitational shift, applied to whatever was found.
                // Surfaces carry their own f; the sky is on the other
                // sheet and is left alone rather than given an invented
                // one.
                if (why == 0.0) {
                    Metric mh = metricAt(x, 1.0);
                    col = shiftTint(col, shiftFactor(mh.f));
                }

                // Rays that ran out of budget are black, not grey.
                //
                // At the raised ceiling the survivors are overwhelmingly
                // rays spiralling in towards the ring, which reach it and
                // are therefore black anyway; painting them any other
                // colour would be inventing a source. If this ever
                // becomes a visible halo again, that is the signal the
                // budget is too low, not that the colour is wrong.
                if (why == 4.0) col = vec3(0.0);

                if (uDebug > 0.5) {
                    if (why == 0.0) col = vec3(0.2, 0.6, 0.2);
                    else if (why == 1.0) col = vec3(0.9, 0.2, 0.2);
                    else if (why == 2.0) col = vec3(0.2, 0.4, 0.9);
                    else if (why == 3.0) col = vec3(0.9, 0.9, 0.2);
                    else col = vec3(1.0, 0.0, 1.0);
                }

                // Reinhard + gamma. Deliberately the same tonemap the
                // reference renderer used, so the Node PNGs and the
                // shader can be compared pixel for pixel.
                vec3 c = max(col * uExposure, 0.0);
                fragColor = vec4(pow(c / (1.0 + c), vec3(1.0 / 2.2)), 1.0);
            }
        `,
    });
}