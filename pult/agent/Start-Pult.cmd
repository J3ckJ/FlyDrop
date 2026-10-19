@echo off
cd /d "%~dp0"
if exist "%~dp0pult.exe" (
  "%~dp0pult.exe" %*
  exit /b %errorlevel%
)
if exist "%~dp0..\dist\pult.exe" (
  "%~dp0..\dist\pult.exe" %*
  exit /b %errorlevel%
)
echo Нет pult.exe рядом с этим файлом.
echo Скачайте артефакт сборки GitHub Actions «Pult Windows» или соберите:
echo   cd pult
echo   set CGO_ENABLED=0
echo   go build -trimpath -o pult.exe .\win\cmd\pult
exit /b 1
