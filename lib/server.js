/**
 * 面板 /gpt-image
 *  - 出图台：看所有产物缩略图 + 提示词 + 参数（「哪张图对应哪句提示词」一目了然）
 *  - 配置：多配置档（服务商/baseUrl/Key/模型/apiMode）、导入导出 Playground 配置、测连通
 * 只读本插件的数据目录与输出目录；POST 有同源栅栏。
 */
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { Gallery, ProfileStore } from './store.js'
import { SpendLedger } from './spend.js'
import { DemandPool } from './pool.js'
import { buildBalanceReport } from './balance.js'
import { AssetCatalog, scanAssetCatalog, normalizePath, sliceRuleFor, assetNameOf } from './assets.js'
import { getThumbnail } from './thumb.js'
/* 扫描缓存：scanAssetCatalog 会**递归遍历整个输出目录**（4121 个文件，全量 381ms）。
 * 它在 server 里被调用 11 处，面板一次刷新可能触发好几次 —— 每次都重扫纯属浪费。
 * 缓存键带「目录根 mtime」：有文件增删根目录 mtime 就变，缓存自动失效，
 * 所以不会出现"新素材不显示"的脏读。
 */
const scanCache = new Map()
const SCAN_TTL_MS = 4000

async function scanCached(args) {
  const key = `${args.outputDir}|${args.project ?? ''}`
  const rootInfo = await stat(args.outputDir).catch(() => null)
  const stamp = rootInfo ? Math.round(rootInfo.mtimeMs) : 0
  const hit = scanCache.get(key)
  if (hit && hit.stamp === stamp && Date.now() - hit.at < SCAN_TTL_MS) {
    return { ...hit.result, cached: true, cached_ms: Date.now() - hit.at }
  }
  const started = Date.now()
  const result = await scanAssetCatalog(args)
  scanCache.set(key, { at: Date.now(), stamp, result })
  return { ...result, cached: false, scan_ms: Date.now() - started }
}

/** 输出目录有变动（生成、装机、整理）后调它，让下一次扫描立即重新算。 */
function invalidateScanCache() {
  scanCache.clear()
}

import { ProvenanceLog, createBackup, listBackups, restoreBackup } from './safety.js'
import { parseWebhook } from './watch.js'
import { PipelineConfig, STEP_CATALOG } from './declarative.js'
import { ReviewLog, classifyAsset, DEFAULT_POLICY, applyPolicy } from './decide.js'
import { planOrphanCleanup, applyOrphanCleanup, planDanglingVerdicts, planMissingRepair } from './selfheal.js'
import { healthDashboard, pipelineFunnel, trending } from './pipeline2.js'
import { checkAlerts, pipelineStatus, maintenanceChecklist, DEFAULT_ROLES } from './orchestrate.js'
import { readJson, writeJsonAtomic } from './util.js'
import { Snapshot, diffSnapshot } from './snapshot.js'
import { buildCompare } from './compare.js'
import { acquireLock, planReprocess, runReprocess } from './reprocess.js'
import { decodePngRgba } from './pngcodec.js'
import { computeSlices } from './sheet.js'
import { probe } from './api.js'
import { resolveProvider, runImage } from './run.js'
import { runVideo, resolveVideoProfile } from './video.js'
import { runAudio } from './audio.js'
import { pixelizePng } from './pixelize.js'
import { checkProject, readExpectations } from './check.js'
import { scanGame } from './batch/scan.js'
import { ApprovalQueue } from './approval.js'
import { buildProjectProfiles } from './crossstyle.js'
import { BUILTIN_PROVIDERS, normalizeProvider, providerCapabilities } from './protocol.js'
import { isSameOrigin, resolveInside } from './util.js'
import { parseMultipart, firstFile, fieldValue, boundaryOf } from './multipart.js'
import { resolvePublicUrl } from './upload.js'

const PLUGIN_NAME = '@dsh-external/dsh-gpt-image'
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.json': 'application/json; charset=utf-8',
  // 视频产物（Agnes 视频出 mp4）；缺了这行浏览器只会当二进制下载，不能内联播放
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
}

/**
 * 从像素化结果里挑出能安全 JSON 化的元信息。
 * 为什么要单独抽：pixelizePng 的返回值里有 `pixels`（TypedArray）和 `buffer`，
 * 直接塞进 sendJson 会变成几十万个数字、把响应撑爆（也把浏览器卡死）。
 */
function pickPixelMeta(result) {
  if (!result) return {}
  const { pixels, buffer, also, ...rest } = result
  return {
    ...rest,
    ...(also ? { also: { width: also.width, height: also.height } } : {}),
  }
}

/**
 * 惰性读原始 body（Buffer），给 multipart 用；同样只真正读一次。
 *
 * 注意：POST 路由在下面有一句统一的 `await readJsonBody(req)`，它会把整个流读干。
 * 所以 uploads 这类要走原始字节的路由，必须靠「读过就缓存」共享同一份 Buffer ——
 * 否则拿到的会是空 body（实测：报「请求体是空的」）。
 */
async function readRawBody(req, maxBytes = 64 * 1024 * 1024) {
  if (req.__dshRawBody !== undefined) return req.__dshRawBody
  if (req.__dshRawPromise) return req.__dshRawPromise
  req.__dshRawPromise = (async () => {
    const chunks = []
    let size = 0
    let tooLarge = false
    for await (const chunk of req) {
      const buf = Buffer.from(chunk)
      size += buf.length
      if (size > maxBytes) {
        // 超限就别再攒了，但**要把流读完**：半读的流会让连接悬着不结束
        tooLarge = true
        continue
      }
      chunks.push(buf)
    }
    if (tooLarge) req.__dshRawTooLarge = true
    req.__dshRawBody = Buffer.concat(chunks)
    return req.__dshRawBody
  })()
  return req.__dshRawPromise
}

/**
 * 惰性读 JSON body（可被多次调用，只真正读一次）。
 *
 * 为什么需要：路由处理是**顺序 if**，而 POST body 的统一解析在较后面。
 * 若某个 POST 分支放在解析之前、又直接引用 `body`，就会
 * "Cannot access 'body' before initialization"（实测踩过）。
 * 这个 helper 把「读过就缓存」封装起来，任何一个分支都能安全拿到 body。
 */
async function readJsonBody(req) {
  if (req.__dshParsedBody !== undefined) return req.__dshParsedBody
  if (req.__dshBodyPromise) return req.__dshBodyPromise
  req.__dshBodyPromise = (async () => {
    try {
      // 走 readRawBody：原始字节要留在 req.__dshRawBody 上给 multipart 用
      const raw = await readRawBody(req)
      const text = raw.toString('utf8')
      req.__dshParsedBody = text ? JSON.parse(text) : {}
    } catch {
      req.__dshParsedBody = {}
    }
    return req.__dshParsedBody
  })()
  return req.__dshBodyPromise
}

const sendJson = (res, code, payload) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload, null, 2))
}

function pageHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>GPT Image 出图台</title>
<style>
 :root{color-scheme:dark}
 body{margin:0;font:14px/1.6 system-ui,"Segoe UI",sans-serif;background:#0f1117;color:#e6e8ee}
 main{max-width:1180px;margin:0 auto;padding:24px 18px 80px}
 h1{font-size:20px;margin:0 0 4px} h3{margin:0 0 10px;font-size:15px}
 .sub{color:#98a2b3;margin-bottom:16px;font-size:13px}
 .tabs{display:flex;gap:8px;margin:16px 0}
 .tabs button{background:#171a22;border:1px solid #262b36;color:#c2c9d6;padding:8px 14px;border-radius:8px;cursor:pointer}
 .tabs button.on{background:#8b5cf6;color:#fff;border-color:#8b5cf6}
 .card{background:#171a22;border:1px solid #262b36;border-radius:12px;padding:16px;margin:14px 0}
 label{display:block;color:#c2c9d6;margin:10px 0 4px;font-size:13px}
 input,select,textarea{width:100%;box-sizing:border-box;background:#0f1117;border:1px solid #2c3340;color:#e6e8ee;border-radius:8px;padding:8px 10px;font:inherit}
 textarea{min-height:150px;font-family:ui-monospace,Consolas,monospace;font-size:12px}
 button.act{background:#8b5cf6;border:0;color:#fff;border-radius:8px;padding:9px 16px;font:inherit;cursor:pointer;margin:12px 8px 0 0}
 button.ghost{background:#232936;border:0;color:#e6e8ee;border-radius:8px;padding:8px 14px;font:inherit;cursor:pointer;margin:10px 8px 0 0}
 pre{white-space:pre-wrap;background:#0f1117;border:1px solid #2c3340;border-radius:8px;padding:12px;max-height:240px;overflow:auto;font-size:12px}
 .row{display:flex;gap:12px;flex-wrap:wrap}.row>div{flex:1;min-width:160px}
 .wall{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px}
 .tile{background:#12151c;border:1px solid #262b36;border-radius:10px;overflow:hidden}
 .tile img{width:100%;height:190px;object-fit:contain;background:#0b0e14}
 .tile .meta{padding:8px;font-size:12px}
 .name{font-weight:600;word-break:break-all}
 .prompt{background:#0b0e14;border:1px dashed #2c3340;border-radius:6px;padding:8px;margin:6px 0;font-family:ui-monospace,Consolas,monospace;font-size:12px;word-break:break-word;max-height:120px;overflow:auto}
 .chips span{display:inline-block;background:#232936;border-radius:999px;padding:1px 8px;margin:2px 4px 0 0;font-size:11px;color:#c2c9d6}
 .ok{color:#4ade80}.bad{color:#f87171}.warn{color:#fbbf24}.muted{color:#8b95a5}
 .balbar{display:flex;gap:14px;align-items:center;flex-wrap:wrap;font-size:13px;padding:10px 12px;margin-bottom:12px;
   border:1px solid #262b36;border-left:3px solid #8b5cf6;border-radius:8px;background:#141822}
 .balbar .t{font-weight:600}
 .balbar.ok{border-left-color:#4ade80}.balbar.warn{border-left-color:#fbbf24}.balbar.bad{border-left-color:#f87171}
 .balbar .k{color:#8b95a5}
 .balbar .bar{width:90px;height:6px;border-radius:3px;background:#262b36;overflow:hidden;display:inline-block;vertical-align:middle}
 .balbar .bar i{display:block;height:100%;background:#4ade80}
 .balbar .bar.warn i{background:#fbbf24}.balbar .bar.bad i{background:#f87171}
 .prof{border:1px solid #262b36;border-radius:8px;padding:10px;margin:8px 0}
 .prof.on{border-color:#8b5cf6}
</style></head><body><main>
<h1>GPT Image 出图台</h1>
<div class="sub">多服务商 / 多配置档 · 文生图 · 图生图改图 · 异步任务轮询。产物按 <code>&lt;输出根&gt;/&lt;项目&gt;/&lt;素材名&gt;_序号.png</code> 落盘，并生成「图片清单.md」。AI 也可直接调用同名工具。</div>

<div class="tabs">
  <button id="tab-gallery" class="on" onclick="show('gallery')">出图记录</button>
  <button id="tab-approval" onclick="show('approval')">待批准 <span id="approvalBadge"></span></button>
  <button id="tab-check" onclick="show('check')">素材核对</button>
  <button id="tab-cross" onclick="show('cross')">跨项目风格</button>
  <button id="tab-config" onclick="show('config')">配置</button>
</div>

<section id="pane-approval" style="display:none">
  <div class="card">
    <h3>资产预算审批流</h3>
    <p class="muted">一次花费超过阈值时不直接跑，先生成待批准单。点「批准」后，把单号作为 <code>approved_token</code> 交给对应工具即可执行。**参数变了单子自动作废**。</p>
    <div class="row">
      <div><label>审批阈值（元）</label><input id="approvalThreshold" type="number" min="0" step="1"/></div>
      <div style="display:flex;align-items:flex-end"><button class="act" onclick="saveThreshold()">保存阈值</button></div>
    </div>
    <div id="approvalList"></div>
  </div>
</section>

<section id="pane-cross" style="display:none">
  <div class="card">
    <h3>跨项目风格对比</h3>
    <p class="muted">相似度低 = 两套美术语言，生成时**不能跨项目借用参考图**（会串味）。生成时已强制只用同项目素材当参考。</p>
    <button class="act" onclick="loadCross()">重新扫描</button>
    <div id="crossResult"></div>
  </div>
</section>

<section id="pane-gallery">
  <div class="card">
    <div id="balanceBar" class="balbar">余额读取中…</div>
    <div class="toolbar" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
      <input id="filter" placeholder="按项目/素材名/提示词过滤" style="max-width:300px" oninput="renderGallery()"/>
      <button class="ghost" onclick="loadGallery()">刷新</button>
      <button class="ghost" onclick="loadBalance()">刷新余额</button>
      <span id="stats" class="muted"></span>
    </div>
    <div id="wall" class="wall"></div>
  </div>
</section>

<section id="pane-check" style="display:none">
  <div class="card">
    <h3>素材核对 · 我的生图到底能不能用在游戏里</h3>
    <div class="row">
      <div><label>游戏目录（用来查规格清单与代码引用）</label><input id="gameRoot" placeholder="D:\\AHC\\doomsday-ember"/></div>
      <div><label>项目（输出目录里的子目录名）</label><select id="checkProject"></select></div>
    </div>
    <button class="act" onclick="saveGameRoot()">保存游戏目录</button>
    <button class="act" onclick="runCheck()">开始核对</button>
    <button class="ghost" onclick="runScan()">体检（缺什么素材）</button>
    <pre id="checkLog">就绪。核对会告诉你：尺寸/透明底对不对、是不是空图、游戏代码里有没有引用。</pre>
    <div id="checkSummary" class="muted" style="margin:8px 0"></div>
    <div id="checkTable"></div>
  </div>
</section>

<section id="pane-config" style="display:none">
  <div class="card">
    <h3>配置档</h3>
    <div id="profiles"></div>
    <div class="row">
      <div><label>档 id（唯一）</label><input id="p_id" placeholder="my-relay"/></div>
      <div><label>显示名</label><input id="p_name" placeholder="我的中转站"/></div>
    </div>
    <label>服务商</label>
    <select id="p_provider"></select>
    <label>baseUrl（不带 /v1 也行，插件会自动补）</label><input id="p_baseUrl" placeholder="https://sub-proxy-us.65535.space/v1"/>
    <label>API Key（留空=不改动）</label><input id="p_apiKey" placeholder="sk-..."/>
    <div class="row">
      <div><label>模型</label><input id="p_model" placeholder="gpt-image-2.5-sunburst"/></div>
      <div><label>接口模式</label><select id="p_apiMode"><option value="images">Images API（/v1/images）</option><option value="responses">Responses API（/v1/responses）</option></select></div>
    </div>
    <label>输出根目录</label><input id="outputDir" placeholder="默认 ~/.dsh/gpt-image/output"/>
    <button class="act" onclick="saveProfile()">保存配置档</button>
    <button class="ghost" onclick="testProfile()">测试连通</button>
    <button class="ghost" onclick="saveOutput()">保存输出目录</button>
    <button class="ghost" onclick="exportConfig()">导出 Playground 配置</button>
    <button class="ghost" onclick="importConfig()">导入配置(粘贴到下方)</button>
    <pre id="log">就绪。</pre>
  </div>
  <div class="card">
    <h3>导入/导出（与 GPT Image Playground 的 gpt-image-config.json 兼容）</h3>
    <textarea id="cfg" placeholder='{"customProviders":[],"profiles":[{"id":"x","provider":"openai","baseUrl":"https://.../v1","apiKey":"sk-...","model":"gpt-image-2"}]}'></textarea>
    <button class="act" onclick="importConfig()">导入上面的 JSON</button>
  </div>
  <div class="card"><h3>当前状态（密钥打码）</h3><pre id="state"></pre></div>
</section>

<script>
var state = { records: [], profiles: [] }
function show(n){
  ;['gallery','check','approval','cross','config'].forEach(function(k){
    document.getElementById('pane-'+k).style.display = k===n ? '' : 'none'
    document.getElementById('tab-'+k).className = k===n ? 'on' : ''
  })
  if (n==='config') refresh()
  if (n==='check') runCheck()
  if (n==='approval') loadApprovals()
  if (n==='cross') loadCross()
}

async function loadApprovals(){
  var r = await api('approvals')
  document.getElementById('approvalThreshold').value = r.threshold
  document.getElementById('approvalBadge').textContent = r.pending ? '(' + r.pending + ')' : ''
  var items = r.items || []
  document.getElementById('approvalList').innerHTML = items.length ? items.map(function(it){
    var cls = it.status === 'pending' ? 'warn' : it.status === 'approved' ? 'ok' : 'bad'
    return '<div class="prof"><b>'+esc(it.action)+' · '+esc(it.project||'未命名')+'</b> <span class="'+cls+'">'+esc(it.status)+'</span>'+(it.stale?' <span class="warn">超过24h没处理</span>':'')
      +'<div class="muted">要花 '+it.cost+' '+esc(it.currency)+'（'+it.images+' 张）｜单号 '+esc(it.token)+'</div>'
      +(it.purpose?'<div class="muted">用途：'+esc(it.purpose)+'</div>':'')
      +(it.names&&it.names.length?'<div class="muted">画什么：'+esc(it.names.slice(0,10).join('、'))+'</div>':'')
      +(it.impact_files&&it.impact_files.length?'<div class="muted">影响范围：'+esc(it.impact_files.join('、'))+'</div>':'')
      +(it.status==='pending'
        ? '<button class="act" onclick="decideApproval(\''+it.token+'\',\'approve\')">批准</button><button class="ghost" onclick="decideApproval(\''+it.token+'\',\'reject\')">驳回</button>'
        : '<div class="muted">'+(it.decidedAt||'').replace('T',' ').slice(0,19)+' 由 '+esc(it.decidedBy||'-')+' 处理</div>')
      +'</div>'
  }).join('') : '<div class="muted">没有待批准的单子。</div>'
}
async function decideApproval(token, decision){
  var r = await api(decision, { token: token })
  log(r.ok ? (decision==='approve' ? '已批准 '+token+'：把这串作为 approved_token 传给对应工具即可执行。' : '已驳回 '+token) : r)
  await loadApprovals()
}
async function saveThreshold(){
  var r = await api('approval-threshold', { threshold: Number(document.getElementById('approvalThreshold').value) })
  log('审批阈值已设为 '+r.threshold+' 元')
  await loadApprovals()
}
async function loadCross(){
  var r = await api('cross-style')
  var html = '<div class="prof"><b>'+esc(r.warning||'')+'</b></div>'
  html += (r.projects||[]).map(function(p){
    return '<div class="prof">'+esc(p.project)+' <span class="muted">'+p.samples+' 张 · 主色 '+esc(p.dominant)+' · '+esc(p.label)+'</span></div>'
  }).join('')
  html += (r.pairs||[]).map(function(pair){
    var cls = pair.similarity < 0.35 ? 'bad' : pair.similarity < 0.6 ? 'warn' : 'ok'
    return '<div class="prof">'+esc(pair.a)+' ↔ '+esc(pair.b)+' <span class="'+cls+'">'+pair.similarity+'</span><div class="muted">'+esc(pair.verdict)+'</div></div>'
  }).join('')
  document.getElementById('crossResult').innerHTML = html
}
function log(m, cls){ var el=document.getElementById('log'); el.className=cls||''; el.textContent = typeof m==='string'?m:JSON.stringify(m,null,2) }
function esc(s){ return String(s==null?'':s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c]}) }
function api(p, body){ return fetch('/gpt-image/api/'+p, body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}).then(function(r){return r.json()}) }
function fileUrl(p){ return '/gpt-image/api/file?path='+encodeURIComponent(p) }
// 缩略图：格子一律用它。原图动辄 1MB，一屏 200 个格子就是 140MB+，
// 而浏览器同域只有 6 个并发连接 —— 这就是"加载慢、有时干脆不加载"的原因。
function thumbUrl(p,w){ return '/gpt-image/api/thumb?w='+(w||220)+'&path='+encodeURIComponent(p) }

async function loadGallery(){
  var data = await api('images')
  state.records = data.records||[]
  document.getElementById('stats').textContent = '共 '+data.stats.total+' 次 · 成功 '+data.stats.ok+' · 失败 '+data.stats.failed+' · 图片 '+data.stats.images+' 张'
  renderGallery()
}
/** 余额条：本地闸门（真实生效）+ 上游账户（能查到多少算多少，占位额度不当余额）。 */
async function loadBalance(){
  var el = document.getElementById('balanceBar')
  if(!el) return
  var b = await api('balance')
  if(!b || !b.ok){ el.className='balbar bad'; el.innerHTML='<span class="t">余额不可用</span><span class="k">读不到 /api/balance（插件没启用或还没重启 DSH）</span>'; return }
  var cur = b.currency||'CNY'
  var t = b.today||{}
  var tone = b.state==='exhausted'?'bad':(b.state==='tight'?'warn':(b.state==='disabled'?'':'ok'))
  var pct = t.used_pct===null?0:Math.min(100,t.used_pct||0)
  var barCls = 'bar'+(b.state==='exhausted'?' bad':(b.state==='tight'?' warn':''))
  var parts = []
  parts.push('<span class="t '+(tone||'')+'">'+esc(b.state==='free'?'免费档':(b.state==='exhausted'?'预算用尽':(b.state==='tight'?'预算吃紧':(b.state==='disabled'?'总闸已关':'额度充足'))))+'</span>')
  parts.push('<span class="k">配置档</span> '+esc(b.active_profile||'-')+' <span class="k">单价</span> '+(b.price_per_image===0?'免费':esc(String(b.price_per_image))+' '+esc(cur)))
  parts.push('<span class="k">今日</span> '+esc(String(t.cost||0))+' / '+esc(String(t.budget||'-'))+' '+esc(cur)
    + (t.used_pct===null?'':' <span class="'+barCls+'"><i style="width:'+pct+'%"></i></span> '+pct+'%'))
  parts.push('<span class="k">今日</span> '+esc(String(t.images||0))+' 张')
  if(b.images_affordable_today!==null && b.images_affordable_today!==undefined) parts.push('<span class="k">还能出</span> 约 '+esc(String(b.images_affordable_today))+' 张')
  var r = b.remote
  if(r && r.ok){
    parts.push('<span class="k">上游</span> '+(r.balance_available? ('余额 '+esc(String(r.remaining_usd))+' USD') : '无真实余额（免费/内部额度）'))
  } else if(r){ parts.push('<span class="k">上游</span> '+esc(r.error||'查不到')) }
  el.className = 'balbar '+(tone||'')
  el.innerHTML = parts.join(' <span class="k">｜</span> ')
}
function renderGallery(){
  var q=(document.getElementById('filter').value||'').toLowerCase()
  var items = state.records.filter(function(r){ return !q || ((r.project||'')+' '+(r.name||'')+' '+(r.prompt||'')).toLowerCase().indexOf(q)>=0 })
  document.getElementById('wall').innerHTML = items.length ? items.map(function(r){
    var f=(r.files&&r.files[0])?r.files[0]:''
    var img = f ? '<img loading="lazy" decoding="async" src="'+thumbUrl(f)+'"/>' : '<div style="height:190px;display:flex;align-items:center;justify-content:center" class="muted">无图</div>'
    return '<div class="tile">'+img+'<div class="meta">'
      +'<div class="name">'+esc(r.project)+' / '+esc(r.name)+'</div>'
      +'<div class="chips"><span>'+esc(r.provider||'')+'</span><span>'+esc(r.model||'')+'</span><span>'+(r.params&&r.params.size||'')+'</span><span>'+(r.params&&r.params.quality||'')+'</span><span>'+(r.ms?((r.ms/1000).toFixed(1)+'s'):'')+'</span><span class="'+(r.status==='ok'?'ok':r.status==='pending'?'warn':'bad')+'">'+esc(r.status)+'</span></div>'
      +'<div class="prompt">'+esc(r.prompt||'')+'</div>'
      +(r.error?'<div class="bad">'+esc(r.error)+'</div>':'')
      +'</div></div>'
  }).join('') : '<div class="muted">还没有出图记录。让 AI 调 generate，或用工具页配置好再试。</div>'
}
async function refresh(){
  var data = await api('state')
  if(!data.ok){ log(data); return }
  state.profiles = data.config.profiles||[]
  var opts = (data.providers||[]).map(function(p){ return '<option value="'+p.id+'">'+esc(p.id)+' — '+esc(p.name)+'</option>' }).join('')
  document.getElementById('p_provider').innerHTML = opts
  document.getElementById('outputDir').value = data.config.outputDir||''
  document.getElementById('profiles').innerHTML = state.profiles.map(function(p){
    return '<div class="prof '+(p.id===data.config.activeProfileId?'on':'')+'">'
      +'<b>'+esc(p.name||p.id)+'</b> <span class="muted">'+esc(p.id)+'</span>'
      +'<div class="muted">'+esc(p.provider)+' · '+esc(p.baseUrl)+' · '+esc(p.model)+' · '+(p.apiKey||'(无 Key)')+(p.apiMode?' · '+esc(p.apiMode):'')+'</div>'
      +'<button class="ghost" onclick="loadProfile(\\''+p.id+'\\')">载入</button>'
      +'<button class="ghost" onclick="setActive(\\''+p.id+'\\')">设为激活</button>'
      +'<button class="ghost" onclick="removeProfile(\\''+p.id+'\\')">删除</button>'
      +'</div>'
  }).join('')
  document.getElementById('state').textContent = JSON.stringify({activeProfileId:data.config.activeProfileId, outputDir:data.config.outputDir, providers:data.providers, customProviders:data.config.customProviders}, null, 2)
  return data
}
function loadProfile(id){
  var p = state.profiles.filter(function(x){return x.id===id})[0]; if(!p) return
  document.getElementById('p_id').value=p.id; document.getElementById('p_name').value=p.name||''
  document.getElementById('p_provider').value=p.provider||'openai'
  document.getElementById('p_baseUrl').value=p.baseUrl||''; document.getElementById('p_apiKey').value=''
  document.getElementById('p_model').value=p.model||''; document.getElementById('p_apiMode').value=p.apiMode||'images'
  log('已载入配置档 '+id+'（Key 留空表示不修改）')
}
async function saveProfile(){
  var v=function(id){return document.getElementById(id).value.trim()}
  var profile={id:v('p_id'),name:v('p_name')||v('p_id'),provider:v('p_provider'),baseUrl:v('p_baseUrl'),model:v('p_model'),apiMode:v('p_apiMode')}
  if(v('p_apiKey')) profile.apiKey=v('p_apiKey')
  var r=await api('profile',{profile:profile}); log(r.ok?'已保存':r); if(r.ok) await refresh()
}
async function setActive(id){ log(await api('active',{id:id})); await refresh() }
async function removeProfile(id){ log(await api('remove',{id:id})); await refresh() }
async function saveOutput(){ log(await api('output',{output_dir:document.getElementById('outputDir').value.trim()})); await refresh() }
async function testProfile(){
  var id=document.getElementById('p_id').value.trim()
  log('测试中…'); log(await api('test', id?{id:id}:{}))
}
async function exportConfig(){ var r=await api('export'); document.getElementById('cfg').value=JSON.stringify(r.config,null,2); log('已导出到下方文本框，可复制保存为 gpt-image-config.json') }

var VERDICT = { ok:['ok','达标'], broken:['bad','用不上'], mismatch:['warn','规格不符'], 'not-referenced':['warn','没被引用'], 'unknown-spec':['muted','无规格'] }
async function loadProjects(){
  var r = await api('check')
  var list = r.projects || []
  var sel = document.getElementById('checkProject')
  var cur = sel.value
  sel.innerHTML = list.map(function(p){ return '<option value="'+esc(p)+'">'+esc(p)+'</option>' }).join('') || '<option value="">（还没有产出）</option>'
  if (cur && list.indexOf(cur)>=0) sel.value = cur
  if (r.game_root && !document.getElementById('gameRoot').value) document.getElementById('gameRoot').value = r.game_root
  return r
}
async function runCheck(){
  var project = document.getElementById('checkProject').value
  var root = document.getElementById('gameRoot').value.trim()
  var r = await loadProjects()
  project = project || document.getElementById('checkProject').value
  var data = await api('check?project='+encodeURIComponent(project||'')+'&root='+encodeURIComponent(root))
  if(!data.ok){ document.getElementById('checkTable').innerHTML=''; document.getElementById('checkLog').textContent=JSON.stringify(data); return }
  if(data.note){ document.getElementById('checkTable').innerHTML=''; document.getElementById('checkSummary').textContent=data.note; return }
  var s = data.summary||{}
  document.getElementById('checkSummary').innerHTML = '共 '+data.generated+' 张 ｜ <span class="ok">达标 '+(s.ok||0)+'</span> ｜ <span class="bad">用不上 '+(s.broken||0)+'</span> ｜ <span class="warn">规格不符 '+(s.mismatch||0)+'</span> ｜ <span class="warn">没被引用 '+(s['not-referenced']||0)+'</span> ｜ <span class="muted">无规格 '+(s['unknown-spec']||0)+'</span>'
  document.getElementById('checkLog').textContent = data.hint || ''
  document.getElementById('checkTable').innerHTML = (data.items||[]).map(function(it){
    var v = VERDICT[it.verdict] || ['muted', it.verdict]
    var refs = (it.referencedBy||[]).map(function(x){ return esc(x.file) }).join('<br>') || '<span class="muted">无</span>'
    var exp = it.expected ? (esc(it.expected.size||'')+(it.expected.transparent?' 透明':'')+(it.expected.tileable?' 可平铺':'')) : '<span class="muted">清单里没有</span>'
    return '<div class="prof"><b>'+esc(it.key)+'</b> <span class="'+v[0]+'">'+esc(v[1])+'</span>'
      +'<div class="muted">文件 '+esc(it.file)+'</div>'
      +'<div class="muted">实际 '+esc(it.size)+' · '+(it.hasAlphaChannel?'有透明通道':'无透明通道')+' · '+Math.round((it.bytes||0)/1024)+'KB ｜ 要求 '+exp+'</div>'
      +'<div class="muted">被引用：'+refs+'</div>'
      +((it.problems||[]).length? '<div class="bad">'+it.problems.map(esc).join('<br>')+'</div>' : '')
      +'</div>'
  }).join('') || '<div class="muted">没有问题可核对。</div>'
}
async function saveGameRoot(){
  var r = await api('game-root',{ root: document.getElementById('gameRoot').value.trim(), project: document.getElementById('checkProject').value })
  document.getElementById('checkLog').textContent = r.ok ? '已保存游戏目录，刷新后仍然记得。' : JSON.stringify(r)
  await loadProjects()
}
async function runScan(){
  var root = document.getElementById('gameRoot').value.trim()
  log('体检中…')
  var data = await api('scan?root='+encodeURIComponent(root))
  document.getElementById('checkLog').textContent = JSON.stringify({
    conclusion: data.conclusion,
    genres: data.genres,
    missing_referenced: (data.missing_referenced||[]).map(function(m){ return m.ref }),
    suggested: (data.suggested||[]).slice(0,12).map(function(s){ return s.name+' — '+s.prompt_hint }),
    notes: data.notes,
  }, null, 2)
}
async function importConfig(){
  var text=document.getElementById('cfg').value.trim(); if(!text){ log('先把配置 JSON 粘到文本框里','bad'); return }
  var payload; try{ payload=JSON.parse(text) }catch(e){ log('JSON 解析失败：'+e.message,'bad'); return }
  log(await api('import',{payload:payload})); await refresh()
}
loadGallery(); refresh(); loadBalance(); setInterval(loadBalance, 30000)
</script>
</main></body></html>`
}

/**
 * 每个项目的概况：几台图、最近什么时候出的、最近几个素材名、核对结论分布。
 * 用途：让「哪个项目是哪个」一眼可见（面板/侧栏的项目卡片直接显示这些数字）。
 */
export function projectSummaries(records = []) {
  const out = {}
  for (const record of records) {
    const key = record.project || 'images'
    const bucket = (out[key] ??= {
      count: 0,
      ok: 0,
      failed: 0,
      labeled: 0,
      latest: '',
      latest_name: '',
      names: [],
      kinds: [],
    })
    bucket.count += 1
    if (record.status === 'ok') bucket.ok += 1
    else if (record.status === 'failed') bucket.failed += 1
    if (Array.isArray(record.labeled) && record.labeled.length > 0) bucket.labeled += 1
    const ts = String(record.ts ?? record.updatedAt ?? '')
    if (ts > bucket.latest) {
      bucket.latest = ts
      bucket.latest_name = String(record.name ?? '')
    }
    if (record.name && bucket.names.length < 5 && !bucket.names.includes(record.name)) bucket.names.push(record.name)
    const kind = String(record.kind ?? '')
    if (kind && bucket.kinds.length < 5 && !bucket.kinds.includes(kind)) bucket.kinds.push(kind)
  }
  for (const bucket of Object.values(out)) {
    bucket.latest_text = bucket.latest ? bucket.latest.replace('T', ' ').slice(0, 16) : ''
  }
  return out
}

function handlerFor(config) {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const sub = url.pathname.replace(/^\/gpt-image/, '') || '/'
    try {
      const profiles = await ProfileStore.load(config.dataDir)
      if (config.outputDir) profiles.data.outputDir = config.outputDir
      const gallery = await Gallery.load(config.dataDir)

      if (sub === '/' || sub === '') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return res.end(pageHtml())
      }

      if (req.method === 'GET' && sub === '/api/assets') {
        // 磁盘索引：输出目录里**所有**图（含不是本插件生成的），带审核状态
        const catalog = await AssetCatalog.load(profiles.dataDir)
        const project = url.searchParams.get('project') ?? ''
        const kind = url.searchParams.get('kind') ?? ''
        const state = url.searchParams.get('state') ?? ''
        const result = await scanCached({ outputDir: profiles.outputDir, catalog, gallery, project })
        let files = result.files
        if (kind) files = files.filter((item) => item.kind === kind)
        if (state) files = files.filter((item) => item.review_state === state)
        // 队列是派生数据：每次都由"当前结论 + 磁盘内容"重算，不会和实际脱节
        const queue = catalog.recomputeQueue({ files: result.files })
        return sendJson(res, 200, {
          ...result,
          files: files.slice(0, Math.max(1, Number(url.searchParams.get('limit') ?? 500))),
          filtered_total: files.length,
          review_stats: catalog.stats(),
          queue: { needs_install: queue.needsInstall.length, needs_review: queue.needsReview.length, needs_re_review: queue.needsReReview.length },
          queue_files: { needs_review: queue.needsReview.slice(0, 50), needs_re_review: queue.needsReReview.slice(0, 50) },
        })
      }

      if (req.method === 'GET' && sub === '/api/changes') {
        // 变化摘要（prompt 1）：和上次快照 diff。默认**不写**快照（只读），
        // 带 save=1 才推进基线 —— 否则每轮轮询都会把变化"吃掉"。
        const catalog = await AssetCatalog.load(profiles.dataDir)
        const project = url.searchParams.get('project') ?? ''
        const scan = await scanCached({ outputDir: profiles.outputDir, catalog, gallery, project })
        const previous = await Snapshot.load(profiles.dataDir)
        const diff = await diffSnapshot({ files: scan.files, previous })
        if (url.searchParams.get('save') === '1') {
          await previous.save(scan.files)
        }
        return sendJson(res, 200, {
          ...diff,
          // 结论失效单独报：它比"内容变化"更严重（要重审）
          invalidated: catalog.recomputeQueue({ files: scan.files }).needsReReview.length,
          baseline_taken_at: previous.data.takenAt,
        })
      }

      if (req.method === 'GET' && sub === '/api/compare') {
        // 审核对比视图（prompt 2）：四格并排，切片预览**实时算、不写盘**
        const target = resolveInside(url.searchParams.get('path') ?? '', [profiles.outputDir])
        if (!target) return sendJson(res, 403, { ok: false, error: '只允许读取输出目录内的文件' })
        const catalog = await AssetCatalog.load(profiles.dataDir)
        const project = path.basename(path.dirname(target)) === path.basename(profiles.outputDir)
          ? '' : path.basename(path.dirname(target))
        const scan = await scanCached({ outputDir: profiles.outputDir, catalog, gallery, project })
        const entry = scan.files.find((item) => normalizePath(item.file) === normalizePath(target))
        if (!entry) return sendJson(res, 404, { ok: false, error: '不在素材目录里' })
        const { expectations } = await readExpectations(url.searchParams.get('root') ?? profiles.data.gameRoot ?? '').catch(() => ({ expectations: {} }))
        // 相邻帧：同项目同目录的源图，按名字排序（判断连贯性用）
        const siblings = scan.files
          .filter((item) => item.project === entry.project && item.kind === entry.kind && path.dirname(item.file) === path.dirname(entry.file))
          .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'))
          .map((item) => item.file)
        const result = await buildCompare({
          file: entry.file,
          name: entry.name,
          kind: entry.kind,
          expected: expectations[entry.name] ?? null,
          siblings,
        })
        return sendJson(res, 200, {
          ...result,
          review: catalog.reviewOf({ file: entry.file, name: entry.name }) ?? { state: 'unreviewed' },
          rule: sliceRuleFor({ name: entry.name, kind: entry.kind, expected: expectations[entry.name] ?? null }),
        })
      }

      if (req.method === 'GET' && sub === '/api/reprocess') {
        // 批量重处理规划（prompt 3）：GET = dry-run，只看不动
        const project = url.searchParams.get('project') ?? ''
        const catalog = await AssetCatalog.load(profiles.dataDir)
        const scan = await scanCached({ outputDir: profiles.outputDir, catalog, gallery, project })
        const { expectations } = await readExpectations(url.searchParams.get('root') ?? profiles.data.gameRoot ?? '').catch(() => ({ expectations: {} }))
        const plan = planReprocess({
          files: scan.files,
          catalog,
          expectations,
          slices: url.searchParams.get('slices') !== '0',
          scaled: url.searchParams.get('scaled') === '1',
        })
        return sendJson(res, 200, {
          ok: true,
          dry_run: true,
          summary: plan.summary,
          text: plan.text,
          affected: plan.to_reprocess.map((item) => item.name),
          skipped_unreviewed: plan.skipped_unreviewed.length,
          invalidated: plan.invalidated,
          orphans: plan.orphans.length,
        })
      }

      if (req.method === 'GET' && sub === '/api/auto') {
        // 自动化总览：一个接口把「现在什么情况、该做什么」说清（给 UI 用，避免前端拼多次请求）
        const catalog = await AssetCatalog.load(profiles.dataDir)
        const scan = await scanCached({ outputDir: profiles.outputDir, catalog, gallery, project: url.searchParams.get('project') ?? '' })
        const queue = catalog.recomputeQueue({ files: scan.files })
        const pipeline = await PipelineConfig.load(profiles.dataDir)
        const validation = pipeline.validate()
        const runState = await readJson(path.join(profiles.dataDir, 'pipeline-run.json'), null)
        const backups = await listBackups({ dataDir: profiles.dataDir })
        const reviewLog = await readJson(path.join(profiles.dataDir, 'review-log.json'), null)
        const undoable = (reviewLog?.entries ?? []).filter((e) => !e.undone && e.count > 0).slice(0, 20)

        // 自愈规划（只读，不改任何东西）
        const { sliceRuleFor: ruleFor } = await import('./assets.js')
        for (const f of scan.files) {
          f.asset_kind = classifyAsset({ file: f.file, name: f.name }).kind
          f.slice_rule = ruleFor({ name: f.name, kind: f.kind, observedSlices: f.observedSlices })
        }
        const { expectations } = await readExpectations(profiles.data.gameRoot ?? '').catch(() => ({ expectations: {} }))
        const orphans = planOrphanCleanup({ files: scan.files, catalog })
        const dangling = planDanglingVerdicts({ files: scan.files, catalog })
        const missing = planMissingRepair({ files: scan.files, catalog, expectations })

        const reviews = Object.values(catalog.data.reviews ?? {})
        const history = {
          approved: reviews.filter((r) => r.state === 'approved').length,
          rejected: reviews.filter((r) => r.state === 'rejected').length,
        }
        const alerts = checkAlerts({
          metrics: {
            unreviewed_ratio: (scan.tally?.total ?? 0) > 0 ? (scan.tally?.unreviewed ?? 0) / scan.tally.total : 0,
            queue_backlog: queue.needsReview.length,
          },
        })

        return sendJson(res, 200, {
          ok: true,
          pipeline: {
            name: pipeline.data.name,
            steps: (pipeline.data.steps ?? []).map((s) => s.id ?? s.use),
            valid: validation.ok,
            errors: validation.errors,
            last_run: runState ? { batch_id: runState.batchId, at: runState.at, failed_at: runState.failedAt ?? null, completed: Boolean(runState.completed) } : null,
            status: pipelineStatus({ pipeline, runState, scan }),
          },
          queue: {
            needs_install: queue.needsInstall.length,
            needs_review: queue.needsReview.length,
            needs_re_review: queue.needsReReview.length,
            samples: { needs_review: queue.needsReview.slice(0, 5), needs_re_review: queue.needsReReview.slice(0, 5) },
          },
          selfheal: {
            orphans: orphans.summary.total,
            orphan_detail: orphans.derived_orphans.slice(0, 10),
            dangling_reviews: dangling.summary.invalidated,
            missing: missing.summary.total,
            missing_detail: missing.needs.slice(0, 10),
            risk: orphans.risk,
          },
          alerts,
          history,
          policy: { confidence_approve: DEFAULT_POLICY.confidence_approve, sample_after_approve: DEFAULT_POLICY.sample_after_approve, auto_approve_kinds: DEFAULT_POLICY.auto_approve_kinds, never_auto_approve: DEFAULT_POLICY.never_auto_approve },
          cold_start: (history.approved + history.rejected) < DEFAULT_POLICY.min_history,
          undoable: undoable.map((e) => ({ batch_id: e.batch_id, at: e.at, by: e.by, action: e.action, count: e.count, note: e.note })),
          backups: backups.items.slice(0, 10),
          maintenance: maintenanceChecklist({ outputDir: profiles.outputDir, dataDir: profiles.dataDir }).tasks,
          roles: Object.keys(DEFAULT_ROLES),
        })
      }

      if (req.method === 'GET' && sub === '/api/pipeline') {
        const pipeline = await PipelineConfig.load(profiles.dataDir)
        return sendJson(res, 200, { ok: true, pipeline: pipeline.data, validation: pipeline.validate(), catalog: STEP_CATALOG })
      }

      if (req.method === 'POST' && sub === '/api/pipeline') {
        // 保存流水线配置（YAML 或 JSON 文本）
        const body = await readJsonBody(req)
        const parsed = PipelineConfig.parse(body.text ?? '')
        if (!parsed.ok) return sendJson(res, 400, parsed)
        const store = new PipelineConfig(path.join(profiles.dataDir, 'pipeline.json'), parsed.data)
        const validation = store.validate()
        if (!validation.ok) return sendJson(res, 400, { ok: false, error: '流水线定义有误，未保存', errors: validation.errors })
        await store.save()
        return sendJson(res, 200, { ok: true, validation, pipeline: store.data })
      }

      if (req.method === 'POST' && sub === '/api/auto-run') {
        // 给 UI 的执行口：分流 / 撤销 / 自愈 / 备份 这几件最常用的。
        // 注意：POST body 的解析在下方统一做（`const body = ...`），
        // 所以这里**延迟读取**（lazy read）而不是直接引用 body —— 否则会
        // "Cannot access 'body' before initialization"（实测踩过）。
        const body = await readJsonBody(req)
        const what = body.what ?? ''
        const catalog = await AssetCatalog.load(profiles.dataDir)
        const scan = await scanCached({ outputDir: profiles.outputDir, catalog, gallery, project: body.project ?? '' })

        if (what === 'backup') {
          return sendJson(res, 200, await createBackup({ dataDir: profiles.dataDir, label: body.label ?? 'ui' }))
        }
        if (what === 'restore') {
          return sendJson(res, 200, await restoreBackup({ dataDir: profiles.dataDir, id: body.id ?? '' }))
        }
        if (what === 'undo') {
          // 批量撤销（UI 里点"撤销"）
          const logPath = path.join(profiles.dataDir, 'review-log.json')
          const raw = await readJson(logPath, null)
          const log = new ReviewLog(logPath, raw && Array.isArray(raw.entries) ? raw : { version: 1, entries: [] })
          const plan = log.planUndo(body.batch_id ?? '')
          if (!plan.ok) return sendJson(res, 400, plan)
          if (body.dry_run) return sendJson(res, 200, { ok: true, dry_run: true, ...plan })
          const inverse = []
          for (const item of plan.restore) {
            const before = catalog.reviewOf({ file: item.file })?.state ?? null
            if (item.state === null) catalog.clear({ files: [item.file] })
            else catalog.mark({ files: [{ path: item.file }], state: item.state, by: 'undo', note: `撤销 ${body.batch_id}` })
            inverse.push({ file: item.file, before, after: item.state })
          }
          log.markUndone(body.batch_id)
          const undoId = `undo_${body.batch_id}_${Date.now().toString(36)}`
          log.record({ batchId: undoId, by: body.by ?? 'user', action: 'undo', changes: inverse, note: `撤销了 ${body.batch_id}` })
          await catalog.save()
          await writeJsonAtomic(logPath, log.data)
          return sendJson(res, 200, { ok: true, undone: plan.restore.length, batch_id: body.batch_id, undo_batch: undoId })
        }
        if (what === 'selfheal') {
          // 自愈执行（孤儿清理；先备份到回收目录）
          const plan = planOrphanCleanup({ files: scan.files, catalog })
          if (body.dry_run) return sendJson(res, 200, { ok: true, dry_run: true, summary: plan.summary, orphans: plan.derived_orphans.slice(0, 20), risk: plan.risk })
          const safety = await createBackup({ dataDir: profiles.dataDir, label: 'before-selfheal' })
          const recycleDir = path.join(profiles.dataDir, 'recycled', new Date().toISOString().slice(0, 10))
          const result = await applyOrphanCleanup({ plan, catalog, recycleDir })
          await catalog.save()
          return sendJson(res, 200, { ok: true, ...result, safety_backup: safety.id ?? null, plan_summary: plan.summary })
        }
        if (what === 'route') {
          // 自动分流（默认 dry-run；确认后写结论 + 留撤销日志）
          const routePolicy = { ...DEFAULT_POLICY, ...(body.policy ?? {}) }
          const reviews = Object.values(catalog.data.reviews ?? {})
          const history = {
            approved: reviews.filter((r) => r.state === 'approved').length,
            rejected: reviews.filter((r) => r.state === 'rejected').length,
          }
          const pool = scan.files.filter((f) => (f.review_state ?? 'unreviewed') === 'unreviewed' && f.kind === 'source').slice(0, Number(body.limit ?? 50))
          // 算事实
          const computed = []
          const { styleFingerprint } = await import('./stylefp.js')
          const { scoreAsset } = await import('./semantics.js')
          const { readabilityAtSize } = await import('./coherence.js')
          const { decodePngRgba: decodePng } = await import('./pngcodec.js')
          for (const entry of pool) {
            const buffer = await readFile(entry.file).catch(() => null)
            if (!buffer) continue
            const decoded = decodePng(buffer)
            let fp = null
            try { fp = styleFingerprint(buffer) } catch { /* 忽略 */ }
            const score = scoreAsset({ buffer, fingerprint: fp })
            const read = decoded ? readabilityAtSize({ buffer, targetWidth: Math.min(64, decoded.width), targetHeight: Math.min(64, decoded.height) }) : null
            computed.push({
              name: entry.name,
              file: entry.file,
              kind: classifyAsset({ file: entry.file, name: entry.name }).kind,
              facts: {
                kind: classifyAsset({ file: entry.file, name: entry.name }).kind,
                size: decoded ? { width: decoded.width, height: decoded.height } : null,
                palette: { drift: 0 },
                dup: { similarity: 0 },
                quality: { score: score.score },
                readability: { level: read?.level ?? 'unknown' },
              },
            })
          }
          const routed = applyPolicy({ policy: routePolicy, items: computed, history })
          if (body.dry_run) {
            return sendJson(res, 200, {
              ok: true, dry_run: true,
              summary: routed.summary,
              auto_approve: routed.auto_approve.slice(0, 20).map((r) => ({ name: r.name, confidence: r.confidence, reasons: r.reasons })),
              auto_reject: routed.auto_reject.slice(0, 20).map((r) => ({ name: r.name, confidence: r.confidence, reasons: r.reasons })),
              sampled: routed.sampled.slice(0, 20).map((r) => ({ name: r.name })),
              policy_blocked: routed.policy_blocked.slice(0, 20).map((r) => ({ name: r.name, why: r.policy_block })),
              cold_start: routed.cold_start ?? false,
              advice: routed.advice,
            })
          }
          // 执行
          const logPath = path.join(profiles.dataDir, 'review-log.json')
          const raw = await readJson(logPath, null)
          const log = new ReviewLog(logPath, raw && Array.isArray(raw.entries) ? raw : { version: 1, entries: [] })
          const batchId = body.batch_id ?? `auto_${Date.now().toString(36)}`
          const changes = []
          for (const item of [...routed.auto_approve, ...routed.sampled]) {
            const before = catalog.reviewOf({ file: item.file, name: item.name })?.state ?? null
            catalog.mark({ files: [{ path: item.file, name: item.name }], state: 'approved', note: item.sampled ? '自动通过（抽查复核）' : '自动通过', by: 'auto' })
            changes.push({ file: item.file, before, after: 'approved' })
          }
          for (const item of routed.auto_reject) {
            const before = catalog.reviewOf({ file: item.file, name: item.name })?.state ?? null
            catalog.mark({ files: [{ path: item.file, name: item.name }], state: 'rejected', note: (item.reasons ?? []).join('；') || '自动驳回', by: 'auto' })
            changes.push({ file: item.file, before, after: 'rejected' })
          }
          log.record({ batchId, by: 'auto', action: 'auto_review', changes, note: `自动分流：通过 ${routed.auto_approve.length}，驳回 ${routed.auto_reject.length}` })
          await catalog.save()
          await writeJsonAtomic(logPath, log.data)
          return sendJson(res, 200, { ok: true, applied: true, batch_id: batchId, changed: changes.length, summary: routed.summary, undo_hint: `批量撤销：${batchId}` })
        }
        return sendJson(res, 400, { ok: false, error: `未知的自动操作：${what}` })
      }

      if (req.method === 'GET' && sub === '/api/health') {
        // I1 健康度 + I3 漏斗合并（UI 一页看全）
        const catalog = await AssetCatalog.load(profiles.dataDir)
        const scan = await scanCached({ outputDir: profiles.outputDir, catalog, gallery, project: url.searchParams.get('project') ?? '' })
        const queue = catalog.recomputeQueue({ files: scan.files })
        const records = gallery.list({ limit: 1000 }) ?? []
        const generated = records.reduce((s, r) => s + (r.images ?? 0), 0)
        const reviews = Object.values(catalog.data.reviews ?? {})
        const points = reviews.map((r) => ({ date: r.at, approved: r.state === 'approved' ? 1 : 0, rejected: r.state === 'rejected' ? 1 : 0 }))
        return sendJson(res, 200, {
          ok: true,
          health: healthDashboard({ scan, reviewStats: catalog.stats(), orphans: 0 }),
          queue: { needs_install: queue.needsInstall.length, needs_review: queue.needsReview.length, needs_re_review: queue.needsReReview.length },
          funnel: pipelineFunnel({
            generated,
            reviewed: (scan.tally?.approved ?? 0) + (scan.tally?.rejected ?? 0) + (scan.tally?.pending ?? 0),
            approved: scan.tally?.approved ?? 0,
            installed: scan.files.filter((f) => f.review_state === 'approved').length,
          }),
          trend: trending({ points }),
          history: {
            approved: reviews.filter((r) => r.state === 'approved').length,
            rejected: reviews.filter((r) => r.state === 'rejected').length,
            min_history: DEFAULT_POLICY.min_history,
          },
        })
      }

      if (req.method === 'GET' && sub === '/api/balance') {
        // 余额/花费面板：本地闸门（真实生效）+ 上游账户计费（能查到多少算多少）
        const spend = await SpendLedger.load(profiles.dataDir)
        const pool = await DemandPool.load(profiles.dataDir)
        const remote = url.searchParams.get('remote')
        const report = await buildBalanceReport({
          profiles,
          spend,
          pool,
          gallery,
          profileId: url.searchParams.get('profile') ?? '',
          // 默认查远端；带 remote=0 只看本地（面板轮询时省一次外网请求）
          checkRemote: remote !== '0',
          timeoutMs: 10000,
        })
        return sendJson(res, 200, report)
      }

      if (req.method === 'GET' && sub === '/api/state') {
        const providers = Object.entries(BUILTIN_PROVIDERS).map(([id, definition]) => ({
          id, name: definition.name, kind: 'builtin', ...providerCapabilities(normalizeProvider({ id })),
        }))
        for (const custom of profiles.data.customProviders) {
          providers.push({ id: custom.id, name: custom.name ?? custom.id, kind: 'custom', ...providerCapabilities(normalizeProvider(custom)) })
        }
        return sendJson(res, 200, {
          ok: true,
          config: profiles.masked(),
          providers,
          data_dir: profiles.dataDir,
          gallery: gallery.stats(),
        })
      }

      if (req.method === 'GET' && sub === '/api/images') {
        // 预览优先用「画面内带名字」的 labeled 图（硬规定产物）；干净图仍在 files 里，给游戏用
        // **音频记录必须排除**：这里的每条都会被渲染成 <img src=...>，
        // 把 .wav 塞进去就是一个坏图标。音频有自己的一页（/api/audio-recent）。
        // limit 可调：面板默认只要一屏多一点，剩下的靠"加载更多"
        const limit = Math.min(500, Math.max(20, Number(url.searchParams.get('limit') ?? 120) || 120))
        const records = gallery.list({ limit })
          .filter((record) => record.media !== 'audio')
          .map((record) => ({
            ...record,
            preview: (record.labeled ?? [])[0] ?? (record.files ?? [])[0] ?? '',
          }))
        return sendJson(res, 200, { ok: true, stats: gallery.stats(), records })
      }

      if (req.method === 'GET' && sub === '/api/audio-recent') {
        // 生音频页的「最近生成」：只返回音频记录，每条带可直接播放的 URL
        const limit = Math.min(60, Math.max(1, Number(url.searchParams.get('limit') ?? 12) || 12))
        const records = gallery.list({ limit: 400 })
          .filter((record) => record.media === 'audio')
          .slice(0, limit)
          .map((record) => ({
            id: record.id,
            name: record.name,
            project: record.project,
            action: record.audio_action ?? record.params?.action ?? '',
            ts: record.ts,
            seconds: record.params?.seconds ?? null,
            files: record.files ?? [],
            url: record.files?.[0] ? `/gpt-image/api/file?path=${encodeURIComponent(record.files[0])}` : '',
          }))
        return sendJson(res, 200, { ok: true, count: records.length, records })
      }

      if (req.method === 'GET' && sub === '/api/check') {
        const project = url.searchParams.get('project') || profiles.data.lastProject || ''
        const root = url.searchParams.get('root') || profiles.data.gameRoot || ''
        const records = gallery.list({ limit: 500 })
        const projects = [...new Set(records.map((record) => record.project).filter(Boolean))]
          .sort((a, b) => String(a).localeCompare(String(b), 'zh-Hans-CN'))
        // 没选项目时也要能把「哪个项目是哪个」显示出来 → 给出每个项目的概况
        if (!project) {
          return sendJson(res, 200, {
            ok: true,
            project: '',
            items: [],
            summary: null,
            note: '还没选项目（上面点一个项目卡片即可）',
            game_root: root,
            projects,
            project_summaries: projectSummaries(records),
          })
        }
        const result = await checkProject({ root, outputDir: profiles.outputDir, project })
        return sendJson(res, 200, {
          ...result,
          game_root: root,
          projects,
          project_summaries: projectSummaries(records),
        })
      }

      if (req.method === 'GET' && sub === '/api/approvals') {
        const queue = await ApprovalQueue.load(profiles.dataDir)
        return sendJson(res, 200, {
          ok: true,
          threshold: queue.threshold,
          items: queue.list({ status: url.searchParams.get('status') ?? '' }),
          pending: queue.pending().length,
        })
      }

      if (req.method === 'GET' && sub === '/api/cross-style') {
        const result = await buildProjectProfiles({ outputDir: profiles.outputDir, dataDir: profiles.dataDir })
        return sendJson(res, 200, result)
      }

      if (req.method === 'GET' && sub === '/api/scan') {
        const root = url.searchParams.get('root') || profiles.data.gameRoot || ''
        const project = url.searchParams.get('project') || profiles.data.lastProject || ''
        const result = await scanGame({ root, brief: url.searchParams.get('brief') || '', project, outputDir: profiles.outputDir })
        return sendJson(res, 200, result)
      }

      /* 缩略图：面板里所有格子都用它，而不是原图。
       * 原图 700KB~2MB × 200 个格子 = 140MB+，浏览器同域只有 6 并发 → 又慢又"有时不加载"。
       * 缩略图约 10~45KB，并且带 immutable 缓存头，第二次几乎瞬间。 */
      if (req.method === 'GET' && sub === '/api/thumb') {
        const candidate = resolveInside(url.searchParams.get('path') ?? '', [profiles.outputDir, profiles.dataDir])
        if (!candidate) return sendJson(res, 403, { ok: false, error: '只允许读取输出目录/数据目录内的文件' })
        const width = Number(url.searchParams.get('w') ?? 200) || 200
        const thumb = await getThumbnail({ file: candidate, dataDir: profiles.dataDir, maxWidth: width })
        if (!thumb.ok) {
          // 缩不出来就别砸整个面板：退回原图（占位也行，但至少能显示）
          return sendJson(res, 200, { ok: false, error: thumb.error, fallback: `/gpt-image/api/file?path=${encodeURIComponent(candidate)}` })
        }
        res.writeHead(200, {
          'content-type': 'image/png',
          // 内容由「原图路径 + mtime + 宽度」决定，所以可以长期缓存
          'cache-control': 'public, max-age=31536000, immutable',
          'x-thumb-cached': thumb.cached ? '1' : '0',
        })
        return res.end(thumb.buffer)
      }

      if (req.method === 'GET' && sub === '/api/file') {
        const candidate = resolveInside(url.searchParams.get('path') ?? '', [profiles.outputDir, profiles.dataDir])
        if (!candidate) return sendJson(res, 403, { ok: false, error: '只允许读取输出目录/数据目录内的文件' })
        try {
          const buffer = await readFile(candidate)
          // 素材文件基本不再改（改了会用新文件名），给个短缓存省掉重复下载；
          // 之前是 no-cache，导致每次刷新都把 140MB 重新拉一遍
          const info = await stat(candidate).catch(() => null)
          res.writeHead(200, {
            'content-type': MIME[path.extname(candidate).toLowerCase()] ?? 'application/octet-stream',
            'cache-control': 'public, max-age=3600',
            ...(info ? { 'last-modified': new Date(info.mtimeMs).toUTCString() } : {}),
          })
          return res.end(buffer)
        } catch (error) {
          return sendJson(res, 404, { ok: false, error: `读不到文件：${error.message}` })
        }
      }

      if (req.method !== 'POST') return sendJson(res, 404, { ok: false, error: `未知路由 ${req.method} /gpt-image${sub}` })
      if (!isSameOrigin(req)) return sendJson(res, 403, { ok: false, error: '跨站请求被拒绝（同源栅栏）' })
      const body = await readJsonBody(req)

      if (sub === '/api/profile') {
        const incoming = body.profile
        if (!incoming?.id) return sendJson(res, 400, { ok: false, error: '需要 profile.id' })
        if (incoming.apiKey && /^\*+$/.test(incoming.apiKey)) delete incoming.apiKey
        if (incoming.baseUrl) incoming.baseUrl = String(incoming.baseUrl).replace(/\/+$/, '')
        profiles.upsert(incoming)
        await profiles.save()
        return sendJson(res, 200, { ok: true, config: profiles.masked() })
      }
      if (sub === '/api/active') {
        const ok = profiles.setActive(body.id)
        await profiles.save()
        return sendJson(res, 200, { ok, active: profiles.active?.id })
      }
      if (sub === '/api/remove') {
        const ok = profiles.remove(body.id)
        await profiles.save()
        return sendJson(res, 200, { ok, active: profiles.active?.id })
      }
      if (sub === '/api/output') {
        profiles.data.outputDir = String(body.output_dir ?? '')
        await profiles.save()
        return sendJson(res, 200, { ok: true, outputDir: profiles.outputDir })
      }
      if (sub === '/api/approve' || sub === '/api/reject') {
        const queue = await ApprovalQueue.load(profiles.dataDir)
        const result = queue.decide(body.token, sub === '/api/approve' ? 'approve' : 'reject', { by: 'panel' })
        if (result.ok) await queue.save()
        return sendJson(res, 200, { ...result, pending: queue.pending().length })
      }
      if (sub === '/api/approval-threshold') {
        const queue = await ApprovalQueue.load(profiles.dataDir)
        queue.data.threshold = Number(body.threshold ?? queue.threshold)
        await queue.save()
        return sendJson(res, 200, { ok: true, threshold: queue.threshold })
      }
      if (sub === '/api/reprocess') {
        // 执行批量重处理（prompt 3）。先拿锁：reprocess 和 install 不能同时改同一批文件。
        const lock = await acquireLock(profiles.dataDir, 'reprocess')
        if (!lock.ok) return sendJson(res, 409, { ok: false, error: lock.error })
        try {
          const catalog = await AssetCatalog.load(profiles.dataDir)
          const project = body.project ?? ''
          const scan = await scanCached({ outputDir: profiles.outputDir, catalog, gallery, project })
          const { expectations } = await readExpectations(body.root ?? profiles.data.gameRoot ?? '').catch(() => ({ expectations: {} }))
          const plan = planReprocess({
            files: scan.files,
            catalog,
            expectations,
            slices: body.slices !== false,
            scaled: body.scaled === true,
          })
          if (body.dry_run) {
            return sendJson(res, 200, { ok: true, dry_run: true, summary: plan.summary, text: plan.text, invalidated: plan.invalidated, orphans: plan.orphans.length })
          }
          // 真正执行：切片用 computeSlices（与预览同一套计算，保证所见即所得）
          const result = await runReprocess({
            root: path.join(profiles.outputDir, project || ''),
            files: scan.files,
            catalog,
            expectations,
            plan,
            sliceFn: async ({ file, name, rule, outDir }) => {
              const decoded = decodePngRgba(await readFile(file))
              if (!decoded) return { ok: false, error: '解不开（只支持 8bit 非隔行 PNG）' }
              const size = expectations[name]?.size
              const computed = computeSlices({
                decoded,
                items: Array.from({ length: rule.columns * rule.rows }, (_, i) => ({
                  name: `${name}_${String(i + 1).padStart(2, '0')}`,
                  width: size?.width ?? 0, height: size?.height ?? 0,
                })),
                columns: rule.columns,
                rows: rule.rows,
                trim: true,
                targetWidth: size?.width ?? 0,
                targetHeight: size?.height ?? 0,
                encode: true,
              })
              if (!computed.ok) return { ok: false, error: computed.error }
              const { writeFile: writePng } = await import('node:fs/promises')
              const files = []
              for (const slice of computed.slices) {
                const out = path.join(outDir, `${slice.name}.png`)
                await writePng(out, slice.png)
                files.push(out)
              }
              return { ok: true, files, warnings: computed.warnings }
            },
          })
          // 重切完进 needsInstall，重算队列并落盘
          const after = await scanCached({ outputDir: profiles.outputDir, catalog, gallery, project })
          catalog.recomputeQueue({ files: after.files })
          await catalog.save()
          return sendJson(res, 200, { ...result, queue: catalog.queueReport() })
        } finally {
          await lock.release?.()
        }
      }

      if (sub === '/api/webhook') {
        // L2：外部脚本上报（带路径/批次/来源）→ 自动触发处理
        const parsed = parseWebhook(body ?? {})
        if (!parsed.ok) return sendJson(res, 400, parsed)
        const catalog = await AssetCatalog.load(profiles.dataDir)
        // 写进来源登记（H2）—— 自己上报的归属是**精确的**，不用按目录+日期猜
        const log = await ProvenanceLog.load(profiles.dataDir)
        log.recordBatch({
          batchId: parsed.event.batchId,
          writer: parsed.event.writer,
          when: parsed.event.when,
          files: parsed.event.files,
          note: parsed.event.note || 'webhook 上报',
        })
        await log.save()
        // 看看这些文件在不在素材目录里，以及状态
        const scan = await scanCached({ outputDir: profiles.outputDir, catalog, gallery, project: parsed.event.project ?? '' })
        const known = new Map(scan.files.map((f) => [String(f.file).replace(/\\/g, '/').toLowerCase(), f]))
        const matched = []
        const unknownFiles = []
        for (const file of parsed.event.files) {
          const hit = known.get(String(file).replace(/\\/g, '/').toLowerCase())
          if (hit) matched.push({ file, name: hit.name, kind: hit.kind, review: hit.review_state })
          else unknownFiles.push(file)
        }
        const queue = catalog.recomputeQueue({ files: scan.files })
        await catalog.save()
        return sendJson(res, 200, {
          ok: true,
          received: parsed.event.files.length,
          matched: matched.length,
          unknown: unknownFiles.length,
          unknown_files: unknownFiles.slice(0, 20),
          writer: parsed.event.writer,
          batch_id: parsed.event.batchId,
          queue: { needs_install: queue.needsInstall.length, needs_review: queue.needsReview.length, needs_re_review: queue.needsReReview.length },
          note: unknownFiles.length > 0
            ? `有 ${unknownFiles.length} 个文件不在素材目录里 —— 可能写到了别处，或还没落盘完（防抖）。`
            : '全部文件都在素材目录里，已并入待审队列。',
          next: '跑 auto action=selfheal-plan 看有没有要处理的；或等定时任务统一处理。',
        })
      }

      if (sub === '/api/review') {
        // 人工审核：合格 / 不合格 / 待定。支持按文件路径或按素材名（重画后结论可继承）
        const catalog = await AssetCatalog.load(profiles.dataDir)
        // contentHash 一并记下：这是「结论失效」能被发现的前提
        const files = (Array.isArray(body.files) ? body.files : []).map((item) => {
          if (typeof item === 'string') return { path: item, name: assetNameOf(item) }
          return item
        })
        const result = catalog.mark({
          files,
          names: Array.isArray(body.names) ? body.names : [],
          state: body.state,
          note: body.note ?? '',
          by: body.by ?? 'user',
          scope: body.scope === 'name' ? 'name' : 'file',
        })
        if (!result.ok) return sendJson(res, 400, result)
        await catalog.save()
        // 审核一变，队列就要跟着变（标合格 → 进 needsInstall；标不合格 → 出队）
        const scan = await scanCached({ outputDir: profiles.outputDir, catalog, gallery, project: body.project ?? '' })
        const queue = catalog.recomputeQueue({ files: scan.files })
        await catalog.save()
        return sendJson(res, 200, {
          ...result,
          stats: catalog.stats(),
          queue: {
            needs_install: queue.needsInstall.length,
            needs_review: queue.needsReview.length,
            needs_re_review: queue.needsReReview.length,
          },
        })
      }

      if (sub === '/api/review-clear') {
        const catalog = await AssetCatalog.load(profiles.dataDir)
        const result = catalog.clear({ files: body.files ?? [], names: body.names ?? [] })
        await catalog.save()
        return sendJson(res, 200, { ...result, stats: catalog.stats() })
      }

      if (sub === '/api/upload') {
        // 面板「导入图片」：浏览器发的 multipart，存到本地磁盘，然后换公网 URL。
        // 两步分开是为了把「文件收下来了」和「传出去了」讲清楚 —— 只报一句成功等于没说。
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' })
        const raw = await readRawBody(req)
        if (req.__dshRawTooLarge) return sendJson(res, 413, { ok: false, error: '文件太大（上限 64MB）' })
        const parsed = parseMultipart(raw, req.headers['content-type'])
        if (!parsed.ok) return sendJson(res, 400, { ok: false, error: `解析上传失败：${parsed.error}` })
        const file = firstFile(parsed.parts)
        if (!file) return sendJson(res, 400, { ok: false, error: `没收到文件字段（boundary=${boundaryOf(req.headers['content-type']) || '?'}）` })
        if (file.data.length === 0) return sendJson(res, 400, { ok: false, error: '收到的文件是空的' })

        const safeName = String(file.filename ?? 'upload.bin').replace(/[^\w.\-]+/g, '_').slice(-120) || 'upload.bin'
        const uploadDir = path.join(profiles.dataDir, 'uploads')
        await mkdir(uploadDir, { recursive: true })
        const stored = path.join(uploadDir, `${Date.now().toString(36)}_${safeName}`)
        await writeFile(stored, file.data)

        const wantPublic = String(fieldValue(parsed.parts, 'public') ?? 'true') !== 'false'
        if (!wantPublic) {
          return sendJson(res, 200, { ok: true, stored, bytes: file.data.length, name: safeName, public: false })
        }
        const health = profiles.data.uploadHealth ?? (profiles.data.uploadHealth = {})
        const resolved = await resolvePublicUrl(stored, {
          maxBytes: 64 * 1024 * 1024,
          publicBaseUrl: profiles.data.publicBaseUrl ?? '',
          endpoint: profiles.data.uploadEndpoint ?? '',
          field: profiles.data.uploadField ?? 'file',
          timeoutMs: profiles.data.uploadTimeoutMs,
          health,
        })
        await profiles.save()
        if (!resolved.ok) {
          // 文件已经落在本地了，所以即使传不出去也不是白忙 —— 把本地路径一起给回去
          return sendJson(res, 200, {
            ok: false, stored, bytes: file.data.length, name: safeName,
            error: resolved.error, hint: resolved.hint, tried_hosts: resolved.tried_hosts,
          })
        }
        return sendJson(res, 200, {
          ok: true,
          stored,
          bytes: file.data.length,
          name: safeName,
          url: resolved.url,
          via: resolved.via,
          host: resolved.hostName ?? resolved.host,
          ttl_minutes: resolved.ttlMinutes ?? 0,
        })
      }

      if (sub === '/api/video') {
        // 面板的「生成视频」按钮走这里：提交异步视频任务并（按需）等结果。
        // 配置档不强制用户指定：面板可能没传，或者传的是出图档 —— 自己解析成视频档。
        const resolved = resolveVideoProfile(profiles, body.profile)
        if (!resolved.profile) {
          return sendJson(res, 400, {
            ok: false,
            error: `找不到可用的视频配置档${body.profile ? `（${body.profile} 不是视频服务商）` : ''}。`,
            hint: '需要 provider 为 "agnes-video" 的配置档；已配 Agnes 图片档（同 baseUrl / Key）时会自动派生。',
            profile_reason: resolved.reason,
            available_profiles: resolved.candidates,
          })
        }
        if (resolved.profile.derived && !profiles.get(resolved.profile.id)) {
          profiles.upsert(resolved.profile)
          await profiles.save()
        }
        const gallery = await Gallery.load(profiles.dataDir)
        const result = await runVideo({
          profiles,
          gallery,
          settings: {
            outputDir: profiles.outputDir,
            timeoutMs: profiles.timeoutMs,
            dataDir: profiles.dataDir,
            // 本地素材换公网 URL 用（见 lib/upload.js）
            publicBaseUrl: profiles.data.publicBaseUrl ?? '',
            uploadEndpoint: profiles.data.uploadEndpoint ?? '',
            uploadField: profiles.data.uploadField ?? 'file',
            uploadTimeoutMs: profiles.data.uploadTimeoutMs,
          },
          args: {
            prompt: body.prompt,
            profile: resolved.profile.id,
            seconds: body.seconds,
            mode: body.mode,
            aspect_ratio: body.aspect_ratio,
            first_frame: body.first_frame,
            last_frame: body.last_frame,
            images: body.images,
            audios: body.audios,
            upload: body.upload,
            seed: body.seed,
            project: body.project,
            name: body.name,
            wait_s: body.wait_s,
          },
        })
        await gallery.save()
        // 上传健康记录（哪些图床刚失败过）跟着 profiles 一起存，下次少等超时
        if ((result.assets ?? []).length || result.upload_failed) await profiles.save()
        return sendJson(res, 200, {
          ...result,
          profile: resolved.profile.id,
          profile_reason: resolved.reason,
          profile_note: resolved.note,
        })
      }

      if (sub === '/api/audio') {
        // 生音频（桥接本机 VoiceStudio）：面板/脚本都能用同一个口
        const gallery = await Gallery.load(profiles.dataDir)
        const result = await runAudio({
          profiles,
          settings: {
            outputDir: profiles.outputDir,
            timeoutMs: profiles.timeoutMs,
            dataDir: profiles.dataDir,
          },
          args: {
            action: body.action,
            role: body.role,
            script: body.script,
            style: body.style,
            lyrics: body.lyrics,
            duration: body.duration,
            steps: body.steps,
            title: body.title,
            song: body.song,
            lang: body.lang,
            job_id: body.job_id,
            project: body.project,
            name: body.name,
            wait_s: body.wait_s,
            autostart: body.autostart,
          },
        })
        if (result.ok && (result.files ?? []).length > 0) {
          for (const file of result.files) {
            gallery.add({
              kind: 'audio', media: 'audio', model: 'voicestudio', profile: '',
              name: path.basename(file, path.extname(file)),
              project: result.project, prompt: String(body.script ?? body.style ?? '').slice(0, 200),
              params: { action: result.action, role: result.role?.id, job_id: result.job_id },
              status: 'ok', images: 0, files: [file], audio_action: result.action,
            })
          }
          await gallery.save()
        }
        return sendJson(res, 200, result)
      }

      if (sub === '/api/pixelize') {
        /* 单个素材像素化（核对页的「像素化」按钮）。
         * 铁律：**绝不覆盖原图** —— 另存 `<名字>.pixel.png`。
         * 原图是花钱买来的，后处理写坏了就找不回来了。
         *
         * 注意 pixelizePng 的签名是 pixelizePng({ buffer, options }) 且**同步**、不碰磁盘 ——
         * 写文件这一步在这里做（原来写成 pixelizePng(source, {...output}) 是错的，会直接报错）。 */
        const file = resolveInside(String(body.path ?? ''), [profiles.outputDir, profiles.dataDir])
        if (!file) return sendJson(res, 403, { ok: false, error: '只允许处理输出目录/数据目录内的文件' })
        const options = {
          /* 按钮的默认输出：**保持原尺寸**（最近邻放回），而不是逻辑分辨率。
           * 为什么：auto 检测出来可能是 8×8，直接给 8×8 的 93 字节小图，
           * 点按钮的人会以为"处理坏了"；而放回原尺寸是**整块等大、无抗锯齿**的真像素外观，
           * 端到端看起来才"对"。要原始逻辑分辨率就传 output='logical'。 */
          output: body.output ? String(body.output) : 'origin',
        }
        if (body.width) options.logicalWidth = Number(body.width)
        if (body.height) options.logicalHeight = Number(body.height)
        if (body.palette !== undefined) options.palette = Number(body.palette)
        if (body.method) options.method = String(body.method)
        const source = await readFile(file).catch(() => null)
        if (!source) return sendJson(res, 200, { ok: false, error: `读不到文件：${file}` })
        let result
        try {
          result = pixelizePng({ buffer: source, options })
        } catch (error) {
          return sendJson(res, 200, { ok: false, error: `像素化异常：${error?.message ?? error}` })
        }
        if (!result?.ok) return sendJson(res, 200, { ok: false, error: result?.error ?? '像素化失败', ...pickPixelMeta(result) })
        const base = path.basename(file, path.extname(file))
        const output = path.join(path.dirname(file), `${base}.pixel.png`)
        await writeFile(output, result.buffer)
        return sendJson(res, 200, {
          ...pickPixelMeta(result),
          ok: true,
          source: file,
          output,
          note: `已生成 ${path.basename(output)}（原图未改动）`,
        })
      }

      if (req.method === 'GET' && sub === '/api/rig-preview') {
        /* 直接吐出预览器 HTML（text/html）。
         * 为什么要这个路由：预览器是自包含单文件，`file://` 双击也能开，
         * 但面板里要给「点开预览」的链接就必须走 http，
         * 否则浏览器会当成下载、或被 file:// 的跨源限制挡住。
         * 只允许读 输出目录/数据目录 下的 .html。 */
        const candidate = resolveInside(url.searchParams.get('path') ?? '', [profiles.outputDir, profiles.dataDir])
        if (!candidate || path.extname(candidate).toLowerCase() !== '.html') {
          return sendJson(res, 403, { ok: false, error: '只允许读取输出目录/数据目录内的 .html' })
        }
        const html = await readFile(candidate, 'utf8').catch(() => null)
        if (!html) return sendJson(res, 404, { ok: false, error: `读不到 ${candidate}` })
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
        return res.end(html)
      }

      if (sub === '/api/game-root') {
        profiles.data.gameRoot = String(body.root ?? '')
        if (body.project !== undefined) profiles.data.lastProject = String(body.project ?? '')
        await profiles.save()
        return sendJson(res, 200, { ok: true, gameRoot: profiles.data.gameRoot, lastProject: profiles.data.lastProject })
      }
      if (sub === '/api/import') {
        const result = profiles.importPlaygroundConfig(body.payload)
        if (result.ok) await profiles.save()
        return sendJson(res, 200, result)
      }
      if (sub === '/api/export') {
        return sendJson(res, 200, { ok: true, config: profiles.exportPlaygroundConfig() })
      }
      if (sub === '/api/test') {
        const profile = profiles.get(body.id)
        if (!profile) return sendJson(res, 400, { ok: false, error: '找不到配置档' })
        const provider = resolveProvider(profiles, profile)
        const result = await probe({ profile, provider })
        return sendJson(res, 200, { ok: Boolean(result.ok), profile: profile.id, model: profile.model, probe: result })
      }
      return sendJson(res, 404, { ok: false, error: `未知路由 POST /gpt-image${sub}` })
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
    }
  }
}

export function attachPanel(ctx, config) {
  const attach = (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'prefix',
      path: '/gpt-image',
      handler: handlerFor(config ?? {}),
    }), `${PLUGIN_NAME}: panel`)
    // 合并后只保留一个插件：旧链接 /asset-forge 直接跳到出图台，不再有两个入口
    scope.effect(() => scope.webServer.register({
      kind: 'prefix',
      path: '/asset-forge',
      handler: (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const rest = url.pathname.replace(/^\/asset-forge/, '') || '/'
        const target = `/gpt-image${rest === '/' ? '' : rest}${url.search}`
        res.writeHead(302, { location: target })
        res.end()
      },
    }), `${PLUGIN_NAME}: /asset-forge 别名`)
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], attach)
    return
  }
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (webServer && typeof webServer.register === 'function') attach(ctx)
}
