import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildTerrain } from './terrainGeometry.js';
import { islandHeight } from './islandHeight.js';
import { fbm } from './noise.js';
import { CAUSTICS_GLSL } from '../water/Caustics.js';
import { FLOAT_SHADOW_GLSL } from './floaterShadow.js';
import { SHORE_GLSL, SWASH_GLSL } from '../water/OceanSurface.js';

// Island + shore rocks on MeshStandardMaterial, patched with: biome colouring,
// wet sand sheen, refracted + absorbed sunlight under water, wave-driven caustics and
// the floater shadow map.
const VERT_PARS = /* glsl */`
varying vec3 vWPos;
varying vec3 vWNrm;
`;

const FRAG_PARS = /* glsl */`
varying vec3 vWPos;
varying vec3 vWNrm;
uniform samplerCube uSkyCube;
uniform vec3 uAbsorption;
uniform vec3 uSunDirT;
uniform float uCausticStrength;
uniform float uFogDensity;
${CAUSTICS_GLSL}
${FLOAT_SHADOW_GLSL}
${SHORE_GLSL}
#define SWASH_ROCKS
uniform sampler2D uRockIdx;
uniform sampler2D uRockData;
${SWASH_GLSL}
float th(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float tn(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(th(i), th(i + vec2(1, 0)), u.x), mix(th(i + vec2(0, 1)), th(i + 1.0), u.x), u.y); }
// ripple marks: the phase along d (wavenumber w) is warped by noise of scale s and
// amplitude a (metres along d), so crests meander and fork where the warp gets steep
float ripplePhase(vec2 p, vec2 d, float w, float s, float a) {
  return w * (dot(p, d) + (tn(p * s) - 0.5) * a + (tn(p * s * 0.27 + 4.0) - 0.5) * a * 3.0);
}
// slope of h = amp (sin ph - 0.25 cos 2ph): sharp crests, broad troughs
vec2 rippleSlope(vec2 p, vec2 d, float w, float s, float a, float amp) {
  float ph = ripplePhase(p, d, w, s, a);
  vec2 grad = (vec2(ripplePhase(p + vec2(0.01, 0.0), d, w, s, a), ripplePhase(p + vec2(0.0, 0.01), d, w, s, a)) - ph) / 0.01;
  return grad * amp * (cos(ph) + 0.5 * sin(2.0 * ph));
}
uniform mat4 uSunShadowMatrix;
#ifdef ROCK
// 3D value noise: the rock faces are steep, a 2D world-xz pattern would streak down them
float th3(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float tn3(vec3 p) { vec3 i = floor(p), f = fract(p); vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(th3(i), th3(i + vec3(1, 0, 0)), u.x), mix(th3(i + vec3(0, 1, 0)), th3(i + vec3(1, 1, 0)), u.x), u.y),
             mix(mix(th3(i + vec3(0, 0, 1)), th3(i + vec3(1, 0, 1)), u.x), mix(th3(i + vec3(0, 1, 1)), th3(i + 1.0), u.x), u.y), u.z); }
#endif
`;

const ALBEDO = /* glsl */`
  float hgt = vWPos.y;
  float flat_ = clamp(vWNrm.y, 0.0, 1.0);
  float n1 = tn(vWPos.xz * 0.08), n2 = tn(vWPos.xz * 0.6), n3 = tn(vWPos.xz * 0.013);
  vec3 sand = mix(vec3(0.80, 0.71, 0.53), vec3(0.72, 0.62, 0.45), n1) * (0.92 + 0.16 * n2);
  vec3 seabed = mix(vec3(0.78, 0.72, 0.56), vec3(0.62, 0.58, 0.44), n1 * n3);
  vec3 grass = mix(vec3(0.20, 0.30, 0.10), vec3(0.33, 0.37, 0.15), n1) * (0.85 + 0.3 * n2);
  vec3 rock = mix(vec3(0.33, 0.31, 0.29), vec3(0.45, 0.41, 0.36), n2) * (0.8 + 0.4 * n3);
#ifdef ROCK
  // banded stone (cavities come from the vertex colour), a dark weed-and-barnacle band
  // through the tidal range and salt-bleached patches on the dry tops
  float r1 = tn3(vWPos * 0.9), r2 = tn3(vWPos * 3.7 + 7.0);
  float strata = sin(vWPos.y * 2.2 + r1 * 3.0) * 0.5 + 0.5;
  vec3 albedo = mix(vec3(0.27, 0.25, 0.23), vec3(0.52, 0.47, 0.41), r1 * 0.6 + strata * 0.25 + r2 * 0.15);
  float tide = (1.0 - smoothstep(0.4, 1.3 + 0.6 * r1, hgt)) * smoothstep(-3.0, -0.8, hgt);
  albedo = mix(albedo, vec3(0.10, 0.11, 0.07) * (0.7 + 0.6 * r2), tide * 0.8);
  albedo = mix(albedo, vec3(0.80, 0.78, 0.72), smoothstep(0.7, 0.92, flat_) * smoothstep(1.0, 2.0, hgt) * smoothstep(0.55, 0.8, r2) * 0.55);
#else
  float sandLine = 2.4 + 1.6 * n3 + 0.8 * n1;
  vec3 albedo = mix(seabed, sand, smoothstep(-0.05, 0.05, hgt));
  albedo = mix(albedo, grass, smoothstep(sandLine, sandLine + 1.5, hgt) * smoothstep(0.62, 0.8, flat_));
  albedo = mix(albedo, rock, smoothstep(0.78, 0.62, flat_) * smoothstep(-6.0, 1.0, hgt));
  albedo = mix(albedo, rock * 1.1, smoothstep(38.0, 52.0, hgt + n1 * 8.0));
#endif
  // wet band above the waterline, plus where the swash has run (dries over seconds)
  vec3 sw = swash(vWPos.xz, hgt);
  float wet = max(1.0 - smoothstep(0.35, 1.3 + 0.5 * n1, hgt), sw.z);
  // water filling the pores darkens sand and deepens its colour (light bounces more
  // times inside the grains before it escapes, so each tint compounds): roughly the
  // albedo squared, not a flat grey multiply, which reads as cold concrete. Below the
  // waterline the bed keeps a flatter darkening, or a metre of water turns it olive.
  albedo *= mix(vec3(1.0), mix(0.8 * albedo + 0.06, vec3(0.6), smoothstep(0.0, -0.8, hgt)), wet);
  // the swash film itself: wet-shiny from the first mm (rippled, so a soft sheen rather
  // than a sky mirror) and only faintly tinted, since a few cm of water absorb almost
  // nothing; the sea's colour comes from depth, not the film
  float film = smoothstep(0.0, 0.004, sw.x) * smoothstep(-0.05, 0.05, hgt);
  albedo *= mix(vec3(1.0), vec3(0.9, 0.97, 0.97), smoothstep(0.0, 0.06, sw.x) * film);
  // bubbles: lace on the running-up edge, broken remnants carried down in the backwash.
  // The less foam is left, the higher the threshold, so it breaks into ever smaller
  // islands as it pops rather than fading as a uniform veil
  float fwP = max(fwidth(vWPos.x), fwidth(vWPos.z));
  if (sw.y > 0.0) {
    float lace = smoothstep(0.75 - 0.4 * sw.y, 0.92 - 0.3 * sw.y, tn(vWPos.xz * 3.1 + uTime * 0.15) * 0.6 + tn(vWPos.xz * 7.3) * 0.4);
    // the lace cells shrink below a pixel far off: their average there, not a shimmer
    lace = mix(lace, 0.3, smoothstep(0.05, 0.3, fwP));
    // a few cm of bubbles over wet sand: pale and sand-tinted, never paper white
    albedo = mix(albedo, albedo * 0.4 + vec3(0.42, 0.41, 0.38), min(sw.y * 1.4, 1.0) * lace * 0.7);
  }
  diffuseColor.rgb = albedo;
`;

// sand ripples + grain bump in world space, faded out before they alias
const RIPPLES = /* glsl */`
#ifndef ROCK
  {
    vec2 fw = fwidth(vWPos.xz);
    float px = max(fw.x, fw.y);
    if (px < 0.5) {   // both ripple bands are faded out beyond this
    float sandMask = (1.0 - smoothstep(sandLine - 0.5, sandLine + 0.5, hgt)) * smoothstep(0.85, 0.95, flat_);
    sandMask *= mix(1.0, 0.25, smoothstep(-0.3, 0.6, hgt)); // dry sand: faint wind ripples only
    // long wave-formed ripples (~1.6 m) and short ones (~0.3 m), each fading in and out
    // in patches
    vec2 p = vWPos.xz;
    vec2 d1 = normalize(vec2(0.8, 0.6) + (vec2(tn(p * 0.02), tn(p * 0.02 + 5.0)) - 0.5));
    float a1 = 0.02 * (0.3 + 0.7 * smoothstep(0.25, 0.75, tn(p * 0.06 + 11.0)));
    vec2 g = rippleSlope(p, d1, 3.9, 0.35, 0.8, a1) * (1.0 - smoothstep(0.15, 0.5, px));
    if (px < 0.09) {
      float a2 = 0.002 * (0.3 + 0.7 * smoothstep(0.25, 0.75, tn(p * 0.15 + 3.0)));
      g += rippleSlope(p, normalize(d1 + vec2(-d1.y, d1.x) * 0.3), 21.0, 2.2, 0.1, a2) * (1.0 - smoothstep(0.03, 0.09, px));
    }
    vec3 nW = normalize(vWNrm - vec3(g.x, 0.0, g.y) * sandMask);
    normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
    }
  }
#else
  {
    // crags and grain: a bump from the 3D noise through screen derivatives (no texture),
    // the fine octave faded out before it aliases
    float px = length(fwidth(vWPos));
    float bh = tn3(vWPos * 1.6) * 0.6 + r2 * 0.25 + tn3(vWPos * 9.0) * 0.15 * (1.0 - smoothstep(0.03, 0.12, px));
    vec3 dpx = dFdx(vWPos), dpy = dFdy(vWPos);
    vec3 R1 = cross(dpy, vWNrm), R2 = cross(vWNrm, dpx);
    float det = dot(dpx, R1);
    vec3 grad = sign(det) * (dFdx(bh) * R1 + dFdy(bh) * R2);
    vec3 nW = normalize(abs(det) * vWNrm - grad * 0.3);
    normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
  }
#endif
`;

const UNDERWATER = /* glsl */`
  float wdepth = max(-vWPos.y, 0.0);
  // sun and sky light reaching the bed through the water column (the sun along its
  // refracted path)
  vec3 rsun = refract(-uSunDirT, vec3(0.0, 1.0, 0.0), 1.0 / 1.33);
  float sunPath = wdepth / max(-rsun.y, 0.1);
  diffuseColor.rgb *= exp(-uAbsorption * (sunPath * 0.6 + wdepth * 0.4));
`;

// Direct sun (spliced into three's light loop, one directional light): floater shadows
// everywhere; below the surface the light arrives refracted (much steeper than the
// grazing sun outside), dimmed by the Fresnel transmission, and both shadow maps are
// read where it came through the surface, so the bed isn't shadowed along the
// unrefracted ray by every sand bar up-sun.
const SUN = /* glsl */`
    getDirectionalLightInfo( directionalLight, directLight );
    float under = smoothstep(0.05, -0.25, vWPos.y);
    vec3 shadowAt = vWPos + vWNrm * 0.04;
    bool viaSurface = false;
    if (under > 0.0) {
      vec3 rsun = refract(-uSunDirT, vec3(0.0, 1.0, 0.0), 1.0 / 1.33);
      viaSurface = rsun.y < -0.05 && under > 0.5;
      if (viaSurface) shadowAt = vec3(vWPos.x - rsun.x / rsun.y * vWPos.y, 0.05, vWPos.z - rsun.z / rsun.y * vWPos.y);
      directLight.direction = normalize(mix(directLight.direction, (viewMatrix * vec4(-rsun, 0.0)).xyz, under));
      float Ft = 0.02 + 0.98 * pow(1.0 - max(uSunDirT.y, 0.0), 5.0);
      directLight.color *= 1.0 - Ft * under;
    }
    directLight.color *= floatShadow(shadowAt);
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    vec4 sunShadowCoord = viaSurface ? uSunShadowMatrix * vec4(shadowAt, 1.0) : vDirectionalShadowCoord[ 0 ];
#endif
`;
const LIGHTS_BEGIN = THREE.ShaderChunk.lights_fragment_begin
  .replace('getDirectionalLightInfo( directionalLight, directLight );', SUN)
  .replace('vDirectionalShadowCoord[ i ]', 'sunShadowCoord');

const ROUGH = /* glsl */`
  roughnessFactor = mix(mix(roughnessFactor, 0.32, wet * smoothstep(-0.05, 0.05, hgt)), 0.2, film);
`;

// caustics focused by the actual waves (Caustics.js); mean 1, so they only redistribute
// the direct sun
const CAUSTICS = /* glsl */`
  if (wdepth > 0.0 && rsun.y < -0.05) {
    vec2 entry = vWPos.xz + rsun.xz / rsun.y * wdepth;   // where this light entered the surface
    vec2 fwc = fwidth(entry);
    float c = waveCaustic(entry, wdepth, log2(max(max(fwc.x, fwc.y) * CAUSTIC_TEXELS_PER_M, 1.0)));
    // a little more contrast in the first metre or two, where the net is sharpest; faded
    // in over the top few cm so the waterline doesn't get a hard caustic seam
    float cs = uCausticStrength * mix(1.35, 1.0, smoothstep(1.5, 3.0, wdepth)) * smoothstep(0.0, 0.3, wdepth);
    reflectedLight.directDiffuse *= max(mix(1.0, c, cs), 0.0);
  }
`;

const FOG = /* glsl */`
  vec3 fdir = normalize(vWPos - cameraPosition);
  float fogAmt = 1.0 - exp(-length(vWPos - cameraPosition) * uFogDensity);
  outgoingLight = mix(outgoingLight, textureLod(uSkyCube, vec3(fdir.x, max(fdir.y, 0.0), fdir.z), 3.0).rgb, fogAmt);
`;

// mode: 'terrain' | 'rock' | 'prop' (props keep their own colours, just get the
// underwater light falloff, caustics and fog)
function patch(material, uniforms, mode) {
  const ground = mode !== 'prop';
  if (mode === 'rock') material.defines = { ...material.defines, ROCK: '' };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <project_vertex>', `#include <project_vertex>
  vec4 wp = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  wp = instanceMatrix * wp;
#endif
  vWPos = (modelMatrix * wp).xyz;
  vec3 wn = objectNormal;
#ifdef USE_INSTANCING
  wn = mat3(instanceMatrix) * wn;
#endif
  vWNrm = normalize(mat3(modelMatrix) * wn);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + (ground ? ALBEDO : '') + UNDERWATER)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + (ground ? ROUGH : ''))
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + (ground ? RIPPLES : ''))
      .replace('#include <lights_fragment_begin>', LIGHTS_BEGIN)
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + CAUSTICS)
      .replace('#include <opaque_fragment>', FOG + '#include <opaque_fragment>');
  };
  material.customProgramCacheKey = () => 'gelatin-' + mode;
}

function rockGeometry() {
  let g = new THREE.IcosahedronGeometry(1, 4);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const p = g.attributes.position, v = new THREE.Vector3();
  const ao = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = fbm(v.x * 1.4 + 3, v.z * 1.4 + v.y * 0.7, 5, 21);
    const facet = Math.abs(fbm(v.x * 3.1, v.y * 3.1 + v.z, 3, 5));
    // ridged cracks cut into the surface
    const crack = Math.abs(fbm(v.x * 5.7 + v.z * 1.9, v.y * 5.7 - v.z * 1.3, 2, 9));
    const d = 1 + 0.38 * n - 0.12 * facet - 0.06 * Math.max(0.12 - crack, 0) / 0.12;
    v.multiplyScalar(d);
    // a hint of bedding: the height steps a little, like layered rock
    v.y -= 0.7 * Math.sin(v.y * 8 * Math.PI) / (8 * Math.PI);
    if (v.y < -0.2) v.y = -0.2 + (v.y + 0.2) * 0.4;   // flattish base
    p.setXYZ(i, v.x, v.y, v.z);
    // cavity occlusion baked into the vertex colour: hollows and cracks darker
    const c = Math.min(Math.max(0.78 + 0.9 * (d - 1), 0.42), 1) * (0.65 + 0.35 * Math.min(crack / 0.12, 1));
    ao[i * 3] = ao[i * 3 + 1] = ao[i * 3 + 2] = c;
  }
  g.setAttribute('color', new THREE.BufferAttribute(ao, 3));
  g.computeVertexNormals();
  return g;
}

// one big rock out in the surf on the swell-exposed coast (the default swell comes from
// bearing -15 deg), in ~2.5 m of water so the swash wraps round it; the 'Surf rock'
// camera looks at it
export const heroRock = (() => {
  const a = THREE.MathUtils.degToRad(-15);
  let r = 100;
  while (r < 900 && islandHeight(Math.cos(a) * r, Math.sin(a) * r) > -2.5) r += 1;
  return { x: Math.cos(a) * r, z: Math.sin(a) * r };
})();

function placeRocks(count, rand) {
  const out = [];
  for (let i = 0; i < count * 6 && out.length < count; i++) {
    const a = rand() * Math.PI * 2;
    // walk outwards to the coast along this bearing, then jitter around it
    let r = 150;
    while (r < 700 && islandHeight(Math.cos(a) * r, Math.sin(a) * r) > 0) r += 4;
    r += (rand() - 0.6) * 40;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = islandHeight(x, z);
    if (h < -5 || h > 6) continue;
    const s = 1.5 + Math.pow(rand(), 2.2) * 9;
    out.push({ x, z, y: h - s * 0.15, s });
    // small satellites
    for (let k = 0; k < 3 && out.length < count; k++) {
      const ox = x + (rand() - 0.5) * s * 4, oz = z + (rand() - 0.5) * s * 4;
      const ss = s * (0.25 + rand() * 0.35);
      out.push({ x: ox, z: oz, y: islandHeight(ox, oz) - ss * 0.2, s: ss });
    }
  }
  return out;
}

// Per shore-map texel the two rocks whose influence reaches it (index into uRockData,
// -1 = none), ranked by distance in radii; uRockData holds centre xz and radius
function rockMaps(rocks, extent, size = 512) {
  const data = new Float32Array(rocks.length * 4);
  rocks.forEach((r, i) => data.set([r.x, r.z, r.r, 0], i * 4));
  const idx = new Float32Array(size * size * 2).fill(-1);
  const texel = extent / size;
  rocks.forEach((r, i) => {
    const reach = 4.5 * r.r + 2 + texel;
    const i0 = Math.max(0, Math.floor((r.x - reach) / texel + size / 2)), i1 = Math.min(size - 1, Math.ceil((r.x + reach) / texel + size / 2));
    const j0 = Math.max(0, Math.floor((r.z - reach) / texel + size / 2)), j1 = Math.min(size - 1, Math.ceil((r.z + reach) / texel + size / 2));
    for (let j = j0; j <= j1; j++) for (let ii = i0; ii <= i1; ii++) {
      const x = (ii + 0.5 - size / 2) * texel, z = (j + 0.5 - size / 2) * texel;
      const d = Math.hypot(x - r.x, z - r.z);
      if (d > reach) continue;
      const k = (j * size + ii) * 2, q = d / r.r;
      const rank = (m) => (idx[k + m] < 0 ? Infinity : Math.hypot(x - rocks[idx[k + m]].x, z - rocks[idx[k + m]].z) / rocks[idx[k + m]].r);
      if (q < rank(0)) { idx[k + 1] = idx[k]; idx[k] = i; } else if (q < rank(1)) idx[k + 1] = i;
    }
  });
  const tex = (arr, w, h, fmt) => {
    const t = new THREE.DataTexture(arr, w, h, fmt, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.needsUpdate = true;
    return t;
  };
  return {
    uRockIdx: { value: tex(idx, size, size, THREE.RGFormat) },
    uRockData: { value: tex(data, Math.max(rocks.length, 1), 1, THREE.RGBAFormat) },
  };
}

export function createTerrain({ sky, caustics, floatShadow, water, absorption, reflectionLayer = 1 }) {
  const uniforms = {
    ...floatShadow,
    // shore maps + wave settings for the swash (same objects as the water's)
    ...Object.fromEntries(['uShore', 'uTravel', 'uSurf', 'uShoreExtent', 'uTime', 'uShoreWave', 'uSwellDir'].map((k) => [k, water[k]])),
    ...caustics,
    uSkyCube: { value: sky.cube },
    uAbsorption: { value: absorption },
    uSunDirT: { value: sky.sunDir },
    uSunShadowMatrix: { value: new THREE.Matrix4() },   // the sun light's shadow.matrix (main.js)
    uCausticStrength: { value: 1.0 },
    uFogDensity: { value: 1 / 18000 },
  };

  const { geometry } = buildTerrain(384);
  const groundMat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, envMapIntensity: 0.9 });
  patch(groundMat, uniforms, 'terrain');
  const ground = new THREE.Mesh(geometry, groundMat);
  ground.castShadow = ground.receiveShadow = true;

  let seed = 7;
  const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const spots = placeRocks(90, rand);
  spots.push({ ...heroRock, y: islandHeight(heroRock.x, heroRock.z) - 1.6, s: 0, hero: true });
  const rockMat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, envMapIntensity: 0.9, vertexColors: true });
  patch(rockMat, uniforms, 'rock');
  const rocks = new THREE.InstancedMesh(rockGeometry(), rockMat, spots.length);
  const m = new THREE.Matrix4(), qt = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3();
  spots.forEach((s, i) => {
    e.set(rand() * 0.6, rand() * Math.PI * 2, rand() * 0.6);
    if (s.hero) sc.set(9, 6, 7.5);
    else sc.set(s.s * (0.8 + rand() * 0.6), s.s * (0.5 + rand() * 0.5), s.s * (0.8 + rand() * 0.6));
    m.compose(new THREE.Vector3(s.x, s.y, s.z), qt.setFromEuler(e), sc);
    rocks.setMatrixAt(i, m);
    // footprint where the (deformed unit sphere) rock meets the sand
    s.r = 0.95 * (sc.x + sc.z) / 2;
  });
  // rocks the waves and swash run into (the surf rock has its own treatment in the water)
  const shoreRocks = spots.filter((s) => !s.hero && islandHeight(s.x, s.z) > -3 && islandHeight(s.x, s.z) < 2.5);
  Object.assign(uniforms, rockMaps(shoreRocks, water.uShoreExtent.value));
  rocks.computeBoundingSphere();
  rocks.castShadow = rocks.receiveShadow = true;

  const group = new THREE.Group();
  group.add(ground, rocks);
  for (const o of [ground, rocks]) o.layers.enable(reflectionLayer);
  return { group, uniforms, shoreRocks, patchProp: (m) => patch(m, uniforms, 'prop') };
}
