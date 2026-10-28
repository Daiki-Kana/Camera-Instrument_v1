// --- 拍手検知 ---
// HandLandmarkerで検出した両手の「手のひらの中心」を求め、
// 2つの手のひらが拍手するほど近づいた瞬間を拍手1回として検出する
// 想定: カメラは演奏者の正面から演奏者に向いており、体を背景に両手が手前に映る

// 手のひらの中心を求めるのに使う点（手首と、人差し指〜小指の付け根）
const PALM_LANDMARKS = [0, 5, 9, 13, 17];

// 閾値（手のひらの大きさ＝手首〜中指の付け根の長さを1としたときの、両手のひら中心の距離）
// 手の大きさを基準にするため、カメラに手を近づけても遠ざけても同じ感覚で判定できる
export const CLOSE_THRESHOLD = 0.8; // これより近づいたら手が合わさったとみなす
const OPEN_THRESHOLD = 1.6;         // これより離れたら次の拍手を受け付ける（ヒステリシス）
const COOLDOWN_MS = 120;            // 連続検出を防ぐ最短間隔

// 先読み判定: 勢いよく近づいている場合、次のフレームで合わさると予測できた時点で鳴らし、1フレーム分の遅延を削減
const PREDICT_MAX_RATIO = 1.5; // この距離より近づいてから先読みを行う

// 手が重なって片方（または両方）が見えなくなった場合の判定
// 素早い拍手では、手が合わさる前のフレームで既に片手が隠れて検出されなくなることが多いため、
// 「見えなくなる直前に近くにいた」か「勢いよく近づいていた」なら拍手とみなす
const LOSS_WINDOW_MS = 250;      // 見えなくなる直前のこの時間内の動きを判定に使う
const MERGE_THRESHOLD = 1.3;     // 直前の距離がこれ未満なら、重なったとみなす
const APPROACH_THRESHOLD = 2.5;  // 直前の距離がこれ未満かつ…
const APPROACH_SPEED = 3.0;      // …この速さ（手のひらの大きさ/秒）以上で近づいていたら、重なったとみなす

// 拍手の強さ（音量）: 手が近づく速さをこの範囲で 0〜1 に換算
const SOFT_SPEED = 2;   // これ以下の速さは最小音量
const HARD_SPEED = 15;  // これ以上の速さは最大音量
const MIN_STRENGTH = 0.25;

// 処理画像は5:3のため、高さを1とした座標に補正して距離を計算
const ASPECT_X = 5 / 3;
const ASPECT_Y = 1;

function distance(p1, p2) {
  const dx = (p1.x - p2.x) * ASPECT_X;
  const dy = (p1.y - p2.y) * ASPECT_Y;
  return Math.hypot(dx, dy);
}

// 手のひらの中心座標（正規化座標）と大きさ（画像の高さ=1）
export function getPalm(landmarks) {
  let x = 0, y = 0;
  for (const idx of PALM_LANDMARKS) {
    x += landmarks[idx].x;
    y += landmarks[idx].y;
  }
  return {
    x: x / PALM_LANDMARKS.length,
    y: y / PALM_LANDMARKS.length,
    size: distance(landmarks[0], landmarks[9])
  };
}

export class ClapDetector {
  constructor() {
    this.reset();
  }

  // 戻り値: palms（各手のひら）, ratio（両手のひらの距離／手のひらの大きさ）,
  //         isArmed（次の拍手を受け付け中か）, clap（拍手を検出したフレームのみ { x, y, timestamp, strength }）
  update(handLandmarks, timestamp) {
    const palms = handLandmarks.map(getPalm);
    let ratio = null;
    let clap = null;

    if (palms.length >= 2) {
      const [a, b] = palms;
      const palmSize = (a.size + b.size) / 2;
      if (palmSize > 1e-3) {
        ratio = distance(a, b) / palmSize;
        this.lastMidpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        this.history.push({ t: timestamp, ratio });
      }
    }
    // 古い履歴を破棄
    while (this.history.length > 0 && timestamp - this.history[0].t > LOSS_WINDOW_MS) {
      this.history.shift();
    }

    if (ratio !== null) {
      if (ratio > OPEN_THRESHOLD) {
        this.isArmed = true;
      } else if (this.isArmed && (ratio < CLOSE_THRESHOLD || this.willCloseByNextFrame(ratio))) {
        clap = this.trigger(this.lastMidpoint, timestamp);
      }
    } else if (this.isArmed && this.wasMergingBeforeLoss()) {
      clap = this.trigger(this.lastMidpoint, timestamp);
    }

    return { palms, ratio, isArmed: this.isArmed, clap };
  }

  // 直前フレームからの接近速度が続くと仮定し、次のフレームまでに手が合わさるかを予測
  willCloseByNextFrame(ratio) {
    if (ratio > PREDICT_MAX_RATIO || this.history.length < 2) return false;
    const prev = this.history[this.history.length - 2];
    const last = this.history[this.history.length - 1];
    const frameMs = last.t - prev.t;
    if (frameMs <= 0) return false;
    const closingPerFrame = prev.ratio - last.ratio; // 1フレームで縮まった距離
    return closingPerFrame > 0 && ratio - closingPerFrame < CLOSE_THRESHOLD;
  }

  // 両手が見えなくなる直前の履歴から、手が重なって隠れたのかを判定
  wasMergingBeforeLoss() {
    if (this.history.length === 0) return false;

    const last = this.history[this.history.length - 1];
    if (last.ratio < MERGE_THRESHOLD) return true;
    return last.ratio < APPROACH_THRESHOLD && this.approachSpeed() > APPROACH_SPEED;
  }

  // 直近の履歴から、両手が近づく速さ（手のひらの大きさ/秒）を求める
  approachSpeed() {
    if (this.history.length < 2) return 0;
    const first = this.history[0];
    const last = this.history[this.history.length - 1];
    const elapsedSec = (last.t - first.t) / 1000;
    return elapsedSec > 0 ? (first.ratio - last.ratio) / elapsedSec : 0;
  }

  trigger(position, timestamp) {
    const speed = this.approachSpeed();
    this.isArmed = false;
    this.history = [];
    if (timestamp - this.lastClapTime < COOLDOWN_MS) return null;
    this.lastClapTime = timestamp;

    const normalized = Math.min(1, Math.max(0, (speed - SOFT_SPEED) / (HARD_SPEED - SOFT_SPEED)));
    const strength = MIN_STRENGTH + (1 - MIN_STRENGTH) * normalized;
    return { x: position.x, y: position.y, timestamp, strength };
  }

  reset() {
    this.isArmed = false;
    this.history = []; // 両手が見えていたフレームの { t, ratio }
    this.lastMidpoint = null;
    this.lastClapTime = -Infinity;
  }
}
