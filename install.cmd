@echo off
rem Subtitle Fetcher — Windows installer wrapper
where node >nul 2>nul || (echo [!] Node.js v18+ is required: https://nodejs.org & pause & exit /b 1)
cd /d "%~dp0"
node subtitles-fetcher.mjs setup
pause
