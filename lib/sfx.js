/**
 * 程序化音效合成（SFX）：直接生成 WAV，不依赖任何模型。
 *
 * 为什么自己做而不是接模型：
 *   ① 你机器上没有音效生成模型（GPT-SoVITS 是 TTS/换声，YuE2/YingMusic 是音乐，
 *      VoiceStudio 的 job 类型里没有 sfx）。
 *   ② 更重要的是 —— **像素游戏的经典音效本来就是合成的**（8/16 位时代没有采样库，
 *      金币声是方波、激光是下滑锯齿波、爆炸是滤波噪声）。用模型去"生成"反而容易糊。
 *   ③ 合成是**确定性**的：同一个 seed 永远得到逐字节相同的文件，可以进版本库、可复现。
 *      模型生成做不到这一点。
 *
 * 所以这里给的是：一串能调参数的音效配方（preset）+ 一个纯 JS 的合成器 + WAV 编码。
 * 零依赖、离线、毫秒级出结果。
 *
 * 输出格式：16 位 PCM 单声道（可选立体声）。44100Hz 默认；
 * 想做"复古感"就把 sampleRate 调到 22050（更接近老主机）。
 */

const TAU = Math.PI * 2

/** 确定性伪随机（mulberry32）：同 seed 同序列，保证可复现。 */
export function makeRng(seed = 1) {
  let a = (Number(seed) || 1) >>> 0
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ---------------- 基础波形（相位用 0~1 的循环相位，不累加时间） ---------------- */
const wave = {
  sine: (p) => Math.sin(TAU * p),
  square: (p) => (p % 1 < 0.5 ? 1 : -1),
  saw: (p) => 2 * ((p % 1) - 0.5),
  triangle: (p) => 1 - 4 * Math.abs((p % 1) - 0.5),
  /** 脉宽可变的方波（8 位机的"细"音色） */
  pulse: (p, duty = 0.25) => (p % 1 < duty ? 1 : -1),
}

/** 简单一阶低通（用在噪声上做"钝化"）。 */
function lowpass(samples, cutoffHz, sampleRate) {
  const k = Math.min(0.999, Math.max(0.001, 1 - Math.exp((-TAU * cutoffHz) / sampleRate)))
  let y = 0
  for (let i = 0; i < samples.length; i++) {
    y += k * (samples[i] - y)
    samples[i] = y
  }
  return samples
}

/** 一阶高通（去掉低频轰鸣，让"咔"更清脆）。 */
function highpass(samples, cutoffHz, sampleRate) {
  const k = Math.min(0.999, Math.max(0.001, 1 - Math.exp((-TAU * cutoffHz) / sampleRate)))
  let prevX = 0
  let prevY = 0
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i]
    const y = k * (prevY + x - prevX)
    prevX = x
    prevY = y
    samples[i] = y
  }
  return samples
}

/** 指数衰减包络（音效最常用：起音快、尾巴指数衰减）。 */
function decayEnvelope(i, total, { attack = 0.005, decay = 0.3 } = {}) {
  const t = i / total
  const a = attack <= 0 ? 1 : Math.min(1, t / attack)
  return a * Math.exp(-t / Math.max(1e-6, decay))
}

/** 淡出尾巴，避免末尾"啪"一声（不淡出会有直流跳变）。 */
function fadeOut(samples, seconds, sampleRate) {
  const n = Math.min(samples.length, Math.floor(seconds * sampleRate))
  for (let i = 0; i < n; i++) {
    samples[samples.length - 1 - i] *= i / n
  }
  return samples
}

function normalize(samples, peak = 0.85) {
  let max = 0
  for (const v of samples) max = Math.max(max, Math.abs(v))
  if (max < 1e-9) return samples
  const gain = peak / max
  for (let i = 0; i < samples.length; i++) samples[i] *= gain
  return samples
}

/**
 * 音效配方表。
 * 每个配方拿到 (ctx) 往里填 samples；ctx 里有 sampleRate / duration / rng / semitone 等。
 * 参数都做了上下限夹取，避免用户传个 999 秒的爆炸声把内存打爆。
 */
export const SFX_PRESETS = {
  coin: { label: '金币（经典两音）', hint: '拾取/得分', generate: coinGen },
  laser: { label: '激光', hint: '射击/能量枪', generate: laserGen },
  impact: { label: '撞击', hint: '重物砸地/碰撞', generate: impactGen },
  explosion: { label: '爆炸', hint: '大范围破坏', generate: explosionGen },
  whoosh: { label: '挥砍 / 风', hint: '攻击/闪避/切换', generate: whooshGen },
  powerup: { label: '强化', hint: '升级/获得能力', generate: powerupGen },
  hit: { label: '受击', hint: '角色受伤', generate: hitGen },
  jump: { label: '跳跃', hint: '起跳', generate: jumpGen },
  blip: { label: '短提示音', hint: 'UI/对话推进', generate: blipGen },
  alarm: { label: '警报', hint: '危险/计时', generate: alarmGen },
  click: { label: '点击', hint: 'UI 按钮', generate: clickGen },
  footstep: { label: '脚步', hint: '行走（可换 seed 做差异）', generate: footstepGen },
  glass: { label: '玻璃碎', hint: '破坏/碎裂', generate: glassGen },
  electric: { label: '电流', hint: '技能/机械故障', generate: electricGen },
  magic: { label: '魔法', hint: '施法/疗愈', generate: magicGen },
  noise: { label: '纯噪声', hint: '做底噪/占位', generate: noiseGen },
}

export function sfxList() {
  return Object.entries(SFX_PRESETS).map(([id, p]) => ({ id, label: p.label, hint: p.hint }))
}

/* ---------------- 具体配方 ---------------- */

function coinGen({ samples, sampleRate, duration, rng, semitone }) {
  // 经典两段方波：B5 → E6，第二段更长
  const notes = [987.77, 1318.51]
  const split = Math.floor(samples.length * 0.38)
  let phase = 0
  for (let i = 0; i < samples.length; i++) {
    const note = i < split ? notes[0] : notes[1]
    const freq = note * Math.pow(2, semitone / 12)
    phase += freq / sampleRate
    const env = i < split ? decayEnvelope(i, split, { decay: 0.7 }) : decayEnvelope(i - split, samples.length - split, { decay: 0.9 })
    samples[i] = 0.35 * wave.square(phase) * env
  }
}

function laserGen({ samples, sampleRate, rng, semitone, brightness }) {
  let phase = 0
  const base = 1800 * Math.pow(2, semitone / 12)
  for (let i = 0; i < samples.length; i++) {
    const t = i / samples.length
    // 频率从高往下滑，t^0.5 让下滑感觉更"甩"
    const freq = base * Math.pow(1 - 0.85 * Math.sqrt(t), 1) + 80
    phase += freq / sampleRate
    const env = decayEnvelope(i, samples.length, { decay: 0.45 })
    const vib = Math.sin(TAU * 55 * (i / sampleRate)) * 0.06 * brightness
    samples[i] = 0.4 * wave.saw(phase + vib) * env
  }
  highpass(samples, 120, sampleRate)
}

function impactGen({ samples, sampleRate, rng, semitone }) {
  let phase = 0
  const base = 120 * Math.pow(2, semitone / 12)
  for (let i = 0; i < samples.length; i++) {
    const t = i / samples.length
    // 低频下坠（体感）+ 噪声（质感）
    const freq = base * (1 - 0.6 * t)
    phase += freq / sampleRate
    const thump = wave.sine(phase) * decayEnvelope(i, samples.length, { decay: 0.18 })
    const click = (rng() * 2 - 1) * decayEnvelope(i, samples.length, { decay: 0.03 })
    samples[i] = 0.7 * thump + 0.35 * click
  }
  lowpass(samples, 2200, sampleRate)
}

function explosionGen({ samples, sampleRate, rng, semitone }) {
  // 主噪声 + 低频轰鸣，衰减比撞击长得多
  let phase = 0
  const base = 70 * Math.pow(2, semitone / 12)
  for (let i = 0; i < samples.length; i++) {
    const t = i / samples.length
    phase += (base * (1 - 0.5 * t)) / sampleRate
    const rumble = wave.sine(phase) * 0.5
    const noise = (rng() * 2 - 1)
    const env = decayEnvelope(i, samples.length, { decay: 0.5 })
    // 噪声先亮后闷：模拟"炸开→余烬"
    samples[i] = (noise * 0.8 * (1 - t * 0.7) + rumble) * env
  }
  lowpass(samples, 1600, sampleRate)
}

function whooshGen({ samples, sampleRate, rng, brightness }) {
  // 带通式的噪声：用"移动平均"当粗糙带通，扫过去就是风声
  let lp = 0
  let hp = 0
  for (let i = 0; i < samples.length; i++) {
    const t = i / samples.length
    const noise = rng() * 2 - 1
    // 截止频率随时间上下扫（0 → 中 → 0）
    const cutoff = 300 + 3000 * brightness * Math.sin(Math.PI * t)
    const k = Math.min(0.999, (TAU * cutoff) / sampleRate)
    lp += k * (noise - lp)
    hp += 0.02 * (lp - hp)
    const env = Math.sin(Math.PI * t) ** 1.5 // 中间最响
    samples[i] = (lp - hp) * env * 0.9
  }
  fadeOut(samples, 0.01, sampleRate)
}

function powerupGen({ samples, sampleRate, rng, semitone }) {
  // 上行琶音（4 个音，越来越亮）
  const steps = 4
  const baseFreq = 523.25 * Math.pow(2, semitone / 12)
  const per = Math.floor(samples.length / steps)
  let phase = 0
  for (let i = 0; i < samples.length; i++) {
    const step = Math.min(steps - 1, Math.floor(i / per))
    const freq = baseFreq * Math.pow(2, (step * 3) / 12)
    phase += freq / sampleRate
    const local = i - step * per
    const env = decayEnvelope(local, per, { decay: 1.6 })
    samples[i] = 0.3 * wave.pulse(phase, 0.3) * env
  }
  highpass(samples, 200, sampleRate)
}

function hitGen({ samples, sampleRate, rng, semitone }) {
  let phase = 0
  const base = 200 * Math.pow(2, semitone / 12)
  for (let i = 0; i < samples.length; i++) {
    const t = i / samples.length
    phase += (base * (1 - 0.4 * t)) / sampleRate
    const tone = wave.triangle(phase) * decayEnvelope(i, samples.length, { decay: 0.12 })
    const grit = (rng() * 2 - 1) * decayEnvelope(i, samples.length, { decay: 0.04 })
    samples[i] = 0.6 * tone + 0.4 * grit
  }
  lowpass(samples, 3000, sampleRate)
}

function jumpGen({ samples, sampleRate, rng, semitone }) {
  let phase = 0
  const base = 330 * Math.pow(2, semitone / 12)
  for (let i = 0; i < samples.length; i++) {
    const t = i / samples.length
    phase += (base * (1 + 1.2 * t)) / sampleRate // 上滑 = 起跳感
    samples[i] = 0.3 * wave.square(phase) * decayEnvelope(i, samples.length, { decay: 0.6 })
  }
}

function blipGen({ samples, sampleRate, rng, semitone }) {
  let phase = 0
  const freq = 880 * Math.pow(2, semitone / 12)
  for (let i = 0; i < samples.length; i++) {
    phase += freq / sampleRate
    samples[i] = 0.4 * wave.sine(phase) * decayEnvelope(i, samples.length, { decay: 0.35 })
  }
  fadeOut(samples, 0.005, sampleRate)
}

function alarmGen({ samples, sampleRate, rng, semitone }) {
  let phase = 0
  const a = 740 * Math.pow(2, semitone / 12)
  const b = 988 * Math.pow(2, semitone / 12)
  const period = Math.floor(samples.length / 4) || 1
  for (let i = 0; i < samples.length; i++) {
    const on = Math.floor(i / period) % 2 === 0 ? a : b
    phase += on / sampleRate
    // 每段留一点空隙，警报才有"滴-嘟"感
    const local = (i % period) / period
    const env = local < 0.85 ? 1 : Math.max(0, (1 - local) / 0.15)
    samples[i] = 0.28 * wave.square(phase) * env
  }
}

function clickGen({ samples, sampleRate, rng }) {
  for (let i = 0; i < samples.length; i++) {
    samples[i] = (rng() * 2 - 1) * decayEnvelope(i, samples.length, { decay: 0.012 })
  }
  highpass(samples, 900, sampleRate)
}

function footstepGen({ samples, sampleRate, rng, semitone }) {
  let phase = 0
  const base = 90 * Math.pow(2, semitone / 12)
  for (let i = 0; i < samples.length; i++) {
    phase += base / sampleRate
    const thump = wave.sine(phase) * decayEnvelope(i, samples.length, { decay: 0.1 })
    const scuff = (rng() * 2 - 1) * decayEnvelope(i, samples.length, { decay: 0.06 })
    samples[i] = 0.6 * thump + 0.3 * scuff
  }
  lowpass(samples, 1400, sampleRate)
}

function glassGen({ samples, sampleRate, rng, semitone }) {
  // 多个高频"碎片"，起点随机错开一点
  const shards = 7
  for (let s = 0; s < shards; s++) {
    const start = Math.floor(rng() * samples.length * 0.25)
    const freq = (2200 + rng() * 4200) * Math.pow(2, semitone / 12)
    const len = Math.floor((0.04 + rng() * 0.12) * sampleRate)
    let phase = 0
    for (let i = 0; i < len; i++) {
      const idx = start + i
      if (idx >= samples.length) break
      phase += freq / sampleRate
      samples[idx] += 0.22 * wave.sine(phase) * decayEnvelope(i, len, { decay: 0.25 })
    }
  }
  // 底下垫一点噪声（碎片的"沙"）
  for (let i = 0; i < samples.length; i++) {
    samples[i] += (rng() * 2 - 1) * 0.16 * decayEnvelope(i, samples.length, { decay: 0.2 })
  }
  highpass(samples, 1200, sampleRate)
}

function electricGen({ samples, sampleRate, rng, semitone }) {
  let phase = 0
  const base = 220 * Math.pow(2, semitone / 12)
  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate
    // 快速频率抖动 = 电流的"嗡"
    const jitter = 1 + 0.35 * Math.sign(Math.sin(TAU * 37 * t)) * Math.sin(TAU * 3 * t)
    phase += (base * jitter) / sampleRate
    const env = decayEnvelope(i, samples.length, { decay: 0.5 })
    samples[i] = 0.3 * wave.saw(phase) * env + 0.12 * (rng() * 2 - 1) * env
  }
  highpass(samples, 150, sampleRate)
}

function magicGen({ samples, sampleRate, rng, semitone }) {
  // FM 钟声：载波 + 调制，产生金属泛音
  const carrier = 880 * Math.pow(2, semitone / 12)
  const mod = carrier * 2.01
  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate
    const env = decayEnvelope(i, samples.length, { decay: 0.55 })
    const m = Math.sin(TAU * mod * t) * 2.2 * Math.exp(-t * 3)
    samples[i] = 0.3 * Math.sin(TAU * carrier * t + m) * env
  }
  fadeOut(samples, 0.01, sampleRate)
}

function noiseGen({ samples, sampleRate, rng }) {
  for (let i = 0; i < samples.length; i++) samples[i] = (rng() * 2 - 1) * 0.5
  fadeOut(samples, 0.02, sampleRate)
}

/* ---------------- 渲染 & WAV 编码 ---------------- */

export const SFX_LIMITS = {
  minDuration: 0.05,
  maxDuration: 8,
  minSampleRate: 8000,
  maxSampleRate: 48000,
  defaultSampleRate: 44100,
}

/**
 * 合成一个音效。
 * @returns {{samples:Float32Array, sampleRate:number, duration:number, preset:string, warnings:string[]}}
 */
export function synthSfx({ preset = 'coin', duration, pitch = 0, brightness = 1, seed = 1, sampleRate, volume = 1 } = {}) {
  const id = String(preset || 'coin')
  const def = SFX_PRESETS[id]
  if (!def) {
    const known = Object.keys(SFX_PRESETS).join(', ')
    throw new Error(`不认识的音效「${id}」。可用：${known}`)
  }
  const warnings = []
  const sr = Math.round(Math.min(SFX_LIMITS.maxSampleRate, Math.max(SFX_LIMITS.minSampleRate,
    Number(sampleRate) || SFX_LIMITS.defaultSampleRate)))
  const defaultDur = id === 'explosion' ? 1.2 : id === 'alarm' ? 0.8 : id === 'footstep' || id === 'click' ? 0.12 : 0.35
  const dur = Math.min(SFX_LIMITS.maxDuration, Math.max(SFX_LIMITS.minDuration, Number(duration) || defaultDur))
  if (Number(duration) > SFX_LIMITS.maxDuration) warnings.push(`时长被夹到上限 ${SFX_LIMITS.maxDuration}s（再长就不像"音效"了）`)

  const total = Math.max(1, Math.floor(sr * dur))
  const samples = new Float32Array(total)
  def.generate({
    samples,
    sampleRate: sr,
    duration: dur,
    rng: makeRng(seed),
    semitone: Number(pitch) || 0,
    brightness: Math.max(0.1, Math.min(2, Number(brightness) || 1)),
  })
  normalize(samples, Math.min(0.98, Math.max(0.05, Number(volume) || 1) * 0.85))
  fadeOut(samples, 0.02, sr)
  return { samples, sampleRate: sr, duration: dur, preset: id, warnings }
}

/** Float32 样本 → 16 位 PCM 单声道/立体声 WAV。 */
export function encodeWav(samples, { sampleRate = 44100, channels = 1 } = {}) {
  const ch = channels === 2 ? 2 : 1
  const frames = samples.length
  const dataBytes = frames * ch * 2
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)              // fmt chunk 大小
  buffer.writeUInt16LE(1, 20)               // PCM
  buffer.writeUInt16LE(ch, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * ch * 2, 28) // byte rate
  buffer.writeUInt16LE(ch * 2, 32)          // block align
  buffer.writeUInt16LE(16, 34)              // bits per sample
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataBytes, 40)
  let offset = 44
  for (let i = 0; i < frames; i++) {
    // 夹取 + 有符号 16 位量化（不夹会爆音，量化用 round 而不是隐式截断）
    const v = Math.max(-1, Math.min(1, samples[i]))
    const q = Math.round(v * 32767)
    for (let c = 0; c < ch; c++) {
      buffer.writeInt16LE(q, offset)
      offset += 2
    }
  }
  return buffer
}

/** 一步到位：preset → WAV Buffer。 */
export function renderSfxToWav(options = {}) {
  const { samples, sampleRate, duration, preset, warnings } = synthSfx(options)
  const wav = encodeWav(samples, { sampleRate, channels: options.channels === 2 ? 2 : 1 })
  return { wav, sampleRate, duration, preset, warnings, frames: samples.length, bytes: wav.length }
}
