/**
 * 一键工作台（pipeline）：把「生成 → 自检 → 重画废图 → 按规格装机 → 登记进游戏」串成一条命令。
 *
 * 为什么需要：这些步骤每一步都已经有了，但模型要连着调 5 个工具、还要自己判断中间结果，
 * 容易漏步骤（尤其是"自检发现废图却还是装了"）。这里把它们按**正确顺序**串起来，
 * 并且在每个花钱的环节前都过闸门。
 */
import path from 'node:path'
import { runBatch } from './batch/run.js'
import { checkProject, readExpectations } from './check.js'
import { installAssets } from './install.js'
import { registerAssets } from './register.js'
import { planGenerationOrder } from './depgraph.js'
import { reviewBatch } from './review.js'

/**
 * @param {{profiles, gallery, pool, spend, runtime, args}} params
 *   args: { root, project, assets?, use_order?, quality?, size?, confirm?, skip_install?, skip_register?, max_images?, dry_run? }
 */
export async function runPipeline({ profiles, gallery, pool, spend, runtime, args = {} }) {
  const root = args.root ?? profiles.data.gameRoot ?? ''
  const project = args.project || (root ? path.basename(root) : 'assets')
  const steps = []
  const record = (name, data) => { steps.push({ step: name, ...data }); return data }

  // ── 步骤 0：素材从哪来 ────────────────────────────────────────────
  let assets = Array.isArray(args.assets) ? args.assets : []
  if (assets.length === 0) {
    const pending = pool.pending().filter((item) => !args.project || item.project === project)
    if (pending.length > 0) {
      assets = pending.map((item) => ({ name: item.name, prompt: item.prompt, kind: item.kind, size: item.size || args.size }))
      record('assets-from-pool', { count: assets.length, note: '从需求池取待生成素材' })
    } else if (root && args.use_order !== false) {
      const order = await planGenerationOrder({ root })
      const first = order.batches[0]
      if (first) {
        assets = first.items.map((item) => ({
          name: item.key,
          prompt: `${item.key.replace(/_/g, ' ')}, game asset, consistent art style`,
          kind: first.group,
          size: args.size,
        }))
        record('assets-from-order', { batch: first.step, group: first.group, count: assets.length, why: first.why })
      }
    }
  }
  if (assets.length === 0) {
    return { ok: false, error: '没有可生成的素材：给 assets，或先 scan 攒进需求池，或给 root 让我按顺序计划挑第一批。', steps }
  }

  // ── 步骤 1：生成（batch 内部已有去重/容量规划/波次/重试） ──────────
  if (args.dry_run) {
    const plan = await runBatch({
      profiles, gallery,
      settings: { outputDir: profiles.outputDir, caps: profiles.data.caps, timeoutMs: profiles.timeoutMs },
      args: { assets, project, quality: args.quality ?? 'low', size: args.size, dry_run: true, caps: { maxImagesPerRun: args.max_images } },
    })
    return { ok: true, dry_run: true, project, steps, planned: plan.plan, summary: plan.summary, pool_before: pool.report({ project }) }
  }

  const requested = assets.length
  const requestedImages = assets.reduce((sum, item) => sum + (Number(item.variants) || 1), 0)
  const gate = spend.check({ images: requestedImages, action: 'pipeline.generate', confirm: Boolean(args.confirm) })
  if (!gate.allow) return { ok: false, spend_guard: true, ...gate, steps }

  const generated = await runBatch({
    profiles, gallery,
    settings: { outputDir: profiles.outputDir, caps: profiles.data.caps, timeoutMs: profiles.timeoutMs },
    args: {
      assets, project,
      quality: args.quality ?? 'low',
      size: args.size,
      use_style_refs: args.use_style_refs !== false,
      game_root: root,
      caps: { maxImagesPerRun: args.max_images ?? requestedImages },
    },
  })
  spend.record({ action: 'pipeline.generate', images: generated.executed?.images ?? requestedImages, project, names: assets.map((item) => item.name) })
  pool.markGenerated(assets.map((item) => item.name), project)
  record('generate', { images: generated.executed?.images ?? 0, spent_images: generated.executed?.images_attempted, summary: generated.summary })
  const producedFiles = (generated.results ?? []).flatMap((item) => item.files ?? [])
  if (producedFiles.length === 0) {
    return { ok: false, error: '这一步没有产出任何图（可能都被闸门/去重挡下了）', steps, generated }
  }

  // ── 步骤 2：自检（废图不装机，直接列出来重画） ────────────────────
  const expectations = root ? (await readExpectations(root).catch(() => ({ expectations: {} }))).expectations : {}
  const review = await reviewBatch(producedFiles, { expectations })
  record('review', { good: review.good, needs_fit: review.needs_fit, suspect: review.suspect, bad_files: review.suspects.map((item) => item.file.split(/[\\/]/).pop()) })
  if (review.suspect > 0 && args.strict !== false) {
    // 严格模式：先把废图挑出来，不往下走（装进去只会黑屏）
    return {
      ok: false,
      error: `自检发现 ${review.suspect} 张废图（空/全黑/不可辨），已停下不装机。`,
      steps,
      review,
      next: '这几张直接重画（换提示词，别用同样的词），或加 strict=false 强行继续。',
      retry_assets: review.suspects.map((item) => {
        const name = item.file.split(/[\\/]/).pop().replace(/\.[a-z0-9]+$/i, '').replace(/_\d+$/, '')
        const original = assets.find((asset) => asset.name === name)
        return { name, prompt: original?.prompt ?? name, kind: original?.kind, problems: item.problems }
      }),
    }
  }

  const results = {}
  // ── 步骤 3：按规格装机 ────────────────────────────────────────────
  if (!args.skip_install && root) {
    results.install = await installAssets({ root, outputDir: profiles.outputDir, project, dataUrl: args.data_url !== false })
    record('install', { installed: results.install.installed, failed: results.install.failed, size_fixed: results.install.size_fixed?.length ?? 0, still_not_referenced: results.install.still_not_referenced?.length ?? 0 })
  }

  // ── 步骤 4：登记进游戏（写生成物会被拒绝，返回里会说） ────────────
  if (!args.skip_register && root && (args.register !== false)) {
    const check = await checkProject({ root, outputDir: profiles.outputDir, project })
    const entries = (check.items ?? [])
      .filter((item) => (args.names?.length ? args.names.includes(item.key) : true))
      .map((item) => ({ key: item.key, file: path.join(profiles.outputDir, item.file), name: item.key }))
    if (entries.length > 0) {
      results.register = await registerAssets({ root, entries, dataUrl: args.data_url !== false, dryRun: Boolean(args.register_dry_run) })
      record('register', { total_changed: results.register.total_changed, skipped: results.register.reports?.filter((item) => item.skipped).length ?? 0 })
    }
  }

  return {
    ok: true,
    project,
    steps,
    generated: { images: generated.executed?.images ?? 0, requests: generated.executed?.requests, seconds: generated.executed?.seconds },
    review: { good: review.good, needs_fit: review.needs_fit, suspect: review.suspect },
    install: results.install ? { installed: results.install.installed, size_fixed: results.install.size_fixed } : null,
    register: results.register ? { changed: results.register.total_changed, hint: results.register.hint } : null,
    pool_after: pool.report({ project }),
    next: '装完请截图给用户看界面变化（screenshot mode=window）。',
  }
}
