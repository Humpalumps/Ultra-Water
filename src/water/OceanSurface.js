import * as THREE from 'three';
import { N } from './OceanSim.js';
import { FLOAT_SHADOW_GLSL } from '../scene/floaterShadow.js';

// Camera-centred polar grid. Ring radii grow geometrically so cells stay square and
// screen density stays ~constant. Displacement is band-limited to the local vertex
// spacing (textureLod), which is what kills swimming - no clipmap snapping needed.
const ANGULAR = 384;
const HIGH_CAMERA = 60;  // m: above this a half-density grid is used (waves there are sub-pixel)
const INNER = 1;        // m, scaled by camera height
const OUTER = 3000;     // m, then one flat skirt
const SKIRT = 60000;

function buildGrid(ANGULAR) {
  const q = 1 + (2 * Math.PI) / ANGULAR;
  const radii = [];
  // a few coarser-ratio rings inside INNER so the surface right at the lens isn't one
  // flat fan when the camera sits on the waterline
  for (let r = INNER / 16; r < INNER * 0.99; r *= 1.12) radii.push(r);
  for (let r = INNER; r < OUTER; r *= q) radii.push(r);
  radii.push(SKIRT);
  const verts = new Float32Array((1 + radii.length * ANGULAR) * 3);
  let v = 3; // vertex 0 = centre
  for (const r of radii) {
    for (let a = 0; a < ANGULAR; a++) {
      const t = (a / ANGULAR) * Math.PI * 2;
      verts[v++] = Math.cos(t) * r; verts[v++] = 0; verts[v++] = Math.sin(t) * r;
    }
  }
  const idx = [];
  for (let a = 0; a < ANGULAR; a++) idx.push(0, 1 + ((a + 1) % ANGULAR), 1 + a);
  for (let ring = 0; ring < radii.length - 1; ring++) {
    const i0 = 1 + ring * ANGULAR, i1 = i0 + ANGULAR;
    for (let a = 0; a < ANGULAR; a++) {
      const b = (a + 1) % ANGULAR;
      idx.push(i0 + a, i0 + b, i1 + a, i0 + b, i1 + b, i1 + a);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
  return geo;
}

// Shore maps, noise and the per-place wave phase/sets: shared by the breakers (below)
// and the beach swash in the terrain shader, so the two always agree.
export const SHORE_GLSL = /* glsl */`
uniform sampler2D uShore;
uniform sampler2D uTravel;   // wave travel time from the coast (s), propagation dir xz, shoaling
uniform float uShoreExtent;
uniform float uTime;
uniform vec4 uShoreWave;   // amplitude, wavelength, speed, steepness
uniform vec2 uSwellDir;    // propagation direction of the swell (xz)

vec4 shoreSample(vec2 xz) {
  vec2 uv = xz / uShoreExtent + 0.5;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec4(-60.0, 1e4, 0.0, 0.0);
  return textureLod(uShore, uv, 0.0);
}
// Shelter depth S (m): shallowest bar/reef the breakers crossed to get here. The water
// fragment shader is at the 16 sampler limit, so it reads S from a vertex varying.
#ifdef SURF_VARYING
in float vSurf;
float surfSample(vec2 xz) { return vSurf; }
#else
uniform sampler2D uSurf;
float surfSample(vec2 xz) {
  vec2 uv = xz / uShoreExtent + 0.5;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 6.0;
  return textureLod(uSurf, uv, 0.0).r;
}
#endif
vec4 travelSample(vec2 xz) {
  vec2 uv = xz / uShoreExtent + 0.5;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec4(0.0);
  return textureLod(uTravel, uv, 0.0);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + 1.0), u.x), u.y);
}

// phase offset along the coast, the slowly drifting sets, and how much of the swell a
// coast facing dir receives
float shoreNoisePhase(vec2 xz) { return vnoise(xz * 0.0042) * 9.0 + vnoise(xz * 0.011 + 7.0) * 2.5; }
float shoreGroup(vec2 xz) { return 0.45 + 0.55 * vnoise(xz * 0.004 + vec2(uTime * 0.021, -uTime * 0.017)); }
float shoreExposure(vec2 dir) { return mix(0.25, 1.0, smoothstep(-0.3, 0.7, dot(dir, uSwellDir))); }
vec2 shoreDir(vec4 sh, vec4 tr) { return dot(tr.yz, tr.yz) > 0.25 ? normalize(tr.yz) : -sh.zw / max(length(sh.zw), 1e-3); }
`;

// Swash on the beach (terrain shader): every bore reaching the waterline runs up the sand
// to a height R and drains back. swashAt() is the timing alone (shared with the rock
// splashes in Spray.js); swash() returns (film thickness m, edge foam 0..1, wetness 0..1).
// With SWASH_ROCKS defined (uRockIdx/uRockData declared first) the shore rocks shelter a
// dry wedge in their lee, make the run-up surge up their seaward faces and churn foam
// against them.
export const SWASH_GLSL = /* glsl */`
// R: run-up height (m, 0 = none), s: fraction of a period since the bore reached the
// waterline, w: angular frequency, dir: travel direction (xz)
struct Swash { float R; float s; float w; vec2 dir; };
Swash swashAt(vec2 xz) {
  Swash o = Swash(0.0, 0.0, 1.0, vec2(0.0));
  vec4 sh = shoreSample(xz);
  if (sh.y > 60.0 || uShoreWave.x <= 0.0) return o;
  o.dir = shoreDir(sh, travelSample(xz));
  // run-up of what's left of the breakers: lagoon and lee beaches only lap
  float A = min(uShoreWave.x * shoreExposure(o.dir) * shoreGroup(xz), 0.42 * surfSample(xz) + 0.02);
  o.R = 0.55 * A * smoothstep(0.35, 0.8, length(sh.zw));
  o.w = sqrt(9.81 * 6.2831853 / uShoreWave.y) * uShoreWave.z;
  o.s = fract((o.w * uTime + shoreNoisePhase(xz)) / 6.2831853);
  return o;
}
#ifdef SWASH_ROCKS
// rock k's hold on the swash at xz: x = shelter in its lee, y = closeness to its seaward face
vec2 rockSwash(vec2 xz, vec2 dir, float k) {
  if (k < 0.0) return vec2(0.0);
  vec4 rk = texelFetch(uRockData, ivec2(int(k), 0), 0);
  vec2 d = xz - rk.xy;
  float r = rk.z, l = length(d);
  float along = dot(d, dir), across = abs(dir.x * d.y - dir.y * d.x);
  // the fronts bend round both sides and close in again a few radii behind it
  float lee = smoothstep(r, 0.45 * r, across + 0.28 * along) * smoothstep(-0.3 * r, 0.4 * r, along);
  float face = smoothstep(-0.25, 0.55, -along / max(l, 1e-3)) * smoothstep(0.6 + 0.2 * r, 0.0, l - r);
  return vec2(lee, face);
}
#endif
vec3 swash(vec2 xz, float hgt) {
  if (hgt < -0.3 || hgt >= 1.74 * uShoreWave.x) return vec3(0.0);
  Swash S = swashAt(xz);
  vec2 rk = vec2(0.0);
#ifdef SWASH_ROCKS
  vec2 ids = textureLod(uRockIdx, xz / uShoreExtent + 0.5, 0.0).rg;
  rk = max(rockSwash(xz, S.dir, ids.x), rockSwash(xz, S.dir, ids.y));
#endif
  float R = S.R * (1.0 - 0.9 * rk.x);
  // the bore runs into the rock and its momentum carries it up the face (~u^2/2g),
  // a surge that drains off again before the rest of the backwash
  float up = 1.0 + 1.1 * rk.y;
  if (R < 0.02) return vec3(0.0);
  if (hgt > R * up) return vec3(0.0, 0.0, 0.5 * smoothstep(1.5 * R * up, R * up, hgt));   // reached by bigger sets
  float s = S.s;
  float eta = R * (s < 0.3 ? sin(s / 0.3 * 1.5708) : cos((s - 0.3) / 0.7 * 1.5708));
  eta *= mix(up, 1.0, smoothstep(0.25, 0.45, s));
  float th = eta - hgt;
  // bubbly front while it runs up (a band behind the tip); in the backwash only sparse
  // remnants, thinning as they drain, so the film dissolves into wet sand instead of
  // leaving a pale sheet over the whole run-up
  // (the front stays a few pixels wide however far off, or it crawls as a 1-pixel line)
  float aa = 0.005 + 5e-5 * distance(xz, cameraPosition.xz);
  float edge = s < 0.35 ? smoothstep(-aa, aa, th) * (1.0 - smoothstep(0.0, 0.06 + aa, th))
                        : 0.3 * smoothstep(0.0, 0.03, th) * (1.0 - smoothstep(0.35, 0.6, s));
  // churned foam piled against a rock while the water is up, torn apart in the backwash
  edge = max(edge, rk.y * smoothstep(0.0, 0.02, th) * (1.0 - smoothstep(0.15, 0.55, s)));
  // drying since the backwash uncovered this height
  float sPass = 0.3 + 0.7 * acos(clamp(hgt / R, 0.0, 1.0)) / 1.5708;
  float dry = (s > sPass ? s - sPass : s + 1.0 - sPass) * 6.2831853 / S.w;
  return vec3(max(th, 0.0), edge, th > 0.0 ? 1.0 : exp(-dry / 5.0));
}
`;

export const WATER_GLSL = /* glsl */`
#define N_TEX ${N.toFixed(1)}
#define PI 3.14159265359
uniform sampler2D uDisp0, uDisp1, uDisp2;           // the capillary cascade is slopes only
uniform sampler2D uSlope0, uSlope1, uSlope2, uSlope3;
uniform vec4 uLength;
uniform vec2 uWaveDamp;    // depth where long swell fully exists, chop strength in shallows
uniform vec4 uImpact[8];      // x, z, age (s), amplitude (m); amplitude 0 = free slot
uniform float uImpactSize[8]; // splash radius (m)
${SHORE_GLSL}

// Ripple rings from objects hitting the water (Cauchy-Poisson): by stationary phase a
// point impulse gives local wavenumber k = g t^2 / (4 r^2) at radius r and phase k r, so
// long waves race ahead and short ones trail inside. A splash of radius L excites
// ~ (kL)^2 exp(-(kL)^2); kMax band-limits to what the mesh or pixel can show.
// Returns (height, dh/dx, dh/dz).
vec3 impactWaves(vec2 xz, float kMax) {
  vec3 o = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    vec4 e = uImpact[i];
    if (e.w <= 0.0) continue;
    vec2 dv = xz - e.xy;
    float r = length(dv) + 1e-3, L = uImpactSize[i];
    float k = 9.81 * e.z * e.z / (4.0 * r * r);
    float kl2 = k * k * L * L;
    float amp = e.w * 2.72 * kl2 * exp(-kl2 - k * k / (kMax * kMax) - 0.12 * e.z) * L / (L + r);
    float ph = k * r;
    o.x += amp * cos(ph);
    o.yz += dv / r * (amp * k * sin(ph));
  }
  return o;
}

// FFT cascade weights by water depth: long swell is replaced by shore waves in the
// shallows, chop survives almost to the beach.
vec3 cascadeDamp(float depth) {
  float swell = smoothstep(2.0, uWaveDamp.x, depth);
  float chop = smoothstep(-0.4, 2.0, depth) * mix(uWaveDamp.y, 1.0, smoothstep(0.0, 10.0, depth));
  return vec3(swell, chop, chop);
}

// Travelling breakers on the eikonal travel-time field (shoreMap.js): phase = w (tau + t)
// with local wavenumber w / sqrt(g depth), so fronts slow down, bunch up and bend around
// the bathymetry on their way in. Gerstner push along the propagation direction, Green's
// law + ray-tube shoaling, breaking limit A <= 0.42*depth.
// Breaking crests pitch forward of their base (plunging lip), glow where thin (lip) and
// leave lace behind in the surf zone (residual).
// wave0 = (amplitude, k, omega, phase) and breaking (0..1) of the main train, for spray
struct Shore { vec3 disp; vec2 slope; float foam; vec4 wave0; float breaking0; vec2 dir; float lip; float residual; };
// cell: sampling interval (m); trains only a few cells long fade out instead of aliasing
Shore shoreWaves(vec2 xz, vec4 sh, float cell) {
  Shore o = Shore(vec3(0.0), vec2(0.0), 0.0, vec4(0.0), 0.0, vec2(0.0), 0.0, 0.0);
  float depth = -sh.x, sdf = sh.y;
  float gl = length(sh.zw);
  float env = smoothstep(180.0, 70.0, sdf) * smoothstep(0.35, 0.8, gl) * smoothstep(-0.9, 0.5, depth);
  if (env <= 0.0 || uShoreWave.x <= 0.0) return o;
  vec4 tr = travelSample(xz);
  vec2 dir = shoreDir(sh, tr);
  o.dir = dir;
  // coasts facing the swell get the big sets, lee shores only small ones
  env *= shoreExposure(dir);
  float shoal = dot(tr.yz, tr.yz) > 0.25 ? tr.w : pow(clamp(max(depth, 0.6) / 14.0, 0.04, 1.0), -0.25);
  float cel = sqrt(9.81 * clamp(depth, 0.3, 14.0));
  // dissipation memory: a wave that already broke over a bar or reef (shelter depth S)
  // reaches here at most 0.42 S high; once it runs into water much deeper than S it
  // re-forms as unbroken swell instead of breaking again on every inner bar and flat
  float S = surfSample(xz);
  float amax = 0.42 * min(max(depth, 0.0), S) + 0.14 * smoothstep(0.5, 2.0, S) + 0.02;
  float gate = smoothstep(1.4, 1.05, depth / max(S, 0.05));
  float noisePhase = shoreNoisePhase(xz);
  float group = shoreGroup(xz);
  float pinch = 0.85;   // total horizontal compression allowed (Jacobian stays > 0.15)
  for (int i = 0; i < 2; i++) {
    float lambda = uShoreWave.y * (i == 0 ? 1.0 : 0.61);
    float w = sqrt(9.81 * 2.0 * PI / lambda) * uShoreWave.z;
    float k = w / cel;
    float a = min(uShoreWave.x * (i == 0 ? 1.0 : 0.45) * env * shoal * group, amax * (i == 0 ? 1.0 : 0.5));
    float ph = w * (tr.x + uTime) + noisePhase * (i == 0 ? 1.0 : 1.37) + float(i) * 2.1;
    float c = 0.5 + 0.5 * cos(ph);
    float s = sin(ph);
    const float P = 1.6;           // narrower crests, flatter troughs
    float cp = pow(max(c, 0.0), P - 1.0);
    float rel = a / max(depth, 0.05);
    // sections of each crest break early or late (peeling), new layout every wave
    float cycle = floor((ph + PI) / (2.0 * PI));
    float early = vnoise(xz * 0.03 + vec2(cycle * 7.3, cycle * 3.1 + float(i) * 31.0));
    // too little height left to whiten anything (lagoon ripples, the lee of the rock)
    float energy = smoothstep(0.03, 0.2, a);
    float breaking = smoothstep(0.12 + 0.14 * early, 0.3 + 0.2 * early, rel) * gate * energy;
    // plunging only around the break point; the inner surf zone runs as a bore
    float pitch = i == 0 ? 2.0 * uShoreWave.w * a * smoothstep(0.16, 0.28, rel) * (1.0 - smoothstep(0.4, 0.6, rel)) * gate : 0.0;
    // a heightfield can't overhang: the lean (up to 1.08 pitch k of compression just
    // ahead of the crest) and both trains' Gerstner pinch share one budget, so the
    // surface never folds over into a glassy fin
    pitch = min(pitch, 0.35 / (1.08 * k));
    // the lean is a c^6 pulse ~0.1 wavelength wide: on cells coarser than that it only
    // folds triangles (dropped as backfaces) into flickering slivers along the crest
    pitch *= 1.0 - smoothstep(0.03, 0.1, k * cell / (2.0 * PI));
    pinch -= 1.08 * pitch * k;
    float qak = min(pinch, uShoreWave.w * a * k * 8.0);
    pinch -= qak;
    float c5 = c * c * c * c * c;
    // the camera-centred grid slides as the view moves: a crest only a cell or two long
    // gets resampled differently every frame and the waterline warps and flashes
    float bl = 1.0 - smoothstep(0.1, 0.3, k * cell / (2.0 * PI));
    o.disp.y += bl * a * (2.0 * cp * c - 0.78);
    o.disp.xz += bl * dir * ((qak / k) * s + pitch * c5 * c);
    o.slope += bl * dir * (a * k * P * cp * s / max(1.0 - qak * cos(ph) + 3.0 * pitch * k * c5 * s, 0.2));
    // whitewater: on the crest and trailing behind it once the wave is near breaking. An
    // established bore (rel > 0.4) also drags a long spilling sheet over its back face,
    // which reaches past the pinched crest so the band isn't squeezed into a ribbon; the
    // arcs wrapping round small bars stay thin.
    float psi = mod(ph + PI, 2.0 * PI) - PI;
    // Small breakers spilling over bars and in the lagoon are short and shallow, so a band
    // a radian wide is a thin ribbon there: they get a wider, fainter tail (a soft band
    // the lace erodes, not a bright line drawn along every crest).
    float big = smoothstep(0.2, 0.5, a);
    float tail = max(exp(-max(psi, 0.0) * mix(0.45, 1.0, big)), 0.65 * smoothstep(0.3, 0.55, rel) * smoothstep(2.4, 0.3, psi));
    float f = breaking * smoothstep(mix(-0.7, -0.35, big), 0.0, psi) * tail * mix(0.55, 1.0, big);
    o.foam += f;
    if (i == 0) {
      o.wave0 = vec4(a, k, w, ph);
      o.breaking0 = breaking;
      o.lip = breaking * c5 * smoothstep(0.6, -0.2, psi);
      // (the lace outlives single crests: no peeling, or it would pop between waves)
      o.residual = smoothstep(0.18, 0.4, rel) * (0.3 + 0.45 * exp(-mod(ph, 2.0 * PI) * 0.4)) * gate * energy;
    }
  }
  return o;
}

// Full surface displacement at an undisplaced xz; lod per cascade (0 = finest).
vec3 waterDisplacement(vec2 xz, vec3 lod) {
  vec4 sh = shoreSample(xz);
  vec3 damp = cascadeDamp(-sh.x);
  vec3 d = textureLod(uDisp0, xz / uLength.x, max(lod.x, 0.0)).xyz * damp.x
         + textureLod(uDisp1, xz / uLength.y, max(lod.y, 0.0)).xyz * damp.y
         + textureLod(uDisp2, xz / uLength.z, max(lod.z, 0.0)).xyz * damp.z;
  d += shoreWaves(xz, sh, exp2(lod.x - 1.0) * uLength.x / N_TEX).disp;
  // rings at their world position; cell size back from the finest lod
  d.y += impactWaves(xz + d.xz, 2.0 * N_TEX / (exp2(lod.z - 1.0) * uLength.z)).x;
  return d;
}

// Surface at world xz: invert the choppy horizontal displacement by fixed-point
// iteration, then read the height there. Returns the displacement; .y is the height.
vec3 waterAt(vec2 q, vec3 lod) {
  vec2 p = q;
  vec3 d = vec3(0.0);
  for (int i = 0; i < 4; i++) { d = waterDisplacement(p, lod); p = q - d.xz; }
  return waterDisplacement(p, lod);
}
`;

const VERT = WATER_GLSL + /* glsl */`
uniform float uGridScale;
uniform float uCellStep;
uniform float uWind;
out vec3 vWorld;
out vec2 vXZ;
out float vUnresolved;
out float vSurf;

void main() {
  vec2 local = position.xz;
  float r = length(local);
  float scale = r > ${(OUTER * 2).toFixed(1)} ? 1.0 : uGridScale;
  vec2 xz = cameraPosition.xz + local * scale;
  float cell = max(r, ${INNER.toFixed(1)}) * uCellStep * scale;

  // +1 LOD bias: box-filtered mips still leak a little past Nyquist
  vec3 d = waterDisplacement(xz, log2(cell * N_TEX / uLength.xyz) + 1.0);
  // Cox-Munk mean square slope minus what the cascades carry (each one's 1x1 mip is its
  // mean square slope): the rest is sub-texel roughness
  vec4 m0 = textureLod(uSlope0, vec2(0.5), 8.0), m1 = textureLod(uSlope1, vec2(0.5), 8.0);
  vec4 m2 = textureLod(uSlope2, vec2(0.5), 8.0), m3 = textureLod(uSlope3, vec2(0.5), 8.0);
  vUnresolved = max(0.003 + 0.00512 * uWind - (m0.z + m0.w + m1.z + m1.w + m2.z + m2.w + m3.z + m3.w), 0.0);

  vXZ = xz;
  vSurf = surfSample(xz);
  vWorld = vec3(xz.x + d.x, d.y, xz.y + d.z);
  // water can't drain below the bed: a trough over a bar or a flat just under sea level
  // only thins the water. Without this the coarse far mesh dips under the sand in
  // triangles, which the terrain still shades as underwater (sea level 0, caustics).
  // (clearance grows with distance, as the depth buffer's precision falls off)
  if (vWorld.y < 0.0) {
    float dc = distance(vWorld.xz, cameraPosition.xz);
    vWorld.y = max(vWorld.y, min(shoreSample(vWorld.xz).x + 0.04 + 2e-7 * dc * dc, 0.0));
  }
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}`;

const FRAG = '#define SURF_VARYING\n' + WATER_GLSL + FLOAT_SHADOW_GLSL + /* glsl */`
precision highp sampler2DShadow;
uniform vec2 uResolution;
uniform vec2 uNearFar;
uniform sampler2D uSceneColor;
uniform sampler2D uSceneDepth;
uniform sampler2D uReflection;
uniform mat4 uReflMatrix;
uniform samplerCube uSkyCube;
uniform float uSkyMaxLod;
uniform sampler2D uFoamTex;
uniform sampler2DShadow uShadowMap;
uniform mat4 uShadowMatrix;
uniform float uShadowBias;  // depth units
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAbsorption;
uniform vec3 uScatterColor;
uniform vec3 uFoamTint;     // thin foam: the water colour showing through the bubbles
uniform vec4 uSSS;          // peak strength, view strength, shadow strength, -
uniform vec4 uFoam;         // bias, scale, shore band (m), brightness
uniform vec4 uRock;         // surf rock: centre xz, waterline radius (m; 0 = none), unused
uniform vec4 uOptics;       // base roughness, refraction strength, reflection distortion, fog density
uniform vec3 uCamForward;
uniform int uDebug;
uniform float uGlint;
uniform float uCamSide;     // -1 camera above the surface, 1 below, 0 straddling it
in vec3 vWorld;
in vec2 vXZ;
in float vUnresolved;
out vec4 fragColor;

float linearDepth(float d) {
  float z = d * 2.0 - 1.0;
  return 2.0 * uNearFar.x * uNearFar.y / (uNearFar.y + uNearFar.x - z * (uNearFar.y - uNearFar.x));
}

float sunShadow(vec3 p) {
  float s = 1.0;
  vec4 sc = uShadowMatrix * vec4(p, 1.0);
  // one hardware 2x2 PCF tap: texels are ~0.44 m, soft enough on moving water. The water
  // casts nothing, so the bias only has to cover depth precision.
  if (all(greaterThan(sc.xy, vec2(0.0))) && all(lessThan(sc.xyz, vec3(1.0)))) s = texture(uShadowMap, vec3(sc.xy, sc.z - uShadowBias));
  return min(s, floatShadow(p));
}

// Poisson count with mean lam from one uniform number: inverse CDF, normal (logistic)
// approximation for large means
float poisson(float lam, float u) {
  if (lam > 6.0) return max(0.0, lam + sqrt(lam) * log(u / (1.0 - u)) / 1.702);
  float p = exp(-lam), F = p, n = 0.0;
  for (int k = 0; k < 14; k++) { if (u <= F) break; n += 1.0; p *= lam / n; F += p; }
  return n;
}

vec3 skyLod(vec3 dir, float lod) {
  dir.y = max(dir.y, 0.0);
  return textureLod(uSkyCube, dir, lod).rgb;
}

void main() {
  // folded crests flip triangles; drop faces that can't face the camera's side
  if (gl_FrontFacing ? uCamSide > 0.5 : uCamSide < -0.5) discard;
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec2 uv = gl_FragCoord.xy / uResolution;

  // --- surface: slopes + slope variance from the three cascades -----------------
  vec4 sh = shoreSample(vXZ);
  float depthBelow = -sh.x;
  vec3 damp = cascadeDamp(depthBelow);
  vec4 s0 = texture(uSlope0, vXZ / uLength.x) * damp.x;
  vec4 s1 = texture(uSlope1, vXZ / uLength.y) * damp.y;
  vec4 s2 = texture(uSlope2, vXZ / uLength.z) * damp.z;
  vec4 s3 = texture(uSlope3, vXZ / uLength.w) * damp.z;
  s0.zw *= damp.x; s1.zw *= damp.y; s2.zw *= damp.z; s3.zw *= damp.z;   // second moments scale by damp^2
  // wind slicks: surfactant patches damp the short waves (capillaries most), so the far
  // field breaks into calm and rough streaks instead of a uniform speckle
  float slick = smoothstep(0.3, 0.7, vnoise(vXZ * 0.006 + uTime * 0.01));
  float sl2 = mix(0.75, 1.0, slick), sl3 = mix(0.4, 1.0, slick);
  s2.xy *= sl2; s2.zw *= sl2 * sl2; s3.xy *= sl3; s3.zw *= sl3 * sl3;
  vec2 fwXZ = fwidth(vXZ);
  Shore shore = shoreWaves(vXZ, sh, max(fwXZ.x, fwXZ.y));
  vec3 imp = impactWaves(vWorld.xz, 2.0 / max(max(fwXZ.x, fwXZ.y), 1e-3));
  vec2 slope = s0.xy + s1.xy + s2.xy + s3.xy + shore.slope + imp.yz;
  vec2 variance = max(s0.zw - s0.xy * s0.xy, 0.0) + max(s1.zw - s1.xy * s1.xy, 0.0)
                + max(s2.zw - s2.xy * s2.xy, 0.0) + max(s3.zw - s3.xy * s3.xy, 0.0);
  vec3 Nrm = normalize(vec3(-slope.x, 1.0, -slope.y));
  // the normal's tilt as a screen offset: project a small world step along it
  vec3 vp = (viewMatrix * vec4(vWorld, 1.0)).xyz;
  vec3 dv = mat3(viewMatrix) * vec3(Nrm.x, 0.0, Nrm.z);
  vec2 nS = dv.xy - vp.xy / vp.z * dv.z;

  // geometric specular AA (Kaplanyan): normal change across the pixel adds variance
  vec3 dndx = dFdx(Nrm), dndy = dFdy(Nrm);
  float geoVar = min(0.25 * (dot(dndx, dndx) + dot(dndy, dndy)), 0.18);
  float alpha2 = uOptics.x * uOptics.x + vUnresolved * damp.z * damp.z * sl3 * sl3 + variance.x + variance.y + geoVar;
  float alpha = sqrt(alpha2);

  float NoV = max(dot(Nrm, V), 1e-4);
  float NoL = dot(Nrm, uSunDir);
  float shadow = sunShadow(vWorld);

  // --- foam -------------------------------------------------------------------
  float t0 = texture(uDisp0, vXZ / uLength.x).w, t1 = texture(uDisp1, vXZ / uLength.y).w, t2 = texture(uDisp2, vXZ / uLength.z).w;
  float jac = mix(1.0, t0, damp.x) + mix(1.0, t1, damp.y) + mix(1.0, t2, damp.z) - 2.0;
  float foam = clamp((uFoam.x - jac) * uFoam.y, 0.0, 1.0);

  // --- seen from below: Snell's window + total internal reflection ---------------
  // (the camera->surface water column is fogged later by the underwater pass)
  if (!gl_FrontFacing) {
    vec3 Nu = -Nrm;
    float cosI = dot(V, Nu);
    // outside Snell's window total internal reflection mirrors the deep water: the same
    // colour the underwater pass fogs towards, for the reflected direction
    vec3 Rd = reflect(-V, Nu);
    vec3 ambientU = skyLod(vec3(0.0, 1.0, 0.0), uSkyMaxLod);
    vec3 deep = uScatterColor * (ambientU + uSunColor * max(uSunDir.y, 0.0)) * mix(0.55, 1.35, Rd.y * 0.5 + 0.5);
    vec3 colU = deep;
    // the window edge (critical angle) blurred by the sub-pixel roughness, so rough
    // patches fade between window and mirror instead of switching
    const float COS_CRIT = 0.6614;   // sqrt(1 - 1/1.33^2)
    float edge = max(alpha * 1.5, 0.02);
    float win = smoothstep(COS_CRIT - edge, COS_CRIT + edge, cosI);
    if (win > 0.0) {
      vec3 Tdir = refract(-V, Nu, 1.33);
      if (dot(Tdir, Tdir) == 0.0) Tdir = normalize(-V - Nu * dot(-V, Nu));   // grazing, just past the edge
      float cosT = max(dot(Tdir, Nrm), 0.0);
      float Fu = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
      // sky through the window is the refracted direction (the 180-degree sky squeezed
      // into the ~97-degree cone); anything opaque above water comes from the frame
      vec2 wuv = uv + nS * 0.04;
      vec3 above = textureLod(uSceneDepth, wuv, 0.0).r > 0.999999
        ? skyLod(Tdir, clamp(log2(alpha * 900.0), 0.0, uSkyMaxLod)) : textureLod(uSceneColor, wuv, 0.0).rgb;
      // sun through the window: GGX transmission lobe, widened by the roughness
      float aT = max(alpha * 1.4, 0.03), mu = max(dot(Tdir, uSunDir), 0.0);
      float dT = mu * mu * (aT * aT - 1.0) + 1.0;
      float sunLobe = aT * aT / (PI * dT * dT) * 0.25;
      colU = mix(deep, mix(above + uSunColor * sunLobe * shadow, deep, Fu), win);
    }
    colU *= 1.0 - 0.55 * max(foam, clamp(shore.foam, 0.0, 1.0));
    // alpha tags what the pixel sees for the underwater pass: 0 underside, 2 top
    // (everything else writes 1, so MSAA edge averages never look like the other face)
    fragColor = vec4(colU, 0.0);
    return;
  }

  // --- refraction + absorption -------------------------------------------------
  float waterDepth = linearDepth(gl_FragCoord.z);
  float sceneDepth = linearDepth(textureLod(uSceneDepth, uv, 0.0).r);
  float viewCos = max(dot(-V, uCamForward), 0.05);
  float thick = max(sceneDepth - waterDepth, 0.0) / viewCos;
  vec2 ruv = uv + nS * uOptics.y * clamp(thick * 0.25, 0.0, 1.0) / max(waterDepth * 0.02, 1.0);
  float rDepth = linearDepth(textureLod(uSceneDepth, ruv, 0.0).r);
  // the offset landed on something in front of the water: fall back towards no offset,
  // smoothly so object edges don't get a hard outline
  float keep = smoothstep(waterDepth - 0.3, waterDepth + 0.3, rDepth);
  ruv = mix(uv, ruv, keep);
  thick = mix(thick, max(rDepth - waterDepth, 0.0) / viewCos, keep);
  vec3 refracted = textureLod(uSceneColor, ruv, 0.0).rgb;
  vec3 T = exp(-uAbsorption * thick);

  // shoreline contact foam where the water gets thin (in the shallows only: around
  // floating props it would be a white frill). Vertical thickness, so it doesn't change
  // with camera pitch; capped below solid cover so it stays lace, and mostly where bores
  // arrive (a lee shore or sandbar without surf gets almost none, not an outline).
  float shoreFoam = clamp(shore.foam, 0.0, 1.0);
  float vth = thick * V.y;
  // rocks (and props) the bed height map doesn't know about: water much thinner than the
  // column over the bed (measured from the displaced surface). Swash churns a wider ring
  // round them, which breathes as the waves rise and fall against them
  if (depthBelow < 6.0) {
    float obst = smoothstep(0.5, 1.5, depthBelow + vWorld.y - vth);
    float act = clamp(shore.residual * 1.5 + shoreFoam + 0.6 * obst, 0.0, 1.0);
    float contact = smoothstep(mix(uFoam.z, 1.0, obst), 0.0, vth) * smoothstep(6.0, 2.0, depthBelow) * mix(0.0, 0.5, act);
    // broken into drifting patches so it never traces the waterline as a continuous rim
    contact *= smoothstep(0.3, 0.6, vnoise(vXZ * 0.7 + shore.dir * uTime * 0.4) * 0.65 + vnoise(vXZ * 2.3) * 0.35);
    // and gone before the mesh edge, which would otherwise wear it as a row of white beads;
    // far off the patches are sub-pixel and only sparkle
    contact *= smoothstep(0.03, 0.2, vth) * (1.0 - smoothstep(300.0, 600.0, dist));
    foam = max(foam, contact);
  }
  // the surf rock: each crest slams into it and leaves a churned skirt that fades until
  // the next one and trails off into the lee (the depth-buffer contact above only reaches
  // ~1 m out from a steep face). Phase of the main train, so it pulses with the sets.
  vec2 rd = vWorld.xz - uRock.xy;
  float rl = length(rd);
  if (rl < uRock.z * 3.0 && uShoreWave.x > 0.0) {
    float lee = max(dot(rd, shore.dir) / max(rl, 1e-3), 0.0);
    float since = mod(shore.wave0.w, 2.0 * PI);            // radians since the crest passed
    float hit = exp(-since * 0.7);
    float reach = uRock.z * (1.15 + (0.3 + 0.9 * lee) * (0.3 + 0.7 * hit));
    float ring = smoothstep(reach, uRock.z * 0.95, rl);
    // churned patches streaming off into the lee, never a solid ring: noise thresholded
    // by how fresh the hit is, so a slam is a dense burst that tears into lace as it ages
    float n = vnoise(vXZ * 0.55 - shore.dir * uTime * 0.9) * 0.6 + vnoise(vXZ * 1.9 + uTime * 0.35) * 0.4;
    float skirt = ring * smoothstep(0.62 - 0.3 * hit * ring, 0.85 - 0.3 * hit * ring, n);
    foam = max(foam, skirt * mix(0.35, 0.75, hit) * smoothstep(0.0, 0.3, uShoreWave.x));
  }

  // --- lighting ------------------------------------------------------------------
  vec3 ambient = skyLod(vec3(0.0, 1.0, 0.0), uSkyMaxLod);
  vec3 sun = uSunColor * shadow;
  // in-scatter of the water column (sun + sky), then Atlas-style SSS on crests
  vec3 inscatter = uScatterColor * (ambient + uSunColor * (0.3 + 0.7 * shadow) * max(uSunDir.y, 0.0));
  // over shallow bright sand the light scattered back up has crossed little water: turquoise
  inscatter *= 1.0 + 1.5 * exp(-0.3 * max(depthBelow, 0.0));
  float h = max(vWorld.y, 0.0);
  float k1 = uSSS.x * h * pow(clamp(dot(uSunDir, -V), 0.0, 1.0), 4.0) * pow(0.5 - 0.5 * NoL, 3.0);
  float k2 = uSSS.y * pow(NoV, 2.0);
  vec3 sss = (k1 + k2) * uScatterColor * sun + uSSS.z * max(NoL, 0.0) * uScatterColor * sun;
  // thin breaking lips: sunlight through about a metre of water glows turquoise,
  // strongest looking into the sun
  sss += shore.lip * sun * exp(-uAbsorption * 2.0) * 0.06 * (0.3 + 2.5 * pow(clamp(dot(uSunDir, -V), 0.0, 1.0), 3.0));
  vec3 body = refracted * T + (inscatter + sss) * (1.0 - T);
  // surf-zone turbidity: sand stirred up under and behind the bores clouds the water a
  // little (the bed and its caustics soften, the colour goes sandy-green), never white:
  // bubbles are the foam layer's job. The thin wash over the beach settles clear again.
  float turb = clamp(shore.residual * 0.8 + shoreFoam * 0.6, 0.0, 1.0) * smoothstep(5.0, 1.0, depthBelow) * smoothstep(0.1, 0.8, vth);
  if (turb > 0.0) {
    turb *= 0.6 + 0.4 * vnoise(vXZ * 0.08 - shore.dir * uTime * 0.3);
    float ext = 0.7 * turb;
    vec3 Tt = T * exp(-ext * thick);
    float wm = min(ext / (ext + dot(uAbsorption, vec3(0.333))), 0.4);
    body = refracted * Tt + mix(inscatter + sss, inscatter * vec3(1.2, 1.1, 0.75), wm) * (1.0 - Tt);
  }

  // Fresnel with roughness-aware F90 (Lagarde) so the rough far field doesn't go white
  const float F0 = 0.02;
  float F90 = max(1.0 - 0.7 * sqrt(alpha), F0);
  float F = F0 + (F90 - F0) * pow(1.0 - NoV, 5.0);

  // --- reflection: half-res planar (terrain) over the sky cube -----------------------
  vec3 R = reflect(-V, Nrm);
  R.y = abs(R.y);
  float lod = clamp(log2(alpha * 650.0), 0.0, uSkyMaxLod);
  vec3 refl = skyLod(R, lod);
  // (premultiplied: the target clears to 0, so blurred mips fade to the sky, not black)
  vec4 pc = uReflMatrix * vec4(vWorld.x, 0.0, vWorld.z, 1.0);
  vec2 puv = pc.xy / pc.w + nS * uOptics.z / max(1.0, waterDepth * 0.01);
  vec4 planar = textureLod(uReflection, puv, clamp(log2(alpha * 300.0), 0.0, 6.0));
  refl = refl * (1.0 - planar.a) + planar.rgb;

  // --- sun specular: GGX, alpha floored so the sun acts as a small area light ---------
  float aS = max(alpha, 0.015);
  float aS2 = aS * aS;
  vec3 H = normalize(uSunDir + V);
  float NoH = max(dot(Nrm, H), 0.0);
  float nl = max(NoL, 0.0);
  float dd = NoH * NoH * (aS2 - 1.0) + 1.0;
  float D = aS2 / (PI * dd * dd);
  float vis = 0.5 / (nl * sqrt(NoV * NoV * (1.0 - aS2) + aS2) + NoV * sqrt(nl * nl * (1.0 - aS2) + aS2) + 1e-5);
  float Fs = F0 + (1.0 - F0) * pow(1.0 - max(dot(V, H), 0.0), 5.0);
  vec3 spec = sun * (PI * D * vis * Fs * nl);

  // glitter: the lobe as a finite number of sub-pixel facets. Per cell of about the
  // pixel footprint the expected count mirroring the sun is lam = facet density * area *
  // D * (sun solid angle / 4 VoH); a Poisson draw / lam scales the smooth lobe (mean 1,
  // energy kept). Dense cells (close to the lobe core, far away) stay smooth, sparse
  // ones break into points; each cell crossfades between draws so they twinkle.
  if (uGlint > 0.0 && dot(spec, vec3(1.0)) > 0.02) {
    const float FACETS = 2e4;   // per m^2 (calibration knob)
    float lf = log2(max(max(fwXZ.x, fwXZ.y), 1e-3)) + 1.0;
    float l0 = floor(lf);
    float per = FACETS * D * NoH * 6.8e-5 / (4.0 * max(dot(V, H), 0.05));
    float m = 0.0;
    for (int j = 0; j < 2; j++) {
      float l = l0 + float(j), sz = exp2(l);
      vec2 cell = floor(vXZ / sz);
      float lam = per * sz * sz;
      float tt = uTime * 3.0 + hash12(cell + l * 17.17) * 64.0, it = floor(tt);
      float n0 = poisson(lam, clamp(hash12(cell * 1.31 + it * 3.7), 1e-4, 0.9999));
      float n1 = poisson(lam, clamp(hash12(cell * 1.31 + (it + 1.0) * 3.7), 1e-4, 0.9999));
      m += (j == 0 ? 1.0 - (lf - l0) : lf - l0) * min(mix(n0, n1, smoothstep(0.0, 1.0, tt - it)) / max(lam, 1e-4), 30.0);
    }
    spec *= mix(1.0, m, uGlint * smoothstep(4.0, 30.0, dist) * smoothstep(0.05, 0.3, vth));
  }

  // the thin wash is churned and aerated, so it mirrors only a dim, broken sky: a full
  // sky reflection over sand a hand deep washes it out to grey-white
  vec3 col = mix(body, refl, F * mix(0.45, 1.0, smoothstep(0.08, 0.8, vth))) + spec;
  // vanishing film at the waterline: no reflection / specular seam where the mesh cuts the sand
  // (a few cm wide and over the swash band, so the edge melts into the moving film on
  // the sand instead of drawing a glassy lip line along the static mesh waterline)
  col = mix(refracted, col, smoothstep(0.0, 0.12 + dist * 5e-4, vth));

  // --- foam surface: eroded by age via the pattern threshold, kills specular ----------
  // erosion: dense foam is nearly solid, ageing foam thins out to the lace network
  // (texture taps only where there is foam; most of the ocean has none). Each source
  // also gives a billow height + gradient (world) and a density for the shading.
  float cover = 0.0, pat = 0.0, fh = 0.5, dens = 0.0;
  vec2 fg = vec2(0.0);
  if (foam > 0.0) {
    vec4 t0 = texture(uFoamTex, vXZ * 0.11);
    pat = t0.r * 0.65 + texture(uFoamTex, vXZ * 0.031 + 0.37).r * 0.35;
    cover = smoothstep(1.05 - foam, 1.3 - foam, pat) * sqrt(foam);
    fh = t0.g; fg = (t0.ba - 0.5) * 64.0 * 0.11; dens = foam;
  }
  if (shoreFoam > 0.0) {
    // whitewater rides shoreward with the bore: a world-space flow map at the phase
    // speed, two phases crossfaded every half period (which also makes it churn). On the
    // displaced surface, so the crest pinch doesn't squash it into streaks; a coordinate
    // tied to the front direction would shear wherever the fronts curve.
    const float FLOW_T = 2.5;   // s
    vec2 vel = shore.dir * shore.wave0.z / max(shore.wave0.y, 1e-3);
    float f0 = fract(uTime / FLOW_T), f1 = fract(uTime / FLOW_T + 0.5), wb = abs(2.0 * f0 - 1.0);
    vec4 b0 = texture(uFoamTex, (vWorld.xz - vel * (f0 * FLOW_T)) * 0.15);
    vec4 b1 = texture(uFoamTex, (vWorld.xz - vel * (f1 * FLOW_T)) * 0.15 + 0.43);
    float sh_ = mix(b0.g, b1.g, wb);
    float sPattern = mix(b0.r, b1.r, wb) * 0.3 + sh_ * 0.45 + texture(uFoamTex, vWorld.xz * 0.023 + 0.5).r * 0.25;
    // lace over a thin, patchy veil on the fresh bore only (an even translucent sheet over
    // the whole inner surf zone reads as ice); in the thin wash it all breaks up into lace
    float sCover = smoothstep(1.0 - shoreFoam * 1.1, 1.45 - shoreFoam * 1.1, sPattern) * sqrt(shoreFoam);
    sCover = max(sCover, 0.3 * smoothstep(0.45, 0.9, shoreFoam) * smoothstep(0.35, 0.7, sPattern) * smoothstep(0.1, 0.5, vth));
    sCover *= mix(0.55, 1.0, smoothstep(0.05, 0.4, vth));
    if (sCover >= cover) {
      pat = sPattern; fh = sh_; dens = shoreFoam;
      fg = mix(b0.ba, b1.ba, wb) * (64.0 * 0.15) - 32.0 * 0.15;
    }
    cover = max(cover, sCover);
  }
  if (shore.residual > 0.0) {
    // lace left behind in the surf zone, drifting shoreward (two-phase flow map)
    float fp = fract(uTime / 8.0);
    vec2 drift = shore.dir * 2.8;
    float r0 = texture(uFoamTex, (vWorld.xz - drift * fp) * 0.06).r;
    float r1 = texture(uFoamTex, (vWorld.xz - drift * fract(fp + 0.5)) * 0.06 + 0.5).r;
    float rp = mix(r0, r1, abs(2.0 * fp - 1.0));
    float rCover = smoothstep(1.2 - shore.residual, 1.35 - shore.residual, rp) * shore.residual;
    if (rCover >= cover) { pat = rp; fh = 0.5; fg = vec2(0.0); dens = shore.residual * 0.5; }
    cover = max(cover, rCover);
  }
  // no foam on the vanishing film at the waterline, whose thickness flickers as the far
  // mesh slides; the band widens with distance like the film fade above
  cover *= smoothstep(0.0, 0.05 + dist * 3e-4, vth);
  if (cover > 0.0) {
    // billows bump the normal (whitewater is lumpy, thin lace lies flat) and shade
    // their creases; thin foam is a bubble film tinted by the water under it, dense foam
    // a bright diffuse white with a little sheen on the bubble tops
    vec3 fN = normalize(Nrm - vec3(fg.x, 0.0, fg.y) * (0.03 + 0.12 * dens));
    float fl = dot(fN, uSunDir);
    float ao = mix(0.45, 1.0, smoothstep(0.15, 0.75, fh));
    float solid = smoothstep(0.2, 0.9, dens * (0.55 + 0.7 * fh));
    vec3 foamAlbedo = mix(uFoamTint, vec3(0.93, 0.92, 0.88), max(solid, smoothstep(0.3, 0.9, pat) * 0.6));
    vec3 lit = sun * (0.15 + 0.85 * clamp(fl * 0.8 + 0.2, 0.0, 1.0)) * mix(ao, 1.0, 0.4) + ambient * 1.1 * ao;
    // sun behind the crest shines through the thin foam on top
    lit += sun * pow(clamp(dot(uSunDir, -V), 0.0, 1.0), 4.0) * 0.4 * (1.0 - solid);
    vec3 foamCol = uFoam.w * foamAlbedo * lit;
    foamCol += sun * pow(max(dot(fN, H), 0.0), 90.0) * 0.5 * smoothstep(0.55, 0.85, fh) * solid;
    col = mix(col, foamCol, cover * mix(0.8, 1.0, solid));
  }

  // --- aerial perspective into the horizon sky ---------------------------------------
  float fog = 1.0 - exp(-dist * uOptics.w);
  col = mix(col, skyLod(-V, 3.0), fog);

  if (uDebug == 1) col = Nrm * 0.5 + 0.5;
  else if (uDebug == 2) col = spec;
  else if (uDebug == 3) col = vec3(foam, cover, shoreFoam);
  else if (uDebug == 4) col = vec3(alpha * 5.0, sqrt(geoVar) * 5.0, sqrt(variance.x + variance.y) * 5.0);
  else if (uDebug == 5) col = vec3(F);
  else if (uDebug == 6) col = body;
  else if (uDebug == 7) col = refl;
  fragColor = vec4(col, 2.0);
}`;

export class OceanSurface {
  constructor(sim, shore, sky, floatShadow) {
    this.sim = sim;
    this.uniforms = {
      uDisp0: { value: null }, uDisp1: { value: null }, uDisp2: { value: null },
      uSlope0: { value: null }, uSlope1: { value: null }, uSlope2: { value: null }, uSlope3: { value: null },
      uLength: { value: new THREE.Vector4(...sim.lengths) },
      uWind: { value: 0 },
      uImpact: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
      uImpactSize: { value: new Array(8).fill(1) },
      uShore: { value: shore.texture }, uTravel: { value: shore.travel }, uSurf: { value: shore.surf }, uShoreExtent: { value: shore.extent },
      uTime: { value: 0 },
      uShoreWave: { value: new THREE.Vector4(0.55, 30, 1.0, 1.0) },
      uWaveDamp: { value: new THREE.Vector2(26, 0.55) },
      uSwellDir: { value: new THREE.Vector2(1, 0) },
      uGridScale: { value: 1 },
      uCellStep: { value: (2 * Math.PI) / ANGULAR },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uNearFar: { value: new THREE.Vector2(0.5, 80000) },
      uSceneColor: { value: null },
      uSceneDepth: { value: null },
      uReflection: { value: null },
      uReflMatrix: { value: new THREE.Matrix4() },
      uSkyCube: { value: sky.cube },
      uSkyMaxLod: { value: Math.log2(sky.cubeSize) },
      uFoamTex: { value: null },
      uShadowMap: { value: null },
      uShadowMatrix: { value: new THREE.Matrix4() },
      uShadowBias: { value: 1e-5 },
      ...floatShadow,
      uSunDir: { value: sky.sunDir },
      uSunColor: { value: sky.sunColor },
      uAbsorption: { value: new THREE.Vector3(0.40, 0.062, 0.032) },
      uScatterColor: { value: new THREE.Color(0.0, 0.05, 0.08) },
      uFoamTint: { value: new THREE.Color(0.62, 0.78, 0.82) },
      uSSS: { value: new THREE.Vector4(1.6, 0.06, 0.05, 0) },
      uFoam: { value: new THREE.Vector4(0.05, 1.3, 0.2, 0.72) },
      uRock: { value: new THREE.Vector4() },
      uOptics: { value: new THREE.Vector4(0.02, 0.06, 0.04, 1 / 18000) },
      uCamForward: { value: new THREE.Vector3() },
      uDebug: { value: 0 },
      uGlint: { value: 0.6 },
      uCamSide: { value: -1 },
    };
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      side: THREE.DoubleSide,
    });
    this.grids = [buildGrid(ANGULAR), buildGrid(ANGULAR / 2)];
    this.mesh = new THREE.Mesh(this.grids[0], this.material);
    this.mesh.frustumCulled = false;
  }

  update(camera, time) {
    const u = this.uniforms, s = this.sim;
    u.uDisp0.value = s.displacement[0]; u.uDisp1.value = s.displacement[1]; u.uDisp2.value = s.displacement[2];
    u.uSlope0.value = s.slope[0]; u.uSlope1.value = s.slope[1]; u.uSlope2.value = s.slope[2]; u.uSlope3.value = s.slope[3];
    u.uWind.value = s.params.windSpeed;
    u.uTime.value = time;
    const a = THREE.MathUtils.degToRad(s.params.swellDirection);
    u.uSwellDir.value.set(-Math.cos(a), -Math.sin(a));
    u.uGridScale.value = Math.max(1, Math.abs(camera.position.y) / 2);
    // hysteresis, so hovering at the threshold doesn't swap grids back and forth
    const coarse = +(Math.abs(camera.position.y) > HIGH_CAMERA * (this.mesh.geometry === this.grids[1] ? 0.85 : 1.15));
    this.mesh.geometry = this.grids[coarse];
    u.uCellStep.value = (2 * Math.PI) / (ANGULAR >> coarse);
    u.uNearFar.value.set(camera.near, camera.far);
    camera.getWorldDirection(u.uCamForward.value);
  }
}
