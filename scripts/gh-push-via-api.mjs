/**
 * 用 GitHub **Git 数据 API** 提交并更新 main 分支。
 *
 * 为什么需要它：这台机器访问 github.com:443 超时（git push 走 443），
 * 但 api.github.com 是通的。所以 push 的替代路径是：
 *   建 blob → 建 tree → 建 commit → 移动 ref
 * 效果等价于一次 push，而且只产生**一个** commit（不是一文件一提交）。
 *
 * 用法（在仓库根目录）：
 *   gh-push-via-api.mjs "提交信息文件路径" [父提交 sha，默认 HEAD]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const REPO = 'yyfabab1/dsh-gpt-image'
const BRANCH = 'main'
const MSG_FILE = process.argv[2]
const commitMessage = readFileSync(MSG_FILE, 'utf8')

function gh(args, input) {
  // 用 gh api 走已登录的凭据；--input - 让大文件也安全（不走命令行参数）
  const out = execFileSync('gh', ['api', ...args], {
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PATH: `${process.env.PATH};C:\\Program Files\\GitHub CLI` },
  })
  return out.trim()
}
function ghJson(args, body) {
  const raw = gh([...args, '--input', '-'], JSON.stringify(body))
  return raw ? JSON.parse(raw) : null
}

// ---------- 1. 本地改了哪些文件 ----------
// 必须带 -c core.quotepath=false：否则中文文件名会返回成 "\345\210\206..." 这种八进制定界，
// 直接拿去 readFileSync 会 ENOENT（实测踩过）。
const changed = execFileSync('git', ['-c', 'core.quotepath=false', 'diff', '--name-only', `origin/${BRANCH}`, 'HEAD'], { encoding: 'utf8' })
  .split('\n').map((s) => s.trim()).filter(Boolean)
if (changed.length === 0) { console.log('没有差异，不用提交'); process.exit(0) }
console.log(`要提交 ${changed.length} 个文件：`)
for (const f of changed) console.log('  ' + f)

// ---------- 2. 父提交与基线 tree ----------
const parentSha = gh(['repos/' + REPO + '/git/ref/heads/' + BRANCH, '--jq', '.object.sha'])
const parentCommit = JSON.parse(gh(['repos/' + REPO + '/git/commits/' + parentSha]))
const baseTree = parentCommit.tree.sha
console.log(`\n父提交 ${parentSha.slice(0, 8)}  基线 tree ${baseTree.slice(0, 8)}`)

// ---------- 3. 逐个上传 blob ----------
const tree = []
for (const file of changed) {
  const buffer = readFileSync(file)
  const deleted = buffer.length === 0 && false // 这里没有删除，留着占位说明
  const blob = ghJson(['repos/' + REPO + '/git/blobs', '-X', 'POST'], {
    content: buffer.toString('base64'),
    encoding: 'base64',
  })
  tree.push({ path: file, mode: '100644', type: 'blob', sha: blob.sha })
  console.log(`  blob ${blob.sha.slice(0, 8)}  ${file}  (${buffer.length} B)`)
}

// ---------- 4. 建 tree / commit / 移动 ref ----------
const newTree = ghJson(['repos/' + REPO + '/git/trees', '-X', 'POST'], { base_tree: baseTree, tree })
console.log(`\n新 tree ${newTree.sha.slice(0, 8)}`)

const newCommit = ghJson(['repos/' + REPO + '/git/commits', '-X', 'POST'], {
  message: commitMessage,
  tree: newTree.sha,
  parents: [parentSha],
})
console.log(`新提交 ${newCommit.sha.slice(0, 12)}`)

ghJson(['repos/' + REPO + '/git/refs/heads/' + BRANCH, '-X', 'PATCH'], { sha: newCommit.sha, force: false })
console.log(`已更新 ${BRANCH} → ${newCommit.sha.slice(0, 12)}`)

// ---------- 5. 让本地 remote-tracking ref 跟上（fetch 走 443 不通） ----------
execFileSync('git', ['update-ref', `refs/remotes/origin/${BRANCH}`, newCommit.sha])
console.log('本地 origin/' + BRANCH + ' 已同步')

console.log(`\n完成：https://github.com/${REPO}/commit/${newCommit.sha}`)
