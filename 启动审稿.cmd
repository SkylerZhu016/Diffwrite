@echo off
setlocal
cd /d "%~dp0"
if exist "%ProgramFiles%\nodejs\node.exe" (
  "%ProgramFiles%\nodejs\node.exe" server.mjs --open
) else (
  node server.mjs --open
)
if errorlevel 1 pause
