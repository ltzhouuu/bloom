import { clamp, distance2D, smoothstep } from './utils.js';

/**
 * Landmark indices, following the MediaPipe Hands topology:
 *
 *   0 wrist
 *   1-4 thumb   | 5-8 index   | 9-12 middle
 *   13-16 ring  | 17-20 pinky
 */
export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

export const FINGERTIP_INDICES = [4, 8, 12, 16, 20];

const FINGERS = [
  {
    name: 'thumb',
    chain: [1, 2, 3, 4],
    tip: 4,
    weight: 0.68,
    reach: [0.38, 1.06],
  },
  {
    name: 'index',
    chain: [5, 6, 7, 8],
    tip: 8,
    weight: 1,
    reach: [0.52, 1.42],
  },
  {
    name: 'middle',
    chain: [9, 10, 11, 12],
    tip: 12,
    weight: 1,
    reach: [0.55, 1.5],
  },
  {
    name: 'ring',
    chain: [13, 14, 15, 16],
    tip: 16,
    weight: 0.94,
    reach: [0.5, 1.36],
  },
  {
    name: 'pinky',
    chain: [17, 18, 19, 20],
    tip: 20,
    weight: 0.82,
    reach: [0.45, 1.2],
  },
];

const PALM_INDICES = [0, 5, 9, 13, 17];

function averagePoint(landmarks, indices) {
  const total = indices.reduce(
    (value, index) => {
      value.x += landmarks[index].x;
      value.y += landmarks[index].y;
      value.z += landmarks[index].z || 0;
      return value;
    },
    { x: 0, y: 0, z: 0 },
  );
  return {
    x: total.x / indices.length,
    y: total.y / indices.length,
    z: total.z / indices.length,
  };
}

/**
 * Average cosine between consecutive bone directions. A straight finger scores ~1,
 * a curled finger scores noticeably lower.
 */
function straightness(chain, landmarks) {
  if (chain.length < 3) return 0.5;
  let total = 0;
  let samples = 0;
  for (let index = 1; index < chain.length - 1; index += 1) {
    const previous = landmarks[chain[index - 1]];
    const current = landmarks[chain[index]];
    const next = landmarks[chain[index + 1]];
    const ax = current.x - previous.x;
    const ay = current.y - previous.y;
    const bx = next.x - current.x;
    const by = next.y - current.y;
    const lengthA = Math.hypot(ax, ay) || 1e-6;
    const lengthB = Math.hypot(bx, by) || 1e-6;
    total += (ax * bx + ay * by) / (lengthA * lengthB);
    samples += 1;
  }
  return total / Math.max(1, samples);
}

function analyseFinger(finger, landmarks, palmCenter, palmScale) {
  const tip = landmarks[finger.tip];
  const reach = distance2D(tip, palmCenter) / palmScale;
  const reachScore = smoothstep(finger.reach[0], finger.reach[1], reach);
  const straight = straightness(finger.chain, landmarks);
  const straightScore = smoothstep(-0.08, 0.82, straight);

  // Distance from the wrist is also useful for the thumb, which folds in a
  // different direction than the other fingers.
  const wristReach = distance2D(tip, landmarks[0]) / palmScale;
  const wristScore = smoothstep(0.8, 1.75, wristReach);
  const combined = finger.name === 'thumb'
    ? reachScore * 0.62 + straightScore * 0.24 + wristScore * 0.14
    : reachScore * 0.64 + straightScore * 0.36;

  return {
    name: finger.name,
    score: clamp(combined, 0, 1),
    reach,
    straight,
  };
}

/**
 * Turns a frame of 21 landmarks into low-level, display-friendly values.
 * All output coordinates are mirrored horizontally so they line up with the
 * selfie view and with the 3D stage.
 */
export function analyseHand(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length < 21) {
    return null;
  }

  const palmCenter = averagePoint(landmarks, PALM_INDICES);
  const palmWidth = Math.max(
    distance2D(landmarks[5], landmarks[17]),
    distance2D(landmarks[0], landmarks[9]) * 0.72,
    0.035,
  );

  const fingers = FINGERS.map((finger) => analyseFinger(finger, landmarks, palmCenter, palmWidth));
  let total = 0;
  let totalWeight = 0;
  for (const finger of fingers) {
    const weight = FINGERS.find((entry) => entry.name === finger.name)?.weight ?? 1;
    total += finger.score * weight;
    totalWeight += weight;
  }

  const rawOpenness = clamp(total / totalWeight, 0, 1);
  const extendedCount = fingers.filter((finger) => finger.score > 0.56).length;
  const spread = distance2D(landmarks[8], landmarks[20]) / palmWidth;

  // Roll of the palm, measured along the knuckle line. Kept small so the flower
  // leans with the hand rather than spinning wildly.
  let rowAngle = Math.atan2(landmarks[17].y - landmarks[5].y, landmarks[5].x - landmarks[17].x);
  if (rowAngle > Math.PI / 2) rowAngle -= Math.PI;
  if (rowAngle < -Math.PI / 2) rowAngle += Math.PI;

  const middleBase = landmarks[9];
  const indexTip = landmarks[8];

  return {
    openness: rawOpenness,
    extendedCount,
    spread,
    fingers,
    tilt: clamp(rowAngle * 0.55, -0.42, 0.42),
    palm: {
      x: clamp(1 - palmCenter.x, 0, 1),
      y: clamp(palmCenter.y, 0, 1),
    },
    tip: {
      x: clamp(1 - indexTip.x, 0, 1),
      y: clamp(indexTip.y, 0, 1),
    },
    indexBase: {
      x: clamp(1 - middleBase.x, 0, 1),
      y: clamp(middleBase.y, 0, 1),
    },
    handScale: clamp(palmWidth / 0.21, 0.78, 1.2),
  };
}

/** Median of the last few frames removes single-frame landmark glitches. */
export class GestureFilter {
  constructor() {
    this.history = [];
    this.value = 0;
    this.initialised = false;
  }

  reset(value = 0) {
    this.history.length = 0;
    this.value = value;
    this.initialised = false;
  }

  push(openness, delta) {
    this.history.push(openness);
    if (this.history.length > 6) this.history.shift();

    const sorted = [...this.history].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (!this.initialised) {
      this.value = median;
      this.initialised = true;
      return this.value;
    }

    // A quick attack makes an open palm feel responsive, while the slightly
    // slower release prevents a momentary tracking dropout from snapping shut.
    const lambda = median > this.value ? 18 : 11;
    this.value += (median - this.value) * (1 - Math.exp(-lambda * delta));
    return clamp(this.value, 0, 1);
  }
}

export function classifyOpenness(openness) {
  if (openness < 0.24) return 'closed';
  if (openness > 0.68) return 'open';
  return 'half';
}
