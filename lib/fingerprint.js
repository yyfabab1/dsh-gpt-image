/**
 * 素材指纹：同一「配置档+模型+提示词+尺寸+宽高比+质量+类型」视为同一张图，用来去重（避免重复花钱）。
 * ratio 必须参与：size=2K 时 16:9 与 9:16 是两张完全不同的图，漏掉它会把不同构图误判成重复。
 *
 * pixel 的兼容性处理（很重要）：只有**非空**时才拼进哈希。
 * 因为历史记录里的指纹是按 `[...kind].join('|')` 算的，无条件多拼一段会让所有已有指纹全部失效
 * —— 后果是「以前出过的图判定成没出过」，重新生成一遍，真金白银重复花一次。
 * 这样写：不传 pixel 的老指纹逐位不变；传了 pixel 的才会得到新指纹（也正是我们想要的去重区分）。
 */
import { sha256 } from './util.js'

export function assetFingerprint({ profileId = '', model = '', prompt = '', size = '', ratio = '', quality = '', kind = 'image', pixel = '' }) {
  const parts = [profileId, model, prompt, size, ratio, quality, kind]
  if (pixel) parts.push(typeof pixel === 'string' ? pixel : JSON.stringify(pixel))
  return sha256(parts.join('|')).slice(0, 20)
}

export function galleryFingerprints(gallery, filter = {}) {
  const set = new Set()
  for (const record of gallery?.records ?? []) {
    if (record.status !== 'ok' && record.status !== 'pending') continue
    if (filter.profile && record.profile !== filter.profile) continue
    const fp = record.fingerprint ?? assetFingerprint({
      profileId: record.profile,
      model: record.model,
      prompt: record.prompt,
      size: record.params?.size ?? '',
      ratio: record.params?.ratio ?? '',
      quality: record.params?.quality ?? '',
      kind: record.kind ?? 'image',
    })
    set.add(fp)
  }
  return set
}

/**
 * 去重预检：这次要花的钱里，有多少是「已经生成过的」。
 * 用在单张/多张生成之前 —— 同一配置档+模型+提示词+尺寸+宽高比+质量+类型就是同一张图；
 * 没有这道预检，把同一句提示词再发一次就等于白付一次钱。
 * @returns {{duplicate:boolean, fingerprint:string, existing:object|null}}
 */
export function findDuplicate(gallery, spec = {}) {
  const fingerprintOf = (record) => record.fingerprint ?? assetFingerprint({
    profileId: record.profile,
    model: record.model,
    prompt: record.prompt,
    size: record.params?.size ?? '',
    ratio: record.params?.ratio ?? '',
    quality: record.params?.quality ?? '',
    kind: record.kind ?? 'image',
  })
  const fingerprint = assetFingerprint({
    profileId: spec.profileId ?? '',
    model: spec.model ?? '',
    prompt: spec.prompt ?? '',
    size: spec.size ?? '',
    ratio: spec.ratio ?? '',
    quality: spec.quality ?? '',
    kind: spec.kind ?? 'image',
  })
  const existing = (gallery?.records ?? []).find((record) => record.status === 'ok' && fingerprintOf(record) === fingerprint) ?? null
  return { duplicate: Boolean(existing), fingerprint, existing }
}
