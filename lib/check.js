/**
 * 素材核对：把「生成出来的图」和「游戏要求的规格 / 游戏代码里的引用」对上。
 * 回答两个最要紧的问题：
 *   1) 我生成的东西符合游戏要求吗（尺寸、透明底、可平铺）？
 *   2) 它到底有没有被游戏用上（哪个文件引用了它）？
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { parseSizeSpec, pngInfo } from './pnginfo.js'
import { safeSegment } from './util.js'

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target', '.next', '.cache',
  '__pycache__', '.venv', 'venv', 'vendor', 'Library', 'Temp', 'obj', 'bin', '.idea', '.vscode',
])
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.html', '.htm', '.css', '.scss', '.json', '.lua', '.py', '.md', '.txt', '.yml', '.yaml', '.xml', '.gd', '.cs', '.java', '.c', '.cpp', '.h', '.ini', '.cfg'])
const SPEC_FILE = /待画|待生成|素材清单|asset.?list|素材登记/i
/** 单张图小于这个字节数，多半是空图/纯色图（用户实际的 450B "40×60" 就是这种情况）。 */
const SUSPICIOUS_BYTES = 1200

async function walk(root, { maxFiles = 4000, depth = 6, files = [], level = 0 } = {}) {
  if (level > depth || files.length >= maxFiles) return files
  let entries = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    if (files.length >= maxFiles) break
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      await walk(full, { maxFiles, depth, files, level: level + 1 })
    } else if (entry.isFile()) {
      files.push(full)
    }
  }
  return files
}

/** 从「待画素材清单」这类 Markdown 表格里读出每个素材的规格要求。 */
export function parseExpectations(text) {
  const out = {}
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.includes('|')) continue
    const cells = line.split('|').map((cell) => cell.trim())
    const keyCell = cells.find((cell) => /^`[^`]+`$/.test(cell))
    if (!keyCell) continue
    const key = keyCell.replace(/`/g, '').trim()
    if (!key || /^-+$/.test(key)) continue
    const sizeCell = cells.find((cell) => /(≤|<=|max)?\s*\d{1,4}\s*[×xX*]\s*\d{1,4}/.test(cell))
    const size = parseSizeSpec(sizeCell)
    out[key] = {
      key,
      size,
      sizeText: sizeCell ?? '',
      transparent: /透明|alpha|去掉背景/i.test(line),
      tileable: /可平铺|无缝|tileable|无缝重复/i.test(line),
      note: cells.filter((cell) => cell && !cell.startsWith('-')).slice(-1)[0]?.slice(0, 120) ?? '',
    }
  }
  return out
}

/** 扫描项目里的规格清单文件，合并成一张「要求表」。 */
export async function readExpectations(root) {
  const files = await walk(root, { maxFiles: 1500 })
  const merged = {}
  const sources = []
  for (const file of files) {
    if (!/\.(md|txt)$/i.test(file) || !SPEC_FILE.test(path.basename(file))) continue
    try {
      const info = await stat(file)
      if (info.size > 512 * 1024) continue
      const parsed = parseExpectations(await readFile(file, 'utf8'))
      if (Object.keys(parsed).length === 0) continue
      sources.push(path.relative(root, file))
      for (const [key, value] of Object.entries(parsed)) merged[key] ??= { ...value, source: path.relative(root, file) }
    } catch {
      /* 跳过读不了的 */
    }
  }
  return { expectations: merged, sources }
}

/** 生成文件名 → 素材 key：去掉扩展名、去掉结尾的 _1 / _40x60 这类尾巴。 */
export function assetKeyOf(fileName) {
  const base = String(fileName).replace(/\.[a-z0-9]+$/i, '')
  return base.replace(/_\d+x\d+$/i, '').replace(/_\d+$/, '')
}

/** 列出某个项目目录里生成出来的图，并读它们的真实属性。 */
export async function collectGenerated({ outputDir, project }) {
  const dir = path.join(outputDir, safeSegment(project, project))
  const files = await walk(dir, { maxFiles: 800, depth: 3 })
  const items = []
  for (const file of files) {
    if (!/\.(png|jpe?g|webp)$/i.test(file)) continue
    const info = await pngInfo(file)
    items.push({
      key: assetKeyOf(path.basename(file)),
      file: path.relative(outputDir, file),
      absolute: file,
      actual: info,
    })
  }
  return items
}

/** 在游戏项目里找每个素材 key 被哪些文件引用。 */
export async function findReferences(root, keys) {
  const wanted = [...new Set(keys.filter(Boolean))]
  const refs = Object.fromEntries(wanted.map((key) => [key, []]))
  if (wanted.length === 0) return refs
  const files = await walk(root, { maxFiles: 4000 })
  for (const file of files) {
    if (!TEXT_EXT.has(path.extname(file).toLowerCase())) continue
    let text
    try {
      const info = await stat(file)
      if (info.size > 2 * 1024 * 1024) continue
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    for (const key of wanted) {
      const matches = text.split(key).length - 1
      if (matches > 0) refs[key].push({ file: path.relative(root, file).replace(/\\/g, '/'), count: matches })
    }
  }
  for (const key of wanted) refs[key].sort((a, b) => b.count - a.count)
  return refs
}

export function judge({ actual, expected }) {
  const problems = []
  if (!expected) return { verdict: 'unknown-spec', problems: ['清单里没有这个素材的规格，无法判断是否达标'] }
  if (actual.format !== 'png') problems.push(`格式是 ${actual.format}，核对按 PNG 规格进行`)
  if (expected.transparent && actual.format === 'png' && actual.hasAlphaChannel === false) {
    problems.push('要求透明底，但生成的是不带透明通道的图（colorType 不是 4/6）→ 叠在游戏里会糊住背景')
  }
  if (expected.size) {
    const { width, height, max } = expected.size
    const sizeOk = max ? actual.width <= width && actual.height <= height : actual.width === width && actual.height === height
    if (!sizeOk) {
      problems.push(`要求 ${max ? '≤' : ''}${width}×${height}，实际生成 ${actual.width}×${actual.height}（需要按规格缩放/裁剪后再登记）`)
    }
  }
  if (actual.bytes != null && actual.bytes < SUSPICIOUS_BYTES) {
    problems.push(`文件只有 ${actual.bytes} 字节，很可能是空图/纯色图（打开确认一下）—— 这类图在游戏里就是黑屏或空白`)
  }
  if (problems.length === 0) return { verdict: 'ok', problems: [] }
  if (problems.some((p) => /空图|黑屏|透明/.test(p))) return { verdict: 'broken', problems }
  return { verdict: 'mismatch', problems }
}

/** 只在「清单/报告类文档」里出现的名字不算被游戏使用（那是待办与记录，不是真引用）。 */
export function isSpecDoc(relativeFile) {
  const base = path.basename(String(relativeFile))
  return SPEC_FILE.test(base) || /\.(md|txt)$/i.test(base)
}

/**
 * 核对一个项目：要求规格 + 生成结果 + 游戏引用。
 * @param {{root:string, outputDir:string, project:string}} params
 */
export async function checkProject({ root, outputDir, project }) {
  const generated = await collectGenerated({ outputDir, project })
  if (generated.length === 0) {
    return { ok: true, project, generated: 0, items: [], note: `输出目录里还没有 ${project} 的图` }
  }
  const [expect, refs] = await Promise.all([
    root ? readExpectations(root).catch(() => ({ expectations: {}, sources: [] })) : Promise.resolve({ expectations: {}, sources: [] }),
    root ? findReferences(root, generated.map((item) => item.key)).catch(() => ({})) : Promise.resolve({}),
  ])
  const items = generated.map((item) => {
    const expected = expect.expectations[item.key] ?? null
    const allRefs = refs[item.key] ?? []
    // 真正算「游戏在用」的是代码/配置里的引用；只在 md/txt 清单里提到的不算
    const codeRefs = allRefs.filter((ref) => !isSpecDoc(ref.file))
    const docRefs = allRefs.filter((ref) => isSpecDoc(ref.file))
    const judged = judge({ actual: item.actual, expected })
    const problems = [...judged.problems]
    if (root && codeRefs.length === 0) {
      problems.push(docRefs.length > 0
        ? '只在清单/报告文档里被提到，游戏代码里没有引用它（还没登记进游戏）'
        : '游戏代码里没有任何文件引用它（文件名或登记项可能对不上）')
    }
    const verdict = root && codeRefs.length === 0 && judged.verdict === 'ok' ? 'not-referenced' : judged.verdict
    return {
      key: item.key,
      file: item.file.replace(/\\/g, '/'),
      size: `${item.actual.width}×${item.actual.height}`,
      bytes: item.actual.bytes,
      hasAlphaChannel: item.actual.hasAlphaChannel,
      expected: expected ? { size: expected.sizeText, transparent: expected.transparent, tileable: expected.tileable, source: expected.source } : null,
      referencedBy: codeRefs.slice(0, 6),
      mentionedInDocs: docRefs.slice(0, 4),
      referenceCount: codeRefs.reduce((sum, ref) => sum + ref.count, 0),
      verdict,
      problems,
    }
  })
  const summary = { ok: 0, broken: 0, mismatch: 0, 'not-referenced': 0, 'unknown-spec': 0 }
  for (const item of items) summary[item.verdict] = (summary[item.verdict] ?? 0) + 1
  return {
    ok: true,
    project,
    generated: items.length,
    expectationSources: expect.sources,
    summary,
    items,
    hint: 'verdict=broken 的图就是「生成了但用不上/黑屏」的元凶：先按 expected.size 缩放裁剪、确认透明底，再看 referencedBy 是否非空。',
  }
}
