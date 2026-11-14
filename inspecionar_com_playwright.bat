@echo off
setlocal
cd /d "%~dp0"
set "PATH=%APPDATA%\nvm\v22.23.1;%LOCALAPPDATA%\pnpm;%APPDATA%\npm;%ProgramFiles%\nodejs;%PATH%"
node scripts\inspect_playwright.mjs
pause
