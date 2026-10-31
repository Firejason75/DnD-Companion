@echo off
title DnD Party Server
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed on this PC.
  echo Download it from https://nodejs.org , install it, then run this file again.
  echo.
  pause
  exit /b 1
)
node server.js
echo.
echo The server has stopped.
pause
