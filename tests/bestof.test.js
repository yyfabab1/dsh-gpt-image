/**
 * Best-of-N 择优测试。
 *
 * 这个功能会**花 N 倍的钱**，所以最该钉住的是：
 *   ① 它只做"淘汰明显废图"，不会把好图误杀（打分规则不能被随便改坏）
 *   ② 同分时保留先生成的那张（可复现，不随机）
 *   ③ 落选的默认**不删**，只改名（可以后悔）
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, rm, writeFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { scoreImageFile, pickBest, disposeLosers } from '../lib/bestof.js'
import { encodePngRgba } from '../lib/pngcodec.js'

function solidPng(width, height, [r, g, b, a = 255]) {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = r
    pixels[i * 4 + 1] = g
    pixels[i * 4 + 2] = b
    pixels[i * 4 + 3] = a
  }
  return encodePngRgba(width, height, pixels)
}

/** 一张有细节的"好图"：棋盘格 + 渐变，保证有颜色、有边缘、有对比。 */
function detailedPng(size = 64) {
  const pixels = new Uint8ClampedArray(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const checker = ((x >> 3) + (y >> 3)) % 2 === 0
      pixels[i] = checker ? 220 : 30 + Math.floor((x / size) * 120)
      pixels[i + 1] = checker ? 60 + Math.floor((y / size) * 150) : 40
      pixels[i + 2] = checker ? 40 : 200
      pixels[i + 3] = 255
    }
  }
  return encodePngRgba(size, size, pixels)
}

async function writeTemp(dir, name, buffer) {
  const file = path.join(dir, name)
  await writeFile(file, buffer)
  return file
}

test('打分：好图高分、单色/全黑图被判废（这是这个功能存在的意义）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bestof-'))
  try {
    const good = await writeTemp(dir, 'good.png', detailedPng())
    const flat = await writeTemp(dir, 'flat.png', solidPng(64, 64, [255, 255, 255]))
    const black = await writeTemp(dir, 'black.png', solidPng(64, 64, [0, 0, 0]))
    const red = await writeTemp(dir, 'red.png', solidPng(64, 64, [200, 10, 10]))

    const sGood = await scoreImageFile(good)
    assert.equal(sGood.score, 100, `好图应满分，实际 ${sGood.score}：${sGood.penalties}`)
    assert.equal(sGood.fatal, false)

    for (const [file, label] of [[flat, '全白'], [black, '全黑'], [red, '单色']]) {
      const s = await scoreImageFile(file)
      assert.ok(s.score < 70, `${label}图应低分，实际 ${s.score}`)
      assert.equal(s.fatal, true, `${label}图应判为致命`)
      assert.ok(s.penalties.length > 0, `${label}图要给出扣分原因`)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('打分：尺寸不符扣分但不判废（内容能用，只是要缩放）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bestof2-'))
  try {
    const file = await writeTemp(dir, 'big.png', detailedPng(128))
    const exact = await scoreImageFile(file, { expected: { width: 128, height: 128 } })
    const wrong = await scoreImageFile(file, { expected: { width: 64, height: 64 } })
    assert.ok(exact.score > wrong.score, '尺寸精确匹配应得分更高')
    assert.equal(wrong.fatal, false, '尺寸不符不该判废（缩放能救）')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('打分：要求透明底却没有透明像素 → 扣分', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bestof3-'))
  try {
    const opaque = await writeTemp(dir, 'opaque.png', detailedPng())
    const withAlpha = await writeTemp(dir, 'alpha.png', solidPng(64, 64, [255, 0, 0, 255]))
    const a = await scoreImageFile(opaque, { requireAlpha: true })
    assert.ok(a.penalties.some((p) => /透明/.test(p)), `应指出透明问题：${a.penalties}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('pickBest：选出最高分，worst 里不含它，同分保留先生成的', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bestof4-'))
  try {
    const first = await writeTemp(dir, 'a.png', detailedPng(64))
    const bad = await writeTemp(dir, 'b.png', solidPng(64, 64, [0, 0, 0]))
    const second = await writeTemp(dir, 'c.png', detailedPng(64))
    const picked = await pickBest([first, bad, second])
    assert.equal(picked.all_bad, false)
    assert.ok([first, second].includes(picked.best), `应选中好图，实际 ${picked.best}`)
    assert.equal(picked.best, first, '同分应保留先生成的（可复现）')
    assert.equal(picked.ties, 2)
    assert.ok(picked.worst.includes(bad), '废图要在落选名单里')
    assert.ok(!picked.worst.includes(picked.best), '最佳不该在落选名单里')
    assert.match(picked.summary, /\d+\/100/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('pickBest：全是废图时如实说"建议重画"，但仍给一张占位', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bestof5-'))
  try {
    const a = await writeTemp(dir, 'a.png', solidPng(64, 64, [0, 0, 0]))
    const b = await writeTemp(dir, 'b.png', solidPng(64, 64, [255, 255, 255]))
    const picked = await pickBest([a, b])
    assert.equal(picked.all_bad, true)
    assert.equal(picked.best, a, '全废时保留第一张作占位')
    assert.match(picked.summary, /建议.*重画/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('disposeLosers：默认只改名（可以后悔），recycle=true 才真删', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bestof6-'))
  try {
    const keep = await writeTemp(dir, 'keep.png', detailedPng())
    const drop1 = await writeTemp(dir, 'drop1.png', detailedPng())
    const drop2 = await writeTemp(dir, 'drop2.png', detailedPng())

    const renamed = await disposeLosers([drop1], { recycle: false })
    assert.equal(renamed[0].action, 'renamed')
    assert.match(path.basename(renamed[0].to), /^_落选_drop1\.png$/)
    // 文件还在（改名了），原文件不在了
    await assert.rejects(stat(drop1))
    assert.ok((await stat(renamed[0].to)).size > 0)

    const deleted = await disposeLosers([drop2], { recycle: true })
    assert.equal(deleted[0].action, 'deleted')
    await assert.rejects(stat(drop2))

    // 保留的那张没被碰
    assert.ok((await stat(keep)).size > 0)
    const names = await readdir(dir)
    assert.ok(names.some((n) => n.startsWith('_落选_')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('读不到的文件：判致命而不是抛异常（择优过程不能因为一张坏图整体崩掉）', async () => {
  const s = await scoreImageFile(path.join(os.tmpdir(), '绝对不存在_' + Date.now() + '.png'))
  assert.equal(s.fatal, true)
  assert.equal(s.score, 0)
  assert.ok(s.penalties.length > 0)
})
