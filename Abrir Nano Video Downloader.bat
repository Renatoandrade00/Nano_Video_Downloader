@echo off
setlocal
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE="

:: Adiciona caminhos comuns do Node, NVM e pnpm ao PATH desta sessao
set "PATH=%APPDATA%\nvm\v22.23.1;%LOCALAPPDATA%\pnpm;%APPDATA%\npm;%ProgramFiles%\nodejs;%PATH%"

echo Iniciando Nano Video Downloader...

if exist "node_modules\electron\dist\electron.exe" (
  start "" "node_modules\electron\dist\electron.exe" .
  exit /b 0
)

if exist "%LOCALAPPDATA%\Programs\nano-video-downloader\Nano Video Downloader.exe" (
  start "" "%LOCALAPPDATA%\Programs\nano-video-downloader\Nano Video Downloader.exe"
  exit /b 0
)

where pnpm >nul 2>nul && (
  call pnpm start
) || (
  where npm >nul 2>nul && (
    call npm start
  ) || (
    echo [ERRO] Nem o executavel local do Electron nem o pnpm/npm foram encontrados.
    echo Por favor, instale o aplicativo utilizando o instalador oficial "release\Nano Video Downloader Setup 1.1.0.exe".
    pause
    exit /b 1
  )
)
