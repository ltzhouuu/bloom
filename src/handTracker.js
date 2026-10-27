import { analyseHand } from './gesture.js';

const MEDIAPIPE_BASE = new URL('../vendor/mediapipe/', import.meta.url);

function loadScript(src, timeout = 45_000) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-hand-engine]');
    if (existing?.dataset.loaded === 'true') {
      resolve();
      return;
    }
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('手势引擎脚本加载失败')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.dataset.handEngine = 'true';
    const timer = window.setTimeout(() => {
      reject(new Error('手势引擎加载超时'));
    }, timeout);
    script.addEventListener(
      'load',
      () => {
        window.clearTimeout(timer);
        script.dataset.loaded = 'true';
        resolve();
      },
      { once: true },
    );
    script.addEventListener(
      'error',
      () => {
        window.clearTimeout(timer);
        reject(new Error('手势引擎脚本加载失败'));
      },
      { once: true },
    );
    document.head.append(script);
  });
}

function describeCameraError(error) {
  const name = error?.name || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return '摄像头权限被拒绝。你仍然可以按住指针，让花在掌心里开合。';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return '没有找到可用的摄像头。你仍然可以使用指针预览。';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return '摄像头似乎被其他应用占用了，请关闭占用程序后再试。';
  }
  if (name === 'OverconstrainedError') {
    return '摄像头不支持所需的分辨率。请重试，或改用指针预览。';
  }
  if (name === 'SecurityError') {
    return '浏览器阻止了摄像头访问。请通过 localhost 或 HTTPS 打开这个页面。';
  }
  return error?.message || '无法打开摄像头，请稍后重试。';
}

export class HandTracker {
  constructor({ video, onResult, onStatus }) {
    this.video = video;
    this.onResult = onResult;
    this.onStatus = onStatus || (() => {});
    this.hands = null;
    this.stream = null;
    this.active = false;
    this.sending = false;
    this.raf = 0;
    this.lastSend = 0;
    this.resultTimes = [];
    this.lastPresent = false;
    this.frameSize = { width: 0, height: 0 };
  }

  async start() {
    if (!window.isSecureContext) {
      throw new Error('摄像头需要安全上下文。请通过 http://localhost 或 HTTPS 访问。');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前浏览器不支持摄像头访问。你仍然可以使用指针预览。');
    }

    this.onStatus({ phase: 'camera', message: '正在请求摄像头权限' });

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: 'user',
          width: { ideal: 960, max: 1280 },
          height: { ideal: 720, max: 960 },
          frameRate: { ideal: 30, max: 60 },
        },
      });
    } catch (error) {
      throw new Error(describeCameraError(error));
    }

    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    try {
      await this.video.play();
    } catch {
      // Some mobile browsers only start playback after metadata. Waiting for it
      // below is sufficient; MediaPipe will not be fed until then.
    }

    await this.waitForVideo();

    this.onStatus({ phase: 'model', message: '正在唤醒手势识别引擎' });
    await loadScript(new URL('hands.js', MEDIAPIPE_BASE).href, 45_000);

    if (!window.Hands) {
      throw new Error('手势识别引擎没有正确初始化，请刷新后重试。');
    }

    this.hands = new window.Hands({
      locateFile: (file) => new URL(file, MEDIAPIPE_BASE).href,
    });
    this.hands.setOptions({
      maxNumHands: 1,
      modelComplexity: 1,
      minDetectionConfidence: 0.62,
      minTrackingConfidence: 0.58,
      selfieMode: false,
    });
    this.hands.onResults((results) => this.handleResults(results));

    this.onStatus({ phase: 'warming', message: '正在让花园适应你的手' });
    if (typeof this.hands.initialize === 'function') {
      await this.hands.initialize();
    }

    this.active = true;
    this.onStatus({ phase: 'ready', message: '寻找手掌' });
    this.lastSend = 0;
    this.loop();

    return {
      width: this.video.videoWidth,
      height: this.video.videoHeight,
    };
  }

  waitForVideo() {
    if (this.video.readyState >= 2 && this.video.videoWidth > 0) {
      this.frameSize = { width: this.video.videoWidth, height: this.video.videoHeight };
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error('摄像头画面没有准备好，请重试。'));
      }, 12_000);

      const onReady = () => {
        if (this.video.videoWidth === 0) return;
        cleanup();
        this.frameSize = { width: this.video.videoWidth, height: this.video.videoHeight };
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('无法读取摄像头画面，请重试。'));
      };
      const cleanup = () => {
        window.clearTimeout(timeout);
        this.video.removeEventListener('loadeddata', onReady);
        this.video.removeEventListener('canplay', onReady);
        this.video.removeEventListener('error', onError);
      };

      this.video.addEventListener('loadeddata', onReady);
      this.video.addEventListener('canplay', onReady);
      this.video.addEventListener('error', onError, { once: true });
    });
  }

  loop = () => {
    if (!this.active) return;
    this.raf = window.requestAnimationFrame(this.loop);

    if (this.sending) return;
    if (this.video.readyState < 2) return;

    const now = performance.now();
    // Around 30 inferences per second is plenty for a soft, organic bloom and
    // leaves headroom for the WebGL scene.
    if (now - this.lastSend < 32) return;
    this.lastSend = now;

    this.sending = true;
    this.hands
      .send({ image: this.video })
      .catch((error) => {
        console.error('[hand-tracker] inference failed', error);
        this.onStatus({ phase: 'error', message: '手势识别暂时中断，正在重试' });
      })
      .finally(() => {
        this.sending = false;
      });
  };

  handleResults(results) {
    if (!this.active) return;
    const now = performance.now();
    this.resultTimes.push(now);
    while (this.resultTimes.length > 20) this.resultTimes.shift();
    const fps = this.resultTimes.length > 1
      ? Math.round((this.resultTimes.length - 1) * 1000 / (now - this.resultTimes[0]))
      : 0;

    const landmarks = results.multiHandLandmarks?.[0];
    const handedness = results.multiHandedness?.[0];
    const hand = landmarks ? analyseHand(landmarks) : null;

    if (hand) {
      this.lastPresent = true;
      this.onStatus({ phase: 'tracking', message: '手掌已捕捉', fps });
    } else if (this.lastPresent) {
      this.lastPresent = false;
      this.onStatus({ phase: 'lost', message: '寻找手掌', fps });
    } else {
      this.onStatus({ phase: 'ready', message: '寻找手掌', fps });
    }

    this.onResult({
      hand,
      landmarks: landmarks || null,
      label: handedness?.label || null,
      score: handedness?.score ?? 0,
      fps,
      timestamp: now,
      video: this.frameSize,
    });
  }

  stop() {
    this.active = false;
    window.cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.video.srcObject) this.video.srcObject = null;
    try {
      this.hands?.close?.();
    } catch {
      // Closing is best-effort.
    }
    this.hands = null;
  }
}
