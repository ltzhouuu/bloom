import { FlowerScene } from './flower.js';
import { HandTracker } from './handTracker.js';
import {
  classifyOpenness,
  FINGERTIP_INDICES,
  GestureFilter,
  HAND_CONNECTIONS,
} from './gesture.js';
import { clamp, damp, formatPercent, prefersReducedMotion, smoothstep } from './utils.js';

const $ = (selector) => document.querySelector(selector);

const elements = {
  canvas: $('#scene'),
  intro: $('#intro'),
  startCamera: $('#startCameraButton'),
  startCameraLabel: $('#startCameraButton .button__label'),
  demoButton: $('#demoButton'),
  startError: $('#startError'),
  guideButton: $('#guideButton'),
  cameraButton: $('#cameraButton'),
  cameraHud: $('#cameraHud'),
  cameraWindow: $('#cameraWindow'),
  cameraFps: $('#cameraFps'),
  handStatus: $('#handStatus'),
  handOverlay: $('#handOverlay'),
  inputVideo: $('#inputVideo'),
  boot: $('#boot'),
  bootText: $('#bootText'),
  bootHint: $('#bootHint'),
  bootCancel: $('#bootCancelButton'),
  guideDialog: $('#guideDialog'),
  closeGuide: $('#closeGuideButton'),
  guideDone: $('#guideDoneButton'),
  gesturePanel: $('#gesturePanel'),
  trackingLabel: $('#trackingLabel'),
  modeBadge: $('#modeBadge'),
  gestureTitle: $('#gestureTitle'),
  gestureCopy: $('#gestureCopy'),
  bloomFill: $('#bloomFill'),
  bloomPercent: $('#bloomPercent'),
  rosette: $('#rosette'),
  statusLight: $('#statusLight'),
  liveHint: $('#liveHint'),
  pointerGlow: $('#pointerGlow'),
  fatal: $('#fatal'),
};

const params = new URLSearchParams(window.location.search);
const reducedMotion = prefersReducedMotion();

if (!elements.canvas || !elements.intro) {
  throw new Error('The bloom stage is missing its markup.');
}

let flowerScene;
try {
  flowerScene = new FlowerScene(elements.canvas, { reducedMotion });
} catch (error) {
  console.error('[bloom] WebGL initialisation failed', error);
  elements.fatal.hidden = false;
  elements.boot.hidden = true;
  throw error;
}

if (params.has('debug')) {
  window.__BLOOM__ = { scene: flowerScene };
}

const state = {
  mode: 'attract',
  started: false,
  bloom: 0.32,
  bloomVelocity: 0,
  targetBloom: 0.56,
  visualState: 'half',
  anchorX: 0.665,
  anchorY: 0.48,
  targetAnchorX: 0.665,
  targetAnchorY: 0.48,
  handScale: 1,
  targetScale: 1,
  tilt: 0,
  targetTilt: 0,
  hand: null,
  handPresent: false,
  lastHandAt: 0,
  lastResultAt: 0,
  fps: 0,
  filter: new GestureFilter(),
  pointer: {
    x: 0.6,
    y: 0.5,
    down: false,
    active: false,
  },
  tipX: 0.6,
  tipY: 0.5,
  tipVisible: false,
  lastBurstAt: 0,
  lastUiAt: 0,
  cameraHidden: false,
  bootVisible: false,
  starting: false,
  startAttempt: 0,
  lastNow: performance.now(),
  tracker: null,
};

const ui = {
  tracking: '',
  mode: '',
  hint: '',
};

const pointerGlow = {
  x: -200,
  y: -200,
};

const bootWatchTimers = new Set();

function clearBootWatch() {
  for (const timer of bootWatchTimers) window.clearTimeout(timer);
  bootWatchTimers.clear();
}

function scheduleBootWatch(delay, callback) {
  const timer = window.setTimeout(() => {
    bootWatchTimers.delete(timer);
    callback();
  }, delay);
  bootWatchTimers.add(timer);
  return timer;
}

function setText(node, value) {
  if (!node) return;
  if (node.textContent !== value) node.textContent = value;
}

function setMode(mode) {
  state.mode = mode;
  document.body.dataset.mode = mode;
}

function setStarted(started) {
  state.started = started;
  document.body.dataset.started = String(started);
  elements.gesturePanel.setAttribute('aria-hidden', String(!started));
}

function showBoot(message) {
  clearBootWatch();
  state.bootVisible = true;
  elements.bootText.textContent = message;
  elements.bootHint.textContent = '首次加载需下载约 8 MB 手部模型，网络较慢时约需 20–30 秒。';
  elements.bootCancel.hidden = true;
  elements.boot.hidden = false;
}

function hideBoot() {
  clearBootWatch();
  state.bootVisible = false;
  elements.boot.hidden = true;
}

function abandonCameraAttempt() {
  state.startAttempt += 1;
  state.starting = false;
  setStarting(false);
  const tracker = state.tracker;
  state.tracker = null;
  tracker?.stop();
}

function cancelCameraStart() {
  if (state.mode !== 'loading' || !state.bootVisible) return;
  abandonCameraAttempt();
  hideBoot();
  startDemo();
}

function failCameraStart(message) {
  abandonCameraAttempt();
  hideBoot();
  setMode('attract');
  showStartError(message);
  elements.startCameraLabel.textContent = '再试一次';
  elements.startCamera.disabled = false;
  elements.cameraHud.setAttribute('aria-hidden', 'true');
  elements.cameraButton.classList.add('is-off');
  elements.cameraButton.setAttribute('aria-pressed', 'false');
}

function setStarting(starting) {
  state.starting = starting;
  elements.startCamera.classList.toggle('is-loading', starting);
  elements.startCamera.disabled = starting;
  elements.startCamera.setAttribute('aria-busy', String(starting));
  elements.startCameraLabel.textContent = starting ? '正在打开花园' : '开启手势体验';
}

function openGuide() {
  if (typeof elements.guideDialog.showModal === 'function') {
    if (!elements.guideDialog.open) elements.guideDialog.showModal();
  } else {
    elements.guideDialog.setAttribute('open', '');
  }
}

function closeGuide() {
  if (typeof elements.guideDialog.close === 'function') {
    elements.guideDialog.close();
  } else {
    elements.guideDialog.removeAttribute('open');
  }
}

function resetStartError() {
  setText(elements.startError, '');
}

function showStartError(message) {
  setText(elements.startError, message);
}

function startDemo() {
  if (state.starting) return;
  resetStartError();
  setMode('demo');
  setStarted(true);
  state.handPresent = false;
  state.tipVisible = false;
  state.pointer.active = false;
  state.pointer.down = false;
  state.pointer.x = 0.6;
  state.pointer.y = 0.5;
  state.tipX = state.pointer.x;
  state.tipY = state.pointer.y;
  state.targetBloom = 0.96;
  state.targetAnchorX = 0.58;
  state.targetAnchorY = 0.5;
  state.targetScale = 1;
  state.targetTilt = 0;
  elements.cameraHud.classList.add('is-hidden');
  elements.cameraHud.setAttribute('aria-hidden', 'true');
  elements.pointerGlow.classList.remove('is-visible');
  setPointerGlowPosition(0.6, 0.5);
  setHints('demo');
  updateModeChrome('指针', '指针模式');
  flowerScene.triggerBurst(true);
  state.lastBurstAt = performance.now();
}

function startCameraExperience() {
  if (state.starting) return;
  resetStartError();
  setStarting(true);
  setMode('loading');
  showBoot('正在请求摄像头权限');
  state.pointer.down = false;
  elements.pointerGlow.classList.remove('is-visible');

  const attempt = ++state.startAttempt;
  const tracker = new HandTracker({
    video: elements.inputVideo,
    onResult: handleTrackingResult,
    onStatus: handleTrackerStatus,
  });
  state.tracker = tracker;

  scheduleBootWatch(8000, () => {
    if (state.startAttempt !== attempt || !state.bootVisible) return;
    elements.bootHint.textContent = '模型正在下载中，首次打开会久一点，请保持页面打开…';
  });
  scheduleBootWatch(12000, () => {
    if (state.startAttempt !== attempt || !state.bootVisible) return;
    elements.bootCancel.hidden = false;
  });
  scheduleBootWatch(30000, () => {
    if (state.startAttempt !== attempt || !state.bootVisible) return;
    elements.bootHint.textContent = '网络似乎有点慢。你可以继续等待，或先使用指针预览。';
  });
  scheduleBootWatch(95000, () => {
    if (state.startAttempt !== attempt || !state.bootVisible) return;
    failCameraStart('手势模型加载超时，请检查网络后重试，或使用指针预览。');
  });

  tracker
    .start()
    .then(({ width, height }) => {
      if (state.startAttempt !== attempt || state.mode !== 'loading') {
        tracker.stop();
        return;
      }
      state.starting = false;
      state.handPresent = false;
      state.lastHandAt = 0;
      state.filter.reset(0.18);
      state.bloom = Math.min(state.bloom, 0.46);
      state.bloomVelocity = 0;
      setMode('live');
      setStarted(true);
      setStarting(false);
      hideBoot();
      updateModeChrome('手势', '等待手掌');
      setHints('live');
      elements.cameraHud.classList.remove('is-hidden');
      elements.cameraHud.setAttribute('aria-hidden', 'false');
      elements.cameraButton.classList.remove('is-off');
      elements.cameraButton.setAttribute('aria-pressed', 'true');
      elements.cameraFps.textContent = '—';
      elements.handStatus.textContent = '21 LANDMARKS';
      if (width && height) {
        elements.cameraWindow.style.aspectRatio = `${width} / ${height}`;
      }
      // Give the first frames a moment to settle before the user sees the HUD.
      state.targetBloom = 0.24;
      state.targetAnchorX = 0.58;
      state.targetAnchorY = 0.5;
      elements.gesturePanel.focus?.({ preventScroll: true });
    })
    .catch((error) => {
      if (state.startAttempt !== attempt || error?.name === 'AbortError' || state.mode !== 'loading') {
        tracker.stop();
        return;
      }
      console.error('[bloom] camera start failed', error);
      tracker.stop();
      state.tracker = null;
      state.starting = false;
      failCameraStart(error.message || '摄像头没有准备好，请稍后重试。');
    });
}

function handleTrackerStatus(status) {
  if (status.phase === 'ready' && state.bootVisible) {
    elements.bootText.textContent = '找到你了，请将手掌放进画面';
  } else if (status.message && (status.phase === 'camera' || status.phase === 'model' || status.phase === 'warming')) {
    elements.bootText.textContent = status.message;
  }

  if (status.phase === 'tracking' || status.phase === 'lost' || status.phase === 'ready') {
    if (typeof status.fps === 'number' && status.fps > 0) {
      state.fps = status.fps;
    }
  }

  if (status.phase === 'tracking') {
    state.lastHandAt = performance.now();
  }
}

function handleTrackingResult(result) {
  if (state.mode !== 'live') return;

  const now = performance.now();
  const resultDelta = clamp((now - (state.lastResultAt || now)) / 1000, 0.001, 0.12);
  state.lastResultAt = now;
  state.fps = result.fps || state.fps;

  if (result.hand) {
    const previousHandAt = state.lastHandAt;
    const wasAbsent = !state.handPresent;
    state.hand = result.hand;
    state.handPresent = true;
    state.lastHandAt = now;
    if (wasAbsent || now - previousHandAt > 1400) {
      state.filter.reset(result.hand.openness);
    }
    state.filter.push(result.hand.openness, resultDelta);
  } else if (now - state.lastHandAt > 320) {
    // A short grace period absorbs single-frame tracking dropouts without
    // making the flower feel sticky.
    state.handPresent = false;
  }

  drawHandOverlay(result);
}

function drawHandOverlay(result) {
  const canvas = elements.handOverlay;
  if (!canvas) return;
  const rectangle = canvas.getBoundingClientRect();
  if (rectangle.width < 2 || rectangle.height < 2) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const targetWidth = Math.round(rectangle.width * dpr);
  const targetHeight = Math.round(rectangle.height * dpr);
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }

  const context = canvas.getContext('2d');
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, rectangle.width, rectangle.height);

  const landmarks = result?.landmarks;
  if (!Array.isArray(landmarks) || !landmarks.length) return;

  const videoWidth = result.video?.width || 4;
  const videoHeight = result.video?.height || 3;
  const videoAspect = videoWidth / videoHeight;
  const canvasAspect = rectangle.width / rectangle.height;

  let scaleX;
  let scaleY;
  let offsetX = 0;
  let offsetY = 0;
  if (videoAspect > canvasAspect) {
    scaleY = rectangle.height;
    scaleX = scaleY * videoAspect;
    offsetX = (scaleX - rectangle.width) / 2;
  } else {
    scaleX = rectangle.width;
    scaleY = scaleX / videoAspect;
    offsetY = (scaleY - rectangle.height) / 2;
  }

  const points = landmarks.map((landmark) => ({
    x: rectangle.width - (landmark.x * scaleX - offsetX),
    y: landmark.y * scaleY - offsetY,
  }));

  const gold = 'rgba(255, 220, 178, 0.76)';
  const rose = 'rgba(255, 146, 145, 0.92)';

  context.save();
  context.lineCap = 'round';
  context.lineJoin = 'round';

  // Faint aura behind the skeleton.
  context.strokeStyle = 'rgba(255, 183, 139, 0.08)';
  context.lineWidth = 4.5;
  context.shadowColor = 'rgba(255, 185, 133, 0.55)';
  context.shadowBlur = 6 * dpr;
  traceConnections(context, points);
  context.stroke();

  context.strokeStyle = gold;
  context.lineWidth = 1.15;
  context.shadowBlur = 3 * dpr;
  traceConnections(context, points);
  context.stroke();
  context.restore();

  context.save();
  for (let index = 0; index < points.length; index += 1) {
    const isFingertip = FINGERTIP_INDICES.includes(index);
    const isIndexTip = index === 8;
    const point = points[index];
    context.beginPath();
    context.arc(point.x, point.y, isIndexTip ? 3.2 : isFingertip ? 2.3 : 1.45, 0, Math.PI * 2);
    context.fillStyle = isFingertip ? rose : 'rgba(255, 234, 207, 0.72)';
    context.shadowColor = isFingertip ? 'rgba(255, 139, 133, 0.9)' : 'rgba(255, 205, 158, 0.7)';
    context.shadowBlur = isFingertip ? 8 : 4;
    context.fill();
  }

  const tip = points[8];
  if (tip) {
    context.beginPath();
    context.arc(tip.x, tip.y, 7.5, 0, Math.PI * 2);
    context.strokeStyle = 'rgba(255, 212, 168, 0.35)';
    context.lineWidth = 0.7;
    context.stroke();
  }
  context.restore();
}

function traceConnections(context, points) {
  context.beginPath();
  for (const [from, to] of HAND_CONNECTIONS) {
    if (!points[from] || !points[to]) continue;
    context.moveTo(points[from].x, points[from].y);
    context.lineTo(points[to].x, points[to].y);
  }
}

function updateModeChrome(modeLabel, trackingLabel) {
  if (ui.mode !== modeLabel) {
    ui.mode = modeLabel;
    setText(elements.modeBadge, modeLabel);
  }
  if (ui.tracking !== trackingLabel) {
    ui.tracking = trackingLabel;
    setText(elements.trackingLabel, trackingLabel);
  }
}

function setHints(mode) {
  if (ui.hint === mode) return;
  ui.hint = mode;
  const keys = elements.liveHint.querySelectorAll('.live-hint__key');
  const labels = elements.liveHint.querySelectorAll('.live-hint__text');
  if (keys.length < 2 || labels.length < 2) return;
  if (mode === 'demo') {
    keys[0].textContent = '按住';
    labels[0].textContent = '合拢花苞';
    keys[1].textContent = '松开';
    labels[1].textContent = '让花盛放';
  } else {
    keys[0].textContent = '握拳';
    labels[0].textContent = '合拢花苞';
    keys[1].textContent = '张掌';
    labels[1].textContent = '等待盛放';
  }
}

function setPointerGlowPosition(x, y) {
  const px = x * window.innerWidth;
  const py = y * window.innerHeight;
  pointerGlow.x = px;
  pointerGlow.y = py;
  elements.pointerGlow.style.transform = `translate3d(${px}px, ${py}px, 0) translate(-50%, -50%)`;
}

function handlePointerMove(event) {
  if (state.mode !== 'demo') return;
  const x = clamp(event.clientX / window.innerWidth, 0, 1);
  const y = clamp(event.clientY / window.innerHeight, 0, 1);
  state.pointer.x = x;
  state.pointer.y = y;
  state.pointer.active = true;
  setPointerGlowPosition(x, y);
  elements.pointerGlow.classList.add('is-visible');
}

function isInteractiveTarget(target) {
  return target instanceof Element
    && Boolean(target.closest('button, a, input, textarea, select, dialog, [role="dialog"], .gesture-panel, .camera-hud'));
}

function handlePointerDown(event) {
  if (state.mode !== 'demo' || event.button > 0 || isInteractiveTarget(event.target)) return;
  state.pointer.down = true;
  state.pointer.x = clamp(event.clientX / window.innerWidth, 0, 1);
  state.pointer.y = clamp(event.clientY / window.innerHeight, 0, 1);
  state.pointer.active = true;
  setPointerGlowPosition(state.pointer.x, state.pointer.y);
  elements.pointerGlow.classList.add('is-visible');
  event.preventDefault();
}

function handlePointerUp() {
  if (state.mode !== 'demo') return;
  state.pointer.down = false;
}

function handleKeyDown(event) {
  if (state.mode !== 'demo' || elements.guideDialog.open) return;
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;

  if (event.code === 'Space') {
    event.preventDefault();
    state.pointer.down = true;
    state.pointer.active = true;
    elements.pointerGlow.classList.add('is-visible');
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault();
    const amount = event.shiftKey ? 0.06 : 0.025;
    if (event.key === 'ArrowLeft') state.pointer.x -= amount;
    if (event.key === 'ArrowRight') state.pointer.x += amount;
    if (event.key === 'ArrowUp') state.pointer.y -= amount;
    if (event.key === 'ArrowDown') state.pointer.y += amount;
    state.pointer.x = clamp(state.pointer.x, 0, 1);
    state.pointer.y = clamp(state.pointer.y, 0, 1);
    state.pointer.active = true;
    setPointerGlowPosition(state.pointer.x, state.pointer.y);
    elements.pointerGlow.classList.add('is-visible');
  }
}

function handleKeyUp(event) {
  if (event.code === 'Space' && state.mode === 'demo') {
    state.pointer.down = false;
  }
}

function handleCameraToggle() {
  state.cameraHidden = !state.cameraHidden;
  elements.cameraHud.classList.toggle('is-hidden', state.cameraHidden);
  elements.cameraHud.setAttribute('aria-hidden', String(state.cameraHidden));
  elements.cameraButton.classList.toggle('is-off', state.cameraHidden);
  elements.cameraButton.setAttribute('aria-pressed', String(!state.cameraHidden));
}

function triggerVisualBurst(nextState, previousState) {
  if (!state.started || state.mode === 'attract') return;
  const now = performance.now();
  if (now - state.lastBurstAt < 480) return;

  if (nextState === 'open' && previousState !== 'open') {
    flowerScene.triggerBurst(true);
    state.lastBurstAt = now;
  } else if (nextState === 'closed' && previousState !== 'closed') {
    flowerScene.triggerBurst(false);
    state.lastBurstAt = now;
  }
}

function updateTargets(now, delta) {
  const compact = window.innerWidth <= 760;
  const short = window.innerHeight < 720;

  if (state.mode === 'attract') {
    const elapsed = now / 1000;
    state.targetBloom = 0.54 + Math.sin(elapsed * 0.22) * 0.21;
    state.targetAnchorX = (compact ? 0.5 : 0.665) + Math.sin(elapsed * 0.12) * (compact ? 0.008 : 0.014);
    state.targetAnchorY = (compact ? (short ? 0.24 : 0.3) : 0.48)
      + Math.cos(elapsed * 0.1) * (compact ? 0.006 : 0.014);
    state.targetScale = compact ? (short ? 0.76 : 0.92) : 1;
    state.targetTilt = Math.sin(elapsed * 0.18) * 0.025;
    state.tipVisible = false;
    return;
  }

  if (state.mode === 'demo') {
    state.targetBloom = state.pointer.down ? 0.015 : 0.94;
    if (state.pointer.active) {
      state.targetAnchorX = state.pointer.x;
      state.targetAnchorY = state.pointer.y;
      state.tipX = state.pointer.x;
      state.tipY = state.pointer.y;
    }
    state.targetScale = 1;
    state.targetTilt = (0.5 - state.pointer.x) * 0.16;
    state.tipVisible = state.pointer.active;
    return;
  }

  if (state.mode === 'live') {
    if (state.handPresent && state.hand) {
      const hand = state.hand;
      state.targetBloom = smoothstep(0.18, 0.8, state.filter.value);
      state.targetAnchorX = hand.palm.x * 0.9 + hand.tip.x * 0.1;
      state.targetAnchorY = hand.palm.y * 0.9 + hand.tip.y * 0.1;
      state.targetScale = clamp(hand.handScale, 0.88, 1.08);
      state.targetTilt = hand.tilt;
      state.tipX = hand.tip.x;
      state.tipY = hand.tip.y;
      state.tipVisible = true;
    } else {
      const missingFor = now - state.lastHandAt;
      if (missingFor > 850) {
        state.targetBloom = damp(state.targetBloom, 0.3, 0.55, delta);
      }
      if (missingFor > 1600) {
        state.targetAnchorX = damp(state.targetAnchorX, 0.58, 0.35, delta);
        state.targetAnchorY = damp(state.targetAnchorY, 0.5, 0.35, delta);
        state.targetScale = damp(state.targetScale, 1, 0.6, delta);
        state.targetTilt = damp(state.targetTilt, 0, 0.8, delta);
      }
      state.tipVisible = false;
    }
  }
}

function updateBloom(delta) {
  const stiffness = state.targetBloom > state.bloom ? 22 : 13;
  state.bloomVelocity += (state.targetBloom - state.bloom) * stiffness * delta;
  state.bloomVelocity *= Math.exp(-7.8 * delta);
  state.bloom += state.bloomVelocity * delta;

  if (state.bloom < 0) {
    state.bloom = 0;
    state.bloomVelocity *= -0.18;
  } else if (state.bloom > 1) {
    state.bloom = 1;
    state.bloomVelocity *= -0.18;
  }

  state.anchorX = damp(state.anchorX, state.targetAnchorX, 7, delta);
  state.anchorY = damp(state.anchorY, state.targetAnchorY, 7, delta);
  state.handScale = damp(state.handScale, state.targetScale, 4, delta);
  state.tilt = damp(state.tilt, state.targetTilt, 4, delta);
}

function updateHud(now) {
  const bloom = clamp(state.bloom, 0, 1);
  if (elements.bloomFill) {
    elements.bloomFill.style.transform = `scaleX(${Math.max(0.005, bloom).toFixed(4)})`;
  }
  if (elements.rosette) {
    elements.rosette.style.setProperty('--petal-open', bloom.toFixed(4));
  }

  if (now - state.lastUiAt < 85) return;
  state.lastUiAt = now;

  setText(elements.bloomPercent, formatPercent(bloom));

  let title = '含苞';
  let copy = '握紧掌心，把光收进花心。';
  let tracking = '等待手掌';
  let gestureMode = '手势';

  if (state.mode === 'demo') {
    gestureMode = '指针';
    tracking = '指针已就位';
  } else if (state.mode === 'live') {
    tracking = state.handPresent ? '手掌已捕捉' : '正在寻找手掌';
    if (!state.handPresent && now - state.lastHandAt > 900) {
      title = '静候';
      copy = '将手放进画面，让花再次醒来。';
    } else if (bloom < 0.24) {
      title = '含苞';
      copy = '握紧掌心，把光收进花心。';
    } else if (bloom < 0.68) {
      title = '欲放';
      copy = '再张开一点，让花瓣呼吸。';
    } else {
      title = '盛放';
      copy = '掌心舒展，花开在指间。';
    }
  } else {
    tracking = '等待开始';
  }

  if (state.mode === 'demo') {
    if (bloom < 0.3) {
      title = '含苞';
      copy = '按住画面，把光收进花心。';
    } else if (bloom < 0.7) {
      title = '欲放';
      copy = '松开指针，看花瓣慢慢舒展。';
    } else {
      title = '盛放';
      copy = '移动指针，花会跟着你走。';
    }
  }

  updateModeChrome(gestureMode, tracking);
  setText(elements.gestureTitle, title);
  setText(elements.gestureCopy, copy);
  elements.statusLight.classList.toggle('is-lost', state.mode === 'live' && !state.handPresent);
  elements.gesturePanel.dataset.state = bloom < 0.24 ? 'closed' : bloom > 0.68 ? 'open' : 'half';

  if (state.mode === 'live') {
    setText(elements.handStatus, state.handPresent ? 'HAND FOUND' : 'NO SIGNAL');
    setText(elements.cameraFps, state.fps ? `${state.fps} FPS` : '—');
  }
}

function animate(now) {
  window.requestAnimationFrame(animate);
  if (document.hidden) return;

  const delta = clamp((now - state.lastNow) / 1000, 0, 0.05);
  state.lastNow = now;

  updateTargets(now, delta);
  updateBloom(delta);

  const nextVisualState = classifyOpenness(state.bloom);
  if (nextVisualState !== state.visualState) {
    triggerVisualBurst(nextVisualState, state.visualState);
    state.visualState = nextVisualState;
  }

  flowerScene.update({
    delta,
    bloom: state.bloom,
    anchorX: state.anchorX,
    anchorY: state.anchorY,
    handScale: state.handScale,
    tilt: state.tilt,
    tipX: state.tipX,
    tipY: state.tipY,
    tipVisible: state.tipVisible,
  });
  flowerScene.render();
  updateHud(now);
}

function bindEvents() {
  elements.startCamera.addEventListener('click', startCameraExperience);
  elements.demoButton.addEventListener('click', startDemo);
  elements.bootCancel.addEventListener('click', cancelCameraStart);
  elements.guideButton.addEventListener('click', openGuide);
  elements.closeGuide.addEventListener('click', closeGuide);
  elements.guideDone.addEventListener('click', closeGuide);
  elements.cameraButton.addEventListener('click', handleCameraToggle);

  elements.guideDialog.addEventListener('click', (event) => {
    if (event.target === elements.guideDialog) closeGuide();
  });

  window.addEventListener('pointermove', handlePointerMove, { passive: true });
  window.addEventListener('pointerdown', handlePointerDown);
  window.addEventListener('pointerup', handlePointerUp);
  window.addEventListener('pointercancel', handlePointerUp);
  window.addEventListener('blur', () => {
    state.pointer.down = false;
  });
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);

  window.addEventListener('resize', () => {
    setPointerGlowPosition(state.pointer.x, state.pointer.y);
  });

  window.addEventListener('beforeunload', () => {
    state.tracker?.stop();
  });
}

setPointerGlowPosition(0.6, 0.5);
setHints('live');
bindEvents();
window.requestAnimationFrame(animate);

if (params.has('demo') || params.has('autostart')) {
  window.setTimeout(() => {
    startDemo();
    if (params.has('debug')) {
      Object.assign(window.__BLOOM__, { state, flowerScene });
    }
  }, 120);
} else if (params.has('debug')) {
  window.__BLOOM__.state = state;
}
