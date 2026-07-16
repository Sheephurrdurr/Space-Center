// =====================================================================
// "lazy follow" third-person kamera.
//
// Kameraet husker sin egen position og bliver blot trukket mod en ønsket afstand + højde.
//
// Planet-walking: camera.up sættes til spillerens sfæriske up hvert frame. 
// =====================================================================
import * as THREE from 'three';
import { PLANET, surfaceUp, projectOnTangent } from './planetMath.js';

const DIST = 8.5;    // ønsket vandret afstand
const HEIGHT = 3.8;  // ønsket højde over spilleren (langs up)

const _up = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();

export class CameraRig {
    constructor(camera, player) {
        this.camera = camera;
        this.player = player;

        // Startposition: bag spilleren
        surfaceUp(player.position, _up);
        camera.position.copy(player.position)
            .addScaledVector(player.facing, -DIST)
            .addScaledVector(_up, HEIGHT);
    }

    update(dt) {
        const p = this.player.position;
        surfaceUp(p, _up);

        // Hvor er kameraet i forhold til spilleren but with tagents
        _offset.copy(this.camera.position).sub(p);
        projectOnTangent(_offset, _up, _offset);
        if (_offset.lengthSq() < 1e-4) {
            _offset.copy(this.player.facing).multiplyScalar(-1);
        }
        _offset.normalize();

        // Ønsket position: samme tangent-retning, fast afstand og højde
        _desired.copy(p)
            .addScaledVector(_offset, DIST)
            .addScaledVector(_up, HEIGHT);

        // Eksponentiel dæmpning giver frameRATE-uafhængig smoothing.
        // (lerp med fast faktor ville opføre sig forskelligt ved 60 og
        // 144 fps; 1 - e^(-k·dt) gør den konsistent.)
        this.camera.position.lerp(_desired, 1 - Math.exp(-5 * dt));

        // Lad ikke kameraet dykke ned i planeten
        const minR = PLANET.radius + PLANET.terrainAmp + 1.2;
        if (this.camera.position.length() < minR) {
            this.camera.position.setLength(minR);
        }

        // THE LINE that then enables all this to work
        this.camera.up.copy(_up);

        _look.copy(p).addScaledVector(_up, 1.6);
        this.camera.lookAt(_look);
    }
}
