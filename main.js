import {
  PoseLandmarker,
  FilesetResolver
} from '@mediapipe/tasks-vision';

const video = document.getElementById('webcam');
const canvas = document.getElementById('output_canvas');
const canvasCtx = canvas.getContext('2d');
const statusMessage = document.getElementById('status-message');
const infoBadge = document.getElementById('info-badge');
const container = document.getElementById('container');

let poseLandmarker = null;
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

// MediaPipe PoseLandmarkerの初期化
async function initPoseLandmarker() {
  setStatus('骨格認識モデルを読み込み中...');

  try {
    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
    );

    // モバイル向けに軽量な pose_landmarker_lite を使用
    poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
        delegate: 'GPU' // GPUアクセラレーション（WebGL）
      },
      runningMode: 'VIDEO',
      numPoses: 1, // 認識対象人数（必要に応じて複数人対応可能）
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5
    });
  } catch (error) {
    console.warn('GPUでの初期化に失敗したため、CPUにフォールバックします:', error);
    try {
      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
      );
      poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
          delegate: 'CPU'
        },
        runningMode: 'VIDEO',
        numPoses: 1
      });
    } catch (fallbackError) {
      console.error('PoseLandmarkerの読み込みに失敗しました:', fallbackError);
      setStatus('モデルの読み込みに失敗しました', true);
      throw fallbackError;
    }
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

  // カメラ切り替え時にフィルターの過去履歴をリセット
  if (typeof landmarkSmoother !== 'undefined' && landmarkSmoother) {
    landmarkSmoother.reset();
  }

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

// 表示対象とする体の代表部位（顔の細部や指先は除外）
const KEY_LANDMARKS = [
  0,  // 頭部（鼻）
  11, // 左肩
  12, // 右肩
  13, // 左肘
  14, // 右肘
  15, // 左手首
  16, // 右手首
  23, // 左腰
  24, // 右腰
  25, // 左膝
  26, // 右膝
  27, // 左足首
  28  // 右足首
];

// 代表部位をつなぐ骨格ライン（接続ペア）
const SKELETON_CONNECTIONS = [
  // 肩
  [11, 12],
  // 左腕
  [11, 13],
  [13, 15],
  // 右腕
  [12, 14],
  [14, 16],
  // 胴体
  [11, 23],
  [12, 24],
  [23, 24],
  // 左脚
  [23, 25],
  [25, 27],
  // 右脚
  [24, 26],
  [26, 28]
];

// 代表骨格と関節の描画
function drawSimplifiedSkeleton(landmarks, width, height) {
  canvasCtx.save();

  // 1. 骨格ラインの描画（薄い水色）
  canvasCtx.strokeStyle = 'rgba(125, 211, 252, 0.85)'; // 淡い水色
  canvasCtx.lineWidth = 6.5; // 線幅を太めに設定
  canvasCtx.lineCap = 'round';
  canvasCtx.lineJoin = 'round';

  // 首ライン（頭部と両肩の中間点を接続）
  const nose = landmarks[0];
  const lShoulder = landmarks[11];
  const rShoulder = landmarks[12];
  if (nose && lShoulder && rShoulder) {
    const neckX = ((lShoulder.x + rShoulder.x) / 2) * width;
    const neckY = ((lShoulder.y + rShoulder.y) / 2) * height;
    canvasCtx.beginPath();
    canvasCtx.moveTo(nose.x * width, nose.y * height);
    canvasCtx.lineTo(neckX, neckY);
    canvasCtx.stroke();
  }

  // 主要骨格ライン
  for (const [startIdx, endIdx] of SKELETON_CONNECTIONS) {
    const p1 = landmarks[startIdx];
    const p2 = landmarks[endIdx];
    if (p1 && p2) {
      canvasCtx.beginPath();
      canvasCtx.moveTo(p1.x * width, p1.y * height);
      canvasCtx.lineTo(p2.x * width, p2.y * height);
      canvasCtx.stroke();
    }
  }

  // 2. 代表部位の関節点（淡い水色ドット）
  canvasCtx.fillStyle = 'rgba(186, 230, 253, 0.95)';
  for (const idx of KEY_LANDMARKS) {
    const pt = landmarks[idx];
    if (pt) {
      canvasCtx.beginPath();
      canvasCtx.arc(pt.x * width, pt.y * height, 6.0, 0, Math.PI * 2);
      canvasCtx.fill();
    }
  }

  canvasCtx.restore();
}

// --- One Euro Filter（適応型平滑化フィルター）の実装 ---
// 静止時は手ブレ・微細な震えを除去し、高速運動時は遅延ゼロで即追従するフィルター
class LowPassFilter {
  constructor(alpha = 0) {
    this.alpha = alpha;
    this.s = null;
  }
  setAlpha(alpha) {
    this.alpha = Math.max(0, Math.min(1, alpha));
  }
  filter(val) {
    if (this.s === null) {
      this.s = val;
    } else {
      this.s = this.alpha * val + (1 - this.alpha) * this.s;
    }
    return this.s;
  }
  last() { return this.s; }
  reset() { this.s = null; }
}

class OneEuroFilter {
  constructor(minCutoff = 1.0, beta = 0.008, dCutoff = 1.0) {
    this.minCutoff = minCutoff; // 静止時の遮断周波数（小さいほどブレを強力にカット）
    this.beta = beta;           // 速度感度係数（大きいほど高速時の追従遅延を削減）
    this.dCutoff = dCutoff;     // 速度の遮断周波数
    this.xFilter = new LowPassFilter();
    this.dxFilter = new LowPassFilter();
    this.tPrev = null;
  }

  alpha(cutoff, te) {
    const tau = 1.0 / (2 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / te);
  }

  filter(val, timestamp) {
    if (this.tPrev === null) {
      this.tPrev = timestamp;
      return this.xFilter.filter(val);
    }
    const te = Math.max((timestamp - this.tPrev) / 1000.0, 0.0001); // 経過秒数
    this.tPrev = timestamp;

    const prevX = this.xFilter.last();
    const dx = (prevX !== null) ? (val - prevX) / te : 0;
    const edx = this.dxFilter.filter(dx);
    this.dxFilter.setAlpha(this.alpha(this.dCutoff, te));

    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    this.xFilter.setAlpha(this.alpha(cutoff, te));

    return this.xFilter.filter(val);
  }

  reset() {
    this.xFilter.reset();
    this.dxFilter.reset();
    this.tPrev = null;
  }
}

// 主要ランドマークの座標平滑化管理
class LandmarkSmoother {
  constructor() {
    this.filters = new Map();
    this.lastTimestamp = 0;
  }

  smooth(landmarks, timestamp) {
    // 0.3秒以上検出が途切れた場合は古い履歴をリセット
    if (timestamp - this.lastTimestamp > 300) {
      this.reset();
    }
    this.lastTimestamp = timestamp;

    return landmarks.map((lm, idx) => {
      if (!KEY_LANDMARKS.includes(idx)) return lm;

      const keyX = `${idx}_x`;
      const keyY = `${idx}_y`;

      if (!this.filters.has(keyX)) {
        this.filters.set(keyX, new OneEuroFilter(1.0, 0.008, 1.0));
        this.filters.set(keyY, new OneEuroFilter(1.0, 0.008, 1.0));
      }

      const smoothedX = this.filters.get(keyX).filter(lm.x, timestamp);
      const smoothedY = this.filters.get(keyY).filter(lm.y, timestamp);

      return {
        ...lm,
        x: smoothedX,
        y: smoothedY
      };
    });
  }

  reset() {
    this.filters.forEach((filter) => filter.reset());
    this.filters.clear();
  }
}

const landmarkSmoother = new LandmarkSmoother();

// AI推論・処理用の5:3オフスクリーンキャンバス（低解像度・高速化）
const PROCESS_WIDTH = 500;
const PROCESS_HEIGHT = 300; // 5:3比率
const processCanvas = document.createElement('canvas');
processCanvas.width = PROCESS_WIDTH;
processCanvas.height = PROCESS_HEIGHT;
const processCtx = processCanvas.getContext('2d', { willReadFrequently: true });

// 骨格推定のリアルタイム描画ループ
function renderLoop() {
  if (video.readyState >= 2 && poseLandmarker) {
    // 表示用キャンバスの内部解像度を5:3（500x300）に固定
    if (canvas.width !== PROCESS_WIDTH || canvas.height !== PROCESS_HEIGHT) {
      canvas.width = PROCESS_WIDTH;
      canvas.height = PROCESS_HEIGHT;
    }

    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;

      // カメラ映像の中央5:3領域を切り出してオフスクリーンCanvasに縮小描画
      const srcAspect = video.videoWidth / video.videoHeight;
      const targetAspect = 5 / 3; // 約1.67

      let sx = 0, sy = 0, sWidth = video.videoWidth, sHeight = video.videoHeight;
      if (srcAspect > targetAspect) {
        // 元映像が横長の場合、左右を均等にトリミングして中央の5:3を切り出す
        sWidth = video.videoHeight * targetAspect;
        sx = (video.videoWidth - sWidth) / 2;
      } else {
        // 元映像が縦長の場合、上下を均等にトリミング
        sHeight = video.videoWidth / targetAspect;
        sy = (video.videoHeight - sHeight) / 2;
      }

      processCtx.drawImage(
        video,
        sx, sy, sWidth, sHeight,
        0, 0, PROCESS_WIDTH, PROCESS_HEIGHT
      );

      // 軽量化された5:3画像（500x300）から骨格を検出
      const startTimeMs = performance.now();
      const results = poseLandmarker.detectForVideo(processCanvas, startTimeMs);

      // 前フレームの描画をクリア
      canvasCtx.clearRect(0, 0, canvas.width, canvas.height);

      if (results && results.landmarks && results.landmarks.length > 0) {
        for (const landmarks of results.landmarks) {
          // One Euro Filterで平滑化（ブレを抑制しつつ遅延なしで追従）
          const smoothedLandmarks = landmarkSmoother.smooth(landmarks, startTimeMs);
          // 5:3の表示キャンバス上に骨格を描画（ビデオ映像と完全一致）
          drawSimplifiedSkeleton(smoothedLandmarks, canvas.width, canvas.height);
        }
      } else {
        landmarkSmoother.reset();
      }

      // 最初の描画が成功したらステータス表示を消す
      if (!isPredicting) {
        isPredicting = true;
        hideStatus();
      }

      // 実際の解像度とFPSを更新（0.5秒間隔でリフレッシュ）
      frameCount++;
      const now = performance.now();
      if (now - lastFpsUpdate >= 500) {
        currentFps = Math.round((frameCount * 1000) / (now - lastFpsUpdate));
        frameCount = 0;
        lastFpsUpdate = now;
        if (infoBadge) {
          infoBadge.textContent = `5:3 (${PROCESS_WIDTH}×${PROCESS_HEIGHT}) ${currentFps}fps`;
        }
      }
    }
  }

  requestAnimationFrame(renderLoop);
}

// iOS Safariで自動再生がブロックされた場合の画面タップ復帰
let lastTapTime = 0;
container.addEventListener('click', () => {
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
  try {
    // モデル読み込みとカメラ起動を並列で実行し、起動時間を短縮
    await Promise.all([initPoseLandmarker(), startCamera()]);
    requestAnimationFrame(renderLoop);
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
