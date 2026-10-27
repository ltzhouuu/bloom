/**
 * Verifies the hand classifier against MediaPipe's official landmark fixtures.
 * Usage: node tools/test-gestures.mjs
 *
 * The fixtures under tools/fixtures/ are Apache-2.0 licensed samples from
 * google-ai-edge/mediapipe (mediapipe/tasks/testdata/vision).
 */
import { readFile } from 'node:fs/promises';
import { analyseHand } from '../src/gesture.js';

const FIXTURE_ROOT = new URL('./fixtures/', import.meta.url);

const fixtures = [
  ['open_right_up', 'expected_right_up_hand_landmarks.prototxt'],
  ['open_right_down', 'expected_right_down_hand_landmarks.prototxt'],
  ['open_left_up', 'expected_left_up_hand_landmarks.prototxt'],
  ['open_right_up_rotated', 'expected_right_up_hand_rotated_landmarks.prototxt'],
  ['fist', 'fist_landmarks.pbtxt'],
  ['pointing_up', 'pointing_up_landmarks.pbtxt'],
  ['thumb_up', 'thumb_up_landmarks.pbtxt'],
  ['victory', 'victory_landmarks.pbtxt'],
];

function parseLandmarks(text) {
  return [...text.matchAll(/landmark\s*\{([^}]*)\}/g)]
    .slice(0, 21)
    .map((match) => {
      const x = Number(match[1].match(/x:\s*([\d.eE+-]+)/)?.[1]);
      const y = Number(match[1].match(/y:\s*([\d.eE+-]+)/)?.[1]);
      const z = Number(match[1].match(/z:\s*([\d.eE+-]+)/)?.[1] || 0);
      return { x, y, z };
    });
}

console.log('MediaPipe fixture'.padEnd(24), 'openness'.padEnd(10), 'extended'.padEnd(9), 'finger scores');
console.log('-'.repeat(76));

for (const [name, file] of fixtures) {
  const text = await readFile(new URL(file, FIXTURE_ROOT), 'utf8');
  const landmarks = parseLandmarks(text);
  if (landmarks.length !== 21) throw new Error(`${file}: expected 21 landmarks, got ${landmarks.length}`);

  const result = analyseHand(landmarks);
  const scores = result.fingers.map((finger) => finger.score.toFixed(2)).join(', ');
  console.log(
    name.padEnd(24),
    result.openness.toFixed(3).padEnd(10),
    String(result.extendedCount).padEnd(9),
    scores,
  );
}
