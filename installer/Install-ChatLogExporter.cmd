@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title ChatLogExporter 설치

echo.
echo   ====================================================
echo     ChatLogExporter  (BetterDiscord 플러그인) 설치
echo   ====================================================
echo.

if not exist "%APPDATA%\BetterDiscord" (
  echo   [!] BetterDiscord 가 설치되어 있지 않아요.
  echo       먼저 https://betterdiscord.app 에서 BetterDiscord 를 설치한 뒤
  echo       이 파일을 다시 실행해 주세요.
  echo.
  pause
  exit /b 1
)

set "DEST=%APPDATA%\BetterDiscord\plugins"
if not exist "%DEST%" mkdir "%DEST%"

echo   플러그인을 내려받는 중...  (잠깐만요)
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;" ^
  "$u='https://raw.githubusercontent.com/NampleS/ChatLogExporter/main/ChatLogExporter.plugin.js';" ^
  "$d=Join-Path $env:APPDATA 'BetterDiscord\plugins\ChatLogExporter.plugin.js';" ^
  "try { Invoke-WebRequest -Uri $u -OutFile $d -UseBasicParsing -ErrorAction Stop;" ^
  "  if ((Get-Item $d).Length -lt 5000) { throw '받은 파일이 너무 작아요.' };" ^
  "  Write-Host ('  설치 완료: ' + $d) -ForegroundColor Green }" ^
  "catch { Write-Host ('  [실패] ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }"

if errorlevel 1 (
  echo.
  echo   내려받기에 실패했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.
  echo.
  pause
  exit /b 1
)

echo.
echo   ----------------------------------------------------
echo   다 됐어요!  이제 디스코드에서:
echo     설정 → 플러그인(Plugins) 에서 ChatLogExporter 를 켜세요.
echo     (이미 켜져 있었다면 자동으로 다시 읽혀요)
echo.
echo   앞으로 새 버전이 나오면 플러그인이 알아서 업데이트돼요.
echo   ----------------------------------------------------
echo.
pause
exit /b 0
