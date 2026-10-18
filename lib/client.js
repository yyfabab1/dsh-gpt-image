/**
 * 客户端半边（合并后只剩这一个生图插件）：
 *   1) 左侧栏多一个「生图」图标 → 点开是**主区域整页**的项目生图画廊（最显眼、一直在）
 *   2) 对话/轨迹那一行也保留一个「生图」按钮 → 浮层看同一份内容
 * 画廊里每条都带**核对结果**：尺寸/透明底对不对、是不是空图、游戏代码里有没有引用它。
 */
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-gpt-image',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')
    const inject = ['slots']

    const API = '/gpt-image/api'

    const styles = `
.dshimg-chips-row{display:flex;gap:8px;flex-wrap:wrap;width:100%;margin-top:6px}
.dshimg-chip{display:flex;flex-direction:column;align-items:flex-start;gap:1px;cursor:pointer;font:inherit;
  background:var(--theme-input-bg,#80808014);color:inherit;border:1px solid var(--theme-border,#80808040);
  border-radius:9px;padding:5px 10px;line-height:1.25;max-width:220px}
.dshimg-chip:hover{border-color:var(--theme-accent,#4a9eff)}
.dshimg-chip.on{background:var(--theme-accent,#4a9eff);border-color:var(--theme-accent,#4a9eff);color:#fff}
.dshimg-chip-name{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px}
.dshimg-chip-sub{font-size:10.5px;opacity:.75}
.dshimg-vrow{display:flex;gap:6px;flex-wrap:wrap;width:100%;margin-top:4px}
.dshimg-vchip{font:inherit;font-size:11px;cursor:pointer;background:transparent;color:inherit;
  border:1px solid var(--theme-border,#80808040);border-radius:999px;padding:3px 10px}
.dshimg-vchip:hover{border-color:var(--theme-accent,#4a9eff)}
.dshimg-vchip.on{background:var(--theme-accent,#4a9eff);border-color:var(--theme-accent,#4a9eff);color:#fff}
.dshimg-vchip.bad{border-color:#f87171;color:#f87171}
.dshimg-vchip.warn{border-color:#fbbf24;color:#fbbf24}
.dshimg-vchip.ok{border-color:#4ade80;color:#4ade80}
.dshimg-vchip.bad.on,.dshimg-vchip.warn.on,.dshimg-vchip.ok.on{color:#fff}
.dshimg-btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12px;line-height:1;cursor:pointer;
  background:var(--theme-input-bg,#80808014);color:inherit;border:1px solid var(--theme-border,#80808040);
  border-radius:8px;padding:6px 10px;white-space:nowrap}
.dshimg-btn:hover{border-color:var(--theme-accent,#4a9eff)}
.dshimg-btn .dot{width:6px;height:6px;border-radius:50%;background:var(--theme-accent,#4a9eff)}
.dshimg-ov{position:fixed;inset:0;z-index:9999;background:rgba(6,8,12,.72);display:flex;align-items:center;justify-content:center;padding:24px}
.dshimg-panel{width:min(1180px,96vw);height:min(86vh,940px);display:flex;flex-direction:column;overflow:hidden;
  background:var(--theme-bg,#14161c);color:var(--theme-fg,#e6e8ee);border:1px solid var(--theme-border,#2c3340);
  border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.45);font:13px/1.55 ui-sans-serif,system-ui,sans-serif}
.dshimg-page{display:flex;flex-direction:column;height:100%;min-height:0;color:inherit;
  font:13px/1.55 ui-sans-serif,system-ui,sans-serif}
.dshimg-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--theme-border,#2c3340);flex-wrap:wrap}
.dshimg-title{font-weight:600;font-size:14px;margin-right:auto}
.dshimg-head select,.dshimg-head input{font:inherit;font-size:12px;color:inherit;background:var(--theme-input-bg,#80808014);
  border:1px solid var(--theme-border,#80808059);border-radius:8px;padding:5px 8px}
.dshimg-head input.dshimg-wide{min-width:280px}
.dshimg-x{font:inherit;cursor:pointer;background:transparent;border:1px solid var(--theme-border,#80808059);
  color:inherit;border-radius:8px;padding:5px 10px}
.dshimg-body{flex:1;overflow:auto;padding:14px;min-height:0}
.dshimg-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px}
.dshimg-card{border:1px solid var(--theme-border,#2c3340);border-radius:10px;overflow:hidden;background:var(--theme-input-bg,#8080800d)}
.dshimg-card img{width:100%;height:176px;object-fit:contain;background:repeating-conic-gradient(#2a2f3a 0% 25%, #20242c 0% 50%) 50%/16px 16px;display:block;cursor:zoom-in}
.dshimg-nothumb{height:176px;display:flex;align-items:center;justify-content:center;opacity:.6}
.dshimg-meta{padding:8px;font-size:12px}
.dshimg-name{font-weight:600;word-break:break-all;margin-bottom:2px}
.dshimg-chips span{display:inline-block;border:1px solid var(--theme-border,#80808040);border-radius:999px;
  padding:0 7px;margin:2px 4px 0 0;font-size:11px;opacity:.9}
.dshimg-chips span.bad{border-color:#f87171;color:#f87171}
.dshimg-chips span.warn{border-color:#fbbf24;color:#fbbf24}
.dshimg-chips span.ok{border-color:#4ade80;color:#4ade80}
.dshimg-prompt{margin-top:6px;font:11px/1.45 ui-monospace,Consolas,monospace;opacity:.82;max-height:78px;overflow:auto;
  background:rgba(0,0,0,.22);border-radius:6px;padding:6px;word-break:break-word}
.dshimg-problems{margin-top:6px;color:#f87171;font-size:11px}
.dshimg-empty{opacity:.75;text-align:center;padding:60px 20px}
.dshimg-err{color:#f87171;font-size:12px;padding:6px 0}
.dshimg-foot{display:flex;gap:12px;align-items:center;padding:10px 14px;border-top:1px solid var(--theme-border,#2c3340);font-size:12px;opacity:.9;flex-wrap:wrap}
.dshimg-foot a{color:inherit;text-decoration:underline}
.dshimg-sum{font-size:12px;opacity:.9}
.dshimg-sum b.ok{color:#4ade80}.dshimg-sum b.bad{color:#f87171}.dshimg-sum b.warn{color:#fbbf24}
.dshimg-btn .dot.alt{background:#f59e0b}
.dshvid-panel{width:min(880px,96vw);height:min(88vh,900px)}
.dshvid-form{display:flex;flex-direction:column;gap:10px}
.dshvid-field{display:flex;flex-direction:column;gap:4px;font-size:12px;flex:1;min-width:120px}
.dshvid-field>span{opacity:.8}
.dshvid-field input,.dshvid-field select,.dshvid-field textarea{font:inherit;font-size:12px;color:inherit;
  background:var(--theme-input-bg,#80808014);border:1px solid var(--theme-border,#80808059);border-radius:8px;padding:6px 8px}
.dshvid-prompt{min-height:74px;resize:vertical;font-family:ui-monospace,Consolas,monospace}
.dshvid-row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
.dshvid-note{font-size:11.5px;opacity:.72;flex:1}
.dshvid-go{font-weight:600}
.dshvid-go[disabled]{opacity:.55;cursor:default}
.dshvid-log{white-space:pre-wrap;background:rgba(0,0,0,.22);border:1px solid var(--theme-border,#80808040);
  border-radius:8px;padding:10px;font-size:12px;max-height:150px;overflow:auto;margin-top:12px}
.dshvid-results{display:flex;flex-direction:column;gap:8px;margin-top:12px}
.dshvid-card{border:1px solid var(--theme-border,#2c3340);border-radius:10px;padding:10px;background:var(--theme-input-bg,#8080800d)}
.dshvid-link{display:inline-block;margin-right:10px;color:var(--theme-accent,#4a9eff);text-decoration:underline}
.dshvid-task{font:11px/1.5 ui-monospace,Consolas,monospace;opacity:.7;margin-top:4px}
.dshvid-import{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px dashed var(--theme-border,#80808050);border-radius:8px}
.dshvid-file{flex:1;min-width:180px;font:inherit;font-size:12px;color:inherit}
.dshvid-materials{display:flex;flex-wrap:wrap;gap:6px}
.dshvid-chip{font-size:11px;padding:2px 8px;border-radius:999px;background:rgba(74,158,255,.16);border:1px solid rgba(74,158,255,.35)}
.dshvid-chip-bad{background:rgba(255,170,60,.16);border-color:rgba(255,170,60,.45)}
.dshvid-library{display:flex;flex-wrap:wrap;gap:6px;max-height:150px;overflow:auto}
.dshvid-thumb{padding:0;border:1px solid var(--theme-border,#80808050);border-radius:6px;background:none;cursor:pointer;overflow:hidden;line-height:0}
.dshvid-thumb img{width:60px;height:60px;object-fit:cover;display:block}
.dshvid-thumb:hover{border-color:var(--theme-accent,#4a9eff)}
.dshbal-btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12px;line-height:1;cursor:pointer;
  background:var(--theme-input-bg,#80808014);color:inherit;border:1px solid var(--theme-border,#80808040);
  border-radius:8px;padding:6px 10px;white-space:nowrap}
.dshbal-btn:hover{border-color:var(--theme-accent,#4a9eff)}
.dshbal-btn.tone-ok{border-color:#4ade80}.dshbal-btn.tone-warn{border-color:#fbbf24}.dshbal-btn.tone-bad{border-color:#f87171}
.dshbal-btn .amt{font-weight:600}
.dshbal-bar{width:40px;height:4px;border-radius:2px;background:var(--theme-border,#80808040);overflow:hidden;display:inline-block}
.dshbal-bar i{display:block;height:100%;background:#4ade80}
.dshbal-bar.warn i{background:#fbbf24}.dshbal-bar.bad i{background:#f87171}
.dshbal-panel{width:min(760px,96vw);height:min(86vh,860px)}
.dshbal-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.dshbal-card{border:1px solid var(--theme-border,#2c3340);border-radius:10px;padding:10px 12px;background:var(--theme-input-bg,#8080800d)}
.dshbal-card .k{font-size:11px;opacity:.7;margin-bottom:3px}
.dshbal-card .v{font-size:17px;font-weight:600;line-height:1.25}
.dshbal-card .s{font-size:11px;opacity:.65;margin-top:2px}
.dshbal-card.ok .v{color:#4ade80}.dshbal-card.warn .v{color:#fbbf24}.dshbal-card.bad .v{color:#f87171}
.dshbal-sect{margin-top:16px}
.dshbal-sect>h4{margin:0 0 8px;font-size:13px;font-weight:600;opacity:.9}
.dshbal-table{width:100%;border-collapse:collapse;font-size:12px}
.dshbal-table th,.dshbal-table td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--theme-border,#2c334055)}
.dshbal-table th{opacity:.65;font-weight:500}
.dshbal-table tr.on{background:var(--theme-input-bg,#80808014)}
.dshbal-advice{margin-top:12px;padding:10px 12px;border-radius:8px;font-size:12.5px;line-height:1.6;
  border:1px solid var(--theme-border,#80808040);background:var(--theme-input-bg,#8080800d)}
.dshbal-advice.ok{border-color:#4ade8066}.dshbal-advice.warn{border-color:#fbbf2466}.dshbal-advice.bad{border-color:#f8717166}
.dshbal-muted{opacity:.7;font-size:12px}
/* 素材审核：勾选 + 批量拍板 */
.dshrev-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 14px;
  border-bottom:1px solid var(--theme-border,#2c3340);background:var(--theme-input-bg,#8080800d);font-size:12px}
.dshrev-bar .sp{flex:1}
.dshrev-btn{font:inherit;font-size:12px;cursor:pointer;background:transparent;color:inherit;
  border:1px solid var(--theme-border,#80808059);border-radius:8px;padding:4px 10px;white-space:nowrap}
.dshrev-btn:hover{border-color:var(--theme-accent,#4a9eff)}
.dshrev-btn.ok{border-color:#4ade80;color:#4ade80}
.dshrev-btn.bad{border-color:#f87171;color:#f87171}
.dshrev-btn.warn{border-color:#fbbf24;color:#fbbf24}
.dshrev-btn[disabled]{opacity:.45;cursor:default}
.dshrev-count{font-weight:600}
.dshimg-card.sel{outline:2px solid var(--theme-accent,#4a9eff);outline-offset:-2px}
.dshimg-pick{position:absolute;top:6px;left:6px;width:18px;height:18px;cursor:pointer;z-index:3;
  accent-color:var(--theme-accent,#4a9eff)}
.dshimg-thumbwrap{position:relative}
.dshimg-compare{position:absolute;bottom:6px;left:6px;z-index:3;font:11px/1 ui-sans-serif,system-ui,sans-serif;
  cursor:pointer;padding:3px 8px;border-radius:6px;color:#fff;border:1px solid rgba(255,255,255,.3);
  background:rgba(74,158,255,.85)}
.dshimg-compare:hover{background:rgba(74,158,255,1)}
.dshrev-badge{position:absolute;top:6px;right:6px;font-size:10.5px;padding:1px 6px;border-radius:999px;
  border:1px solid var(--theme-border,#80808059);background:rgba(0,0,0,.55);z-index:2}
.dshrev-badge.approved{border-color:#4ade80;color:#4ade80}
.dshrev-badge.rejected{border-color:#f87171;color:#f87171}
.dshrev-badge.pending{border-color:#fbbf24;color:#fbbf24}
.dshrev-badge.external{border-color:#a78bfa;color:#a78bfa}
.dshrev-legend{opacity:.72;font-size:11.5px}
.dshrev-legend b{font-weight:600}
/* 变化摘要横幅（prompt 1） */
.dshchg{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:8px 14px;font-size:12px;
  border-bottom:1px solid var(--theme-border,#2c3340)}
.dshchg.has{background:linear-gradient(90deg,rgba(74,158,255,.12),transparent)}
.dshchg .t{font-weight:600}
.dshchg .n{font-weight:600}
.dshchg .n.add{color:#4ade80}.dshchg .n.del{color:#f87171}.dshchg .n.chg{color:#fbbf24}.dshchg .n.inv{color:#a78bfa}
.dshchg-bar{height:3px;background:var(--theme-accent,#4a9eff);border-radius:2px;transition:width .2s}
/* 对比视图（prompt 2） */
.dshcmp-panel{width:min(1200px,97vw);height:min(92vh,980px)}
.dshcmp-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.dshcmp-cell{border:1px solid var(--theme-border,#2c3340);border-radius:10px;padding:8px;background:var(--theme-input-bg,#8080800d)}
.dshcmp-cell .h{font-size:12px;font-weight:600;margin-bottom:4px;display:flex;justify-content:space-between;gap:8px}
.dshcmp-cell .d{font-size:11px;opacity:.7;margin-bottom:6px}
.dshcmp-cell img{max-width:100%;max-height:30vh;display:block;margin:0 auto;background:repeating-conic-gradient(#2a2f3a 0% 25%, #20242c 0% 50%) 50%/16px 16px;border-radius:6px;cursor:zoom-in}
.dshcmp-cells{display:flex;flex-wrap:wrap;gap:6px;max-height:30vh;overflow:auto}
.dshcmp-cells img{max-height:88px;max-width:none;margin:0}
.dshcmp-none{opacity:.55;font-size:12px;padding:16px;text-align:center}
.dshcmp-slider{display:flex;align-items:center;gap:8px;font-size:12px;margin-top:10px}
.dshcmp-slider input{flex:1}
.dshcmp-bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:8px 14px;font-size:12px;
  border-bottom:1px solid var(--theme-border,#2c3340)}
.dshcmp-bar .sp{flex:1}
.dshcmp-keys{opacity:.65;font-size:11.5px}
.dshcmp-kbd{display:inline-block;border:1px solid var(--theme-border,#80808059);border-radius:4px;
  padding:0 5px;font:11px ui-monospace,Consolas,monospace;margin:0 2px}
/* 重处理（prompt 3） */
.dshrep-pre{white-space:pre-wrap;background:rgba(0,0,0,.22);border:1px solid var(--theme-border,#80808040);
  border-radius:8px;padding:12px;font-size:12px;max-height:40vh;overflow:auto}
/* 自动化页（L–R 组） */
.dshauto-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}
.dshauto-card{border:1px solid var(--theme-border,#2c3340);border-radius:10px;padding:12px;background:var(--theme-input-bg,#8080800d)}
.dshauto-card h4{margin:0 0 6px;font-size:13px;display:flex;justify-content:space-between;gap:8px;align-items:center}
.dshauto-card .big{font-size:22px;font-weight:700;line-height:1.15}
.dshauto-card .sub{font-size:11.5px;opacity:.72;margin-top:3px}
.dshauto-card.warn{border-color:#fbbf2466}.dshauto-card.bad{border-color:#f8717166}.dshauto-card.ok{border-color:#4ade8066}
.dshauto-kv{display:flex;justify-content:space-between;font-size:12px;padding:3px 0;border-bottom:1px dashed var(--theme-border,#80808030)}
.dshauto-kv:last-child{border-bottom:none}
.dshauto-kv b{font-weight:600}
.dshauto-pill{font-size:11px;border:1px solid var(--theme-border,#80808059);border-radius:999px;padding:1px 7px}
.dshauto-pill.ok{border-color:#4ade80;color:#4ade80}
.dshauto-pill.warn{border-color:#fbbf24;color:#fbbf24}
.dshauto-pill.bad{border-color:#f87171;color:#f87171}
.dshauto-flow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;margin-top:6px}
.dshauto-step{border:1px solid var(--theme-border,#80808059);border-radius:7px;padding:3px 8px}
.dshauto-step.done{border-color:#4ade80;color:#4ade80}
.dshauto-step.failed{border-color:#f87171;color:#f87171}
.dshauto-step.pending{opacity:.6}
.dshauto-arrow{opacity:.45}
.dshauto-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.dshauto-list{font-size:12px;margin-top:8px;max-height:200px;overflow:auto}
.dshauto-list div{padding:2px 0;border-bottom:1px dashed var(--theme-border,#80808025)}
.dshauto-log{white-space:pre-wrap;font:11.5px/1.5 ui-monospace,Consolas,monospace;background:rgba(0,0,0,.22);
  border:1px solid var(--theme-border,#80808040);border-radius:8px;padding:10px;margin-top:12px;max-height:240px;overflow:auto}
`

    function jget(path) {
      return fetch(path, { headers: { accept: 'application/json' } })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null)
    }

    function jpost(path, body) {
      return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
        .then((response) => response.json().catch(() => ({})))
        .catch((error) => ({ ok: false, error: String(error?.message ?? error) }))
    }

    const VERDICT = {
      ok: ['ok', '达标'],
      broken: ['bad', '用不上'],
      mismatch: ['warn', '规格不符'],
      'not-referenced': ['warn', '没被引用'],
      'unknown-spec': ['', '无规格'],
    }

    /** 一份数据源：出图历史 + 磁盘素材目录 + 核对结果 + 勾选/对比/变化 状态。 */
    function useGallery() {
      const [state, setState] = React.useState({ records: [], assets: [], tally: null, byKind: null, reviewStats: null, queue: null, check: {}, items: [], summary: null, projects: [], gameRoot: '', loading: true, error: '' })
      const [project, setProject] = React.useState('')
      const [verdict, setVerdict] = React.useState('')
      const [assetKind, setAssetKind] = React.useState('')
      const [reviewFilter, setReviewFilter] = React.useState('')
      const [gameRoot, setGameRoot] = React.useState('')
      const [tick, setTick] = React.useState(0)
      const [selected, setSelected] = React.useState(() => new Set())
      const [compareFile, setCompareFile] = React.useState('')
      const [changeFilter, setChangeFilter] = React.useState('')
      const [changeFiles, setChangeFiles] = React.useState(null)
      const restoredRef = React.useRef(false)      // 「上次选的项目」只自动恢复一次
      const userEditedRootRef = React.useRef(false) // 用户手动改过目录后就不再自动覆盖

      // 勾选 / 对比：一件勾选、批量拍板、进对比视图都走这里，避免各组件各存一份状态
      const sel = {
        has: (file) => selected.has(file),
        size: selected.size,
        toggle: (file, on) => setSelected((prev) => {
          const next = new Set(prev)
          if (on) next.add(file); else next.delete(file)
          return next
        }),
        setAll: (files) => setSelected(new Set(files)),
        clear: () => setSelected(new Set()),
        compare: (file) => setCompareFile(file),
      }

      // 只依赖 project / tick 重新拉数据；gameRoot 是受控输入，绝不能进依赖（否则每敲一个字就重建定时器）
      React.useEffect(() => {
        let alive = true
        const load = () => {
          Promise.all([
            jget(API + '/images'),
            jget(API + '/check' + (project ? '?project=' + encodeURIComponent(project) : '')),
            // 磁盘素材目录：这是"大量素材只在文件夹里"的那批的来源
            jget(API + '/assets' + (project ? '?project=' + encodeURIComponent(project) : '')),
          ])
            .then(([images, check, assets]) => {
              if (!alive) return
              const records = images?.records ?? []
              // 项目列表取「磁盘 + 历史」的并集：磁盘上有、历史里没有的项目也要能选
              const projectSet = new Set()
              for (const record of records) if (record.project) projectSet.add(record.project)
              for (const item of assets?.files ?? []) if (item.project) projectSet.add(item.project)
              const projects = [...projectSet]
                .sort((a, b) => String(a).localeCompare(String(b), 'zh-Hans-CN'))
              setState((prev) => ({
                records,
                assets: assets?.files ?? [],
                tally: assets?.tally ?? null,
                byKind: assets?.by_kind ?? null,
                reviewStats: assets?.review_stats ?? null,
                queue: assets?.queue ?? null,
                check,
                items: check?.items ?? [],
                summary: check?.summary ?? null,
                projects,
                loading: false,
                error: images ? '' : '读不到 /gpt-image/api（插件没启用或还没重启 DSH）',
              }))
              // 服务端记着「上次选的项目」：首次加载时跟它对齐，刷新后不会跳回「全部」
              if (!project && check?.project && !restoredRef.current) {
                restoredRef.current = true
                setProject(check.project)
              }
              // 游戏目录要跟着当前项目走：只有用户没手动改过时才自动同步，
              // 否则切换项目后目录一直停在第一个项目上（旧值会算错规格/引用）。
              if (check?.game_root && !userEditedRootRef.current) setGameRoot(check.game_root)
            })
            .catch((error) => { if (alive) setState((prev) => ({ ...prev, loading: false, error: String(error?.message ?? error) })) })
        }
        load()
        const timer = setInterval(load, 5000)
        return () => { alive = false; clearInterval(timer) }
      }, [project, tick])

      return {
        ...state,
        project,
        setProject,
        verdict,
        setVerdict,
        assetKind,
        setAssetKind,
        reviewFilter,
        setReviewFilter,
        sel,
        compareFile,
        setCompareFile,
        changeFilter,
        setChangeFilter,
        changeFiles,
        setChangeFiles,
        gameRoot,
        setGameRoot: (value) => { userEditedRootRef.current = true; setGameRoot(value) },
        reload: () => setTick((value) => value + 1),
      }
    }

    /** 项目卡片：一眼看出哪个项目是哪个（数量、最新时间、最近素材名）。 */
    function projectChips(data) {
      const summaryOf = data.check?.project_summaries ?? {}
      const stats = {}
      for (const record of data.records) {
        const key = record.project || 'images'
        const bucket = (stats[key] ??= { count: 0, latest: '', names: [], kinds: new Set() })
        bucket.count += 1
        if (String(record.ts ?? '') > bucket.latest) bucket.latest = String(record.ts ?? '')
        if (record.name && bucket.names.length < 3) bucket.names.push(record.name)
        // record.kind 是出图时写进历史的类型（generate / edit / sheet …）
        const kind = record.kind
        if (kind) bucket.kinds.add(kind)
      }
      const all = ['<全部项目>', ...data.projects]
      const chips = all.map((name) => {
        const value = name === '<全部项目>' ? '' : name
        const info = value ? (stats[value] ?? { count: 0, latest: '', names: [] }) : null
        const check = value ? (summaryOf[value] ?? null) : null
        const active = data.project === value
        const kinds = value ? [...(info?.kinds ?? [])].join('/') : ''
        const title = value
          ? `项目「${value}」\n图 ${info?.count ?? 0} 张｜最近 ${String(info?.latest ?? '').replace('T', ' ').slice(0, 16) || '-'}\n最近素材：${(info?.names ?? []).join('、') || '-'}` +
            (kinds ? `\n类型：${kinds}` : '') +
            (check ? `\n达标 ${check.ok ?? 0}｜用不上 ${check.broken ?? 0}｜规格不符 ${check.mismatch ?? 0}｜没被引用 ${check['not-referenced'] ?? 0}` : '')
          : '显示全部项目的图'
        const label = value
          ? `${value}`
          : `全部（${data.records.length}）`
        const sub = value
          ? `${info?.count ?? 0} 张${kinds ? ` · ${kinds}` : ''}${check?.broken ? ` · ⚠${check.broken}` : ''}${check?.mismatch ? ` · △${check.mismatch}` : ''}`
          : '不过滤'
        return React.createElement('button', {
          key: name || 'all',
          className: 'dshimg-chip' + (active ? ' on' : ''),
          title,
          onClick: () => data.setProject(value),
        },
          React.createElement('span', { className: 'dshimg-chip-name' }, label),
          React.createElement('span', { className: 'dshimg-chip-sub' }, sub))
      })
      return React.createElement('div', { className: 'dshimg-chips-row' }, chips)
    }

    function downloadAll(records) {
      const files = []
      for (const record of records) for (const file of record.files ?? []) files.push(file)
      files.slice(0, 40).forEach((file, index) => {
        setTimeout(() => window.open(API + '/file?path=' + encodeURIComponent(file), '_blank'), index * 220)
      })
    }

    function card(record, checkByFile, sel) {
      // 预览用「画面内带名字」的 labeled 图，一眼知道这张是什么
      const file = record.preview || (record.files ?? [])[0]
      const url = file ? API + '/file?path=' + encodeURIComponent(file) : ''
      const cleanFile = (record.files ?? [])[0] ?? ''
      const info = cleanFile ? checkByFile[cleanFile.replace(/\\/g, '/')] : null
      const verdict = info ? (VERDICT[info.verdict] ?? ['', info.verdict]) : null
      const chips = [
        record.provider, record.model, record.params && record.params.size, record.params && record.params.quality,
        record.ms ? (record.ms / 1000).toFixed(1) + 's' : '',
      ].filter(Boolean)
      const chipNodes = chips.map((chip, index) => React.createElement('span', { key: index }, String(chip)))
      if (verdict) chipNodes.push(React.createElement('span', { key: 'v', className: verdict[0] }, verdict[1]))
      if (info?.referenceCount) chipNodes.push(React.createElement('span', { key: 'r', className: 'ok' }, '被引用 ' + info.referenceCount))

      // 审核状态徽章：人工拍板的结论（合格/不合格/待定）；外部产物额外标一下
      const review = record.review_state ?? 'unreviewed'
      const badgeText = { approved: '✓ 合格', rejected: '✕ 不合格', pending: '? 待定' }[review]
        ?? (record.generated === false ? '外部产物' : '')
      const badge = badgeText
        ? React.createElement('span', {
            className: 'dshrev-badge ' + (review === 'unreviewed' ? 'external' : review),
            title: record.review_note ? `备注：${record.review_note}` : badgeText,
          }, badgeText)
        : null

      const meta = React.createElement('div', { className: 'dshimg-meta' },
        React.createElement('div', { className: 'dshimg-name' }, record.project + ' / ' + record.name),
        React.createElement('div', { className: 'dshimg-chips' }, chipNodes),
        record.prompt ? React.createElement('div', { className: 'dshimg-prompt' }, record.prompt) : null,
        (info?.problems ?? []).length
          ? React.createElement('div', { className: 'dshimg-problems' }, info.problems.map((problem, index) => React.createElement('div', { key: index }, '• ' + problem)))
          : null)

      const checked = sel?.has?.(record.file) ?? false
      const thumbInner = url
        ? React.createElement('img', {
            src: url, loading: 'lazy',
            title: '点击看大图；按住 C 或点右上角「对比」进对比视图',
            onClick: () => window.open(url, '_blank'),
            onError: (event) => { event.target.style.opacity = 0.15 },
          })
        : React.createElement('div', { className: 'dshimg-nothumb' }, '无图')
      const thumb = React.createElement('div', { className: 'dshimg-thumbwrap' },
        sel
          ? React.createElement('input', {
              type: 'checkbox', className: 'dshimg-pick', checked,
              title: '勾选后可批量标记合格/不合格',
              onClick: (event) => event.stopPropagation(),
              onChange: (event) => sel.toggle(record.file, event.target.checked),
            })
          : null,
        // 「对比」按钮：进四格对比视图（键盘流审图的入口）
        sel?.compare
          ? React.createElement('button', {
              className: 'dshimg-compare',
              title: '对比视图（C）：原图 / 实时切片 / 游戏尺寸 / 相邻帧',
              onClick: (event) => { event.stopPropagation(); sel.compare(record.file) },
            }, '对比')
          : null,
        badge,
        thumbInner)
      return React.createElement('div', {
        className: 'dshimg-card' + (checked ? ' sel' : ''),
        key: record.id ?? record.file,
      }, thumb, meta)
    }

    /**
     * 批量审核条：勾了几张、一键合格/不合格/待定/清空。
     * 「一件勾选」= 全选当前筛选结果、反选、只选未审核。
     */
    function reviewBar(data, sel, rows, onDone) {
      const count = sel.size
      const act = async (state) => {
        if (count === 0) return
        const files = rows.filter((r) => sel.has(r.file)).map((r) => ({ path: r.file, name: r.name }))
        const res = await jpost(API + '/review', { files, state, scope: 'name' })
        if (res.ok) { sel.clear(); onDone?.(res) }
      }
      const bulk = (kind) => {
        if (kind === 'all') sel.setAll(rows.map((r) => r.file))
        else if (kind === 'none') sel.clear()
        else if (kind === 'unreviewed') sel.setAll(rows.filter((r) => (r.review_state ?? 'unreviewed') === 'unreviewed').map((r) => r.file))
        else if (kind === 'external') sel.setAll(rows.filter((r) => r.generated === false).map((r) => r.file))
      }
      return React.createElement('div', { className: 'dshrev-bar' },
        React.createElement('span', null, '已选 ', React.createElement('b', { className: 'dshrev-count' }, String(count)), ' 张'),
        React.createElement('button', { className: 'dshrev-btn', onClick: () => bulk('all'), disabled: rows.length === 0 }, `全选本页(${rows.length})`),
        React.createElement('button', { className: 'dshrev-btn', onClick: () => bulk('unreviewed') }, '选未审核'),
        React.createElement('button', { className: 'dshrev-btn', onClick: () => bulk('external') }, '选外部产物'),
        React.createElement('button', { className: 'dshrev-btn', onClick: () => bulk('none'), disabled: count === 0 }, '清空选择'),
        React.createElement('span', { className: 'sp' }),
        React.createElement('button', { className: 'dshrev-btn ok', onClick: () => act('approved'), disabled: count === 0 }, '✓ 标为合格'),
        React.createElement('button', { className: 'dshrev-btn bad', onClick: () => act('rejected'), disabled: count === 0 }, '✕ 标为不合格'),
        React.createElement('button', { className: 'dshrev-btn warn', onClick: () => act('pending'), disabled: count === 0 }, '? 标为待定'))
    }

    function summaryLine(data) {
      const s = data.summary ?? {}
      const checkByFile = {}
      for (const item of data.items ?? []) checkByFile[item.file.replace(/\\/g, '/')] = item
      let rows = visibleAssets(data)
      if (data.assetKind) rows = rows.filter((item) => item.kind === data.assetKind)
      if (data.reviewFilter) {
        rows = data.reviewFilter === 'unreviewed'
          ? rows.filter((item) => (item.review_state ?? 'unreviewed') === 'unreviewed')
          : rows.filter((item) => item.review_state === data.reviewFilter)
      }
      const shown = rows.length
      const tally = data.tally ?? {}
      const parts = []
      parts.push(data.project ? `项目「${data.project}」` : '全部项目')
      if (data.assetKind) parts.push(KIND_LABEL[data.assetKind] ?? data.assetKind)
      if (data.reviewFilter) parts.push(REVIEW_LABEL[data.reviewFilter] ?? data.reviewFilter)
      return React.createElement('span', { className: 'dshimg-sum' },
        parts.join(' · ') + ' 显示 ' + shown + ' 张 ｜ ',
        React.createElement('span', { className: 'dshrev-legend' }, `目录共 ${tally.total ?? 0}（外部产物 ${tally.external ?? 0}）｜`),
        React.createElement('b', { className: 'ok' }, '合格 ' + (tally.approved ?? 0)), ' ｜ ',
        React.createElement('b', { className: 'bad' }, '不合格 ' + (tally.rejected ?? 0)), ' ｜ ',
        React.createElement('b', { className: 'warn' }, '待定 ' + (tally.pending ?? 0)), ' ｜ ',
        React.createElement('span', { className: 'dshrev-legend' }, '未审核 ' + (tally.unreviewed ?? 0)), ' ｜ ',
        React.createElement('span', { className: 'dshrev-legend' }, '核对结论：'),
        React.createElement('b', { className: 'ok' }, '达标 ' + (s.ok ?? 0)), ' ',
        React.createElement('b', { className: 'bad' }, '用不上 ' + (s.broken ?? 0)), ' ',
        React.createElement('b', { className: 'warn' }, '规格不符 ' + (s.mismatch ?? 0)))
    }

    /**
     * 当前选中的项目过滤后的记录。
     * 分类栏（项目卡片）以前只把 project 传给了 /check，没过滤网格，
     * 所以点哪个项目下面都还是全部图 —— 这里统一收口，网格和汇总都用它。
     *
     * 注意：本文件是浏览器端 bundle（没有 import），这里的实现与
     * lib/galleryfilter.js 保持一致；那份是给 node --test 用的可测副本，
     * 改动时请同步（tests/galleryfilter.test.js 钉住了行为）。
     */
    function projectKeyOf(name) {
      return String(name ?? '').trim().toLowerCase()
    }
    function visibleRecords(data) {
      const records = data.records ?? []
      const wanted = projectKeyOf(data.project)
      if (!wanted) return records
      return records.filter((record) => projectKeyOf(record.project || 'images') === wanted)
    }

    /**
     * 「核对结论」过滤：按 verdict 只看某一类，方便盯着问题图改。
     * 结论来自 /api/check 的 items（每条带 verdict），按文件路径对上记录。
     */
    function filterByVerdict(records, checkByFile, verdict) {
      if (!verdict) return records
      return records.filter((record) => {
        const clean = ((record.files ?? [])[0] ?? '').replace(/\\/g, '/')
        const info = clean ? checkByFile[clean] : null
        return info?.verdict === verdict
      })
    }

    /**
     * 这一屏要显示哪些「素材」。
     *
     * 关键改动：**以磁盘为准**（/api/assets 扫出来的），不再只用出图历史。
     * 以前历史里没有的图（切片、缩放件、别的脚本批量产出的）根本不出现 ——
     * 用户看到的"大量素材只在文件夹里"就是这样来的。
     * 历史仍然有用：它带着提示词/模型，所以按文件路径合进来。
     */
    function visibleAssets(data) {
      const assets = data.assets ?? []
      if (assets.length === 0) return []
      const historyByFile = new Map()
      for (const record of data.records ?? []) {
        for (const file of record.files ?? []) historyByFile.set(String(file).replace(/\\/g, '/').toLowerCase(), record)
        for (const file of record.labeled ?? []) historyByFile.set(String(file).replace(/\\/g, '/').toLowerCase(), record)
      }
      return assets.map((item) => {
        const key = String(item.file).replace(/\\/g, '/').toLowerCase()
        const record = historyByFile.get(key) ?? null
        return {
          ...item,
          // 交给 card() 用的字段，缺历史就从磁盘信息兜底
          id: key,
          project: item.project,
          name: item.name,
          prompt: item.prompt || record?.prompt || '',
          provider: item.provider || record?.provider || '',
          model: item.model || record?.model || '',
          params: record?.params ?? { size: '' },
          ms: record?.ms ?? 0,
          generated: item.generated,
          preview: item.file,   // 磁盘文件本身就是可预览的图
        }
      })
    }

    function galleryBody(data, sel, onReviewed) {
      const children = []
      if (data.error) children.push(React.createElement('div', { className: 'dshimg-err', key: 'err' }, data.error))
      if (data.loading && (data.assets ?? []).length === 0) children.push(React.createElement('div', { className: 'dshimg-empty', key: 'load' }, '加载中…'))
      // 变化摘要横幅（prompt 1）：一句话说清"自上次以来多了什么"
      children.push(React.createElement(ChangeBanner, {
        key: 'chg',
        data,
        onChangeFilter: async (kind) => {
          const res = await jget(API + '/changes' + (data.project ? '?project=' + encodeURIComponent(data.project) : ''))
          if (!res) return
          const list = kind === 'added' ? (res.added ?? []).map((item) => item.file)
            : kind === 'changed' ? (res.changed ?? []).map((item) => item.file)
              : (res.queue_files?.needs_re_review ?? [])
          data.setChangeFilter(kind)
          data.setChangeFiles(new Set(list))
        },
      }))
      const checkByFile = {}
      for (const item of data.items ?? []) checkByFile[item.file.replace(/\\/g, '/')] = item

      let rows = visibleAssets(data)
      // 「只看新增/变化」：按横幅给出的文件集合过滤
      if (data.changeFiles) rows = rows.filter((item) => data.changeFiles.has(item.file))
      // 按「素材类别」过滤：正式素材 / 切片 / 缩放件 / 预览图 / 截图
      if (data.assetKind) rows = rows.filter((item) => item.kind === data.assetKind)
      // 按「审核状态」过滤：合格 / 不合格 / 待定 / 未审核
      if (data.reviewFilter) {
        rows = data.reviewFilter === 'unreviewed'
          ? rows.filter((item) => (item.review_state ?? 'unreviewed') === 'unreviewed')
          : rows.filter((item) => item.review_state === data.reviewFilter)
      }
      // 核对结论过滤需要历史记录，这里按路径对上
      if (data.verdict) {
        rows = rows.filter((item) => {
          const key = String(item.file).replace(/\\/g, '/')
          return checkByFile[key]?.verdict === data.verdict
        })
      }

      if (!data.loading && rows.length === 0) {
        children.push(React.createElement('div', { className: 'dshimg-empty', key: 'none' },
          data.records.length === 0 && (data.assets ?? []).length === 0
            ? '这个项目下还没有任何素材文件。'
            : '当前筛选下没有素材。试试清掉「类别/审核」筛选，或点「全部项目」。'))
      }
      children.push(reviewBar(data, sel, rows, onReviewed))
      children.push(React.createElement('div', { className: 'dshimg-grid', key: 'grid' },
        rows.map((record) => card(record, checkByFile, sel))))
      return React.createElement('div', { className: 'dshimg-body' }, children)
    }

    /**
     * 对比视图（prompt 2）：四格并排，切片预览实时算，键盘流审 900 张不用碰鼠标。
     * 快捷键：C 进/出、← → 切上下张、A 合格、R 不合格、P 待定（拍板后自动跳下一张未审核）。
     */
    function ComparePanel({ file, siblings, onClose, onDecided }) {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [index, setIndex] = React.useState(() => Math.max(0, siblings.indexOf(file)))
      const [mix, setMix] = React.useState(0)   // 0=原图 1=切片，滑块过渡
      const [busy, setBusy] = React.useState(false)
      const [toast, setToast] = React.useState('')

      const current = siblings[index] ?? file
      const load = React.useCallback(async (target) => {
        setError('')
        const res = await jget(API + '/compare?path=' + encodeURIComponent(target))
        if (!res) { setError('读不到对比数据'); return }
        if (res.ok === false) { setError(res.error ?? '对比失败'); return }
        setData(res)
      }, [])
      React.useEffect(() => { load(current) }, [current, load])

      const decide = React.useCallback(async (state) => {
        if (busy) return
        setBusy(true)
        try {
          const res = await jpost(API + '/review', {
            files: [{ path: current, name: data?.name }],
            state,
            scope: 'name',
          })
          setToast(`已标为${state === 'approved' ? '合格' : state === 'rejected' ? '不合格' : '待定'}`)
          onDecided?.(current, state, res)
          // 拍板后自动跳到下一张（键盘流的重点：不用回头找位置）
          if (index < siblings.length - 1) setIndex(index + 1)
        } finally {
          setBusy(false)
          setTimeout(() => setToast(''), 1500)
        }
      }, [busy, current, data, index, siblings.length, onDecided])

      React.useEffect(() => {
        const onKey = (event) => {
          const k = event.key.toLowerCase()
          if (k === 'escape' || k === 'c') { event.preventDefault(); onClose() }
          else if (event.key === 'ArrowRight') { event.preventDefault(); setIndex((i) => Math.min(siblings.length - 1, i + 1)) }
          else if (event.key === 'ArrowLeft') { event.preventDefault(); setIndex((i) => Math.max(0, i - 1)) }
          else if (k === 'a') { event.preventDefault(); decide('approved') }
          else if (k === 'r') { event.preventDefault(); decide('rejected') }
          else if (k === 'p') { event.preventDefault(); decide('pending') }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [decide, onClose, siblings.length])

      const pane = (id, label) => {
        const p = (data?.panes ?? []).find((item) => item.id === id)
        if (!p) return null
        // 滑块只在「原图 ↔ 切片」之间过渡，用来判断切得准不准
        const useMix = id === 'slice' && mix > 0 && mix < 1
        return React.createElement('div', { className: 'dshcmp-cell', key: id },
          React.createElement('div', { className: 'h' },
            React.createElement('span', null, label ?? p.label),
            React.createElement('span', { className: 'dshrev-legend' }, p.detail ?? '')),
          p.empty
            ? React.createElement('div', { className: 'dshcmp-none' }, p.detail ?? '无')
            : (p.cells
                // 切片预览：把所有格都摆出来，一眼看全
                ? React.createElement('div', { className: 'dshcmp-cells' },
                    p.cells.map((cell, i) => React.createElement('img', {
                      key: i, src: cell.url, title: `${cell.name} · ${cell.size} · ${cell.alignment ?? ''}`,
                      style: useMix ? { opacity: mix } : undefined,
                      onClick: () => window.open(cell.url, '_blank'),
                    })))
                : React.createElement('img', {
                    src: p.url, title: '点击看大图', onClick: () => window.open(p.url, '_blank'),
                    style: useMix ? { opacity: mix } : undefined,
                  })))
      }

      const review = data?.review?.state ?? 'unreviewed'
      const reviewText = { approved: '✓ 合格', rejected: '✕ 不合格', pending: '? 待定' }[review] ?? '未审核'
      const rule = data?.rule

      return React.createElement('div', { className: 'dshimg-ov' },
        React.createElement('div', { className: 'dshimg-panel dshcmp-panel' },
          React.createElement('style', null, styles),
          React.createElement('div', { className: 'dshimg-head' },
            React.createElement('span', { className: 'dshimg-title' }, '审核对比 · ' + (data?.name ?? '')),
            React.createElement('span', { className: 'dshrev-badge ' + (review === 'unreviewed' ? '' : review) }, reviewText),
            React.createElement('span', { className: 'dshcmp-keys' }, `${index + 1} / ${siblings.length}`),
            React.createElement('button', { className: 'dshimg-x', onClick: onClose }, '关闭 C')),
          React.createElement('div', { className: 'dshcmp-bar' },
            React.createElement('button', { className: 'dshrev-btn', onClick: () => setIndex(Math.max(0, index - 1)) }, '← 上一张'),
            React.createElement('button', { className: 'dshrev-btn', onClick: () => setIndex(Math.min(siblings.length - 1, index + 1)) }, '下一张 →'),
            React.createElement('span', { className: 'sp' }),
            rule
              ? React.createElement('span', { className: 'dshrev-legend' }, `切片规则：${rule.source}${rule.scaled ? ` · 目标 ${rule.scaled.width}×${rule.scaled.height}` : ''}`)
              : React.createElement('span', { className: 'dshrev-legend' }, '无切片规则（对比退化为两格）'),
            React.createElement('span', { className: 'dshcmp-keys' }, toast || 'A 合格 · R 不合格 · P 待定 · ← → 翻页')),
          React.createElement('div', { className: 'dshimg-body' },
            error
              ? React.createElement('div', { className: 'dshimg-err' }, error)
              : !data
                ? React.createElement('div', { className: 'dshimg-empty' }, '加载中…')
                : React.createElement(React.Fragment, null,
                    React.createElement('div', { className: 'dshcmp-grid' },
                      pane('original', '① 原图'),
                      pane('slice', '② 切片预览（实时算）')),
                    React.createElement('div', { className: 'dshcmp-grid', style: { marginTop: '12px' } },
                      pane('ingame', '③ 游戏实际尺寸'),
                      React.createElement('div', null,
                        pane('prev', '④ 上一张 / 下一张'),
                        React.createElement('div', { className: 'dshcmp-slider' },
                          React.createElement('span', null, '原图'),
                          React.createElement('input', {
                            type: 'range', min: 0, max: 1, step: 0.05, value: mix,
                            title: '拖动在原图与切片之间过渡，看切得准不准',
                            onChange: (event) => setMix(Number(event.target.value)),
                          }),
                          React.createElement('span', null, '切片'))))
                    , React.createElement('div', { className: 'dshcmp-bar', style: { borderTop: '1px solid var(--theme-border,#2c3340)', borderBottom: 'none', marginTop: '10px' } },
                        React.createElement('span', { className: 'dshrev-legend' }, '拍板后自动跳下一张'),
                        React.createElement('span', { className: 'sp' }),
                        React.createElement('button', { className: 'dshrev-btn ok', disabled: busy, onClick: () => decide('approved') }, '✓ 合格 A'),
                        React.createElement('button', { className: 'dshrev-btn bad', disabled: busy, onClick: () => decide('rejected') }, '✕ 不合格 R'),
                        React.createElement('button', { className: 'dshrev-btn warn', disabled: busy, onClick: () => decide('pending') }, '? 待定 P')),
                    (data.notes ?? []).length
                      ? React.createElement('div', { className: 'dshrev-legend', style: { marginTop: '8px' } }, data.notes.join(' ｜ '))
                      : null))))
    }

    /** 核对结论过滤：只看某一类问题图，便于集中返工。 */
    function verdictChips(data) {
      const counts = {}
      for (const item of data.items ?? []) {
        const key = item.verdict ?? ''
        if (key) counts[key] = (counts[key] ?? 0) + 1
      }
      const order = ['ok', 'broken', 'mismatch', 'not-referenced', 'unknown-spec']
      const nodes = [React.createElement('button', {
        key: 'all',
        className: 'dshimg-vchip' + (data.verdict ? '' : ' on'),
        onClick: () => data.setVerdict(''),
      }, '全部结论')]
      for (const key of order) {
        const count = counts[key]
        if (!count) continue
        const meta = VERDICT[key] ?? ['', key]
        nodes.push(React.createElement('button', {
          key,
          className: 'dshimg-vchip ' + meta[0] + (data.verdict === key ? ' on' : ''),
          title: `只看「${meta[1]}」的图（${count} 张）`,
          onClick: () => data.setVerdict(data.verdict === key ? '' : key),
        }, `${meta[1]} ${count}`))
      }
      if (nodes.length === 1) return null
      return React.createElement('div', { className: 'dshimg-vrow' }, nodes)
    }

    /**
     * 变化摘要横幅（prompt 1）：一句话告诉你「自上次以来发生了什么」。
     * 首次运行只报"已建立基线"，绝不把已有 900 张全报成新增。
     */
    function ChangeBanner({ data, onChangeFilter }) {
      const [diff, setDiff] = React.useState(null)
      const [error, setError] = React.useState('')
      React.useEffect(() => {
        let alive = true
        const load = async () => {
          // 只读不推进基线（save 由「知道了」按钮或工具显式触发）
          const res = await jget(API + '/changes' + (data.project ? '?project=' + encodeURIComponent(data.project) : ''))
          if (!alive) return
          if (res) { setDiff(res); setError('') } else setError('读不到变化摘要')
        }
        load()
        const timer = setInterval(load, 30000)
        return () => { alive = false; clearInterval(timer) }
      }, [data.project])

      const acknowledge = async () => {
        const res = await jget(API + '/changes?save=1' + (data.project ? '&project=' + encodeURIComponent(data.project) : ''))
        if (res) setDiff(res)
      }

      if (error) return React.createElement('div', { className: 'dshchg' }, '变化摘要：' + error)
      if (!diff) return React.createElement('div', { className: 'dshchg' }, '变化摘要：读取中…')

      if (diff.first_run) {
        return React.createElement('div', { className: 'dshchg' },
          React.createElement('span', { className: 't' }, '📸 已建立基线'),
          React.createElement('span', { className: 'dshrev-legend' }, diff.summary))
      }

      const s = diff.stats ?? {}
      const total = (s.added ?? 0) + (s.changed ?? 0) + (s.removed ?? 0) + (diff.invalidated ?? 0)
      const btn = (label, kind) => React.createElement('button', {
        className: 'dshimg-vchip',
        onClick: () => onChangeFilter?.(kind),
      }, label)

      return React.createElement('div', { className: 'dshchg' + (total > 0 ? ' has' : '') },
        React.createElement('span', { className: 't' }, total > 0 ? '🔄 自上次以来' : '✅ 无变化'),
        s.added ? React.createElement('span', null, React.createElement('span', { className: 'n add' }, '新增 ' + s.added), ' ', btn('只看新增', 'added')) : null,
        s.changed ? React.createElement('span', null, React.createElement('span', { className: 'n chg' }, '内容变化 ' + s.changed), ' ', btn('只看变化', 'changed')) : null,
        s.removed ? React.createElement('span', null, React.createElement('span', { className: 'n del' }, '消失 ' + s.removed)) : null,
        diff.invalidated ? React.createElement('span', null, React.createElement('span', { className: 'n inv' }, '结论失效 ' + diff.invalidated), ' ', btn('去看', 'invalidated')) : null,
        React.createElement('span', { className: 'dshrev-legend' },
          '基线 ' + String(diff.baseline_taken_at ?? '').replace('T', ' ').slice(0, 16) || '—'),
        React.createElement('span', { style: { flex: 1 } }),
        React.createElement('button', { className: 'dshrev-btn', onClick: acknowledge }, '知道了（推进基线）'))
    }

    /**
     * 素材筛选第二排：按「文件类别」与「审核状态」过滤。
     * 类别能解释"为什么有些图看起来不像素材"：切片/缩放件/预览图/截图都不是正式素材。
     */
    const KIND_LABEL = { source: '正式素材', slice: '切片', resized: '缩放件', preview: '带名预览图', screenshot: '截图' }
    const REVIEW_LABEL = { approved: '合格', rejected: '不合格', pending: '待定', unreviewed: '未审核' }

    function assetFilterRow(data) {
      const byKind = data.byKind ?? {}
      const review = data.reviewStats ?? {}
      const total = data.tally?.total ?? 0
      const nodes = []

      nodes.push(React.createElement('span', { className: 'dshrev-legend', key: 'k0' }, '类别：'))
      nodes.push(React.createElement('button', {
        key: 'k-all',
        className: 'dshimg-vchip' + (data.assetKind ? '' : ' on'),
        onClick: () => data.setAssetKind(''),
      }, `全部 ${total}`))
      for (const [kind, label] of Object.entries(KIND_LABEL)) {
        const count = byKind[kind] ?? 0
        if (!count) continue
        nodes.push(React.createElement('button', {
          key: 'k-' + kind,
          className: 'dshimg-vchip' + (data.assetKind === kind ? ' on' : ''),
          title: `只看「${label}」（${count} 张）`,
          onClick: () => data.setAssetKind(data.assetKind === kind ? '' : kind),
        }, `${label} ${count}`))
      }

      nodes.push(React.createElement('span', { className: 'dshrev-legend', key: 'r0', style: { marginLeft: '10px' } }, '审核：'))
      nodes.push(React.createElement('button', {
        key: 'r-all',
        className: 'dshimg-vchip' + (data.reviewFilter ? '' : ' on'),
        onClick: () => data.setReviewFilter(''),
      }, '全部'))
      for (const [state, label] of Object.entries(REVIEW_LABEL)) {
        const count = state === 'unreviewed'
          ? (data.tally?.unreviewed ?? 0)
          : (review[state] ?? 0)
        if (!count) continue
        const cls = state === 'approved' ? 'ok' : state === 'rejected' ? 'bad' : state === 'pending' ? 'warn' : ''
        nodes.push(React.createElement('button', {
          key: 'r-' + state,
          className: 'dshimg-vchip ' + cls + (data.reviewFilter === state ? ' on' : ''),
          title: `只看「${label}」（${count} 张）`,
          onClick: () => data.setReviewFilter(data.reviewFilter === state ? '' : state),
        }, `${label} ${count}`))
      }

      return React.createElement('div', { className: 'dshimg-vrow' }, nodes)
    }

    function header(data, { onClose, scanLog }) {
      const rootInput = React.createElement('input', {
        className: 'dshimg-wide',
        value: data.gameRoot,
        placeholder: '游戏目录，例如 D:\\AHC\\doomsday-ember（查规格与引用）',
        onChange: (event) => data.setGameRoot(event.target.value),
      })
      const nodes = [
        React.createElement('span', { className: 'dshimg-title', key: 'title' }, '项目生图 · 核对'),
        React.createElement(BalanceBadge, { key: 'bal', compact: true }),
        projectChips(data),
        assetFilterRow(data),
        verdictChips(data),
        rootInput,
        React.createElement('button', {
          className: 'dshimg-x',
          key: 'save',
          onClick: async () => {
            await jpost(API + '/game-root', { root: data.gameRoot, project: data.project })
            data.reload()
          },
        }, '保存目录'),
        React.createElement('button', {
          className: 'dshimg-x',
          key: 'scan',
          onClick: async () => {
            scanLog?.('体检中…')
            const result = await jget(API + '/scan?root=' + encodeURIComponent(data.gameRoot))
            scanLog?.(JSON.stringify({
              conclusion: result?.conclusion,
              genres: (result?.genres ?? []).map((genre) => genre.label),
              missing: (result?.missing_referenced ?? []).map((item) => item.ref),
              suggested: (result?.suggested ?? []).slice(0, 10).map((item) => item.name),
            }, null, 2))
          },
        }, '体检'),
        React.createElement('button', { className: 'dshimg-x', key: 'refresh', onClick: () => data.reload() }, '刷新'),
        // 批量重处理：派生规则变了但不想重审 —— 只重切、继承结论
        React.createElement('button', {
          className: 'dshimg-x',
          key: 'reprocess',
          title: '派生规则（切片网格/目标尺寸）变了时，只重切派生文件并继承审核结论',
          onClick: async () => {
            const plan = await jget(API + '/reprocess' + (data.project ? '?project=' + encodeURIComponent(data.project) : ''))
            if (!plan) { scanLog?.('读不到重处理规划'); return }
            const ok = window.confirm(`${plan.text}\n\n确定执行吗？（只动派生文件，源图与审核结论都不碰）`)
            if (!ok) { scanLog?.(plan.text); return }
            scanLog?.('重处理中…')
            const res = await jpost(API + '/reprocess', { project: data.project ?? '', slices: true, dry_run: false })
            scanLog?.(res?.text ?? JSON.stringify(res, null, 2))
            data.reload()
          },
        }, '重处理'),
      ]
      if (onClose) nodes.push(React.createElement('button', { className: 'dshimg-x', key: 'close', onClick: onClose }, '关闭 Esc'))
      return React.createElement('div', { className: 'dshimg-head' }, nodes)
    }

    function GalleryOverlay({ onClose }) {
      const data = useGallery()
      React.useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      const body = React.createElement('div', { className: 'dshimg-panel' },
        React.createElement('style', null, styles),
        header(data, { onClose }),
        galleryBody(data, data.sel, () => data.reload()),
        React.createElement('div', { className: 'dshimg-foot' }, summaryLine(data),
          React.createElement('a', { href: '/gpt-image', target: '_blank', rel: 'noreferrer' }, '在浏览器打开完整面板')))
      return React.createElement('div', {
        className: 'dshimg-ov',
        onClick: (event) => { if (event.target === event.currentTarget) onClose() },
      }, body)
    }

    function GalleryPage() {
      const data = useGallery()
      const [log, setLog] = React.useState('核对说明：达标=规格符合且游戏引用；用不上=尺寸/透明/空图有问题；没被引用=代码里没人用它。勾选素材后可一键标为合格/不合格；点卡片上的「对比」进四格对比视图（快捷键 C）。')
      return React.createElement('div', { className: 'dshimg-page' },
        React.createElement('style', null, styles),
        header(data, { scanLog: setLog }),
        data.compareFile
          ? React.createElement(ComparePanel, {
              file: data.compareFile,
              siblings: (data.assets ?? []).filter((item) => item.kind === 'source').map((item) => item.file),
              onClose: () => data.setCompareFile(''),
              onDecided: () => data.reload(),
            })
          : null,
        galleryBody(data, data.sel, () => data.reload()),
        React.createElement('div', { className: 'dshimg-foot' },
          summaryLine(data),
          React.createElement('button', { className: 'dshimg-x', onClick: () => downloadAll(data.records) }, '批量打开原图'),
          React.createElement('span', { style: { opacity: 0.8 } }, log)))
    }

    /** 左侧栏的图标（由侧栏自己渲染按钮与提示文案）。 */
    /**
     * 自动化页（L–R 组）：把「自动化的现状」和「需要人做的事」放在一页。
     * 这一页的存在理由：auto 工具有 36 个 action，但之前**只有 AI 调得到** ——
     * 人在界面上看不到分流结果、撤销入口、告警、自愈清单。
     */
    function useAuto() {
      const [state, setState] = React.useState({ data: null, health: null, loading: true, error: '' })
      const [tick, setTick] = React.useState(0)
      React.useEffect(() => {
        let alive = true
        const load = () => {
          Promise.all([jget(API + '/auto'), jget(API + '/health')])
            .then(([auto, health]) => {
              if (!alive) return
              setState({ data: auto, health, loading: false, error: auto ? '' : '读不到 /api/auto（插件没启用或还没重启 DSH）' })
            })
            .catch((error) => { if (alive) setState((p) => ({ ...p, loading: false, error: String(error?.message ?? error) })) })
        }
        load()
        const timer = setInterval(load, 15000)
        return () => { alive = false; clearInterval(timer) }
      }, [tick])
      return { ...state, reload: () => setTick((v) => v + 1) }
    }

    function AutoPage() {
      const { data, health, loading, error, reload } = useAuto()
      const [log, setLog] = React.useState('自动化说明：审核一次、之后自动到底。这里能看到「系统自己做了什么」和「需要你做什么」。所有破坏性操作默认先试运行。')
      const [busy, setBusy] = React.useState(false)

      const act = async (what, body = {}, label = '') => {
        setBusy(true)
        setLog(`执行「${label || what}」…`)
        try {
          const res = await jpost(API + '/auto-run', { what, ...body })
          setLog(JSON.stringify(res, null, 2))
          reload()
        } catch (e) {
          setLog('出错：' + String(e?.message ?? e))
        } finally {
          setBusy(false)
        }
      }

      if (loading && !data) return React.createElement('div', { className: 'dshimg-page' },
        React.createElement('style', null, styles),
        React.createElement('div', { className: 'dshauto-log' }, '读取中…'))
      if (error) return React.createElement('div', { className: 'dshimg-page' },
        React.createElement('style', null, styles),
        React.createElement('div', { className: 'dshimg-err' }, error))

      const q = data.queue ?? {}
      const sh = data.selfheal ?? {}
      const alerts = data.alerts?.alerts ?? []
      const pipeline = data.pipeline ?? {}
      const st = pipeline.status ?? {}
      const healthMetrics = health?.health ?? {}
      const funnel = health?.funnel ?? {}

      const card = (key, tone, title, big, sub, extra = []) => React.createElement('div', {
        className: 'dshauto-card' + (tone ? ' ' + tone : ''), key,
      },
        React.createElement('h4', null, title),
        React.createElement('div', { className: 'big' }, big),
        sub ? React.createElement('div', { className: 'sub' }, sub) : null,
        ...extra)

      const kv = (k, v) => React.createElement('div', { className: 'dshauto-kv', key: k },
        React.createElement('span', null, k), React.createElement('b', null, String(v)))

      return React.createElement('div', { className: 'dshimg-page' },
        React.createElement('style', null, styles),
        React.createElement('div', { className: 'dshimg-head' },
          React.createElement('span', { className: 'dshimg-title' }, '自动化 · 流水线 · 治理'),
          React.createElement(BalanceBadge, { compact: true }),
          React.createElement('button', { className: 'dshimg-x', onClick: reload }, '刷新')),

        React.createElement('div', { className: 'dshimg-body' },
          // ⚠ 冷启动警告放最前：这是最容易被忽略的前提
          data.cold_start
            ? React.createElement('div', { className: 'dshbal-advice warn', style: { marginBottom: '12px' } },
                React.createElement('b', null, '⚠ 自动化冷启动'),
                React.createElement('span', null, ` 历史样本只有 ${(data.history?.approved ?? 0) + (data.history?.rejected ?? 0)} 条（需 ${data.history?.min_history ?? 20} 条）—— 阈值已提高，**绝大多数会转人工**。这是刻意的：不在没数据时硬猜。先审一批，自动分流才会真正生效。`))
            : null,

          // 第一排：最该知道的四个数
          React.createElement('div', { className: 'dshauto-grid' },
            card('q1', q.needs_review > 0 ? 'warn' : 'ok', '需要你审核',
              q.needs_review ?? 0, '唯一必须人的一步',
              q.samples?.needs_review?.length
                ? [React.createElement('div', { className: 'dshauto-list', key: 'l' }, q.samples.needs_review.map((f, i) => React.createElement('div', { key: i }, String(f).split(/[\\/]/).pop())))]
                : []),
            card('q2', q.needs_re_review > 0 ? 'bad' : 'ok', '结论失效',
              q.needs_re_review ?? 0, '内容变了，要重审'),
            card('q3', 'ok', '待自动安装',
              q.needs_install ?? 0, '已合格，install 会自动捡走'),
            card('q4', alerts.length > 0 ? 'warn' : 'ok', '告警',
              alerts.length, alerts.length ? alerts[0].code : '无告警',
              alerts.slice(0, 3).map((a, i) => React.createElement('div', { className: 'sub', key: i }, `[${a.level}] ${a.message}`)))),

          // 第二排：流水线
          React.createElement('div', { className: 'dshauto-card', key: 'pl', style: { marginTop: '12px' } },
            React.createElement('h4', null,
              React.createElement('span', null, `流水线：${pipeline.name ?? '-'}`),
              React.createElement('span', { className: 'dshauto-pill ' + (pipeline.valid ? 'ok' : 'bad') }, pipeline.valid ? '配置有效' : '配置有误')),
            pipeline.valid ? null : React.createElement('div', { className: 'sub', style: { color: '#f87171' } }, (pipeline.errors ?? []).join('；')),
            React.createElement('div', { className: 'dshauto-flow' },
              (pipeline.steps ?? []).flatMap((id, i) => {
                const step = (st.steps ?? [])[i] ?? {}
                const node = React.createElement('span', {
                  className: 'dshauto-step ' + (step.state ?? 'pending'), key: id,
                }, id)
                return i === 0 ? [node] : [React.createElement('span', { className: 'dshauto-arrow', key: id + 'a' }, '→'), node]
              })),
            React.createElement('div', { className: 'sub', style: { marginTop: '6px' } }, st.advice ?? ''),
            pipeline.last_run
              ? React.createElement('div', { className: 'sub' }, `上次运行 ${String(pipeline.last_run.at ?? '').replace('T', ' ').slice(0, 19)}｜批次 ${pipeline.last_run.batch_id}${pipeline.last_run.failed_at ? `｜失败于 ${pipeline.last_run.failed_at}` : ''}`)
              : null),

          // 第三排：自愈 + 健康
          React.createElement('div', { className: 'dshauto-grid', style: { marginTop: '12px' } },
            React.createElement('div', { className: 'dshauto-card' + (sh.orphans > 0 ? ' warn' : ''), key: 'sh' },
              React.createElement('h4', null, '自愈检查'),
              kv('孤儿派生文件', sh.orphans ?? 0),
              kv('悬空审核记录', sh.dangling_reviews ?? 0),
              kv('缺失（该切没切）', sh.missing ?? 0),
              sh.orphan_detail?.length
                ? React.createElement('div', { className: 'dshauto-list' }, sh.orphan_detail.slice(0, 5).map((o, i) => React.createElement('div', { key: i }, String(o.file).split(/[\\/]/).slice(-2).join('/'))))
                : null,
              React.createElement('div', { className: 'sub' }, sh.risk === 'irreversible-delete' ? '⚠ 清理会删文件（会先进回收目录）' : '没有需要删的东西')),
            React.createElement('div', { className: 'dshauto-card', key: 'hm' },
              React.createElement('h4', null, '健康度'),
              kv('素材总数', healthMetrics.total ?? 0),
              kv('已审比例', `${Math.round((healthMetrics.review_progress ?? 0) * 100)}%`),
              kv('驳回率', `${Math.round((healthMetrics.reject_rate ?? 0) * 100)}%`),
              kv('漏斗留存', `${Math.round((funnel.overall ?? 0) * 100)}%`),
              React.createElement('div', { className: 'sub' }, funnel.advice ?? '')),

            // 第四排：批量撤销（你批评里漏掉的那条）
            React.createElement('div', { className: 'dshauto-card' + (data.undoable?.length ? ' warn' : ''), key: 'undo' },
              React.createElement('h4', null, '可撤销的批次'),
              (data.undoable ?? []).length === 0
                ? React.createElement('div', { className: 'sub' }, '没有可撤销的批次')
                : React.createElement('div', { className: 'dshauto-list' },
                    (data.undoable ?? []).slice(0, 8).map((e, i) => React.createElement('div', { key: i },
                      React.createElement('button', {
                        className: 'dshrev-btn warn', style: { marginRight: '8px' },
                        disabled: busy,
                        onClick: () => act('undo', { batch_id: e.batch_id, dry_run: false }, `撤销 ${e.batch_id}`),
                      }, '撤销'),
                      React.createElement('span', null, `${e.count} 项 · ${e.by} · ${e.action} · ${String(e.at).replace('T', ' ').slice(5, 16)}`)))),
              React.createElement('div', { className: 'sub' }, '撤销本身也留痕，撤错还能再撤回来')),

            React.createElement('div', { className: 'dshauto-card', key: 'bk' },
              React.createElement('h4', null, '备份'),
              (data.backups ?? []).length === 0
                ? React.createElement('div', { className: 'sub' }, '还没有备份')
                : React.createElement('div', { className: 'dshauto-list' },
                    data.backups.slice(0, 5).map((b, i) => React.createElement('div', { key: i },
                      `${String(b.at).replace('T', ' ').slice(0, 19)} · ${(b.files ?? []).length} 个文件`))),
              React.createElement('div', { className: 'sub' }, '只备份状态文件（不备份几万张图）'))),

          // 操作区
          React.createElement('div', { className: 'dshauto-actions' },
            React.createElement('button', { className: 'dshrev-btn', disabled: busy, onClick: () => act('route', { dry_run: true }, '试运行自动分流') }, '试运行分流'),
            React.createElement('button', {
              className: 'dshrev-btn ok', disabled: busy,
              onClick: () => { if (window.confirm('确认执行自动分流？会自动改审核结论（可通过「撤销」批量撤回）。')) act('route', { dry_run: false }, '执行自动分流') },
            }, '执行自动分流'),
            React.createElement('button', { className: 'dshrev-btn', disabled: busy, onClick: () => act('selfheal', { dry_run: true }, '自愈试运行') }, '自愈试运行'),
            React.createElement('button', {
              className: 'dshrev-btn warn', disabled: busy,
              onClick: () => { if (window.confirm('确认执行自愈？会清理孤儿派生文件（先移进回收目录）。')) act('selfheal', { dry_run: false }, '执行自愈') },
            }, '执行自愈'),
            React.createElement('button', { className: 'dshrev-btn', disabled: busy, onClick: () => act('backup', {}, '备份') }, '立即备份')),

          React.createElement('div', { className: 'dshbal-sect' },
            React.createElement('h4', null, '📋 每日维护清单（已挂 DSH 定时任务，每天 03:00）'),
            React.createElement('table', { className: 'dshbal-table' },
              React.createElement('tbody', null, (data.maintenance ?? []).map((t) => React.createElement('tr', { key: t.step },
                React.createElement('th', null, t.step),
                React.createElement('td', null, t.why)))))),

          React.createElement('div', { className: 'dshauto-log' }, log)))
    }

    /** 侧栏「自动化」图标（齿轮）。 */
    function AutoIcon(props) {
      const size = Number(props?.size ?? 18)
      return React.createElement('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        style: { display: 'block', opacity: props?.active ? 1 : 0.85 },
      },
        React.createElement('circle', { cx: 12, cy: 12, r: 3 }),
        React.createElement('path', { d: 'M12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8L6 18M18 6l1.8-1.8' }))
    }

    function PanelIcon(props) {
      const size = Number(props?.size ?? 18)
      return React.createElement('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        style: { display: 'block', opacity: props?.active ? 1 : 0.85 },
      },
        React.createElement('rect', { x: 3, y: 4, width: 18, height: 14, rx: 2 }),
        React.createElement('circle', { cx: 8, cy: 9, r: 1.6 }),
        React.createElement('path', { d: 'M4 16l5-5 4 4 3-3 4 4' }))
    }

    /** 侧栏「生视频」图标（胶片 + 播放三角）。 */
    function VideoIcon(props) {
      const size = Number(props?.size ?? 18)
      return React.createElement('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        style: { display: 'block', opacity: props?.active ? 1 : 0.85 },
      },
        React.createElement('rect', { x: 2.5, y: 5, width: 19, height: 14, rx: 2.5 }),
        React.createElement('path', { d: 'M10 9.5l4.5 2.5L10 14.5z' }))
    }

    /** 侧栏「余额」图标（钱币）。 */
    function BalanceIcon(props) {
      const size = Number(props?.size ?? 18)
      return React.createElement('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        style: { display: 'block', opacity: props?.active ? 1 : 0.85 },
      },
        React.createElement('circle', { cx: 12, cy: 12, r: 8.5 }),
        React.createElement('path', { d: 'M12 7.5v9M14.5 9.5c0-1-1.1-1.6-2.5-1.6s-2.5.6-2.5 1.6 1.1 1.5 2.5 1.7 2.5.7 2.5 1.7-1.1 1.6-2.5 1.6-2.5-.6-2.5-1.6' }))
    }

    function ImagesButton() {
      const [open, setOpen] = React.useState(false)
      return React.createElement(React.Fragment, null,
        React.createElement('button', {
          className: 'dshimg-btn',
          title: '项目生图（含规格核对与游戏引用）',
          onClick: () => setOpen((value) => !value),
        }, React.createElement('span', { className: 'dot' }), '生图'),
        open ? React.createElement(GalleryOverlay, { onClose: () => setOpen(false) }) : null)
    }

    /** 生视频面板：填提示词与参数，提交后轮询进度，完成后给下载链接。 */
    const VIDEO_ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']
    const VIDEO_MODES = [
      ['text', '文生视频'],
      ['keyframe', '首/尾帧控制'],
      ['reference', '参考图/音频'],
    ]

    /**
     * 生视频表单主体（不含外层容器）：浮层和主区域整页共用同一份。
     * 抽出来的原因见下方 VideoPage —— 侧栏图标必须能对上一个 main 面板，
     * 否则点了会「选不中」（DSH 的 sidebar.panellist 契约：id 要对应 main 的 key）。
     */
    function VideoForm({ onClose, scanable }) {
      const [prompt, setPrompt] = React.useState('')
      const [seconds, setSeconds] = React.useState(5)
      const [mode, setMode] = React.useState('text')
      const [aspect, setAspect] = React.useState('16:9')
      const [project, setProject] = React.useState('video')
      const [firstFrame, setFirstFrame] = React.useState('')
      const [lastFrame, setLastFrame] = React.useState('')
      const [images, setImages] = React.useState('')
      const [target, setTarget] = React.useState('first_frame')
      const [busy, setBusy] = React.useState(false)
      const [log, setLog] = React.useState('提示：视频是异步任务，通常几十秒到几分钟；Agnes 视频队列常满，会自动退避重试。\n「导入图片」：可以直接选本地文件、也可以粘贴本地绝对路径 —— Agnes 只收公网 URL，插件会自己把本地素材传出去换公网地址。')
      const [results, setResults] = React.useState([])
      const [materials, setMaterials] = React.useState([])
      const [library, setLibrary] = React.useState([])
      const [showLibrary, setShowLibrary] = React.useState(false)
      const fileRef = React.useRef(null)

      React.useEffect(() => {
        if (!onClose) return undefined
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])

      // 模式切了，之前挑的目标字段可能就不成立了（比如首帧 → 参考图）
      React.useEffect(() => {
        if (mode === 'keyframe' && target !== 'first_frame' && target !== 'last_frame') setTarget('first_frame')
        if (mode === 'reference' && target !== 'images') setTarget('images')
      }, [mode, target])

      const loadLibrary = async () => {
        const res = await jget(API + '/images')
        const records = (res && res.records) || []
        // 只挑真的落了干净图的记录（labeled 是给看的，不拿来当输入）
        const items = []
        for (const record of records) {
          for (const file of (record.files || [])) {
            if (items.length >= 24) break
            if (/\.(png|jpe?g|webp)$/i.test(file)) items.push({ file, project: record.project || '', name: record.name || '' })
          }
          if (items.length >= 24) break
        }
        setLibrary(items)
      }

      const addMaterial = (field, value, meta) => {
        if (field === 'first_frame') setFirstFrame(value)
        else if (field === 'last_frame') setLastFrame(value)
        else setImages((prev) => {
          const list = prev.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
          if (!list.includes(value)) list.push(value)
          return list.join('\n')
        })
        if (meta) setMaterials((prev) => [...prev, { ...meta, field, at: Date.now() }])
      }

      /** 导入本地文件：浏览器只会给字节，先交给插件存盘，再换公网 URL。 */
      const importFiles = async (event) => {
        const files = Array.from(event.target.files || [])
        if (fileRef.current) fileRef.current.value = ''
        if (files.length === 0) return
        setBusy(true)
        for (const file of files) {
          setLog('正在导入「' + file.name + '」（' + (file.size / 1024).toFixed(0) + 'KB）…')
          try {
            const form = new FormData()
            form.append('file', file, file.name)
            const response = await fetch(API + '/upload', { method: 'POST', body: form })
            const json = await response.json().catch(() => ({}))
            if (json.ok) {
              addMaterial(target, json.url, { name: file.name, url: json.url, host: json.host || json.via, stored: json.stored, ttl: json.ttl_minutes })
              setLog('已导入「' + file.name + '」\n公网地址：' + json.url
                + (json.ttl_minutes ? '\n注意：这是临时图床，约 ' + json.ttl_minutes + ' 分钟后失效。' : '')
                + '\n本地备份：' + (json.stored || '（无）'))
            } else {
              // 传不出去也不是白忙：文件已经落在本地，本地路径同样能用作输入
              if (json.stored) addMaterial(target, json.stored, { name: file.name, stored: json.stored, failed: true })
              setLog('「' + file.name + '」没换到公网地址：' + (json.error || '未知原因')
                + (json.stored ? '\n已存到本地：' + json.stored + '\n（已把它填进输入框；提交时会再试一次上传）' : '')
                + (json.hint ? '\n' + json.hint : ''))
            }
          } catch (error) {
            setLog('上传出错：' + String(error?.message ?? error))
          }
        }
        setBusy(false)
      }

      const submit = async () => {
        if (!prompt.trim()) { setLog('先写一句视频描述。'); return }
        setBusy(true)
        setLog('已提交，等待视频队列…（队列满会自动重试）')
        try {
          const body = {
            prompt,
            seconds: Number(seconds),
            mode,
            aspect_ratio: aspect,
            project,
            confirm: true,
          }
          if (mode === 'keyframe') {
            if (firstFrame.trim()) body.first_frame = firstFrame.trim()
            if (lastFrame.trim()) body.last_frame = lastFrame.trim()
          }
          if (mode === 'reference' && images.trim()) {
            body.images = images.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
          }
          const res = await jpost(API + '/video', body)
          if (res.ok && res.files && res.files.length) {
            setResults((prev) => [{ ...res, at: Date.now() }, ...prev])
            setLog('完成：' + res.files.map((f) => f.split(/[\\/]/).pop()).join('、')
              + (res.profile_note ? '\n' + res.profile_note : ''))
          } else if (res.pending) {
            setLog('任务已提交（未等待）：task_id=' + res.task_id + '。稍后用「查进度」看结果。')
            setResults((prev) => [{ ...res, pending: true, at: Date.now() }, ...prev])
          } else {
            setLog('失败：' + (res.error || '未知原因')
              + (res.profile_note ? '\n' + res.profile_note : '')
              + (res.hint ? '\n' + res.hint : ''))
          }
        } catch (error) {
          setLog('出错：' + String(error?.message ?? error))
        } finally {
          setBusy(false)
        }
      }

      const field = (label, node) => React.createElement('label', { className: 'dshvid-field' },
        React.createElement('span', null, label), node)

      const materialRow = mode === 'text'
        ? null
        : React.createElement('div', { className: 'dshvid-import' },
            React.createElement('div', { className: 'dshvid-row' },
              React.createElement('span', { className: 'dshvid-note' },
                mode === 'keyframe'
                  ? '导入图片 → 用作' + (target === 'first_frame' ? '首帧' : '尾帧') + '（Agnes 会尽量把它当成成片的第一/最后一帧）'
                  : '导入图片 → 作为参考图（可用 <Picture 1> 在描述里指代）'),
              React.createElement('input', {
                ref: fileRef, type: 'file', multiple: mode === 'reference',
                accept: 'image/png,image/jpeg,image/webp,image/gif,audio/mpeg,audio/wav,audio/mp4',
                className: 'dshvid-file', disabled: busy, onChange: importFiles,
              }),
              React.createElement('button', {
                className: 'dshimg-x', type: 'button', disabled: busy,
                onClick: () => { setShowLibrary((prev) => { if (!prev) loadLibrary(); return !prev }) },
              }, showLibrary ? '收起素材库' : '从已生成的图选'),
              mode === 'keyframe'
                ? React.createElement('select', {
                    value: target, onChange: (event) => setTarget(event.target.value),
                  }, [['first_frame', '填到首帧'], ['last_frame', '填到尾帧']].map(([value, label]) =>
                    React.createElement('option', { key: value, value }, label)))
                : null),
            materials.length > 0
              ? React.createElement('div', { className: 'dshvid-materials' }, materials.map((item, index) =>
                  React.createElement('span', { key: index, className: 'dshvid-chip' + (item.failed ? ' dshvid-chip-bad' : ''), title: item.url || item.stored || '' },
                    (item.field === 'first_frame' ? '首帧 ' : item.field === 'last_frame' ? '尾帧 ' : '参考 ')
                    + (item.name || '') + (item.host ? ' · ' + item.host : item.failed ? ' · 待上传' : ''))))
              : null,
            showLibrary
              ? React.createElement('div', { className: 'dshvid-library' },
                  library.length === 0
                    ? React.createElement('span', { className: 'dshvid-note' }, '还没有已生成的图；先去出图台生成，或者直接选本地文件。')
                    : library.map((item, index) => React.createElement('button', {
                        key: index, className: 'dshvid-thumb', type: 'button', title: item.file,
                        onClick: () => addMaterial(target, item.file, { name: item.name || item.file.split(/[\\/]/).pop(), stored: item.file }),
                      }, React.createElement('img', { src: API + '/file?path=' + encodeURIComponent(item.file), alt: item.name }))))
              : null)

      return React.createElement(React.Fragment, null,
        React.createElement('div', { className: 'dshvid-form' },
          field('视频描述（主体 + 动作 + 镜头 + 氛围）',
            React.createElement('textarea', {
              className: 'dshvid-prompt',
              value: prompt,
              placeholder: '例：一枚金色硬币在深色石面上缓慢旋转，镜头缓缓推近，柔和轮廓光，电影感\n导入图片时例：以 <Picture 1> 中的角色与美术风格为参考，角色在花田中自然奔跑，保持外观一致，低机位跟拍',
              onChange: (event) => setPrompt(event.target.value),
            })),
          React.createElement('div', { className: 'dshvid-row' },
            field('时长（4-12 秒）', React.createElement('input', {
              type: 'number', min: 4, max: 12, value: seconds,
              onChange: (event) => setSeconds(event.target.value),
            })),
            field('模式', React.createElement('select', {
              value: mode, onChange: (event) => setMode(event.target.value),
            }, VIDEO_MODES.map(([value, label]) => React.createElement('option', { key: value, value }, label)))),
            field('比例', React.createElement('select', {
              value: aspect, onChange: (event) => setAspect(event.target.value),
            }, VIDEO_ASPECTS.map((value) => React.createElement('option', { key: value, value }, value)))),
            field('项目', React.createElement('input', {
              value: project, onChange: (event) => setProject(event.target.value),
            }))),
          materialRow,
          mode === 'keyframe'
            ? React.createElement(React.Fragment, null,
                field('首帧（本地绝对路径或公网 URL 都行，留空则只用尾帧）', React.createElement('input', {
                  value: firstFrame, placeholder: 'D:\\游戏\\assets\\hero.png 或 https://…/first.png',
                  onChange: (event) => setFirstFrame(event.target.value),
                })),
                field('尾帧（可选）', React.createElement('input', {
                  value: lastFrame, placeholder: 'D:\\游戏\\assets\\hero_end.png 或 https://…/last.png',
                  onChange: (event) => setLastFrame(event.target.value),
                })))
            : null,
          mode === 'reference'
            ? field('参考图（每行一个，最多 5 张；本地绝对路径或公网 URL 都行）', React.createElement('textarea', {
                className: 'dshvid-prompt', value: images,
                placeholder: 'D:\\游戏\\assets\\hero.png\nhttps://…/b.png',
                onChange: (event) => setImages(event.target.value),
              }))
            : null,
          React.createElement('div', { className: 'dshvid-row' },
            React.createElement('span', { className: 'dshvid-note' }, '720P 固定 ｜ 当前免费（刊例 $0.025/秒）｜ 配置档会自动选视频档'),
            React.createElement('button', {
              className: 'dshimg-x dshvid-go', disabled: busy, onClick: submit,
            }, busy ? '生成中…' : '生成视频'))),
        React.createElement('pre', { className: 'dshvid-log' }, log),
        results.length > 0
          ? React.createElement('div', { className: 'dshvid-results' }, results.map((item, index) =>
              React.createElement('div', { className: 'dshvid-card', key: item.gallery_id ?? index },
                React.createElement('div', { className: 'dshimg-name' }, item.pending ? '任务已提交（进行中）' : '已完成'),
                (item.files ?? []).map((file, i) => React.createElement('a', {
                  key: i, href: API + '/file?path=' + encodeURIComponent(file),
                  target: '_blank', rel: 'noreferrer', className: 'dshvid-link',
                }, String(file).split(/[\\/]/).pop())),
                item.task_id ? React.createElement('div', { className: 'dshvid-task' }, 'task_id: ' + item.task_id) : null,
                (item.assets ?? []).length
                  ? React.createElement('div', { className: 'dshvid-task' }, '导入素材：' + item.assets.map((a) => (a.input ? String(a.input).split(/[\\/]/).pop() : '') + ' → ' + (a.host || a.via)).join('；'))
                  : null)))
          : null)
    }

    /** 浮层版（会话头部按钮用）。 */
    function VideoPanel({ onClose }) {
      return React.createElement('div', { className: 'dshimg-ov' },
        React.createElement('div', { className: 'dshimg-panel dshvid-panel' },
          React.createElement('style', null, styles),
          React.createElement('div', { className: 'dshimg-head' },
            React.createElement('span', { className: 'dshimg-title' }, '生成视频 · Agnes Video 2.5 Flash'),
            React.createElement(BalanceBadge, { compact: true }),
            React.createElement('button', { className: 'dshimg-x', onClick: onClose }, '关闭 Esc')),
          React.createElement('div', { className: 'dshimg-body' }, React.createElement(VideoForm, { onClose }))))
    }

    /**
     * 整页版（左侧栏「生视频」用）。
     * 关键：sidebar.panellist 的每个 id 必须对应一个 main 面板，
     * 否则 DSH 选择时会抛错、当前面板不变 —— 表现就是「点了没反应」。
     */
    function VideoPage() {
      return React.createElement('div', { className: 'dshimg-page' },
        React.createElement('style', null, styles),
        React.createElement('div', { className: 'dshimg-head' },
          React.createElement('span', { className: 'dshimg-title' }, '生成视频 · Agnes Video 2.5 Flash'),
          React.createElement(BalanceBadge, { compact: true })),
        React.createElement('div', { className: 'dshimg-body' }, React.createElement(VideoForm, {})))
    }


    /**
     * 余额 / 花费：本地闸门是真实生效的；上游账户计费能查到多少算多少。
     * 每 30 秒刷新一次本地部分（远端查询较慢，只在打开详情时拉）。
     */
    function useBalance() {
      const [state, setState] = React.useState({ data: null, loading: true, error: '' })
      React.useEffect(() => {
        let alive = true
        const load = async () => {
          // 徽章轮询只看本地（remote=0）：省一次外网请求，也不受上游抖动影响
          const data = await jget(API + '/balance?remote=0')
          if (!alive) return
          if (data) setState((prev) => ({ data: { ...(prev.data ?? {}), ...data }, loading: false, error: '' }))
          else setState((prev) => ({ ...prev, loading: false, error: '读不到余额（插件没启用或还没重启 DSH）' }))
        }
        load()
        const timer = setInterval(load, 30000)
        return () => { alive = false; clearInterval(timer) }
      }, [])
      const fetchRemote = async () => {
        const data = await jget(API + '/balance')
        if (data) setState((prev) => ({ ...prev, data: { ...(prev.data ?? {}), ...data } }))
      }
      return { ...state, fetchRemote }
    }

    const BAL_TONE = { exhausted: 'bad', tight: 'warn', disabled: 'muted', free: 'ok', healthy: 'ok' }
    const BAL_STATE_TEXT = {
      free: '免费档',
      healthy: '额度充足',
      tight: '预算吃紧',
      exhausted: '预算用尽',
      disabled: '总闸已关',
    }

    function toneOf(data) {
      return BAL_TONE[data?.state] ?? 'ok'
    }

    /** 徽章：一行看清「免费 / 已用多少 / 还剩多少」。点开看详情。 */
    function BalanceBadge({ compact }) {
      const { data, loading, error } = useBalance()
      const [open, setOpen] = React.useState(false)
      const tone = toneOf(data)
      const cur = data?.currency ?? 'CNY'
      const today = data?.today ?? {}
      const free = Boolean(data?.free_tier)
      const usedPct = today.used_pct ?? 0
      const barClass = 'dshbal-bar' + (tone === 'warn' ? ' warn' : tone === 'bad' ? ' bad' : '')

      let label
      if (error) label = '余额 ?'
      else if (loading && !data) label = '余额…'
      else if (free) label = `免费档 ∞ · ${today.free_images ?? 0} 张`
      else if (today.budget) label = `${today.paid_cost ?? today.cost ?? 0} / ${today.budget} ${cur}`
      else label = `今日 ${today.paid_cost ?? today.cost ?? 0} ${cur}`

      const title = data
        ? [
            `状态：${BAL_STATE_TEXT[data.state] ?? data.state}`,
            `配置档：${data.active_profile}（${data.active_model}）`,
            free ? '额度：无限（免费档单独计数，不占付费预算）' : `单价：${data.price_per_image} ${cur}/张`,
            `今日免费：${today.free_images ?? 0} 张`,
            `今日付费：${today.paid_cost ?? 0} / ${today.budget ?? '-'} ${cur}，${today.paid_images ?? 0} 张`,
            data.images_affordable_today === null ? '' : `还能出约 ${data.images_affordable_today} 张`,
            data.advice ?? '',
          ].filter(Boolean).join('\n')
        : '查看余额 / 花费'

      return React.createElement(React.Fragment, null,
        React.createElement('button', {
          className: `dshbal-btn tone-${tone}`,
          title,
          onClick: () => setOpen((v) => !v),
        },
          React.createElement('span', null, free ? '🎁' : '💰'),
          React.createElement('span', { className: 'amt' }, label),
          // 面板头部里已有项目/结论筛选条，空间紧张时不画进度条
          !compact && !free && today.budget
            ? React.createElement('span', { className: barClass }, React.createElement('i', { style: { width: Math.min(100, usedPct) + '%' } }))
            : null),
        open ? React.createElement(BalancePanel, { onClose: () => setOpen(false) }) : null)
    }

    function balCard(key, k, v, s, tone) {
      return React.createElement('div', { className: 'dshbal-card' + (tone ? ' ' + tone : ''), key },
        React.createElement('div', { className: 'k' }, k),
        React.createElement('div', { className: 'v' }, v),
        s ? React.createElement('div', { className: 's' }, s) : null)
    }

    /** 详情：本地闸门 + 上游账户 + 各配置档单价。 */
    /**
     * 余额主体（头部 + 内容）：浮层版与整页版共用，避免两处漂移。
     * @param {{onClose?:Function, page?:boolean}} props
     */
    function BalanceContent({ onClose, page }) {
      const { data, loading, fetchRemote } = useBalance()
      const [remoteLoading, setRemoteLoading] = React.useState(false)
      React.useEffect(() => {
        if (!onClose) return undefined
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      React.useEffect(() => {
        let alive = true
        setRemoteLoading(true)
        fetchRemote().finally(() => { if (alive) setRemoteLoading(false) })
        return () => { alive = false }
      }, [])

      const body = []
      if (loading && !data) body.push(React.createElement('div', { className: 'dshimg-empty', key: 'l' }, '读取中…'))
      if (data) {
        const cur = data.currency ?? 'CNY'
        const today = data.today ?? {}
        const tone = toneOf(data)
        body.push(React.createElement('div', { className: 'dshbal-advice ' + tone, key: 'adv' },
          React.createElement('b', null, BAL_STATE_TEXT[data.state] ?? data.state),
          React.createElement('span', null, ' ｜ ' + (data.advice ?? ''))))

        // 本地：免费与付费分开看（免费=无限额度，单独计数）
        body.push(React.createElement('div', { className: 'dshbal-grid', key: 'g1', style: { marginTop: '12px' } },
          balCard('c0', '免费档产出', `∞ ${today.free_images ?? 0} 张`,
            `不占付费预算｜${today.free_runs ?? 0} 次`, 'ok'),
          balCard('c1', '今日付费花费', `${today.paid_cost ?? 0} ${cur}`,
            `${today.paid_images ?? 0} 张｜${today.date ?? ''}`),
          balCard('c2', '日预算（付费）', today.budget ? `${today.budget} ${cur}` : '不限',
            today.used_pct === null ? '未设上限' : `已用 ${today.used_pct}%`),
          balCard('c3', '付费剩余', today.budget ? `${today.remaining ?? 0} ${cur}` : '—',
            free ? '当前是免费档，不占预算' : (data.images_affordable_today === null ? '—' : `还能出约 ${data.images_affordable_today} 张`),
            tone === 'exhausted' ? 'bad' : tone === 'tight' ? 'warn' : null)))

        // 上游：能查到多少算多少，绝不把占位值当余额
        const r = data.remote
        const remoteNodes = []
        if (!r) remoteNodes.push('未查询')
        else if (!r.ok) {
          remoteNodes.push(`查不到：${r.error ?? '未知原因'}`)
          remoteNodes.push(React.createElement('div', { className: 'dshbal-muted', key: 'rn' }, '（很多服务商/中转站不提供计费接口，属正常）'))
        } else {
          remoteNodes.push(React.createElement('div', { className: 'dshbal-muted', key: 'r1' },
            `服务商 ${r.provider || '-'} ｜ 接口 ${r.base_url}`))
          const rows = [
            ['账户余额', r.balance_available ? `${r.remaining_usd} USD` : '无真实余额（免费/内部额度）'],
            ['额度上限', r.limit_is_placeholder ? '占位值（非真实额度）' : `${r.hard_limit_usd ?? r.soft_limit_usd} USD`],
            ['累计用量', r.total_usage_usd === null ? '取不到' : `${r.total_usage_usd} USD`],
            ['绑定支付方式', r.has_payment_method === null ? '未知' : r.has_payment_method ? '已绑定' : '未绑定'],
          ]
          remoteNodes.push(React.createElement('table', { className: 'dshbal-table', key: 'rt' },
            React.createElement('tbody', null, rows.map(([k, v]) => React.createElement('tr', { key: k },
              React.createElement('th', null, k), React.createElement('td', null, String(v)))))))
          if (r.note) remoteNodes.push(React.createElement('div', { className: 'dshbal-muted', key: 'rn', style: { marginTop: '6px' } }, r.note))
        }

        body.push(React.createElement('div', { className: 'dshbal-sect', key: 's2' },
          React.createElement('h4', null, '☁️ 上游账户', remoteLoading ? '（查询中…）' : ''),
          ...remoteNodes))

        // 各配置档单价：一眼看出哪个免费
        const profileRows = data.profiles ?? []
        if (profileRows.length > 0) {
          const head = React.createElement('tr', null,
            React.createElement('th', null, '配置档'),
            React.createElement('th', null, '模型'),
            React.createElement('th', null, '单价'),
            React.createElement('th', null, '备注'))
          const rows = profileRows.map((p) => React.createElement('tr', {
            key: p.id,
            className: p.is_active ? 'on' : '',
          },
            React.createElement('td', null, p.id + (p.is_active ? ' ●' : '')),
            React.createElement('td', null, p.model),
            React.createElement('td', null, p.price_per_image === 0 ? '免费' : `${p.price_per_image} ${cur}`),
            React.createElement('td', null, p.price_declared ? '配置档自定义' : '全局默认')))
          const table = React.createElement('table', { className: 'dshbal-table' },
            React.createElement('thead', null, head),
            React.createElement('tbody', null, rows))
          body.push(React.createElement('div', { className: 'dshbal-sect', key: 's3' },
            React.createElement('h4', null, '📋 各配置档单价'),
            table))
        }

        // 闸门状态
        const lockRows = [
          ['总闸（只挡付费）', data.locks?.spend_disabled ? '已关：付费调用会被拒绝（免费档不受影响）' : '开着'],
          ['单次最多', `${data.locks?.per_run_max_images ?? '-'} 张（免费档同样受此保护）`],
          ['确认锁（只对付费）', `付费超过 ${data.locks?.confirm_above_images ?? '-'} 张需 confirm=true`],
          ['日预算（只算付费）', data.locks?.daily_budget ? `${data.locks.daily_budget} ${cur}` : '不限'],
          ['当前单价', data.price_per_image === 0 ? '免费 → 无限额度、单独计数' : `${data.price_per_image} ${cur}/张`],
        ].map(([k, v]) => React.createElement('tr', { key: k },
          React.createElement('th', null, k),
          React.createElement('td', null, v)))
        body.push(React.createElement('div', { className: 'dshbal-sect', key: 's4' },
          React.createElement('h4', null, '🔒 花钱闸门'),
          React.createElement('table', { className: 'dshbal-table' },
            React.createElement('tbody', null, lockRows))))
      }

      const headNode = React.createElement('div', { className: 'dshimg-head' },
        React.createElement('span', { className: 'dshimg-title' }, '余额 · 花费 · 额度'),
        React.createElement('button', { className: 'dshimg-x', onClick: () => fetchRemote() }, '刷新上游'),
        onClose ? React.createElement('button', { className: 'dshimg-x', onClick: onClose }, '关闭 Esc') : null)
      const bodyNode = React.createElement('div', { className: 'dshimg-body' }, body)
      if (page) {
        return React.createElement('div', { className: 'dshimg-page' },
          React.createElement('style', null, styles), headNode, bodyNode)
      }
      return React.createElement('div', { className: 'dshimg-ov' },
        React.createElement('div', { className: 'dshimg-panel dshbal-panel' },
          React.createElement('style', null, styles), headNode, bodyNode))
    }

    /** 浮层版（头部徽章点开用）。 */
    function BalancePanel({ onClose }) {
      return React.createElement(BalanceContent, { onClose })
    }

    /** 整页版（左侧栏「余额」用）—— 与生图/生视频一致的主区域页面。 */
    function BalancePage() {
      return React.createElement(BalanceContent, { page: true })
    }

    /** 「生视频」按钮：紧跟在「生图」下面。 */
    function VideoButton() {
      const [open, setOpen] = React.useState(false)
      return React.createElement(React.Fragment, null,
        React.createElement('button', {
          className: 'dshimg-btn',
          title: '生成视频（Agnes Video 2.5 Flash，异步）',
          onClick: () => setOpen((value) => !value),
        }, React.createElement('span', { className: 'dot alt' }), '生视频'),
        open ? React.createElement(VideoPanel, { onClose: () => setOpen(false) }) : null)
    }

    const PLUGIN = 'dsh-gpt-image'

    function apply(ctx) {
      // 余额徽章排在最前（order 29），让「还能不能花钱」一眼可见
      ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: PLUGIN + '-balance',
        order: 29,
        label: () => '余额',
      }, BalanceBadge)), `${PLUGIN}: 会话头部余额徽章`)

      // 对话/轨迹那一行的按钮：生图 + 生视频（order 紧挨着，视频排在生图下面）
      ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: PLUGIN,
        order: 30,
        label: () => '生图',
      }, ImagesButton)), `${PLUGIN}: 会话头部按钮`)

      ctx.effect(() => ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: PLUGIN + '-video',
        order: 31,
        label: () => '生视频',
      }, VideoButton)), `${PLUGIN}: 会话头部生视频按钮`)

      // 左侧栏图标 + 主区域整页（最显眼的入口）
      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: 'balance',
        order: 29,
        label: () => '余额',
      }, BalanceIcon)), `${PLUGIN}: 侧栏余额图标`)

      // 自动化页：让 L–R 组的能力不再只有 AI 能调
      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: 'auto',
        order: 32,
        label: () => '自动化',
      }, AutoIcon)), `${PLUGIN}: 侧栏自动化图标`)

      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: 'gallery',
        order: 30,
        label: () => '生图',
      }, PanelIcon)), `${PLUGIN}: 侧栏图标`)

      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: 'video',
        order: 31,
        label: () => '生视频',
      }, VideoIcon)), `${PLUGIN}: 侧栏生视频图标`)

      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: 'gallery',
      }, GalleryPage)), `${PLUGIN}: 主区域生图页`)

      // 关键：侧栏 'video' 必须能对上一个 main 面板，否则点了「选不中」（表现为没反应）
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: 'video',
      }, VideoPage)), `${PLUGIN}: 主区域生视频页`)

      // 同理：侧栏 'balance' 也要有对应 main 面板
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: 'balance',
      }, BalancePage)), `${PLUGIN}: 主区域余额页`)

      // 侧栏 'auto' 的对应 main 面板
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: 'auto',
      }, AutoPage)), `${PLUGIN}: 主区域自动化页`)
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
