/**
 * 极简 multipart/form-data 解析（零依赖）。
 *
 * 为什么需要：面板上「导入图片」用的是浏览器 <input type="file">，浏览器只会发
 * multipart/form-data —— 而插件是零依赖的，没有 formidable / busboy 可用。
 * 这里只做「按 boundary 切块 + 解析每块头部」这点必要的事，不追求覆盖 RFC 全部分支。
 *
 * 不支持的（明确说出来，别装作支持）：嵌套 multipart、base64 传输编码、
 * 超过 maxBytes 的请求体（由调用方在读到 Buffer 后自行判断）。
 */

/** 从 Content-Type 里取出 boundary。 */
export function boundaryOf(contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType ?? ''))
  const boundary = (match?.[1] ?? match?.[2] ?? '').trim()
  return boundary || ''
}

/**
 * @param {Buffer} buffer 完整的请求体
 * @param {string} contentType 请求的 Content-Type
 * @returns {{ok:boolean, parts?:Array<{name:string,filename:string|null,contentType:string|null,data:Buffer}>, error?:string}}
 */
export function parseMultipart(buffer, contentType) {
  const boundary = boundaryOf(contentType)
  if (!boundary) return { ok: false, error: '缺少 multipart boundary' }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { ok: false, error: '请求体是空的' }

  // 难点：分隔符不是裸的 "--boundary"，而是 "--boundary" 前面还带一个 CRLF。
  // 用裸的去找，内容里只要出现同样的字节序列就会被提前截断（实测：文件内容是
  // "a\r\nb--Xc" 时被切成了 "a\r\nb"）。所以必须带上前缀 CRLF。
  const opening = Buffer.from(`--${boundary}`)
  const delimiter = Buffer.from(`\r\n--${boundary}`)

  // 第一个分隔符可能前面有 preamble，所以限定它「在开头」或「紧跟在 CRLF 之后」
  let start = -1
  for (let at = buffer.indexOf(opening); at >= 0; at = buffer.indexOf(opening, at + 1)) {
    const afterCrlf = at >= 2 && buffer[at - 2] === 0x0d && buffer[at - 1] === 0x0a
    if (at === 0 || afterCrlf) { start = at; break }
  }
  if (start < 0) return { ok: false, error: '在请求体里找不到 boundary 分隔符' }

  const chunks = []
  let cursor = start + opening.length
  while (cursor < buffer.length) {
    // 收尾的 "--boundary--"
    if (buffer[cursor] === 0x2d && buffer[cursor + 1] === 0x2d) break
    if (buffer[cursor] === 0x0d && buffer[cursor + 1] === 0x0a) cursor += 2

    const next = buffer.indexOf(delimiter, cursor)
    if (next < 0) break
    // delimiter 自带前缀 CRLF，所以内容就是 [cursor, next) —— 不用再削尾巴
    chunks.push(buffer.subarray(cursor, next))
    cursor = next + delimiter.length
  }

  const parts = []
  for (const chunk of chunks) {
    const split = chunk.indexOf('\r\n\r\n')
    if (split < 0) continue
    const headerText = chunk.subarray(0, split).toString('utf8')
    const data = chunk.subarray(split + 4)
    const name = /name="([^"]*)"/i.exec(headerText)?.[1] ?? ''
    const filename = /filename="([^"]*)"/i.exec(headerText)?.[1]
    const type = /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1]?.trim()
    parts.push({
      name,
      filename: filename === undefined ? null : filename,
      contentType: type ?? null,
      data,
    })
  }

  if (parts.length === 0) return { ok: false, error: '解析出 0 个字段（boundary 可能不对）' }
  return { ok: true, parts }
}

/** 取第一个文件字段。 */
export function firstFile(parts = []) {
  return parts.find((part) => part.filename) ?? null
}

/** 取普通文本字段。 */
export function fieldValue(parts = [], name) {
  const part = parts.find((item) => item.name === name && !item.filename)
  return part ? part.data.toString('utf8') : undefined
}
