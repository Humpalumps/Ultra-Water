import * as THREE from 'three';
import { WATER_GLSL, SWASH_GLSL } from './OceanSurface.js';

// Breaker spray, fully stateless: each instance is an emitter in the surf zone. The
// vertex shader evaluates the same shore-wave train the surface uses; when a breaking
// crest passes the emitter it throws a puff forward and up (ballistic with drag), so
// spray curtains follow the actual crest lines with no CPU work or simulation state.
const VERT_COMMON = /* glsl */`
precision highp float;
${WATER_GLSL}
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform samplerCube uSkyCube;
uniform float uSkyMaxLod;
uniform vec3 uSpray;        // amount, size, max distance
uniform vec2 uResolution;
out vec2 vUv;
out float vCov;
out float vAlpha;
out vec3 vLight;
out float vSeed;
out float vViewZ;

// camera-facing quad of the given size at p; droplets: strong forward scattering of the
// sun + sky ambient
void billboard(vec3 p, float size) {
  // at least a pixel and a half across: a smaller droplet only flickers on and off as it
  // crosses pixel centres, so it's drawn larger and fainter instead
  float px = size * projectionMatrix[1][1] * uResolution.y * 0.5 / max(-(viewMatrix * vec4(p, 1.0)).z, 1e-3);
  vCov = min(px * px / 2.25, 1.0);
  size *= max(1.5 / px, 1.0);
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec4 view = viewMatrix * vec4(p + (right * position.x + up * position.y) * size, 1.0);
  gl_Position = projectionMatrix * view;
  vViewZ = -view.z;
  vUv = position.xy;
  float mu = dot(normalize(p - cameraPosition), uSunDir);
  const float g = 0.6;
  float phase = (1.0 - g * g) / (4.0 * PI * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
  vec3 sky = textureLod(uSkyCube, vec3(0.0, 1.0, 0.0), uSkyMaxLod).rgb;
  vLight = 0.9 * (uSunColor * (0.25 + 1.6 * phase) + sky * 1.1);
}
`;

const VERT = VERT_COMMON + /* glsl */`
in vec4 aEmit;              // emitter xz, two randoms

void main() {
  vAlpha = 0.0;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // dead instances fall outside the clip volume
  vec2 e = aEmit.xy;
  float r1 = aEmit.z, r2 = aEmit.w;
  vec2 toE = e - cameraPosition.xz;
  if (dot(toE, toE) > uSpray.z * uSpray.z) return;

  Shore s = shoreWaves(e, shoreSample(e), 0.0);
  float a = s.wave0.x, k = s.wave0.y, w = s.wave0.z;
  // only real breakers throw spray; the small spills over bars and in the lagoon would
  // dot every crest with blobs
  float strength = s.breaking0 * smoothstep(0.25, 0.55, a);
  if (strength <= 0.01) return;
  // seconds since the crest passed this emitter, staggered per particle
  float psi = mod(s.wave0.w + PI, 2.0 * PI) - PI;
  float age = psi / w - r1 * 0.3;
  float life = 0.9 + 1.5 * r2;
  if (age < 0.0 || age > life) return;

  // thrown with the crest (towards the beach) and up, slowed by air drag
  const float KD = 1.7, G = 9.81;
  float ex = (1.0 - exp(-KD * age)) / KD;
  float c = w / k;
  vec2 side = vec2(-s.dir.y, s.dir.x) * (fract(r1 * 31.7) - 0.5) * 1.6;
  vec2 xz = e + side + s.dir * c * (0.25 + 0.45 * fract(r2 * 17.3)) * ex;
  float vy = (1.2 + 3.2 * fract(r1 * 7.9)) * sqrt(a);
  float y = 1.1 * a + (vy + G / KD) * ex - G * age / KD;
  if (y < -0.3) return;

  float size = (0.05 + 0.35 * age) * (0.6 + 0.8 * fract(r2 * 5.3)) * uSpray.y * sqrt(a / 0.5);
  billboard(vec3(xz.x, y, xz.y), size);
  vSeed = r1;
  vAlpha = strength * uSpray.x * smoothstep(0.0, 0.12, age) * pow(1.0 - age / life, 1.5)
         * smoothstep(-0.3, 0.2, y) * smoothstep(uSpray.z, uSpray.z * 0.7, sqrt(dot(toE, toE)))
         * smoothstep(2.5, 10.0, vViewZ);   // no giant blobs on the lens
}`;

// Splash crowns where props hit the water: each instance belongs to one impact slot
// (WATER_GLSL's uImpact) and is thrown up and out from the rim, ballistic with drag.
const SPLASH_PER_IMPACT = 160;
const SPLASH_VERT = VERT_COMMON + /* glsl */`
void main() {
  vAlpha = 0.0;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vec4 e = uImpact[gl_InstanceID % 8];
  float L = uImpactSize[gl_InstanceID % 8];
  float r1 = hash12(vec2(float(gl_InstanceID), 1.7)), r2 = hash12(vec2(float(gl_InstanceID), 8.3));
  float r3 = hash12(vec2(float(gl_InstanceID), 4.1));
  float life = 0.5 + 1.1 * r2;
  float age = e.z;
  if (e.w <= 0.0 || age > life) return;
  const float KD = 1.2, G = 9.81;
  float ex = (1.0 - exp(-KD * age)) / KD;
  float ang = r1 * 2.0 * PI;
  vec2 out_ = vec2(cos(ang), sin(ang));
  float strength = sqrt(e.w / 0.2);
  float vy = (1.5 + 4.0 * r3 * r3) * strength;
  vec2 xz = e.xy + out_ * (L * (0.6 + 0.5 * r2) + (0.5 + 2.0 * r3) * strength * ex);
  float y = (vy + G / KD) * ex - G * age / KD;
  if (y < -0.2) return;
  billboard(vec3(xz.x, y, xz.y), (0.05 + 0.25 * age) * (0.5 + r2) * uSpray.y);
  vSeed = r1;
  vAlpha = uSpray.x * 0.6 * smoothstep(0.0, 0.05, age) * pow(1.0 - age / life, 1.5)
         * smoothstep(-0.2, 0.1, y) * smoothstep(1.0, 4.0, vViewZ);
}`;

// Rocks the waves run into: each instance sits on the seaward side of one rock. When a
// shore wave crest (rocks standing in water) or the swash front (rocks on the beach)
// reaches its foot, it is thrown up the face and back off it, ballistic with drag, so the
// water visibly stops against the rock instead of sliding past it.
const ROCK_SPLASH_PER_ROCK = 128;
const ROCK_VERT = VERT_COMMON + SWASH_GLSL + /* glsl */`
in vec4 aRock;              // centre xz, footprint radius, random

void main() {
  vAlpha = 0.0;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vec2 c = aRock.xy;
  float rr = aRock.z;
  vec2 toE = c - cameraPosition.xz;
  if (dot(toE, toE) > uSpray.z * uSpray.z) return;
  float r1 = aRock.w, r2 = fract(r1 * 57.31 + 0.13), r3 = fract(r1 * 23.17 + 0.71);
  vec4 sh = shoreSample(c);
  vec2 dir = shoreDir(sh, travelSample(c));
  if (dot(dir, dir) < 0.5) return;
  // a point on the seaward half of the footprint, outward normal n
  float ang = (r1 - 0.5) * 2.6;
  vec2 n = -vec2(dir.x * cos(ang) - dir.y * sin(ang), dir.x * sin(ang) + dir.y * cos(ang));
  vec2 e = c + n * rr * 1.08;
  float hb = shoreSample(e).x;
  float age, strength, y0, reach;
  if (hb > -0.3) {
    // on the beach: the swash front reaching the foot of the rock, harder the further
    // below its run-up height the foot is
    Swash S = swashAt(e);
    float Rf = S.R * 2.1;
    float h = max(hb, 0.0);
    if (Rf < 0.05 || h > Rf * 0.9) return;
    float sArr = 0.3 * asin(h / Rf) / 1.5708;
    age = (S.s - sArr) * 6.2831853 / S.w - r2 * 0.25;
    strength = smoothstep(0.05, 0.3, S.R) * sqrt(1.0 - h / Rf);
    y0 = h + 0.05;
    reach = 0.6;
  } else {
    // in the surf: the crest slamming into it, harder where it breaks
    Shore sw = shoreWaves(e, sh, 0.0);
    float a = sw.wave0.x;
    age = (mod(sw.wave0.w + PI, 2.0 * PI) - PI) / sw.wave0.z - r2 * 0.25;
    strength = smoothstep(0.04, 0.3, a) * (0.6 + 0.4 * sw.breaking0);
    y0 = 1.2 * a;
    reach = 1.5 + 4.0 * sqrt(a);
  }
  float life = 0.5 + 0.9 * r3;
  if (strength <= 0.01 || age < 0.0 || age > life) return;
  const float KD = 1.6, G = 9.81;
  float ex = (1.0 - exp(-KD * age)) / KD;
  // up the face, then falling back off it seawards and to the sides
  float vy = (2.0 + 4.0 * r3 * r3) * reach * strength;
  vec2 vh = n * (0.15 + 0.5 * r2) * reach + dir * 0.3;
  vec2 xz = e + vh * ex;
  float y = y0 + (vy + G / KD) * ex - G * age / KD;
  if (y < y0 - 0.3) return;
  billboard(vec3(xz.x, y, xz.y), (0.04 + 0.3 * age) * (0.5 + r2) * uSpray.y * mix(0.6, 1.0, reach / 3.0));
  vSeed = r1;
  vAlpha = uSpray.x * 2.0 * strength * smoothstep(0.0, 0.06, age) * pow(1.0 - age / life, 1.5)
         * smoothstep(uSpray.z, uSpray.z * 0.7, sqrt(dot(toE, toE))) * smoothstep(1.0, 4.0, vViewZ);
}`;

const FRAG = /* glsl */`
precision highp float;
uniform sampler2D uSceneDepth;
uniform sampler2D uFoamTex;
uniform vec2 uResolution;
uniform vec2 uNearFar;
in vec2 vUv;
in float vAlpha;
in vec3 vLight;
in float vSeed;
in float vViewZ;
in float vCov;
out vec4 fragColor;

void main() {
  float r = length(vUv);
  if (vAlpha <= 0.0 || r > 1.0) discard;
  // a cloud of droplets, not a smooth gaussian: whole soft puffs read as cotton balls
  float n = texture(uFoamTex, vUv * 0.08 + vSeed * 17.0).r;
  float drops = smoothstep(0.35, 0.7, texture(uFoamTex, vUv * 0.3 + vSeed * 7.0).r);
  float a = vAlpha * vCov * exp(-3.5 * r * r) * (0.5 + n) * drops * 1.6;
  // soft against the opaque scene (the water surface itself is handled by the depth test)
  float d = texelFetch(uSceneDepth, ivec2(gl_FragCoord.xy), 0).r * 2.0 - 1.0;
  float sceneZ = 2.0 * uNearFar.x * uNearFar.y / (uNearFar.y + uNearFar.x - d * (uNearFar.y - uNearFar.x));
  a *= clamp((sceneZ - vViewZ) / 0.8, 0.0, 1.0);
  fragColor = vec4(vLight * a, a);
}`;

function sampleEmitters(shore, count) {
  const { data, size, extent } = shore, out = new Float32Array(count * 4);
  let seed = 11, n = 0;
  const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let tries = 0; n < count && tries < count * 400; tries++) {
    const i = Math.floor(rand() * size), j = Math.floor(rand() * size), k = (j * size + i) * 4;
    const depth = -data[k], sdf = data[k + 1];
    if (depth < 0.3 || depth > 3.2 || sdf > 150) continue;   // where shore waves break
    out.set([((i + rand()) / size - 0.5) * extent, ((j + rand()) / size - 0.5) * extent, rand(), rand()], n * 4);
    n++;
  }
  return { data: out.subarray(0, n * 4), count: n };
}

function quads(count) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.instanceCount = count;
  return geo;
}

export class Spray {
  constructor(surface, shore, rocks = [], count = 150000) {
    const em = sampleEmitters(shore, count);
    const geo = quads(em.count);
    geo.setAttribute('aEmit', new THREE.InstancedBufferAttribute(em.data, 4));
    this.params = { amount: 1, size: 1, distance: 350 };
    this.uniforms = { ...surface.uniforms, uSpray: { value: new THREE.Vector3() } };
    const material = (vertexShader) => new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader, fragmentShader: FRAG, uniforms: this.uniforms,
      transparent: true, depthWrite: false,
      // premultiplied over; alpha untouched (it carries the water-facing tag)
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    this.mesh = new THREE.Mesh(geo, material(VERT));
    this.mesh.frustumCulled = false;
    this.splash = new THREE.Mesh(quads(8 * SPLASH_PER_IMPACT), material(SPLASH_VERT));
    this.splash.frustumCulled = false;
    const rockGeo = quads(rocks.length * ROCK_SPLASH_PER_ROCK);
    const aRock = new Float32Array(rocks.length * ROCK_SPLASH_PER_ROCK * 4);
    let seed = 5;
    const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    rocks.forEach((r, i) => {
      for (let k = 0; k < ROCK_SPLASH_PER_ROCK; k++) aRock.set([r.x, r.z, r.r, rand()], (i * ROCK_SPLASH_PER_ROCK + k) * 4);
    });
    rockGeo.setAttribute('aRock', new THREE.InstancedBufferAttribute(aRock, 4));
    this.rockSplash = new THREE.Mesh(rockGeo, material(ROCK_VERT));
    this.rockSplash.frustumCulled = false;
  }

  update() {
    const p = this.params;
    this.uniforms.uSpray.value.set(p.amount, p.size, p.distance);
    this.mesh.visible = this.splash.visible = this.rockSplash.visible = p.amount > 0;
  }
}
