@echo off
REM ===========================================================================
REM  dsh-gpt-image one-click installer  (ASCII-only launcher)
REM
REM  Why this file is pure ASCII: a .bat saved as UTF-8 that switches to
REM  chcp 65001 breaks on Windows -- lines containing multi-byte characters
REM  get split into fragments and each fragment is treated as a command.
REM  So all Chinese text lives in install.ps1 (UTF-8 with BOM), and this
REM  launcher only calls it.
REM
REM  Usage:
REM    一键安装.bat            -> install (restarts DSH at the end)
REM    一键安装.bat check      -> environment check only, changes nothing
REM ===========================================================================
setlocal

set "PS1=%~dp0install.ps1"
if not exist "%PS1%" (
  echo [X] install.ps1 not found next to this file.
  echo     Please extract the whole zip first, then run 一键安装.bat again.
  pause
  exit /b 1
)

where powershell >nul 2>nul
if errorlevel 1 (
  echo [X] Windows PowerShell not found. This installer needs it.
  echo     Try: right-click install.ps1 -^> Run with PowerShell
  pause
  exit /b 1
)

REM -ExecutionPolicy Bypass: do not depend on machine policy (many boxes are
REM Restricted, where running a .ps1 would fail with a security error).
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
set "CODE=%ERRORLEVEL%"

if "%CODE%"=="0" (
  echo.
  echo Installer finished successfully.
) else (
  echo.
  echo Installer finished with errors ^(exit %CODE%^).
  echo Open 安装说明.html and read the troubleshooting table.
)

if defined NO_PAUSE exit /b %CODE%
pause
exit /b %CODE%
