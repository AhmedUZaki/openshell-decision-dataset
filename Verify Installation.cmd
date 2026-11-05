@echo off
setlocal
title Verify NemoClaw Installation
pushd "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\Verify-Installation.ps1"
set "result=%errorlevel%"
popd
echo.
pause
exit /b %result%
