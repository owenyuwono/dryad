import * as THREE from 'three';

export function createGround() {
  const geo = new THREE.PlaneGeometry(200, 200);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x4a3e2a,   // earthy dirt/grass brown
    roughness: 0.95,
    metalness: 0.0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow = true;
  mesh.castShadow = false;

  return {
    mesh,
    setBaseY(y) {
      mesh.position.y = y;
    },
    /**
     * setRevealed(revealed)
     *
     * When revealed=true, fades the ground plane to near-transparent so the
     * underground root system is visible.  Uses opacity fade (not mesh.visible=false)
     * so the plane stays in the shadow-receiver pass and cast shadows persist on
     * the ghosted ground surface.
     *
     * @param {boolean} revealed
     */
    setRevealed(revealed) {
      mat.transparent = revealed;
      mat.opacity     = revealed ? 0.15 : 1.0;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
