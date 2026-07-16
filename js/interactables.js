// =====================================================================
// Exhibit-monumenter + proximity-systemet.
//
// Arkitekturen:
//
//   InteractableSystem  ← kender listen, finder nærmeste, styrer UI
//        │  består af
//   Interactable        ← ét monument: position, radius, data, visuals
//
// Systemet ved IKKE hvordan et Kerr-monument ser ud, det får en
// build-funktion injiceret. Systemet afhænger af kontrakten (position, update, setActive),
// ikke af implementationen.
// =====================================================================
import * as THREE from 'three';
import { surfaceUp, projectOnTangent, tangentBasisQuaternion, groundRadiusAt } from './planetMath.js';

const ACTIVATE_RADIUS = 6;   // meter — hvor tæt man skal være
const ACCENT = new THREE.Color('#5fd3c4');
const WARM = new THREE.Color('#ffb454');

// --- Stien: én storcirkel som alle exhibits ligger på -------------------
// Cirklen er skæringen mellem kuglen og et plan gennem centrum, defineret
// ved sin normal. Normalen er valgt næsten vinkelret på spawn-retningen,
// så stien passerer tæt forbi startpunktet.
const PATH_NORMAL = new THREE.Vector3(-1, 0.25, 0.55).normalize();
const SPAWN_DIR = new THREE.Vector3(0.25, 1, 0.4).normalize(); // samme som player.js

const _pathA = new THREE.Vector3();
const _pathB = new THREE.Vector3();
// A = spawn-retningen projiceret ind i stiens plan (så θ=0 ≈ spawn),
// B = vinkelret på både N og A. Højrehåndet basis for cirklen.
projectOnTangent(SPAWN_DIR, PATH_NORMAL, _pathA).normalize();
_pathB.crossVectors(PATH_NORMAL, _pathA).normalize();

/** Retning fra planetens centrum til punktet på stien ved vinkel `angle`. */
export function pathDirection(angle, target = new THREE.Vector3()) {
    return target.copy(_pathA).multiplyScalar(Math.cos(angle))
        .addScaledVector(_pathB, Math.sin(angle));
}

// ---------------------------------------------------------------------
// Ét interaktivt monument på overfladen
// ---------------------------------------------------------------------
class Interactable {
    /**
     * @param dir    retning fra planetens centrum (normaliseres)
     * @param data   { number, title, desc, url }
     * @param build  funktion der returnerer monumentets THREE.Group —
     *               injiceres, så systemet er ligeglad med udseendet
     */
    constructor(dir, data, build) {
        this.data = data;
        this.active = false;

        const d = dir.clone().normalize();
        this.group = new THREE.Group();
        this.group.position.copy(d).multiplyScalar(groundRadiusAt(d));

        // Stil monumentet "opret" på kuglen — samme trick som astronauten
        tangentBasisQuaternion(d, randomTangent(d), this.group.quaternion);

        this.group.add(build());

        // --- Fælles udstyr for alle monumenter --------------------------

        // Lysende ring på jorden som highlight-indikator
        this.ring = new THREE.Mesh(
            new THREE.TorusGeometry(2.1, 0.06, 8, 40),
            new THREE.MeshBasicMaterial({
                color: ACCENT, transparent: true, opacity: 0.25,
            }));
        this.ring.rotation.x = Math.PI / 2;
        this.ring.position.y = 0.15;
        this.group.add(this.ring);

        // Beacon: en lyssøjle op i rummet, så exhibits kan ses på afstand.
        // openEnded cylinder + additiv blending = billig "hologram"-stråle.
        this.beacon = new THREE.Mesh(
            new THREE.CylinderGeometry(0.12, 0.45, 14, 10, 1, true),
            new THREE.MeshBasicMaterial({
                color: ACCENT, transparent: true, opacity: 0.10,
                blending: THREE.AdditiveBlending, depthWrite: false,
                side: THREE.DoubleSide,
            }));
        this.beacon.position.y = 7;
        this.group.add(this.beacon);
    }

    setActive(on) {
        if (this.active === on) return;
        this.active = on;
        this.ring.material.opacity = on ? 0.9 : 0.25;
        this.beacon.material.opacity = on ? 0.22 : 0.10;
    }

    update(dt, t) {
        // Aktiv ring "ånder" 
        if (this.active) {
            const pulse = 1 + Math.sin(t * 3.5) * 0.04;
            this.ring.scale.setScalar(pulse);
        } else if (this.ring.scale.x !== 1) {
            this.ring.scale.setScalar(1);
        }
        this.animate?.(dt, t); // monument-specifik animation, hvis sat.. but it aint
    }
}

/** En vilkårlig vektor vinkelret på d, bare til at orientere monumenter. */
function randomTangent(d) {
    const ref = Math.abs(d.y) < 0.99
        ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(1, 0, 0);
    return new THREE.Vector3().crossVectors(d, ref).normalize();
}

// ---------------------------------------------------------------------
// Systemet: registrering, proximity, UI, navigation
// ---------------------------------------------------------------------
export class InteractableSystem {
    constructor(scene, player) {
        this.scene = scene;
        this.player = player;
        this.items = [];
        this.current = null;

        this.#buildPlacardDOM();

        // Interact-tast: kun aktiv når et exhibit er nært
        window.addEventListener('keydown', (e) => {
            if ((e.code === 'KeyE' || e.code === 'Enter') && this.current && this.current.data.url) {
                window.location.href = this.current.data.url;
            }
        });
    }

    register(dir, data, build) {
        const item = new Interactable(dir, data, build);
        this.items.push(item);
        this.scene.add(item.group);
        return item;
    }

    update(dt, t) {
        // Find nærmeste exhibit inden for aktiveringsradius.
        // O(n) hver frame. Helt fint til 4-10 exhibits. (Får museet 500
        // exhibits en dag, snakker vi spatial partitioning. Meeen det gør det ikke.)
        let nearest = null;
        let bestDistSq = ACTIVATE_RADIUS * ACTIVATE_RADIUS;

        for (const item of this.items) {
            const dSq = item.group.position.distanceToSquared(this.player.position);
            if (dSq < bestDistSq) {
                bestDistSq = dSq;
                nearest = item;
            }
            item.update(dt, t);
        }

        if (nearest !== this.current) {
            this.current?.setActive(false);
            nearest?.setActive(true);
            this.current = nearest;
            this.#updatePlacard();
        }
    }

    // --- Placard-UI (DOM-lag ovenpå canvas) ------------------------------
    #buildPlacardDOM() {
        this.placard = document.createElement('div');
        this.placard.className = 'placard';
        this.placard.innerHTML = `
            <span class="placard-number"></span>
            <h2 class="placard-title"></h2>
            <p class="placard-desc"></p>
            <span class="placard-action">
                <span class="hint-key">E</span> Enter exhibit
            </span>`;
        document.body.appendChild(this.placard);

        this.placard.addEventListener('click', () => {
            if (this.current?.data.url) window.location.href = this.current.data.url;
        });
    }

    #updatePlacard() {
        if (!this.current) {
            this.placard.classList.remove('visible');
            return;
        }
        const { number, title, desc } = this.current.data;
        this.placard.querySelector('.placard-number').textContent = number;
        this.placard.querySelector('.placard-title').innerHTML = title;
        this.placard.querySelector('.placard-desc').textContent = desc;

        const isTouch = window.matchMedia('(pointer: coarse)').matches;
        this.placard.querySelector('.placard-action').innerHTML = this.current.data.url
            ? (isTouch ? 'Tap to enter' : '<span class="hint-key">E</span> Enter exhibit')
            : 'Coming soon';

        this.placard.classList.add('visible');
    }
}

// ---------------------------------------------------------------------
// Monument-visuals med én build-funktion per exhibit.
// Alle står på samme sokkel, men bærer forskellige "modeller".
// ---------------------------------------------------------------------

function pedestal() {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({
        color: '#494361', flatShading: true, roughness: 0.9,
    });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.9, 0.5, 7), mat);
    base.position.y = 0.25;
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 1.4, 7), mat);
    column.position.y = 1.2;
    g.add(base, column);
    return g;
}

function blackSphere(r) {
    return new THREE.Mesh(
        new THREE.SphereGeometry(r, 20, 16),
        new THREE.MeshBasicMaterial({ color: 0x000000 }));
}

function glowRing(r, tube, color, intensity = 1) {
    return new THREE.Mesh(
        new THREE.TorusGeometry(r, tube, 8, 48),
        new THREE.MeshStandardMaterial({
            color, emissive: color, emissiveIntensity: intensity,
            flatShading: true,
        }));
}

/** 001 — Schwarzschild: sort kugle med fotonring, stille og roligt truende. */
export function buildSchwarzschild() {
    const g = pedestal();
    const bh = blackSphere(0.85);
    bh.position.y = 3.1;
    const photonRing = glowRing(1.0, 0.035, WARM, 1.4);
    photonRing.position.y = 3.1;
    photonRing.rotation.x = Math.PI / 2.4;
    g.add(bh, photonRing);
    return g;
}

/** 002 — Kerr: sort kugle med roterende accretion disk. */
export function buildKerr() {
    const g = pedestal();
    const bh = blackSphere(0.75);
    bh.position.y = 3.1;

    const disk = new THREE.Group();
    disk.position.y = 3.1;
    disk.rotation.x = Math.PI / 2.15; // let tiltet, lidt mere dramatisk
    disk.add(glowRing(1.15, 0.09, WARM, 1.6));
    disk.add(glowRing(1.55, 0.05, new THREE.Color('#ff7a3c'), 1.1));

    // Hot spot: en torus er rotationssymmetrisk, så uden et asymmetrisk
    // punkt kan man ikke SE at disken roterer. Klassisk grafik-fælde.
    const hotSpot = new THREE.Mesh(
        new THREE.SphereGeometry(0.13, 8, 6),
        new THREE.MeshStandardMaterial({
            color: '#fff3d6', emissive: '#ffe9b8', emissiveIntensity: 2.2,
        }));
    hotSpot.position.set(1.15, 0, 0);
    disk.add(hotSpot);
    g.add(bh, disk);

    // Gem en reference så Interactable.animate kan spinne den
    g.userData.spin = disk;
    return g;
}

/** 003 + 004 — Merger: BH og NS i kredsløb om fælles massecenter. */
export function buildMerger(withLensRing = false) {
    const g = pedestal();

    const orbit = new THREE.Group();
    orbit.position.y = 3.2;

    const bh = blackSphere(0.5);
    bh.position.x = 0.45;
    const ns = new THREE.Mesh(
        new THREE.SphereGeometry(0.28, 14, 12),
        new THREE.MeshStandardMaterial({
            color: '#dfeaff', emissive: '#9fc4ff', emissiveIntensity: 1.6,
        }));
    ns.position.x = -1.1; // længere ude fordi den er lettest (m·r er ens om CoM)
    orbit.add(bh, ns);

    if (withLensRing) {
        // Einstein-ring om den sorte hul — lensing-udgavens kendetegn
        const lens = glowRing(0.78, 0.025, new THREE.Color('#bcd9ff'), 1.2);
        bh.add(lens);
        lens.rotation.x = Math.PI / 2.6;
    }

    g.add(orbit);
    g.userData.spin = orbit;
    return g;
}

/** 005 — Coming soon exhibit:  */
export function buildComingSoon() {
    const g = pedestal();
    const ghost = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.7, 1),
        new THREE.MeshStandardMaterial({
            color: '#7a7492', wireframe: true, transparent: true, opacity: 0.4,
        }));
    ghost.position.y = 3.0;
    g.add(ghost);
    g.userData.spin = ghost; // roterer langsomt, så den ikke virker helt død
    return g;
}

// ---------------------------------------------------------------------
// Opsætning: registrér museets fire exhibits.
// Kaldes fra main.js — composition root beslutter HVAD der findes,
// systemet håndterer HVORDAN det opfører sig.
// ---------------------------------------------------------------------
export function registerExhibits(system) {
    const V = THREE.Vector3;
    const step = Math.PI * 2 / 5; // 72° mellem exhibits

    const e1 = system.register(pathDirection(0 * step), {
        number: 'Exhibit 001',
        title: 'Static, Non Rotating<br>Black Hole',
        desc: 'A 5 solar mass black hole rendered via real-time ray marching through curved spacetime. ',
        url: '/exhibits/blackhole/index.html',
    }, buildSchwarzschild);

    const e2 = system.register(pathDirection(1 * step), {
        number: 'Exhibit 002',
        title: 'The Cool Exhibit<br>Rotating Black Hole',
        desc: 'Kerr metric, RK4 Hamiltonian geodesics. Unhinged math and physics come together to create stunning visuals.',
        url: '/exhibits/Kerr_finalBoss/index.html',
    }, buildKerr);

    const e3 = system.register(pathDirection(2 * step), {
        number: 'Exhibit 003',
        title: 'Two Of the Densest Objects Collide:<br>Gravitational Waves',
        desc: 'A neutron star and a black hole in their final moments. Throw Peters & Mathews orbital decay after the compiler and watch them ripple through spacetime.',
        url: '/exhibits/merger_gw/index.html',
    }, () => buildMerger(false));

    const e4 = system.register(pathDirection(3 * step), {
        number: 'Exhibit 004',
        title: 'Two Of The Densest Object Collide:<br>Gravitational Lensing',
        desc: 'A neutron star and a black hole in their final moments. But with more "blackhole distrupts spacetime"',
        url: '/exhibits/merger_lens/index.html',
    }, () => buildMerger(true));

    const e5 = system.register(pathDirection(4 * step), {
        number: '',
        title: 'A Mysterious Object',
        desc: 'Next exhibit is on its way. Maybe.',
    }, buildComingSoon);

    // Animation: spin diske og orbits. Hastigheden er "kunstnerisk" —
    // rigtig fysik bor inde i selve exhibitsene.
    e2.animate = makeSpinner(e2, 'z', 1.1);
    e3.animate = makeSpinner(e3, 'y', 2.2);
    e4.animate = makeSpinner(e4, 'y', 2.2);
    e5.animate = makeSpinner(e5, 'y', 0.4);
}

/**
 * Returnerer en animate-funktion der spinner monumentets 'spin'-gruppe.
 * Referencen slås op ÉN gang og caches i closuren — ikke traverse()
 * 60 gange i sekundet. (Closures som privat state: JavaScripts svar
 * på et private felt.)
 */
function makeSpinner(item, axis, speed) {
    let spin; // undefined = ikke slået op endnu, null = findes ikke
    return (dt) => {
        if (spin === undefined) {
            spin = null;
            item.group.traverse((o) => { if (o.userData?.spin) spin = o.userData.spin; });
        }
        if (!spin) return;
        if (axis === 'z') spin.rotateZ(speed * dt);
        else spin.rotateY(speed * dt);
    };
}

/** Små lysende sten langs stien, så retningen aldrig er til at tage fejl af. */
export function buildPathMarkers(scene) {
    const markers = new THREE.Group();
    const geo = new THREE.OctahedronGeometry(0.14, 0);
    const markerMat = new THREE.MeshStandardMaterial({
        color: '#3a5f5a', emissive: ACCENT, emissiveIntensity: 0.5,
        flatShading: true,
    });
    const STEP = Math.PI * 2 / 60;          // en sten per 6°
    const EXHIBIT_GAP = Math.PI * 2 / 5;    // exhibit-vinklerne
    const dir = new THREE.Vector3();

    for (let a = 0; a < Math.PI * 2 - 1e-6; a += STEP) {
        // Spring over tæt på exhibits — de skal ikke drukne i småsten
        const nearestExhibit = Math.round(a / EXHIBIT_GAP) * EXHIBIT_GAP;
        if (Math.abs(a - nearestExhibit) < THREE.MathUtils.degToRad(10)) continue;

        pathDirection(a, dir);
        const m = new THREE.Mesh(geo, markerMat);
        m.position.copy(dir).multiplyScalar(groundRadiusAt(dir) + 0.02);
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        m.rotateY(a * 7); // lidt variation i drejningen
        markers.add(m);
    }
    scene.add(markers);
}

/** Nav-menu: toggle-knap + liste over alle registrerede exhibits.
 *  Læser direkte fra system.items — registreringen ER datakilden. */
export function buildNavMenu(system) {
    const toggle = document.createElement('button');
    toggle.className = 'nav-toggle';
    toggle.textContent = '☰';
    toggle.setAttribute('aria-label', 'Exhibit list');

    const menu = document.createElement('nav');
    menu.className = 'nav-menu';

    for (const item of system.items) {
        const { number, title, url } = item.data;
        // Links for rigtige exhibits, "dødt" element for coming soon
        const entry = document.createElement(url ? 'a' : 'span');
        entry.className = 'nav-entry' + (url ? '' : ' nav-disabled');
        if (url) entry.href = url;
        entry.innerHTML = `
            <span class="nav-number">${number || '&mdash;'}</span>
            <span class="nav-title">${title.replace(/<br\s*\/?>/g, ' ')}</span>`;
        menu.appendChild(entry);
    }

    toggle.addEventListener('click', () => {
        menu.classList.toggle('open');
    });

    document.body.append(toggle, menu);
}
