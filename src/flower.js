import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { clamp, damp, mulberry32, TAU } from './utils.js';

const FLOWER_RADIUS = 2.35;
const CAMERA_DISTANCE = 9.5;
const CAMERA_FOV = 40;

const petalVertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uBloom;
  uniform float uPointSize;
  uniform float uPixelRatio;
  uniform float uPulse;
  uniform float uAlphaScale;
  uniform float uBrightness;
  uniform float uFillSize;
  uniform float uFillAlpha;

  attribute vec3 aBud;
  attribute vec3 aColor;
  attribute vec4 aSeed;
  attribute float aSize;
  attribute float aDelay;
  attribute float aEdge;

  varying vec3 vColor;
  varying float vAlpha;
  varying float vFlare;
  varying float vSoft;

  void main() {
    float span = max(0.38, 1.0 - aDelay);
    float open = smoothstep(0.0, 1.0, clamp((uBloom - aDelay) / span, 0.0, 1.0));

    vec3 p = mix(aBud, position, open);

    // A little weightless swirl while the petals travel between states.
    float transition = sin(open * 3.14159265);
    p.x += (aSeed.x - 0.5) * transition * 0.10;
    p.y += (aSeed.y - 0.5) * transition * 0.11;
    p.z += transition * (0.08 + aSeed.z * 0.12);

    float t = uTime;
    float wind = 0.010 + open * 0.023;
    p.x += sin(t * 0.54 + aSeed.x * 6.283 + p.y * 0.85) * wind;
    p.y += cos(t * 0.43 + aSeed.y * 6.283 + p.x * 0.65) * wind * 0.72;
    p.z += sin(t * 0.78 + aSeed.z * 6.283) * (0.012 + open * 0.016);

    // Fine petal trembling, concentrated around the edges.
    p.z += sin(t * 1.7 + aSeed.w * 18.0 + p.y * 2.4) * 0.013 * open * (0.35 + aEdge);

    vec2 radial = normalize(p.xy + vec2(0.0001));
    p.xy += radial * uPulse * (0.10 + aSeed.x * 0.30);

    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    float contour = smoothstep(0.26, 0.82, aEdge);
    float softFill = 1.0 - contour;
    vSoft = softFill;
    float perspective = clamp(9.2 / max(4.0, -mvPosition.z), 0.72, 1.38);
    gl_PointSize = aSize * uPointSize * uPixelRatio * perspective
      * (1.0 + uPulse * 0.7)
      * mix(uFillSize, 1.0, contour);

    float twinkle = 0.84 + 0.16 * sin(t * 1.9 + aSeed.w * 29.0);
    vColor = aColor * twinkle * uBrightness;
    vAlpha = mix(0.34, 0.95, aEdge)
      * (0.92 + 0.08 * sin(t * 1.2 + aSeed.x * 9.0))
      * mix(uFillAlpha, 1.0, contour)
      * uAlphaScale;
    vFlare = step(0.965, aSeed.w) * (0.5 + 0.5 * sin(t * 2.6 + aSeed.z * 31.0));
  }
`;

const petalFragmentShader = /* glsl */ `
  precision highp float;

  varying vec3 vColor;
  varying float vAlpha;
  varying float vFlare;
  varying float vSoft;

  void main() {
    vec2 center = gl_PointCoord - 0.5;
    float distanceToCenter = length(center) * 2.0;
    if (distanceToCenter > 1.0) discard;

    float core = pow(1.0 - distanceToCenter, mix(4.0, 1.55, vSoft));
    float halo = pow(1.0 - distanceToCenter, mix(1.35, 2.5, vSoft));
    float alpha = (core * mix(0.58, 0.13, vSoft) + halo * mix(0.18, 0.42, vSoft)) * vAlpha;
    vec3 color = vColor * (mix(0.56, 0.72, vSoft) + core * mix(1.06, 0.62, vSoft));

    // A handful of pollen grains carry a soft four-point glint.
    if (vFlare > 0.2) {
      float cross = max(
        1.0 - smoothstep(0.0, 0.12, abs(center.x)),
        1.0 - smoothstep(0.0, 0.12, abs(center.y))
      );
      color += vColor * cross * vFlare * 0.35 * (1.0 - distanceToCenter);
      alpha += cross * vFlare * 0.045;
    }

    gl_FragColor = vec4(color, alpha);
  }
`;

const petalMistVertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uBloom;
  uniform float uPulse;

  attribute vec3 aBud;
  attribute vec3 aColor;
  attribute float aDelay;

  varying vec2 vUv;
  varying vec3 vColor;
  varying float vOpen;

  void main() {
    float span = max(0.38, 1.0 - aDelay);
    float open = smoothstep(0.0, 1.0, clamp((uBloom - aDelay) / span, 0.0, 1.0));
    vec3 p = mix(aBud, position, open);

    float transition = sin(open * 3.14159265);
    p.z += transition * 0.08;
    float t = uTime;
    p.x += sin(t * 0.54 + aDelay * 18.0 + p.y * 0.85) * (0.008 + open * 0.018);
    p.y += cos(t * 0.43 + aDelay * 14.0 + p.x * 0.65) * (0.006 + open * 0.012);
    p.z += sin(t * 0.78 + aDelay * 24.0) * (0.01 + open * 0.012);

    vec2 radial = normalize(p.xy + vec2(0.0001));
    p.xy += radial * uPulse * 0.16;

    vUv = uv;
    vColor = aColor;
    vOpen = open;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const petalMistFragmentShader = /* glsl */ `
  precision highp float;
  uniform float uMistOpacity;
  uniform float uTime;

  varying vec2 vUv;
  varying vec3 vColor;
  varying float vOpen;

  void main() {
    float lateral = abs(vUv.y);
    float sideFade = 1.0 - smoothstep(0.48, 1.0, lateral);
    float baseFade = smoothstep(0.0, 0.1, vUv.x);
    float tipFade = 1.0 - smoothstep(0.78, 1.0, vUv.x);
    float body = sideFade * baseFade * tipFade;

    float veins = 0.88 + 0.12 * sin(vUv.y * 34.0 + vUv.x * 4.0 + uTime * 0.3);
    float alpha = body * uMistOpacity * (0.35 + vOpen * 0.8) * veins;
    vec3 color = vColor * (0.55 + (1.0 - lateral) * 0.35);

    gl_FragColor = vec4(color, alpha);
  }
`;

function makePetalMistGeometry() {
  const random = mulberry32(0x7f4a7c15);
  const positions = [];
  const buds = [];
  const colors = [];
  const uvs = [];
  const delays = [];
  const indices = [];
  const baseColor = new THREE.Color();
  const tipColor = new THREE.Color();
  const color = new THREE.Color();
  const across = 9;

  for (const ring of RING_CONFIG) {
    baseColor.set(ring.baseColor);
    tipColor.set(ring.tipColor);

    for (let petal = 0; petal < ring.petals; petal += 1) {
      const baseAngle = ring.offset + (petal / ring.petals) * TAU + (random() - 0.5) * 0.026;
      const lengthScale = 0.9 + random() * 0.17;
      const zTilt = (random() - 0.5) * 0.16;
      const delay = clamp(ring.delay + petal * 0.0025 + random() * 0.035, 0, 0.44);
      const startIndex = positions.length / 3;
      const along = 20;

      for (let iy = 0; iy <= across; iy += 1) {
        const lateral = -1 + (iy / across) * 2;
        for (let ix = 0; ix <= along; ix += 1) {
          const t = ix / along;
          const widthProfile = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.94)), 0.62);
          const halfAngle = ring.width * widthProfile;
          const theta = baseAngle + ring.twist * t + lateral * halfAngle;
          const ripple = Math.sin(lateral * 4.7 + petal * 1.7 + t * 4.2) * 0.024 * t * t;
          const radial = ring.radius + ring.length * lengthScale * t
            + ring.length * 0.03 * Math.cos(lateral * Math.PI * 0.5) * t
            + ripple;
          const x = Math.cos(theta) * radial;
          const y = Math.sin(theta) * radial;
          const z = ring.z
            + ring.cup * (lateral * lateral) * Math.pow(t, 1.35)
            + ring.tipRise * t * t
            + zTilt * t;

          const profile = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.88)), 0.72);
          const budRadius = ring.budRadius * (0.08 + 0.92 * profile) * (1 + Math.abs(lateral) * 0.055);
          const budAngle = baseAngle
            + ring.budTwist * t
            + lateral * ring.budWidth * (0.45 + 0.55 * Math.sin(Math.PI * t));
          const budX = Math.cos(budAngle) * budRadius;
          const budZ = Math.sin(budAngle) * budRadius;
          const budY = -0.92 + t * ring.budHeight + Math.abs(lateral) * 0.022;

          positions.push(x, y, z);
          buds.push(budX, budY, budZ);
          uvs.push(t, lateral);
          delays.push(delay);
          color.copy(baseColor).lerp(tipColor, clamp((t - 0.08) / 0.92, 0, 1));
          colors.push(color.r, color.g, color.b);
        }
      }

      for (let iy = 0; iy < across; iy += 1) {
        for (let ix = 0; ix < along; ix += 1) {
          const a = startIndex + iy * (along + 1) + ix;
          const b = a + 1;
          const c = a + (along + 1);
          const d = c + 1;
          indices.push(a, c, b, b, c, d);
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aBud', new THREE.Float32BufferAttribute(buds, 3));
  geometry.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('aDelay', new THREE.Float32BufferAttribute(delays, 1));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

const backgroundVertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const backgroundFragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform float uAspect;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
      mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }

  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 4; i++) {
      value += amplitude * noise(p);
      p = p * 2.02 + 19.7;
      amplitude *= 0.5;
    }
    return value;
  }

  void main() {
    vec2 uv = vUv;
    vec2 centered = uv - 0.5;
    centered.x *= uAspect;

    vec3 color = vec3(0.0105, 0.0080, 0.0165);
    color += vec3(0.0060, 0.0045, 0.0090) * (1.0 - smoothstep(0.0, 0.95, length(centered)));

    float cloud = fbm(uv * vec2(3.0 * uAspect, 3.0) + vec2(uTime * 0.003, -uTime * 0.0025));
    color += mix(vec3(0.0055, 0.0040, 0.0090), vec3(0.0180, 0.0070, 0.0170), cloud);

    vec2 roseCenter = vec2(0.64, 0.52);
    vec2 roseVector = uv - roseCenter;
    roseVector.x *= uAspect;
    float roseGlow = exp(-length(roseVector) * 4.6);
    color += vec3(0.031, 0.007, 0.016) * roseGlow * (0.55 + cloud * 0.6);

    vec2 tealCenter = vec2(0.22, 0.68);
    vec2 tealVector = uv - tealCenter;
    tealVector.x *= uAspect;
    float tealGlow = exp(-length(tealVector) * 5.4);
    color += vec3(0.004, 0.012, 0.012) * tealGlow;

    // Sparse, slowly revolving stars.
    vec2 starSpace = uv;
    starSpace.x *= uAspect;
    vec2 starGrid = starSpace * 44.0;
    vec2 starId = floor(starGrid);
    vec2 starCell = fract(starGrid) - 0.5;
    float starHash = hash21(starId);
    vec2 starOffset = vec2(hash21(starId + 7.1), hash21(starId + 13.7)) - 0.5;
    float starShape = smoothstep(0.052, 0.0, length(starCell - starOffset * 0.7));
    float twinkle = 0.55 + 0.45 * sin(uTime * 0.7 + starHash * 34.0);
    float star = smoothstep(0.984, 1.0, starHash) * starShape * twinkle;
    color += mix(vec3(0.6, 0.55, 0.42), vec3(0.42, 0.62, 0.6), starHash) * star * 0.33;

    color *= 1.0 - smoothstep(0.33, 0.92, length(centered)) * 0.5;
    gl_FragColor = vec4(color, 1.0);
  }
`;

const auraFragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uBloom;
  uniform float uTime;

  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float glow = exp(-d * d * 4.6);
    float inner = exp(-d * d * 14.0);
    float ring = smoothstep(0.028, 0.0, abs(d - 0.57)) * 0.025;

    vec3 rose = vec3(0.56, 0.13, 0.24);
    vec3 gold = vec3(1.0, 0.58, 0.27);
    vec3 color = mix(rose, gold, smoothstep(0.95, 0.06, d));
    float breathe = 0.92 + 0.08 * sin(uTime * 0.7);
    float alpha = (glow * 0.012 + inner * 0.018 + ring * glow) * (0.62 + uBloom * 0.55) * breathe;
    gl_FragColor = vec4(color, alpha);
  }
`;

const dustVertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uBloom;
  uniform float uPixelRatio;
  uniform float uPointSize;

  attribute vec4 aSeed;
  attribute vec3 aColor;
  attribute float aSize;

  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec3 p = position;
    float angle = uTime * (0.025 + aSeed.x * 0.045) * (aSeed.y > 0.5 ? 1.0 : -1.0);
    float c = cos(angle);
    float s = sin(angle);
    p.xy = mat2(c, -s, s, c) * p.xy;

    p.x += sin(uTime * 0.22 + aSeed.z * 6.283) * 0.16;
    p.y += cos(uTime * 0.18 + aSeed.x * 6.283) * 0.12;
    p.z += sin(uTime * 0.31 + aSeed.y * 6.283) * 0.14;

    float radius = mix(0.70, 1.0, uBloom);
    p.xy *= radius;

    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = aSize * uPointSize * uPixelRatio * clamp(8.0 / max(4.0, -mvPosition.z), 0.7, 1.4);

    float flicker = 0.4 + 0.6 * (0.5 + 0.5 * sin(uTime * 1.1 + aSeed.w * 37.0));
    vColor = aColor;
    vAlpha = flicker * (0.16 + uBloom * 0.22) * (0.5 + aSeed.z * 0.5);
  }
`;

const dustFragmentShader = /* glsl */ `
  precision highp float;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float core = pow(1.0 - d, 3.0);
    gl_FragColor = vec4(vColor * (0.6 + core * 1.4), core * vAlpha);
  }
`;

const burstVertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uBurstTime;
  uniform float uDirection;
  uniform float uPixelRatio;
  uniform float uPointSize;

  attribute vec3 aDirection;
  attribute vec3 aColor;
  attribute vec4 aSeed;
  attribute float aSize;
  attribute float aDelay;

  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    float age = (uTime - uBurstTime - aDelay * 0.12) / 1.55;
    float live = step(0.0, age) * step(age, 1.0);

    float eased = 1.0 - pow(1.0 - clamp(age, 0.0, 1.0), 2.2);
    float startRadius = uDirection > 0.0 ? 0.06 : 2.7;
    float endRadius = uDirection > 0.0 ? 2.55 : 0.04;
    float radius = mix(startRadius, endRadius, eased);

    vec3 p = aDirection * radius;
    p.z += sin(clamp(age, 0.0, 1.0) * 3.14159) * (0.25 + aSeed.x * 0.55);
    p.xy += vec2(
      sin(age * 8.0 + aSeed.y * 8.0),
      cos(age * 7.0 + aSeed.z * 8.0)
    ) * 0.08 * sin(clamp(age, 0.0, 1.0) * 3.14159);

    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = live * aSize * uPointSize * uPixelRatio * (1.0 - age * 0.4);

    vColor = aColor;
    vAlpha = sin(clamp(age, 0.0, 1.0) * 3.14159) * 0.9 * live;
  }
`;

const burstFragmentShader = /* glsl */ `
  precision highp float;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float core = pow(1.0 - d, 3.2);
    gl_FragColor = vec4(vColor * (0.8 + core * 1.6), core * vAlpha);
  }
`;

const RING_CONFIG = [
  {
    petals: 9,
    length: 2.18,
    radius: 0.17,
    width: 0.31,
    cup: 0.30,
    z: -0.42,
    tipRise: 0.18,
    twist: 0.11,
    offset: 0,
    delay: 0.0,
    particles: 700,
    edgePerSide: 54,
    veins: 24,
    budRadius: 0.43,
    budHeight: 2.02,
    budWidth: 0.56,
    budTwist: 0.52,
    baseColor: '#ff4f6d',
    tipColor: '#ffb070',
    edgeColor: '#ff8a96',
  },
  {
    petals: 8,
    length: 1.77,
    radius: 0.14,
    width: 0.33,
    cup: 0.24,
    z: -0.19,
    tipRise: 0.15,
    twist: -0.13,
    offset: 0.31,
    delay: 0.09,
    particles: 600,
    edgePerSide: 50,
    veins: 22,
    budRadius: 0.34,
    budHeight: 1.9,
    budWidth: 0.58,
    budTwist: -0.38,
    baseColor: '#ff7f4f',
    tipColor: '#ffd995',
    edgeColor: '#ffc58a',
  },
  {
    petals: 7,
    length: 1.33,
    radius: 0.11,
    width: 0.36,
    cup: 0.18,
    z: 0.0,
    tipRise: 0.11,
    twist: 0.16,
    offset: 0.63,
    delay: 0.19,
    particles: 520,
    edgePerSide: 44,
    veins: 20,
    budRadius: 0.25,
    budHeight: 1.74,
    budWidth: 0.62,
    budTwist: 0.44,
    baseColor: '#ffae58',
    tipColor: '#fff1c2',
    edgeColor: '#ffe7b2',
  },
  {
    petals: 5,
    length: 0.87,
    radius: 0.08,
    width: 0.4,
    cup: 0.12,
    z: 0.13,
    tipRise: 0.08,
    twist: -0.2,
    offset: 1.02,
    delay: 0.3,
    particles: 440,
    edgePerSide: 38,
    veins: 16,
    budRadius: 0.16,
    budHeight: 1.5,
    budWidth: 0.68,
    budTwist: -0.55,
    baseColor: '#ffc46f',
    tipColor: '#fffdf4',
    edgeColor: '#fff3d2',
  },
];

function createGlowTexture() {
  const size = 192;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  const center = size / 2;

  const gradient = context.createRadialGradient(center, center, 0, center, center, center);
  gradient.addColorStop(0, 'rgba(255, 250, 235, 1)');
  gradient.addColorStop(0.08, 'rgba(255, 232, 193, 0.95)');
  gradient.addColorStop(0.22, 'rgba(255, 196, 138, 0.5)');
  gradient.addColorStop(0.52, 'rgba(239, 128, 122, 0.12)');
  gradient.addColorStop(1, 'rgba(239, 128, 122, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);

  context.globalCompositeOperation = 'lighter';
  context.strokeStyle = 'rgba(255, 244, 218, 0.46)';
  context.lineWidth = 1.2;
  context.beginPath();
  context.moveTo(center, 8);
  context.lineTo(center, size - 8);
  context.moveTo(8, center);
  context.lineTo(size - 8, center);
  context.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function makePetalGeometry() {
  const random = mulberry32(0x9e3779b9);
  const positions = [];
  const buds = [];
  const colors = [];
  const seeds = [];
  const sizes = [];
  const delays = [];
  const edges = [];

  const baseColor = new THREE.Color();
  const tipColor = new THREE.Color();
  const edgeColor = new THREE.Color();
  const color = new THREE.Color();
  const white = new THREE.Color('#fff8e8');

  for (const ring of RING_CONFIG) {
    baseColor.set(ring.baseColor);
    tipColor.set(ring.tipColor);
    edgeColor.set(ring.edgeColor);

    for (let petal = 0; petal < ring.petals; petal += 1) {
      const baseAngle = ring.offset + (petal / ring.petals) * TAU + (random() - 0.5) * 0.026;
      const lengthScale = 0.9 + random() * 0.17;
      const zTilt = (random() - 0.5) * 0.16;
      const delay = clamp(ring.delay + petal * 0.0025 + random() * 0.035, 0, 0.44);

      function addParticle(t, v, edgeKind) {
        const clampedT = clamp(t, 0, 1);
        const lateral = clamp(v, -1, 1);
        const widthProfile = Math.pow(Math.sin(Math.PI * Math.pow(clampedT, 0.94)), 0.62);
        const halfAngle = ring.width * widthProfile;
        const theta = baseAngle + ring.twist * clampedT + lateral * halfAngle;
        const ripple = Math.sin(lateral * 4.7 + petal * 1.7 + clampedT * 4.2) * 0.024 * clampedT * clampedT;
        const radial = ring.radius + ring.length * lengthScale * clampedT
          + ring.length * 0.03 * Math.cos(lateral * Math.PI * 0.5) * clampedT
          + ripple;

        const x = Math.cos(theta) * radial;
        const y = Math.sin(theta) * radial;
        const z = ring.z
          + ring.cup * (lateral * lateral) * Math.pow(clampedT, 1.35)
          + ring.tipRise * clampedT * clampedT
          + zTilt * clampedT
          + (random() - 0.5) * 0.024;

        // Closed bud: petals wrap around the vertical axis in a teardrop shell.
        const profile = Math.pow(
          Math.sin(Math.PI * Math.pow(clampedT, 0.88)),
          0.72,
        );
        const budRadius = ring.budRadius * (0.08 + 0.92 * profile) * (1 + Math.abs(lateral) * 0.055);
        const budAngle = baseAngle
          + ring.budTwist * clampedT
          + lateral * ring.budWidth * (0.45 + 0.55 * Math.sin(Math.PI * clampedT));
        const budX = Math.cos(budAngle) * budRadius;
        const budZ = Math.sin(budAngle) * budRadius;
        const budY = -0.92 + clampedT * ring.budHeight
          + Math.abs(lateral) * 0.022
          + (random() - 0.5) * 0.018;

        positions.push(x, y, z);
        buds.push(budX, budY, budZ);
        seeds.push(random(), random(), random(), random());

        color.copy(baseColor).lerp(tipColor, clamp((clampedT - 0.08) / 0.92, 0, 1));
        if (edgeKind === 'edge') {
          color.lerp(edgeColor, 0.55);
        } else if (edgeKind === 'vein') {
          color.lerp(white, 0.28);
        } else if (random() > 0.93) {
          color.lerp(white, 0.15);
        }
        color.multiplyScalar(0.9 + random() * 0.16);
        colors.push(color.r, color.g, color.b);

        let size = 0.46 + random() * 0.56;
        let edgeValue = 0;
        if (edgeKind === 'edge') {
          size = 0.84 + random() * 0.55;
          edgeValue = 1;
        } else if (edgeKind === 'vein') {
          size = 0.58 + random() * 0.38;
          edgeValue = 0.58;
        }
        if (random() > 0.985) size += 0.8;

        sizes.push(size);
        delays.push(delay);
        edges.push(edgeValue);
      }

      // Interior grains.
      for (let particle = 0; particle < ring.particles; particle += 1) {
        const t = Math.pow(random(), 0.92);
        const v = random() * 2 - 1;
        addParticle(t, v, 'fill');
      }

      // A continuous, luminous petal contour on both sides. This is what makes
      // the flower read as a flower rather than a cloud of dust.
      for (const side of [-1, 1]) {
        for (let index = 0; index < ring.edgePerSide; index += 1) {
          const t = (index + 0.35 + random() * 0.5) / ring.edgePerSide;
          const v = side * (0.94 + random() * 0.06);
          addParticle(t, v, 'edge');
        }
      }

      // A delicate central vein.
      for (let index = 0; index < ring.veins; index += 1) {
        const t = 0.06 + (index / Math.max(1, ring.veins - 1)) * 0.88;
        const v = Math.sin(t * Math.PI * 2.1 + petal * 1.3) * 0.045;
        addParticle(t, v, 'vein');
      }
    }
  }

  // Golden heart and stamen grains.
  const heartBase = new THREE.Color('#ffd27d');
  const heartTip = new THREE.Color('#fffdf4');
  for (let particle = 0; particle < 640; particle += 1) {
    const isStamen = particle % 4 === 0;
    const angle = random() * TAU;
    let radius;
    let x;
    let y;
    let z;

    if (isStamen) {
      radius = 0.2 + Math.pow(random(), 0.6) * 0.48;
      x = Math.cos(angle) * radius;
      y = Math.sin(angle) * radius * 0.92;
      z = 0.22 + random() * 0.36;
    } else {
      radius = Math.sqrt(random()) * 0.29;
      x = Math.cos(angle) * radius;
      y = Math.sin(angle) * radius;
      z = 0.18 + random() * 0.1;
    }

    const budX = (random() - 0.5) * 0.14;
    const budY = 0.06 + (random() - 0.5) * 0.42;
    const budZ = (random() - 0.5) * 0.12;

    positions.push(x, y, z);
    buds.push(budX, budY, budZ);
    seeds.push(random(), random(), random(), random());

    color.copy(heartBase).lerp(heartTip, random());
    color.multiplyScalar(0.88 + random() * 0.2);
    colors.push(color.r, color.g, color.b);

    sizes.push(isStamen ? 0.75 + random() * 0.9 : 0.48 + random() * 0.68);
    delays.push(clamp(0.32 + random() * 0.08, 0, 0.42));
    edges.push(random() > 0.75 ? 0.8 : 0.25);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aBud', new THREE.Float32BufferAttribute(buds, 3));
  geometry.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 4));
  geometry.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 1));
  geometry.setAttribute('aDelay', new THREE.Float32BufferAttribute(delays, 1));
  geometry.setAttribute('aEdge', new THREE.Float32BufferAttribute(edges, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

function makeDustGeometry() {
  const random = mulberry32(0x85ebca6b);
  const count = 600;
  const positions = [];
  const colors = [];
  const seeds = [];
  const sizes = [];
  const gold = new THREE.Color('#ffc887');
  const rose = new THREE.Color('#f38d92');
  const teal = new THREE.Color('#82e0cf');
  const color = new THREE.Color();

  for (let i = 0; i < count; i += 1) {
    const angle = random() * TAU;
    const radius = 1.75 + Math.pow(random(), 0.62) * 3.5;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius * (0.62 + random() * 0.38);
    const z = -1.1 + random() * 2.4;
    positions.push(x, y, z);
    seeds.push(random(), random(), random(), random());

    const type = random();
    if (type > 0.78) {
      color.copy(teal);
    } else if (type > 0.5) {
      color.copy(rose);
    } else {
      color.copy(gold);
    }
    color.multiplyScalar(0.7 + random() * 0.45);
    colors.push(color.r, color.g, color.b);
    sizes.push(0.42 + Math.pow(random(), 2) * 1.5);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 4));
  geometry.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 1));
  return geometry;
}

function makeBurstGeometry() {
  const random = mulberry32(0x27d4eb2f);
  const count = 420;
  const directions = [];
  const colors = [];
  const seeds = [];
  const sizes = [];
  const delays = [];
  const gold = new THREE.Color('#ffd18e');
  const rose = new THREE.Color('#ff8c88');
  const teal = new THREE.Color('#93e7d4');
  const color = new THREE.Color();

  for (let i = 0; i < count; i += 1) {
    const theta = random() * TAU;
    const z = (random() - 0.5) * 1.4;
    const planar = Math.sqrt(Math.max(0, 1 - z * z));
    const speed = 0.55 + random() * 0.55;
    directions.push(Math.cos(theta) * planar * speed, Math.sin(theta) * planar * speed, z * speed);
    seeds.push(random(), random(), random(), random());
    const type = random();
    color.copy(type > 0.82 ? teal : type > 0.5 ? gold : rose);
    color.multiplyScalar(0.8 + random() * 0.3);
    colors.push(color.r, color.g, color.b);
    sizes.push(1.1 + random() * 2.6);
    delays.push(random() * 0.8);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute('aDirection', new THREE.Float32BufferAttribute(directions, 3));
  geometry.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('aSeed', new THREE.Float32BufferAttribute(seeds, 4));
  geometry.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 1));
  geometry.setAttribute('aDelay', new THREE.Float32BufferAttribute(delays, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
  return geometry;
}

export class FlowerScene {
  constructor(canvas, { reducedMotion = false } = {}) {
    this.canvas = canvas;
    this.reducedMotion = reducedMotion;
    this.width = 0;
    this.height = 0;
    this.dpr = Math.min(window.devicePixelRatio || 1, window.matchMedia('(max-width: 760px)').matches ? 1.6 : 1.85);
    this.time = 0;
    this.pulse = 0;
    this.bloom = 0.32;
    this.baseScale = 0.96;
    this.currentScale = 0.96;
    this.anchorWorld = new THREE.Vector3();
    this.cameraDistance = CAMERA_DISTANCE;
    this.visibleHeight = 0;
    this.visibleWidth = 0;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.28;
    this.renderer.setClearColor(0x06050b, 1);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x06050b);

    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 100);
    this.camera.position.set(0, 0, CAMERA_DISTANCE);
    this.camera.lookAt(0, 0, 0);

    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(1024, 1024),
      0.33,
      0.3,
      0.56,
    );
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());

    this.createBackground();
    this.createFlower();
    this.createTipSpark();

    this.resize();
    this.onResize = () => this.resize();
    window.addEventListener('resize', this.onResize);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    if (canvas.parentElement) this.resizeObserver.observe(canvas.parentElement);
    this._tempWorld = new THREE.Vector3();
    this._lastTick = performance.now();
  }

  createBackground() {
    const geometry = new THREE.PlaneGeometry(1, 1);
    this.backgroundMaterial = new THREE.ShaderMaterial({
      vertexShader: backgroundVertexShader,
      fragmentShader: backgroundFragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uAspect: { value: 1 },
      },
      depthWrite: false,
      depthTest: false,
    });
    this.background = new THREE.Mesh(geometry, this.backgroundMaterial);
    this.background.scale.set(88, 54, 1);
    this.background.position.z = -16;
    this.background.frustumCulled = false;
    this.scene.add(this.background);
  }

  createFlower() {
    this.group = new THREE.Group();
    this.group.position.set(0.6, 0, 0);
    this.scene.add(this.group);

    const mistGeometry = makePetalMistGeometry();
    this.mistMaterial = new THREE.ShaderMaterial({
      vertexShader: petalMistVertexShader,
      fragmentShader: petalMistFragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uBloom: { value: 0.3 },
        uPulse: { value: 0 },
        uMistOpacity: { value: 0.3 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.petalMist = new THREE.Mesh(mistGeometry, this.mistMaterial);
    this.petalMist.frustumCulled = false;
    this.petalMist.renderOrder = 1;
    this.group.add(this.petalMist);

    const petalGeometry = makePetalGeometry();
    const petalMaterial = new THREE.ShaderMaterial({
      vertexShader: petalVertexShader,
      fragmentShader: petalFragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uBloom: { value: 0.3 },
        uPointSize: { value: 3.2 },
        uPixelRatio: { value: this.dpr },
        uPulse: { value: 0 },
        uAlphaScale: { value: 2.4 },
        uBrightness: { value: 1.8 },
        uFillSize: { value: 2.4 },
        uFillAlpha: { value: 0.22 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.flowerPoints = new THREE.Points(petalGeometry, petalMaterial);
    this.flowerPoints.frustumCulled = false;
    this.flowerPoints.renderOrder = 3;
    this.group.add(this.flowerPoints);

    this.auraMaterial = new THREE.ShaderMaterial({
      vertexShader: backgroundVertexShader,
      fragmentShader: auraFragmentShader,
      uniforms: {
        uBloom: { value: 0.3 },
        uTime: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.aura = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.auraMaterial);
    this.aura.scale.set(6.4, 6.4, 1);
    this.aura.position.z = -1.1;
    this.aura.renderOrder = 0;
    this.group.add(this.aura);

    const dustGeometry = makeDustGeometry();
    this.dustMaterial = new THREE.ShaderMaterial({
      vertexShader: dustVertexShader,
      fragmentShader: dustFragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uBloom: { value: 0.3 },
        uPixelRatio: { value: this.dpr },
        uPointSize: { value: 2.1 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.dust = new THREE.Points(dustGeometry, this.dustMaterial);
    this.dust.frustumCulled = false;
    this.dust.renderOrder = 2;
    this.group.add(this.dust);

    const burstGeometry = makeBurstGeometry();
    this.burstMaterial = new THREE.ShaderMaterial({
      vertexShader: burstVertexShader,
      fragmentShader: burstFragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uBurstTime: { value: -10 },
        uDirection: { value: 1 },
        uPixelRatio: { value: this.dpr },
        uPointSize: { value: 2.2 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.burst = new THREE.Points(burstGeometry, this.burstMaterial);
    this.burst.frustumCulled = false;
    this.burst.renderOrder = 4;
    this.group.add(this.burst);
  }

  createTipSpark() {
    const texture = createGlowTexture();
    this.glowTexture = texture;
    const material = new THREE.SpriteMaterial({
      map: texture,
      color: 0xffd9a4,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.tipSpark = new THREE.Sprite(material);
    this.tipSpark.scale.set(0.55, 0.55, 1);
    this.tipSpark.renderOrder = 10;
    this.scene.add(this.tipSpark);

    const haloMaterial = material.clone();
    haloMaterial.opacity = 0;
    haloMaterial.color = new THREE.Color(0xf58c93);
    this.tipHalo = new THREE.Sprite(haloMaterial);
    this.tipHalo.scale.set(1.45, 1.45, 1);
    this.tipHalo.renderOrder = 9;
    this.scene.add(this.tipHalo);

    const heartMaterial = new THREE.SpriteMaterial({
      map: texture,
      color: 0xffd6a1,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.heartGlow = new THREE.Sprite(heartMaterial);
    this.heartGlow.scale.set(1.45, 1.45, 1);
    this.heartGlow.position.z = 0.42;
    this.heartGlow.renderOrder = 6;
    this.group.add(this.heartGlow);

    const heartHaloMaterial = heartMaterial.clone();
    heartHaloMaterial.color = new THREE.Color(0xf89287);
    heartHaloMaterial.opacity = 0.07;
    this.heartHalo = new THREE.Sprite(heartHaloMaterial);
    this.heartHalo.scale.set(3.3, 3.3, 1);
    this.heartHalo.position.z = 0.3;
    this.heartHalo.renderOrder = 5;
    this.group.add(this.heartHalo);

    this.tipTarget = new THREE.Vector3(0, 0, 0.4);
    this.tipOpacity = 0;
  }

  resize() {
    const parent = this.canvas.parentElement;
    const width = Math.max(1, parent?.clientWidth || window.innerWidth);
    const height = Math.max(1, parent?.clientHeight || window.innerHeight);
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.dpr = Math.min(window.devicePixelRatio || 1, window.matchMedia('(max-width: 760px)').matches ? 1.6 : 1.85);

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(width, height, false);
    this.composer.setPixelRatio(this.dpr);
    this.composer.setSize(width, height);
    this.flowerPoints.material.uniforms.uPixelRatio.value = this.dpr;
    this.dustMaterial.uniforms.uPixelRatio.value = this.dpr;
    this.burstMaterial.uniforms.uPixelRatio.value = this.dpr;
    this.backgroundMaterial.uniforms.uAspect.value = width / height;

    this.visibleHeight = 2 * Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV / 2)) * CAMERA_DISTANCE;
    this.visibleWidth = this.visibleHeight * (width / height);
    const widthFit = (this.visibleWidth * 0.82) / (FLOWER_RADIUS * 2);
    const heightFit = (this.visibleHeight * 0.9) / (FLOWER_RADIUS * 2);
    this.baseScale = clamp(Math.min(0.96, widthFit, heightFit), 0.42, 0.98);
  }

  normalizedToWorld(x, y, depth = 0) {
    const vector = new THREE.Vector3(x * 2 - 1, -(y * 2 - 1), 0.5);
    vector.unproject(this.camera);
    vector.sub(this.camera.position).normalize();
    const distance = (depth - this.camera.position.z) / vector.z;
    vector.multiplyScalar(distance).add(this.camera.position);
    return vector;
  }

  getAnchorLimits() {
    const radiusX = (FLOWER_RADIUS * this.baseScale * 0.92) / this.visibleWidth;
    const radiusY = (FLOWER_RADIUS * this.baseScale * 0.92) / this.visibleHeight;
    return {
      minX: clamp(radiusX + 0.035, 0.16, 0.42),
      maxX: clamp(1 - radiusX - 0.035, 0.58, 0.84),
      minY: clamp(radiusY + 0.045, 0.2, 0.44),
      maxY: clamp(1 - radiusY - 0.045, 0.56, 0.8),
    };
  }

  setBloom(value) {
    this.bloom = clamp(value, 0, 1);
  }

  triggerBurst(opening = true) {
    this.burstMaterial.uniforms.uBurstTime.value = this.time;
    this.burstMaterial.uniforms.uDirection.value = opening ? 1 : -1;
    this.pulse = Math.min(1.1, this.pulse + 0.72);
  }

  update({
    delta,
    bloom,
    anchorX,
    anchorY,
    handScale = 1,
    tilt = 0,
    tipX,
    tipY,
    tipVisible = false,
  }) {
    const dt = Math.min(Math.max(delta, 0), 0.08);
    this.time += dt;
    this.setBloom(bloom);

    const limits = this.getAnchorLimits();
    const targetX = clamp(anchorX, limits.minX, limits.maxX);
    const targetY = clamp(anchorY, limits.minY, limits.maxY);
    const targetWorld = this.normalizedToWorld(targetX, targetY, 0);
    this.anchorWorld.x = damp(this.anchorWorld.x, targetWorld.x, 7.5, dt);
    this.anchorWorld.y = damp(this.anchorWorld.y, targetWorld.y, 7.5, dt);

    if (this.anchorWorld.lengthSq() === 0) {
      this.anchorWorld.set(targetWorld.x, targetWorld.y, 0);
    }

    this.currentScale = damp(this.currentScale, this.baseScale * handScale, 4.2, dt);
    this.group.position.x = this.anchorWorld.x;
    this.group.position.y = this.anchorWorld.y;

    const reduced = this.reducedMotion;
    const swayX = reduced ? 0 : Math.sin(this.time * 0.21) * 0.045;
    const swayY = reduced ? 0 : Math.cos(this.time * 0.17) * 0.032;

    this.group.scale.setScalar(this.currentScale);
    this.group.rotation.z = damp(
      this.group.rotation.z,
      tilt + (reduced ? 0 : Math.sin(this.time * 0.16) * 0.015),
      4,
      dt,
    );
    this.group.rotation.x = damp(
      this.group.rotation.x,
      -0.06 + (anchorY - 0.5) * 0.18 + swayY,
      3.2,
      dt,
    );
    this.group.rotation.y = damp(
      this.group.rotation.y,
      (anchorX - 0.5) * 0.3 + swayX + (reduced ? 0 : Math.sin(this.time * 0.13) * 0.022),
      3.2,
      dt,
    );

    this.pulse = Math.max(0, this.pulse - dt * 1.8);

    this.flowerPoints.material.uniforms.uTime.value = this.time;
    this.flowerPoints.material.uniforms.uBloom.value = this.bloom;
    this.flowerPoints.material.uniforms.uPulse.value = this.pulse;
    this.mistMaterial.uniforms.uTime.value = this.time;
    this.mistMaterial.uniforms.uBloom.value = this.bloom;
    this.mistMaterial.uniforms.uPulse.value = this.pulse;
    this.dustMaterial.uniforms.uTime.value = this.time;
    this.dustMaterial.uniforms.uBloom.value = this.bloom;
    this.burstMaterial.uniforms.uTime.value = this.time;
    this.auraMaterial.uniforms.uBloom.value = this.bloom;
    this.auraMaterial.uniforms.uTime.value = this.time;
    this.backgroundMaterial.uniforms.uTime.value = this.time;

    this.bloomPass.strength = 0.3 + this.bloom * 0.08 + this.pulse * 0.07;

    const heartPulse = 0.9 + 0.1 * Math.sin(this.time * 1.1);
    this.heartGlow.material.opacity = (0.24 + this.bloom * 0.36 + this.pulse * 0.16) * heartPulse;
    this.heartHalo.material.opacity = (0.025 + this.bloom * 0.05 + this.pulse * 0.03) * heartPulse;
    this.heartGlow.scale.setScalar(1.15 + this.bloom * 0.45);
    this.heartHalo.scale.setScalar(3.0 + this.bloom * 0.5);

    if (Number.isFinite(tipX) && Number.isFinite(tipY)) {
      this.tipTarget.copy(this.normalizedToWorld(clamp(tipX, 0, 1), clamp(tipY, 0, 1), 0.45));
    }
    this.tipSpark.position.lerp(this.tipTarget, 1 - Math.exp(-10 * dt));
    this.tipHalo.position.copy(this.tipSpark.position);
    const targetOpacity = tipVisible ? 0.8 : 0;
    this.tipOpacity = damp(this.tipOpacity, targetOpacity, 5, dt);
    this.tipSpark.material.opacity = this.tipOpacity * 0.86;
    this.tipHalo.material.opacity = this.tipOpacity * 0.1;
    const sparkScale = 0.8 + this.bloom * 0.35 + this.pulse * 0.12;
    this.tipSpark.scale.setScalar(0.55 * sparkScale);
    this.tipHalo.scale.setScalar(1.45 * sparkScale);
    this.tipSpark.material.rotation = this.time * 0.15;
    this.tipHalo.material.rotation = -this.time * 0.08;
  }

  render() {
    this.composer.render();
  }

  dispose() {
    window.removeEventListener('resize', this.onResize);
    this.resizeObserver?.disconnect();
    this.composer.dispose?.();
    this.scene.traverse((object) => {
      object.geometry?.dispose?.();
      if (Array.isArray(object.material)) {
        object.material.forEach((material) => material.dispose?.());
      } else {
        object.material?.dispose?.();
      }
    });
    this.renderer.dispose();
  }
}
