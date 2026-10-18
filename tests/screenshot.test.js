/**
 * 截图能力：路径/候选命令的纯逻辑单测；
 * 真机截屏用 FORGE_SHOT_REAL=1 打开（会在本机桌面拍一张，CI/无桌面环境默认跳过）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { capture, powershellCandidates, shotFileName } from '../lib/screenshot.js'
import { pngInfoFromBuffer } from '../lib/pnginfo.js'

test('PowerShell 候选：优先系统绝对路径（本机 PATH 里没有 powershell.exe）', () => {
  const list = powershellCandidates()
  assert.ok(list.length >= 3)
  assert.match(list[0], /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i)
  assert.ok(list.includes('pwsh.exe'))
})

test('截图文件名：安全、带时间戳、前缀固定', () => {
  const name = shotFileName({ name: 'my game / v2' })
  assert.match(name, /^shot_my game _ v2_\d{4}-\d{2}-\d{2}T/)
  assert.match(name, /\.png$/)
  assert.equal(name.includes('..'), false)
  assert.match(shotFileName({ name: '' }), /^shot_screen_/)
})

test('真实截屏（设置 FORGE_SHOT_REAL=1 时执行）', { skip: process.env.FORGE_SHOT_REAL !== '1' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gpt-image-shot-'))
  try {
    const result = await capture({ mode: 'screen', outputDir: dir, project: 'shots', name: 'unit', maxWidth: 800 })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.width, 800)
    assert.ok(result.height > 0)
    const info = await stat(result.file)
    assert.ok(info.size > 1000)
    const png = pngInfoFromBuffer(await readFile(result.file))
    assert.equal(png.format, 'png')
    assert.equal(png.width, 800)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
