@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Finances — Harutyunyan deploy

echo.
echo  Finances deploy
echo  Folder: %CD%
echo.

if not exist "%~dp0deploy-finances.ps1" (
  echo  ERROR: deploy-finances.ps1 is missing from this folder.
  echo  Keep Deploy Finances.bat, Deploy Finances.vbs and deploy-finances.ps1 together.
  echo.
  pause
  exit /b 1
)

where powershell >nul 2>&1
if errorlevel 1 (
  echo  ERROR: PowerShell is not on PATH.
  echo.
  pause
  exit /b 1
)

rem Double-click opens the deploy window.
rem Unattended website deploy:
rem   "Deploy Finances.bat" /deploy
rem Unattended website + Apps Script:
rem   "Deploy Finances.bat" /complete
rem Apps Script only:
rem   "Deploy Finances.bat" /script
rem Preflight only:
rem   "Deploy Finances.bat" /check

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-finances.ps1" %*
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" (
  echo.
  echo  Deploy helper exited with code %ERR%.
  pause
)
endlocal
exit /b %ERR%
