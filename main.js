import {
  HandLandmarker,
  FilesetResolver
} from '@mediapipe/tasks-vision';
import { ClapDetector, CLOSE_THRESHOLD } from './clap-detector.js';
import { SoundPlayer } from './sound-player.js';

const video = document.getElementById('webcam');
const canvas = document.getElementById('output_canvas');
const canvasCtx = canvas.getContext('2d');
const statusMessage = document.getElementById('status-message');
const infoBadge = document.getElementById('info-badge');
const container = document.getElementById('container');

let handLandmarker = null;
let lastVideoTime = -1;
let isPredicting = false;

// FPS・解像度計測用
let frameCount = 0;
let lastFpsUpdate = performance.now();
let currentFps = 0;

// ステータスメッセージの更新
function setStatus(text, isError = false) {
  if (!statusMessage) return;
  statusMessage.textContent = text;
  if (isError) {
    statusMessage.style.color = '#ff6b6b';
  }
}

// ステータスメッセージの非表示化
function hideStatus() {
  if (statusMessage) {
    statusMessage.classList.add('hidden');
  }
}

const WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const HAND_MODEL_PATH =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const HAND_OPTIONS = {
  runningMode: 'VIDEO',
  numHands: 2, // 演奏者の両手
  minHandDetectionConfidence: 0.5,
  // 手が重なって隠れかけても追跡を続けられるよう、追跡側の信頼度は低めに設定
  minHandPresenceConfidence: 0.3,
  minTrackingConfidence: 0.3
};

// MediaPipe HandLandmarker（手のひら・拍手判定）の初期化
async function initHandLandmarker() {
  setStatus('手の認識モデルを読み込み中...');

  try {
    const vision = await FilesetResolver.forVisionTasks(WASM_PATH);
    try {
      handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: HAND_MODEL_PATH, delegate: 'GPU' }, // GPUアクセラレーション（WebGL）
        ...HAND_OPTIONS
      });
    } catch (error) {
      console.warn('GPUでの初期化に失敗したため、CPUにフォールバックします:', error);
      handLandmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: HAND_MODEL_PATH, delegate: 'CPU' },
        ...HAND_OPTIONS
      });
    }
  } catch (error) {
    console.error('HandLandmarkerの読み込みに失敗しました:', error);
    setStatus('モデルの読み込みに失敗しました', true);
    throw error;
  }
}

// カメラの向き切り替え用（UIは配置せず、画面ダブルタップで切り替え）
let currentFacingMode = 'user';

// カメラの起動
async function startCamera(facingMode = 'user') {
  currentFacingMode = facingMode;

  // インカメラの場合は鏡像反転、アウトカメラの場合は通常向き
  if (facingMode === 'user') {
    video.style.transform = 'scaleX(-1)';
    canvas.style.transform = 'scaleX(-1)';
  } else {
    video.style.transform = 'none';
    canvas.style.transform = 'none';
  }

  // 既存のストリームがあれば停止
  if (video.srcObject) {
    const tracks = video.srcObject.getTracks();
    tracks.forEach((track) => track.stop());
  }

  // カメラ切り替え時に拍手判定の履歴をリセット
  clapDetector.reset();

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('お使いのブラウザはカメラアクセスに対応していません（HTTPS接続が必要です）', true);
    return;
  }

  setStatus('カメラを起動中...');

  // 5:3アスペクト比・60fps駆動・低解像度を要求
  const constraintsList = [
    // 試行1: 60fps固定（min: 55, ideal: 60）、5:3比率要求、最大640x480
    {
      audio: false,
      video: {
        facingMode: facingMode,
        width: { max: 640 },
        height: { max: 480 },
        aspectRatio: { ideal: 5 / 3 },
        frameRate: { min: 55, ideal: 60 }
      }
    },
    // 試行2: 60fps優先（min制約緩和）、5:3比率要求
    {
      audio: false,
      video: {
        facingMode: facingMode,
        width: { ideal: 640 },
        height: { ideal: 480 },
        aspectRatio: { ideal: 5 / 3 },
        frameRate: { ideal: 60, min: 30 }
      }
    }
  ];

  try {
    let stream = null;
    for (const c of constraintsList) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(c);
        break;
      } catch (err) {
        console.warn('制約での取得をスキップ:', err);
      }
    }

    if (!stream) {
      throw new Error('カメラストリームの取得に失敗しました');
    }

    video.srcObject = stream;

    // iOS Safariでの動画再生開始処理
    video.addEventListener('loadeddata', () => {
      video.play().catch((playError) => {
        console.warn('自動再生が制限されました。タップで開始してください:', playError);
        setStatus('画面をタップしてカメラを開始してください');
      });
    }, { once: true });
  } catch (err) {
    console.error('カメラの起動に失敗しました:', err);
    if (err.name === 'NotAllowedError') {
      setStatus('カメラのアクセスが拒否されました。設定で許可してください', true);
    } else {
      setStatus(`カメラの起動エラー: ${err.message}`, true);
    }
  }
}

// 拍手時に鳴らす音色（public/sounds/ に配置、画面下のスイッチで切り替え）
// scripts/generate-sounds.mjs で生成
// 他の音: kick / snare / woodblock / pluck / zap（.wav）
const SOUNDS = [
  { id: 'crash', label: 'シンバル', file: 'sounds/crash.wav' },
  { id: 'tambourine', label: 'タンバリン', file: 'sounds/tambourine.wav' },
  { id: 'hihat', label: 'ハイハット', file: 'sounds/hihat.wav' },
  { id: 'clap', label: 'クラップ', file: 'sounds/clap.wav' },
  { id: 'bell', label: 'ベル', file: 'sounds/bell.wav' }
];
const SOUND_STORAGE_KEY = 'camera-instrument:sound';

const clapDetector = new ClapDetector();
const soundPlayer = new SoundPlayer(
  SOUNDS.map(({ id, file }) => ({ id, url: import.meta.env.BASE_URL + file }))
);

// 画面下の音色スイッチ（選択は次回起動時も保持）
function setupSoundSwitch() {
  const bar = document.getElementById('sound-switch');
  if (!bar) return;

  let savedId = null;
  try {
    savedId = localStorage.getItem(SOUND_STORAGE_KEY);
  } catch {
    // ストレージが使えない環境では保持しない
  }
  if (SOUNDS.some((s) => s.id === savedId)) {
    soundPlayer.select(savedId);
  }

  const buttons = SOUNDS.map((sound) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = sound.label;
    button.addEventListener('click', (event) => {
      // 画面タップ（ダブルタップでのカメラ切り替え）と区別する
      event.stopPropagation();
      soundPlayer.select(sound.id);
      try {
        localStorage.setItem(SOUND_STORAGE_KEY, sound.id);
      } catch {
        // ストレージが使えない環境では保持しない
      }
      updateActive();
      // 選んだ音色を試し鳴らし（このタップで音声も有効化される）
      soundPlayer.unlock().then(() => soundPlayer.play(0.7)).catch(console.error);
    });
    bar.appendChild(button);
    return { id: sound.id, button };
  });

  function updateActive() {
    for (const { id, button } of buttons) {
      button.classList.toggle('active', id === soundPlayer.currentId);
    }
  }
  updateActive();
}
let clapCount = 0;
let lastClapEffect = null; // 拍手位置に表示する波紋エフェクト

const CLAP_EFFECT_MS = 300;

// 手の骨格・手のひら中心・拍手判定状態の描画
function drawHands(handLandmarks, clapState, width, height) {
  canvasCtx.save();

  // 1. 手の骨格（認識できている手の形を薄く表示）
  canvasCtx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
  canvasCtx.lineWidth = 2;
  canvasCtx.lineCap = 'round';
  for (const landmarks of handLandmarks) {
    for (const { start, end } of HandLandmarker.HAND_CONNECTIONS) {
      canvasCtx.beginPath();
      canvasCtx.moveTo(landmarks[start].x * width, landmarks[start].y * height);
      canvasCtx.lineTo(landmarks[end].x * width, landmarks[end].y * height);
      canvasCtx.stroke();
    }
  }

  const { palms, ratio, isArmed } = clapState;

  // 2. 両手のひらを結ぶ線（黄色: 拍手受付中 / 灰色: 一度手を開くまで待機中）
  if (palms.length >= 2) {
    const [a, b] = palms;
    canvasCtx.strokeStyle = isArmed ? 'rgba(250, 204, 21, 0.9)' : 'rgba(156, 163, 175, 0.7)';
    canvasCtx.lineWidth = 3;
    canvasCtx.setLineDash([6, 6]);
    canvasCtx.beginPath();
    canvasCtx.moveTo(a.x * width, a.y * height);
    canvasCtx.lineTo(b.x * width, b.y * height);
    canvasCtx.stroke();
    canvasCtx.setLineDash([]);
  }

  // 3. 手のひらの中心と判定範囲（2つの輪が触れると拍手と判定される）
  const isClose = ratio !== null && ratio < CLOSE_THRESHOLD;
  for (const palm of palms) {
    const cx = palm.x * width;
    const cy = palm.y * height;

    canvasCtx.strokeStyle = isClose ? 'rgba(244, 114, 182, 0.95)' : 'rgba(244, 114, 182, 0.5)';
    canvasCtx.lineWidth = 2;
    canvasCtx.beginPath();
    canvasCtx.arc(cx, cy, (CLOSE_THRESHOLD * palm.size * height) / 2, 0, Math.PI * 2);
    canvasCtx.stroke();

    canvasCtx.fillStyle = 'rgba(244, 114, 182, 1)';
    canvasCtx.beginPath();
    canvasCtx.arc(cx, cy, 6, 0, Math.PI * 2);
    canvasCtx.fill();
  }

  // 4. 拍手した位置に広がる波紋
  if (lastClapEffect) {
    const progress = (performance.now() - lastClapEffect.shownAt) / CLAP_EFFECT_MS;
    if (progress < 1) {
      canvasCtx.strokeStyle = `rgba(250, 204, 21, ${1 - progress})`;
      canvasCtx.lineWidth = 5;
      canvasCtx.beginPath();
      canvasCtx.arc(lastClapEffect.x * width, lastClapEffect.y * height, 15 + progress * 60, 0, Math.PI * 2);
      canvasCtx.stroke();
    } else {
      lastClapEffect = null;
    }
  }

  canvasCtx.restore();
}

// 表示用キャンバスの内部解像度（5:3）
const DISPLAY_WIDTH = 500;
const DISPLAY_HEIGHT = 300;
const TARGET_ASPECT = 5 / 3;

// 推論にかかった時間（ms、表示用に平滑化）
let inferenceMs = 0;

// 画面に表示されるカメラ映像の中央5:3領域（object-fit: cover と同じ切り出し）
function getCropRect() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (vw / vh > TARGET_ASPECT) {
    // 元映像が横長の場合、左右を均等にトリミング
    const w = vh * TARGET_ASPECT;
    return { x: (vw - w) / 2 / vw, y: 0, w: w / vw, h: 1 };
  }
  // 元映像が縦長の場合、上下を均等にトリミング
  const h = vw / TARGET_ASPECT;
  return { x: 0, y: (vh - h) / 2 / vh, w: 1, h: h / vh };
}

// カメラ映像全体の正規化座標を、5:3表示領域の正規化座標に変換
function toDisplayCoords(handLandmarks, crop) {
  return handLandmarks.map((landmarks) =>
    landmarks.map((lm) => ({ ...lm, x: (lm.x - crop.x) / crop.w, y: (lm.y - crop.y) / crop.h }))
  );
}

// カメラの新しいフレームが届いた直後に処理する（未対応ブラウザは画面描画ごと）
function scheduleNextFrame() {
  if ('requestVideoFrameCallback' in video) {
    video.requestVideoFrameCallback(renderLoop);
  } else {
    requestAnimationFrame(renderLoop);
  }
}

// 手の認識・拍手判定のリアルタイム描画ループ
function renderLoop() {
  if (video.readyState >= 2 && handLandmarker) {
    // 表示用キャンバスの内部解像度を5:3（500x300）に固定
    if (canvas.width !== DISPLAY_WIDTH || canvas.height !== DISPLAY_HEIGHT) {
      canvas.width = DISPLAY_WIDTH;
      canvas.height = DISPLAY_HEIGHT;
    }

    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;

      // カメラ映像をコピーせず直接渡して検出（キャンバス経由のGPU⇔CPU転送を省いて高速化）
      const startTimeMs = performance.now();
      const handResults = handLandmarker.detectForVideo(video, startTimeMs);
      inferenceMs = inferenceMs * 0.9 + (performance.now() - startTimeMs) * 0.1;

      // 前フレームの描画をクリア
      canvasCtx.clearRect(0, 0, canvas.width, canvas.height);

      // 両手のひらの距離から拍手を判定
      const handLandmarks = toDisplayCoords(handResults?.landmarks ?? [], getCropRect());
      const clapState = clapDetector.update(handLandmarks, startTimeMs);
      if (clapState.clap) {
        clapCount++;
        soundPlayer.play(clapState.clap.strength);
        lastClapEffect = { ...clapState.clap, shownAt: performance.now() };
      }
      drawHands(handLandmarks, clapState, canvas.width, canvas.height);

      // 最初の描画が成功したらステータス表示を消す
      if (!isPredicting) {
        isPredicting = true;
        hideStatus();
      }

      // FPSを0.5秒間隔で計測
      frameCount++;
      const now = performance.now();
      if (now - lastFpsUpdate >= 500) {
        currentFps = Math.round((frameCount * 1000) / (now - lastFpsUpdate));
        frameCount = 0;
        lastFpsUpdate = now;
      }

      // 処理FPS（カメラFPS）・推論時間・検出した手の数・両手のひらの距離（閾値調整用）を毎フレーム表示
      if (infoBadge) {
        const cameraFps = Math.round(video.srcObject?.getVideoTracks()[0]?.getSettings().frameRate ?? 0);
        const ratioText = clapState.ratio !== null ? clapState.ratio.toFixed(2) : '--';
        const soundState = soundPlayer.isUnlocked ? '' : ' 🔇タップで音ON';
        infoBadge.textContent =
          `${currentFps}fps(cam${cameraFps}) 推論${Math.round(inferenceMs)}ms ` +
          `手:${clapState.palms.length} 距離:${ratioText} 拍手:${clapCount}${soundState}`;
      }
    }
  }

  scheduleNextFrame();
}

// iOS Safariで自動再生がブロックされた場合の画面タップ復帰
let lastTapTime = 0;
container.addEventListener('click', () => {
  // 最初のタップで音声再生を有効化
  soundPlayer.unlock().catch(console.error);

  const now = Date.now();
  // ダブルタップ検知（300ms以内）で前面/背面カメラを切り替え
  if (now - lastTapTime < 300) {
    const nextMode = currentFacingMode === 'user' ? 'environment' : 'user';
    startCamera(nextMode);
    lastTapTime = 0;
    return;
  }
  lastTapTime = now;

  // 再生が停止している場合は再開
  if (video.paused) {
    video.play().then(() => {
      hideStatus();
    }).catch(console.error);
  }
});

// アプリの起動処理
async function init() {
  setupSoundSwitch();
  try {
    // モデル読み込み・カメラ起動・音声読み込みを並列で実行し、起動時間を短縮
    const [, , loadedSounds] = await Promise.all([
      initHandLandmarker(),
      startCamera(),
      soundPlayer.load()
    ]);
    if (loadedSounds === 0) {
      console.warn('再生できる音声ファイルがありません。public/sounds/ に配置してください');
    }
    scheduleNextFrame();
  } catch (err) {
    console.error('アプリの初期化中にエラーが発生しました:', err);
  }
}

// DOM読み込み完了時に自動実行
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
