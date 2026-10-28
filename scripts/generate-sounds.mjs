// 拍手時に鳴らす短い効果音を合成し、public/sounds/ に WAV として書き出す
// 実行: node scripts/generate-sounds.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SAMPLE_RATE = 44100;
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sounds');

// 毎回同じ音になるよう、シード固定の乱数でノイズを生成
let seed = 12345;
function noise() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return (seed / 0xffffffff) * 2 - 1;
}

function render(durationSec, fn) {
  const length = Math.floor(durationSec * SAMPLE_RATE);
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    samples[i] = fn(i / SAMPLE_RATE, i);
  }
  return samples;
}

// 1次ハイパスフィルター（シャリっとした高域成分だけを残す）
function highpass(samples, cutoffHz) {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const a = rc / (rc + 1 / SAMPLE_RATE);
  const out = new Float32Array(samples.length);
  let prevIn = 0, prevOut = 0;
  for (let i = 0; i < samples.length; i++) {
    prevOut = a * (prevOut + samples[i] - prevIn);
    prevIn = samples[i];
    out[i] = prevOut;
  }
  return out;
}

// 2次バンドパスフィルター（特定の帯域を強調）
function bandpass(samples, centerHz, q) {
  const w0 = (2 * Math.PI * centerHz) / SAMPLE_RATE;
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0, b2 = -alpha / a0;
  const a1 = (-2 * Math.cos(w0)) / a0, a2 = (1 - alpha) / a0;
  const out = new Float32Array(samples.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i];
    const y0 = b0 * x0 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    out[i] = y0;
  }
  return out;
}

// シュレーダー型リバーブ（並列コムフィルター + 直列オールパス）で空間の響きを付加
function reverb(samples, { combMs, decaySec, wet }) {
  const length = samples.length;
  const wetOut = new Float32Array(length);
  for (const ms of combMs) {
    const delay = Math.floor((ms / 1000) * SAMPLE_RATE);
    const feedback = Math.pow(10, (-3 * ms) / 1000 / decaySec); // decaySec で -60dB
    const buf = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      buf[i] = samples[i] + (i >= delay ? feedback * buf[i - delay] : 0);
      wetOut[i] += buf[i] / combMs.length;
    }
  }
  for (const ms of [5.0, 1.7]) {
    const delay = Math.floor((ms / 1000) * SAMPLE_RATE);
    const g = 0.7;
    const input = Float32Array.from(wetOut);
    for (let i = 0; i < length; i++) {
      const delayedIn = i >= delay ? input[i - delay] : 0;
      const delayedOut = i >= delay ? wetOut[i - delay] : 0;
      wetOut[i] = -g * input[i] + delayedIn + g * delayedOut;
    }
  }
  return samples.map((s, i) => s * (1 - wet) + wetOut[i] * wet);
}

// ピークを揃え、末尾をフェードアウトしてプチノイズを防ぐ（channels: チャンネルごとの配列）
function finalize(channels, peak = 0.9) {
  let max = 0;
  for (const ch of channels) for (const s of ch) max = Math.max(max, Math.abs(s));
  const gain = max > 0 ? peak / max : 0;
  for (const samples of channels) {
    const fadeLen = Math.min(samples.length, Math.floor(0.005 * SAMPLE_RATE));
    for (let i = 0; i < samples.length; i++) {
      samples[i] *= gain;
      const remain = samples.length - i;
      if (remain < fadeLen) samples[i] *= remain / fadeLen;
    }
  }
  return channels;
}

function writeWav(fileName, channels) {
  const numChannels = channels.length;
  const length = channels[0].length;
  const blockAlign = numChannels * 2;
  const dataSize = length * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);          // fmtチャンクサイズ
  buf.writeUInt16LE(1, 20);           // PCM
  buf.writeUInt16LE(numChannels, 22); // 1: モノラル / 2: ステレオ
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * blockAlign, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34);          // 16bit
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      buf.writeInt16LE(Math.round(s * 32767), 44 + i * blockAlign + c * 2);
    }
  }
  writeFileSync(join(OUT_DIR, fileName), buf);
}

const sounds = {
  // キック：150Hz→45Hzへ急降下する正弦波
  'kick.wav': () => {
    let phase = 0;
    return render(0.35, (t) => {
      const freq = 45 + 105 * Math.exp(-t * 30);
      phase += (2 * Math.PI * freq) / SAMPLE_RATE;
      return Math.sin(phase) * Math.exp(-t * 9);
    });
  },

  // スネア：胴鳴りの低音 + 減衰するノイズ
  'snare.wav': () => {
    const tone = render(0.25, (t) => Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t * 25) * 0.6);
    const rattle = highpass(render(0.25, (t) => noise() * Math.exp(-t * 18)), 1500);
    return tone.map((s, i) => s + rattle[i]);
  },

  // ハイハット：高域ノイズのごく短い減衰
  'hihat.wav': () => highpass(render(0.08, (t) => noise() * Math.exp(-t * 60)), 7000),

  // クラップ：細かく3回重なるノイズバースト + 残響
  'clap.wav': () => {
    const bursts = [0, 0.011, 0.022];
    const raw = render(0.3, (t) => {
      let env = 0;
      for (const start of bursts) {
        if (t >= start && t < start + 0.011) env = Math.max(env, Math.exp(-(t - start) * 200));
      }
      if (t >= 0.033) env = Math.max(env, 0.6 * Math.exp(-(t - 0.033) * 20));
      return noise() * env;
    });
    return bandpass(raw, 1200, 1.2);
  },

  // ベル：非整数倍音を含む金属的な響き
  'bell.wav': () => render(0.8, (t) => {
    const base = 880;
    return (
      Math.sin(2 * Math.PI * base * t) * Math.exp(-t * 4) +
      0.5 * Math.sin(2 * Math.PI * base * 2.76 * t) * Math.exp(-t * 7) +
      0.25 * Math.sin(2 * Math.PI * base * 5.4 * t) * Math.exp(-t * 12)
    );
  }),

  // ウッドブロック：短く乾いた打撃音
  'woodblock.wav': () => render(0.12, (t) => (
    Math.sin(2 * Math.PI * 820 * t) * Math.exp(-t * 45) +
    0.4 * Math.sin(2 * Math.PI * 1640 * t) * Math.exp(-t * 70)
  )),

  // プラック：Karplus-Strong法による弦をはじいた音（ラ音 220Hz）
  'pluck.wav': () => {
    const period = Math.round(SAMPLE_RATE / 220);
    const ring = Float32Array.from({ length: period }, () => noise());
    let idx = 0;
    return render(0.6, () => {
      const next = (idx + 1) % period;
      const out = ring[idx];
      ring[idx] = 0.498 * (ring[idx] + ring[next]);
      idx = next;
      return out;
    });
  },

  // クラッシュシンバル（ステレオ）：多数の非整数倍音が重なって「シャーン」と長く広がり、
  // 叩いた直後は明るく、余韻は徐々に丸くなる。部屋の残響を加えて空間的な響きを出す
  'crash.wav': () => {
    const duration = 5.0;
    const length = Math.floor(duration * SAMPLE_RATE);
    const LOW = 380, HIGH = 12000;

    const makeChannel = (reverbCombMs) => {
      const out = new Float32Array(length);

      // 金属板の複雑な振動を模した160本の倍音（低い成分ほど長く響き、高い成分は控えめ）
      for (let n = 0; n < 160; n++) {
        const u = (noise() + 1) / 2;
        const freq = LOW * Math.pow(HIGH / LOW, u); // 対数的に均等分布
        const amp = Math.pow(freq / LOW, -0.45);     // 高域を抑えて刺さる響きを防ぐ
        const decaySec = 4.0 * Math.pow(freq / LOW, -0.3);
        const bloomSec = 0.003 + 0.04 * u;           // 高い成分ほど遅れて立ち上がる（叩いた後の広がり）
        const w = (2 * Math.PI * freq) / SAMPLE_RATE;
        const phase = noise() * Math.PI;
        const decay = Math.exp(-1 / (decaySec * SAMPLE_RATE));
        const bloom = Math.exp(-1 / (bloomSec * SAMPLE_RATE));
        let env = amp, bloomEnv = 1;
        for (let i = 0; i < length; i++) {
          out[i] += Math.sin(w * i + phase) * env * (1 - bloomEnv);
          env *= decay;
          bloomEnv *= bloom;
        }
      }

      // スティックが当たった瞬間のごく短いアタック（控えめ）
      const attack = bandpass(render(duration, (t) => noise() * Math.exp(-t * 80)), 5000, 0.8);
      for (let i = 0; i < length; i++) out[i] = out[i] / 20 + attack[i] * 0.25;

      // 時間とともに高域を落とす（明るいアタック → 丸い余韻）
      let lp = 0;
      for (let i = 0; i < length; i++) {
        const t = i / SAMPLE_RATE;
        const cutoff = 5000 + 9000 * Math.exp(-t * 1.2);
        const a = 1 - Math.exp((-2 * Math.PI * cutoff) / SAMPLE_RATE);
        lp += a * (out[i] - lp);
        out[i] = lp;
      }

      const wet = reverb(highpass(out, 250), { combMs: reverbCombMs, decaySec: 2.2, wet: 0.3 });

      // 末尾1.5秒で自然に消えるようフェードアウト
      const fadeLen = Math.floor(1.5 * SAMPLE_RATE);
      for (let i = length - fadeLen; i < length; i++) {
        const p = (i - (length - fadeLen)) / fadeLen;
        wet[i] *= 0.5 * (1 + Math.cos(Math.PI * p));
      }
      return wet;
    };

    // 左右で異なる倍音・残響にして広がりを出す
    return [
      makeChannel([29.7, 37.1, 41.1, 43.7]),
      makeChannel([31.3, 35.9, 40.3, 45.1])
    ];
  },

  // タンバリン（ステレオ）：打面を叩いた軽い「トッ」と、小さな鈴（ジングル）が
  // わずかな時間差で次々に鳴る「シャラッ」という短い響き
  'tambourine.wav': () => {
    const duration = 0.5;
    const length = Math.floor(duration * SAMPLE_RATE);

    const makeChannel = () => {
      const out = new Float32Array(length);

      // ジングルが少しずつずれて鳴る（後のものほど小さい）
      const hitTimes = [0, 0.007, 0.015, 0.024, 0.036, 0.052, 0.075];
      hitTimes.forEach((hitTime, k) => {
        const start = Math.floor((hitTime + (noise() + 1) * 0.002) * SAMPLE_RATE);
        const hitAmp = Math.pow(0.72, k);
        // 1枚のジングルは高い非整数倍音の集まり
        for (let n = 0; n < 8; n++) {
          const freq = 3200 * Math.pow(11000 / 3200, (noise() + 1) / 2);
          const w = (2 * Math.PI * freq) / SAMPLE_RATE;
          const phase = noise() * Math.PI;
          const decay = Math.exp(-(22 + (noise() + 1) * 10) / SAMPLE_RATE);
          let env = hitAmp * Math.pow(freq / 3200, -0.4);
          for (let i = start; i < length; i++) {
            out[i] += Math.sin(w * (i - start) + phase) * env;
            env *= decay;
          }
        }
      });

      // ジングル同士がこすれる「シャッ」というノイズ
      const sizzle = highpass(render(duration, (t) => {
        let env = 0;
        for (const [k, hitTime] of hitTimes.entries()) {
          if (t >= hitTime) env += Math.pow(0.72, k) * Math.exp(-(t - hitTime) * 45);
        }
        return noise() * env;
      }), 6000);

      // 打面の軽い「トッ」
      const thump = render(duration, (t) => Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 45));

      for (let i = 0; i < length; i++) {
        out[i] = out[i] / 8 + sizzle[i] * 0.35 + thump[i] * 0.25;
      }
      return out;
    };

    return [makeChannel(), makeChannel()];
  },

  // ザップ：高音から低音へ駆け下りる電子音
  'zap.wav': () => {
    let phase = 0;
    return render(0.2, (t) => {
      const freq = 200 + 1800 * Math.exp(-t * 25);
      phase += (2 * Math.PI * freq) / SAMPLE_RATE;
      return (Math.sin(phase) > 0 ? 1 : -1) * 0.5 * Math.exp(-t * 15);
    });
  }
};

mkdirSync(OUT_DIR, { recursive: true });
for (const [fileName, build] of Object.entries(sounds)) {
  const result = build();
  writeWav(fileName, finalize(Array.isArray(result) ? result : [result]));
  console.log(`生成: public/sounds/${fileName}`);
}
