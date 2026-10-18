@echo off
chcp 65001 >nul
title 重启 DSH 并加载「AI 生图」插件
echo ============================================
echo  重启 DSH web（让生图插件的客户端半边生效）
echo ============================================
echo.
echo 说明：插件的「左侧栏生图图标 / 对话里的生图按钮」属于客户端半边，
echo       必须在 DSH 启动时组图才会出现 —— 改完插件后需要重启一次。
echo.
echo 注意：重启会让当前对话页面断开（会话不会丢），重启后按 Ctrl+F5 刷新即可。
echo.
pause

echo [1/3] 找到并结束当前 dsh web（监听 3080 的进程）...
set FOUND=0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3080" ^| findstr LISTENING') do (
  echo     结束进程 PID %%p
  taskkill /PID %%p /F >nul 2>&1
  set FOUND=1
)
if "%FOUND%"=="0" echo     没有发现监听 3080 的进程（可能已经停了）

echo [2/3] 等待 2 秒...
timeout /t 2 /nobreak >nul

echo [3/3] 重新启动 dsh web ...
start "" cmd /c "dsh web"

echo.
echo 完成！浏览器打开 http://127.0.0.1:3080 并刷新（Ctrl+F5）。
echo   - 左侧栏应出现「生图」图标 → 点开是项目生图整页
echo   - 对话/轨迹那一行也应出现「生图」按钮
echo.
pause
