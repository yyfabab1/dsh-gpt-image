/**
 * 画廊的「分类栏」过滤逻辑（纯函数，可单测）。
 *
 * 单独抽出来的原因：这段逻辑以前内联在浏览器端 React 组件里，
 * 结果「点项目分类，下面还是全部图」这个 bug 没有任何测试能发现
 * （client.js 是浏览器 bundle，node --test 跑不到）。
 * 抽成纯函数后，行为可以被测试钉住。
 */

/** 记录所属项目（历史里可能没写 project）。 */
export function projectOf(record) {
  return String(record?.project || 'images')
}

/** 项目名归一化比较键：忽略大小写与首尾空白，避免「Demo」和「demo 」被当成两个项目。 */
export function projectKey(name) {
  return String(name ?? '').trim().toLowerCase()
}

/**
 * 按当前选中的项目过滤记录。
 * @param {Array<object>} records 全部记录
 * @param {string} project 选中的项目；空串表示「全部」，不做过滤
 * @returns {Array<object>} 过滤后的记录（保持原顺序）
 */
export function filterByProject(records, project) {
  const list = Array.isArray(records) ? records : []
  const wanted = projectKey(project)
  if (!wanted) return list
  return list.filter((record) => projectKey(projectOf(record)) === wanted)
}

/**
 * 汇总每个项目的统计，给分类栏的卡片用。
 * @returns {Record<string, {count:number, latest:string, names:string[], kinds:string[]}>}
 */
export function projectStats(records) {
  const stats = {}
  for (const record of Array.isArray(records) ? records : []) {
    const key = projectOf(record)
    const bucket = (stats[key] ??= { count: 0, latest: '', names: [], kinds: [] })
    bucket.count += 1
    const ts = String(record?.ts ?? '')
    if (ts > bucket.latest) bucket.latest = ts
    if (record?.name && bucket.names.length < 3) bucket.names.push(record.name)
    const kind = record?.kind
    if (kind && !bucket.kinds.includes(kind)) bucket.kinds.push(kind)
  }
  return stats
}

/** 分类栏要展示的项目列表：去重 + 按中文排序。 */
export function projectList(records) {
  return [...new Set((Array.isArray(records) ? records : []).map(projectOf).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b), 'zh-Hans-CN'))
}

/** 记录的主文件（与 /api/check 的 items[].file 对齐用）。 */
export function primaryFileOf(record) {
  return String((record?.files ?? [])[0] ?? '').replace(/\\/g, '/')
}

/**
 * 按核对结论（verdict）过滤：只看某一类，便于集中返工。
 * @param {Array<object>} records 已按项目过滤后的记录
 * @param {Record<string, {verdict?:string}>} checkByFile 文件路径 → 核对结果
 * @param {string} verdict 目标结论；空串表示不过滤
 */
export function filterByVerdict(records, checkByFile = {}, verdict = '') {
  const list = Array.isArray(records) ? records : []
  if (!verdict) return list
  return list.filter((record) => {
    const file = primaryFileOf(record)
    return file ? checkByFile[file]?.verdict === verdict : false
  })
}

/** 统计各结论的张数，给结论筛选条用。 */
export function verdictCounts(items = []) {
  const counts = {}
  for (const item of Array.isArray(items) ? items : []) {
    const key = item?.verdict
    if (key) counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}
