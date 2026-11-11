@echo off
setlocal
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="

if not exist "dist\main\index.js" (
  call pnpm run build
  if errorlevel 1 pause & exit /b 1
)

if not exist "dist\renderer\index.html" (
  call pnpm run build
  if errorlevel 1 pause & exit /b 1
)

if exist "node_modules\electron\dist\electron.exe" (
  start "" "node_modules\electron\dist\electron.exe" .
) else (
  call pnpm start
)

