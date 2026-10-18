/**
 * 出图探针：真发 1 张，验证 配置档 / Key / 模型 / 路径 / 落盘。
 *   node scripts/probe.mjs "一个红色苹果，白色背景"
 * 只花 1 张的钱，通了再批量出图。
 */
import { ProfileStore, Gallery } from '../lib/store.js'
import { runImage } from '../lib/run.js'
import { probe } from '../lib/api.js'
import { resolveProvider } from '../lib/run.js'

const prompt = process.argv.slice(2).join(' ') || 'a simple red apple on plain white background, clean game asset style'
const project = process.env.FORGE_PROBE_PROJECT || '连通性测试'
const name = process.env.FORGE_PROBE_NAME || 'gptimage_probe'

const profiles = await ProfileStore.load()
const profile = profiles.active
if (!profile) {
  console.error('没有可用的配置档：先在面板 /gpt-image 或 config 工具里配一个')
  process.exit(1)
}
const provider = resolveProvider(profiles, profile)
const health = await probe({ profile, provider })
console.log(`配置档 ${profile.id}｜服务商 ${provider.id}｜baseUrl ${profile.baseUrl}｜模型 ${profile.model}`)
console.log(`连通性：ok=${health.ok} ${health.note ?? health.message ?? ''} ${health.baseUrlUsed ?? ''}`)

const gallery = await Gallery.load()
const result = await runImage({
  profiles,
  gallery,
  settings: { outputDir: profiles.outputDir, timeoutMs: profiles.timeoutMs },
  args: {
    prompt,
    project,
    name,
    size: process.env.FORGE_PROBE_SIZE || '1024x1024',
    quality: process.env.FORGE_PROBE_QUALITY || 'low',
    n: 1,
  },
})
await gallery.save()

console.log(JSON.stringify({
  ok: result.ok,
  images: result.images,
  files: result.files,
  output_dir: result.output_dir,
  index_file: result.index_file,
  ms: result.ms,
  error: result.error,
  upstream: result.upstream,
  board_url: result.board_url,
}, null, 2))
