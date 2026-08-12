// =====================================================================
// exhibits/ring/RingGeodesic.js
//
// Overextremal Kerr: a > M. Same Kerr-Schild machinery as Dive, one
// number different, and that number removes both horizons:
//
//     r± = M ± √(M² − a²)
//
// With a > M the discriminant is negative and there is no real root.
// Nothing is hidden. The ring singularity at r = 0, ρ = a is naked.
//
// ── What carries over from Dive ─────────────────────────────────────
//   • Kerr-Schild coordinates, g = η + f (l ⊗ l)
//   • the closed-form gradient −∂H/∂x
//   • orthonormal tetrad construction, Gram-Schmidt against g
//
// ── What is different ───────────────────────────────────────────────
//   • The observer is STATIC, not falling. u = (u^t,0,0,0) exists only
//     where f < 1. That inequality is the ergosphere, and it is the only
//     boundary in this room — there is no horizon to hide behind.
//   • r is SIGNED. A ray crossing the disc ρ < a at z = 0 passes through
//     the ring's opening onto the r < 0 sheet of the maximal extension,
//     where f flips sign and gravity repels. That sheet is what you see
//     through the ring, and it is where the sky texture lives.
//
// ── Scale, and why it is not a free parameter ───────────────────────
// The ring's coordinate radius IS a, and a = SPIN·M with SPIN just over
// 1. So the ring's physical radius pins M to within a factor of two,
// and M is the length over which spacetime is strongly curved.
//
// Measured (probe/ring_scale_probe.js), same room in metres both times:
//
//     ring 2 m   → M = 1.333 m → room is   8 M across → unrecognisable
//     ring 6 cm  → M = 0.040 m → room is 267 M across → reads as a room
//
// A 2 m naked ring and an undistorted room are mutually exclusive. This
// exhibit takes the second: a relic on an altar, with the distortion
// confined to arm's length around it, because the stated goal is what
// an eye would actually see.
// =====================================================================

/** Ring radius in metres. THE anchor — everything else follows from it. */
export const RING_R_METRES = 0.06;

/** a/M. Must exceed 1 or a horizon returns and the ring is hidden. */
export const SPIN = 1.5;

export const M = 1.0;             // geometric units, M := 1
export const A = SPIN * M;        // ring coordinate radius

/** Metres per geometric unit. With M := 1 this is M's length in metres. */
export const UNIT_M = RING_R_METRES / SPIN;

/** Physical mass, for the UI. GM/c² = 1476.6 m for the Sun. */
export const MASS_SUN = UNIT_M / 1476.6;
export const MASS_JUPITER = MASS_SUN * 1047.0;

const m2u = metres => metres / UNIT_M;

// ── The room, authored in metres, stored in geometric units ─────────
export const SCENE = {
    FLOOR_Z: m2u(-1.60),   // the ring plane is z = 0
    CEIL_Z:  m2u(5.33),
    ROOM_R:  m2u(10.67),
    COL_R:   m2u(8.00),
    COL_TH:  m2u(0.20),
    COL_N:   12,
    PED_R:   m2u(0.67),
    PED_Z:   m2u(-0.73),   // pedestal top
    EYE:     m2u(1.70),
    WALK_MAX: m2u(9.8),    // keeps the camera off the wall
};

/** Kerr-Schild radius (unsigned). Constant-r surfaces are oblate. */
export function ksR(x, y, z, a = A) {
    const rho2 = x * x + y * y + z * z;
    const b = rho2 - a * a;
    const r2 = 0.5 * (b + Math.sqrt(b * b + 4 * a * a * z * z));
    return Math.sqrt(Math.max(r2, 1e-12));
}

/**
 * The metric in four lines, with r allowed to be negative.
 *
 * On the r < 0 sheet f < 0: the mass term reverses and the geometry
 * pushes rather than pulls. Not an effect added for the exhibit — it is
 * what the Kerr solution does once the disc has been crossed.
 */
export function metricAt(x, y, z, rSigned, a = A, mass = M) {
    const r = rSigned, r2 = r * r;
    const D = r2 * r2 + a * a * z * z;
    const W = r2 + a * a;
    return {
        r, D, W,
        f:  (2 * mass * r2 * r) / Math.max(D, 1e-12),
        lx: (r * x + a * y) / W,
        ly: (r * y - a * x) / W,
        lz: z / (Math.abs(r) < 1e-9 ? 1e-9 : r),
    };
}

/** f on the r > 0 sheet. f ≥ 1 is the ergoregion. Shown live in the UI. */
export function frameDrag(x, y, z, a = A, mass = M) {
    const r = ksR(x, y, z, a), r2 = r * r;
    return (2 * mass * r2 * r) / (r2 * r2 + a * a * z * z);
}

/**
 * Outer edge of the ergoregion at height z: the largest ρ with f > fMax.
 * Returns 0 when no such ρ exists — i.e. the ergoregion does not reach
 * this height at all.
 *
 * That zero is a real answer and the caller must handle it. f is NOT
 * monotonic in ρ: it rises from the axis, peaks near ρ ≈ a, and falls
 * off outside, so a plain bisection assuming "f decreases with ρ" walks
 * itself down to the axis and reports a limit of zero whenever the
 * region is absent. Scan for the peak first, then bisect on the outer
 * flank only.
 *
 * At the exhibit's scale this matters: with a 6 cm ring the ergoregion
 * is a bubble roughly 5 cm across, hugging the ring plane and nowhere
 * near a standing visitor's eye. The boundary that actually stops a
 * visitor is the pedestal — ordinary furniture. At a 2 m ring it would
 * have been the ergosphere itself.
 */
export function ergoRadius(z, fMax = 0.92, a = A, mass = M) {
    const RMAX = 40 * a;
    const N = 2048;

    let peakRho = 0, peakF = -1;
    for (let i = 1; i <= N; i++) {
        const rho = (i / N) * RMAX;
        const f = frameDrag(rho, 0, z, a, mass);
        if (f > peakF) { peakF = f; peakRho = rho; }
    }
    if (peakF <= fMax) return 0;          // no ergoregion at this height

    let lo = peakRho, hi = RMAX;
    for (let i = 0; i < 60; i++) {
        const mid = 0.5 * (lo + hi);
        if (frameDrag(mid, 0, z, a, mass) > fMax) lo = mid; else hi = mid;
    }
    return hi;
}

/**
 * The right-hand direction for a given look direction: fwd × up.
 *
 * Exported because it needs to be defined exactly once. It was defined
 * twice — here for the tetrad, and again inside main.js's movement code
 * with the sign flipped — and the result was that the image was correct
 * while walking sideways went the wrong way. Nothing in either file was
 * obviously wrong on its own, which is what made it a nuisance to spot:
 * you have to compare the two to see it.
 *
 * Note this is the coordinate-space right. The tetrad's e1 is this
 * vector after Gram-Schmidt against g, which tilts it slightly — by
 * about 0.8% at the exhibit's walking radius, from frame dragging. For
 * choosing which way a footstep goes that difference is irrelevant; for
 * building the camera basis it is not, which is why the tetrad
 * orthonormalises and the movement code does not.
 */
export function rightVector(fwd, up) {
    return [
        fwd[1] * up[2] - fwd[2] * up[1],
        fwd[2] * up[0] - fwd[0] * up[2],
        fwd[0] * up[1] - fwd[1] * up[0],
    ];
}

/** g(P,Q) for contravariant 4-vectors [t,x,y,z]. l_t = 1 by construction. */
export function dotG(met, P, Q) {
    const lP = P[0] + met.lx * P[1] + met.ly * P[2] + met.lz * P[3];
    const lQ = Q[0] + met.lx * Q[1] + met.ly * Q[2] + met.lz * Q[3];
    return -P[0] * Q[0] + P[1] * Q[1] + P[2] * Q[2] + P[3] * Q[3] + met.f * lP * lQ;
}

/**
 * Orthonormal tetrad for a STATIC observer, oriented by the look
 * direction.
 *
 * e0 is the four-velocity of someone standing still in these
 * coordinates: g_tt (u^t)² = −1 with g_tt = −1 + f, so
 *
 *     u^t = 1 / √(1 − f)
 *
 * which exists only for f < 1. Inside the ergosphere the root is
 * imaginary — frame dragging is strong enough that no timelike vector
 * points purely along t. main.js keeps the camera out of that region
 * rather than clamping the maths and pretending otherwise.
 *
 * e1/e2/e3 are right/up/forward, Gram-Schmidted in that order so that
 * forward survives intact and up absorbs the correction.
 *
 * @returns null if the point is inside the ergoregion.
 */
export function buildStaticTetrad(pos, fwd, up, a = A, mass = M) {
    const [x, y, z] = pos;
    const met = metricAt(x, y, z, ksR(x, y, z, a), a, mass);
    if (met.f >= 0.999) return null;

    const ut = 1 / Math.sqrt(1 - met.f);
    const e0 = [ut, 0, 0, 0];

    const sub = (P, Q, s) => [P[0] - s * Q[0], P[1] - s * Q[1], P[2] - s * Q[2], P[3] - s * Q[3]];
    const norm = P => {
        const n = Math.sqrt(Math.max(dotG(met, P, P), 1e-12));
        return [P[0] / n, P[1] / n, P[2] / n, P[3] / n];
    };
    const orthT = P => sub(P, e0, -dotG(met, P, e0));   // e0·e0 = −1, hence the flip
    const orthS = (P, Q) => sub(P, Q, dotG(met, P, Q));

    const e3 = norm(orthT([0, fwd[0], fwd[1], fwd[2]]));
    const right = rightVector(fwd, up);
    const e1 = norm(orthS(orthT([0, right[0], right[1], right[2]]), e3));
    const e2 = norm(orthS(orthS(orthT([0, up[0], up[1], up[2]]), e3), e1));

    return { e0, e1, e2, e3, ut, f: met.f };
}

/**
 * Residuals of the tetrad's defining relations. Run once at startup and
 * after any change to the construction — a merely nearly-orthonormal
 * tetrad produces a merely nearly-right image, and that is the kind of
 * error that hides for weeks.
 */
export function checkTetrad(pos, tet, a = A, mass = M) {
    const met = metricAt(pos[0], pos[1], pos[2], ksR(pos[0], pos[1], pos[2], a), a, mass);
    const { e0, e1, e2, e3 } = tet;
    return {
        e0e0: dotG(met, e0, e0) + 1,
        e1e1: dotG(met, e1, e1) - 1,
        e2e2: dotG(met, e2, e2) - 1,
        e3e3: dotG(met, e3, e3) - 1,
        e0e3: dotG(met, e0, e3),
        e1e2: dotG(met, e1, e2),
        e1e3: dotG(met, e1, e3),
        e2e3: dotG(met, e2, e3),
    };
}