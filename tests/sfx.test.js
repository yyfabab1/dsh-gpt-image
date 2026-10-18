/**
 * 程序化音效测试。
 *
 * 这个模块最容易出的问题是「看起来生成了文件，但其实是静音/爆音/头不对」——
 * 所以测试重点不是"好不好听"（主观），而是这几件客观的事：
 *   ① WAV 头合法、长度与帧数一致（不然游戏引擎直接播不出来）
 *   ② 不是静音、也没有削顶爆音
 *   ③ 同 seed 逐字节相同（确定性 —— 这是它能进版本库的前提）
 *   ④ 换 seed / 换预设确实产出不同内容（不是所有音效都长一样）
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  makeRng, SFX_PRESETS, SFX_LIMITS, sfxList, synthSfx, encodeWav, renderSfxToWav,
} from '../lib/sfx.js'
import { runAudio } from '../lib/audio.js'

/** 解析 WAV 头，返回关键字段（自己解，不依赖库）。 */
function parseWav(buffer) {
  assert.equal(buffer.subarray(0, 4).toString('ascii'), 'RIFF', 'RIFF 魔数')
  assert.equal(buffer.subarray(8, 12).toString('ascii'), 'WAVE', 'WAVE 标记')
  assert.equal(buffer.subarray(12, 16).toString('ascii'), 'fmt ', 'fmt 块')
  const fmtSize = buffer.readUInt32LE(16)
  const audioFormat = buffer.readUInt16LE(20)
  const channels = buffer.readUInt16LE(22)
  const sampleRate = buffer.readUInt32LE(24)
  const byteRate = buffer.readUInt32LE(28)
  const blockAlign = buffer.readUInt16LE(32)
  const bitsPerSample = buffer.readUInt16LE(34)
  assert.equal(buffer.subarray(36, 40).toString('ascii'), 'data', 'data 块')
  const dataBytes = buffer.readUInt32LE(40)
  assert.equal(buffer.subarray(4).readUInt32LE(0), 36 + dataBytes, 'RIFF 长度要等于 36 + data 长度')
  assert.equal(buffer.length, 44 + dataBytes, '文件长度要等于 44 + data 长度')
  return { fmtSize, audioFormat, channels, sampleRate, byteRate, blockAlign, bitsPerSample, dataBytes }
}

/** 取样本的峰值与是否静音。 */
function analyze(buffer) {
  const dataBytes = buffer.readUInt32LE(40)
  const frames = dataBytes / 2
  let peak = 0
  let nonZero = 0
  for (let i = 0; i < frames; i++) {
    const v = buffer.readInt16LE(44 + i * 2)
    peak = Math.max(peak, Math.abs(v))
    if (v !== 0) nonZero += 1
  }
  return { peak, nonZero, frames, silent: nonZero === 0 }
}

test('makeRng：同 seed 同序列（确定性是这套音效可复现的前提）', () => {
  const a = makeRng(123)
  const b = makeRng(123)
  const c = makeRng(124)
  const seqA = Array.from({ length: 8 }, () => a())
  const seqB = Array.from({ length: 8 }, () => b())
  const seqC = Array.from({ length: 8 }, () => c())
  assert.deepEqual(seqA, seqB)
  assert.notDeepEqual(seqA, seqC)
  for (const v of seqA) assert.ok(v >= 0 && v < 1, `随机数要在 [0,1)，收到 ${v}`)
})

test('WAV 头合法：44 字节头 + 16bit PCM + 长度自洽（头错了引擎直接播不出来）', () => {
  const { wav } = renderSfxToWav({ preset: 'coin', seed: 1 })
  const head = parseWav(wav)
  assert.equal(head.audioFormat, 1, 'PCM')
  assert.equal(head.bitsPerSample, 16)
  assert.equal(head.channels, 1)
  assert.equal(head.sampleRate, 44100)
  assert.equal(head.byteRate, head.sampleRate * head.channels * 2, 'byteRate 要自洽')
  assert.equal(head.blockAlign, head.channels * 2, 'blockAlign 要自洽')
  assert.equal(head.fmtSize, 16)
})

test('所有预设都能出**非静音**且**不爆音**的音频', () => {
  for (const { id } of sfxList()) {
    const { wav, duration } = renderSfxToWav({ preset: id, seed: 3 })
    const info = analyze(wav)
    assert.ok(!info.silent, `${id} 是静音`)
    assert.ok(info.peak > 1000, `${id} 音量太小（peak=${info.peak}）`)
    assert.ok(info.peak < 32767, `${id} 削顶了（peak=${info.peak}）`)
    assert.ok(info.frames > 0, `${id} 没有帧`)
    assert.ok(duration > 0 && duration <= SFX_LIMITS.maxDuration)
    // 尾巴必须淡出：最后一帧不该是满幅（否则播放结束会"啪"一声）
    const last = Math.abs(wav.readInt16LE(wav.length - 2))
    assert.ok(last < 2000, `${id} 结尾没淡出（最后一帧 ${last}）`)
  }
})

test('确定性：同参数同 seed → 逐字节相同的文件', () => {
  const a = renderSfxToWav({ preset: 'explosion', seed: 77, duration: 0.6 })
  const b = renderSfxToWav({ preset: 'explosion', seed: 77, duration: 0.6 })
  assert.ok(a.wav.equals(b.wav), '同 seed 必须逐字节相同')
  const c = renderSfxToWav({ preset: 'explosion', seed: 78, duration: 0.6 })
  assert.ok(!a.wav.equals(c.wav), '换 seed 应该有差异（噪声/碎片位置变了）')
})

test('不同预设产出不同内容（不是所有音效长一样）', () => {
  const coin = renderSfxToWav({ preset: 'coin', seed: 1 })
  const laser = renderSfxToWav({ preset: 'laser', seed: 1 })
  const explosion = renderSfxToWav({ preset: 'explosion', seed: 1, duration: 0.35 })
  assert.ok(!coin.wav.equals(laser.wav))
  assert.ok(!coin.wav.equals(explosion.wav))
  assert.ok(!laser.wav.equals(explosion.wav))
})

test('参数：时长/采样率被夹在安全范围内，pitch 不炸', () => {
  // 时长下限
  const short = synthSfx({ preset: 'blip', duration: 0.0001 })
  assert.ok(short.duration >= SFX_LIMITS.minDuration)
  // 时长上限 + 警告
  const long = synthSfx({ preset: 'explosion', duration: 999 })
  assert.equal(long.duration, SFX_LIMITS.maxDuration)
  assert.ok(long.warnings.length >= 1, '超上限要警告')
  // 采样率夹取
  assert.equal(synthSfx({ preset: 'blip', sampleRate: 1 }).sampleRate, SFX_LIMITS.minSampleRate)
  assert.equal(synthSfx({ preset: 'blip', sampleRate: 999999 }).sampleRate, SFX_LIMITS.maxSampleRate)
  // pitch 上下都正常（不抛异常、有声音）
  for (const pitch of [-24, -12, 0, 12, 24]) {
    const r = renderSfxToWav({ preset: 'coin', pitch, seed: 1 })
    assert.ok(!analyze(r.wav).silent, `pitch=${pitch} 出静音了`)
  }
})

test('立体声：声道数 2 时数据长度翻倍且 byteRate 跟着变', () => {
  const mono = renderSfxToWav({ preset: 'coin', seed: 1, channels: 1 })
  const stereo = renderSfxToWav({ preset: 'coin', seed: 1, channels: 2 })
  const m = parseWav(mono.wav)
  const s = parseWav(stereo.wav)
  assert.equal(s.channels, 2)
  assert.equal(s.dataBytes, m.dataBytes * 2)
  assert.equal(s.byteRate, m.byteRate * 2)
  assert.equal(s.blockAlign, 4)
})

test('未知预设：报错里要列出可用的，而不是只说"不支持"', () => {
  assert.throws(() => synthSfx({ preset: '不存在的声音' }), (error) => {
    assert.match(error.message, /不认识的音效/)
    assert.match(error.message, /coin/, '要列出可用预设')
    return true
  })
})

test('encodeWav：超出 ±1 的样本被夹取（不能溢出成反向爆音）', () => {
  const samples = new Float32Array([0, 1.5, -1.5, 0.5])
  const wav = encodeWav(samples, { sampleRate: 44100 })
  assert.equal(wav.readInt16LE(44), 0)
  assert.equal(wav.readInt16LE(46), 32767, '1.5 应夹到 32767')
  assert.equal(wav.readInt16LE(48), -32767, '-1.5 应夹到 -32767')
})

test('sfxList：16 个预设，每个都有中文名与用途提示', () => {
  const list = sfxList()
  assert.equal(list.length, Object.keys(SFX_PRESETS).length)
  assert.ok(list.length >= 16)
  for (const item of list) {
    assert.ok(item.id, '要有 id')
    assert.ok(item.label, `${item.id} 缺中文名`)
    assert.ok(item.hint, `${item.id} 缺用途提示`)
    assert.equal(SFX_PRESETS[item.id].generate.length, 1, 'generate 要接收 ctx')
  }
})

test('端到端：runAudio(action="sfx") 落盘、可批量、不需要 VoiceStudio', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sfx-'))
  try {
    // 故意把 VoiceStudio 指向一个死端口：sfx 不该去连它
    const before = process.env.VOICESTUDIO_URL
    process.env.VOICESTUDIO_URL = 'http://127.0.0.1:1'
    try {
      const result = await runAudio({
        profiles: { data: { lastProject: 'game' } },
        settings: { outputDir: dir },
        args: { action: 'sfx', presets: ['coin', 'laser', 'explosion'], name: 'pickup', seed: 5 },
      })
      assert.equal(result.ok, true, result.error)
      assert.equal(result.files.length, 3)
      assert.equal(result.project, 'game')
      assert.equal(result.output_dir, path.join(dir, 'game', 'audio'))
      for (const file of result.files) {
        const info = await stat(file)
        assert.ok(info.size > 44, `${file} 太小`)
        const wav = await readFile(file)
        parseWav(wav)
        assert.ok(!analyze(wav).silent, `${file} 是静音`)
      }
      // 文件名带序号（批量时要能分清）
      assert.match(path.basename(result.files[0]), /pickup_1\.wav$/)
      assert.match(path.basename(result.files[1]), /pickup_2\.wav$/)

      // sfx-list 不需要服务
      const listed = await runAudio({ profiles: { data: {} }, settings: { outputDir: dir }, args: { action: 'sfx-list' } })
      assert.equal(listed.ok, true)
      assert.ok(listed.presets.length >= 16)
    } finally {
      if (before === undefined) delete process.env.VOICESTUDIO_URL
      else process.env.VOICESTUDIO_URL = before
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('单个音效（不给 presets）也能用，文件名叫 name.wav', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sfx2-'))
  try {
    const result = await runAudio({
      profiles: { data: {} },
      settings: { outputDir: dir },
      args: { action: 'sfx', preset: 'alarm', name: 'alarm_loop', project: 'p' },
    })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.files.length, 1)
    assert.match(path.basename(result.files[0]), /^alarm_loop\.wav$/)
    assert.ok(result.items[0].duration_ms > 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
