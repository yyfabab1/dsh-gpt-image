/**
 * 自动登记：生成好并缩放好的图，直接写进游戏的素材登记表，真正做到「一步到游戏里」。
 *
 * 支持两类登记形式（都先备份、可回滚、dry-run 预览）：
 *   ① JS 常量表白名单：`ASSET_FUSION` / `ASSET_MAP` 里形如 `key: 'wx_xxx'` 的键值
 *   ② 素材表带 data URL：`key: { s: 'data:image/png;base64,...', w, h }` —— 直接把图片内联进去
 *
 * 安全：只改「明确点名」的登记文件；写前备份 `.bak-before-register`；dry_run 只给 diff。
 */
import { copyFile, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pngInfo } from './pnginfo.js'

/** 候选登记文件：名字里带 asset/fusion/map/registry 的 JS。 */
export const REGISTRY_HINT = /(asset.?fusion|asset.?map|assets?_?data|asset.?registry|09_assets|素材)/i
/** 「构建生成物，请勿手改」的文件：写进去下次构建就被覆盖，必须先警告。 */
export const GENERATED_HINT = /(请勿手改|自动抽取生成|自动生成|由[^\n]{0,60}生成|do not edit|don'?t edit|auto-?generated|generated (?:by|from)|build\.mjs)/i

/**
 * 判断某个文件是不是「构建生成物」——如果是，写它没用（下次构建覆盖）。
 * 返回命中的证据文本，便于直接告诉用户该改哪个源文件。
 */
export async function detectGenerated(file) {
  try {
    const head = (await readFile(file, 'utf8')).slice(0, 1500)
    const match = head.match(GENERATED_HINT)
    if (!match) return null
    // 源文件线索：中文「从 X 生成」优先，其次英文 from X
    const sourceMatch = head.match(/从\s*([\w./\\-]+\.js)\s*(?:自动抽取生成|抽取生成|自动生成|生成)/)
      ?? head.match(/(?:from|by)\s+([\w./\\-]+\.m?js)/i)
    return { evidence: match[0], source: sourceMatch ? sourceMatch[1] : '' }
  } catch {
    return null
  }
}

export async function findRegistryFiles(root, { max = 8 } = {}) {
  const { readdir } = await import('node:fs/promises')
  const found = []
  const walk = async (dir, level = 0) => {
    if (level > 4 || found.length >= max) return
    let entries = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= max) break
      if (entry.name.startsWith('.') || ['node_modules', 'dist', 'build', 'out'].includes(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full, level + 1)
      else if (/\.(js|mjs|cjs)$/i.test(entry.name) && REGISTRY_HINT.test(entry.name)) found.push(full)
    }
  }
  await walk(root)
  return found
}

/**
 * 在一份登记文件里找 key 的写法。真实项目里的形态（实测自 84_assetmap.js / ASSET_FUSION）：
 *   "key": { "s": "data:image/png;base64,....", "w": 40, "h": 60, "base": 0, "g": "wx", "label": "晴天叠加层" }
 * 也兼容 `key: 'xxx'` 这种简写。
 */
export function findKeyPattern(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const patterns = [
    // 带对象体的（我们主要改这种）
    new RegExp(`(['"\`]?)${escaped}\\1\\s*:\\s*\\{[^{}]*\\}`, 'g'),
    // 简写：key: 'xxx'
    new RegExp(`(['"\`]?)${escaped}\\1\\s*:\\s*(['"\`])([^'"\`]*)\\2`, 'g'),
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match) return match
  }
  return null
}

/**
 * 把素材登记进 JS 表。
 * @param {{root:string, files:string[], entries:Array<{key:string,file:string,name?:string}>,
 *          dataUrl?:boolean, dryRun?:boolean, registry?:string}} params
 */
export async function registerAssets({ root, entries = [], dataUrl = false, dryRun = false, registry = '' }) {
  if (!root) return { ok: false, error: '需要 root（游戏目录）' }
  if (entries.length === 0) return { ok: false, error: '没有要登记的素材' }
  const registries = registry ? [registry] : await findRegistryFiles(root)
  if (registries.length === 0) {
    return { ok: false, error: '没在项目里找到素材登记文件（名字里带 asset-fusion / asset-map / 素材 的 JS）' }
  }
  const reports = []
  for (const file of registries) {
    // 写「构建生成物」等于白写：先查出来并明确告诉用户该改哪个源文件
    const generated = await detectGenerated(file)
    if (generated) {
      reports.push({
        file,
        ok: false,
        skipped: true,
        generated: true,
        error: `这是构建生成物（文件头写着「${generated.evidence}」），改了会被下次构建覆盖`,
        fix: generated.source
          ? `请改源文件 ${generated.source}（登记表由它烘入），或把 registry 参数指向源文件`
          : '请把 registry 参数指向真正的源文件',
      })
      continue
    }
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      reports.push({ file, ok: false, error: String(error.message) })
      continue
    }
    const changes = []
    let next = text
    for (const entry of entries) {
      const found = findKeyPattern(next, entry.key)
      if (!found) continue
      const buffer = await readFile(entry.file)
      const info = await pngInfo(entry.file)
      const uri = `data:image/png;base64,${buffer.toString('base64')}`
      const name = entry.name ?? path.basename(entry.file).replace(/\.[a-z0-9]+$/i, '')
      let replacement
      if (!dataUrl && found[0].includes('{')) {
        // 只改名字（真实项目里 base/g/label 这些字段要保留）
        replacement = found[0].replace(/(['"`]?)s\1\s*:\s*(['"`])([^'"`]*)\2/, `"s": "${name}"`)
      } else if (found[0].includes('{')) {
        // 内联真图：替换 s/w/h，保留 base/g/label 等其它字段（实测格式）
        replacement = found[0]
          .replace(/(['"`]?)s\1\s*:\s*(['"`])[^'"`]*\2/, `"s": "${uri}"`)
          .replace(/(['"`]?)w\1\s*:\s*\d+/, `"w": ${info.width}`)
          .replace(/(['"`]?)h\1\s*:\s*\d+/, `"h": ${info.height}`)
        if (!/(['"`]?)s\1\s*:/.test(found[0])) replacement = found[0].replace('{', `{"s": "${uri}", "w": ${info.width}, "h": ${info.height},`)
      } else {
        replacement = `${found[0].split(':')[0]}: ${dataUrl ? `{ "s": "${uri}", "w": ${info.width}, "h": ${info.height} }` : `'${name}'`}`
      }
      if (replacement === found[0]) continue
      next = next.replace(found[0], replacement)
      changes.push({ key: entry.key, bytes_added: dataUrl ? buffer.length : 0, w: info.width, h: info.height })
    }
    if (changes.length === 0) {
      reports.push({ file, ok: true, changed: 0, note: '这个文件里没有匹配的键（可能登记表在别的文件）' })
      continue
    }
    if (dryRun) {
      reports.push({ file, ok: true, changed: changes.length, dry_run: true, changes: changes.map((item) => ({ key: item.key, before: item.before.slice(0, 60) })) })
      continue
    }
    const backup = `${file}.bak-before-register`
    try {
      await copyFile(file, backup)
    } catch {
      /* 备份失败也要记下来，但别阻断 */
    }
    await writeFile(file, next, 'utf8')
    reports.push({ file, ok: true, changed: changes.length, backup, changes: changes.map((item) => ({ key: item.key })) })
  }
  const total = reports.reduce((sum, item) => sum + (item.changed ?? 0), 0)
  return {
    ok: reports.some((item) => item.ok),
    dry_run: Boolean(dryRun),
    registries,
    total_changed: total,
    reports,
    hint: total === 0
      ? '没有改动任何文件（没找到匹配的键）。先看 registries 列表里是不是正确的登记表，或用 dry_run 预览。'
      : dryRun
        ? `预览：会改 ${total} 处。确认无误后带 dry_run=false 真正写入（会自动备份 .bak-before-register）。`
        : `已登记 ${total} 处并备份。刷新游戏即可看到；要回滚就用对应的 .bak-before-register 覆盖回去。`,
  }
}

/** 找出登记表里「有键但没有 dataURL」的项（游戏会画出破图，正好是要补画的清单）。 */
export async function findUnfilledRegistrations(root, registry = '') {
  const files = registry ? [registry] : await findRegistryFiles(root)
  const pending = []
  for (const file of files) {
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    // 实测格式： "key": { "s": "...", "w": .., "h": .., ... }  —— s 不是 data: 就是没图
    const objectPattern = /(["'`]?)([A-Za-z][A-Za-z0-9_]*(?:_[A-Za-z0-9]+){1,4})\1\s*:\s*\{[^{}]*?(["'`]?)s\3\s*:\s*(["'`])([^"'`]*)\4/g
    for (const match of text.matchAll(objectPattern)) {
      pending.push({
        file: path.relative(root, file),
        key: match[2],
        filled: match[5].startsWith('data:'),
        current: match[5].startsWith('data:') ? `data URL（${match[5].length} 字节）` : match[5],
      })
    }
    // 简写形态： key: 'xxx'
    const shorthandPattern = /(["'`]?)([A-Za-z][A-Za-z0-9_]*(?:_[A-Za-z0-9]+){1,4})\1\s*:\s*(["'`])([^"'`]*)\3/g
    for (const match of text.matchAll(shorthandPattern)) {
      pending.push({ file: path.relative(root, file), key: match[2], filled: false, current: match[4] })
    }
  }
  const missing = pending.filter((item) => item.filled === false)
  return {
    registries: files.map((file) => path.relative(root, file)),
    total: pending.length,
    filled: pending.length - missing.length,
    missing_dataurl: missing.slice(0, 40),
    missing_count: missing.length,
    hint: missing.length > 0
      ? `登记表里还有 ${missing.length} 项没有真图（s 不是 data URL）—— 游戏里会画出破图。这些就是要补画的清单。`
      : '登记表里的项都填了真图。',
  }
}
