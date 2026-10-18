# dsh-gpt-image · GPT Image 出图台（DeepSeek Harness 插件）

> 把 **GPT Image Playground**（`gpt-image2ground`）的能力模型搬进 DSH：多服务商 · 多配置档 ·
> 文生图 · 图生图/局部重绘 · 异步任务轮询 · 自定义接口模板 —— 变成 **AI 自己就能调用的工具**。

独立插件，零运行时依赖（只用 `node:` 内置模块），装进 profile 不需要再拉依赖树。

---

## 它和 Playground 的对应关系 · Feature parity

| GPT Image Playground 里的能力 | 本插件里的形态 |
|---|---|
| 多服务商（openai / sb2api 异步 / fal / 自定义） | 内置 3 个模板 + 任意自定义 `provider` 模板 |
| 多配置档（每个档 = 接口 + Key + 模型） | `profiles`（配置档），工具与面板都能增删改、切换激活档 |
| `gpt-image-config.json` 导入导出 | `config` 工具 `import` / `export`，格式完全兼容 |
| 文生图（Images API） | `generate`（`apiMode: images`） |
| Responses API 模式 | `generate`（`apiMode: responses`，`tool_choice: required` + `image_generation` 工具） |
| 图生图 / 刷蒙版局部重绘 | `edit`（`image[]` + `mask`，multipart；Responses 模式走 data URL） |
| 异步提交 + 轮询任务 | `generate ... wait_s=0` 拿 `task_id` → `job` 查状态/继续等 |
| `$profile.model` / `$params.size` 模板占位 | 同一套占位语法 + 路径表达式 `data.*.url` / `result.data.*.b64_json` |
| 「哪张图对应哪句提示词」 | 落盘 `<输出根>/<项目>/<素材名>_序号.png` + `<素材名>.json` + 项目 `图片清单.md` |
| 出图历史 / 预览 | 面板 `/gpt-image`：缩略图 + 提示词 + 参数 + 状态，全部可回看 |

**本插件比 Playground 多的几件事**：

| 能力 | 说明 |
|---|---|
| **自动化编排（L–R）** | 一个 `auto` 工具、36 个 action：声明式流水线（N）；规则引擎+置信度分流（M）；自愈（O）；触发（L）；优化（P）；治理（R） |
| **素材工作室（F–J）** | 一个 `studio` 工具、30 个 action：模板库/变体矩阵/成本（F）；引擎契约·引用完整性·替换影响（G）；并发锁·来源归属·损坏检测·备份回滚（H）；健康度·漏斗·趋势（I）；风格指南·共享库·风格迁移·A/B·图鉴（J） |
| **质量地基（A–E）** | 一个 `quality` 工具、11 个 action：spec 校验+自动修复 / 协调性 / 派生变体 / 图集 / 视觉标签 / 评分路由 / 偏好 / 回归 |
| **素材变化摘要** | 画廊顶部横幅：新增 / 消失 / 内容变化 / 结论失效。首次只建基线；touch 不算变化；清空不刷屏 |
| **审核对比视图** | `C` 进四格对比：原图 / **实时切片** / 游戏实际尺寸 / 相邻帧。键盘流 `←/→` `A/R/P` |
| **批量重处理** | 规则变了但源图没变 → **结论继承、只重切**；失败回滚、孤儿清理、文件锁互斥 |
| **素材目录 + 人工审核** | 画廊以**磁盘为准**（含切片/缩放件/外部产物）。勾选后一键标 合格/不合格/待定 |
| 余额 / 花费 · 免费档无限额度 · ratio · 重试 · 蒙版守卫 · 花钱闸门 | 见下方各节 |

### L–R：自动化编排

#### ⚠ 单机游戏的硬约束（已确认）

**Q1 装机数据回传 / Q2 效果反馈校准 / Q4 玩家数据补货 / P4 自动 A/B / J4 真实 A/B**
—— 这些**全部依赖游戏端回传数据**。单机游戏没有回传通道，所以：

| 功能 | 状态 | 替代方案 |
|---|---|---|
| Q1 使用分析 | ⚠ 降级 | 用**文件级证据**（代码里有没有引用）判断"死重量"，并明确标注这**不是**玩家行为数据 |
| Q2 评分校准 | ❌ 不做 | 没有真实使用数据可校准 |
| P4/J4 A/B | ⚠ 降级 | 保留**实验设计 + 显著性判定**（`ab-design`/`ab-analyze`），数据由你填，**不编造** |
| Q4 补货 | ✅ 本地版 | 只看本地库存（数量/合格数/被引用数） |
| Q3 淘汰 | ✅ 本地版 | 用"未被引用 + 低分 + 过保护期"判定，不依赖玩家数据 |

#### 你指出的冲突，逐个解法

| 冲突 | 解法（已实现） |
|---|---|
| **M2 自动 approve ↔ 责任** | **事后抽查**（确定性 hash 抽样 + 保底至少 1 张）+ **批量撤销**（`review-undo`，撤销本身也留痕可再撤） |
| **Q3 自动淘汰 ↔ H3 备份** | 淘汰计划带 `requires_snapshot: true`；清理**先移到回收目录**而不是直接删 |
| **C1 变体 ↔ 母图结论变更** | **级联失效**（`cascade-plan/apply`）：母图 reject → 派生件**一并驳回**（不让再审一遍） |
| **N5 事务性 ↔ N3 并行** | 事务**按批次**划：某步失败 → 整批中止，不留"一半新一半旧" |
| **L1 监听 ↔ H1 文件锁** | **防抖**（mtime 距今 > 5s）**+ 尺寸二次确认**，写完才读 |
| **L1 监听 ↔ 脚本失控** | **限流**（超量只处理前 N）+ **熔断**（连续 3 轮超量就停） |

#### 你自检的 7 条，全部补上

| 漏项 | 实现 |
|---|---|
| 批量撤销 | `review-undo`：按批次恢复，且**撤销本身也留痕**（可再撤回来） |
| 试运行模式 | 所有破坏性 action 默认 `dry_run=true`；流水线有 `require_dry_run_first` |
| 审核的 undo | 同上（人的操作和机器的一样都进日志） |
| 素材库版本 | `backup` / `restore`（只备份**状态文件**，不备份几万张图） |
| 并发审核协调 | `H1` 心跳锁 + `R3` 权限；冲突由日志可追溯 |
| 权限 | `R3`：**外部脚本不能改审核结论**（未知身份 fail closed） |
| 自动化冷启动 | **M2 降级**：历史样本 < 20 时阈值提高，**全部转人工**，不在没数据时硬猜 |

#### 诚实说明：三件"做不到"的事

| 想做的 | 为什么做不到 | 正确落点 |
|---|---|---|
| L3 定时任务 | 插件**无常驻进程**，DSH 关了就没 | 用 **DSH 任务看板的 cron 卡**每天调一次 `auto action=maintenance` |
| L1 永久目录监听 | 同上（`fs.watch` 只在插件活着时有效） | webhook 主动上报 / git hook / cron 触发**防抖扫描** |
| R2 自动推送告警 | 插件**没有推送通道**（发不了邮件/IM） | `checkAlerts` 出清单，由 cron 卡消费 |

> `auto action=maintenance` 会给出完整维护清单（扫变更→清孤儿→查损坏→悬空结论→健康→备份→告警），
> 配合 DSH 的定时任务就是无人值守的日常维护。

#### 声明式流水线（N1）

```yaml
name: 我的素材流水线
on: [manual, new_asset]
steps:
  - id: postprocess
    use: postprocess
    opts: {defringe: true, sharpen: true}
  - id: slice
    use: slice
  - id: validate
    use: validate
  - id: route
    use: route
  - id: auto_review
    use: auto_review
    opts: {min_confidence: 0.85, sample_after_approve: 0.1}
  - id: install
    use: install
```

改流程改这个配置，**不改代码**。`pipeline-validate` 会检查步骤依赖顺序（`install` 需要 `review` 前置）。

### F–J：从生成到演进的闭环

```
F1 模板 ──→ F2 变体矩阵 ──→ batch 执行 ──→ F3 成本汇总
   ↑                                            │
   │                                            ↓
J1 风格指南 ←── 审核通过 ←── A2 规格/A1 后处理 ←──┘
   │                    │
   ↓                    ↓
J2 共享库          C1 派生变体 → C2 图集
                        │
                   H2 来源登记 / H3 备份 / H1 并发锁
```

| 组 | 关键设计（都是实测踩出来的） |
|---|---|
| **F1** 模板 | 缺变量**保留 `{占位符}`** 而不是静默留空 —— 否则 prompt 少一截却看不出来 |
| **F2** 调度 | 变体是**乘法的**（prompt×尺寸×质量×seed），>50 张给成本预警。每个变体带 seed，好结果能精确复现 |
| **F3** 成本 | 均单价**只看付费张数**（免费图不稀释）；性价比按「记录里被装机名字的比例」折算，而不是"命中一个就算整条都用上" |
| **F4** 反向提取 | 反推的是**可复用风格特征**（颜色/明暗/线条/构图），**不猜"画的是什么"** |
| **G2** 契约 | 自己读文件核尺寸与透明（不是等调用方传） |
| **G3** 引用完整性 | **误报比漏报更糟**：实测被 diag 脚本的产出名（`cdpperf.png`）误报过 36 次。现按**相对游戏目录**的路径判定用途；冗余必须遍历「磁盘上的图」，只遍历代码引用会让它恒为空 |
| **G4** 影响分析 | 给出**具体文件+行号**与风险等级，不说"有引用"这种空话 |
| **H1** 并发锁 | 用**心跳**而不是 `exists()` —— 进程被强杀后锁能自动失效，不会永久卡死 |
| **H2** 来源归属 | 归一化路径（大小写/斜杠）；补登记按「目录+日期」聚类，并**声明这是启发式** |
| **H4** 损坏检测 | 三级：文件头 → **IEND 结尾**（写一半的典型特征）→ 解码 |
| **H3** 备份回滚 | 只备份**状态文件**（审核结论/快照/账本），不备份几万张图。**回滚前先给当前状态留一份** —— 回错了还能回来 |
| **I1–I4** 可观测 | 审都还没审时优先提醒这一点；样本不足就明说"看不出趋势"，不硬给方向 |
| **J4** A/B | **不采集游戏数据**（那要埋点）。只做实验设计与显著性判定，**不编造留存/点击数字** |
| **J5** 图鉴 | 自包含 HTML，可按状态/类别筛选；名字**转义**（防 `<img onerror>` 注入）

### 质量地基（A–E）

核心思路：**把「能不能用」从审美问题降级成技术问题**。

| 组 | 能力 | 关键设计 |
|---|---|---|
| A2 | 规格即代码 | `resolveSpec`：内置默认 → `<游戏目录>/asset-specs.json` → 「待画素材清单.md」→ 显式传入。**能修的修**（尺寸/透明/留白/毛边），**不能修的才报人**（空图/全黑/背景无法确定） |
| A1 | 出厂后处理 | `applySpecFixes` 固定顺序：抠背景 → 去毛边 → 裁留白 → 调色板吸附 → 锐化 → 尺寸归一。先抠再裁（背景透明了包围盒才准），最后缩放（避免锐化放大噪点） |
| B1 | 调色板锁定 + 漂移 | `buildPalette` 按**覆盖张数**排序（跨多张都出现的色才是"这套的底色"）；`paletteDrift` 按「离群色的占比」判 ok/watch/off。取样 <2% 的噪点不参与 |
| B2 | 小尺寸可读性 | **先缩到游戏尺寸再算**（大图上一切清楚，问题只在缩小后暴露）：对比度 p90−p10、有效像素占比、边缘密度 |
| B3 | 动画连贯性 | 相邻帧差 + 首尾闭合 + 全一样。**判"突变"用中位数而非平均值** —— 平均值会被突变本身拉高（实测 0.09/0.08/0.74 → avg 0.30，0.74 只有 2.5 倍，卡在阈值上检不出来；中位数 0.09 → 8 倍，稳定检出） |
| C1 | 派生变体 | 翻转/灰度/染色/受损/高亮。染色**保留明暗结构**（按亮度用目标色重建，不是简单叠色）；受损态用 xorshift32 **确定性**噪点（同 seed 同结果，可复现可测）。**继承源图审核结论** —— 人审 1 张 = N 份产出 |
| C2 | 图集打包 | 同一次计算产出图集与 manifest，天然一致（手工拼容易改了顺序忘改 manifest）。**注意用 `fitted.drawn` 而不是 `fitted.width`** —— 后者是画布尺寸，小图会被误报成"填满整格"，引擎据此放大就错了 |
| D1 | 视觉标签 | 用**确定性图像特征**给可检索标签（横/竖、透明底、主色系、密度、线条感），**不调视觉模型猜"画的是什么"**（慢且不稳）。语义描述只来自 prompt |
| D2 | prompt 血缘 | `lineageOf` 记录可复现参数；`planRegenerate` 派生相邻 seed。**没有 seed 就坦白说"随机、无法复现"**，不假装确定性。注意 `seed: 0` 是合法值，不能用 `||` 兜底 |
| D3 | 评分路由 | 分数构成全可解释（硬伤 −60 / 可读性 −25 / 留白 −15 / 漂移 −20 / 尺寸 −5）。`auto_pass ≥80` / `normal 50-79` / `priority <50`。**auto_pass 不等于"好看"**，只保证技术层面无硬伤 |
| E1 | 偏好学习 | 从合格/不合格记录统计最常用的 provider/model/尺寸；**样本 <5 就说"别急着学"**，不硬给结论 |
| E2 | 回归检测 | 重画后与 `.bak-before-install` 对比质量分；**差 ≤3 判持平**（避免噪声假报变好/变差） |

工具：`quality`（`check`/`batch`/`spec`/`fix`/`coherence`/`animation`/`variants`/`atlas`/`tags`/`preference`/`regression`）

### 审核一次、之后自动到底

人只出现在两个地方：**审核**、**冲突**。其余全自动。

```
生成（本插件 / 外部脚本）
      ↓
  磁盘上的素材
      ↓
  审过？─否→ needsReview ──→ 【人：画廊勾选/对比视图拍板】
      │是                          ↓
      ↓                        approved
  直接用                          ↓
      ↓                   自动切片（继承源图结论）
      ↓                          ↓
      └────────→ needsInstall ←──┘
                     ↓
              install 自动装（无人值守）
```

**队列**（`assets.json.queue`，派生数据、可重算）：

| 队列 | 含义 | 谁处理 |
|---|---|---|
| `needsInstall` | 已合格、待装 | install 自动 |
| `needsReview` | 从未审核 | **人**（唯一必须人的地方） |
| `needsReReview` | 审过但内容变了 → 结论失效 | **人**（重审一次） |

`needsReview` / `needsReReview` **不阻塞**已合格部分的安装。

### 切片规则的歧义（实测踩了三个坑）

网格从哪来？名字 + 清单 + **磁盘观测**三者定，优先级从低到高：

| 例子 | 陷阱 | 处理 |
|---|---|---|
| `t_path_64x16` | `16` 是尺寸高度，不是 16 格 | 排除 `_WxH` 后缀 |
| `i_skull_48` | `48` 是清单声明的规格（48×48） | 结尾数字等于清单宽/高 → 当尺寸 |
| `r67tpath_dark2` | `2` 是版本号，不是 2 格 | 名字只作**候选**，以观测为准 |
| `r67_frames_8` | 名字对，且磁盘上真有 8 个切片 | **观测优先**（`_slices/` 里文件数） |

所以 `<name>_slices/` 里**实际有几个文件**才是事实来源；名字解析只用于"还没切过"的情况。

工具：`assets`（`scan`/`review`/`clear`/`pending`/`changes`/`queue`）、`reprocess`、`quality`
接口：`/api/assets`、`/api/changes`、`/api/compare`、`/api/review`、`/api/reprocess`

### 素材目录与审核（为什么以前看不到很多图）

**根因**：`history.json` 只记录**本插件生成的**图。而输出目录里还有大量图来自别处：

| 来源 | 例子 | 以前 |
|---|---|---|
| 切片产物 | `hero_slices/hero_01.png` | 看不见 |
| 缩放件 | `hero_64x16.png` | 看不见 |
| 带名预览图 | `hero_1_labeled.png` | 部分可见 |
| 截图 | `shot_xxx.png` | 看不见 |
| 别的脚本/agent 批量产出 | `r67rest_cardart_28.png` | 看不见 |

实测本机：**目录里 916 张，本插件只记了 235 张 → 681 张是"只在文件夹里"的**。

现在画廊改为**扫磁盘**，全部列出来，并给每张分类（`source` / `slice` / `resized` / `preview` / `screenshot`），
顶部两排筛选条可按「类别」与「审核状态」过滤。

**一件勾选**：

| 按钮 | 作用 |
|---|---|
| 全选本页 | 勾选当前筛选结果的全部 |
| 选未审核 | 只勾还没拍板的（逐批清最快） |
| 选外部产物 | 只勾不是本插件生成的（那批历史遗留） |
| ✓ 标为合格 / ✕ 标为不合格 / ? 标为待定 | 对已勾选项批量写结论 |
| 清空选择 | 取消勾选 |

审核结论**按素材名也记一份**，所以「重画同名的图」会继承你之前的判断（按文件路径的单独结论优先）。

数据落在 `~/.dsh/gpt-image/assets.json`，与 `history.json` 分开 —— 前者是"人工判断"，后者是"生成记录"，
生命周期不同（重画不清掉结论，改结论也不动生成记录）。

**给 AI 的约定**（`assets` 工具 `guidance` 里会明说）：

- 挑素材给游戏用 → **优先 `review=approved`**
- `unreviewed` 未经人确认，`rejected` 不要用
- `kind=preview`（画面里带名字）与 `kind=screenshot` 是给人看的，**不要装进游戏**

工具：`_dsh_external_dsh_gpt_image_assets`（`scan` / `review` / `clear` / `pending`）
接口：`GET /gpt-image/api/assets`、`POST /gpt-image/api/review`、`POST /gpt-image/api/review-clear`

### 花钱闸门：免费与付费分开算

**免费档（单价 0）的语义是「无限额度」** —— 这是刻意的，因为 0 元没有可防的东西：

| 锁 | 付费档 | 免费档 |
|---|---|---|
| `dailyBudget` 日预算 | 超了就拒 | **不参与**（付费额度用尽也照样跑） |
| `confirmAboveImages` 确认锁 | 超过要 `confirm` | **不触发**（0 元没什么可确认的） |
| `spendDisabled` 总闸 | 拒绝 | **不受影响**（它是"付费总闸"） |
| `perRunMaxImages` 单次张数 | 生效 | **同样生效** —— 这是请求体量保护，与钱无关 |

免费档在 `check()` 返回值里会明说 `free: true`、`quota: 'unlimited'`、`remaining_today: null`，
并在 `skipped_locks` 里列出「本次跳过了哪些锁」，避免用户疑惑「为什么没拦我」。

**记账也是分开的**（`spend.json`）：

```jsonc
{
  "records": [ { "images": 5, "cost": 0,    "free": true  },   // 免费：只记张数
               { "images": 3, "cost": 0.12, "free": false } ],  // 付费：记张数 + 金额
  "totals": { "free": { "images": 5, "runs": 1 },
              "paid": { "images": 3, "runs": 1, "cost": 0.12 } }
}
```

- `todayFree()` / `todayPaid()` 分开取；`todaySpent()` 只算付费（免费恒 0 元，天然不挤占预算）。
- 旧记录没有 `free` 字段时按金额推断，所以历史数据不会算错。

> ⚠️ **闸门按「本次实际使用的配置档」算价，不是激活档。**
> 否则「激活档是免费 + 显式指定付费档」会绕过日预算与确认锁 = 漏钱。
> 7 处闸门调用都传 `pricePerImage: priceForProfile(state, args.profile)`，并有回归测试钉住。

### 余额显示怎么看

| 看到 | 含义 |
|---|---|
| `🎁 免费档 ∞ · 3 张` | 当前是免费档：无限额度，今日已免费出 3 张（不占付费预算） |
| `💰 0.20 / 1 CNY` + 进度条 | 付费档：今日已花 / 日预算；条子变黄 = 用到 80%，变红 = 用尽 |
| 状态「预算用尽」 | 付费档会被拦下；等明天、调高 `locks.dailyBudget`，或切免费档 |
| 状态「总闸已关」 | `spendDisabled=true`，付费调用被拒（免费档不受影响） |
| 上游「无真实余额（免费/内部额度）」 | 该账户额度上限是**占位值**（如 1e8），不是真余额 —— 插件不会把它伪装成余额 |

> 为什么分两块看：**本地闸门才是真正会拦住出图的**（真实生效）；上游账户计费多数中转站不提供接口，
> 且免费档的「额度」是占位数字。所以插件以本地为主、上游为参考，并在详情里如实标注来源。

工具：`_dsh_external_dsh_gpt_image_balance`（`check_remote=false` 只看本地不联网）
接口：`GET /gpt-image/api/balance`（`?remote=0` 跳过上游查询，面板轮询用）

**自动纠错**：`baseUrl` 少写 `/v1`（中转站最常见的坑）时，先按原样请求，404 自动补 `/v1` 重试；
`probe` 还会直接告诉你「建议把 baseUrl 改成 xxx」。

---

## 省钱工作流：攒够一批再生成 · Accumulate, then spend

单价按 **0.04 元/张** 计（`pool.json` 里可改 `pricePerImage`），插件的工作方式是**先攒后花**：

```text
scan(root="D:\AHC\doomsday-ember")
  → 体检：还缺 16 张素材 → 只登记进「需求池」，一张都不生成
pool(action="show")            → 待生成 16 张 · 阈值 8（卡牌类 12）· 现在跑要花 0.64 元
pool(action="flush", dry_run=true)  → 只规划：冷启动先 1 张探针、本轮最多几张、预计花费
pool(action="flush", confirm=true)  → 到阈值才一次性跑，跑完自动从池子划掉
install(root="D:\AHC\doomsday-ember")  → 按规格缩放(保留透明) → 写进游戏 → 立刻复核尺寸与引用
screenshot(mode="window", window="<游戏窗口>", attach=true)  → 重大改动后截图给用户看
```

**两道花费闸门**：①没到阈值不给跑（除非 `force=true`）；②一批超过 `autoSpendLimit`（默认 0.5 元）
必须显式 `confirm=true`。所有预估都写在返回里，先看数字再决定。

**`install` 解决的正是黑屏**：模型只能出 1024 级别大图，游戏要 40×60 这种规格；手工缩放很容易做出
几百字节的空图（`wx_clear_tile_40x60.png` 就是 450 字节 → 黑屏）。`install` 统一按规格缩放
（保留 alpha，实测 1024×1536 → 40×60 透明 3.4KB）→ 落到游戏真正读的位置（同名文件先备份
`.bak-before-install`）→ 复核，未登记的还会告诉你差哪一步。

---

## 多花钱的三个真 bug（已修 · Money-leak fixes）

自查真实使用数据时发现的三处「钱会漏掉」的地方，都已修好并有回归测试：

| 问题 | 后果 | 现在 |
|---|---|---|
| 判停用「已成功张数」 | 失败的张数不算数 → 整轮顶出上限，多花 | 改成按**已尝试张数**判停（失败也烧钱），并在返回里给出 `images_attempted` |
| 时间预算用平均耗时 | 实测 141s/最慢 214s 时，按 141s 排量 → 超时那部分白花 | 取**最慢值**估算（`estimateLatencyMs`），排不完整的不排 |
| 普通失败不会停批 | 只认限流；连续报错时会一直撞着烧钱 | 连续 3 波有失败就停（`repeated-failures`），并退回 1 路并发 |
| 单张生成不查重 | 同一句提示词再发一次 = 白付一次 | 生成前**指纹预检**，命中直接跳过（`skipped_duplicate`, `spent: 0`），要重画才带 `force=true` |

实测：拿历史里 `starcraft-rts / flag_terran` 的原参数再要一次 → `skipped_duplicate = true, spent = 0`，直接复用已有产物。

另外：**硬规定不允许静默失效** —— 「画面内带名字」的预览图如果没做出来，
返回里会明确给出 `label_warning` + `label_errors`，不再悄悄跳过（你的历史里曾有 3/8 张没标签）。

---

## 第四轮：审批流 + 跨项目风格 + 图标集批量生成

### 1. 资产预算审批流（`approval`）

四道锁拦的是「单次张数/日预算」，但**一次 5 元、10 元的大批采购属于"要跟人商量"的量级**，单独拎出来：

```
batch(assets=[...6 个...], confirm=true)
  → needs_approval: true，返回待批准单（没花任何钱）
【待批准】batch · demo
  要花：0.24 CNY（6 张）
  用途：塔防第一批通用素材
  画什么：tower_fire、tower_ice、enemy_grunt、enemy_boss、icon_coin、icon_heart
  影响范围：src/game.js
  单号：apr_861af39046ac6d8c

approval(action="approve", token="apr_861af39046ac6d8c")
  → 已批准。把 approved_token 传给对应工具就会执行。
```

- **面板上点确认**：新增「待批准」标签页，直接点批准/驳回；超 24h 未处理会标红
- **单子有签名**：`approvalToken()` 由参数决定 —— **参数变了单子自动作废**（防止批了 A 跑了 B）。实测：6 张批准后放行；改成 7 张立刻出新单号
- 阈值默认 **5 元**，`approval action=set_threshold` 可改；待批准单文本可直接贴进对话

### 2. 跨项目风格对比（`cross_style`）

你怀疑的「两个项目风格差异大」已经量化了，实测输出：

```
doomsday-ember  ↔ starcraft-rts      = 0.243  ← 两套美术语言，别互相参考
starcraft-rts   ↔ workbuddy-deploy   = 0.164  ← 差异最大
workbuddy-deploy↔ 连通性测试          = 0.496  ← 风格接近，可共享参考
警告：检测到跨项目风格差异明显：生成时请只用「同项目」的素材当风格参考。
```

配套**强制约束**：挑参考图时若没指定项目，直接**拒绝跨项目挑**（`cross_project_blocked`）——宁可没有参考图，也不要串味。面板新增「跨项目风格」页。

### 3. 图标集批量生成（`sheet`）· 切图后自动对齐

你说得对，你们本来就有这个习惯（`147_whole`、`r42_cardart_sheet`）。现在做成工具：

```
sheet(items=[9 个图标描述], project="tower-defense")
  → 1 个请求出 1536×1024 合集图 → 自动按 3×3 切开 → 每个图标自动对齐 → 缩放到游戏规格
  → requests_used: 1, requests_saved: 8
```

**切图默认自动对齐**（`trim: true`），交付的是「能直接用的图标」而不是「格子」：

| 步骤 | 说明 |
|---|---|
| ① 连通域分析 | 洪水填充找出每格里的图形块（4 邻域，迭代式不爆栈） |
| ② 抗噪 | 丢掉落单的孤立像素/碎块（实测：角落 1 个杂点被识别为 `dropped_specks: 1`，不会把包围盒撑满整格） |
| ③ 取主体包围盒 | 用最大连通域 + 附近的大碎块合并，得到图标真实边界 |
| ④ 居中缩放 | 裁掉多余留白 → 按 `target_width`/`target_height` 等比 `contain` 居中（或 `stretch`），四周补透明 |
| ⑤ 质量判断 | 主体占比过小/没找到主体的格子给 `warnings`，不硬裁成垃圾 |

实测（故意做了一张「图标大小不一、位置歪、还有空格子」的合集图）：

```
icon_1  格内 100×100 → 内容 20×20  → 输出 48×48  居中偏差 0.0/0.0
icon_2  格内 100×100 → 内容 60×40  → 输出 48×48  内容画成 48×32 垂直居中
icon_3  格内 100×100 → 内容 30×15  → 输出 48×48
icon_4  格内 100×100 → 内容 40×60  → 输出 48×48  内容画成 32×48 水平居中
icon_5  空间格子                       → 警告「没找到图标主体」
icon_6  格内 100×100 → 内容 25×25  → 输出 48×48
```

**过程中修掉一个真 bug（坐标系）**：`contentBox` 返回的是「格内相对坐标」，
跨格裁剪必须先用 `absoluteBox()` 转成整图绝对坐标 —— 第一版混用了，导致
图标被裁到角落甚至整张全透明（测试图里 `icon_3`/`icon_6` 空白）。现在两个坐标系显式分开，
并有专门的回归测试（`tests/autotrim.test.js`）锁死。

参数：`trim`（默认 true）、`target_width`/`target_height`（缩放规格）、`mode`（contain/stretch）、
`padding`（格子内缩）；`items` 支持逐格指定尺寸（`[{name:"icon",width:48,height:48}]`）。

### 本轮新增工具（3 个，共 20 个）

| 工具 | 作用 |
|---|---|
| `_dsh_external_dsh_gpt_image_approval` | 待批准清单：`list` / `approve` / `reject` / `set_threshold` |
| `_dsh_external_dsh_gpt_image_sheet` | 图标集：`generate`（出图+切）/ `slice` / `grid` |
| `_dsh_external_dsh_gpt_image_cross_style` | 跨项目风格对比与污染预警 |

---


### 优化

| # | 优化 | 说明 |
|---|---|---|
| 1 | **修好参考图打分的死代码** | 之前 `resolveStyleRefs` 里有个空分支，指纹匹配**从没真正生效**。现在用统一的 `scoreReference` 打分：分类一致(2.5) + 宽高比(1.5) + 风格指纹(4) + 尺寸接近(1) —— 竖版卡牌不会再被塞一张横版背景当参考 |
| 2 | **使用热度去噪** | `_labeled` 预览图、`_fixed` 副本、`.bak` 不再算成独立素材（否则会误报"白花钱"）；同一素材的多尺寸去重成一个 |
| 3 | **热度视图给全** | 新增 `warm`（被引用但不多）与 `all`（完整列表）。之前只有 `hot`(≥5次) 和 `cold`(0次)，用到的素材可能两个视图都找不到 |
| 4 | **自检结果回流提示词库** | 废图自动进避坑清单（带原因），好图进可复用模板 —— 实测你项目已自动记下 2 条避坑（全黑/空图那两条提示词） |

### 新扩展

| 扩展 | 工具 | 价值 |
|---|---|---|
| **一键工作台** | `pipeline` | 把「取素材 → 生成 → 自检 → 装机 → 登记」串成一条命令。素材来源自动选（需求池 → 顺序计划）。**自检发现废图直接停下不装机**（装进去只会黑屏），并给该重画哪几张 + 原提示词。实测 dry_run：`assets-from-pool` → 规划 4 张 / 313s |
| **提示词库** | `prompts` | 记录每条提示词的成功/失败次数与原因。`action=lookup` 生成前先查；`good` 拿可复用模板；`pitfalls` 看避坑清单 |
| **使用热度** | `heatmap` | 哪些生成出来的图**真被游戏代码用到**、哪些零引用（=白花钱）。实测你项目：5 个去重素材里 **3 个零引用**（`waste_ratio: 0.6`）|
| **花费预测** | `config action=spend` 里的 `plan_forecast` | 「这批 24 张约 0.96 元，今天只够 20 张，建议分 2 天」+ 预算还能撑几天 |

### 本轮修掉的 3 个真 bug

1. **`heatmap` 缺 import** → `checkProject is not defined`，工具直接报错
2. **`review` 用错字段** → `result.reviewed is not iterable`（实际字段是 `suspects`/`good_files`）
3. **热度把预览图当素材** → 会把 `xxx_labeled.png` 报成"白花钱"

---


| # | 优化 | 效果 |
|---|---|---|
| 1 | **热启动** | 学习粒度从「模型+尺寸+质量」放宽到「服务商+模型」：换尺寸/质量不再重新冷启动 1 张探针，只有真·第一次才探针 |
| 2 | **真实单价校准** | `config action=calibrate images=12 actual_cost=0.48` → 反推单价并写回，之后所有预算/估算都按真实价算；也能从上游 `usage.total_cost` 等字段自动采信 |
| 3 | **失败重试上限** | 同素材最多重试 1 次（可重试错误才重试：限流/超时/5xx），带退避；**重试同样计入已尝试张数**，不会偷偷超额 |
| 4 | **风格指纹** | 扫全项目给每张图算指纹（主色板/明暗/饱和度/线条密度/透明占比），生成时按「像不像」挑参考图，并把量化风格拼进提示词 |
| 5 | **`order` 生成顺序** | 从代码里解析素材依赖，按「先通用件（UI框/图标底板/地形）、后具体件（立绘/卡面/特效）」排批次 —— 避免通用件没定稿就画一堆具体图导致全部返工 |
| 6 | **并行度** | `caps.maxConcurrency` 可调到 3~4；默认从 2 起，成功会自己加、失败自己退 |

## 三项扩展 · Three extensions

| # | 扩展 | 说明 |
|---|---|---|
| 7 | **`review` 出图自检** | 不等模型"看一眼"，先用确定性规则筛废图：几乎单色 / 全黑 / 全白 / 对比度极低 / 没有边缘（画面是空的）/ 该透明却不透明 / 尺寸不符。**实测在你项目里揪出 3 张**（`t_path_1`、`wx_clear_tile_1`、`wx_clear_tile_40x60`）—— 正是黑屏元凶 |
| 8 | **`order` 素材依赖图** | 你的项目实测：169 个素材排成 3 批通用件（ui×3、terrain×22）+ 2 批具体件（effect×14、misc×130） |
| 9 | **`spend` 预算日历** | 按天聚合花费 + 趋势 + 预测日均 + 文本条形图；`config action=spend` 直接看 |

### 新增工具

| 工具 | 作用 |
|---|---|
| `_dsh_external_dsh_gpt_image_style` | `index` 建/更新风格索引 · `show` 看风格档案 · `outliers` 看跑偏素材 |
| `_dsh_external_dsh_gpt_image_order` | 生成顺序计划（先通用后具体） |
| `_dsh_external_dsh_gpt_image_review` | 出图自检，只列可疑的 |
| `_dsh_external_dsh_gpt_image_register` | 写进游戏登记表（`action=install`）/ 审计缺图（`action=audit`） |

### `register` 的一个关键保护

你的 `src/84_assetmap.js` 和 `src/96_rpgasset.js` 文件头写着「由 `tools/build.mjs` 自动生成，**请勿手改**」。
写它们等于白写（下次构建覆盖），所以 `register` 会**识别并拒绝**，同时告诉你该改哪个源文件：

```
84_assetmap.js skipped: 这是构建生成物（文件头写着「build.mjs」），改了会被下次构建覆盖
```

另外 `register` 兼容你项目的真实登记格式：
`"key":{"s":"data:image/png;base64,...","w":40,"h":60,"base":0,"g":"wx","label":"晴天叠加层"}` ——
只替换 `s/w/h`，**保留 `base`/`g`/`label` 等字段**，写前备份 `.bak-before-register`。
`action=audit` 实测：`96_rpgasset.js` 里 **323 项全部填了真图**，没有破图。

---


每次要花钱的调用（generate / edit / batch / pool.flush）都必须先过 [spend.js](lib/spend.js) 的闸门，
记账落在 `~/.dsh/gpt-image/spend.json`：

| 锁 | 默认 | 行为 |
|---|---|---|
| ① 总闸 `spendDisabled` | `false` | 置 `true` = 一切付费调用直接拒绝（急停开关） |
| ② 单次张数 `perRunMaxImages` | `12` | 超过直接拒绝并让你拆批（实测：16 张被拦） |
| ③ 确认锁 `confirmAboveImages` | `1` | 一次要花 **>1 张**就必须带 `confirm=true`（实测拦住） |
| ④ 日预算 `dailyBudget` | `1.0 元/天` | 当天累计 + 本次估算超了直接拒绝（实测拦住） |

查账 / 改锁：

```text
config(action="spend")                                  → 今天几张、多少钱、预算、日历、趋势
config(action="calibrate", images=12, actual_cost=0.48) → 用真实扣费校准单价
config(action="set_locks", patch={"dailyBudget":2})     → 改预算
config(action="set_locks", patch={"pricePerImage":0.03})→ 单价按 3 分算
config(action="set_locks", patch={"spendDisabled":true})→ 急停，别想花我一分钱
```

**需求池只收真缺口**：报告文档、`tools/`、`scripts/`、`tests/`、`out/` 以及 `_` 开头的临时名
全部过滤掉（实测清掉了 36 条垃圾，否则会为文档里的截图白花钱）。

**风格参考**：`generate/batch/pool.flush` 带 `use_style_refs=true` 时，会自动从
**游戏现有素材（同分类优先）→ 本项目已生成的图**里挑 1~2 张当参考图走图生图，
并追加「严格对齐参考图的画风/线条/配色」的提示词；也可显式传 `style_refs=[路径]`。

---


**DSH 里只保留这一个生图插件**（原来的「素材锻造炉」已整体并入本插件，不再单独安装）：

| 入口 | 位置 | 内容 |
|---|---|---|
| **左侧栏「生图」图标** | 左侧图标栏（与其它主面板并列） | 点开是**主区域整页**：项目生图画廊 + 核对结果 |
| 会话头部「生图」按钮 | 对话 / 轨迹那一行的 actions 区 | 同一个画廊的浮层版，`Esc` 关闭 |

画廊里每条都带：

- 缩略图（透明图用棋盘底，一眼看出有没有抠干净）+ 完整提示词 + 模型/尺寸/质量/耗时
- **核对徽章**：`达标` / `规格不符` / `没被引用` / `用不上`
- 核对明细：游戏要求（尺寸/透明/可平铺）↔ 实际生成，以及**游戏代码里哪些文件引用了它**
- 顶部可选项目、填游戏目录（会记住）、「体检」按钮跑一遍缺什么素材
- 每 5 秒自动刷新，AI 正在出图时能看着一张张冒出来

### 素材核对是怎么判的

| 结论 | 含义 |
|---|---|
| `达标` | 规格符合项目里的清单要求，且游戏代码/工具里确实引用了 |
| `规格不符` | 尺寸对不上（例如清单要 `40×60`，生成的是 `1024×1536`）——**缩放裁剪后再登记** |
| `用不上` | 缺透明通道，或文件小到只有几百字节（空图/纯色图）——**游戏里就是黑屏/空白的直接原因** |
| `没被引用` | 图本身没问题，但游戏代码里没有任何引用，或只在清单/报告文档里被提到 |

规格要求从项目里的 `待画素材清单.md` 这类表格自动读（`| 素材 | \`key\` | 40×60，透明、可平铺 |`），
引用统计只看代码/配置（md/txt 清单与报告不算「在用」）。

---

## 安装 · Installation

### Windows 一键安装

```cmd
:: 先只检查环境（不改任何文件、不重启）
一键安装.bat check

:: 确认没问题后正式装（会重启 DSH）
一键安装.bat
```

一键脚本会：检查 Windows / Node 20+ / 定位 DSH profile → 自检插件本体（工具数、侧栏配对）→
建目录链接（失败自动改用复制）→ 重启 DSH → 打开 `安装说明.html`。
跳过重启：`set AUTO_NORESTART=1`。脚本本体是 `install.ps1`（UTF-8 BOM），
`.bat` 只做纯 ASCII 启动 —— 因为 `.bat` 里写 UTF-8 中文在 `chcp 65001` 下会被拆成碎命令（实测）。

> **⚠️ 跨机器风险**：只在作者本机（Windows + Node 22）验证过。
> 完整风险清单见 [安装说明.html](安装说明.html)（浏览器打开，含可点击的 API 申请入口）。

### 手动安装

```sh
# 本地路径（目录链接，改代码即时生效）
mklink /J "%USERPROFILE%\.dsh\profiles\web\node_modules\@dsh-external\dsh-gpt-image" "D:\你的路径\dsh-gpt-image"

# 或 npm 包
dsh plugin --profile web add @dsh-external/dsh-gpt-image
```

装完重启 DSH，模型侧会多出 `_dsh_external_dsh_gpt_image_*` 工具，浏览器可开
`http://127.0.0.1:3080/gpt-image` 面板。

### 自检

```cmd
npm test                        :: 666 个测试应全过
node scripts\ inventory.mjs      :: 27 工具 / 32 路由 / 4 侧栏页配对
```

---

## API Key 去哪申请

完整清单（含全部网址、每家文档、免费图床可达性实测）见 **[docs/API_KEYS.md](docs/API_KEYS.md)**，
或者直接浏览器打开 **[安装说明.html](安装说明.html)** —— 那里的按钮点了就跳到官网注册页。

速查：

| 服务商 | 申请地址 | baseUrl / 模型 |
|---|---|---|
| **Agnes AI**（作者在用，图+视频当前免费） | <https://platform.agnes-ai.com> | `https://apihub.agnes-ai.com/v1` · `agnes-image-2.5-flash` / `agnes-video-2.5-flash` |
| OpenAI 官方 | <https://platform.openai.com/api-keys> | `https://api.openai.com/v1` · `gpt-image-2` |
| fal.ai | <https://fal.ai/dashboard/keys> | `https://fal.run` · `openai/gpt-image-2` |

---

## 配置 · Configuration

三种方式等价：

1. **面板**：`/gpt-image` → 配置 → 填 baseUrl / Key / 模型 / apiMode → 保存
2. **工具**：`_dsh_external_dsh_gpt_image_config`（`set_profile` / `set_active` / `import` / `export` / `test` / `set_output`）
3. **文件**：`~/.dsh/gpt-image/profiles.json`

```json
{
  "activeProfileId": "sealin-relay",
  "outputDir": "D:\\AHC\\aishengtu图片地址",
  "customProviders": [],
  "profiles": [
    {
      "id": "sealin-relay",
      "name": "中转站",
      "provider": "openai",
      "baseUrl": "https://sub-proxy-us.65535.space/v1",
      "apiKey": "sk-...",
      "model": "gpt-image-2.5-sunburst",
      "apiMode": "images"
    }
  ]
}
```

从 Playground 迁移：把它的 `gpt-image-config.json` 内容直接丢给 `config` 的 `import`：
```json
{ "customProviders": [], "profiles": [{ "id": "x", "provider": "openai", "baseUrl": "https://.../v1", "apiKey": "sk-...", "model": "gpt-image-2" }] }
```

### 配置档字段

| 字段 | 说明 |
| --- | --- |
| `id` / `name` | 配置档 id 与显示名 |
| `provider` | `openai` / `sb2api-async` / `fal`，或 `customProviders[].id` |
| `baseUrl` | 接口根地址；不带 `/v1` 会自动补（404 时自动重试另一种） |
| `apiKey` / `model` / `apiMode` | 密钥 / 模型 id / `images`（默认）或 `responses` |
| `pricePerImage` | **该档单价（元/张）**。免费档写 `0` → 不触发确认锁、不吃日预算。不写则用全局单价 |
| `responseFormatB64Json` | `true` 时给请求体加 `response_format: "b64_json"`（部分中转站需要） |
| `retries` | 同步接口瞬时故障重试次数（也在工具入参上，默认 2） |

> 自定义字段（如 `pricePerImage`）会被完整保留，不会在 `import`/保存时被丢掉。

### 内置示例：Agnes Image 2.5 Flash

官方目前**免费**（1K/2K/3K/4K 与参考图 $0），接口是标准 OpenAI Images API，
但有两处差异，所以用**自定义 provider** 模板接：

- `size` 用档位（`1K`/`2K`/`3K`/`4K`），要配合 `ratio` 才可预期；精确尺寸会被就近归一化
- `response_format` **必须嵌在 `extra_body` 里**（放顶层直接报错）
- **没有 mask 参数** → 不支持局部重绘（传了会被显式拒绝，不会静默整图重画）

现成配置见 [`examples/agnes-config.json`](examples/agnes-config.json)：

```json
{
  "customProviders": [{
    "id": "agnes",
    "submit": {
      "path": "images/generations",
      "body": {
        "model": "$profile.model", "prompt": "$prompt",
        "size": "$params.size", "ratio": "$params.ratio",
        "extra_body": { "response_format": "url" }
      }
    },
    "editSubmit": {
      "path": "images/generations",
      "body": {
        "model": "$profile.model", "prompt": "$prompt",
        "size": "$params.size", "ratio": "$params.ratio",
        "extra_body": { "image": "$inputImages.dataUrls", "response_format": "url" }
      }
    },
    "result": { "imageUrlPaths": ["data.*.url"], "b64JsonPaths": ["data.*.b64_json"] },
    "supports": { "text2image": true, "image2image": true, "mask": false, "async": false }
  }],
  "profiles": [{
    "id": "agnes-2.5-flash", "provider": "agnes", "model": "agnes-image-2.5-flash",
    "baseUrl": "https://apihub.agnes-ai.com/v1", "apiKey": "",
    "apiMode": "images", "pricePerImage": 0
  }]
}
```

导入：`config` 工具 `action=import` + `path` 指向该文件，然后 `set_active`。

**ratio 与档位 size 的实际输出**（已实测）：`1K` + `1:1`→1024×1024，`9:16`→736×1312，
`16:9`→1312×736，`3:4`→864×1152；`2K` 为对应尺寸翻倍。

---

## 生视频 + 导入图片生成视频 · Video & image-to-video

Agnes Video 2.5 Flash（`agnes-video-2.5-flash`）走**异步任务**接口，和出图不是一条线：

```
POST /v1/videos                       → 拿 video_id
GET  /agnesapi?video_id=…&model_name=… → 轮询到 completed
顶层 url                              → 下载 mp4
```

三种模式（上游是**互斥**的，发错字段直接 400）：

| `mode` | 用途 | 必需媒体 | 不允许出现 |
|---|---|---|---|
| `text` | 纯文生视频 | 无 | `first_frame` / `last_frame` / `images` / `audios` |
| `keyframe` | **导入图片**当首/尾帧（控制起止构图） | 首帧或尾帧至少一个 | `images` / `audios` |
| `reference` | **导入图片**/音频当参考（内容、风格、节奏） | `images` / `audios` 至少一类 | `first_frame` / `last_frame` |

Flash 专属硬限制：`size` 只能是 `"720P"`、`seconds` 是字符串 `"4"`–`"12"`、
`images` ≤ 5 张、`audios` ≤ 3 段、**不支持参考视频**。这些在本地就挡住，不浪费一次配额。

### 关键：Agnes 只收「公网 URL」，本地图片要先传出去

官方明确要求「所有媒体 URL 都应当可由 Agnes AI 服务公开访问」。
所以「导入图片」不是把路径塞进请求就完了 —— 插件会自动把本地素材换成公网 URL。

`first_frame` / `last_frame` / `images` / `audios` **直接填本地绝对路径就行**：

```jsonc
// video 工具
{
  "prompt": "以 <Picture 1> 中的角色为参考，角色在花田中奔跑，低机位跟拍",
  "mode": "reference",
  "images": ["D:\\MyGame\\assets\\hero.png"],   // ← 本地路径，会自动上传
  "seconds": 5
}
```

换公网 URL 的策略链（`lib/upload.js`，逐家试到通）：

| 优先级 | 方式 | 说明 |
|---|---|---|
| 0 | 本来就是 `http(s)://` | 原样使用，不做多余动作 |
| 1 | `publicBaseUrl` | 把 DSH 的 HTTP 服务通过隧道/反代暴露出去 → **素材不外泄给第三方** |
| 2 | `uploadEndpoint` | 自己的图床 / 对象存储（multipart 字段名 `uploadField`，默认 `file`） |
| 3 | 内置免费匿名图床 | `uguu.se` / `litterbox` / `tmpfiles` / `catbox` / `0x0.st`，**临时链接（小时级）** |

配置（不用手改 JSON）：

```jsonc
// config 工具，action=set_upload
{ "patch": { "publicBaseUrl": "https://my-tunnel.example.com" } }
{ "patch": { "uploadEndpoint": "https://myhost/upload" } }
{ "patch": { "clear": true } }   // 回到内置免费图床
```

> **诚实记录 · 实测结论（写这份文档时的真实状态）**
> - 免费匿名图床里，**只有 `uguu.se` 实测可用**：上传 + 回读字节完全一致（478346 B in / 478346 B out，`content-type: image/png`）。
>   `catbox.moe` / `tmpfiles.org` 连不上（境内网络），`0x0.st` 官方已停收（"uploads disabled… AI botnet spam"），`litterbox` 返回 HTTP 500。
> - **真实出片没验证成功**：Agnes 免费档视频队列当时持续 `503 video_queue_full`，
>   连续 25 分钟内 **8 次退避重试全部撞在队列满上**，两条路（`data:` URL / uguu 公网 URL）都没跑到媒体校验那一步。
>   所以「Agnes 能不能取到 uguu 的链接」这件事**至今没有实测结论**，只有文档要求 + 我们对链接做过回读校验。
> - `data:` URL（本地图片内联直传）**既没验证成功也没能证伪**，同样被队列满挡住。代码里会原样放过并给提醒，
>   但**不要指望它** —— 按官方要求走上传才是对的路。
> - 反过来说，有一件事是**实测确认**的：给一个取不到的 URL（`https://example.com/nope.png`）会立刻 `400
>   media URL could not be downloaded or did not return valid supported media`，字段名也指得很准（`param: first_frame`）。
>   说明**上游在创建任务时真的会去拉媒体** —— 公网可访问不是建议，是硬要求。
> - 免费档还有**限流**（`rate_limit_exceeded`）：连续几次调用就会 429，也不是配置问题。
> - 探针脚本：[`scripts/probe-i2v.mjs`](scripts/probe-i2v.mjs)（图床可达性 + data URL）、
>   [`scripts/probe-i2v2.mjs`](scripts/probe-i2v2.mjs)（退避重试到有结论为止）。等队列空了自己跑一遍就能补上这个结论。

### 配置档不用你操心（这一条修的就是那个报错）

以前把它当成错误抛出来：

```
失败：配置档 agnes-2.5-flash（provider=agnes）不是视频服务商。
      在 profiles.json 里加一个 provider 为 "agnes-video" 的配置档…
```

这对用户毫无帮助 —— 他只想用同一个 Agnes Key 生成一段视频。现在自动解析（`resolveVideoProfile`）：

1. 指名的档就是视频档 → 用它
2. 配置里已有视频档 → **自动换过去**，并说明「已自动改用 xxx」
3. 一个视频档都没有，但手上有**同域名**的图片档（同一个 `baseUrl` / `Key`）→ **就地派生**一个视频档并落盘
4. 中转站域名跟 `apihub` 不同、光靠域名永远匹配不上 → 在图片档上声明 `videoProvider` 即可：
   ```jsonc
   { "id": "agnes-relay", "baseUrl": "https://my-relay.example.com/v1",
     "apiKey": "sk-…", "model": "agnes-image-2.5-flash",
     "videoProvider": "agnes-video" }   // ← 声明视频对应关系
   ```
5. 域名对不上且没声明 → **不硬派生**（免得把别家的 Key 拿去调 Agnes），给出可执行的提示

派生的档是普通配置档，`config` 工具 `action=remove_profile` 就能删，完全可逆。

### 面板

侧栏「生视频」页：
- **选本地文件**（浏览器 `POST /gpt-image/api/upload` → 存到 `<数据目录>/uploads/` → 换公网 URL）
- **从已生成的图选**（直接挑出图台里的产物）
- 或**粘贴本地绝对路径 / 公网 URL**
- 导入的素材会显示成 chip（标了落到哪家图床、链接多久失效）

> `multipart` 解析是零依赖手写的（`lib/multipart.js`）。踩过一个坑：分隔符必须按 `\r\n--boundary` 匹配，
> 只按 `--boundary` 找，**文件内容里出现同样字节就会被提前截断**（实测 `a\r\nb--Xc` 被切成 `a\r\nb`）。

---

## 像素画净化 · Pixelize（并入 AIPixelImageConversionTool）

上游项目：[qianmozhiyu/AIPixelImageConversionTool](https://github.com/qianmozhiyu/AIPixelImageConversionTool)（MIT，© 2026 qianmozhiyu）
—— 把 AI 扩散模型生成的**伪像素图**转成规范像素图。这里做了**零依赖 ESM 移植**，接在出厂后处理里。

上游的流水线是 `输入 → 降噪 → 放大 → 网格检测 → 块提取 → 调色板精炼`。移植后保留能确定性跑、
且对游戏素材真正有用的那条主链：

```
整数尺度(runs/GCD) ─┐
                    ├─→ 网格周期 + 相位 ─→ 块核心区取代表色 ─→ 调色板精炼 ─→ 可选 AA 消除
自相关正峰(资格) ────┘
```

### 一个反直觉但很关键的结论：**AI 的「像素风」图大多数根本没有网格**

这是本轮最重要的实测结论，也决定了这个功能该怎么用。

拿本项目 4 张真实的「像素画」产物跑自动检测（`node scripts/diag-real.mjs <文件>`）：

| 图 | 尺寸 | 最佳候选周期的 precision | 自动检测 |
|---|---|---|---|
| `ember-pixel/px_000_1.png` | 1248×832 | **0.28 ~ 0.46** | 拒绝 |
| `ember-pixel/pxset_w_1.png` | 1248×832 | **0.33 ~ 0.55** | 拒绝 |
| `doomsday-ember/Retro_16_bit_pixel_art_*.png` | 1024×1024 | **0.28 ~ 0.51** | 拒绝 |

`precision` 是「网格线上真的有边缘」的比例。**0.3 意味着 70% 的网格线根本没有边缘** ——
那不是网格，只是一张高分辨率插画，画风像素化了而已（放大看就能看出：像素块大小并不一致）。

所以自动检测**拒绝是正确行为**，不是 bug。硬做只会把插画毁成马赛克。同类结论上游也踩过：
他们的实测记录写着 comb 判据「在真实 AI 图上**有害**（把 16px 拉到 4px）」、cornerSubPix 与仿射外推
「在真实图上无显著增益」，三项最终都默认关闭。

**结论：要让像素化真正有用，就得走「指定逻辑分辨率」这条路**（游戏规格本来就该写清楚）。

### 两条路

| 用法 | 说明 |
|---|---|
| `pixel: { width: 32, height: 32 }` | **推荐**。等于「把这张图等分成 32×32 个逻辑像素，每块取核心区代表色」 |
| `pixel: true` | 自动检测网格。只在图确实是「小像素图按整数倍放大」时才成立 |

### 实测效果（同一张图、同一目标分辨率）

以 `ember-pixel/px_000_1.png` 左上角一个单元格（312×208）为例，缩到 48×32：

| 做法 | 颜色数 | 文件 | 观感 |
|---|---|---|---|
| 盒式均值缩放（多数工具的默认） | 526 色 | 6193 B | 糊、发灰、渐变到处都是 |
| 纯最近邻抽点 | 494 色 | — | 丢细节、锯齿不规则 |
| **像素化净化** | **16 色** | **2398 B** | **硬边、色块干净、像真像素画** |

复现：`node scripts/compare-pixelize.mjs "…/px_000_1.png" 0,0,312,208 48 16 8`
（出一组同名 `.naive.png` / `.nearest.png` / `.pixel.png`，都放大 ×8 便于对比看）

### 「真像素」= 一个可判定的定义（不是"看起来像"）

想把「以后像素都是真像素」变成可执行的目标，先把定义写死。**同时满足四条才算真像素**：

| # | 条件 | 判据 | 谁来保证 |
|---|---|---|---|
| ① | **有限色板** | 不透明像素的颜色恰好是调色板里的值，**没有中间色** | pixelize 的调色板精炼 + `enforcePixelPurity` 精确吸附 |
| ② | **硬边** | 不存在抗锯齿混合色（像素夹在两侧邻色之间） | `countBlendPixels`（见下方校准表） |
| ③ | **方块等大** | 是某个**整数倍**的最近邻放大；每一块内部完全同色 | `blocksUniform` + `fitToTarget({integerScale:true})` |
| ④ | **alpha 二值** | 只有 0 和 255，没有半透明 | `enforcePixelPurity` 二值化 |

`pixelPurity()` 逐条判定并给出 `pure / score / reasons / verdict`；`enforcePixelPurity()` 负责**修**（量化→二值化→几何重建为整数倍）。管线最后会跑一次验收：**不纯就强制修，修不好就如实说**（写进 `skipped`，绝不假装是真像素）。

实测一张真实产物跑完整管线：

```
pure        : true
score       : 1
色板        : 16 色，板外像素 0
抗锯齿      : 0 个像素（0.00%）
方块        : 边长 2px（期望倍率 2）
alpha 二值  : true
结论        : 真像素（16 色，2× 整数倍放大）
```

复现：`node scripts/verify-purity.mjs "…/px_000_1.png" 48 96 64 16`

### 这一轮堵掉的 3 个「像素会变假」的洞

1. **非整数倍放大**（最隐蔽的一个）。`fitToTarget` 的 contain 缩放会算出 2.13 倍这种东西，
   于是每个「像素」占 2.13 个物理像素、**大小不一**，画面立刻显脏 —— 而且它**没有中间色**，
   所以抗锯齿判据抓不到它。→ `fitToTarget({ integerScale: true })` 把放大向下取整到整数倍，
   放不满的居中留透明。**这是像素画唯一能接受的放大方式。**

2. **我自己的方块判据写错了。** 第一版把「分块同色」写成「周期重复」
   （比 `line[x]` 和 `line[x%p]` 而不是 `line[x-(x%p)]`），
   于是 2× 最近邻放大的图被判成「没有整数方块结构」。
   修完又冒出一个退化情形：`k == 整个宽度`时「只有一块」，恒真但毫无意义 ——
   于是原生 32×32 被报成「方块边长 32」。两处都已修 + 加回归测试。

3. **抗锯齿判据用错了工具。** 一开始直接复用 `removeAntiAliasing` 的 `touched`，
   但它带一个 `d(a,b) > 0.5` 的门槛，只管「两主色差别很大」的情况；
   真实抗锯齿恰恰常出现在**相近色**之间。实测：合成图里 AA 一个都没数出来（漏检）。
   → 改成直接判定「p 夹在左右/上下两邻色之间」，并**实测校准**参数：

   | 输入（64×64） | 混合色比例 |
   |---|---|
   | 12 色像素画·原生 | 0.83% |
   | 12 色像素画·4× 最近邻 | **0.00%** |
   | 12 色像素画·4× + 1px 抗锯齿 | **12.82%** ← 要抓的 |
   | 随机噪点 | 1.68% |

   阈值取 2%（真像素 2.4 倍余量，抗锯齿超阈 6.4 倍）。校准脚本 `scripts/calibrate-aa.mjs`。
   注意噪点是 1.68% —— **光靠这一项抓不住噪点**，噪点要靠色板纪律（颜色数）抓，两条判据互补。

### 合集图：必须**整图一次**像素化，不能按格各做一次

实测踩到：把一张 1248×832、12 个格子的像素风合集图按 48×32 整体像素化 → 一片糊
（12 个精灵挤进 48×32）。正确做法是**逐格**：

- AI 画的是一**套统一网格**，方块横跨整张图对齐 → 所以必须**整图一次**像素化；
  按格各做一次会让每格各自猜块尺寸，同批素材大小不一；
  而且格子宽（`sheetW/columns`）不一定整除块尺寸，按格采样会让方块**跨格错位**。
- 整图逻辑分辨率 = `columns × perCellW`，之后切图/居中/缩放都在逻辑分辨率上做。
- `sheet(action="generate"|"slice", pixel={width:32,height:32})` —— `width/height` 是**每格**的逻辑像素数。
- **只给 `width` 时，高按格子的宽高比推**（不是等于宽）。格子常常不是正方形
  （1248×832 按 4×4 切 → 每格 312×208），若令高 = 宽，块就变成 9.75×6.5 的**长方形** ——
  那不是像素，是拉伸。真像素画的像素必须等大**且正方形**。
- 也支持 `pixel: true`（纯自动检测网格）。**这条以前会被静默忽略**
  （`Number(true.width)` 是 `NaN`，整个分支被跳过，"我要像素画"石沉大海还没有任何报错），已修。
- 逐格像素化后**每格自己也会跑真像素复核**（`pixel_purity`）。

> **诚实记录 · 实测结果**：拿那张真实的 1248×832 合集图按 4×4 / 每格 32 逻辑像素跑，
> **16 格全部 `pure=false`**（抗锯齿比例 6%~25%）。
> 这不是管线坏了，而是**输入不对**：模型在那 312×208 的格子里画的是**细节丰富的插画**，
> 不是 32×21 的像素画。硬压到 32×21 之后，相邻逻辑像素的颜色会经常落到"两色之间"
> —— 那在定义上就是混合色。
> **结论：后处理救不了"生成时就没按网格画"的图。** 这正是下面第 4 件事的存在理由 ——
> 把网格约束写进提示词，让它**一开始就按网格画**；`pure=false` 这个信号本身就是
> 告诉你"这张得重画，别指望修"。

### 第 4 件事：从**生成阶段**就让它出真像素（"以后"最有效的一步）

后处理只是兜底。真正提高命中率的是**把网格写进提示词**。
`pixelStyleFor()` 的关键不是"pixel art"（这句实测基本没用），而是三件事：

1. **等大**：「strict uniform square pixel grid, every pixel exactly the same size」
2. **可数的行列**：「you can count exactly 32 columns and 32 rows of visible pixels」
   —— 给模型一个可数的目标，比"像素风"稳定得多
3. **硬边 + 一像素一色**：「exactly one flat colour per pixel, no anti-aliasing, no blur」

带 `pixel` 出图时会**自动**把这段补进提示词（原提示词不动），并记进历史的
`pixel_prompt_added` —— 你能查到到底补了什么，不会以为提示词被偷偷改了。
不想要就传 `pixel_prompt: false`。

```jsonc
generate(prompt="火焰塔图标", name="tower_fire", project="td",
         pixel={ width: 32, height: 32, palette: 16 })
// 实际发出去的提示词 = 原提示词 + 网格约束（等大 / 32×32 可数 / 硬边 / 16 色）
```

### 用法

```jsonc
// 1) 出图时直接要像素画（generate / edit 都认 pixel 参数；会自动补网格约束）
generate(prompt="火焰塔图标", name="tower_fire", project="td",
         pixel={ width: 32, height: 32, palette: 16 })   // 逻辑 32×32，16 色

// 2) 已有素材批量补做（默认 dry-run，带 apply 才写盘）
quality(action="pixelize", project="td", names=["tower_fire"], logical_width=32, palette=16, apply=true)

// 3) 写在项目规格里，之后所有该类型的素材自动走像素化
//    <游戏目录>/asset-specs.json
{ "kinds": { "pixel": { "width": 64, "height": 64, "alpha": "required",
                        "pixel": { "width": 32, "height": 32, "palette": 16 } } } }

// 4) 合集图逐格像素化（每格 32×32 逻辑像素）
sheet(action="generate", items=["剑","盾","药水","金币"], name="icons",
      pixel={ width: 32, height: 32, palette: 16 })

// 5) 只检查、不改动：看某张图到底是不是真像素
quality(action="pixelize", file="…\\hero_1.png", logical_width=32)   // 默认 dry-run
```

**幂等**：已经是真像素的图再跑一次，`pixelize` 会识别出「块尺寸和调色板没变化」，
不会二次劣化（`quantizePalette` 在颜色数已 ≤ 目标时直接跳过）。

产出写到 `*.pixel.png` / `*.post.png`，**从不覆盖原图**。

### 移植时踩到并修掉的 3 个真 bug（都是执行出来、不是看出来的）

1. **「是不是整数倍」的容差不能大于半个周期。**
   上游把 `tol` 一物二用（既判「同色」又判「是 scale 的整数倍」）。`tol=12`、`scale=8` 时，
   长度 4 的行程 `round(4/8)=1` → `|4-8|=4 ≤ 12` 被判成命中 —— 于是全是 4 的行程也让 8 拿满分，
   块尺寸被放大一倍、两个像素并成一个。上游靠另外四个判据兜住了，这里直接修掉。

2. **峰值匹配的 F1 会被「运气好」的假周期骗到，必须加自相关资格关。**
   实测（×4 放大 + 抗锯齿）：假周期 6 的 F1 = **0.800**，比真周期 4 的 **0.737** 还高 ——
   因为强边缘峰值只有 7 个且间距不规则，周期 6 恰好落在其中 6 个的 ±1 内。
   自相关一眼看穿：真周期 lag 4 = **+0.25**、lag 8 = **+0.41**，而 lag 6 = **−0.41**（半周期反相关）。
   → 候选周期必须是**自相关正峰**，或者有 runs/GCD 的整数尺度证据。

3. **网格线匹配容差必须固定，不能随周期放大。**
   写成 `tol = period × 0.15` 时，周期 12 的容差变成 ±2，它的网格线能"蹭"到不属于它的峰值，
   precision 虚高到 1.00，把真周期 4 挤掉。网格线定位误差是 ~1px，容差就该是 1px。

另外两个口径问题也一并修了：
- **输出尺寸必须正好等于给定的逻辑尺寸**（曾按相位反算漂成 47×31）。
  显式模式下这本来就不是「检测网格」而是「等分图像」——相位取 0 均匀等分更对。
- **像素化之后要跳过去毛边和锐化**：去毛边是「边缘收 1px」，在逻辑分辨率上做等于把像素画
  吃掉一整圈轮廓；锐化会造出调色板外的颜色，正好破坏刚做好的硬边和有限色板。

### 与上游的差异（刻意的，逐条写清）

| 上游做法 | 这里 | 原因 |
|---|---|---|
| `nl_means` / `tv_chambolle` / `bilateral` 降噪（skimage） | 只提供 3×3 中值，**默认关闭** | 那些是 skimage 的算法，移植不了；不假装等价 |
| CLAHE 对比度增强（skimage） | 不做 | 同上 |
| Spectral Comb / GPA / cornerSubPix / 仿射外推 | 不做 | 上游自己的实测结论是这几项在真实图上**有害或无增益**，默认关闭 |
| 只处理 RGB | **保留 alpha**，核心区中位数 + 阈值二值化 | 游戏素材大量要透明底；真像素画没有半透明（要软边用 `softAlpha`） |
| 只有自动检测 | **显式逻辑分辨率优先**，另支持 `softAlpha` / `output:'origin'` | 规格已知时不需要猜，而且猜不准（见上文实测） |

---

## 项目提示词包 · Prompt Pack（统一画风）

**问题**：同一个项目里分十次出图，每次只写「火焰塔图标」，模型就给你十种画风 ——
有的厚涂、有的描边、有的偏写实。不是模型不行，是你**没把「这个项目长什么样」告诉它**。
项目里本来就有 `asset-specs.json` 管尺寸/透明，但没有东西管**画风**。这个模块补的就是这块。

**做法**：一个项目一个 `prompt-pack.json`，配一次，之后该项目**所有出图自动带上**。

```jsonc
prompts(action="pack-template", project="末日余烬")   // 1. 生成起步模板（不用从零写）
prompts(action="pack-show",     project="末日余烬")   // 2. 看看当前锁了什么
prompts(action="pack-save",     project="末日余烬", pack={ … })  // 3. 保存
```

```jsonc
// <输出目录>/末日余烬/prompt-pack.json
{
  "use": "game asset",                       // 用途（官方建议：声明用途来设定"模式"）
  "style": "统一的暗色废土像素画风，硬边，有限色板，冷灰蓝主色调里点橙色火光",
  "composition": "俯视 45 度，主体居中，左上柔光，边缘微轮廓光",
  "palette": ["#101418", "#2b2f36", "#e0603a"],
  "negative": ["no watermark", "no text", "no extra limbs"],
  "preserve": ["48px 下轮廓仍可辨认", "与本项目其它素材同色板"],
  "transparent": true,
  "characters": { "hero": { "desc": "红发女性雇佣兵，破损护甲，左臂绷带" } },
  "kinds": { "icon": { "composition": "正俯视，纯侧光" } }
}
```

### 组装顺序是有依据的，不是随便排的

顺序照 **OpenAI 官方 gpt-image-2 提示词指南**的「固定顺序」原则：

```
Intended use → 主体（你写的） → 角色锚点 → Art style → Composition → 透明底 → Keep unchanged → Exclude
```

官方原文的三条关键说法（都在那份 cookbook 里）：

- 「按**固定顺序**写提示词：背景/场景 → 主体 → 关键细节 → 约束」，并声明**用途**来设定"模式"
- 「**Character Anchor**：建立一个可复用的角色锚点，锁住外观/比例/服装/气质，之后每张都复用它」
- 「**Constraints**：显式写排除项和不变项（no watermark / no extra text / preserve …）」

所以 `characters` 就是官方说的 character anchor，`negative`/`preserve` 就是 constraints。
透明底那段也是照它的要求写全的（`no scenery / no backdrop / no checkerboard / no background shadow`，
少一项模型就会给你画出棋盘格或投影）。

**来源**：[openai-cookbook · image-gen-models-prompting-guide](https://github.com/openai/openai-cookbook/blob/main/examples/multimodal/image-gen-models-prompting-guide.ipynb)、
[awesome-gpt-image-2](https://github.com/YouMind-OpenLab/awesome-gpt-image-2)、
[awesome-ai-image-generator-prompts](https://github.com/cliprise/awesome-ai-image-generator-prompts)

> **纯加法**：项目里没配包时**一个字都不改**提示词（有测试钉住）。
> 想临时不带包：`generate(..., prompt_pack=false)`。

---

## 尺寸守卫 · 别把白花的钱交给上游

按官方 gpt-image-2 约束在**发请求前**校验 size，不合法的自动吸附到最近合法值：

| 约束 | 值 |
|---|---|
| 最长边 | < 3840px |
| 两边 | 必须是 **16 的整数倍** |
| 长短边比 | ≤ 3:1 |
| 总像素 | 655,360 ~ 8,294,400 |
| 超过 2560×1440 | 官方标注**实验性**，会警告（但不拦） |

**两个很多人不知道的点**：

1. `1000x1000` 是**不合法**的（不是 16 的倍数）→ 自动吸附成 `1008x1008`。
2. **`512x512` 做不到** —— 总像素 262,144 低于下限 655,360。最小可用方图是 **816×816**。
   要小图标就出 1024×1024 再本地缩（用 `pixelize` / `fitToTarget`，本地缩放不花钱）。

为什么值得单独做：尺寸不合法时上游要么 400（白等一次），要么**默默给你一张被裁过的图**（更糟，
你以为出的是 2048²，其实不是，而且没人告诉你）。

---

## 像素化按钮（核对页）

核对页每张素材卡片左下角有「**像素化**」按钮：一键把 AI 的"伪像素图"还原成真像素。

- 默认**保持原尺寸**（整数块最近邻放回）—— 端到端看起来才是"真像素"
- 另存 `*.pixel.png`，**绝不覆盖原图**（原图是花钱买来的）
- 要逻辑分辨率（例如真 8×8）就传 `output: "logical"`
- 路由：`POST /api/pixelize`

> 为什么默认不是逻辑分辨率：auto 检测出来的可能是 8×8，直接给你一个 93 字节的小图，
> 点按钮的人会以为处理坏了。放回原尺寸才是「整块等大、无抗锯齿」的可用外观。

---

## 音效 · 程序化合成（SFX，不依赖任何模型）

`audio(action="sfx")`：16 个预设，**纯 JS 合成 + WAV 编码，零依赖、离线、毫秒级**。

```jsonc
audio(action="sfx-list")                                    // 看全部预设
audio(action="sfx", presets=["coin","laser","explosion"], name="pickup", seed=7)
audio(action="sfx", preset="magic", pitch=-5, brightness=1.4, seed=42, sample_rate=22050)
```

预设：`coin` 金币 · `laser` 激光 · `impact` 撞击 · `explosion` 爆炸 · `whoosh` 挥砍/风 ·
`powerup` 强化 · `hit` 受击 · `jump` 跳跃 · `blip` 提示音 · `alarm` 警报 · `click` 点击 ·
`footstep` 脚步 · `glass` 玻璃碎 · `electric` 电流 · `magic` 魔法 · `noise` 噪声

参数：`duration`（0.05~8s）· `pitch`（±24 半音）· `brightness`（0.1~2）· `seed` · `sample_rate`（8000~48000）· `volume` · `channels`

### 为什么自己做而不是接模型

1. **你机器上没有音效生成模型** —— GPT-SoVITS 是 TTS/换声，YuE2/YingMusic 是音乐，
   VoiceStudio 的 job 类型里没有 sfx。
2. 更重要的是：**像素游戏的经典音效本来就是合成的**。8/16 位时代没有采样库，
   金币声是方波、激光是下滑锯齿波、爆炸是滤波噪声。用模型去"生成"反而容易糊。
3. **确定性**：同 seed 永远得到逐字节相同的文件 —— 可以进版本库、可复现、可回归测试。
   模型生成做不到这一点。

实测：16 个预设全部生成成功，单个耗时 **1–8ms**，共 555 KB。
测试钉住了「不是静音」「不削顶」「结尾淡出」「WAV 头合法」「同 seed 同文件」这五件事。

---

## Best-of-N 择优（关键素材值得多花几倍钱）

`generate(..., best_of=3)`：一次出 N 张，自动打分留最高分，落选的**改名**加 `_落选_` 前缀（不删，可后悔）。

```jsonc
generate(prompt="主角立绘，站姿，正面", name="hero_portrait", best_of=3, best_of_recycle=false)
```

**什么时候值得用**：关键素材（主角立绘、封面、商店主视觉）—— 一张画废了返工成本很高。
**什么时候别用**：批量小图标 —— N 倍成本换不来等价收益。

打分全是**确定性规则**（复用 `review.js`，不额外调模型）：

| 问题 | 扣分 |
|---|---|
| 几乎单色 / 全黑 / 全白 | -45（且判致命） |
| 对比度极低 | -35 |
| 几乎没有边缘（画面是空的） | -30 |
| 要求透明底却没有透明像素 | -20 / -15 |
| 尺寸不符 | -12 |

同分时**保留先生成的那张**（不随机，可复现）。全是废图时如实说"建议重画"并保留第一张占位。

> 它叫"择优"不叫"选美"：只淘汰明显废图，把"能用/不能用"筛掉，剩下的交给人看。
> 不接 AI 审美打分 —— 那要额外花钱、又慢、还不可复现。

---

## 生音频 · 角色配音 / 唱歌 / 作曲（桥接 VoiceStudio）

你机器上已经有一套跑通的语音流水线（GPT-SoVITS 训练 + RVC + Seed-VC + YuE2 作曲），
它在 `127.0.0.1:8756` 上提供了完整的 HTTP API。这里**不重写**，只做三件事：
① 包成 AI 能直接调的工具 ② 把产出**拉进当前游戏项目目录**（和图片素材放一起）③ 失败时说清是"服务没起"还是"任务失败"。

```jsonc
audio(action="roles")                                    // 先看有哪些音色（实测有 26 个）
audio(action="speak", role="阿塔尼斯",                     // ★ 角色配音
      script="[愤怒] 你竟敢骗我！\n[低语] 别出声。")
audio(action="song",  role="阿塔尼斯",                     // ★ 作曲 + 换声演唱
      style="dark ambient orchestral, slow, female vocal, 72bpm",
      lyrics="夜色沉沉，火光将尽…", duration=90, steps=32)
audio(action="sing",  role="阿塔尼斯", song="D:\\曲\\demo.mp3")   // 翻唱现成歌
audio(action="rvc",   role="阿塔尼斯", song="D:\\对白.wav")       // 换声
audio(action="status", job_id="j2b0b8bab")               // 查进度（长任务用 wait_s=0 提交）
```

产出落在 `<输出目录>/<项目>/audio/`，文件名按 `name` 参数。

**实测**（2026-10，真实 VoiceStudio）：`[平静] 这是一次接入验证。` → 建任务 → 48.2 秒完成 →
识别出语气 `calm`、音色相似度 0.7734、2.28 秒音频复制进项目目录。

**几个设计细节**：

- **怎么拿到产出**：任务完成后成品不是从 `/api/job` 下的，而是被写进角色的 `outputs` 列表。
  所以正确做法是「建任务前记下 outputs 数量 → 完成后读角色取新增」—— 这样并发也不会拿错文件。
- **语气标签**：`[愤怒]` 这类中括号标签由 VoiceStudio 自己解析（官方支持的写法），
  工具会把解析结果回报成 `tone_plan`，你能确认"这句话会被怎么念"。
- **服务没起**：默认会自动尝试拉起（`autostart=true`，用它的 `_start_server.py`）；
  拉不起来会明确告诉你"双击 `启动VoiceStudio.bat`"，而不是丢一个 ECONNREFUSED。
- **代理坑**：本机若设了 `http_proxy`，请求 127.0.0.1 会被劫持成"接口明明在跑却连不通"
  （VoiceStudio 作者踩过）。Node 的 fetch 默认不读代理变量，所以这里是安全的；但换 HTTP 客户端要注意。

---

---

## 拆件傀儡 · Cutout Puppet（部件图 → 图集 + 骨骼 JSON）

> **核心认知**：**"拼起来"是运行时按骨骼矩阵绘制，不是让 AI 生成一张拼好的图。**
> AI 负责素材和初版元数据，程序负责精确拼合。所以产物是「图集 PNG + skeleton.json」，
> 游戏运行时读这两样就能拼 —— 而不是一张死图。

```jsonc
// 一条命令：生成部件图 → 切分 → 几何命名 → 自动合拢关节 → 骨架 JSON → 预览器
rig(action="generate", prompt="红发女骑士，皮甲，短剑", layout="positional")

// 已有部件图（不花钱）
rig(action="build",  sheet="D:\\素材\\hero_parts.png", project="末日余烬", name="hero")
rig(action="preview")                        // 生成自包含预览器（可拖关节/改 pivot/改名）
rig(action="pivot",  part="head", pivot_ratio_y=0.95)
rig(action="rename", part="torso", to="chest")
rig(action="export", format="spine")         // generic / spine / dragonbones
rig(action="validate")
```

### 两种版面，强项互补（选错会白忙）

| 版面 | 名字（语义） | 摆放（装配位置） | 说明 |
|---|---|---|---|
| **`positional`**（推荐） | ❌ 靠几何猜 | ✅ **位置即装配关系** | AI 把角色按解剖位置画好，只把四肢拉开几像素。切分按 alpha 连通域，装配位置直接取自图纸几何 |
| `grid` | ✅ 格子↔槽位硬对应 | ❌ 靠模板粗偏移 | AI 摆成 4×4 零件盘。名字精确，但格子里没有位置信息 |

`positional` 的关键性质（有测试钉住）：**所有变换归零时，部件回到它在图纸上的原始相对位置**。
所以"切出来 → 直接拼 → 就是原图那个角色"，不需要猜骨骼偏移。

### 命名是启发式的，而且**必须留人工纠正**

`positional` 版面的名字是用几何规则猜的（顶部居中=头、中段最大=躯干、外侧由近到远=上臂/前臂/手、
下段自上而下=大腿/小腿/脚）。对规范 T-pose 准确率不错，但**它本质是启发式**。

所以本模块的三条红线：
1. **匹配不上就保留原名 + 警告**，绝不硬塞一个看起来合理的名字（那会让层级错得很隐蔽）
2. **预览器必须能改名** —— 名字决定父子关系，改错名字 = 骨架错
3. **AI 给不出精确 pivot**，所以 `autoAssemble` 只做"把关节缝收拢"（单件位移限幅 4% 角色高），
   最终 pivot 一定由人在预览器里拖

### 元数据格式（`skeleton.json`）

```jsonc
{
  "version": 1, "name": "hero", "template": "humanoid", "layout": "positional",
  "atlas": { "image": "atlas.png", "width": 512, "height": 256 },
  "bones": [
    { "name": "forearm_L", "parent": "upper_arm_L", "x": 12.5, "y": -3.2,
      "rotation": 0, "scaleX": 1, "scaleY": 1 }
  ],
  "parts": [
    { "name": "forearm_L", "rect": [64, 0, 20, 44], "pivot": [10, 4],
      "zOrder": 41, "sourceRect": [228, 124, 30, 16] }
  ],
  "drawOrder": ["upper_arm_R", "forearm_R", "…"]   // 按 zOrder 升序
}
```

- `x/y` 是**相对父级**的偏移；`pivot` 是**部件矩形内的像素坐标**（旋转中心）
- `rect` 是它在图集里的位置；`drawOrder` 决定谁压在谁上面
- 运行时：按 `bones` 层级累乘世界变换 → 按 `drawOrder` 绘制 → 每件从 `rect` 取图、以 `pivot` 为原点

### 预览器（自包含单文件）

`rig(action="preview")` 生成 `preview.html`，图集内联成 data URL、骨架内联成 JSON，
**双击就能开，不用起服务器**。里面可以：拖蓝圆转关节、`Shift`+拖改 pivot、左侧改名、
「合拢关节」自动收缝、「导出骨架 JSON」拿回改好的结果。

也有 http 入口（面板里给链接用）：`GET /api/rig-preview?path=<preview.html 的绝对路径>`

### 导出格式

| 格式 | 状态 |
|---|---|
| `generic`（通用 JSON + 图集） | ✅ 自带运行时语义，自己写 20 行就能吃（PixiJS/Phaser/自研引擎都行） |
| `spine` | ⚠️ 结构已按 Spine 3.8 组织并校验，但**没有在真实 Spine 编辑器里导入验证过** |
| `dragonbones` | ⚠️ 同上（DragonBones 5.5 结构） |

> 说实话：Spine / DragonBones 的图集打包有自己的规范（`.atlas` / `_tex.json`），
> 本插件给的是 `rect` 信息 + 适配后的骨架 JSON。**先用编辑器导入跑一遍再谈能用**。
> Godot / Unity 建议直接用 `generic` —— 它们的原生格式差异大，直出容易错，
> 给一份能跑的运行时脚本比给一份"看起来像"的私有格式靠谱。

---

---

## 引擎适配层 · Engine Adapter（素材 → 引擎真的能读的配置）

前面几层做到「图能进游戏」，这一层做到「**配置也能进游戏**」。

### 这层为什么存在（从开源模组编辑器学来的）

参考了几个成熟的游戏模组编辑器（铁锈战争生态：
[RustedWarfareCodingTool](https://github.com/promissame/RustedWarfareCodingTool)、
[RustAssistantRebuild](https://github.com/Cold-Mint/RustAssistantRebuild)、
[RustedWarfare-ModEditor](https://github.com/CLRedfield/RustedWarfare-ModEditor)、
[RustPad](https://github.com/Xer0c-Xon/RustPad-Specialized.Rusted.Warfare.Modding.Tool.)）——
它们的设计高度一致，而且共同点是**都不是靠堆代码，而是靠一份数据化的「代码表」**：

> RustedWarfareCodingTool 的 `data/code_table.json` 有 **538KB**，结构是
> **段 → 分组 → 字段**，每个字段带：代码名 / 中文名 / 说明 / 示例 / 类型。
> 另外还有 21 个枚举、69 个「取值词表」、174 个地图码。

这份字典一次性支撑了四件事：

| 用途 | 怎么用 |
|---|---|
| **生成** | AI 按字典填字段，不会瞎编字段名 |
| **校验** | 类型/必填/范围/枚举/引用全部可判定，报错**带稳定错误码**（它们用 E001–E130） |
| **文档** | 中文名 + 说明直接就是表单标签和悬浮提示，不用另写一份 |
| **补全** | 输入时按字典补 |

反过来说：**字典不数据化，这套东西就只能手写 if-else** —— 游戏加一个字段就要改代码。

### 我们的实现

```jsonc
adapter(action="list")                    // 已装的字典

// 从别人的代码表导入（不 vendor 别人的数据：体积/许可/版本漂移都不合适）
adapter(action="import-schema", code_table="D:\\rw_code_table.json",
        schema_id="rusted-warfare", label="铁锈战争 v1.15")

adapter(action="schema", schema_id="rusted-warfare")                       // 概览
adapter(action="schema", schema_id="rusted-warfare", section="core")       // 某段有哪些字段

// 按字典生成配置（类型强制 + 枚举校验 + 越界夹取 + 自产自检）
adapter(action="emit", schema_id="rusted-warfare", values={
  core: { name: "ai_tank", displayText: "AI坦克", maxHp: 260, showInEditor: "是" }
})

// 诊断已有配置（稳定错误码）
adapter(action="lint", schema_id="rusted-warfare", file="D:\\mod\\units\\tank.ini")

// 素材引用体检（白占体积的 / 引用了但文件不存在的）
adapter(action="health", schema_id="rusted-warfare", game_root="D:\\mod")
```

也可以命令行跑导入：

```cmd
node scripts/import-code-table.mjs D:\rw_code_table.json --id rusted-warfare --label "铁锈战争 v1.15"
```

实测导入真实代码表：**21 段 / 1305 字段 / 43 枚举 / 69 个取值词表 / 284 个内置素材**。

### 错误码（稳定，加规则只往后加）

| 码 | 级别 | 含义 |
|---|---|---|
| E001 / E002 | error | 缺必需段 / 缺必需字段 |
| E003 | warn | 字典里没这个键（自定义键可忽略） |
| E004 | error | 类型不对 |
| E005 | error | 数值越界 |
| E006 | error | 枚举值不存在 |
| E007 | error | **中文冒号**（引擎可能不认） |
| E008 | warn | 列表里用了中文逗号 |
| E009 / E010 | error | 同段重复键 / 重复的段 |
| E011 | error | 悬空引用（引用的目标不存在） |
| E012 | error | 颜色格式不对 |
| E013 | warn | 键放错段 |
| E014 | error | 语法不对 |

`adapter(action="codes")` 能列出全部。

### 一条设计红线：**校验器的价值由误报率决定**

那些模组编辑器都专门列了「**不误报清单**」，认得真实写法：
`${...}`、`self.xx`、`max(0, sin(...))`、`price: 8000,蓝晶=2100`、`delay: 2.2s`、
`mutator30_ifUnitWithTags`、`@copyFromSection`、`dont_load: true`、`*.template`。

道理很直接：**一个动不动就报错的校验器会被用户直接关掉，那它等于不存在。**
所以本模块的 `tolerant` 清单命中就放过，宁可少报一条也不制造假警报。

另外 `health` 会把「代码可用内置图像」这类词表当**白名单** ——
配置里写 `beam1.png` 是引擎自带的，不能报"文件缺失"（否则一屏假警报）。

### 诚实边界

- **没有 vendor 任何别人的数据**。字典要你自己用 `import-code-table.mjs` 从官方/社区代码表导入；
  vendor 一份 500KB 的数据既不合规也会立刻过期。
- **只做了 ini 文本格式**（那类游戏的主流格式）+ JSON。其它格式要加 emitter。
- **`deploy` 刻意没做一键写游戏目录** —— 写错目录等于污染工程，所以工具只把文件写进
  `<输出目录>/<项目>/adapter/`，进游戏目录那一步留给你确认。
  （`deployFiles()` 函数本身有 dry-run + 自动备份，想接可以自己接。）

---

## 工具 · Tools

| 工具 | 作用 |
|---|---|
| `_dsh_external_dsh_gpt_image_list` | 服务商与能力矩阵、配置档（打码）、激活档、输出目录、最近记录 |
| `_dsh_external_dsh_gpt_image_generate` | 文生图；可带 `assets` 一次出多个素材 |
| `_dsh_external_dsh_gpt_image_edit` | 图生图 / 局部重绘：`image` 或 `images[]` + `mask` |
| `_dsh_external_dsh_gpt_image_batch` | 批量出图：指纹去重 + 容量规划 + 波次执行 |
| `_dsh_external_dsh_gpt_image_pipeline` | ★一键工作台：取素材 → 生成 → 自检 → 装机 → 登记 |
| `_dsh_external_dsh_gpt_image_scan` | 素材体检：缺什么 + 达不达标 + 有没有被引用 |
| `_dsh_external_dsh_gpt_image_pool` | 需求池：攒够阈值再生成（省钱闸门） |
| `_dsh_external_dsh_gpt_image_install` | 按规格缩放并装进游戏 |
| `_dsh_external_dsh_gpt_image_register` | 写进游戏登记表 / 审计缺图 |
| `_dsh_external_dsh_gpt_image_review` | 出图自检（揪废图） |
| `_dsh_external_dsh_gpt_image_style` | 风格索引 / 档案 / 跑偏检测 |
| `_dsh_external_dsh_gpt_image_order` | 生成顺序（先通用后具体） |
| `_dsh_external_dsh_gpt_image_heatmap` | 使用热度（哪些白花钱） |
| `_dsh_external_dsh_gpt_image_screenshot` | 截图给用户看 |
| `_dsh_external_dsh_gpt_image_job` | 异步任务查/等 |
| `_dsh_external_dsh_gpt_image_video` | **生视频 + 导入图片生成视频**：`text` / `keyframe`（首尾帧）/ `reference`（参考图）；`first_frame` / `images` 直接给**本地路径**即可（自动换公网 URL）；配置档自动解析 |
| `_dsh_external_dsh_gpt_image_quality` | 质量地基：spec 校验修复 / **`pixelize` 像素画净化** / 协调性 / 变体 / 图集 / 标签 / 评分路由 |
| `_dsh_external_dsh_gpt_image_prompts` | 提示词库 + **项目提示词包**（`pack-show` / `pack-save` / `pack-template` / `pack-validate` / `pack-list`）—— 统一画风 |
| `_dsh_external_dsh_gpt_image_audio` | **生音频**：角色配音 `speak`（支持 `[语气]` 标签）/ 作曲演唱 `song` / 翻唱 `sing` / 换声 `rvc`·`seedvc` / `status` |
| `_dsh_external_dsh_gpt_image_rig` | **拆件傀儡**：部件图 → 图集 + 骨骼 JSON（`generate` / `build` / `pivot` / `rename` / `export` / `preview` / `validate`）—— 运行时按骨骼拼合 |
| `_dsh_external_dsh_gpt_image_adapter` | **引擎适配层**：字段字典驱动 —— `import-schema` / `schema` / `emit` 生成配置 / `lint` 稳定错误码诊断 / `health` 素材引用体检 |
| `_dsh_external_dsh_gpt_image_config` | 配置 / 花费 / 校准 / 锁 / `set_upload`（素材上传方式） |

示例（AI 自己就能这么调）：
```text
generate(prompt="像素风塔防的火焰塔，俯视，游戏素材", project="tower-defense", name="tower_fire",
         size="1024x1024", quality="low", n=4)

edit(prompt="把背景换成雪山夜景", image="D:\\games\\art\\hero.png", project="rpg", name="hero_night")

generate(prompt="一张海报", project="poster", wait_s=0)   → 拿到 task_id
job(task_id="task_abc", action="wait")                    → 完成并落盘

# 导入本地图片生成视频（不用先自己传图床）
video(prompt="以 <Picture 1> 的角色为参考，在花田中奔跑，低机位跟拍",
      mode="reference", images=["D:\\games\\art\\hero.png"], seconds=5)
video(prompt="角色自然转身走向窗边，镜头缓慢推进", mode="keyframe",
      first_frame="D:\\games\\art\\hero.png", last_frame="D:\\games\\art\\hero_end.png")
```
```

**落盘规则**
```
<输出根>/<项目>/<素材名>_1.png        图片本体（n>1 依次 _2 _3 …）
<输出根>/<项目>/<素材名>.json         这张图用的完整参数（提示词/模型/参数/来源）
<输出根>/<项目>/图片清单.md           该项目所有图 ↔ 提示词对照表
```

---

## 自定义服务商（换中转站不用改代码）

`provider` 就是一套声明式模板，和 Playground 的 `http-image` 模板同构：

```json
{
  "id": "my-relay",
  "name": "我的中转站",
  "submit": {
    "path": "images/generations",
    "method": "POST",
    "contentType": "json",
    "body": {
      "model": "$profile.model",
      "prompt": "$prompt",
      "size": "$params.size",
      "quality": "$params.quality",
      "n": "$params.n"
    },
    "taskIdPath": "task_id"
  },
  "editSubmit": {
    "path": "images/edits",
    "method": "POST",
    "contentType": "multipart",
    "files": [{ "field": "image[]", "source": "inputImages", "array": true }, { "field": "mask", "source": "mask" }]
  },
  "poll": {
    "path": "images/tasks/{task_id}",
    "intervalSeconds": 3,
    "statusPath": "status",
    "successValues": ["completed"],
    "failureValues": ["failed"],
    "errorPath": "error.message"
  },
  "result": { "imageUrlPaths": ["data.*.url"], "b64JsonPaths": ["data.*.b64_json"] }
}
```

- 占位符：`$prompt` `$profile.model` `$profile.baseUrl` `$params.*`；整串占位会保留原始类型（数字/布尔），取不到就**丢弃该字段**
- 路径插值：`{task_id}`（会 URL 编码）
- 结果提取：`data.*.url`（`*` 通配展开、数字下标），b64 优先于 url
- 内置模板：`openai`（同步 Images API）、`sb2api-async`（异步提交+轮询，结果在 `result.data.*`）、`fal`

---

## 与 dsh-asset-forge 的分工 · With dsh-asset-forge

| | `dsh-gpt-image`（本插件） | `dsh-asset-forge` |
|---|---|---|
| 定位 | **出图台**：协议驱动，把 Playground 的能力做成工具 | **素材锻造炉**：批量规划与素材发现 |
| 强项 | 改图/蒙版、异步任务、Responses 模式、自定义服务商、多配置档、历史面板 | 一次能安全生成多少的容量规划、指纹去重、浪费账本、题材素材发现、ComfyUI 批量 |
| 一起用 | forge 规划「这个游戏缺什么、一次跑几张」，再用本插件出图/改图 | |

---

## 测试 · Tests

```sh
npm test     # 557 个用例：协议模板、占位符、结果提取、异步轮询、Responses、落盘、导入导出、
             #            视频（含导入图片生成视频）、multipart、上传换公网 URL、配置档自动派生、
             #            像素画净化（网格检测 / 块提取 / 调色板 / AA 消除 / **真像素判定与强制** /
             #                      整数倍缩放 / 合集图逐格像素化 / 提示词网格约束）…
```

测试全程用本地假上游（`node:http`），零成本、零外网依赖；真机验证用 `node scripts/probe.mjs`（只花 1 张）。

> **`npm test` 曾经只跑 11 个文件里的 378 个用例。** `package.json` 里把测试文件一个个列全了，
> 结果 `tests/` 下另外 12 个文件（`client` / `spend` / `pool` / `check` / `projects` / `round3` / `round4` …）
> **一个都没跑**，而 `client.test.js` 里已经有 3 条断言过期了（还在断言「侧栏必须正好一个面板」）。
> 现在改成 `node --test "tests/*.test.js"`：全量 557 条，一条不落。
> 这件事本身是个教训 —— **测试清单一旦手写就会腐烂**，要 glob。

## 目录结构 · Layout

```
dsh-gpt-image/
├── lib/
│   ├── index.js     插件入口（注册工具 + 面板）
│   ├── client.js    ★ 客户端半边：对话头部「生图/生视频/余额」+ 侧栏 5 页（含生音频）
│   ├── protocol.js  ★ 协议引擎：provider 模板 / 占位符 / 结果路径表达式
│   ├── api.js       ★ 请求驱动：images · responses · multipart 改图 · 异步轮询 · /v1 自愈
│   ├── run.js       编排：读参考图 → 出图 → 落盘 → 写清单 → 记历史
│   ├── video.js     ★ 生视频：异步建任务 → 轮询 → mp4 落盘；配置档自动解析 + 媒体换公网 URL
│   ├── pixelize.js  ★ 像素画净化 + **真像素判定（pixelPurity / enforcePixelPurity）**
│   ├── prompts.js   pixelStyleFor / pixelPromptSuffix（把网格约束写进提示词）
│   ├── upload.js    ★ 本地文件 → 公网 URL（策略链：自建前缀 / 自配端点 / 免费图床）
│   ├── multipart.js ★ 零依赖 multipart 解析（面板「导入图片」用）
│   ├── store.js     配置档（Playground 配置互导）+ 出图历史
│   ├── tools.js     30 个工具
│   ├── server.js    面板 /gpt-image（36 个路由）
│   └── util.js      HTTP / 路径安全 / 同源栅栏
├── tests/           557 个用例（25 个文件，`npm test` 走 glob 全量）
├── scripts/probe.mjs            真机 1 张探针
├── scripts/probe-i2v*.mjs       真机探针：导入图片生成视频（data URL / 图床可达性）
├── scripts/diag-real.mjs        真机诊断：某张图到底有没有网格（打印 precision/F1/ACF）
├── scripts/try-pixelize.mjs     真机试跑像素化（可强制逻辑分辨率 / 调色板）
├── scripts/compare-pixelize.mjs 视觉 A/B：朴素缩放 vs 像素化，放大 ×8 便于看
├── scripts/verify-purity.mjs    真机验收：跑完整管线并判定「是不是真像素」
├── scripts/calibrate-aa.mjs     抗锯齿判据的参数校准表（改阈值前先跑它）
├── docs/playground-protocol.md  从 GPT Image Playground 源码提取的完整协议规格
├── cordis.patch.yml · market-entry.json · icon.svg
```

## 加入插件市场 · Market

同 `dsh-asset-forge`：市场目录来自 `github.com/awesome-dsh-plugin/awesome-dsh-plugin`，
用本仓库的 [market-entry.json](market-entry.json) 提一个 PR 即可（需要 `url`/`category`/`description` en+zh/`npm`）。

## 许可证 · License

MIT

---

## 合集图（sprite sheet）的两个坑 · 第七十三轮实战教训

> 来源：用本插件给一个 509 张卡牌的像素游戏批量出图，**全量装完才发现**问题。
> 这里的改动就是为了让**下一次不用再踩**。

### 坑 1：`pure transparent background` 写了也没用，格子照样被填成平底

模板里一直写着 "Pure transparent background"，但**像素风/图标风的格子经常被模型填成一块平底**
（浅灰、米色…）。切出来的每张图带一块不透明底板，装进游戏就是
**「一块灰方块 + 一个偏在一边的小图标」**。

使用者的第一反应是报**「位置错乱」**——而真因其实是**底没抠**，
并且因为底板把「内容包围盒」撑到整格，**后面的居中/缩放等于没做**。

### 坑 2：模型会在格子之间画网格线，被切进每一格变成直条纹

模板写了 `no grid lines`，**它照画**。按固定行列切图时，那条线就落在每格的边上，
成为一道**直条纹**；同样会把包围盒撑满整格。

### 修法：`computeSlices` 里默认加一步「格子卫生」（`clean: true`）

```js
const computed = computeSlices({ decoded, items, columns, rows, clean: true })
// 每个 slice 上会多一个 hygiene: { keyed, rounds, skipped, why, cut }
```

| 步骤 | 做什么 | 保护条件（不会吃掉正常内容） |
|---|---|---|
| `keyOutFlatBackground()` | **多轮**洪水填充：从格子边界扩散，把"连得通的平底"置为透明；抠完一轮**重算包围盒再从包围盒边界抠下一轮** —— 因为模型常画成「外层留白 + 一块颜色略不同的内层底板」 | 边界标准差太大（不是平底）⇒ 整个跳过；某轮抠掉超过 88% ⇒ **撤销该轮** |
| `trimEdgeStripes()` | 收掉「贴边 + 整行/整列全不透明 + 颜色均匀」的边线 | 只在最外 12% 范围内收，且至少保留 30% 尺寸 |

抠底用**两个容差**，缺一不可：
- **全局容差**（默认 70）—— 与边框中位色的差，放宽以容忍平底上的渐变；
- **邻域容差**（默认 12）—— 与**相邻像素**的差。**像素画是硬边，跨不过去**，而渐变能跟住。

> 真正防止吃掉主体的是**邻域容差 + 88% 安全阀**，不是"边界平不平"那个标准差。
> 实测把标准差阈值从 62 放松到 120，主体会被啃出洞——**别动它**。

### 实测效果（本项目真实合集图 4×4，16 格）

| | 四角不透明（没抠干净）的格子数 |
|---|---|
| `clean: false`（旧行为） | **16 / 16** |
| `clean: true`（新行为） | **1 / 16** |

负对照成立：旧行为确实 16/16 都是脏的，新行为才降到 1。

### 附：像素风配方（`PIXEL_ART_STYLE`）

**只写 `pixel art` 是没用的** —— 实测模型照样给写实厚涂。必须把话说死：

```js
import { PIXEL_ART_STYLE, SHEET_HYGIENE_NOTE } from './lib/prompts.js'
// 句首 PIXEL ART ONLY + 一串否定约束 + 限色板，才能稳定出真像素画
```

完整的字符串见 `lib/prompts.js`。要点：`PIXEL ART ONLY` / `chunky clearly visible square pixels` /
`hard pixel edges` / `no anti-aliasing` / `no smooth gradients` / `limited 24-colour palette`。

### 一条流程建议

**别等全量装完再验收**。先切 1 张合集图 → 用**品红底**把切片合成一张图看一眼
（透明处会露品红，一眼看出哪张没抠干净）→ 确认没问题再铺量。
本项目就是全量 509 张装完才发现的，白跑了一轮验证。

### 坑 3（补）：横杠 / 竖杠 —— 模型画的网格线和工具的固定行列**不对齐**

前两个坑修完之后，使用者仍然报**「有横杠」**。查出来是第三个坑，而且比前两个更隐蔽：

**模型会画自己的一套网格线，而且它的格距/边距是它自己定的，
跟工具按 `columns × rows` 均分出来的格子并不重合。**
于是那条线**不落在格子边界上，而是落在格子内部** ——
前两个坑里的 `trimEdgeStripes()` 只看**格子边缘**，**抓不到它**。

实测（本项目 4×4 合集图）：擦线前后对比，13 列 + 4 行被判定为网格线。

**修法：`eraseGridLines()`，而且必须在「整张合集图」上先擦、再按格切。**

```js
const computed = computeSlices({ decoded, items, columns, rows })   // clean 默认 true
// 返回值多了 grid_erase: { columns, rows, pixels }
```

判定一条列/行是"网格线"，要**同时**满足三个条件（`lib/autotrim.js`）：

| 条件 | 默认值 | 为什么 |
|---|---|---|
| 该列/行里「不透明且颜色接近本条中位数」的像素占比 | ≥ **0.85** | 网格线在整张图的高度/宽度上都是同一种颜色 |
| 连续成条，且厚度 | ≤ **8 px** | 防止把一大块纯色区域当成线擦掉 |
| （隐含）贯穿**整张图** | — | 真实素材几乎不可能有"贯穿整图的单一颜色细线"：一把竖着的剑只占整图高度的一小部分 |

**为什么"贯穿整图"这个条件很关键**：它就是**避免误伤**的保障。
实测判定比例只有 **0.8%**（1248+832 条里 17 条），不会误伤正常素材。

> **顺序很重要**：擦网格线 → 按格切 → 抠底 → 去边条纹 → 居中。
> 把擦线放到切图**之后**就晚了 —— 线已经分散到各格里，而单格里它不"贯穿整图"，判不出来。

**实测收益**（本项目 509 张卡）：16 张合集图里 **13 张**擦到了线（共 33.4 万像素）；
去边条纹从 169 格升到 **293 格** —— 说明之前有相当一部分"条纹"其实是网格线，
只是没被边缘检测抓到。

---

## 卡面/界面上的「横杠」排查法 · 第七十五轮实战教训（**最重要的一节**）

> 背景：用户连续 **四轮** 都在报同一件事——"卡面上有一道横杠"，
> 而我前三轮一直在改 **PNG 素材**（抠底、擦网格线、去边条纹、去透明缝），
> **一条都没消掉**。真凶最后发现是**一个伪元素 + 一行 CSS**。

### 坑 4：**"图上有横杠"十有八九不是图** —— 先分图层，再碰素材

真凶是：

```css
.card::before {                      /* 稀有度卡框 */
  left: 0; right: 0; top: 44px; height: 62px;
  opacity: .5; background-size: 100% 100%;
}
.card.r-uncommon::before, .card.r-rare::before, .card.r-curse::before { display: block; }
```

**两层错叠在一起：**

1. **布局改了，用旧坐标的东西没跟着搬** —— `top:44 / height:62` 是**上一版插画槽**的坐标；
   后来插画槽改成 `top:4 / height:80`，这个框忘了搬 ⇒ 它横在插画中段。
2. **装饰素材的比例也不对** —— `frame_a/b/c` 是按旧槽比例（118×62）画的，
   套到新槽（114×80）上，`background-size:100% 100%` 把它**纵向拉伸**，
   自身的横纹被拉成**横贯画面的带子**。
   ⇒ **光把坐标对齐不够**；比例不符时只能不用它（或按新比例重画）。

**⇒ 流程规定：在动任何素材之前，先做"分图层"这一步。**

```js
// ① 把宿主自己的背景涂成品红 —— 凡是"露出底色"的地方会立刻变品红
document.querySelectorAll('.card').forEach(c => c.style.background = '#ff00ff')
// ② 把插画本体隐藏 —— 带子如果还在，就**绝不是这张图**
img.style.opacity = '0'
// ③ 逐个关掉装饰层 —— 凹槽 / 纸板 / 伪元素 scrim / 卡框 / 类型渐变
```

**判据（照这个顺序问，一步就能把范围砍一半）：**

| 问题 | 是 | 否 |
|---|---|---|
| 把插画本身隐藏，带子还在吗？ | **不是图** ⇒ 去查 CSS / 叠加层 | 是图 ⇒ 才轮到改素材 |
| 把宿主背景涂品红，带子变成品红吗？ | 是**底色透出**（留白 / 缝） | 是某个**叠加层** |
| 带子位置**跟着卡片走**、不跟画面内容走吗？ | 固定布局 ⇒ CSS | 跟内容走 ⇒ 素材 |
| 换一批**完全不同的素材**，带子一模一样吗？ | **与素材无关** ⇒ CSS | 与素材有关 |

### 坑 5：**`::before` / `::after` 是伪元素 —— 任何"遍历节点"的办法都看不见它**

这是本题花了四轮的直接原因。伪元素对下面这些手段**全部隐形**：

- ❌ 遍历 `.cart` 的子元素 —— 它不在里面
- ❌ 遍历 `.card` 的 `children` —— **`children` 不含伪元素**
- ❌ 把插画 `img` 设成 `opacity:0` —— 它照样在
- ❌ 杀掉 `.card` 的 `background` 和卡框 —— 它还是它

**✅ 唯一有效的两个办法：**

```js
// ① 直接问伪元素（可以拿到 computed style）
getComputedStyle(card, '::before').display   // → 'block' 就是它
getComputedStyle(card, '::before').top       // → '44px'
```

```bash
# ② 或者干脆去 CSS 里搜
grep -n '::before\|::after' style.css
```

**⇒ 规定：DOM 排查到底还找不到叠加层时，必须去 CSS 搜伪元素。
不要因为"遍历完了没有"就下结论说没有。**

### 坑 6：**回滚之前必须确认那个备份是"改动前"还是"改动后"的**

这一轮把自己的修复搞丢过一次：跑诊断时用
`Copy-Item style.css.bak-m2 style.css` 回滚，
结果 `.bak-m2` 是**再前一次**的备份，**把已经写好的修复覆盖掉了**，
于是"改完还是有问题"，又白跑一轮。
**⇒ 备份文件名带序号没用，要带"相对哪个改动"的语义；
回滚后立刻断言一下（`assert(src.includes('top: 84px'))`）再往下走。**

### 配套：给宿主立一条"**会红的断言**"

修完不算完。这一类 bug 的正确收尾是**让它无法悄悄回来**：

```js
// 遍历宿主卡片上的每一个绝对定位层（含伪元素），
// 断言不存在"横跨整宽却又薄、且不在卡底"的层
['', '::before', '::after'].forEach(ps => {
  const cs = getComputedStyle(card, ps || null);
  if (cs.display === 'none' || cs.position !== 'absolute') return;
  const w = parseFloat(cs.width), h = parseFloat(cs.height), top = parseFloat(cs.top);
  assert(!(w >= 100 && h <= 20 && top < 190), '横杠层: ' + ps + ' ' + cs.top);
});
assert(getComputedStyle(card, '::before').display === 'none', '稀有度卡框不许显示');
```

**并且一定要跑负对照**：把真凶改回去，断言**必须变红**。
「改完绿了」说明不了任何事——**只有"改回去会红"才说明这条断言真的在测那件事**。
（本轮实测：把 `display:none` 改回 `block` ⇒ 断言当场红、整轮 exit=1。）

### 一句话流程（贴在手边）

> **看到画面上的"带子 / 杠"** →
> ① 先隐藏内容层，看它还在不在（在 ⇒ 不是素材）→
> ② 再染色，看它是什么颜色（露底 vs 叠加）→
> ③ 再查 CSS，**记得连 `::before` / `::after` 一起搜** →
> ④ 改完加一条**能红的断言** + 跑**负对照**。
> **在走完 ① 之前，不要动任何 PNG。**

### 附：素材侧的收益与它**不能**解决的问题（诚实记录）

这一轮之前，素材侧确实做出过真实收益：透明缝 **183 → 68**（抠底之后加一道"去透明缝"的
in-paint，把被洪水填充切出来的缝补回去）。
**但它跟"横杠"完全无关** —— 用户看到的带子自始至终是那层 CSS。
**记录这条是为了下次别再拿"素材确实变好了"当作"用户看到的问题修好了"。**

---

## 坑 7：抠底「安全阀」把 **90%+ 背景**误判成「吃掉主体」⇒ 抠底直接变 0% · 第七十九轮实战

### 现象

同一套提示词生成的**单张高精度角色图**（1024×1024），四帧**全部抠底失败**：

```
hdnxe_berserk_f0   抠掉  0%   余 100.0%
hdnxe_berserk_f1   抠掉  0%   余 100.0%
```

`keyOutFlatBackground` 返回的 `keyed = 0`，而且 **`why` 是空字符串**——
看起来"什么都没发生"，最容易误判成"模型把背景画花了"。

### 排查过程（**我一开始也判断错了**）

| 假设 | 实测 | 结论 |
|---|---|---|
| 背景不平（有渐变/纹理） | 四角色差只有 **3~6**，边缘种子亮度 **sd = 2.0** | ❌ 背景是平的 |
| 提示词没写清"平底" | 补了 4 段更硬的背景约束，重生成 | ❌ 仍 0% |
| `background:'transparent'` 能救 | 实测**透明像素 0%**（免费模型不返回真 alpha） | ❌ |
| 换成"边缘连通洪水填充" | 自己写的朴素版**能去掉 93.8%** | ✅ **问题在函数里** |

**关键一步是"自己写一遍最朴素的算法"**：当自写版本能成功、而封装版本失败时，
问题一定在封装里，不用再怀疑输入。

### 真因

函数里有个安全阀：

```js
if (hit.length / cellPixels > maxShare) {   // maxShare = 0.88
  for (const i of hit) pixels[i + 3] = 255  // 「抠太多」⇒ 整轮回滚
  break
}
```

**单张高精度图的画布很大，主体往往只占 5~10%、背景 90%+** ⇒
每次都被判成"可能把主体一起吃掉了" ⇒ 回滚 ⇒ `keyed = 0`。

这条判据在**表格切格**（每格都被主体填得较满）时没问题，
一旦改用**单张整幅生成**就必然踩中——而"单张"恰恰是提升精度的唯一办法。

### 修法：把判据从「抠掉多少」换成「**主体还在不在**」

```js
const remain = 1 - hit.length / cellPixels
if (remain < 0.02) {                        // 只有真把主体吃光了才回滚
  for (const i of hit) pixels[i + 3] = 255
  break
}
```

**实测（修复前后同一批图）**：

| 图 | 修复前 | 修复后 |
|---|---|---|
| `hdnxe_berserk_f0` | 0% | **97%** |
| `hdnxe_berserk_f1` | 0% | **98%** |
| `hdnxe_cultist_f0c` | 0% | **93%** |

### 顺带给调用方加的两道保护

1. **入库前拦截**：抠底后不透明 **> 60%** 的帧**当场拒收**、不写映射表；
   收下的帧不足 4 张就整组不写、退出码 5。
   （负对照实测：4 张坏图全部被拒收、exit=5。）
2. **调用方要打印 `keyed`**：这次就是靠"抠掉 0%"这个数字才定位到的。
   只打印"完成"是查不出来的。

---

## 坑 8：主体在画面里占比太小 ⇒ 抠底安全阀会一直回滚 · 第八十一轮

### 现象

同一套提示词生成 4 帧，**有的帧抠底成功、有的帧恒为 0%**：

```
hdnxe_bomber_f0d  抠掉 74%  角色高 1008  ✓
hdnxe_bomber_f1   抠掉  0%  角色高 1024  ✗ 恒为 0%
```

### 真因

抠底函数结尾有个安全阀：**抠掉比例超过 `maxShare`(0.88) 就整轮回滚**
（它原本是为了防止"把主体一起抠掉"）。

当**主体在画面里只占一小块**时（比如角色只占 6%），背景就是 94%，
**一定超过 0.88** ⇒ 每次都被判成"可能把主体吃了" ⇒ 回滚 ⇒ `keyed = 0`。

**我把这个阀值改了三版都没搞对**：
- 改成"剩余 < 2% 才回滚" ⇒ 剩余 1.5% 的瘦长角色仍被误判；
- 改成"最大连通域 ≥ 0.2%" ⇒ **放行了被啃掉一半的角色**（抠完只剩 161px 高）；
- 改成"主体高度 ≥ 抠前 45%" ⇒ 仍不稳。

**⇒ 结论：不要在共用组件里继续堆启发式。** 三次实验后我把插件**回滚到原始状态**。

### 更好的解法：**让主体占满画面**（改提示词，不动代码）

生成时明确写：

```
The character FILLS THE FRAME: head near the top edge, feet near the bottom edge,
body takes up about 90 percent of the canvas height, centred horizontally
with only a thin even margin.
```

**实测效果**（同一角色、同一风格，只改这一句）：

| 提示词 | 抠底 | 角色高 |
|---|---|---|
| 只写"small isolated figure in the middle" | **0%** | 1024（但抠不掉） |
| 写"**FILLS THE FRAME，约 90% 高度**" | **74~88%** ✓ | 1008~1024 |

**同一批 8 帧全部一次通过**，不用再碰抠底代码。

### 教训

1. **抠底类工具对"主体占比"是敏感的**：主体越小，越容易撞上安全阀。
   与其把阀值调来调去，不如**让生成端把主体画大**。
2. **共用组件不要连续试错**：我改了三版，每次都能"修好这一张、弄坏另一类"。
   正确做法是**回滚 + 报告**，而不是继续加特例。
3. 调用方仍应保留**入库前拦截**（抠后不透明 > 60% 就拒收），
   这样即使抠底失败，也只会让该帧重生成，**绝不会把方块或残缺角色装进游戏**。
