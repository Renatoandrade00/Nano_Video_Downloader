@echo off
chcp 65001 > nul
title Inspecionar PDFs com Playwright - Nano Video Downloader
echo ========================================================================
echo   NANO VIDEO DOWNLOADER - INSPEÇÃO DE MATERIAIS COM PLAYWRIGHT
echo ========================================================================
echo.
echo Abrindo o navegador do Playwright na Aula 02...
echo.
node scripts/inspect_playwright.mjs
echo.
echo ========================================================================
echo   Inspeção concluída!
echo ========================================================================
pause
