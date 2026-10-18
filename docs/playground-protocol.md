# gpt-image-playground — Image API protocol specification

Reverse-engineered, implementation-ready spec of the image-generation HTTP protocol used by
`gpt-image2ground-by Sealin/image2` (the "gpt-image-playground" SPA), so it can be reimplemented as a
standalone Node.js plugin.

**Source root:** `D:\5e\gpt-image2ground-by Sealin\image2\` — all `file:line` references below are
relative to that root (`src/lib/...` means `D:\5e\gpt-image2ground-by Sealin\image2\src\lib\...`).
The browser UI (`store.ts`, `components/*`) is only cited where it defines wire behaviour.

**Reading conventions**

- "omitted" means the key is **not present at all** in the JSON body / form data (not `null`).
- Everything below is taken from code; anything I could not determine from the code is marked
  `NOT DETERMINED` with the files I checked.
- The whole protocol is driven by one dispatcher:

```ts
// src/lib/api.ts:9-14
export async function callImageApi(opts: CallApiOptions): Promise<CallApiResult> {
  const profile = getActiveApiProfile(opts.settings)
  if (profile.provider === 'fal') return callFalAiImageApi(opts, profile)

  return callOpenAICompatibleImageApi(opts, profile, getCustomProviderDefinition(opts.settings, profile.provider))
}
```

```ts
// src/lib/openaiCompatibleImageApi.ts:433-447
export async function callOpenAICompatibleImageApi(opts, profile, customProvider) {
  if (customProvider) {
    const n = opts.params.n > 0 ? opts.params.n : 1
    const submitMapping = opts.inputImageDataUrls.length > 0 && customProvider.editSubmit
      ? customProvider.editSubmit
      : customProvider.submit
    const isAsync = Boolean(submitMapping.taskIdPath)
    if (profile.codexCli && n > 1 && !isAsync) return callCustomHttpImageApiConcurrent(opts, profile, customProvider, n)
    return callCustomHttpImageApi(opts, profile, customProvider)
  }

  return profile.apiMode === 'responses'
    ? callResponsesImageApi(opts, profile)
    : callImagesApi(opts, profile)
}
```

---

## 0. Inputs every request path shares

```ts
// src/lib/imageApiShared.ts:14-26
export interface CallApiOptions {
  settings: AppSettings
  prompt: string
  params: TaskParams
  nativeTransparentBackground?: boolean
  /** 输入图片的 data URL 列表 */
  inputImageDataUrls: string[]
  maskDataUrl?: string
  skipCodexCliSizePrompt?: boolean
  onFalRequestEnqueued?: (request: { requestId: string; endpoint: string }) => void
  onCustomTaskEnqueued?: (task: { taskId: string }) => void
  onPartialImage?: (partial: { image: string; partialImageIndex?: number; requestIndex?: number }) => void
}
```

```ts
// src/types.ts:128-146
export interface TaskParams {
  size: string                                        // 'auto' | 'WxH'
  quality: 'auto' | 'low' | 'medium' | 'high'
  output_format: 'png' | 'jpeg' | 'webp'
  output_compression: number | null
  moderation: 'auto' | 'low'
  n: number
  transparent_output: boolean
}
export const DEFAULT_PARAMS: TaskParams = {
  size: 'auto', quality: 'auto', output_format: 'png',
  output_compression: null, moderation: 'auto', n: 1, transparent_output: false,
}
```

`nativeTransparentBackground` is set by the caller as `task.params.transparent_output && !task.transparentOutput`
(`src/store.ts:3564`), i.e. it is true only when transparent output should be requested **from the API**
(not produced by local post-processing).

Prompt post-processing before it becomes the wire `prompt`:

1. `@图N` UI mentions are rewritten to `[image N]` (`src/lib/promptImageMentions.ts:141-147`,
   called at `src/store.ts:3562`).
2. In `codexCli` mode a size sentence is prepended (see §8) unless `skipCodexCliSizePrompt`.

Result contract:

```ts
// src/lib/imageApiShared.ts:28-41
export interface CallApiResult {
  images: string[]                                  // base64 data URLs
  actualParams?: Partial<TaskParams>
  actualParamsList?: Array<Partial<TaskParams> | undefined>
  revisedPrompts?: Array<string | undefined>
  rawImageUrls?: string[]
  failedRequests?: Array<{ requestIndex: number; error: string }>
}
```

MIME used to wrap raw base64 (`src/lib/imageApiShared.ts:4-8`):

```ts
export const MIME_MAP: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }
// caller: const mime = MIME_MAP[params.output_format] || 'image/png'
```

`normalizeBase64Image` (`src/lib/imageApiShared.ts:51-53`): values already starting with `data:` are used
verbatim; otherwise `data:${mime};base64,${value}`.

---

## 1. Provider kinds

### 1.1 Enumeration

```ts
// src/types.ts:18-20
export type BuiltInApiProvider = 'openai' | 'sb2api-async' | 'fal'
export type ApiProvider = BuiltInApiProvider | string   // any other string = custom provider id
export type CustomProviderTemplate = 'http-image'
```

```ts
// src/lib/apiProfiles.ts:38
const BUILT_IN_PROVIDER_IDS = new Set<ApiProvider>(['openai', 'sb2api-async', 'fal'])
```

| Provider id | Transport | Declarative template? | Source |
|---|---|---|---|
| `openai` | hard-coded Images API (`images/generations`, `images/edits`) or Responses API (`responses`) | no | `openaiCompatibleImageApi.ts:39-44, 449-625, 989-1074` |
| `sb2api-async` | declarative `http-image` manifest, async (poll) | yes, built-in constant | `apiProfiles.ts:65-97` |
| `fal` | `@fal-ai/client` SDK (`fal.subscribe`, `fal.queue.*`) | no | `falAiImageApi.ts` |
| any other string | declarative `http-image` manifest from `settings.customProviders` | yes, user/deployment supplied | `apiProfiles.ts:312-346` |

`getCustomProviderDefinition(settings, provider)` returns the built-in `SUB2API_PROVIDER` for
`sb2api-async`, a matching entry of `settings.customProviders` otherwise, `null` for `openai`
(`apiProfiles.ts:738-742`). `isOpenAICompatibleProvider` is `provider === 'openai' || custom provider exists`
(`apiProfiles.ts:751-753`) — `fal` is excluded.

### 1.2 `sb2api-async` — exact template object

```ts
// src/lib/apiProfiles.ts:44-97
const DEFAULT_GENERATE_BODY = {
  model: '$profile.model',
  prompt: '$prompt',
  size: '$params.size',
  quality: '$params.quality',
  output_format: '$params.output_format',
  moderation: '$params.moderation',
  output_compression: '$params.output_compression',
  n: '$params.n',
  background: '$params.background',
}
const DEFAULT_EDIT_BODY = DEFAULT_GENERATE_BODY
const DEFAULT_OPENAI_RESULT: CustomProviderResultMapping = {
  imageUrlPaths: ['data.*.url'],
  b64JsonPaths: ['data.*.b64_json'],
}
const DEFAULT_EDIT_FILES: CustomProviderFileMapping[] = [
  { field: 'image[]', source: 'inputImages', array: true },
  { field: 'mask', source: 'mask' },
]

const SUB2API_PROVIDER: CustomProviderDefinition = {
  id: 'sb2api-async',
  name: 'sub2api（异步）',
  template: 'http-image',
  submit: {
    path: 'images/generations/async',
    method: 'POST',
    contentType: 'json',
    body: DEFAULT_GENERATE_BODY,
    taskIdPath: 'task_id',
  },
  editSubmit: {
    path: 'images/edits/async',
    method: 'POST',
    contentType: 'multipart',
    body: DEFAULT_EDIT_BODY,
    files: DEFAULT_EDIT_FILES,
    taskIdPath: 'task_id',
  },
  poll: {
    path: 'images/tasks/{task_id}',
    method: 'GET',
    intervalSeconds: 3,
    statusPath: 'status',
    successValues: ['completed'],
    failureValues: ['failed'],
    errorPath: 'error.message',
    result: {
      imageUrlPaths: ['result.data.*.url'],
      b64JsonPaths: ['result.data.*.b64_json'],
    },
  },
}
```

Notes:

- `apiProxy` is forced `false` for this provider (`apiProfiles.ts:564`).
- Verified end-to-end shape: submit returns `202 {task_id, status}`, poll URL
  `https://…/v1/images/tasks/imgtask-1`, result `result.data[*].b64_json | url`
  (`src/lib/api.test.ts:1384-1434`).
- The poll mapping has **no** query, no retry limit and no explicit timeout (§6).

### 1.3 Custom provider (`http-image`) defaults and normalization

```ts
// src/lib/apiProfiles.ts:39-63
const DEFAULT_CUSTOM_PROVIDER_PATHS = {
  generationPath: 'images/generations',
  editPath: 'images/edits',
  taskPath: 'images/tasks/{task_id}',
}
```

`normalizeCustomProviderDefinition` (`apiProfiles.ts:312-346`) accepts
`{id?, name?, template?, submit, editSubmit?, poll?}` and returns `null` (invalid, dropped) when
`template` is present and not `'http-image'`, or when `submit` is not an object.
`editSubmit` is only produced when the input has an object at that key. Defaults applied:

| Field | Rule | Ref |
|---|---|---|
| `submit.path` | `normalizeProviderPath(value, 'images/generations')`: trim, strip leading `/`, strip one leading `v1/` | `apiProfiles.ts:156-158, 329-335` |
| `submit.method` | `'GET'`/`'POST'`, else `'POST'` | `apiProfiles.ts:182-184` |
| `submit.contentType` | `'multipart'` else `'json'` | `apiProfiles.ts:186-188` |
| `submit.body` | record, else `DEFAULT_GENERATE_BODY` (`DEFAULT_EDIT_BODY` when contentType is multipart) | `apiProfiles.ts:190-192, 228` |
| `submit.query` | object of string/number/boolean → string map; empty ⇒ `undefined` | `apiProfiles.ts:160-170` |
| `submit.files` | only for `multipart`; entries with non-empty `field` and `source ∈ {inputImages, mask}`; invalid → fallback | `apiProfiles.ts:194-208, 229` |
| `submit.taskIdPath` | trimmed non-empty string, else fallback/`undefined` | `apiProfiles.ts:230` |
| `submit.result` | `{imageUrlPaths, b64JsonPaths}` string arrays; default `DEFAULT_OPENAI_RESULT` | `apiProfiles.ts:210-218, 231` |
| `poll` | dropped entirely when no `statusPath` resolves | `apiProfiles.ts:235-240` |
| `poll.path` | default `images/tasks/{task_id}` | `apiProfiles.ts:238` |
| `poll.method` | default `'GET'` | `apiProfiles.ts:244` |
| `poll.intervalSeconds` | finite number → `Math.max(1, value)`; else fallback `5`. **No upper bound; fractional allowed** | `apiProfiles.ts:246-248` |
| `poll.successValues` | default `['SUCCESS', 'succeeded', 'completed', 'COMPLETED']` | `apiProfiles.ts:250` |
| `poll.failureValues` | default `['FAILURE', 'failed', 'error', 'FAILED', 'cancelled']` | `apiProfiles.ts:251` |
| `poll.errorPath` | trimmed non-empty string, else fallback | `apiProfiles.ts:252` |
| `poll.result` | default `DEFAULT_OPENAI_RESULT` | `apiProfiles.ts:253` |
| `id` | trimmed string that is neither a built-in id nor already used; otherwise `custom-<slug>` / `custom-<slug>-N` | `apiProfiles.ts:300-324` |
| `name` | trimmed, else `'自定义服务商'` | `apiProfiles.ts:319` |

`DEFAULT_CUSTOM_PROVIDER_JSON` (`src/lib/settingsCustomProvider.ts:1-47`) is the UI-provided starter
manifest: sync `submit` (`images/generations`, json) + `editSubmit` (`images/edits`, multipart with
`image[]`/`mask`) and no `poll`. It contains `result` mappings but **not** `query`/`taskIdPath`.

Legacy migration — `legacyCustomProviderToManifest` (`apiProfiles.ts:257-298`) converts old
`template: 'openai-compatible' | 'openai-compatible-async'` records into the above shape, notably:

- async submit/edit get `query: record.submitQuery ?? { async: 'true' }` and `taskIdPath: record.taskIdPath ?? 'data'`.
- poll: `path = record.taskPath ?? 'images/tasks/{task_id}'`, `statusPath = record.taskStatusPath ?? 'data.status'`,
  `errorPath: 'data.fail_reason'`, `intervalSeconds = record.pollIntervalSeconds ?? 5`,
  result paths `[<taskResultPath>.data.*.url]` / `[<taskResultPath>.data.*.b64_json]` where
  `taskResultPath = record.taskResultPath ?? 'data.data'`.

Validation rule: a provider that declares `taskIdPath` **must** have `poll`
(`validateCustomProviderTaskMappings`, `apiProfiles.ts:761-766`; runtime equivalent
`'异步接口返回了 task_id，但服务商配置缺少 poll'` at `openaiCompatibleImageApi.ts:933`).

### 1.4 `openai` — implicit template

```ts
// src/lib/openaiCompatibleImageApi.ts:39-44
function createOpenAICompatiblePaths() {
  return { generationPath: 'images/generations', editPath: 'images/edits' }
}
```

- `apiMode: 'images'` → POST `images/generations` (text-to-image) or POST `images/edits` (any input image).
- `apiMode: 'responses'` → POST `responses` (single endpoint for both generate and edit; edit is
  expressed through the tool `action: 'edit'` and `input_image` parts).
- `apiMode === 'responses'` is only reachable when `provider === 'openai'`; for every other provider
  `normalizeApiProfile` forces `'images'` (`apiProfiles.ts:537`).

### 1.5 `fal`

- No declarative template. Endpoint = `profile.model` with leading/trailing `/` stripped, defaulting to
  `'openai/gpt-image-2'`; `/edit` is appended when input images exist and the model does not already end
  with `/edit` (`falAiImageApi.ts:21-24`).
- SDK config: `fal.config({ credentials: profile.apiKey, suppressLocalCredentialsWarning: true })` plus
  `proxyUrl = baseUrl` when `baseUrl !== 'https://fal.run'` (`falAiImageApi.ts:39-47`).
- Request input (`falAiImageApi.ts:49-68`): `prompt`, `image_size` (`{width,height}` parsed from `WxH`,
  else `1360x1024`; the literal string `'auto'` when editing with `size === 'auto'`), `quality`
  (`'auto'` → `'high'`), `num_images = min(4, max(1, n||1))`, `output_format`, plus `image_urls` (array of
  data URLs) and `mask_url` (data URL) when applicable.
- Call: `fal.subscribe(endpoint, { input, logs: true, onEnqueue })`; result payload at `result.data`
  (`falAiImageApi.ts:212-221`).
- Recovery: `fal.queue.subscribeToStatus(endpoint, { requestId, logs: true })` then
  `fal.queue.result(endpoint, { requestId })` (`falAiImageApi.ts:183-193`).
- Response parsing (`falAiImageApi.ts:94-136`): candidates = `payload.images[]` ∪ `payload.image` ∪
  `payload.url`; per candidate a string is taken as URL/data-URL/base64, an object is read in the order
  `url` → `b64_json` → `base64` → `data`; `{width,height}` becomes `actualParams.size = "WxH"`.

---

## 2. Placeholder syntax (template mini-language)

### 2.1 `$`-placeholders in `body` / `query`

Grammar (informal, exactly as implemented): a **whole string value** that starts with `$` is a path into
the request context. There is no interpolation inside longer strings — `"size $params.size"` stays literal.

```ts
// src/lib/openaiCompatibleImageApi.ts:665-679
function resolveTemplateValue(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === 'string' && value.startsWith('$')) {
    return getByPath(context, value.slice(1))
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplateValue(item, context)).filter((item) => item !== undefined && item !== null)
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, resolveTemplateValue(item, context)] as const)
      .filter(([, item]) => item !== undefined && item !== null && (!Array.isArray(item) || item.length > 0))
    return Object.fromEntries(entries)
  }
  return value
}
```

Context object (any field reachable via the same `$` path syntax is addressable, including the whole
`ApiProfile`):

```ts
// src/lib/openaiCompatibleImageApi.ts:681-706
function createCustomProviderContext(opts: CallApiOptions, profile: ApiProfile) {
  const sizePrompt = profile.codexCli && !opts.skipCodexCliSizePrompt
    ? prependCodexCliSizePrompt(opts.prompt, opts.params.size)
    : opts.prompt
  const prompt = profile.codexCli && !opts.settings.allowPromptRewrite
    ? `${PROMPT_REWRITE_GUARD_PREFIX}\n${sizePrompt}`
    : sizePrompt
  const params = {
    ...opts.params,
    ...(profile.codexCli ? { size: undefined, quality: undefined } : {}),
    ...(opts.nativeTransparentBackground ? { background: 'transparent' } : {}),
  }

  return {
    profile,                                                    // ApiProfile
    prompt,                                                     // final prompt string
    params,                                                     // TaskParams (+background, codexCli blanks)
    inputImages: {
      dataUrls: opts.inputImageDataUrls.length ? opts.inputImageDataUrls : undefined,
      count: opts.inputImageDataUrls.length,
    },
    mask: { dataUrl: opts.maskDataUrl },
  }
}
```

Documented variables (`src/lib/settingsCustomProvider.ts:97-107`):

| Placeholder | Resolves to | Omitted when |
|---|---|---|
| `$profile.model` | `profile.model` | never (profile is always present) |
| `$prompt` | final prompt (after codexCli size prefix + rewrite guard) | never |
| `$params.size` | `params.size` | `profile.codexCli` (set to `undefined`) |
| `$params.quality` | `params.quality` | `profile.codexCli` |
| `$params.output_format` | `'png' \| 'jpeg' \| 'webp'` | never |
| `$params.output_compression` | `number \| null` | `null` |
| `$params.moderation` | `'auto' \| 'low'` | never |
| `$params.n` | `number` | never (may be `1`) |
| `$params.background` | `'transparent'` | native transparent background not requested (key absent from `params`) |
| `$inputImages.dataUrls` | `string[]` of data URLs | no input images (explicitly `undefined`) |
| `$mask.dataUrl` | `string` data URL | no mask |
| `$profile.<anything>` | any `ApiProfile` field, e.g. `$profile.baseUrl`, `$profile.apiMode` | — |

Semantics an implementer must reproduce:

1. String starting with `$` → `getByPath(context, rest)`; **an unresolvable path yields `undefined`**.
2. `undefined` / `null` results are removed: from object values, and from array elements.
3. Empty arrays (`[]`) are removed from object values (but a resolved non-empty array is kept as an array
   in JSON bodies; in multipart it is expanded to repeated fields, §5.2).
4. Non-`$` strings, numbers, booleans are passed through verbatim (`"resolution": "2k"`, `"async": true`).
5. Missing/unknown placeholder ⇒ key silently absent from the request — no error is raised.

### 2.2 `{task_id}` path placeholder

```ts
// src/lib/openaiCompatibleImageApi.ts:659-663
function buildTaskPath(path: string, taskId: string): string {
  return path
    .replace(/\{task_id\}/g, encodeURIComponent(taskId))
    .replace(/\{taskId\}/g, encodeURIComponent(taskId))
}
```

Both `{task_id}` and `{taskId}` are supported, globally replaced, URL-encoded.
`{task_id}` is also the default value of `DEFAULT_CUSTOM_PROVIDER_PATHS.taskPath`.

### 2.3 Query rendering

```ts
// src/lib/openaiCompatibleImageApi.ts:708-715 + 32-37
function renderQuery(query, context) {
  if (!query) return undefined
  const entries = Object.entries(query)
    .map(([key, value]) => [key, resolveTemplateValue(value, context)] as const)
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
    .map(([key, value]) => [key, String(value)] as const)
  return entries.length ? Object.fromEntries(entries) : undefined
}
// appendQuery: `${path}${path.includes('?') ? '&' : '?'}${new URLSearchParams(params)}`
```

Query values are always stringified; `''`, `undefined`, `null` are dropped; arrays are **not**
supported in query (an array would stringify as `a,b`).

### 2.4 `{address}` / `{key}` / `{model}` — share/import-URL placeholders (**not** request templates)

These appear only in generated share links / deployment env values and are substituted by the consuming
integration (e.g. a New API chat front-end), not by this app:

```ts
// src/lib/profileImportUrl.ts:19-33
const importProfile: Partial<ApiProfile> = { ...profile, id: undefined, isDefault: undefined,
  apiKey: options.includeApiKey ? profile.apiKey : '' }
if (!options.includeApiKey) {
  if (options.useNewApiAddress) importProfile.baseUrl = '{address}'
  if (options.useNewApiKey)     importProfile.apiKey = '{key}'
  if (options.useNewApiModel)   importProfile.model = '{model}'
}
url.searchParams.set('settings', JSON.stringify({ customProviders: provider ? [provider] : [], profiles: [importProfile] }))
```

Documented form `https://host/?apiUrl={address}&apiKey={key}&model={model}` (`README.md:454-462`;
`src/components/SettingsModal.tsx:468-488`). `{address}` is documented as *without* `/v1`
(`src/components/settings/ProfileImportUrlModal.tsx:61`). Reading side: `src/lib/urlSettings.ts:15`).

---

## 3. Text-to-image — Images API mode

Entry: `callImagesApi` (`openaiCompatibleImageApi.ts:449-456`)

```ts
const n = opts.params.n > 0 ? opts.params.n : 1
if ((profile.codexCli || (profile.streamImages && n > 1)) && n > 1) return callImagesApiConcurrent(opts, profile, n)
return callImagesApiSingle(opts, profile)
```

### 3.1 URL construction

```ts
// src/lib/devProxy.ts:13-37
export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  if (!trimmed) return ''
  const input = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(input)
    if (trimmed.endsWith('/')) return `${url.origin}${url.pathname.replace(/\/+$/, '/')}`
    const pathSegments = url.pathname.split('/').filter(Boolean)
    const v1Index = pathSegments.indexOf('v1')
    const normalizedSegments = v1Index >= 0 ? pathSegments.slice(0, v1Index + 1)
      : pathSegments.length ? [...pathSegments, 'v1'] : []
    const pathname = normalizedSegments.length ? `/${normalizedSegments.join('/')}` : ''
    return `${url.origin}${pathname}`
  } catch { return trimmed.replace(/\/+$/, '') }
}

// src/lib/devProxy.ts:59-82
export function buildApiUrl(baseUrl, path, proxyConfig?, useApiProxy = false): string {
  const trimmedBaseUrl = baseUrl.trim()
  const endpointPath = path.replace(/^\/+/, '')
  if (useApiProxy) return `${proxyConfig?.prefix ?? '/api-proxy'}/${endpointPath}`
  const normalizedBaseUrl = normalizeBaseUrl(trimmedBaseUrl)
  if (trimmedBaseUrl.endsWith('/')) return `${normalizedBaseUrl.replace(/\/+$/, '')}/${endpointPath}`
  const apiPath = normalizedBaseUrl.endsWith('/v1') ? endpointPath : ['v1', endpointPath].join('/')
  return normalizedBaseUrl ? `${normalizedBaseUrl}/${apiPath}` : `/${apiPath}`
}
```

Resulting behaviour:

| `profile.baseUrl` | `path` | final URL |
|---|---|---|
| `https://api.openai.com/v1` | `images/generations` | `https://api.openai.com/v1/images/generations` |
| `https://api.example.com` | `images/generations` | `https://api.example.com/v1/images/generations` |
| `https://api.example.com/v2` | `images/generations` | `https://api.example.com/v2/v1/images/generations` |
| `https://api.example.com/` | `api/image-tasks` | `https://api.example.com/api/image-tasks` (no `/v1`) |
| `api.example.com` (no scheme) | `images/generations` | `https://api.example.com/v1/images/generations` |
| proxy enabled | `images/generations` | `/api-proxy/images/generations` (**same-origin relative**) |

`useApiProxy = shouldUseApiProxy(profile.apiProxy, readClientDevProxyConfig())`
(`openaiCompatibleImageApi.ts:489-490`), where the proxy is only "available" in this deployment
(`devProxy.ts:96-106`). Default proxy prefix `'/api-proxy'` (`devProxy.ts:11`).

### 3.2 Headers

```ts
// src/lib/openaiCompatibleImageApi.ts:88-92
function createRequestHeaders(profile: ApiProfile): Record<string, string> {
  return { Authorization: `Bearer ${profile.apiKey}` }
}
```

- JSON request adds `'Content-Type': 'application/json'` (`:602-605`).
- Multipart request sends **only** `Authorization` — the multipart boundary header must be generated by
  the HTTP client (`:559-565`).
- No `OpenAI-Beta`, no org/project headers, no `Cache-Control`/`Pragma` anywhere. `cache: 'no-store'` is
  set on every fetch. (`grep` for `OpenAI-Beta` across `src/` → no matches; test asserts the absence of
  cache headers at `src/lib/api.test.ts:1256-1276`.)

### 3.3 Request body — text-to-image (`apiMode: 'images'`, no input images)

```ts
// src/lib/openaiCompatibleImageApi.ts:567-609 (abridged)
const body: Record<string, unknown> = {
  model: profile.model,
  prompt,
  output_format: params.output_format,
  moderation: params.moderation,
}
if (opts.nativeTransparentBackground) body.background = 'transparent'
if (!profile.codexCli) body.size = params.size
if (!profile.codexCli) body.quality = params.quality
if (params.output_format !== 'png' && params.output_compression != null) body.output_compression = params.output_compression
if (params.n > 1) body.n = params.n
if (profile.responseFormatB64Json) body.response_format = 'b64_json'
if (profile.streamImages) { body.stream = true; body.partial_images = getStreamPartialImages(profile) }

response = await fetch(buildApiUrl(profile.baseUrl, 'images/generations', proxyConfig, useApiProxy), {
  method: 'POST',
  headers: { ...requestHeaders, 'Content-Type': 'application/json' },
  cache: 'no-store',
  body: JSON.stringify(body),
  signal: controller.signal,
})
```

Exact field matrix (JSON, generate):

| Field | Type | Included when |
|---|---|---|
| `model` | string | always |
| `prompt` | string | always (final prompt, §0/§8) |
| `output_format` | `'png'\|'jpeg'\|'webp'` | always |
| `moderation` | `'auto'\|'low'` | always |
| `background` | `'transparent'` | `opts.nativeTransparentBackground === true` |
| `size` | string (e.g. `'auto'`, `'1024x1024'`) | `!profile.codexCli` |
| `quality` | `'auto'\|'low'\|'medium'\|'high'` | `!profile.codexCli` |
| `output_compression` | number | `output_format !== 'png' && output_compression != null` |
| `n` | number | `params.n > 1` (**`n` is never sent when 1**) |
| `response_format` | `'b64_json'` | `profile.responseFormatB64Json === true` |
| `stream` | `true` | `profile.streamImages === true` |
| `partial_images` | number 0..3 (default 1) | `profile.streamImages === true` |

`getStreamPartialImages` = `profile.streamPartialImages ?? DEFAULT_STREAM_PARTIAL_IMAGES` (=1,
`openaiCompatibleImageApi.ts:28-30`, `types.ts:21`); normalized clamp 0..3 (`defaultApiUrl.ts:6-11`).

### 3.4 Response parsing (non-streaming)

`response.ok` false → `getApiErrorMessage` + possibly a streaming hint (§3.6, §10.5).

```ts
// src/lib/openaiCompatibleImageApi.ts:224-272 (abridged)
const data = payload.data
if (!Array.isArray(data) || !data.length) throw … '接口没有返回图片数据…' (err.rawResponsePayload = JSON.stringify(payload, null, 2))
const rawImageUrls = data.map((item) => item.url).filter(isHttpUrl)
for (const item of data) {
  const b64 = item.b64_json
  if (b64) { images.push(normalizeBase64Image(b64, mime)); revisedPrompts.push(item.revised_prompt ?? undefined); continue }
  if (isHttpUrl(item.url) || isDataUrl(item.url)) { images.push(await fetchImageUrlAsDataUrl(item.url, mime, signal)); … }
}
if (!images.length) throw … (err.rawResponsePayload = …)
const actualParams = mergeActualParams(pickActualParams(payload))
```

- `data[]` item preferred key order: `b64_json` first, then `url` (http/https or `data:`).
- `url` values are downloaded and converted to data URLs via `fetchImageUrlAsDataUrl`
  (`imageApiShared.ts:155-184`), which on `TypeError` probes with `mode: 'no-cors'` to distinguish
  "server blocks CORS" (`图片已生成，但因服务商未允许跨域…`), offline, or generic failures, and on
  `!ok` throws `图片 URL 下载失败：HTTP <status>`.
- `actualParams` for non-streaming responses come **only** from the payload root (`pickActualParams`,
  `imageApiShared.ts:206-223`: `size`, `quality ∈ {auto,low,medium,high}`, `output_format ∈ {png,jpeg,webp}`,
  `output_compression` (number), `moderation ∈ {auto,low}`, `n`). Item-level values are ignored here.
- If a URL download fails mid-way, `error.rawImageUrls` is attached (`:249-254`).
- Top-level JSON array responses are **not** normalized on this path (only the streaming result-event path
  normalizes arrays, §3.5). `NOT DETERMINED` whether any provider returns a bare array here; checked
  `parseImagesApiResponse` and its callers at `openaiCompatibleImageApi.ts:621`.

Response item / payload types (`src/types.ts:335-354`):

```ts
export interface ImageResponseItem {
  b64_json?: string; url?: string; revised_prompt?: string; size?: string; quality?: string
  output_format?: string; output_compression?: number; moderation?: string
}
export interface ImageApiResponse {
  data: ImageResponseItem[]
  size?: string; quality?: string; output_format?: string
  output_compression?: number; moderation?: string; n?: number
}
```

### 3.5 Streaming (`profile.streamImages === true`)

SSE only when the response `Content-Type` contains `text/event-stream`; otherwise the body is parsed as
plain JSON (`:617-621`).

```ts
// src/lib/openaiCompatibleImageApi.ts:7-9
export function isEventStreamResponse(response: Response): boolean {
  return response.headers.get('Content-Type')?.toLowerCase().includes('text/event-stream') ?? false
}
```

Event handling (`parseImagesApiStreamResponse`, `:287-364`):

| Trigger | Meaning |
|---|---|
| `type === 'image_generation.partial_image'` or `type === 'image_edit.partial_image'` | read `b64_json`, emit `onPartialImage({image, partialImageIndex: partial_image_index})`, continue |
| `object === 'image.generation.result'` or `object === 'image.edit.result'` | the whole event is an `ImageApiResponse` (via `normalizeImageApiPayload`: bare arrays become `{data: [...]}`) → **takes precedence over collected completed items** |
| `type === 'image_generation.completed'` or `type === 'image_edit.completed'` | push `eventToImageResponseItem(event)`: `b64_json, url, revised_prompt, size, quality, output_format, output_compression (number), moderation` |

Final resolution order: result payload (parsed by `parseImagesApiResponse`) → else completed items
(`b64_json` first, else http/data URL download) → else `'流式接口未返回最终图片数据'`.
`actualParams` = first item's actual params merged with `{n: images.length}` when >1 image.

### 3.6 Error shapes

```ts
// src/lib/imageApiShared.ts:186-204
export async function getApiErrorMessage(response: Response): Promise<string> {
  let errorMsg = `HTTP ${response.status}`
  const textResponse = response.clone()
  try {
    const errJson = await response.json()
    if (errJson.error?.message) errorMsg = errJson.error.message
    else if (typeof errJson.detail === 'string') errorMsg = errJson.detail
    else if (Array.isArray(errJson.detail)) errorMsg = errJson.detail.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('\n')
    else if (typeof errJson.error === 'string') errorMsg = errJson.error
    else if (errJson.message) errorMsg = errJson.message
  } catch { try { errorMsg = await textResponse.text() } catch {} }
  return errorMsg
}
```

Priority: `error.message` → `detail` (string) → `detail[]` (joined with `\n`) → `error` (string) →
`message` → raw body text → `HTTP <status>`.

On non-OK responses in OpenAI-compatible paths:

```ts
// src/lib/openaiCompatibleImageApi.ts:612-615
const errorMessage = await getApiErrorMessage(response)
throw new Error(maybeAppendStreamingHint(errorMessage, response.status, profile.streamImages))
```

`maybeAppendStreamingHint` (`imageApiShared.ts:127-135`) appends the "disable streaming" hint unless the
status is 401/403/404/408/429/≥500, and takes precedence for the transparent-background message
(`maybeAppendTransparentBackgroundHint`, `:121-124`, matches
`/transparent background is not supported for this model\.?/i`). ASCII hint texts: `imageApiShared.ts:108-111`.

---

## 4. Text-to-image — Responses API mode (`apiMode: 'responses'`)

Entry `callResponsesImageApi` (`openaiCompatibleImageApi.ts:989-1003`): `n === 1` → single request;
`n > 1` → **n** parallel identical single requests (`Promise.allSettled`, each returning one image),
merged by `mergeConcurrentApiResults`. `n` is never sent in the body.

### 4.1 URL / headers

```ts
// src/lib/openaiCompatibleImageApi.ts:1038-1047
const response = await fetch(buildApiUrl(profile.baseUrl, 'responses', proxyConfig, useApiProxy), {
  method: 'POST',
  headers: { ...requestHeaders, 'Content-Type': 'application/json' },
  cache: 'no-store',
  body: JSON.stringify(body),
  signal: controller.signal,
})
```

So `https://api.openai.com/v1/responses` for the default base URL; `Authorization: Bearer <key>`.

### 4.2 Body

```ts
// src/lib/openaiCompatibleImageApi.ts:1027-1036
const body: Record<string, unknown> = {
  model: profile.model,
  input: createResponsesInput(requestPrompt, inputImageDataUrls, opts.settings.allowPromptRewrite),
  tools: [createResponsesImageTool(params, inputImageDataUrls.length > 0, profile, opts.maskDataUrl, opts.nativeTransparentBackground)],
  tool_choice: 'required',
}
if (profile.reasoningEffort) body.reasoning = { effort: profile.reasoningEffort }
if (profile.streamImages) body.stream = true
```

`requestPrompt` is the raw prompt with the codexCli size sentence prepended when applicable
(`:1007-1009`); the prompt-rewrite guard is applied inside `createResponsesInput`, not to `input` when
images exist (it is part of the text part).

`input` construction (`:170-186`):

```ts
const text = allowPromptRewrite ? prompt : `${PROMPT_REWRITE_GUARD_PREFIX}\n${prompt}`
if (!inputImageDataUrls.length) return text                        // plain string
return [{
  role: 'user',
  content: [
    { type: 'input_text', text },
    ...inputImageDataUrls.map((dataUrl) => ({ type: 'input_image', image_url: dataUrl })),
  ],
}]
```

`PROMPT_REWRITE_GUARD_PREFIX` (`imageApiShared.ts:12`):
`'Treat everything after this line as one complete image-generation prompt, including the resolution instruction. Follow it exactly without rewriting or omitting anything:'`

Image tool (`:127-168`), field order as created:

```ts
const tool: Record<string, unknown> = {
  type: 'image_generation',
  action: isEdit ? 'edit' : 'generate',
  output_format: params.output_format,
  moderation: params.moderation,
}
if (!profile.codexCli) tool.size = params.size
if (profile.streamImages) tool.partial_images = getStreamPartialImages(profile)
if (!profile.codexCli) tool.quality = params.quality
if (params.output_format !== 'png' && params.output_compression != null) tool.output_compression = params.output_compression
if (nativeTransparentBackground) tool.background = 'transparent'
if (maskDataUrl) tool.input_image_mask = { image_url: maskDataUrl }
```

| Tool field | Included when |
|---|---|
| `type` | always (`'image_generation'`) |
| `action` | always (`'edit'` iff input images exist, else `'generate'`) |
| `output_format`, `moderation` | always |
| `size` | `!profile.codexCli` |
| `quality` | `!profile.codexCli` |
| `partial_images` | `profile.streamImages` |
| `output_compression` | `output_format !== 'png' && output_compression != null` |
| `background` | `'transparent'` iff `nativeTransparentBackground` |
| `input_image_mask` | iff `maskDataUrl` — value `{ image_url: <mask data URL> }` |
| `n` | never |

Body-level: `reasoning: { effort }` only when `profile.reasoningEffort` is set (allowed values
`none|minimal|low|medium|high|xhigh|max`, `types.ts:4-5`); `stream: true` only when `profile.streamImages`.

### 4.3 Non-streaming response extraction

```ts
// src/lib/openaiCompatibleImageApi.ts:188-222 (abridged)
const output = payload.output
if (!Array.isArray(output) || !output.length) throw '接口未返回图片数据' (rawResponsePayload attached)
for (const item of output) {
  if (item?.type !== 'image_generation_call') continue
  const b64 = getResponsesImageResultBase64(item.result)
  if (b64) results.push({ image: normalizeBase64Image(b64, fallbackMime),
    actualParams: mergeActualParams(pickActualParams(item)),
    revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined })
}
if (!results.length) throw '接口没有返回可识别的图片数据…' (rawResponsePayload attached)
```

`getResponsesImageResultBase64` (`imageApiShared.ts:55-71`) accepts `result` as:

- a non-empty (after `trim()`) **string** (raw base64), or
- an object, first non-undefined of `result.b64_json` → `result.base64` → `result.image` → `result.data`.

Only items with `type === 'image_generation_call'` are considered; item-level `size/quality/output_format/
output_compression/moderation` feed `actualParams` via `pickActualParams(item)`.

### 4.4 Streaming

Same rule: SSE only if `Content-Type` contains `text/event-stream`, else `response.json()`
(`:1054-1059`).

| Event | Handling (`parseResponsesApiStreamResponse`, `:378-431`) |
|---|---|
| `type === 'response.image_generation_call.partial_image'` | `partial_image_b64` → `onPartialImage({image, partialImageIndex: partial_image_index})` |
| `type === 'response.output_item.done'` and payload has `output[]` | append items to a collection |
| any other event whose `response` is an object | becomes the "completed payload" (last one wins) |
| event whose `item.type === 'image_generation_call'` | payload = `{output: [item]}` |

Payload lookup (`getResponsesStreamPayload`, `:366-376`) prefers `event.response`, else `event.item`.
Final payload = last completed payload, else `{output: collectedItems}`; then
`parseResponsesImageResults`; if that throws, retry with only items that carry a usable base64
(`:419-423`), else rethrow. Error `'流式接口未返回最终图片数据'` when no payload exists.

`ResponsesOutputItem` / `ResponsesApiResponse` types: `src/types.ts:367-425`.

---

## 5. Image editing / img2img

`isEdit = inputImageDataUrls.length > 0` decides the branch everywhere.

### 5.1 `openai` + Images API → multipart `images/edits`

```ts
// src/lib/openaiCompatibleImageApi.ts:500-565 (abridged)
const formData = new FormData()
formData.append('model', profile.model)
formData.append('prompt', prompt)
if (!profile.codexCli) formData.append('size', params.size)
formData.append('output_format', params.output_format)
formData.append('moderation', params.moderation)
if (opts.nativeTransparentBackground) formData.append('background', 'transparent')
if (!profile.codexCli) formData.append('quality', params.quality)
if (params.output_format !== 'png' && params.output_compression != null) formData.append('output_compression', String(params.output_compression))
if (params.n > 1) formData.append('n', String(params.n))
if (profile.responseFormatB64Json) formData.append('response_format', 'b64_json')
if (profile.streamImages) { formData.append('stream', 'true'); formData.append('partial_images', String(getStreamPartialImages(profile))) }

const imageBlobs: Blob[] = []
for (let i = 0; i < inputImageDataUrls.length; i++) {
  const dataUrl = inputImageDataUrls[i]
  const blob = opts.maskDataUrl && i === 0 ? await imageDataUrlToPngBlob(dataUrl) : await dataUrlToBlob(dataUrl)
  imageBlobs.push(blob)
}
const maskBlob = opts.maskDataUrl ? await maskDataUrlToPngBlob(opts.maskDataUrl) : null
…
for (let i = 0; i < imageBlobs.length; i++) {
  const blob = imageBlobs[i]
  const ext = blob.type.split('/')[1] || 'png'
  formData.append('image[]', blob, `input-${i + 1}.${ext}`)
}
if (maskBlob) formData.append('mask', maskBlob, 'mask.png')
```

Wire facts:

- Endpoint: POST `images/edits`; body is `multipart/form-data`; boundary set by the client (no manual
  `Content-Type`); headers = `Authorization` only.
- Image field name: **`image[]`**, one part per input image, filename `input-<i+1>.<ext>` where
  `<ext>` is `blob.type.split('/')[1] || 'png'`.
- Mask field name: **`mask`**, filename `mask.png`, always PNG.
- Encoding: input images are **not** sent as data URLs or base64 on this path — they are decoded into
  binary `Blob`s (`dataUrlToBlob` = `fetch(dataUrl).blob()`, falling back to `image/png` when the blob has
  no type; `canvasImage.ts:12-16`). When a mask is present the **first** image is re-encoded to PNG
  through a canvas (`imageDataUrlToPngBlob`, `canvasImage.ts:18-27`) so it matches the PNG mask;
  the remaining images keep their original bytes/type.
- Mask conversion: `maskDataUrlToPngBlob` keeps a PNG blob as-is, otherwise re-encodes via canvas
  (`canvasImage.ts:29-35`).
- Param inclusion for edits differs slightly from generate: `output_format` and `moderation` are appended
  before `quality`, and `n` is appended as a **string**; `n` only when `> 1`.
- b64-vs-URL handling and `actualParams` for edits use the same `parseImagesApiResponse` as §3.4.
- Streaming edits use the same SSE parser; edit events are `image_edit.partial_image` /
  `image_edit.completed` / `object: 'image.edit.result'` (§3.5).

Size guards (applied on both the built-in edit path and the custom multipart path):

```ts
// src/lib/imageApiShared.ts:10-11
export const MAX_MASK_EDIT_FILE_BYTES = 50 * 1024 * 1024        // 50 MiB
export const MAX_IMAGE_INPUT_PAYLOAD_BYTES = 512 * 1024 * 1024  // 512 MiB
```

- When a mask exists: both the mask target image **and** the mask file must be ≤ 50 MiB
  (`assertMaskEditFileSize('遮罩主图文件' | '遮罩文件', bytes)`).
- Total payload = sum of image blob sizes (+ mask blob size) must be ≤ 512 MiB
  (`assertImageInputPayloadSize`, `openaiCompatibleImageApi.ts:542-547`).
- Byte counts on the multipart path are *decoded blob sizes*; on JSON/Responses paths they are
  **encoded data-URL string lengths** (`getDataUrlEncodedByteSize` = `dataUrl.length`,
  `imageApiShared.ts:77-79`), and mask checks use `getDataUrlDecodedByteSize` (`:81-92`).

Input image count limit in the UI is 16 (`API_MAX_IMAGES`, `src/components/InputBar.tsx:26`).

### 5.2 Custom provider multipart edit

`editSubmit` is used when input images exist and it is defined; otherwise `submit`
(`openaiCompatibleImageApi.ts:436-438`, and identically `:917`).

```ts
// src/lib/openaiCompatibleImageApi.ts:717-761 (abridged)
const formData = new FormData()
const body = resolveTemplateValue(mapping.body ?? {}, context)
for (const [key, value] of Object.entries(body)) {
  if (value === undefined || value === null) continue
  if (Array.isArray(value)) for (const item of value) formData.append(key, String(item))
  else formData.append(key, String(value))
}
…
for (const file of mapping.files ?? []) {
  if (file.source === 'inputImages') {
    for (let i = 0; i < imageBlobs.length; i++)
      formData.append(file.field, imageBlobs[i], `input-${i + 1}.${blob.type.split('/')[1] || 'png'}`)
  } else if (file.source === 'mask' && maskBlob) {
    formData.append(file.field, maskBlob, 'mask.png')
  }
}
```

- Field names come from `files[].field`; the `array` flag is **informational only** — every file source
  appends one part per file regardless (the default manifest uses `image[]` for the images).
- A resolved array body value becomes repeated parts with the same key (`String(item)` each).
- All non-file body values are stringified (`true` → `"true"`, `3` → `"3"`; an array → `a,b`).
- The first input image is re-encoded to PNG only when a mask exists (`:737`).
- `response_format=b64_json` is appended last when `profile.responseFormatB64Json` (`:805-807`).
- Byte guards as in §5.1 (`:742-746`).
- When the mapped images are empty (no `inputImages` file source) the submitted payload is JSON/text only.

### 5.3 Custom provider JSON edit

If `contentType === 'json'` (or `editSubmit` is absent and `submit` is JSON), the same `submit` mapping is
used with `$inputImages.dataUrls` / `$mask.dataUrl` placeholders in the body, e.g. the sponsor preset
`9527 CODE` (`sponsor-presets.json:11-24`): `"images": "$inputImages.dataUrls"`,
`"maskDataUrl": "$mask.dataUrl"`. `response_format: 'b64_json'` is injected into the resolved body object
(`:816-818`). Pre-flight byte check uses encoded data-URL lengths (`:810-813`).

### 5.4 `openai` + Responses API edit

No separate endpoint: `tools[0].action = 'edit'`, the input images are `input_image` content parts with
`image_url` = data URL (base64 data URLs, not multipart), and the mask becomes
`tools[0].input_image_mask = { image_url: <mask data URL> }` (§4.2). Attached mask/size guards use decoded
sizes (`:1018-1025`).

### 5.5 `fal` edit

Endpoint gets `/edit` appended; `image_urls` = array of data URLs, `mask_url` = data URL
(`falAiImageApi.ts:21-24, 59-65`).

---

## 6. Async task mode

Only custom-provider manifests reach this path (`submitMapping.taskIdPath` present).

### 6.1 Submit → task id

```ts
// src/lib/openaiCompatibleImageApi.ts:924-939 (abridged)
const submitPayload = await submitCustomRequest(submitMapping, opts, profile, controller, proxyConfig, useApiProxy)
const taskIdValue = submitMapping.taskIdPath ? getByPath(submitPayload, submitMapping.taskIdPath) : undefined
const taskId = typeof taskIdValue === 'string' ? taskIdValue.trim() : String(taskIdValue ?? '').trim()
if (submitMapping.taskIdPath && !taskId) throw '无法从响应中提取异步任务 ID…' (err.rawResponsePayload)
if (!taskId) return extractCustomImages(submitPayload, submitMapping.result ?? {}, mime, controller.signal)
if (!customProvider.poll) throw new Error('异步接口返回了 task_id，但服务商配置缺少 poll')
opts.onCustomTaskEnqueued?.({ taskId })
if (timeoutId) { clearTimeout(timeoutId); timeoutId = null }   // submit timeout disabled from here on
return pollCustomTaskResult(profile, customProvider.poll, taskId, mime, controller.signal)
```

- `taskId` extraction uses the same path resolver as body templates (`getByPath`, §7) and accepts any
  scalar (non-strings are `String(...)`-coerced).
- If `taskIdPath` is configured but the value is empty → hard error with `rawResponsePayload`; if no
  `taskIdPath` is configured, the same response is parsed for images (sync path).
- After a task id is obtained, the submit `AbortController` timeout is **cancelled**, so the poll loop is
  not bounded by `profile.timeout` (`api.test.ts:1436+` asserts this).
- `onCustomTaskEnqueued({taskId})` is the persistence hook (stored as `task.customTaskId` /
  `customRecoverable`, `src/store.ts:3576-3582`) enabling resume after a reload.

### 6.2 Poll loop

```ts
// src/lib/openaiCompatibleImageApi.ts:838-894 (abridged)
let isFirstPoll = true
while (true) {
  if (isFirstPoll) { isFirstPoll = false }
  else if (signal) await sleep((poll.intervalSeconds ?? 5) * 1000, signal)
  else await new Promise((resolve) => setTimeout(resolve, (poll.intervalSeconds ?? 5) * 1000))

  const taskPath = appendQuery(buildTaskPath(poll.path, taskId), poll.query)
  let taskPayload: unknown
  try {
    const taskResponse = await fetch(buildApiUrl(profile.baseUrl, taskPath, proxyConfig, false), {
      method: poll.method ?? 'GET', headers: requestHeaders, cache: 'no-store', signal,
    })
    if (!taskResponse.ok) {
      if (isRetryablePollingStatus(taskResponse.status)) continue
      throw new Error(await getApiErrorMessage(taskResponse))
    }
    taskPayload = await taskResponse.json()
  } catch (err) {
    if (!signal?.aborted && isRecoverablePollingError(err)) continue
    throw err
  }

  const state = getTaskState(taskPayload, poll)
  if (state === 'failure') { … throw new Error(maybeAppendTransparentBackgroundHint(errorMessage)) }
  if (state === 'success') {
    try { return await extractCustomImages(taskPayload, poll.result, mime, signal) }
    catch (err) { if (!signal?.aborted && isRecoverablePollingError(err)) continue; throw err }
  }
}
```

| Aspect | Behaviour |
|---|---|
| First poll | **immediate** — no initial delay |
| Interval | `(poll.intervalSeconds ?? 5) * 1000` ms, between polls only; `intervalSeconds` clamped to ≥1 at normalization |
| Method / URL | `poll.method ?? 'GET'`; `buildApiUrl(baseUrl, path + query, proxyConfig, false)` — **API proxy is never used for polling** |
| Headers | `Authorization: Bearer <apiKey>` only (no Content-Type, no body even for POST) |
| Status read | `getByPath(payload, poll.statusPath)`, coerced to string via `String(status ?? '')` |
| Success | `successValues.includes(statusText)` |
| Failure | `failureValues.includes(statusText)` |
| Otherwise | pending → loop |
| Failure message | `errorPath` → `'message'` → `'data.fail_reason'` → `'error.message'` (first truthy), else `'异步任务失败'`; then `maybeAppendTransparentBackgroundHint` |
| Retryable HTTP statuses | `408`, `429`, `>= 500` → `continue` (retry after the next interval) |
| Other HTTP errors | `throw new Error(await getApiErrorMessage(taskResponse))` (terminal) |
| Recoverable thrown errors | `AbortError`, or message matching `/abort\|network\|failed to fetch\|fetch failed\|load failed\|timeout\|连接\|断开\|中断/i` → `continue` (`isRecoverablePollingError`, `:649-653`) |
| Result extraction failure | also retried when recoverable (e.g. result not yet present) |
| Overall timeout | **none** — loop runs until success/failure/terminal error or abort of the passed signal |
| Max attempts | none (`NOT DETERMINED` — no attempt counter exists; checked `pollCustomTaskResult` and both call sites) |
| Cancellation | only via the `AbortSignal` (the internal submit timeout is cleared before polling). The gallery path passes no external signal; `getCustomQueuedImageResult(profile, provider, taskId, params)` passes none at all (`:896-905`). `NOT DETERMINED` whether the UI can abort a running gallery task — checked `src/store.ts` for `AbortController` uses (only agent rounds and the API timeouts) |

Resume after reload uses the same loop:

```ts
// src/lib/openaiCompatibleImageApi.ts:896-905
export async function getCustomQueuedImageResult(profile, customProvider, taskId, params) {
  if (!customProvider.poll) throw new Error('自定义异步任务缺少 poll 配置')
  const mime = MIME_MAP[params.output_format] || 'image/png'
  return pollCustomTaskResult(profile, customProvider.poll, taskId, mime)
}
```

---

## 7. Result extraction mini-language

```ts
// src/lib/openaiCompatibleImageApi.ts:46-54 — single value (used by taskIdPath, statusPath, errorPath)
function getByPath(source: unknown, path: string | undefined): unknown {
  if (!path) return source
  return path.split('.').filter(Boolean).reduce<unknown>((current, key) => {
    if (current == null) return undefined
    if (/^\d+$/.test(key) && Array.isArray(current)) return current[Number(key)]
    if (typeof current === 'object') return (current as Record<string, unknown>)[key]
    return undefined
  }, source)
}

// src/lib/openaiCompatibleImageApi.ts:56-80 — many values (used by result.imageUrlPaths / b64JsonPaths)
function getAllByPath(source: unknown, path: string | undefined): unknown[] {
  if (!path) return [source]
  const parts = path.split('.').filter(Boolean)
  let current: unknown[] = [source]
  for (const key of parts) {
    const next: unknown[] = []
    for (const item of current) {
      if (item == null) continue
      if (key === '*') {
        if (Array.isArray(item)) next.push(...item)
        else if (typeof item === 'object') next.push(...Object.values(item as Record<string, unknown>))
        continue
      }
      if (/^\d+$/.test(key) && Array.isArray(item)) { next.push(item[Number(key)]); continue }
      if (typeof item === 'object') next.push((item as Record<string, unknown>)[key])
    }
    current = next
  }
  return current.flatMap((item) => Array.isArray(item) ? item : [item]).filter((item) => item != null)
}
```

Semantics summary:

- Path = `.`-separated keys; empty segments are dropped (`a..b` ≡ `a.b`); an empty/`undefined` path
  returns the whole source.
- Numeric segment on an array → index lookup (`data.0.task_id`).
- `*` (arrays only in `getAllByPath`) flattens: over array elements, or over object values.
- `getAllByPath` final flatten means a leaf that is itself an array is expanded one extra level — this is
  why the documented `data.result.images.*.url.*` pattern works.
- `null`/`undefined` leaves are filtered out by `getAllByPath`; `getByPath` returns `undefined` and stops
  at the first missing/null link.
- Extraction results are then filtered by type: URL paths keep only `http(s)://` or `data:` strings
  (`isHttpUrl`/`isDataUrl`, `imageApiShared.ts:43-49`); b64 paths keep only non-empty trimmed strings
  (`:763-791`).

Order and merging in `extractCustomImages` (`:763-791`): all `b64JsonPaths` values are pushed **first**
(in path order, then match order), then all downloaded URL values; `mime` wraps raw base64; failure to
download any URL sets `error.rawImageUrls`; zero images → error with `rawResponsePayload`.

---

## 8. Parameter compatibility

### 8.1 The normalization function (model/provider + apiMode → params)

```ts
// src/lib/paramCompatibility.ts:5-43
export const DEFAULT_FAL_IMAGE_SIZE = '1360x1024'
export const MAX_FAL_OUTPUT_IMAGES = 4
export const MAX_OPENAI_OUTPUT_IMAGES = 10

export function getOutputImageLimitForSettings(settings: AppSettings) {
  return getActiveApiProfile(settings).provider === 'fal' ? MAX_FAL_OUTPUT_IMAGES : MAX_OPENAI_OUTPUT_IMAGES
}

export function normalizeParamsForSettings(params: TaskParams, settings: AppSettings,
                                          options: { hasInputImages?: boolean } = {}): TaskParams {
  const activeProfile = getActiveApiProfile(settings)
  const outputImageLimit = getOutputImageLimitForSettings(settings)
  const nextParams: TaskParams = {
    ...params,
    size: normalizeImageSize(params.size) || DEFAULT_PARAMS.size,
    n: Math.min(outputImageLimit, Math.max(1, params.n || DEFAULT_PARAMS.n)),
  }

  if (isOpenAICompatibleProvider(settings, activeProfile.provider) && activeProfile.codexCli) {
    nextParams.size = normalizeCodexCliImageSize(nextParams.size)
    nextParams.quality = DEFAULT_PARAMS.quality          // 'auto'
  }

  if (activeProfile.provider === 'fal') {
    if (!options.hasInputImages && nextParams.size === 'auto') nextParams.size = DEFAULT_FAL_IMAGE_SIZE
    if (nextParams.quality === 'auto') nextParams.quality = 'high'
    nextParams.moderation = DEFAULT_PARAMS.moderation     // 'auto'
    nextParams.output_compression = DEFAULT_PARAMS.output_compression  // null
  }

  if (nextParams.output_format === 'png') {
    nextParams.output_compression = DEFAULT_PARAMS.output_compression  // null
  }

  return nextParams
}
```

Rules in effect (per provider / mode):

| Rule | Applies to | Effect |
|---|---|---|
| `n` clamp | every provider | `1 ≤ n ≤ 10`, except fal `1 ≤ n ≤ 4` |
| `size` normalization | every provider | `WxH` rounded/floored to multiples of 16, max edge 3840, max aspect 3, pixel bounds 655 360 … 8 294 400 (`src/lib/size.ts:1-69`); non-`WxH` strings (e.g. `auto`) pass through unchanged |
| codexCli size/quality | all OpenAI-compatible providers **including custom providers**, excluding fal | `size → normalizeCodexCliImageSize(size)` (1K-bounded, `size.ts:71-85`), `quality → 'auto'` |
| fal defaults | `provider === 'fal'` only | text-to-image + `size === 'auto'` → `1360x1024`; `quality 'auto' → 'high'`; `moderation → 'auto'`; `output_compression → null` |
| PNG compression | every provider | `output_format === 'png'` → `output_compression = null` |
| apiMode | only `provider === 'openai'` may be `'responses'`; all others forced `'images'` (`apiProfiles.ts:537`) | changes endpoint + body shape, not the param set |
| `transparent_output` | gallery only | UI-gated to gallery mode; only meaningful with `output_format ∈ {png, webp}`; if local post-processing is used, the API request is made with a keyed-background prompt and `params.transparent_output` stays effective while `nativeTransparentBackground` becomes false (`src/store.ts:1716-1723, 3564`) |

### 8.2 Per-field wire inclusion (exact conditions)

| Param | Images generate (JSON) | Images edit (multipart) | Responses tool | fal input |
|---|---|---|---|---|
| `size` | `!codexCli` | `!codexCli` | `!codexCli` | `image_size` (object, or `'auto'` when editing with `size==='auto'`) |
| `quality` | `!codexCli` | `!codexCli` | `!codexCli` | `quality` (`'auto'`→`'high'`) |
| `background` | `nativeTransparentBackground` → `'transparent'` | same | same (`tool.background`) | **never sent** (not in `createFalRequestInput`) |
| `output_format` | always | always | always | always |
| `moderation` | always | always | always | **never sent** |
| `output_compression` | `output_format !== 'png' && != null` | same, as string | same | **never sent** |
| `n` | `n > 1` only | `n > 1` only, as string | **never** (n parallel requests instead) | `num_images = min(4, max(1,n))` |
| `partial_images` | `streamImages` | `streamImages` | `streamImages` (in tool) | — |
| `response_format='b64_json'` | `profile.responseFormatB64Json` | same | — | — |

Custom providers: the body template decides; the only implicit injection is
`response_format: 'b64_json'` when `profile.responseFormatB64Json` (`:805-807`, `:816-818`).

### 8.3 `codexCli` prompt transforms

```ts
// src/lib/size.ts:87-93
export function prependCodexCliSizePrompt(prompt: string, size: string) {
  if (size === 'auto') return prompt
  const trimmed = prompt.trimStart()
  const hint = `Generate at ${size} resolution.`
  if (trimmed.startsWith(hint)) return trimmed
  return `${hint} ${trimmed}`
}
```

Then, unless `settings.allowPromptRewrite` is true, the prompt is prefixed with
`PROMPT_REWRITE_GUARD_PREFIX + '\n'` (`openaiCompatibleImageApi.ts:484-486` for Images API,
`:685-687` for custom providers, and inside `createResponsesInput` for Responses API). Codex CLI requests
therefore carry no `size`/`quality` parameters and the requested resolution is conveyed in the prompt
(verified: `api.test.ts:164-205, 1124-1131`). `stripInjectedCodexCliSizePrompt` (`size.ts:95-102`) removes
the injected sentence from `revised_prompt` values.

---

## 9. Defaults and configuration format

### 9.1 Constants

```ts
// src/lib/apiProfiles.ts:23-38
const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const RAW_DEFAULT_API_URL = readRuntimeEnv(import.meta.env.VITE_DEFAULT_API_URL)
const DEFAULT_OPENAI_API_PROXY = readRuntimeEnv(import.meta.env.VITE_API_PROXY_AVAILABLE) === 'true'
const DOCKER_DEPLOYMENT = readRuntimeEnv(import.meta.env.VITE_DOCKER_DEPLOYMENT) === 'true'
const DEFAULT_API_URL_PATCH = isImportableConfigUrl(RAW_DEFAULT_API_URL)
  ? null
  : parseDefaultApiUrl(RAW_DEFAULT_API_URL || (DOCKER_DEPLOYMENT && DEFAULT_OPENAI_API_PROXY ? '' : OPENAI_DEFAULT_BASE_URL))
const DEFAULT_BASE_URL = DEFAULT_API_URL_PATCH?.baseUrl ?? ''

export const DEFAULT_IMAGES_MODEL = 'gpt-image-2'
export const DEFAULT_RESPONSES_MODEL = 'gpt-5.6-sol'
export const DEFAULT_FAL_BASE_URL = 'https://fal.run'
export const DEFAULT_FAL_MODEL = 'openai/gpt-image-2'
export const DEFAULT_OPENAI_PROFILE_ID = 'default-openai'
export const DEFAULT_API_TIMEOUT = 600
```

- Default base URL: `https://api.openai.com/v1` (normal build without `VITE_DEFAULT_API_URL`); `''` when
  the deployment config is an importable URL/file (`embedded-config:` / `.json` / `?settings=`, see
  `importableConfigUrl.ts:3-14`), which combined with `apiProxy` yields same-origin requests.
- Default models: `gpt-image-2` (images), `gpt-5.6-sol` (responses; the settings UI swaps the model when
  `apiMode` changes, `src/components/SettingsModal.tsx:281`), `openai/gpt-image-2` (fal).
- Default timeout: **600 seconds** (`profile.timeout`, unit = seconds).
- `DEFAULT_STREAM_PARTIAL_IMAGES = 1` (`types.ts:21`); streaming default: only
  `provider === 'openai' && apiMode === 'responses'` (`apiProfiles.ts:101-103`).

### 9.2 Default profile shapes

```ts
// src/lib/apiProfiles.ts:356-396 (abridged)
export function createDefaultOpenAIProfile(overrides = {}): ApiProfile {
  const apiMode = overrides.apiMode ?? DEFAULT_API_URL_PATCH?.apiMode ?? 'images'
  const streamImages = overrides.streamImages ?? DEFAULT_API_URL_PATCH?.streamImages ?? getDefaultStreamImages('openai', apiMode)
  return {
    id: DEFAULT_OPENAI_PROFILE_ID, name: DEFAULT_API_URL_PATCH?.name ?? '默认',
    provider: 'openai', baseUrl: DEFAULT_BASE_URL, apiKey: DEFAULT_API_URL_PATCH?.apiKey ?? '',
    model: DEFAULT_API_URL_PATCH?.model ?? DEFAULT_IMAGES_MODEL, timeout: DEFAULT_API_TIMEOUT,
    reasoningEffort: DEFAULT_API_URL_PATCH?.reasoningEffort,
    codexCli: DEFAULT_API_URL_PATCH?.codexCli ?? false,
    apiProxy: DEFAULT_OPENAI_API_PROXY,
    streamPartialImages: DEFAULT_API_URL_PATCH?.streamPartialImages ?? DEFAULT_STREAM_PARTIAL_IMAGES,
    transparentBackgroundMethod: DEFAULT_API_URL_PATCH?.transparentBackgroundMethod ?? 'api',
    ...overrides, apiMode, streamImages,
  }
}

export function createDefaultFalProfile(overrides = {}): ApiProfile {
  return {
    id: `fal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: '新配置', provider: 'fal', baseUrl: DEFAULT_FAL_BASE_URL, apiKey: '',
    model: DEFAULT_FAL_MODEL, timeout: DEFAULT_API_TIMEOUT, apiMode: 'images',
    codexCli: false, apiProxy: false, streamImages: false,
    streamPartialImages: DEFAULT_STREAM_PARTIAL_IMAGES, transparentBackgroundMethod: 'local',
    ...overrides,
  }
}
```

Full profile shape (`types.ts:71-92`):

```ts
export interface ApiProfile {
  id: string
  isDefault?: boolean
  name: string
  description?: string
  provider: ApiProvider
  baseUrl: string
  apiKey: string
  model: string
  timeout: number                 // seconds
  apiMode: ApiMode                // 'images' | 'responses'
  reasoningEffort?: ReasoningEffort
  codexCli: boolean
  apiProxy: boolean
  responseFormatB64Json?: boolean
  streamImages?: boolean
  streamPartialImages?: number
  transparentBackgroundMethod: 'api' | 'local'
  providerDrafts?: Partial<Record<ApiProvider, Partial<Pick<ApiProfile, 'baseUrl' | 'model' | 'apiMode' |
    'reasoningEffort' | 'codexCli' | 'apiProxy' | 'responseFormatB64Json' | 'streamImages' |
    'streamPartialImages' | 'transparentBackgroundMethod'>>>>
}
```

Normalization highlights (`normalizeApiProfile`, `apiProfiles.ts:528-573`):

- unknown `provider` → `'openai'`; `apiMode` is `'responses'` only for `provider === 'openai'`;
- `apiProxy` forced `false` for `sb2api-async`;
- `streamImages` forced `false` for any non-`openai` provider;
- `codexCli: Boolean(record.codexCli)`;
- `transparentBackgroundMethod` forced `'local'` for custom providers that do not map
  `$params.background` in **both** `submit.body|query` and `editSubmit.body|query`
  (`customProviderCapabilities.ts:1-17`);
- fal `baseUrl` is trimmed of trailing `/`.

`validateApiProfile` (`apiProfiles.ts:854-860`) requires: non-empty name; non-empty baseUrl unless
`provider === 'fal'` or the API proxy is in use; non-empty apiKey; non-empty model.

### 9.3 `gpt-image-config.json` import/export format

Top level (both fields; `customProviders` may be `[]`):

```json
{
  "customProviders": [ /* CustomProviderDefinition[] */ ],
  "profiles": [ /* ApiProfile[] */ ]
}
```

Producer/consumer:

```ts
// src/lib/apiProfiles.ts:774-825 (abridged)
export function importCustomProviderSettingsFromJson(jsonText, existingProviders = [], options: {deploymentConfig?: boolean} = {}) {
  parsed = JSON.parse(stripMarkdownCodeFence(jsonText))          // ```json fences are stripped
  if (Array.isArray(record.customProviders)) { … }               // wrapped form
  const direct = normalizeCustomProviderDefinition(parsed, usedIds)   // single Manifest object
  if (direct) return { customProviders: [direct], profiles: [] }
  throw new Error('无法识别该 JSON。请粘贴自定义服务商配置。')
}
```

- Markdown code fences are stripped before parsing (`stripMarkdownCodeFence`, `:768-772`).
- Two accepted shapes: `{customProviders, profiles}` or a **single** provider manifest object.
- `deploymentConfig: true` (deployment presets) additionally validates provider ids
  (non-empty, not built-in, unique) and requires exactly one `isDefault: true` when more than one profile
  is present (`:588-623`).
- Wrapped form without `deploymentConfig` throws when no valid provider survives normalization.
- Export/share: `createCustomProfileImportUrl` embeds `{customProviders: [provider?], profiles: [profile]}`
  as the `settings` query parameter; `id`, `isDefault` and (optionally) `apiKey` are stripped
  (`profileImportUrl.ts:19-33`).
- Deployment env consumption: `VITE_DEFAULT_API_URL` / Docker `DEFAULT_API_URL` may be a raw URL with
  `?settings=…`, an `embedded-config:<base64>` payload, a local file path or an HTTP URL to a `.json`
  file; the Docker entrypoint base64-encodes files/URLs into `embedded-config:`
  (`deploy/inject-api-url.sh:45-85`, `customProviderConfigUrl.ts:26-58`).

`profiles[]` field meanings (documented table `README.md:472-487`, implemented in
`normalizeApiProfile`):

| Field | Meaning |
|---|---|
| `id` | stable profile id; same id on re-import updates in place instead of creating a new entry |
| `name` | display name (required by validation) |
| `description` | Markdown help card (preset only) |
| `provider` | `'openai'`, `'fal'`, `'sb2api-async'`, or a `customProviders[].id` |
| `baseUrl` | base URL; no trailing `/` ⇒ `/v1` is appended per OpenAI rules; trailing `/` ⇒ used as-is |
| `apiKey` | optional; recommended to omit so the user fills it in |
| `model` | model id |
| `apiMode` | `'images'` (default) or `'responses'` (openai only) |
| `isDefault` | exactly one `true` when several profiles are deployed |
| `timeout` | request timeout in seconds (default 600) |
| `apiProxy` | route through the deployment's same-origin API proxy (sync only) |
| `transparentBackgroundMethod` | `'api'` (native) or `'local'` (keyed-background post-processing) |

`presetProfileFields` (`ImportedProviderSettings`, `apiProfiles.ts:755-759`) is an export-only map
`profileId → string[]` recording which keys came from the deployment file
(`apiProfiles.ts:806-812`, consumed by `getPresetDeploymentFields`, `:1071-1074`). It is not part of the
protocol and is not sent to any API.

Example (repository template, `gpt-image-config.example.json`):

```json
{ "customProviders": [],
  "profiles": [{ "id": "example-openai", "name": "示例配置", "provider": "openai",
                 "baseUrl": "https://api.example.com/v1", "model": "gpt-image-2",
                 "apiMode": "images", "isDefault": true }] }
```

A real async custom provider entry (`sponsor-presets.json:3-40`): `submit.path = 'api/image-tasks'`,
`contentType: 'json'`, literal `"response_format": "url"`, `"async": true`, body mapped
`"images": "$inputImages.dataUrls"`, `"maskDataUrl": "$mask.dataUrl"`, `taskIdPath: "task_id"`, and
`poll` with `intervalSeconds: 2`, `statusPath: "status"`, `successValues: ["succeeded"]`,
`failureValues: ["failed","cancelled"]`, `errorPath: "error.message"`,
`result.imageUrlPaths: ["data.*.url"]` — and `profile.baseUrl: "https://tu.9527.codes/"` (trailing `/`
so `path` is used verbatim).

---

## 10. Implementation checklist / gotchas

1. **Headers.** Only `Authorization: Bearer <apiKey>` (+ `Content-Type: application/json` for JSON bodies).
   Never set `Content-Type` for multipart. No `OpenAI-Beta`/org/project headers, no `Cache-Control` or
   `Pragma`. Always `cache: 'no-store'` (`openaiCompatibleImageApi.ts:88-92, 602-605, 799-829`;
   assertion in `api.test.ts:1256-1276`).
2. **Timeouts.** `profile.timeout` seconds (default 600) via one `AbortController` per request:
   `setTimeout(() => controller.abort(), profile.timeout * 1000)`, cleared in `finally`
   (`:494-495`, `:1014-1015`, `:912-941`). Async custom providers clear it once a task id is received
   (§6.1). Errors surface as `AbortError`/`signal.reason`.
3. **Watchdog.** Gallery only, and only when the task is neither fal, nor async-custom, nor a concurrent
   multi-request run: a timer at `timeoutSeconds * 1000` after task creation fails the task with a timeout
   message (`src/store.ts:1106-1119`, `3534-3540`). Concurrent multi-request runs rely on per-request
   timeouts.
4. **Concurrency matrix** (`n > 1`):
   - `openai` + `images` → fan out into `n` concurrent single-image requests (`n: 1` each) when
     `codexCli` **or** `streamImages`; otherwise one request carrying `n`
     (`:449-477`). Under `codexCli` each fan-out request forces `quality: 'auto'` (`:464`).
   - `openai` + `responses` → always `n` concurrent single requests; `n` is never sent (`:989-1003`).
   - custom provider → concurrent only when `codexCli && n > 1 && !async`; async submissions keep the
     full `n` in one task (`:434-441`, `:976-987`; test `api.test.ts:1069-1133`).
   - `fal` → one call with `num_images`.
   - Partial results are preserved: failed sub-requests become `failedRequests[{requestIndex, error}]`
     while successful images are returned; only when **all** sub-requests fail is the first error thrown
     (`mergeConcurrentApiResults`, `:945-974`).
5. **Partial images.** Emitted only when streaming: `onPartialImage({image, partialImageIndex, requestIndex})`.
   Images API: event types `image_generation.partial_image` / `image_edit.partial_image`, payload key
   `b64_json`. Responses API: `response.image_generation_call.partial_image`, payload key
   `partial_image_b64`. Both wrap raw base64 with the request MIME. Count requested via `partial_images`
   (clamped 0..3, default 1).
6. **SSE parser contract** (`src/lib/serverSentEvents.ts`): blocks separated by a blank line; only `data:`
   lines are used (a single leading space after `data:` is stripped), lines starting with `:` are ignored,
   multiple `data:` lines are joined with `\n`, `[DONE]` and empty payloads are skipped, non-object/array
   JSON is ignored. Non-JSON data raises an error whose message is the raw data (plus the "disable
   streaming" hint). `response.body` missing → `'接口未返回可读取的流式响应'`. Abort signals cancel the
   reader. If no `data:` line was ever seen at end-of-stream →
   `'未从流式响应中解析到有效 data 事件'`. Event-level errors: `event.error` (object `message`, or string)
   or `type` ending with `.failed` (`message` or `'流式请求失败'`) → thrown
   (`openaiCompatibleImageApi.ts:112-125`).
7. **API proxy.** Enabling it makes every URL same-origin `<prefix>/<endpoint path>` (default prefix
   `/api-proxy`) and requires the deployment to serve it. Not allowed for: custom providers submitted with
   `GET` (`'API 代理暂不支持使用 GET 提交的自定义服务商…'`), custom providers with `taskIdPath` or `poll`
   (`'API 代理暂不支持使用异步任务的自定义服务商…'`), and polling (always called with `useApiProxy =
   false`) (`:918-923`, `:861`).
8. **Response_format.** `profile.responseFormatB64Json` adds `response_format: 'b64_json'` to the Images
   API JSON body / edit form data / custom-provider body. It is ignored in Responses mode.
9. **Image inputs to the Responses API are data URLs** (`input_image.image_url`), and masks go through
   `tool.input_image_mask.image_url`; there is no multipart anywhere in Responses mode.
10. **Payload/element limits.** ≤50 MiB per mask-edit file, ≤512 MiB total input payload, ≤16 UI input
    images, `n` ≤ 10 (OpenAI-compatible) / ≤4 (fal), `partial_images` ≤ 3,
    `streamPartialImages` clamped 0..3, `agentMaxToolRounds` clamped 1..50 (unrelated to image API).
11. **Error message surface.** Providers are expected to return OpenAI-style `{error: {message}}`; the
    fallback chain also handles `detail` (string or array), `error` (string) and `message` (§3.6).
    Raw payloads are attached to thrown errors as `error.rawResponsePayload` when parsing fails, and
    as `error.rawImageUrls` when URL downloads fail mid-way — a Node plugin should surface both.
12. **`n` = 1 is never transmitted** on the Images API and Responses API paths.
13. **Prompt text sent to the API** may differ from user input (mentions → `[image N]`, codexCli size
    sentence, rewrite guard, optional transparent-background key-color prompt from
    `src/lib/transparentImage.ts:17-43` when local post-processing is used). A plugin that wants raw
    prompts must disable `codexCli` and `allowPromptRewrite` and pass prompt text through unchanged.
14. **Agent/text API** (`/responses` chat tool-calling in `src/lib/agentApi.ts`) is a separate protocol
    from the image API; not covered here. `NOT DETERMINED` items are limited to: cancellation of a
    gallery image task and any provider that returns a bare top-level JSON array from
    `images/generations` (files checked: `src/store.ts`, `src/lib/openaiCompatibleImageApi.ts`,
    `src/lib/api.test.ts`).
