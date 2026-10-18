@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Нужен Node.js 22 или новее: https://nodejs.org
  exit /b 1
)
node src\index.js %*
