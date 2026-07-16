// Geometriske enheder: G = c = 1. Ligningerne er ægte fysik (Peters 1964).
// Tallene (masse, afstand) er artistiske toy-units, ikke kg/meter.

export class BinaryOrbit {
    constructor({ massStar, massBH, separation, timeScale = 1, maxAngularVelocity = 6.0 }) {
        this.m1 = massStar;
        this.m2 = massBH;
        this.a = separation;
        this.timeScale = timeScale;
        this.maxAngularVelocity = maxAngularVelocity;
        this.phase = 0;
        this.merged = false;
        this.ringdownTime = 0;
        this.ringdownPhase = 0;
        this.mergerRadius = 6 * Math.max(this.m1, this.m2);
    }

    get totalMass() { return this.m1 + this.m2; }
    get reducedMass() { return (this.m1 * this.m2) / this.totalMass; }

    orbitalAngularVelocity() {
        const omega = Math.sqrt(this.totalMass / (this.a ** 3));
        return Math.min(omega, this.maxAngularVelocity);
    }

    gwAngularFrequency() {
        return 2 * this.orbitalAngularVelocity();
    }

    orbitalDecayRate() {
        return -(64 / 5) * this.m1 * this.m2 * this.totalMass / (this.a ** 3);
    }

    step(dt) {
        const scaledDt = dt * this.timeScale;

        if (this.merged) {
            this.ringdownTime += scaledDt;
            this.ringdownPhase += this.ringdownAngularFrequency() * scaledDt;
            return;
        }

        this.phase += this.orbitalAngularVelocity() * scaledDt;
        this.a += this.orbitalDecayRate() * scaledDt;

        if (this.a <= this.mergerRadius) {
            this.a = this.mergerRadius;
            this.merged = true;
        }
    }

    getPositions() {
        const d1 = this.a * (this.m2 / this.totalMass);
        const d2 = this.a * (this.m1 / this.totalMass);
        return {
            star: { x: Math.cos(this.phase) * d1, z: Math.sin(this.phase) * d1 },
            blackHole: { x: -Math.cos(this.phase) * d2, z: -Math.sin(this.phase) * d2 }
        };
    }

    tidalDisruptionRadius(companionRadius) {
        const q = this.m2 / this.m1;
        return companionRadius * Math.cbrt(2 * Math.max(q, 1 / q));
    }

    strainAmplitude(distanceToObserver) {
        const omega = this.orbitalAngularVelocity();
        return (4 * this.reducedMass * omega ** 2 * this.a ** 2) / distanceToObserver;
    }

    ringdownAngularFrequency() {
        return this.gwAngularFrequency();
    }

    ringdownEnvelope(decayConstant = 2.0) {
        if (!this.merged) return 1.0;
        return Math.exp(-this.ringdownTime * decayConstant);
    }

    physicalTimeToMerge() {
        const K = (64 / 5) * this.m1 * this.m2 * this.totalMass;
        return (this.a ** 4 - this.mergerRadius ** 4) / (4 * K);
    }
}


export function timeScaleForDuration(orbit, desiredSeconds) {
    return orbit.physicalTimeToMerge() / desiredSeconds;
}