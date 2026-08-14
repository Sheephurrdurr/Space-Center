// =====================================================================
//  shared/BlackHole.js
//
//  A black disk with a depth write. It is not a renderer — the lensing
//  passes in each exhibit draw the actual optics — it is an occluder and
//  a position anchor, and getScreenRadius() tells the shader how large
//  the hole is on screen.
// =====================================================================

import * as THREE from 'three';

// Scratch, allocated once. getScreenRadius runs every frame in three
// exhibits; the previous version built four Vector3s per call.
const _worldPos = new THREE.Vector3();
const _right = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _worldScale = new THREE.Vector3();

export class BlackHole {
    /**
     * @param {object}  options
     * @param {number} [options.radius=4]      Schwarzschild radius, world units.
     * @param {boolean} [options.colorWrite=true] False when a post pass draws
     *                                         the hole and this mesh is only
     *                                         needed for depth.
     * @param {number} [options.segments=32]
     */
    constructor(options = {}) {
        this.radius = options.radius ?? 4;
        this.colorWrite = options.colorWrite ?? true;
        this.segments = options.segments ?? 32;

        this.group = new THREE.Group();
        this._buildMesh();
    }

    _buildMesh() {
        this.mesh = new THREE.Mesh(
            new THREE.SphereGeometry(this.radius, this.segments, this.segments),
            new THREE.MeshBasicMaterial({
                color: 0x000000,
                depthWrite: true,
                colorWrite: this.colorWrite,
            })
        );
        this.group.add(this.mesh);
    }

    /**
     * The hole's radius on screen, as a fraction of half the viewport width
     * in normalised device coordinates. This is the convention the lensing
     * shaders expect: they multiply by the aspect ratio to convert it into a
     * fraction of viewport height, which is the space their UV distances live
     * in. Changing the convention here means changing it there too.
     *
     * Two things the previous version got wrong.
     *
     * First, it projected a point offset sideways by `this.radius` and
     * measured how far that landed from the centre. That is the projection of
     * a point on the equator, not the silhouette: the outline of a sphere is
     * the set of points where the line of sight is tangent, which subtends
     * asin(R/d), not atan(R/d). The two agree to 0.2% at fifteen Schwarzschild
     * radii and diverge as the camera closes in — 3% at 3 Rs, 15% at 2 Rs.
     *
     * Second, it read `this.radius` and ignored the group's scale, so an
     * exhibit that grows the horizon at merger got a photon ring that stayed
     * the old size. That is why merger_gw carries a BH_SCREEN_RADIUS_TRACKS_SCALE
     * flag; with this version the flag can go, because the scale is included.
     *
     * @param {THREE.PerspectiveCamera} camera
     * @returns {number} Fraction of half the viewport width.
     */
    getScreenRadius(camera) {
        this.mesh.getWorldPosition(_worldPos);
        this.mesh.getWorldScale(_worldScale);

        // Uniform scale is assumed; the largest axis is the safe reading if it
        // ever is not, since an under-sized shadow is the more visible error.
        const radius = this.radius * Math.max(_worldScale.x, _worldScale.y, _worldScale.z);

        // Distance along the view axis, not straight-line distance: an object
        // at the edge of frame is farther from the eye than from the image
        // plane, and it is the image plane that sets the projected size.
        camera.getWorldDirection(_forward);
        _right.copy(_worldPos).sub(camera.position);
        const depth = Math.max(_right.dot(_forward), 1e-6);

        const distance = Math.max(_worldPos.distanceTo(camera.position), radius * 1.0001);

        // Silhouette half-angle, then its tangent, which is what projects
        // linearly onto the image plane.
        const sinAlpha = Math.min(radius / distance, 0.999999);
        const tanAlpha = sinAlpha / Math.sqrt(1 - sinAlpha * sinAlpha);

        const halfFovTan = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
        const aspect = camera.aspect;

        // Scale by depth/distance so an off-axis hole is not reported larger
        // than it draws.
        return (tanAlpha * (depth / distance)) / (2 * halfFovTan * aspect);
    }

    /** @param {THREE.Vector3} target */
    getWorldPosition(target) {
        return this.mesh.getWorldPosition(target);
    }

    /**
     * Change the horizon size at runtime, keeping getScreenRadius honest.
     * Scaling the group also works and is picked up correctly, but this is
     * the clearer thing to reach for.
     */
    setRadius(radius) {
        this.radius = radius;
        this.mesh.geometry.dispose();
        this.mesh.geometry = new THREE.SphereGeometry(radius, this.segments, this.segments);
    }

    dispose() {
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();
        this.group.remove(this.mesh);
    }
}