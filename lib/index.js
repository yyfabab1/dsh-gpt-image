/**
 * @dsh-external/dsh-gpt-image — GPT Image 出图台（DeepSeek Harness 插件）
 *
 * 仿照 GPT Image Playground（gpt-image2ground）的能力模型，做成 DSH 可直接调用的独立插件：
 *   多服务商（openai / sb2api 异步 / fal / 自定义模板）
 *   多配置档（每个档 = 接口 + Key + 模型 + apiMode）
 *   文生图 · 图生图/局部重绘（image[] + mask）· 异步任务轮询
 *   零运行时依赖（只用 node: 内置模块），装进 profile 不需要再拉依赖树。
 */
import os from 'node:os'
import path from 'node:path'
import { Gallery, ProfileStore } from './store.js'
import { DemandPool } from './pool.js'
import { SpendLedger } from './spend.js'
import { PromptLibrary } from './prompts.js'
import { AssetCatalog } from './assets.js'
import { createTools } from './tools.js'
import { attachPanel } from './server.js'

export const name = '@dsh-external/dsh-gpt-image'
export const inject = ['tools']

export function defaultDataDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'gpt-image')
}

export function createRuntime(config = {}) {
  const fileConfig = {
    dataDir: config.dataDir || '',
    outputDir: config.outputDir || '',
  }
  const dataDir = fileConfig.dataDir || defaultDataDir()
  return {
    dataDir,
    outputDir: fileConfig.outputDir,
    boardUrl() {
      const base = (process.env.DSH_WEB_URL || 'http://127.0.0.1:3080').replace(/\/+$/, '')
      return `${base}/gpt-image`
    },
    async loadState() {
      const profiles = await ProfileStore.load(dataDir)
      if (fileConfig.outputDir) profiles.data.outputDir = fileConfig.outputDir
      const gallery = await Gallery.load(dataDir)
      const pool = await DemandPool.load(dataDir)
      const spend = await SpendLedger.load(dataDir)
      const prompts = await PromptLibrary.load(dataDir)
      const assets = await AssetCatalog.load(dataDir)
      // 配置档可以声明自己的单价（例如免费档 pricePerImage: 0）。
      // 在这里统一生效，所有出图入口的花钱闸门都会自动按该档单价计算，
      // 不需要每个工具调用点各自传参。未声明则沿用全局单价。
      const activePrice = profiles.active?.pricePerImage
      if (activePrice !== undefined && Number.isFinite(Number(activePrice)) && Number(activePrice) >= 0) {
        spend.data.activePricePerImage = Number(activePrice)
      } else {
        delete spend.data.activePricePerImage
      }
      return {
        profiles,
        gallery,
        pool,
        spend,
        prompts,
        assets,
        settings: {
          timeoutMs: profiles.timeoutMs,
          outputDir: profiles.outputDir,
          dataDir,
          // 「导入本地图片生成视频」要用：Agnes 只收公网 URL，本地素材得先传出去。
          // publicBaseUrl = 把自己（DSH 的 HTTP 服务）通过隧道/反代暴露出去，不外泄素材；
          // uploadEndpoint = 自己的图床 / 对象存储；都没配就走内置免费匿名图床。
          publicBaseUrl: profiles.data.publicBaseUrl ?? '',
          uploadEndpoint: profiles.data.uploadEndpoint ?? '',
          uploadField: profiles.data.uploadField ?? 'file',
          uploadTimeoutMs: profiles.data.uploadTimeoutMs,
        },
      }
    },
    async saveState(state) {
      await state.profiles.save()
      await state.gallery.save()
      await state.pool?.save()
      await state.spend?.save()
      await state.prompts?.save()
      await state.assets?.save()
    },
    /** 把截图挂成会话附件（能贴进对话）；服务缺失时返回 null。 */
    async attachImage(file) {
      const store = runtime.attachments
      if (!store || typeof store.saveImage !== 'function') return null
      const { readFile } = await import('node:fs/promises')
      const data = await readFile(file)
      const ref = await store.saveImage({ data: new Uint8Array(data), mediaType: 'image/png', name: path.basename(file) })
      return ref ?? null
    },
  }
}

export function apply(ctx, config = {}) {
  const runtime = createRuntime(config)
  // 附件服务（可选）：有它就能把截图直接贴进对话
  if (typeof ctx.inject === 'function') {
    ctx.inject(['attachments'], (scope) => {
      runtime.attachments = scope.attachments
    })
  }
  for (const tool of createTools(runtime)) {
    ctx.effect(() => ctx.tools.register(tool), `${name}: ${tool.name}`)
  }
  attachPanel(ctx, { ...config, dataDir: runtime.dataDir, outputDir: config.outputDir || '' })
}
