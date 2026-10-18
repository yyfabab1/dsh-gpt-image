/**
 * G 组 · 从游戏倒推（让素材真的能用）。
 *
 *   G2 尺寸/格式契约检查 —— 读游戏工程配置，确认素材符合引擎要求，不符合自动转
 *   G3 引用完整性检查   —— 双向：素材存在但没被引用（冗余）/ 被引用但不存在（缺图）
 *   G4 替换影响分析     —— 某张图要改时，先告诉你会影响哪些地方
 *   G1 引擎实机预览     —— 委托给已有的 screenshot 能力（不重复实现截图）
 *
 * 复用：check.js 的 findReferences / readExpectations / judge、register.js 的注册表探测。
 * G3/G4 的核心是**双向引用图**，所以集中在这里构建一次，供两者共用。
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { readExpectations } from './check.js'
import { findRegistryFiles, findKeyPattern } from './register.js'
import { decodePngRgba } from './pngcodec.js'

const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|json|html|css|scss|lua|py|cs|go|rs|yaml|yml)$/i
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', 'target', 'obj', 'bin', 'Library'])
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|svg|mp4|webm|mp3|wav|ogg)$/i
/**
 * 这些文件名属于「脚本产出的临时/诊断图」，不是游戏素材。
 * 实测 `tools/diag_*.mjs` 会 `shot('cdpperf.png')`、拼 `k + '@' + SCALE + 'x.png'`，
 * 宽松匹配就会把它们当"被引用但缺失的素材"，报出一堆假缺图 —— 比漏报更糟。
 */
const NON_ASSET_NAME = /^(shot|screenshot|screen|debug|diag|tmp|temp|test|out|output|result|preview|thumb)\b/i
const NON_ASSET_PATH = /[\\/](tools?|scripts?|tests?|tmp|temp|out|output|logs?|screenshots?|debug|dist|build)[\\/]/i

/** 遍历工程文件（跳过常见构建目录）。 */
export async function walkProject(root, { maxFiles = 6000, maxDepth = 8, maxBytes = 2 * 1024 * 1024 } = {}) {
  const out = []
  const stack = [{ dir: root, depth: 0 }]
  while (stack.length > 0 && out.length < maxFiles) {
    const { dir, depth } = stack.pop()
    if (depth > maxDepth) continue
    let entries = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) break
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        stack.push({ dir: full, depth: depth + 1 })
      } else if (entry.isFile()) {
        try {
          const info = await stat(full)
          if (info.size > maxBytes) continue
          out.push({ file: full, size: info.size })
        } catch { /* 读不到就跳过 */ }
      }
    }
  }
  return out
}

/**
 * G3 核心：构建**双向引用图**。
 *
 * 两个方向都要，因为两种错都常见且方向相反：
 *   - 被引用但不存在 → 游戏跑起来缺图（严重，直接报错/黑屏）
 *   - 存在但没被引用 → 冗余（白花钱生成/白占体积）
 *
 * @param {{root:string, keys?:string[]}} params
 */
export async function buildReferenceGraph({ root, keys = [] } = {}) {
  if (!root) return { ok: false, error: '需要游戏目录' }
  const files = await walkProject(root)
  const codeFiles = files.filter((f) => CODE_EXT.test(f.file))
  const imageFiles = files.filter((f) => IMAGE_EXT.test(f.file))

  // 磁盘上的图像资源（按 basename 无扩展名索引，便于和代码里的引用比对）
  const onDisk = new Map()
  for (const item of imageFiles) {
    // 工具/诊断脚本的**输出目录**不是游戏资源库：
    // 实测 `tools/out/` 里有几百张诊断截图，全报成"冗余"会把真正的问题淹没。
    // 用相对路径判断（不能用绝对路径，否则项目装在 ...\tools\ 下会整体失效）。
    const rel = path.relative(root, item.file).replace(/\\/g, '/')
    if (NON_ASSET_PATH.test(`/${rel}`)) continue
    const base = path.basename(item.file).replace(/\.[a-z0-9]+$/i, '')
    if (!onDisk.has(base)) onDisk.set(base, [])
    onDisk.get(base).push(item.file)
  }

  // 扫代码里的引用：路径形式的 + 注册表形式的（后者由 register.js 的模式覆盖）
  const references = new Map()   // basename → [{file, line?, raw}]
  const pathRefs = new Map()     // 相对路径引用 → 解析后的绝对路径
  const registryHits = []
  const addRef = (key, ref) => {
    if (!references.has(key)) references.set(key, [])
    references.get(key).push(ref)
  }

  for (const item of codeFiles) {
    let text
    try {
      text = await readFile(item.file, 'utf8')
    } catch {
      continue
    }
    // 诊断/工具脚本里出现的图片名，基本是它们**产出**的截图（`shot('cdpperf.png')`、
    // `k + '@' + SCALE + 'x.png'`），不是游戏素材引用。
    // 名字无法可靠区分（就叫 cdpperf、x），所以按**用途**判定：工具/测试脚本里
    // 只认「明显是素材」的形态，其余当产出物忽略。
    //
    // 注意：判据必须用**相对游戏目录**的路径。
    // 早先用绝对路径，结果项目只要装在 C:\Temp\game 或 ...\tools\game，
    // 整个工程都被当成工具脚本 —— 全盘失效（测试夹具放临时目录时就撞上了）。
    const relative = path.relative(root, item.file).replace(/\\/g, '/')
    const fromToolScript = NON_ASSET_PATH.test(`/${relative}`)
    // ① 字符串里出现的图片路径。
    //    必须严格限定扩展名集合，且排除「代码标识符 + 后缀」这种误匹配：
    //    实测 `window.__np.mjs`、`x.png` 这类会被宽松正则误判成"被引用的素材"，
    //    于是报出一堆假的"缺图"，让人以为游戏坏了。宁可漏报也不能误报。
    for (const match of text.matchAll(/["'`(]([A-Za-z0-9_@./\\ -]+\.(?:png|jpe?g|webp|gif|svg))["'`)]/gi)) {
      const raw = match[1]
      // 排除明显是代码的：以 __ 开头、含 ::、是纯变量名、或含模板拼接
      if (/^__|::|\$\{|\+/.test(raw)) continue
      const base = path.basename(raw).replace(/\.[a-z0-9]+$/i, '')
      // basename 必须是合法的素材名（字母数字下划线连字符），否则跳过
      if (!/^[A-Za-z0-9][A-Za-z0-9_\-]*$/.test(base)) continue
      // 工具/测试脚本：只认「明显是素材」的形态，其余当产出物忽略
      if (fromToolScript && !/^[a-z]{1,3}_[a-z0-9_]+$/i.test(base) && !/^[A-Z]\d/.test(base)) continue
      if (!fromToolScript && NON_ASSET_NAME.test(base)) continue
      const before = text.slice(0, match.index)
      const line = before.split('\n').length
      addRef(base, { file: item.file, line, raw, kind: 'path' })
      const resolved = path.resolve(path.dirname(item.file), raw.replace(/\\/g, '/'))
      pathRefs.set(resolved.toLowerCase(), { file: item.file, line, raw })
    }
    // ② 注册表形式：对每个待查 key 用 register.js 的模式找写法
    //    （`"key": {"s":"data:image/...` 或 `key: 'name'`）—— 注意它一次只查一个 key
    for (const key of keys) {
      if (!key) continue
      const match = findKeyPattern(text, key)
      if (match) {
        addRef(key, { file: item.file, kind: 'registry', raw: String(match[0]).slice(0, 120) })
        registryHits.push({ key, file: item.file })
      }
    }
    // ③ 裸 key 引用（形如 'icon_drug' 出现在逻辑代码里）—— 同样只看显式传入的 keys，避免误报
    for (const key of keys) {
      if (!key) continue
      if (new RegExp(`["'\`]${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'\`]`).test(text)) {
        addRef(key, { file: item.file, kind: 'key' })
      }
    }
  }

  // 三向比对
  const missing = []      // 被引用但磁盘没有
  const orphans = []      // 磁盘有但没人引用
  const referenced = []   // 两边都有（健康）

  // 三向比对。
  // **必须遍历「磁盘上的图 ∪ 代码引用的 key」两个集合**：
  // 只遍历引用的 key 时，一个完全没被引用的文件永远不会进循环 → 冗余检测形同虚设
  // （早先就是这样，orphans 恒为空）。
  const consideredKeys = new Set([
    ...references.keys(),
    ...onDisk.keys(),
    ...keys.filter(Boolean),
  ])
  for (const key of consideredKeys) {
    const disk = onDisk.get(key)
    const refs = references.get(key) ?? []
    if (!disk || disk.length === 0) {
      if (refs.length > 0) {
        // 再确认一次：同名的文件在工程里**任何位置**都不存在才算"缺图"。
        // 只按 basename 索引可能漏掉（比如被 SKIP_DIRS 跳过的目录），
        // 误报"缺图"比漏报更糟 —— 会让人去找根本不缺的东西。
        const anywhere = await findFileByName(root, key)
        if (!anywhere) missing.push({ key, referenced_by: refs.slice(0, 5) })
      }
      continue
    }
    if (refs.length === 0) {
      // 磁盘有、没人引用 → 冗余。
      // 但派生件（切片/缩放/预览）跟着源图走，源图被引用就等于它被使用，
      // 否则会把 94 个切片全报成冗余，淹没真正的问题。
      const derivedOnly = disk.every((file) => /_slices[\\/]|_labeled\.|_\d+x\d+\./i.test(file))
      if (!derivedOnly) orphans.push({ key, files: disk.slice(0, 3), count: disk.length })
    } else {
      referenced.push({ key, files: disk.length, refs: refs.length })
    }
  }

  return {
    ok: true,
    root,
    scanned: { files: files.length, code: codeFiles.length, images: imageFiles.length },
    registry_files: registryHits.length > 0 ? [...new Set(registryHits.map((h) => h.file))].slice(0, 5) : [],
    missing,      // 缺图：游戏会跑不起来
    orphans,      // 冗余：白占体积
    referenced,
    summary: {
      checked: consideredKeys.size,
      missing: missing.length,
      orphans: orphans.length,
      healthy: referenced.length,
    },
    advice: missing.length > 0
      ? `⚠ ${missing.length} 个素材被代码引用但磁盘上不存在 —— 游戏跑起来会缺图。优先补这些。`
      : orphans.length > 0
        ? `没有缺图，但有 ${orphans.length} 个素材存在却没被任何代码引用（冗余）—— 要么接上引用，要么删掉。`
        : '引用完整：没有缺图也没有明显冗余。',
  }
}

/** 在整个工程里按名字找文件（含被 SKIP_DIRS 跳过的目录，用于二次确认"真的缺图"）。 */
async function findFileByName(root, name) {
  const stack = [{ dir: root, depth: 0 }]
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()
    if (depth > 10) continue
    let entries = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue
        stack.push({ dir: full, depth: depth + 1 })
      } else if (IMAGE_EXT.test(entry.name)) {
        if (path.basename(entry.name).replace(/\.[a-z0-9]+$/i, '') === name) return full
      }
    }
  }
  return null
}

/**
 * G2：尺寸/格式契约检查。
 *
 * 读游戏工程里的要求（「待画素材清单」+ asset-specs.json），和磁盘上实际的图比对。
 * 不符合的**给出自动转换建议**（能转的直接标 can_convert）。
 */
export async function checkContract({ root, outputDir = '', assets = [], expectations = null, kindByName = {} } = {}) {
  if (!root && !expectations) return { ok: false, error: '需要游戏目录（或直接传 expectations）' }
  const exp = expectations ?? (await readExpectations(root).catch(() => ({ expectations: {} }))).expectations ?? {}
  const results = []
  for (const asset of assets) {
    const expected = exp[asset.name]
    if (!expected?.size) {
      results.push({ name: asset.name, file: asset.file, status: 'no_spec', note: '清单里没有这张的要求，无法核对（不是错，只是没定义）' })
      continue
    }
    // 优先用调用方给的 actualSize；没给就**自己读文件**（否则这个函数在真实使用中什么也检查不出来）
    let actual = asset.actualSize ?? null
    let readError = ''
    if (!actual && asset.file) {
      try {
        const buffer = await readFile(asset.file)
        const decoded = decodePngRgba(buffer)
        if (decoded) {
          let hasAlpha = false
          for (let i = 3; i < decoded.pixels.length; i += 4) {
            if (decoded.pixels[i] < 255) { hasAlpha = true; break }
          }
          actual = {
            width: decoded.width,
            height: decoded.height,
            // "有 alpha 通道"的实用判据：真的有半透明像素（全 255 的 alpha 通道等于没有）
            hasAlpha,
            fileFormat: path.extname(asset.file).replace('.', '').toLowerCase(),
          }
        }
      } catch (error) {
        readError = String(error?.message ?? error)
      }
    }
    if (!actual) {
      results.push({ name: asset.name, file: asset.file, status: 'unknown', note: readError ? `读不到：${readError}` : '读不到实际尺寸' })
      continue
    }
    const { width, height, max } = expected.size
    const sizeOk = max ? (actual.width <= width && actual.height <= height) : (actual.width === width && actual.height === height)
    const issues = []
    if (!sizeOk) issues.push(`尺寸 ${actual.width}×${actual.height} 与要求 ${max ? '≤' : ''}${width}×${height} 不符`)
    if (expected.transparent === true && actual.hasAlpha === false) issues.push('要求透明底，但实际没有透明像素')
    if (actual.fileFormat && !['png', 'webp'].includes(actual.fileFormat)) {
      issues.push(`格式是 ${actual.fileFormat}，引擎通常只吃 png/webp`)
    }
    results.push({
      name: asset.name,
      file: asset.file,
      status: issues.length === 0 ? 'ok' : 'mismatch',
      expected: `${max ? '≤' : ''}${width}×${height}${expected.transparent ? '，透明底' : ''}`,
      actual: `${actual.width}×${actual.height}${actual.hasAlpha ? '，有透明像素' : '，无透明像素'}`,
      issues,
      // 尺寸/格式可自动转；透明缺失要看能否抠背景（属内容问题）
      can_convert: !sizeOk || (actual.fileFormat && !['png', 'webp'].includes(actual.fileFormat)),
      convert_action: !sizeOk
        ? `按 ${width}×${height} contain 缩放（保留 alpha）`
        : (actual.fileFormat && !['png', 'webp'].includes(actual.fileFormat) ? '转成 PNG（保留 alpha）' : null),
    })
  }
  const mismatched = results.filter((r) => r.status === 'mismatch')
  const convertible = mismatched.filter((r) => r.can_convert)
  return {
    ok: true,
    checked: results.length,
    ok_count: results.filter((r) => r.status === 'ok').length,
    no_spec: results.filter((r) => r.status === 'no_spec').length,
    unknown: results.filter((r) => r.status === 'unknown').length,
    mismatched,
    convertible,
    results,
    advice: mismatched.length === 0
      ? `检查了 ${results.length} 项，全部符合契约。`
      : `${mismatched.length} 项不符合契约，其中 ${convertible.length} 项**可自动转换**（尺寸/格式），`
        + `${mismatched.length - convertible.length} 项需要人处理（透明这类内容问题）。`,
  }
}

/**
 * G4：替换影响分析 —— 改这张图会影响哪里。
 * 复用 G3 建的引用图，给出**具体的文件与行号**，而不是笼统说"有引用"。
 */
export async function analyzeImpact({ root, key, keys = [] } = {}) {
  if (!root) return { ok: false, error: '需要游戏目录' }
  if (!key) return { ok: false, error: '需要 key（素材名）' }
  const graph = await buildReferenceGraph({ root, keys: [key, ...keys] })
  if (!graph.ok) return graph
  const hit = [...graph.missing, ...graph.orphans, ...graph.referenced].find((item) => item.key === key)
  const refs = graph.missing.find((item) => item.key === key)?.referenced_by
    ?? graph.referenced.find((item) => item.key === key)?.refs
    ?? null

  // 重新扫一遍拿到带行号的明细（referenced 只存了数量）
  const details = []
  if (refs !== null) {
    const files = await walkProject(root)
    for (const item of files.filter((f) => CODE_EXT.test(f.file))) {
      let text
      try {
        text = await readFile(item.file, 'utf8')
      } catch {
        continue
      }
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (new RegExp(`["'\`][^"'\`]*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"'\`]*["'\`]`).test(lines[i])) {
          details.push({
            file: item.file,
            line: i + 1,
            code: lines[i].trim().slice(0, 140),
            // 分类：注册表 / 路径引用 / 逻辑常量
            kind: /\bdata:image|["']s["']\s*:/.test(lines[i]) ? 'registry' : /\.(png|jpe?g|webp)/i.test(lines[i]) ? 'path' : 'key',
          })
          if (details.length >= 40) break
        }
      }
      if (details.length >= 40) break
    }
  }

  // 受影响面：按目录归类（UI / 关卡 / 角色…）
  const byArea = new Map()
  for (const item of details) {
    const rel = path.relative(root, item.file)
    const area = rel.split(/[\\/]/).slice(0, 2).join('/') || '(根)'
    byArea.set(area, (byArea.get(area) ?? 0) + 1)
  }

  return {
    ok: true,
    key,
    referenced: details.length > 0,
    reference_count: details.length,
    details,
    by_area: [...byArea.entries()].map(([area, count]) => ({ area, count })).sort((a, b) => b.count - a.count),
    risk: details.length === 0 ? 'none' : details.length > 8 ? 'high' : details.length > 3 ? 'medium' : 'low',
    advice: details.length === 0
      ? `「${key}」目前没有被任何代码引用 —— 改它不会影响游戏（但说明它还没接上）。`
      : `改「${key}」会影响 ${details.length} 处（${[...byArea.keys()].slice(0, 3).join('、')}${byArea.size > 3 ? ' 等' : ''}）。`
        + `风险等级 ${details.length > 8 ? '高' : details.length > 3 ? '中' : '低'} —— 改之前先确认这几处都能接受新外观。`,
  }
}

/** G1：引擎实机预览的**清单**（实际截图交给 screenshot 工具，不重复实现）。 */
export function previewChecklist({ root, key, engine = 'web' } = {}) {
  return {
    ok: true,
    key,
    engine,
    steps: [
      '1. 确认素材已 install（落到游戏目录里代码期望的位置）',
      '2. 启动游戏（或最小 demo 场景）',
      `3. 截取实际渲染画面：screenshot window="<窗口标题>" attach=true`,
      '4. 把截图和素材原图并排看：尺寸是否合适、pivot 是否对、透明边是否正确',
    ],
    why: '审核时看的是「进游戏后」而不是孤立一张图 —— 很多问题（太小/偏心/被裁切）只在真实渲染下才暴露。',
    note: '本插件不重复实现截图：用已有的 screenshot 工具（它支持 screen/window/region 三种模式）。',
  }
}
