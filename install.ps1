<#
  dsh-gpt-image 一键安装（PowerShell 版）

  为什么是 .ps1 而不是全写在 .bat 里：
    .bat 用 UTF-8 存中文 + chcp 65001 在 Windows 上是出了名的不可靠 ——
    实测会出现「一行被拆成几段、每段都当成命令」的报错。
    所以 .bat 只做一件纯 ASCII 的事（调用本脚本），中文文案全在这里。
    本文件必须存成 **UTF-8 带 BOM**，否则 Windows PowerShell 5.1 会按 ANSI 解码成乱码。

  用法：
    一键安装.bat            → 正常安装（装完重启 DSH）
    一键安装.bat check      → 只检查，不改文件、不重启
    想跳过重启：set AUTO_NORESTART=1 后再运行
#>
[CmdletBinding()]
param(
  [string]$Mode = '',
  [switch]$Check,
  [switch]$NoRestart
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$PluginDir = $PSScriptRoot
$PkgScope  = '@dsh-external'
$PkgName   = 'dsh-gpt-image'
$IsCheck   = $Check -or ($Mode -ieq 'check')
$DoNoRestart = $NoRestart -or ($env:AUTO_NORESTART -eq '1')

$DshDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }

$failed  = $false
$target  = $null
$line = '=' * 62

function Say  ($t) { Write-Host $t }
function Ok   ($t) { Write-Host "  [OK] $t" -ForegroundColor Green }
function Bad  ($t) { Write-Host "  [X]  $t" -ForegroundColor Red; $script:failed = $true }
function Warn ($t) { Write-Host "  [!]  $t" -ForegroundColor Yellow }
function Hdr  ($t) { Write-Host ''; Say ('-' * 62); Say "  $t"; Say ('-' * 62) }

Say ''
Say $line
Say '   dsh-gpt-image   一键安装   v1.0.1'
Say $line
Say ''
Say "   插件目录 : $PluginDir"
Say "   DSH 目录 : $DshDir"
if ($IsCheck) { Say '   模式     : 只检查（不改动、不重启）' }
Say ''
Write-Host '   [重要] 这个包只在作者本机（Windows + Node 22）验证过。' -ForegroundColor Yellow
Write-Host '          换电脑可能装不上或跑不起来。装前请先读' -ForegroundColor Yellow
Write-Host '          「安装说明.html」顶部那段警告。' -ForegroundColor Yellow

# ---------------------------------------------------------------- 1. 操作系统
Hdr '[1/6] 操作系统'
if ($env:OS -ne 'Windows_NT') {
  Bad "这不是 Windows。本一键安装只支持 Windows。"
  Say '       其他系统请手动把整个文件夹放进 DSH 的 node_modules\@dsh-external\ 下。'
} else {
  Ok "Windows ($([System.Environment]::OSVersion.VersionString))"
}

# ---------------------------------------------------------------- 2. Node.js
Hdr '[2/6] Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Bad '找不到 node。请先安装 Node.js 20 或更新版本： https://nodejs.org/zh-cn'
} else {
  $nodeVer = (& node -v) 2>$null
  Say "   版本 : $nodeVer"
  $major = 0
  if ($nodeVer -match 'v(\d+)') { $major = [int]$Matches[1] }
  if ($major -ge 20) {
    Ok "Node 版本满足要求（>=20）"
  } else {
    Bad "需要 Node 20+，当前 $nodeVer 。下载： https://nodejs.org/zh-cn"
  }
}

# ---------------------------------------------------------------- 3. 找 profile
Hdr '[3/6] 定位 DSH 插件目录'
$profiles = Join-Path $DshDir 'profiles'
if (-not (Test-Path $profiles)) {
  Bad "找不到 $profiles"
  Say '       可能 DSH 还没装，或者 DSH_HOME 不在默认位置。'
  Say '       如果 DSH 装在别处，先设置环境变量 DSH_HOME 指向它的 .dsh 目录再运行。'
} else {
  $webNm = Join-Path $profiles 'web\node_modules'
  if (Test-Path $webNm) {
    $target = Join-Path $webNm "$PkgScope\$PkgName"
    Say '   profile  : web'
  } else {
    $cand = Get-ChildItem -Path $profiles -Directory -ErrorAction SilentlyContinue |
            Where-Object { Test-Path (Join-Path $_.FullName 'node_modules') } |
            Select-Object -First 1
    if ($cand) {
      $target = Join-Path $cand.FullName "node_modules\$PkgScope\$PkgName"
      Say "   profile  : $($cand.Name)  （没找到 web，退而用这个）"
    } else {
      Bad "$profiles 下没有任何带 node_modules 的 profile。"
      Say '       请先让 DSH 在浏览器里正常跑起来（http://127.0.0.1:3080），再重跑本脚本。'
    }
  }
}
if ($target) { Say "   目标位置 : $target" }

# ---------------------------------------------------------------- 4. 自检
Hdr '[4/6] 自检插件本体（跑 inventory）'
Push-Location $PluginDir
try {
  $invOut = & node 'scripts\inventory.mjs' 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    Bad '自检脚本执行失败。输出：'
    Say $invOut
  } else {
    $summary = ($invOut -split "`n" | Where-Object { $_ -match 'SUMMARY' } | Select-Object -First 1)
    if (-not $summary) {
      Bad '自检输出异常（没找到 SUMMARY 行），插件可能不完整。'
      Say $invOut
    } else {
      Say ('   ' + $summary.Trim())
      if ($summary -match 'SIDEBAR_OK=1') { Ok '侧栏 id 与 main 面板全部配对' }
      else { Warn '侧栏 id 与 main 面板没全部配对 —— 点了可能没反应' }
      if ($summary -match 'TOOLS=(\d+)') {
        $tools = [int]$Matches[1]
        if ($tools -ge 27) { Ok "$tools 个工具都在" } else { Warn "工具数只有 $tools（预期 27），插件可能不完整" }
      }
      if ($summary -match 'ROUTES=(\d+)') { Say "   服务端路由 : $($Matches[1]) 个" }
    }
  }
} catch {
  Bad "自检异常：$($_.Exception.Message)"
} finally {
  Pop-Location
}

# ---------------------------------------------------------------- 5. 安装
Hdr '[5/6] 安装到 DSH'
if ($IsCheck) {
  Say '   [跳过] 只检查模式：不安装、不重启。'
} elseif (-not $target) {
  Say '   [跳过] 没定位到目标目录，无法安装。见上面的 [3/6]。'
} else {
  $parent = Split-Path -Parent $target
  if (-not (Test-Path $parent)) {
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    Say "   已创建父目录 $parent"
  }

  if (Test-Path $target) {
    $item = Get-Item $target -Force
    $isLink = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
    if ($isLink) {
      Say '   目标位置已存在旧链接，先移除'
      cmd /c rmdir "$target" 2>$null | Out-Null
    } else {
      $bak = "$PkgName.bak-$((Get-Random -Maximum 99999))"
      Say "   目标位置已存在真实文件夹（可能是 npm 装的），改名备份为 $bak 后继续"
      Rename-Item -Path $target -NewName $bak -ErrorAction SilentlyContinue
    }
  }

  $linked = $false
  try {
    New-Item -ItemType Junction -Path $target -Target $PluginDir -ErrorAction Stop | Out-Null
    $linked = $true
  } catch {
    # 退路：cmd 的 mklink /J
    cmd /c mklink /J "$target" "$PluginDir" 2>$null | Out-Null
    $linked = ($LASTEXITCODE -eq 0)
  }

  if ($linked) {
    Ok "已建立目录链接：$target"
    Say '        链接方式下改插件代码即时生效'
  } else {
    Warn '创建目录链接失败（可能权限/跨卷限制），改用复制方式'
    try {
      Copy-Item -Path (Join-Path $PluginDir '*') -Destination $target -Recurse -Force -ErrorAction Stop
      Ok "已复制到 $target"
      Say '        复制方式下改插件代码不会即时生效（要重新复制）'
    } catch {
      Bad "复制也失败。请手动把整个文件夹拷到： $target"
    }
  }
}

# ---------------------------------------------------------------- 6. 结果
Hdr '[6/6] 结果'
if ($failed) {
  Bad '有失败项，请按上面的提示处理，然后重跑本脚本。'
  Say ''
  Say '   正在打开「安装说明.html」（警告 / 申请 API Key 入口 / 排错表）'
  Start-Process (Join-Path $PluginDir '安装说明.html') -ErrorAction SilentlyContinue
} elseif ($IsCheck) {
  Ok '环境检查全部通过。'
  Say '        可以正式安装了：双击「一键安装.bat」（不带参数）。'
} else {
  Ok '安装完成。'
  if ($DoNoRestart) {
    Say '   [跳过] AUTO_NORESTART / -NoRestart：不自动重启。'
    Say '          请自己双击「重启DSH并加载生图插件.bat」。'
  } else {
    Say ''
    Say '   接下来重启 DSH —— 插件界面必须重启才出现。'
    Say '   当前网页会断开（会话不会丢）。5 秒后开始，按 Ctrl+C 可取消。'
    Start-Sleep -Seconds 5

    Say ''
    Say '   结束监听 3080 的进程...'
    $found = $false
    try {
      $conns = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction Stop
      foreach ($c in $conns) {
        Say "     PID $($c.OwningProcess)"
        Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
        $found = $true
      }
    } catch {
      $lines = & netstat -ano 2>$null | Select-String ':3080' | Select-String 'LISTENING'
      foreach ($l in $lines) {
        $parts = ($l.ToString() -split '\s+') | Where-Object { $_ }
        $procId = $parts[-1]
        if ($procId -match '^\d+$') {
          Say "     PID $procId"
          Stop-Process -Id ([int]$procId) -Force -ErrorAction SilentlyContinue
          $found = $true
        }
      }
    }
    if (-not $found) { Say '     没发现监听 3080 的进程（可能本来没启动）' }
    Start-Sleep -Seconds 2
    Say '   启动 dsh web ...'
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'dsh web' -WindowStyle Minimized
    Say ''
    Ok '已重新启动。浏览器打开 http://127.0.0.1:3080 并按 Ctrl+F5 刷新。'
  }
  Say ''
  Say '   装好的标志：左侧栏出现 余额 / 生图 / 生视频 / 自动化 四个图标。'
  Say '   还没配 API Key？正在打开「安装说明.html」——里面有申请入口'
  Say '   （点了直接跳官网注册）和本插件用的那份配置。'
  Start-Process (Join-Path $PluginDir '安装说明.html') -ErrorAction SilentlyContinue
}

Say ''
if ([Console]::IsInputRedirected) {
  # 被脚本调用（没有交互终端）→ 直接退出，别卡在 Read-Host
} else {
  Write-Host '按回车键关闭...' -NoNewline
  [void](Read-Host)
}
if ($failed) { exit 1 } else { exit 0 }
