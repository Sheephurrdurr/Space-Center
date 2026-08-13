// =====================================================================
//  exhibits/merger_lens/OrbitalPhysics.js
//
//  Geometric units throughout: G = c = 1. Masses and separations are
//  artistic toy-units, not kg and metres, but every relation below is a
//  real one. Where a number is a fit rather than a derivation it is
//  labelled as such, with the source.
//
//  What is exact here:
//    - Peters (1964) quadrupole orbital decay, da/dt and the closed form
//    - Kepler's third law for the orbital frequency
//    - the quadrupole strain amplitude
//    - the equilibrium tidal ellipticity of the companion
//
//  What is a fit to numerical relativity (disclosed at each call site):
//    - remnant mass and spin
//    - the l = m = 2, n = 0 quasi-normal ringdown mode
//
//  What is artistic:
//    - the mapping from physical time to wall-clock time (see pacing)
//    - the toy-unit values of the masses and the initial separation
//
//  This file is shared verbatim with exhibits/merger_gw. Same binary, same
//  equations, two different renderers — that is the whole point of having
//  both exhibits, so the physics must not drift between them. If you change
//  something here, change it there.
// =====================================================================

/**
 * A circularised compact binary decaying by gravitational wave emission.
 *
 * The orbit is integrated in physical (geometric) time. Wall-clock time is
 * mapped onto physical time by {@link BinaryOrbit#effectiveTimeScale}, which
 * is the only place artistic pacing enters. Every quantity reported by this
 * class is a physical quantity computed from the physical state, so the
 * readouts stay honest no matter how the pacing is tuned.
 */
export class BinaryOrbit {
    /**
     * @param {object}  opts
     * @param {number}  opts.massStar         Companion mass (the neutron star).
     * @param {number}  opts.massBH           Black hole mass.
     * @param {number}  opts.separation       Initial orbital separation.
     * @param {number} [opts.timeScale=1]     Physical seconds per wall second at
     *                                        the initial separation. Use
     *                                        {@link timeScaleForInitialRate} or
     *                                        {@link timeScaleForDuration}.
     * @param {number} [opts.pacingExponent]  Exponent p in the time warp
     *                                        timeScale ∝ (a/a₀)^p. See below.
     * @param {number} [opts.tidalLoveNumber] Dimensionless h₂, O(1) for a stiff
     *                                        neutron star equation of state.
     * @param {number} [opts.ringdownPacing=1] Extra slow-motion factor applied
     *                                        after merger only. Purely artistic;
     *                                        see {@link BinaryOrbit#effectiveTimeScale}.
     * @param {number} [opts.plungePacing=1]  Extra slow-motion factor applied
     *                                        during the plunge only.
     * @param {number} [opts.contactRadius]   Separation at which the companion's
     *                                        surface reaches the horizon. Below
     *                                        this the merger is complete.
     *                                        Defaults to 2·m₂ (the horizon itself).
     */
    constructor({
        massStar,
        massBH,
        separation,
        timeScale = 1,
        pacingExponent = 0.75,
        tidalLoveNumber = 1.0,
        ringdownPacing = 1.0,
        plungePacing = 1.0,
        contactRadius = null,
    }) {
        this.m1 = massStar;
        this.m2 = massBH;
        this.a = separation;

        /** Initial separation, frozen — the time warp is measured against it. */
        this.a0 = separation;

        this.timeScale = timeScale;
        this.pacingExponent = pacingExponent;
        this.tidalLoveNumber = tidalLoveNumber;
        this.ringdownPacing = ringdownPacing;
        this.plungePacing = plungePacing;

        this.phase = 0;
        this.merged = false;
        this.plunging = false;
        this.ringdownTime = 0;
        this.ringdownPhase = 0;

        /** Conserved specific energy of the plunge geodesic. Set at ISCO crossing. */
        this.plungeEnergy = 0;
        /** Conserved specific angular momentum of the plunge geodesic, √12·M. */
        this.plungeL = Math.sqrt(12) * (massStar + massBH);

        this.contactRadius = contactRadius ?? 2 * massBH;

        /**
         * Plunge radius: the innermost stable circular orbit, 6M.
         *
         * M here is the TOTAL mass, not the black hole's. That is the
         * effective-one-body idea in its simplest form — the relative motion of
         * a two-body system is treated as one test particle moving in the field
         * of the total mass. It matters for more than accuracy: a test particle
         * in a field of mass M has dφ/dt = √(M/r³) on a circular orbit, which
         * is exactly two-body Kepler. Use m₂ instead and the orbital frequency
         * drops 12% the instant the plunge takes over — a visible stutter at
         * the most important moment in the run. Using the total mass makes the
         * two descriptions agree identically at every radius.
         */
        this.mergerRadius = 6 * (massStar + massBH);

        /** Strain amplitude captured at the moment of merger, for the burst. */
        this.peakStrain = 0;
    }

    // ── Basic mass combinations ──────────────────────────────────────────

    get totalMass() { return this.m1 + this.m2; }

    get reducedMass() { return (this.m1 * this.m2) / this.totalMass; }

    /** Symmetric mass ratio η = μ/M. Equals 1/4 for equal masses. */
    get symmetricMassRatio() { return this.reducedMass / this.totalMass; }

    // ── Orbital kinematics ───────────────────────────────────────────────

    /** Kepler: ω = √(M/a³). Exact in geometric units. */
    orbitalAngularVelocity() {
        return Math.sqrt(this.totalMass / this.a ** 3);
    }

    /**
     * The dominant gravitational wave mode is the quadrupole, which radiates
     * at twice the orbital frequency. This is why LIGO's chirp is at 2f_orb.
     */
    gwAngularFrequency() {
        return 2 * this.currentAngularVelocity();
    }

    /** Peters (1964), circular orbit: da/dt = −(64/5)·m₁m₂M/a³. */
    orbitalDecayRate() {
        return -(64 / 5) * this.m1 * this.m2 * this.totalMass / (this.a ** 3);
    }

    /** Peters closed form: remaining physical time to reach the plunge radius. */
    physicalTimeToMerge() {
        const K = (64 / 5) * this.m1 * this.m2 * this.totalMass;
        return Math.max(this.a ** 4 - this.mergerRadius ** 4, 0) / (4 * K);
    }

    // ── Pacing ───────────────────────────────────────────────────────────

    /**
     * Physical seconds elapsed per wall-clock second, at the current separation.
     *
     * A constant time scale is the obvious choice and it is wrong. Peters decay
     * is a runaway: with a fixed scale the binary spends 98% of the animation
     * drifting and then crosses the entire interesting regime in a fraction of
     * a second. Measured on the old constant-scale version: 63.6 degrees of
     * orbit advanced per frame at merger — not a fast orbit, a strobe — and
     * only 0.18 s of the ten-second run spent inside a = 40.
     *
     * So the wall-clock → physical-time map is warped by a power law,
     *
     *     timeScale(a) = timeScale₀ · (a / a₀)^p
     *
     * which slows the film down exactly where the physics accelerates. The
     * on-screen angular rate then goes as a^(p − 3/2): at p = 0.75 the chirp
     * survives at 2.5× acceleration instead of 6.1×, the peak rate drops to
     * about 9 degrees per frame, and 1.09 s is spent inside a = 40.
     *
     * Note what this does *not* touch: a, phase and every derived readout are
     * still integrated in true physical time. Only the projection onto the
     * viewer's clock is stretched. A power law is C^∞, so there are no velocity
     * seams anywhere in the run.
     *
     * After merger the warp freezes (a is pinned at the plunge radius) and an
     * additional constant slow-motion factor is applied. Unmodified, the whole
     * ringdown lasts 0.53 wall seconds — which is *correct*, the hole really
     * does stop ringing that fast compared to the inspiral, but it means the
     * one moment the exhibit is about goes by almost unseen. The factor is a
     * constant, so it introduces no velocity discontinuity within the ringdown;
     * it does introduce a step at the merger instant, which is fine because the
     * merger is a discontinuity in the physics too.
     */
    effectiveTimeScale() {
        const warp = this.timeScale * Math.pow(this.a / this.a0, this.pacingExponent);
        if (this.merged) return warp / this.ringdownPacing;
        if (this.plunging) return warp / this._plungeSlowdown();
        return warp;
    }

    /**
     * The plunge slow-motion factor, eased in rather than switched on.
     *
     * Applying plungePacing as a step at the ISCO crossing halves the on-screen
     * angular rate in one frame — measured at 5.3 rad/s of instantaneous change,
     * which reads as a stutter even though nothing physical is discontinuous
     * there. Ramping it over the first third of the plunge with a smootherstep
     * (zero first and second derivative at both ends) removes it entirely.
     *
     * @private
     */
    _plungeSlowdown() {
        const span = this.mergerRadius - this.contactRadius;
        const s = span > 0
            ? Math.min(Math.max((this.mergerRadius - this.a) / (span * 0.35), 0), 1)
            : 1;
        const ease = s * s * s * (s * (s * 6 - 15) + 10);
        return 1 + (this.plungePacing - 1) * ease;
    }

    /** Live compression factor for the instrument panel, e.g. 3400 → "3400×". */
    timeCompression() {
        return this.effectiveTimeScale();
    }

    // ── The plunge ───────────────────────────────────────────────────────

    /**
     * Switch from Peters decay to a Schwarzschild plunge geodesic.
     *
     * Peters describes a quasi-circular orbit shrinking slowly. Below the ISCO
     * there is no orbit left to shrink — the star is simply falling, and the
     * right description is a timelike geodesic in the hole's field. The
     * previous version had no plunge at all: it stopped at r = 30 while the
     * horizon sits at r = 10 and the star's surface is 8.1 wide, leaving an
     * unbridged gap of 12 units between two bodies declared "merged".
     *
     * The geodesic conserves specific angular momentum L (fixed at its ISCO
     * value √12·M) and specific energy E. E is *not* set to the circular-orbit
     * value √(8/9); it is solved so that the plunge starts with exactly the
     * radial velocity Peters had at the crossing. Otherwise the star arrives at
     * the ISCO already moving inward and instantly switches to a trajectory
     * that starts at rest — a velocity discontinuity — and then loiters near
     * the marginally stable orbit for dozens of revolutions before falling.
     * Matching removes both problems: the measured plunge is 607 degrees, a
     * little under two clean final revolutions, ending at contact.
     *
     * @private
     */
    _beginPlunge() {
        this.plunging = true;
        this.a = this.mergerRadius;

        const r = this.a;
        const M = this.totalMass;
        const f = 1 - 2 * M / r;
        const potential = f * (1 + this.plungeL ** 2 / (r * r));
        const drdt = this.orbitalDecayRate();       // Peters, at the crossing

        // dr/dt = −√(E² − V²)·f/E, solved for E with the radial velocity fixed.
        // Substituting u = E² gives a linear equation: u(1 − (drdt/f)²) = V².
        const k = (drdt / f) ** 2;
        this.plungeEnergy = Math.sqrt(potential / Math.max(1 - k, 1e-9));
    }

    /** dr/dt of the plunge geodesic, in coordinate time. Negative (infalling). */
    plungeRadialVelocity() {
        const r = this.a;
        const f = 1 - 2 * this.totalMass / r;
        const E = this.plungeEnergy;
        const radicand = E * E - f * (1 + this.plungeL ** 2 / (r * r));
        return -Math.sqrt(Math.max(radicand, 0)) * f / E;
    }

    /**
     * dφ/dt of the plunge geodesic. Grows as r⁻² because L is conserved: this
     * is the final whip-around, and it is not an effect anyone authored.
     */
    plungeAngularVelocity() {
        const r = this.a;
        const f = 1 - 2 * this.totalMass / r;
        return (this.plungeL / (r * r)) * f / this.plungeEnergy;
    }

    /**
     * Angular velocity for whichever regime the system is currently in.
     * Used for both the animation and the frequency readouts.
     */
    currentAngularVelocity() {
        return this.plunging ? this.plungeAngularVelocity() : this.orbitalAngularVelocity();
    }

    // ── Integration ──────────────────────────────────────────────────────

    /**
     * Advance the system by dt wall-clock seconds.
     *
     * Three regimes, in order: Peters inspiral down to the ISCO, a plunge
     * geodesic down to contact, then ringdown.
     *
     * @param {number} dt Wall-clock delta, in seconds.
     */
    step(dt) {
        const scaledDt = dt * this.effectiveTimeScale();

        if (this.merged) {
            this.ringdownTime += scaledDt;
            this.ringdownPhase += this.ringdownAngularFrequency() * scaledDt;
            return;
        }

        if (this.plunging) {
            this.phase += this.plungeAngularVelocity() * scaledDt;
            this.a += this.plungeRadialVelocity() * scaledDt;

            if (this.a <= this.contactRadius) {
                this.a = this.contactRadius;
                this.plunging = false;
                this.merged = true;
            }
            return;
        }

        this.phase += this.orbitalAngularVelocity() * scaledDt;
        this.a += this.orbitalDecayRate() * scaledDt;

        if (this.a <= this.mergerRadius) this._beginPlunge();
    }

    /** Positions of both bodies about the barycentre, in the orbital plane. */
    getPositions() {
        const d1 = this.a * (this.m2 / this.totalMass);
        const d2 = this.a * (this.m1 / this.totalMass);
        return {
            star: { x: Math.cos(this.phase) * d1, z: Math.sin(this.phase) * d1 },
            blackHole: { x: -Math.cos(this.phase) * d2, z: -Math.sin(this.phase) * d2 },
        };
    }

    // ── Tides ────────────────────────────────────────────────────────────

    /**
     * Separation at which the hole's tidal field overcomes the companion's
     * self-gravity and tears it apart: r_t ≈ R·(M_BH/M_NS)^(1/3).
     *
     * @param {number} companionRadius Radius of the neutron star.
     */
    tidalDisruptionRadius(companionRadius) {
        return companionRadius * Math.cbrt(this.m2 / this.m1);
    }

    /**
     * Whether disruption happens at all before the star plunges.
     *
     * For this exhibit's parameters it does not: r_t = 12.4 against a plunge
     * radius of 30, a ratio of 0.41. A 1.4 M☉ neutron star of realistic radius
     * falling into a *non-spinning* 5 M☉ hole goes in whole. That is the real
     * astrophysics, not a limitation of the model — disruption needs a lighter
     * hole, a stiffer star, or (most importantly) black hole spin, which drags
     * the innermost stable orbit inward and lets the star reach the tidal
     * radius first. Which is a good argument for a Kerr sequel, and a good
     * reason not to draw a debris stream here.
     *
     * @param {number} companionRadius Radius of the neutron star.
     */
    disrupts(companionRadius) {
        return this.tidalDisruptionRadius(companionRadius) > this.mergerRadius;
    }

    /**
     * Equilibrium tidal ellipticity of the companion — the fractional stretch
     * of its long axis, which points at the black hole.
     *
     *     ε ≈ (3/2)·h₂·(M_BH/M_NS)·(R/a)³
     *
     * This is the static (adiabatic) response of a fluid body to the external
     * quadrupole tidal field, with h₂ the Love number. It is small and it grows
     * as a⁻³, so it is invisible for most of the inspiral and then arrives all
     * at once: 1.3% at a = 60, 6.7% at a = 35, 10.6% at the plunge radius.
     *
     * The renderer multiplies this by a fixed gain to make it legible. The
     * shape of the curve is physics; its amplitude on screen is not.
     *
     * @param {number} companionRadius Radius of the neutron star.
     * @returns {number} Fractional elongation ε, dimensionless.
     */
    tidalEllipticity(companionRadius) {
        return 1.5 * this.tidalLoveNumber
            * (this.m2 / this.m1)
            * Math.pow(companionRadius / this.a, 3);
    }

    // ── Radiation ────────────────────────────────────────────────────────

    /**
     * Quadrupole strain amplitude seen by an observer at distance D:
     * h ≈ 4μω²a²/D. Exact to leading post-Newtonian order.
     *
     * @param {number} distanceToObserver
     */
    strainAmplitude(distanceToObserver) {
        const omega = this.currentAngularVelocity();
        return (4 * this.reducedMass * omega ** 2 * this.a ** 2) / distanceToObserver;
    }

    /**
     * Restore the initial state. Kept on the class so the renderer cannot
     * forget a field when a new one is added — which is exactly what happened
     * to the old inline reset when the plunge state arrived.
     */
    reset() {
        this.a = this.a0;
        this.phase = 0;
        this.merged = false;
        this.plunging = false;
        this.ringdownTime = 0;
        this.ringdownPhase = 0;
        this.plungeEnergy = 0;
        this.peakStrain = 0;
    }

    /**
     * Gravitational redshift factor g = √(1 − 2M/r) for light leaving the
     * companion at the current separation.
     *
     * Emitted photons climb out of the well and arrive redder and fainter.
     * Observed specific intensity scales as g⁴, so by the time the star's
     * surface touches the horizon its light has fallen to 8.6% of what it was
     * at the ISCO. The renderer softens that exponent — see REDSHIFT_EXPONENT
     * in main.js — because g⁴ makes the star vanish before it visibly falls in.
     *
     * Ignores the Doppler shift from orbital motion, which at these separations
     * is a smaller correction and would require tracking the line of sight.
     */
    redshiftFactor() {
        return Math.sqrt(Math.max(1 - 2 * this.totalMass / this.a, 0));
    }

    // ── The remnant ──────────────────────────────────────────────────────

    /**
     * Fraction of the total mass radiated away as gravitational waves.
     *
     * Numerical-relativity fit for non-spinning progenitors, leading order in
     * η, normalised so an equal-mass merger radiates ~5.6%. Sanity check: the
     * test-particle binding energy at the Schwarzschild ISCO is 1 − √(8/9) =
     * 5.7% per unit reduced mass, which for η = 0.171 gives ~1% from the
     * inspiral alone — the rest comes from the plunge and ringdown, which is
     * the right proportion.
     *
     * For this binary: 3.8% of 6.4 M☉.
     */
    radiatedEnergyFraction() {
        return 0.0559 * (4 * this.symmetricMassRatio);
    }

    /** Mass of the black hole left behind. */
    get finalMass() {
        return this.totalMass * (1 - this.radiatedEnergyFraction());
    }

    /**
     * Dimensionless spin a/M of the remnant.
     *
     * Fit for non-spinning progenitors: a_f = 2√3·η − 3.871·η² + 4.28·η³
     * (Buonanno, Kidder & Lehner 2008, and consistent with Rezzolla et al.).
     * Gives 0.500 here. Every merger remnant is a Kerr hole — even from two
     * non-spinning parents the orbital angular momentum has to go somewhere.
     *
     * The exhibit renders a Schwarzschild horizon, so this spin is used for
     * the ringdown frequency but is not drawn. Disclosed in what.html.
     */
    get finalSpin() {
        const n = this.symmetricMassRatio;
        return 2 * Math.sqrt(3) * n - 3.871 * n ** 2 + 4.28 * n ** 3;
    }

    /**
     * Horizon growth factor: R_s(final) / R_s(original hole).
     *
     * The hole eats a neutron star and gets visibly bigger — 23% larger
     * Schwarzschild radius here. This is the exhibit's actual merger event.
     * There is no light: nothing was disrupted, so there is no ejecta, no
     * kilonova, no electromagnetic counterpart. What changes is the geometry.
     */
    horizonGrowthFactor() {
        return this.finalMass / this.m2;
    }

    // ── Ringdown ─────────────────────────────────────────────────────────

    /**
     * Angular frequency of the dominant l = m = 2, n = 0 quasi-normal mode of
     * the remnant Kerr hole.
     *
     *     M·ω_R = 1.5251 − 1.1568·(1 − a/M)^0.1292
     *
     * (Berti, Cardoso & Will 2006, Table VIII fit.) The ringdown is the hole
     * itself vibrating, not the orbit — its frequency is set by the remnant's
     * mass and spin and has nothing to do with where the orbit stopped.
     *
     * The previous version returned twice the final orbital frequency, which
     * is 2.5× too low. The audible consequence, if this had sound, is that the
     * chirp should jump *up* in pitch at merger, not continue smoothly.
     */
    ringdownAngularFrequency() {
        const chi = Math.min(this.finalSpin, 0.999);
        const Momega = 1.5251 - 1.1568 * Math.pow(1 - chi, 0.1292);
        return Momega / this.finalMass;
    }

    /**
     * e-folding time of the ringdown, τ = 2Q/ω_R, with the quality factor
     *
     *     Q = 0.7000 + 1.4187·(1 − a/M)^(−0.4990)
     *
     * (same source). Gives τ ≈ 71 physical time units here. Deriving the decay
     * from the mode's quality factor replaces the previous hand-set decay
     * constant: how fast the hole stops ringing follows from how fast it spins.
     */
    ringdownDampingTime() {
        const chi = Math.min(this.finalSpin, 0.999);
        const Q = 0.7000 + 1.4187 * Math.pow(1 - chi, -0.4990);
        return 2 * Q / this.ringdownAngularFrequency();
    }

    /**
     * Exponential envelope of the ringdown, 1 before merger.
     * @returns {number} In [0, 1].
     */
    ringdownEnvelope() {
        if (!this.merged) return 1.0;
        return Math.exp(-this.ringdownTime / this.ringdownDampingTime());
    }

    /** True once the remnant has effectively stopped ringing. */
    get ringdownComplete() {
        return this.merged && this.ringdownEnvelope() < 0.01;
    }
}

// =====================================================================
//  Pacing helpers
// =====================================================================

/**
 * Time scale that makes the binary appear to orbit at a chosen rate at the
 * *initial* separation. This is the readability knob: pick how fast the first
 * orbit should look, and the power-law warp handles the rest.
 *
 * At 0.8 rev/s with a₀ = 70 and p = 0.75, the measured run is 10.4 s long,
 * peaks at 1.35 rev/s, and never exceeds ~9 degrees of orbit per frame.
 *
 * @param {BinaryOrbit} orbit
 * @param {number} revolutionsPerSecond Apparent orbital rate at a₀.
 */
export function timeScaleForInitialRate(orbit, revolutionsPerSecond) {
    return (revolutionsPerSecond * 2 * Math.PI) / orbit.orbitalAngularVelocity();
}

/**
 * Time scale that makes the whole inspiral last a chosen number of wall-clock
 * seconds under the warped pacing.
 *
 * With a constant time scale this was a one-line closed form. Under a power-law
 * warp there isn't one, so this integrates the decay numerically once at start-
 * up (a few thousand cheap steps) and bisects on the scale factor. Exact enough
 * that the error is well under a frame.
 *
 * @param {BinaryOrbit} orbit
 * @param {number} desiredSeconds
 * @returns {number} Value to assign to orbit.timeScale.
 */
export function timeScaleForDuration(orbit, desiredSeconds) {
    const durationFor = (scale) => {
        let a = orbit.a0;
        let t = 0;
        const dt = 1 / 240;
        const K = (64 / 5) * orbit.m1 * orbit.m2 * orbit.totalMass;
        // Guard: 2000 wall-seconds of simulated time is far beyond any sane input.
        while (a > orbit.mergerRadius && t < 2000) {
            const ts = scale * Math.pow(a / orbit.a0, orbit.pacingExponent);
            a -= (K / a ** 3) * dt * ts;
            t += dt;
        }
        return t;
    };

    let lo = 1e-6;
    let hi = 1e9;
    for (let i = 0; i < 60; i++) {
        const mid = Math.sqrt(lo * hi);          // geometric bisection: scale spans decades
        if (durationFor(mid) > desiredSeconds) lo = mid;
        else hi = mid;
    }
    return Math.sqrt(lo * hi);
}