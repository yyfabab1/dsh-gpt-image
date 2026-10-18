/**
 * 素材发现器：让 AI「自己根据游戏内容和情况」列出需要哪些素材。
 *
 * 两个来源，互补：
 *  1) 静态扫描真实项目：代码/HTML 里引用了但磁盘上没有的图（missing，最高优先级）
 *     + 已有素材的分类统计（避免重复造）
 *  2) 玩法/题材规则表：从项目描述、README、代码关键词判断游戏类型，
 *     给出该类型「通常缺什么素材」的清单（带英文提示词骨架，模型只需补风格）
 *
 * 输出永远是「建议」，最终提示词由模型改写；插件只负责把信息找齐、把上下文压小。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { safeSegment } from '../util.js'

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target', '.next',
  '.cache', '__pycache__', '.venv', 'venv', 'vendor', 'Library', 'Temp', 'obj', 'bin', '.idea', '.vscode',
])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp', '.tga'])
const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac'])
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.html', '.htm', '.css', '.scss', '.json', '.lua', '.py', '.md', '.txt', '.yml', '.yaml', '.xml', '.gd', '.cs', '.java', '.c', '.cpp', '.h'])
const ASSET_REF = /["'`(./\\]([\w@./\\-]*[\w-]\.(?:png|jpe?g|webp|gif|svg|bmp|mp3|wav|ogg))["'`)]/gi

export const GENRE_RULES = [
  {
    id: 'tower-defense',
    label: '塔防',
    match: /塔防|防御塔|tower\s*defen[sc]e|td游戏/i,
    assets: [
      ['tower', 'tower_{element}', 'a defense tower, {element} themed, top-down view, game sprite', '每种防御塔都要能一眼区分属性和等级'],
      ['enemy', 'enemy_{type}', 'a marching enemy unit, {type} archetype, top-down view, game sprite', '每种敌人（小怪/精英/BOSS）都要有独立形象'],
      ['projectile', 'projectile_{type}', 'a small projectile / bullet / magic orb, top-down view, game sprite', '不同塔的弹道效果需要区分'],
      ['effect', 'effect_explosion', 'explosion / impact effect, game VFX sprite sheet', '命中反馈决定打击感'],
      ['tile', 'tile_path', 'seamless ground tile for a tower defense lane', '地图至少要能拼出道路与可建造区'],
      ['tile', 'tile_buildable', 'seamless buildable grass tile for tower defense', '可建造区域要与路面区分'],
      ['ui', 'icon_coin', 'flat game UI icon: gold coin', '经济/生命/波次是塔防的三大 HUD'],
      ['ui', 'icon_heart', 'flat game UI icon: life heart', '同上'],
      ['ui', 'icon_wave', 'flat game UI icon: enemy wave indicator', '同上'],
    ],
  },
  {
    id: 'rpg',
    label: '角色扮演',
    match: /rpg|角色扮演|修仙|剧情|回合制|地牢|dungeon/i,
    assets: [
      ['portrait', 'portrait_{character}', 'character portrait / bust, half body, {character} description, consistent art style', '对话与队伍界面必须有立绘或头像'],
      ['sprite', 'sprite_{character}_idle', 'top-down or side-view character sprite, idle pose, transparent background', '场景里角色要有可辨识的小人'],
      ['monster', 'monster_{name}', 'enemy monster creature, game sprite, consistent art style', '战斗对象'],
      ['icon', 'skill_icon_{skill}', 'game skill icon, square, flat with soft shading', '技能栏图标'],
      ['icon', 'item_icon_{item}', 'inventory item icon, square, readable silhouette', '背包/掉落物'],
      ['ui', 'ui_frame_panel', 'ornamental UI panel frame, fantasy style, nine-slice friendly', '对话框、商店、背包都复用同一套 UI'],
      ['ui', 'ui_dialog_box', 'dialogue box UI, bottom bar, fantasy ornament', '对话界面'],
      ['tile', 'tile_{biome}', 'seamless top-down terrain tile, {biome} biome', '地图瓦片'],
      ['logo', 'title_logo', 'game title logo placeholder, no text or placeholder text', '主菜单标题'],
    ],
  },
  {
    id: 'platformer',
    label: '平台跳跃',
    match: /平台(跳跃|游戏)|platformer|跳跃游戏|马里奥|metroidvania/i,
    assets: [
      ['character', 'player_idle', 'side-view platformer character, idle animation keyframe, transparent background', '玩家动作帧是平台跳跃的核心'],
      ['character', 'player_run', 'side-view platformer character, running keyframe', '同上'],
      ['character', 'player_jump', 'side-view platformer character, jumping keyframe', '同上'],
      ['enemy', 'enemy_{type}', 'side-view platformer enemy, {type}', '敌人'],
      ['tile', 'tile_ground', 'seamless platformer ground tile, side view', '地形'],
      ['tile', 'tile_wall', 'seamless platformer wall tile, side view', '地形'],
      ['collectible', 'collectible_coin', 'collectible pickup sprite, spinning coin', '收集物反馈'],
      ['background', 'bg_layer_far', 'parallax background layer, far, {scene}', '视差背景分层'],
      ['background', 'bg_layer_near', 'parallax background layer, near, {scene}', '同上'],
      ['ui', 'icon_pause', 'flat game UI icon: pause', 'HUD'],
    ],
  },
  {
    id: 'shooter',
    label: '射击',
    match: /射击|shoot'?em|弹幕|飞机大战|danmaku|stg|fps/i,
    assets: [
      ['ship', 'ship_player', 'player spaceship / aircraft, top-down view, game sprite', '自机是画面主角'],
      ['enemy', 'ship_enemy_{type}', 'enemy spaceship / aircraft, top-down view, game sprite', '敌机分型'],
      ['projectile', 'bullet_player', 'player bullet projectile, small and bright, top-down', '弹幕可读性'],
      ['projectile', 'bullet_enemy', 'enemy bullet projectile, high contrast, top-down', '同上'],
      ['effect', 'effect_explosion', 'explosion effect sprite sheet', '击破反馈'],
      ['item', 'item_powerup', 'power-up pickup icon, glowing', '升级道具'],
      ['background', 'bg_starfield', 'seamless scrolling starfield background, top-down', '滚动背景'],
      ['ui', 'icon_score', 'flat game UI icon: score / highscore', 'HUD'],
    ],
  },
  {
    id: 'card',
    label: '卡牌',
    match: /卡牌|卡片|card game|构筑|deck ?build|扑克/i,
    assets: [
      ['card', 'card_frame_{rarity}', 'trading card frame, {rarity} rarity ornament, empty center, vertical', '卡面边框是卡牌游戏的门面'],
      ['card', 'card_art_placeholder', 'card illustration, epic scene, vertical composition, no text', '卡面插画占位'],
      ['card', 'card_back', 'card back design, symmetric, ornate', '牌背'],
      ['ui', 'icon_resource_{name}', 'flat game UI icon: {name} resource', '费用/能量等资源图标'],
      ['ui', 'ui_button_primary', 'game UI button, primary, rounded, with states', '交互按钮'],
      ['portrait', 'portrait_{faction}', 'faction emblem / portrait, stylized', '阵营区分'],
    ],
  },
  {
    id: 'rts',
    label: '即时战略',
    match: /即时战略|rts|争霸|星际|基地|建造|unit ?control/i,
    assets: [
      ['unit', 'unit_{faction}_{type}', 'top-down RTS unit sprite, {faction} {type}, readable silhouette', '单位要能从小尺寸分清敌我和兵种'],
      ['building', 'building_{faction}_{type}', 'top-down RTS building sprite, {faction} {type}', '建筑'],
      ['tile', 'terrain_{type}', 'seamless RTS terrain tile, {type}', '地形'],
      ['ui', 'ui_panel_hud', 'RTS HUD panel frame, dark metallic', '指挥界面'],
      ['icon', 'icon_resource_{name}', 'flat RTS resource icon: {name}', '资源栏'],
      ['effect', 'effect_{type}', 'RTS effect: {type} (muzzle flash / build smoke / explosion)', '战斗与建造反馈'],
    ],
  },
  {
    id: 'sandbox',
    label: '沙盒 / 体素',
    match: /沙盒|体素|voxel|minecraft|方块|建造生存/i,
    assets: [
      ['texture', 'block_{name}', 'seamless voxel block texture, {name}, pixel art 16x16', '方块贴图是最小可玩单元'],
      ['icon', 'item_icon_{name}', 'voxel game item icon, {name}', '物品栏'],
      ['creature', 'creature_{name}', 'voxel-style creature sprite, {name}', '生物'],
      ['ui', 'icon_{name}', 'voxel game UI icon: {name}', 'HUD/制作台'],
      ['skybox', 'sky_{time}', 'skybox / sky gradient, {time}', '昼夜氛围'],
    ],
  },
  {
    id: 'visual-novel',
    label: '视觉小说 / 恋爱',
    match: /视觉小说|galgame|文字冒险|恋爱|avg|visual ?novel/i,
    assets: [
      ['character', 'char_{name}_{emotion}', 'anime character sprite, {name}, {emotion} expression, transparent background, half body', '差分表情是 AVG 的核心'],
      ['background', 'bg_{scene}', 'anime visual novel background, {scene}, no characters, wide', '场景背景'],
      ['ui', 'ui_textbox', 'visual novel text box UI, bottom, translucent', '对话界面'],
      ['cg', 'cg_event_{name}', 'event CG illustration, key scene: {name}, no text', '关键剧情插图'],
      ['ui', 'ui_menu_button', 'visual novel menu button, soft style', '菜单'],
    ],
  },
  {
    id: 'casual',
    label: '休闲 / 消除',
    match: /消除|三消|match ?3|合并|merge|休闲游戏|益智|解谜|puzzle/i,
    assets: [
      ['tile', 'gem_{color}', 'match-3 gem tile, {color}, glossy, square, centered', '棋子形态决定可玩性'],
      ['ui', 'ui_board_frame', 'game board frame, rounded, casual style', '棋盘外框'],
      ['ui', 'ui_button_play', 'casual game UI button, big and rounded', '主交互'],
      ['background', 'bg_scene', 'casual game background, soft gradient scene', '背景'],
      ['effect', 'effect_match', 'sparkle effect for matched gems', '消除反馈'],
    ],
  },
  {
    id: 'sim',
    label: '模拟经营',
    match: /模拟经营|经营|simulation|farm|农场|城市建设|management/i,
    assets: [
      ['building', 'building_{name}', 'isometric building sprite, {name}, simulation game style', '建筑是经营游戏的主体'],
      ['item', 'item_{name}', 'isometric / flat item icon, {name}', '商品与资源'],
      ['character', 'npc_{name}', 'cute villager NPC sprite, {name}, isometric', '居民'],
      ['ui', 'ui_panel_shop', 'management game UI panel, cozy style', '经营界面'],
      ['tile', 'tile_ground_{type}', 'seamless isometric ground tile, {type}', '地面'],
    ],
  },
]

const TOKEN_HINTS = [
  [/coin|gold|金币/i, 'gold coin'],
  [/heart|life|hp|血/i, 'health heart'],
  [/sword|剑/i, 'sword'],
  [/shield|盾/i, 'shield'],
  [/potion|药/i, 'potion bottle'],
  [/key|钥匙/i, 'key'],
  [/boss/i, 'boss creature, large and menacing'],
  [/slime|史莱姆/i, 'slime creature'],
  [/goblin|哥布林/i, 'goblin'],
  [/zombie|僵尸|丧尸/i, 'zombie'],
  [/dragon|龙/i, 'dragon'],
  [/tower|塔/i, 'defense tower'],
  [/enemy|怪|敌/i, 'enemy creature'],
  [/hero|player|角色|主角/i, 'hero character'],
  [/icon|图标/i, 'UI icon'],
  [/button|按钮/i, 'UI button'],
  [/bg|background|背景/i, 'background scene'],
  [/tile|瓦片|地形/i, 'seamless terrain tile'],
  [/map|地图/i, 'map / terrain'],
  [/logo|标题/i, 'game logo'],
  [/frame|边框|面板/i, 'UI frame'],
]

function classify(ext) {
  if (IMAGE_EXT.has(ext)) return 'image'
  if (AUDIO_EXT.has(ext)) return 'audio'
  return 'other'
}

function categoryOf(file) {
  const lower = file.toLowerCase()
  if (/icon|ui|按钮|界面/.test(lower)) return 'ui'
  if (/tile|terrain|地形|瓦片|ground|wall/.test(lower)) return 'tile'
  if (/bg|background|背景|sky/.test(lower)) return 'background'
  if (/effect|fx|particle|特效/.test(lower)) return 'effect'
  if (/char|hero|player|npc|角色|立绘|portrait/.test(lower)) return 'character'
  if (/enemy|monster|怪/.test(lower)) return 'enemy'
  if (/item|道具|装备/.test(lower)) return 'item'
  if (/sfx|sound|music|audio|音效|音乐/.test(lower)) return 'audio'
  return 'misc'
}

/** 把文件名/引用路径变成一句可用的英文提示词骨架。 */
export function promptHintOf(ref, fallback = 'game asset') {
  const base = path.basename(String(ref)).replace(/\.[a-z0-9]+$/i, '')
  const tokens = base
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[_\-\s.]+/)
    .filter((token) => token && !/^\d+$/.test(token))
  let hint = ''
  for (const [pattern, phrase] of TOKEN_HINTS) {
    if (pattern.test(base)) {
      hint = phrase
      break
    }
  }
  const subject = tokens.join(' ') || base || 'asset'
  return `${hint || fallback}: ${subject}`.trim()
}

async function walk(root, { maxFiles, maxDepth, files = [], depth = 0, onSkip } = {}) {
  if (depth > maxDepth || files.length >= maxFiles) return files
  let entries = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    if (files.length >= maxFiles) break
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) {
        onSkip?.(full)
        continue
      }
      await walk(full, { maxFiles, maxDepth, files, depth: depth + 1, onSkip })
    } else if (entry.isFile()) {
      files.push(full)
    }
  }
  return files
}

/** 判断题材：描述 + 目录名 + 代码关键词。 */
export function detectGenres(text) {
  const haystack = String(text ?? '')
  return GENRE_RULES.filter((rule) => rule.match.test(haystack))
}

/**
 * 加权打分排序：用户描述 > 设计文档/README > 文件名 > 代码。
 * 代码里顺带出现的词（比如 RTS 工程里提了一句「射击」）不应该把题材清单带偏。
 * @param {{brief?:string, docs?:string, names?:string, code?:string}} segments
 */
export function scoreGenres(segments = {}) {
  const weights = { brief: 4, docs: 3, names: 2, code: 1 }
  const scored = GENRE_RULES.map((rule) => {
    let score = 0
    const hits = {}
    for (const [kind, weight] of Object.entries(weights)) {
      const text = String(segments[kind] ?? '')
      if (!text) continue
      const count = (text.match(new RegExp(rule.match.source, 'gi')) ?? []).length
      if (count > 0) {
        hits[kind] = count
        // 同一段里刷再多也只按 3 次算，避免长文档堆词
        score += weight * Math.min(3, count)
      }
    }
    return { rule, score, hits }
  }).filter((item) => item.score > 0)

  scored.sort((a, b) => b.score - a.score || a.rule.id.localeCompare(b.rule.id))
  const top = scored[0]?.score ?? 0
  // 只留「明显相关」的：绝对分 ≥2，且不低于榜首的一半；最多 3 个题材
  return scored
    .filter((item, index) => item.score >= 2 && (index === 0 || item.score >= top * 0.5))
    .slice(0, 3)
    .map((item) => ({ id: item.rule.id, label: item.rule.label, score: item.score, hits: item.hits, rule: item.rule }))
}

function genreChecklist(genres, limit) {
  const out = []
  for (const genre of genres) {
    for (const [category, nameTpl, promptHint, reason] of genre.assets) {
      if (out.length >= limit) return out
      out.push({
        name: safeSegment(nameTpl.replace(/[{}]/g, ''), 'asset'),
        name_template: nameTpl,
        category,
        genre: genre.label,
        prompt_hint: promptHint,
        reason: `${genre.label}：${reason}`,
      })
    }
  }
  return out
}

/**
 * @param {{root?:string, brief?:string, maxAssets?:number, maxFiles?:number, depth?:number}} options
 */
export async function scanProject({ root = '', brief = '', maxAssets = 24, maxFiles = 3000, depth = 5 } = {}) {
  const suggested = []
  const notes = []
  const existing = { total: 0, images: 0, audio: 0, by_category: {}, samples: [] }
  const missing = []
  let files = []
  let styleContext = brief ? String(brief).slice(0, 1200) : ''
  const dirName = root ? path.basename(path.resolve(root)) : ''

  if (root) {
    try {
      const info = await stat(root)
      if (info.isDirectory()) files = await walk(root, { maxFiles, maxDepth: depth })
      else files = [root]
    } catch (error) {
      return { ok: false, error: `无法读取路径 ${root}：${error.message}` }
    }
  }

  const codeBlobs = []
  for (const file of files) {
    const ext = path.extname(file).toLowerCase()
    const kind = classify(ext)
    if (kind === 'image' || kind === 'audio') {
      existing.total += 1
      if (kind === 'image') existing.images += 1
      else existing.audio += 1
      const category = categoryOf(file)
      existing.by_category[category] = (existing.by_category[category] ?? 0) + 1
      if (existing.samples.length < 12) existing.samples.push(path.relative(root || path.dirname(file), file))
      continue
    }
    if (!TEXT_EXT.has(ext)) continue
    try {
      const info = await stat(file)
      if (info.size > 256 * 1024) continue
      const text = await readFile(file, 'utf8')
      codeBlobs.push({ file, text })
    } catch {
      /* 跳过读不了的文件 */
    }
  }

  // 引用了但磁盘上没有的素材 —— 优先级最高（游戏里就是缺图）
  // 注意：引用路径可能只是相对片段（README 里写 verify/day.png、代码里写 day.png），
  // 所以先按解析路径判断，再按「同名文件是否存在于项目任何位置」兜底，避免误报缺失。
  const allFiles = new Set(files.map((file) => path.resolve(file)))
  const basenames = new Set(files.map((file) => path.basename(file).toLowerCase()))
  const seenMissing = new Set()
  const foundElsewhere = []
  // 只把「游戏运行时代码」里的引用当成真缺口：报告文档、tools/scripts/tests 里的
  // 临时图与中间产物都不算（混进需求池只会白花钱）。
  const TOOLING = /(^|[\\/])(tools?|scripts?|tests?|__tests__|docs?|out|tmp|temp|\.cache|_tmp)([\\/]|$)/i
  const refBlobs = codeBlobs.filter(({ file }) => {
    if (/\.(md|txt)$/i.test(file)) return false
    if (TOOLING.test(file)) return false
    if (/\.(test|spec)\./i.test(path.basename(file))) return false
    return true
  })
  for (const { file, text } of refBlobs) {
    for (const match of text.matchAll(ASSET_REF)) {
      const ref = match[1]
      if (!ref || /^https?:/i.test(ref)) continue
      // 下划线开头的名字基本是脚本里的临时产物，不当素材缺口
      if (path.basename(ref).startsWith('_')) continue
      const resolved = path.resolve(path.dirname(file), ref.replace(/\\/g, path.sep))
      if (allFiles.has(resolved)) continue
      const base = path.basename(ref).toLowerCase()
      if (basenames.has(base)) {
        if (foundElsewhere.length < 10) foundElsewhere.push({ ref, referenced_by: path.relative(root || path.dirname(file), file) })
        continue
      }
      const rel = path.relative(root || path.dirname(file), resolved)
      if (seenMissing.has(rel)) continue
      seenMissing.add(rel)
      missing.push({ ref: rel, referenced_by: path.relative(root || path.dirname(file), file), category: categoryOf(rel) })
    }
  }
  missing.sort((a, b) => a.ref.localeCompare(b.ref))
  if (foundElsewhere.length > 0) {
    notes.push(`有 ${foundElsewhere.length} 处引用只是相对片段（同名文件已在项目里找到），已按「不缺失」处理，例如 ${foundElsewhere[0].ref}。`)
  }

  // 风格上下文：README / 说明 / 描述，用来让提示词风格统一
  if (!styleContext) {
    const doc = codeBlobs.find(({ file }) => /readme|说明|设计|brief|game.?design/i.test(path.basename(file)))
    if (doc) styleContext = doc.text.replace(/\s+/g, ' ').slice(0, 1200)
    else {
      const html = codeBlobs.find(({ file }) => /\.html?$/i.test(file))
      if (html) styleContext = html.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 600)
    }
    if (styleContext) notes.push('风格上下文取自项目内的文档/HTML，请在提示词里延续同一套美术风格。')
  }

  // 关键词判定题材：加权打分（描述 > 设计文档 > 文件名 > 代码），避免代码里的顺带词把清单带偏
  const docsText = codeBlobs
    .filter(({ file }) => /readme|说明|设计|文档|brief|design|docs?\//i.test(file))
    .map(({ text }) => text.slice(0, 6000))
    .join('\n')
  const namesText = [dirName, ...files.map((file) => path.basename(file))].join(' ')
  const codeText = codeBlobs
    .filter(({ file }) => !/readme|说明|设计|文档/i.test(file))
    .slice(0, 12)
    .map(({ text }) => text.slice(0, 1500))
    .join('\n')
  const ranked = scoreGenres({ brief, docs: docsText, names: namesText, code: codeText })
  const genres = ranked.map((item) => item.rule)
  if (genres.length === 0) {
    notes.push('没能从内容和代码里判定具体题材；可补一句玩法/风格描述（brief）再 scan，或用现有素材推断风格。')
  } else {
    notes.push(`题材判定（加权）：${ranked.map((item) => `${item.label}(${item.score})`).join('、')}；分数越高越相关，清单按此顺序给。`)
  }

  for (const item of missing) {
    if (suggested.length >= maxAssets) break
    suggested.push({
      name: safeSegment(path.basename(item.ref).replace(/\.[a-z0-9]+$/i, ''), 'asset'),
      category: item.category,
      priority: 1,
      reason: `代码里引用了 ${item.ref}（来自 ${item.referenced_by}）但文件不存在，属于「游戏跑起来就缺图」`,
      prompt_hint: promptHintOf(item.ref),
      target_path: item.ref,
    })
  }

  const checklist = genreChecklist(genres, Math.max(0, maxAssets - suggested.length))
  for (const item of checklist) {
    suggested.push({ ...item, priority: 2 })
  }

  // 已有素材已经覆盖的分类，提示不要再造
  const covered = Object.keys(existing.by_category)
  if (covered.length > 0) notes.push(`项目里已有这些分类的素材：${covered.join('、')}；建议先做缺失与风格统一的补全，别重复造轮子。`)

  return {
    ok: true,
    root: root || '',
    genres: ranked.map((item) => ({ id: item.id, label: item.label, score: item.score })),
    style_context: styleContext,
    existing,
    missing,
    suggested,
    notes,
    usage: '把 suggested 改写成带风格的最终 prompt（或直接用 prompt_hint 作为骨架），再调 plan → run；missing 里的优先做。',
  }
}
