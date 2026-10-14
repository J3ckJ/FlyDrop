@echo off
cd /d "%~dp0"
if exist "release\FlyDrop-0.3.0-Windows.exe" (
  start "" "release\FlyDrop-0.3.0-Windows.exe"
  exit /b 0
)
where node >nul 2>nul
if errorlevel 1 (
  echo Use release\FlyDrop-0.3.0-Windows.exe or install Node.js 22.12 or newer from https://nodejs.org
  pause
  exit /b 1
)
if not exist "node_modules\electron\package.json" (
  call npm.cmd ci --no-fund --no-audit
  if errorlevel 1 (
    echo Dependency installation failed. Check your internet connection.
    pause
    exit /b 1
  )
)
call npm.cmd start
pause
