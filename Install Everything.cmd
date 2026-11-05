@echo off
setlocal
title Install NemoClaw Portable Workspace
pushd "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\Install-Everything.ps1" %*
set "result=%errorlevel%"
popd
echo.
if "%result%"=="10" echo Restart or finish Ubuntu setup, then run this file again.
if not "%result%"=="0" pause
exit /b %result%
