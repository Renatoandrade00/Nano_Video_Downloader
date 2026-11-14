@echo off
setlocal
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="

:: Adiciona caminhos do Node, NVM e pnpm ao PATH desta sessao
set "PATH=%APPDATA%\nvm\v22.23.1;%LOCALAPPDATA%\pnpm;%APPDATA%\npm;%ProgramFiles%\nodejs;%PATH%"

echo Iniciando Nano Video Downloader...

if exist "node_modules\electron\dist\electron.exe" (
  start "" "node_modules\electron\dist\electron.exe" .
) else (
  where pnpm >nul 2>nul && (
    call pnpm start
  ) || (
    call npm start
  )
)
