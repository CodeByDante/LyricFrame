@echo off
setlocal
cd /d "%~dp0"
if not exist "runtime\node.exe" (
  echo Falta runtime\node.exe. Extrae el ZIP completo antes de abrir LyricFrame.
  pause
  exit /b 1
)
echo Abriendo LyricFrame. Deja esta ventana abierta mientras lo uses.
"runtime\node.exe" "server.mjs"
if errorlevel 1 pause
