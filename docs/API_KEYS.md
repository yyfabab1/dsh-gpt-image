# API Key 申请清单 · Where to get API keys

插件**本身不含任何 Key**。Key 只存在你的 DSH 数据目录（`<DSH_HOME>/gpt-image/profiles.json`），
代码里、示例里、仓库里都是空的。

> **安全提醒**：Key 等于钱。不要把它贴进聊天、截图、提交到仓库。
> 本插件的 `config` 工具和面板都会把 Key **打码显示**（`sk-…abcd`）。

---

## 一、免费首选：Agnes AI（图片 + 视频都免费）

这是本插件内置示例用的服务商，**当前官方免费**，最适合先把整条流水线跑通。

| 项目 | 内容 |
|---|---|
| 官网 | <https://www.agnes-ai.com> |
| 注册 / 控制台 / 充值 | <https://platform.agnes-ai.com> |
| 订阅（Token Plan） | <https://platform.agnes-ai.com/subscribe/subscription> |
| **图片模型文档** | <https://www.agnes-ai.com/zh-Hans/docs/agnes-image-25-flash> |
| **视频模型文档** | <https://www.agnes-ai.com/zh-Hans/docs/agnes-video-25-flash> |
| 快速接入 / 概述 | <https://www.agnes-ai.com/zh-Hans/docs/quickstart> |
| 定价 | <https://www.agnes-ai.com/zh-Hans/docs/pricing> |
| Base URL | `https://apihub.agnes-ai.com/v1` |
| 图片模型名 | `agnes-image-2.5-flash` |
| 视频模型名 | `agnes-video-2.5-flash` |
| 价格 | 图片：所有档位与参考图**当前免费**；视频：刊例 $0.025/秒，**当前 $0/秒** |

**申请步骤**

1. 打开 <https://platform.agnes-ai.com>，注册并登录（官网右上角「登录」也指向这里）。
2. 进入控制台 → **API Keys**（或 "API 密钥"）页面 → 新建一个 Key，复制形如 `sk-...` 的字符串。
3. 在插件里配进去（三种方式任选，见下文「四、把 Key 填进插件」）。

**注意**（都是实测踩到的）

- 图片接口是标准 OpenAI Images API，但有两处差异：`size` 用档位（`1K`/`2K`/`3K`/`4K`）配合 `ratio`；
  `response_format` **必须嵌在 `extra_body` 里**，放顶层直接报错。示例配置已经处理好了。
- 图片接口**没有 mask 参数** → 不支持局部重绘。插件会**显式拒绝**，不会悄悄整图重画。
- 视频接口是异步任务（建任务 + 轮询），免费档**队列常满**（`503 video_queue_full`）且有**限流**（`429`）。
  实测有一次连续 25 分钟都在排队。这不是配置问题，等一会儿或升级 Token Plan。
- 视频要**公网可访问的素材 URL**（详见下文「五、免费图床」）。

---

## 二、OpenAI 官方

| 项目 | 内容 |
|---|---|
| **申请 API Key** | <https://platform.openai.com/api-keys> |
| 用量 / 计费 | <https://platform.openai.com/usage> |
| 充值 | <https://platform.openai.com/settings/organization/billing/overview> |
| Base URL | `https://api.openai.com/v1` |
| 模型名 | `gpt-image-2`（或你账号可用的 `gpt-image-*`） |
| 价格 | 按张计费，以官方定价页为准 |

> `platform.openai.com` 有时会返回 403 给脚本请求（Cloudflare 反爬），
> 用浏览器打开是正常的。Key 需要账号里有余额。

---

## 三、fal.ai

| 项目 | 内容 |
|---|---|
| **申请 API Key** | <https://fal.ai/dashboard/keys> |
| 控制台 | <https://fal.ai/dashboard> |
| Base URL | `https://fal.run` |
| 端点 / 模型 | `openai/gpt-image-2` |
| 价格 | 按张计费，以控制台为准 |

---

## 四、中转站 / 自建代理（OpenAI 兼容）

国内常见的「中转站」大多把 OpenAI Images API 包装成 OpenAI 兼容接口，配置方式是通用的：

```
provider  = openai
baseUrl   = https://<中转站域名>/v1
apiKey    = <中转站给你的 key>
model     = <中转站文档里写明的模型名>
```

**怎么知道填哪家**：中转站的后台一般会写清「Base URL」和「模型列表」，照着填即可。
插件会自动兼容 `baseUrl` 末尾缺 `/v1` 的情况（404 时自动重试另一种拼法）。

> 中转站的安全性由你自己判断 —— 它看得到你发的所有提示词和图片。

---

## 五、免费图床（「导入图片生成视频」会自动用，**不需要 Key**）

Anges 视频接口要求素材是**公网可访问的 URL**，而你的素材都在本地。
插件会用一条策略链把本地文件换出去（详见 README 的「生视频 + 导入图片生成视频」一节）：

| 优先级 | 方式 | 需要 Key 吗 |
|---|---|---|
| 1 | `publicBaseUrl`：把 DSH 的 HTTP 服务通过隧道/反代暴露出去 | 不要（但要自己有隧道） |
| 2 | `uploadEndpoint`：自己的图床 / 对象存储 | 看你的图床 |
| 3 | 内置免费匿名图床 | **不要** |

内置图床的实测可达性（2026-10 实测，境内网络）：

| 图床 | 网址 | 实测 |
|---|---|---|
| **uguu.se** | <https://uguu.se> | ✅ **唯一可用**，约 3 小时失效 |
| litterbox | <https://litterbox.catbox.moe> | ❌ HTTP 500 |
| tmpfiles.org | <https://tmpfiles.org> | ❌ 连接失败 |
| catbox.moe | <https://catbox.moe> | ❌ 连接失败 |
| 0x0.st | <https://0x0.st> | ❌ 官方已停收（"uploads disabled"） |

所以默认走 uguu.se。它给的是**临时链接**，视频任务通常几分钟内就取完素材，
但如果排队很久可能已过期 —— 失败时插件的报错会带上「试过哪几家」，照上面重试或改用自建。

---

## 六、把 Key 填进插件

### 方式 A · 面板（最直观）

侧栏「生图」→ 配置区 → 填 `baseUrl` / `apiKey` / `model` → 保存。
侧栏「余额」页可以看到「还能不能花钱、花了多少」。

### 方式 B · 用 `config` 工具（AI 也能替你配）

```jsonc
// 新增/修改一个配置档
config(action="set_profile", profile={
  id: "agnes-2.5-flash",
  name: "Agnes Image 2.5 Flash（免费档）",
  provider: "agnes",                       // 自定义 provider 模板 id
  baseUrl: "https://apihub.agnes-ai.com/v1",
  apiKey: "sk-你的key",
  model: "agnes-image-2.5-flash",
  apiMode: "images",
  pricePerImage: 0                          // 免费档写 0 → 不触发确认锁、不吃日预算
})

// 切到它
config(action="set_active", profile_id="agnes-2.5-flash")

// 测连通（不发绘图，只探端点）
config(action="test", profile_id="agnes-2.5-flash")
```

### 方式 C · 导入示例配置

```jsonc
// 仓库里自带两份可直接用的模板（apiKey 都是空的，自己填）
config(action="import", path="examples/agnes-config.json")     // Agnes 图片 + 视频
config(action="import", path="examples/headless-overlay.yml")  // 见文件内注释
```

---

## 七、一张表看懂「该选哪家」

| 你的情况 | 建议 | 理由 |
|---|---|---|
| 想先零成本跑通全流程 | **Agnes AI** | 图片/视频当前都免费，Key 好申请 |
| 要最稳的画质与生态 | OpenAI 官方 | 官方直连，无中转风险 |
| 已有中转站 | 用中转站 | 便宜、境内快，但注意隐私 |
| 要批量出像素画 | Agnes + 本文档的 `pixel` 参数 | 免费，可以多试几次挑最好的 |
| 要出视频 | Agnes 视频 | 目前只有它接进了异步视频模板 |

---

## 八、常见问题

**Q：为什么配好了却报 401 / 403？**
A：Key 无效、过期、没权限、或者没余额。用 `config(action="test")` 先探连通。
Agnes 的 `/v1/models` 需要鉴权，401 说明端点是对的、Key 不对。

**Q：报 429？**
A：限流。Agnes 免费档视频尤其明显。等额度恢复或升级 Token Plan —— 重试没用。

**Q：报 503 `video_queue_full`？**
A：视频队列满，免费档常见且可能持续很久。插件会按 `queue_retries` 自动退避重试。

**Q：`size must be 720P`？**
A：Agnes 视频固定 720P。要别的分辨率得换模型。

**Q：能不能不填 Key，用本地模型？**
A：可以。任何 OpenAI 兼容的本地服务（如自建的 images 兼容层）都能当一个 `provider: "openai"` 的配置档，
`baseUrl` 填 `http://127.0.0.1:<端口>/v1`，`apiKey` 随便填个非空字符串即可。
