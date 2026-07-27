// shared/BlackHole.js

import * as THREE from 'three';

export class BlackHole {

    constructor(options = {}) {
        this.radius = options.radius ?? 4;
        this.colorWrite = options.colorWrite ?? true;

        this.group = new THREE.Group();
        
        this._buildMesh();
    }

    _buildMesh() {
        this.mesh = new THREE.Mesh(
            new THREE.SphereGeometry(this.radius, 32, 32),
            new THREE.MeshBasicMaterial({
                color:0x000000,
                depthWrite: true,
                colorWrite: this.colorWrite,
            })
        );
        this.group.add(this.mesh);
    }

    getScreenRadius(camera) {
        const worldPos = new THREE.Vector3();
        this.mesh.getWorldPosition(worldPos);
    
        const right = new THREE.Vector3();
        camera.getWorldDirection(right);
        right.cross(camera.up).normalize();
    
        const edge = worldPos.clone().addScaledVector(right, this.radius);
        const center = worldPos.clone().project(camera);
        const edgeProjected = edge.clone().project(camera);
    
        return Math.abs(edgeProjected.x - center.x) * 0.5;
    }

    getWorldPosition(target) {
        return this.mesh.getWorldPosition(target);
    }
}