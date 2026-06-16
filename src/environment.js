/**
 * environment.js
 *
 * HDRI: kloofendal_43d_clear_1k.hdr
 * Source: https://polyhaven.com/a/kloofendal_43d_clear
 * License: CC0 (Public Domain) — Poly Haven
 *
 * Loads the HDR image, prefilters it into a PMREMGenerator cube map,
 * and returns an envMap ready to assign to scene.environment / scene.background.
 * The caller decides how to use it — this module does not touch the scene.
 */

import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';

const HDR_URL = '/env/kloofendal_43d_clear_1k.hdr';

/**
 * Load and prefilter the project HDRI for use as an environment map.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @returns {Promise<{ envMap: THREE.Texture, dispose: () => void }>}
 */
export async function loadEnvironment(renderer) {
  const loader = new RGBELoader();

  const hdrTexture = await loader.loadAsync(HDR_URL).catch((err) => {
    throw new Error(`loadEnvironment: failed to load "${HDR_URL}" — ${err.message ?? err}`);
  });

  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  const envMap = pmremGenerator.fromEquirectangular(hdrTexture).texture;

  pmremGenerator.dispose();
  hdrTexture.dispose();

  return {
    envMap,
    dispose() {
      envMap.dispose();
    },
  };
}
