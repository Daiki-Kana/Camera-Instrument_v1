// --- 音声ファイルの再生 ---
// Web Audio API で事前にデコードしたバッファを保持し、選択中の音色を低遅延で再生する

export class SoundPlayer {
  // sounds: [{ id, url }]
  constructor(sounds) {
    this.sounds = sounds;
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.buffers = new Map();
    this.currentId = sounds[0]?.id ?? null;
  }

  // 全ファイルを読み込み、成功した数を返す（失敗したファイルはスキップ）
  async load() {
    await Promise.all(
      this.sounds.map(async ({ id, url }) => {
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          this.buffers.set(id, await this.ctx.decodeAudioData(await res.arrayBuffer()));
        } catch (err) {
          console.warn(`音声ファイルの読み込みに失敗しました: ${url}`, err);
        }
      })
    );
    return this.buffers.size;
  }

  // ブラウザの自動再生制限により、ユーザー操作（タップ）後でないと音が出ない
  get isUnlocked() {
    return this.ctx.state === 'running';
  }

  unlock() {
    if (this.ctx.state === 'suspended') {
      return this.ctx.resume();
    }
    return Promise.resolve();
  }

  // 拍手で鳴らす音色を切り替え
  select(id) {
    this.currentId = id;
  }

  // 選択中の音色を再生（volume: 0〜1）
  play(volume = 1) {
    const buffer = this.buffers.get(this.currentId);
    if (!buffer || !this.isUnlocked) return;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    source.connect(gain).connect(this.ctx.destination);
    source.start();
  }
}
