@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0dist\Diffwrite-editor.exe" (
  start "" "%~dp0dist\Diffwrite-editor.exe"
  exit /b
)
if exist "%~dp0dist\Diffwrite.exe" (
  start "" "%~dp0dist\Diffwrite.exe"
  exit /b
)
if exist "%ProgramFiles%\nodejs\node.exe" (
  "%ProgramFiles%\nodejs\node.exe" server.mjs --open
) else (
  node server.mjs --open
)
if errorlevel 1 pause
