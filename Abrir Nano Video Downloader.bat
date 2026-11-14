@echo off
setlocal
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="

echo Verificando e compilando aplicacao...
call pnpm run build
if errorlevel 1 pause & exit /b 1

if exist "node_modules\electron\dist\electron.exe" (
  start "" "node_modules\electron\dist\electron.exe" .
) else (
  call pnpm start
)

