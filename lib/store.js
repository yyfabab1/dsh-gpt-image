/**
 * 配置与出图历史。
 *  - profiles.json：多套接口配置（服务商 + baseUrl + key + 模型 + apiMode）+ 自定义服务商模板，
 *    格式与 GPT Image Playground 的 gpt-image-config.json 兼容（customProviders + profiles），可直接互导。
 *  - history.json：每次出图/改图的记录（提示词、参数、产物路径、耗时、失败原因），面板与清单都读它。
 */
import os from 'node:os'
import path from 'node:path'
import { nowIso, readJson, shortHash, writeJsonAtomic } from './util.js'

export const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
export const DEFAULT_MODEL = 'gpt-image-2'

/** 默认数据目录（传空值时兜底，避免把文件写到当前工作目录）。 */
export function defaultDataDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'gpt-image')
}

/** 内置服务商 id：与 Playground 的 provider 取值对齐。 */
export const BUILTIN_PROVIDERS = ['openai', 'sb2api-async', 'fal']

/** load() 里已显式搬运过的顶层字段：其余的一律原样保留（见 load 里的注释）。 */
const LOAD_HANDLED = new Set(['version', 'profiles', 'customProviders', 'activeProfileId', 'outputDir', 'timeoutMs', 'caps'])

export function defaultProfile() {
  return {
    id: 'default-openai',
    name: '默认（OpenAI 兼容 Images API）',
    provider: 'openai',
    baseUrl: DEFAULT_BASE_URL,
    apiKey: '',
    model: DEFAULT_MODEL,
    apiMode: 'images',
    isDefault: true,
  }
}

export class ProfileStore {
  constructor(dataDir, file, data) {
    this.dataDir = dataDir
    this.file = file
    this.data = data
  }

  static async load(dataDir) {
    const dir = dataDir || defaultDataDir()
    const file = path.join(dir, 'profiles.json')
    const raw = await readJson(file, null)
    const data = {
      version: 1,
      activeProfileId: 'default-openai',
      outputDir: '',
      timeoutMs: 600000,
      caps: { maxImagesPerRun: 12, maxCostPerRun: 3, maxConcurrency: 2, maxBatch: 4 },
      customProviders: [],
      profiles: [defaultProfile()],
    }
    if (raw && typeof raw === 'object') {
      if (Array.isArray(raw.profiles) && raw.profiles.length > 0) data.profiles = raw.profiles
      if (Array.isArray(raw.customProviders)) data.customProviders = raw.customProviders
      if (raw.activeProfileId) data.activeProfileId = raw.activeProfileId
      if (typeof raw.outputDir === 'string') data.outputDir = raw.outputDir
      if (Number(raw.timeoutMs) > 0) data.timeoutMs = Number(raw.timeoutMs)
      if (raw.caps && typeof raw.caps === 'object') data.caps = { ...data.caps, ...raw.caps }
      // save() 是把 this.data 整个写回去的，所以 load 也必须无损，否则「后来加的字段」
      // 会静默丢失 —— 实测 gameRoot / lastProject / publicBaseUrl / uploadEndpoint 全都会丢，
      // 表现是「面板里设了、下次读又空了」，而且一个字都不报错。
      // 这里把上面没显式处理过的顶层字段原样搬回来，杜绝这一类问题再出现。
      for (const [key, value] of Object.entries(raw)) {
        if (LOAD_HANDLED.has(key)) continue
        data[key] = value
      }
    }
    return new ProfileStore(dir, file, data)
  }

  /** 出图落盘根目录（未配置则用 <数据目录>/output）。 */
  get outputDir() {
    return this.data.outputDir || path.join(this.dataDir, 'output')
  }

  get timeoutMs() {
    return Number(this.data.timeoutMs) || 300000
  }

  async save() {
    this.data.updatedAt = nowIso()
    await writeJsonAtomic(this.file, this.data)
    return this.data
  }

  get profiles() {
    return this.data.profiles
  }

  get(id) {
    if (!id) return this.active
    return this.profiles.find((profile) => profile.id === id)
  }

  get active() {
    return this.profiles.find((profile) => profile.id === this.data.activeProfileId)
      ?? this.profiles.find((profile) => profile.isDefault)
      ?? this.profiles[0]
  }

  upsert(profile) {
    const index = this.profiles.findIndex((item) => item.id === profile.id)
    if (index >= 0) this.profiles[index] = { ...this.profiles[index], ...profile }
    else this.profiles.push(profile)
    return this.get(profile.id)
  }

  remove(id) {
    const before = this.profiles.length
    this.data.profiles = this.profiles.filter((profile) => profile.id !== id)
    if (this.data.activeProfileId === id) this.data.activeProfileId = this.profiles[0]?.id ?? ''
    this.data.customProviders = this.data.customProviders.filter((provider) => provider.id !== id)
    return this.profiles.length < before
  }

  setActive(id) {
    if (!this.get(id)) return false
    this.data.activeProfileId = id
    return true
  }

  /** 找一个自定义/内置的服务商模板定义。 */
  provider(providerId) {
    return this.data.customProviders.find((provider) => provider.id === providerId)
  }

  /** 导出成 Playground 可直接导入的 gpt-image-config.json。 */
  exportPlaygroundConfig({ includeSecrets = true } = {}) {
    return {
      customProviders: JSON.parse(JSON.stringify(this.data.customProviders)),
      profiles: this.profiles.map((profile) => {
        const clone = { ...profile }
        if (!includeSecrets) delete clone.apiKey
        return clone
      }),
    }
  }

  /** 导入 Playground 的 gpt-image-config.json（也接受裸 profiles 数组）。 */
  importPlaygroundConfig(config, { merge = true } = {}) {
    const incomingProfiles = Array.isArray(config?.profiles) ? config.profiles : Array.isArray(config) ? config : []
    const incomingProviders = Array.isArray(config?.customProviders) ? config.customProviders : []
    if (incomingProfiles.length === 0 && incomingProviders.length === 0) {
      return { ok: false, message: '配置里既没有 profiles 也没有 customProviders' }
    }
    if (!merge) {
      this.data.profiles = []
      this.data.customProviders = []
    }
    for (const provider of incomingProviders) {
      if (!provider?.id) continue
      const index = this.data.customProviders.findIndex((item) => item.id === provider.id)
      if (index >= 0) this.data.customProviders[index] = provider
      else this.data.customProviders.push(provider)
    }
    for (const profile of incomingProfiles) {
      if (!profile?.id) continue
      // 保留调用方带来的其它字段（如 pricePerImage / responseFormatB64Json / reasoningEffort）：
      // 只挑已知字段会让这些设置在下一次保存时被静默丢掉。
      const { id: _id, ...rest } = profile
      const normalized = {
        ...rest,
        id: profile.id,
        name: profile.name ?? profile.id,
        provider: profile.provider ?? 'openai',
        baseUrl: profile.baseUrl ?? DEFAULT_BASE_URL,
        apiKey: profile.apiKey ?? '',
        model: profile.model ?? DEFAULT_MODEL,
        apiMode: profile.apiMode ?? 'images',
        isDefault: Boolean(profile.isDefault),
      }
      const index = this.data.profiles.findIndex((item) => item.id === normalized.id)
      if (index >= 0) this.data.profiles[index] = { ...this.data.profiles[index], ...normalized }
      else this.data.profiles.push(normalized)
    }
    if (!this.data.profiles.some((profile) => profile.id === this.data.activeProfileId)) {
      this.data.activeProfileId = this.data.profiles.find((profile) => profile.isDefault)?.id ?? this.data.profiles[0]?.id ?? ''
    }
    return { ok: true, profiles: this.data.profiles.length, customProviders: this.data.customProviders.length }
  }

  /** 给模型/面板看的脱敏快照。 */
  masked() {
    return {
      version: this.data.version,
      activeProfileId: this.data.activeProfileId,
      outputDir: this.outputDir,
      timeoutMs: this.timeoutMs,
      caps: this.data.caps,
      profiles: this.profiles.map((profile) => ({
        ...profile,
        apiKey: profile.apiKey ? maskKey(profile.apiKey) : '',
        hasApiKey: Boolean(profile.apiKey),
      })),
      customProviders: this.data.customProviders,
    }
  }
}

export function maskKey(key) {
  const text = String(key ?? '')
  if (!text) return ''
  if (text.length <= 8) return '****'
  return `${text.slice(0, 5)}****${text.slice(-4)}`
}

export class Gallery {
  constructor(file, records = []) {
    this.file = file
    this.records = records
  }

  static async load(dataDir, limit = 1000) {
    const dir = dataDir || defaultDataDir()
    const file = path.join(dir, 'history.json')
    const raw = await readJson(file, null)
    const records = Array.isArray(raw?.records) ? raw.records : []
    return new Gallery(file, records.slice(0, limit))
  }

  async save() {
    await writeJsonAtomic(this.file, { version: 1, updatedAt: nowIso(), records: this.records.slice(0, 1000) })
  }

  add(record) {
    const entry = { id: `g_${Date.now().toString(36)}_${shortHash(`${Date.now()}${Math.random()}`, 6)}`, ts: nowIso(), ...record }
    this.records.unshift(entry)
    this.records = this.records.slice(0, 1000)
    return entry
  }

  list({ limit = 100, profile, kind } = {}) {
    let items = this.records
    if (profile) items = items.filter((record) => record.profile === profile)
    if (kind) items = items.filter((record) => record.kind === kind)
    return items.slice(0, limit)
  }

  stats() {
    const ok = this.records.filter((record) => record.status === 'ok').length
    const failed = this.records.length - ok
    const images = this.records.reduce((sum, record) => sum + (record.images ?? 0), 0)
    return { total: this.records.length, ok, failed, images }
  }
}
