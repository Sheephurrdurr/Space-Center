// =====================================================================
// Keyboard input.
//
// Input-laget ved INTET om planeter, gravity eller
// kameraer. Det oversætter kun taster til abstrakte intentioner
// (forward/right/jump). Player-laget fortolker dem. 
// =====================================================================

export class Controls {
    #keys = new Set();
    #jumpQueuedAt = -Infinity;

    #touchVec = { x: 0, y: 0 };   // joystick-retning, -1..1
    #touchSprint = false;
    #joyTouchId = null;           // hvilken finger ejer joysticken
    #joyOrigin = { x: 0, y: 0 };

    constructor() {
        window.addEventListener('keydown', (e) => {
            // Undgå at siden scroller når man spiller
            if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
                e.preventDefault();
            }
            if (e.code === 'Space' && !e.repeat) {
                // Jump buffering: gem tidspunktet. Player må gerne bruge
                // hoppet op til 0.15s senere, cuz that feels better
                this.#jumpQueuedAt = performance.now();
            }
            this.#keys.add(e.code);
        });

        window.addEventListener('keyup', (e) => this.#keys.delete(e.code));
        window.addEventListener('blur', () => this.#keys.clear());

        this.#setupTouch();
    }

    #setupTouch() {
        const RADIUS = 55; // px før joysticken er "i bund"

        // Visuel joystick: ring + knop, skjult indtil en finger lander
        this.joyBase = document.createElement('div');
        this.joyBase.className = 'joy-base';
        this.joyNub = document.createElement('div');
        this.joyNub.className = 'joy-nub';
        this.joyBase.appendChild(this.joyNub);
        document.body.appendChild(this.joyBase);

        window.addEventListener('touchstart', (e) => {
            if (e.target.closest(".placard, .nav-toggle, .nav-menu")) return;
            
            for (const t of e.changedTouches) {
                if (t.clientX < window.innerWidth / 2 && this.#joyTouchId === null) {
                    // Venstre side: joysticken fødes under fingeren
                    this.#joyTouchId = t.identifier;
                    this.#joyOrigin = { x: t.clientX, y: t.clientY };
                    this.joyBase.style.left = t.clientX + 'px';
                    this.joyBase.style.top = t.clientY + 'px';
                    this.joyBase.classList.add('active');
                } else {
                    // Højre side: hop (genbruger jump-buffering)
                    this.#jumpQueuedAt = performance.now();
                }
            }
        }, { passive: false });

        window.addEventListener('touchmove', (e) => {
            e.preventDefault(); // stop browseren i at scrolle/zoome
            for (const t of e.changedTouches) {
                if (t.identifier !== this.#joyTouchId) continue;
                let dx = t.clientX - this.#joyOrigin.x;
                let dy = t.clientY - this.#joyOrigin.y;
                const len = Math.hypot(dx, dy);
                const clamped = Math.min(len, RADIUS);
                if (len > 0) { dx = dx / len * clamped; dy = dy / len * clamped; }

                this.joyNub.style.transform = `translate(${dx}px, ${dy}px)`;
                // Skærm-y peger NED, spil-forward er OP → minus
                this.#touchVec = { x: dx / RADIUS, y: -dy / RADIUS };
                this.#touchSprint = clamped > RADIUS * 0.85;
            }
        }, { passive: false });

        const endTouch = (e) => {
            for (const t of e.changedTouches) {
                if (t.identifier !== this.#joyTouchId) continue;
                this.#joyTouchId = null;
                this.#touchVec = { x: 0, y: 0 };
                this.#touchSprint = false;
                this.joyNub.style.transform = 'translate(0px, 0px)';
                this.joyBase.classList.remove('active');
            }
        };
        window.addEventListener('touchend', endTouch);
        window.addEventListener('touchcancel', endTouch);
    }

    #down(...codes) {
        return codes.some((c) => this.#keys.has(c)) ? 1 : 0;
    }

    /** -1..1: keyboard hvis aktivt, ellers joystick */
    get forward() {
        const kb = this.#down('KeyW', 'ArrowUp') - this.#down('KeyS', 'ArrowDown');
        return kb !== 0 ? kb : this.#touchVec.y;
    }

    get right() {
        const kb = this.#down('KeyD', 'ArrowRight') - this.#down('KeyA', 'ArrowLeft');
        return kb !== 0 ? kb : this.#touchVec.x;
    }

    get sprint() {
        return this.#down('ShiftLeft', 'ShiftRight') === 1 || this.#touchSprint;
    }

    /** Returnér true ÉN gang hvis et hop er buffered.. og brug det. */
    consumeJump() {
        if (performance.now() - this.#jumpQueuedAt < 150) {
            this.#jumpQueuedAt = -Infinity;
            return true;
        }
        return false;
    }
}
