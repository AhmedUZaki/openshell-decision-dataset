@echo off
setlocal
title OpenClaw - OpenShell Conversation Workspace
pushd "%~dp0"
if not exist "tools\launchers\Start-OpenClaw.ps1" (
  echo The launcher files are missing. Keep this file in the project folder.
  popd
  pause
  exit /b 1
)
echo Starting OpenClaw with OpenShell Events, Policies, and Conversations...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\launchers\Start-OpenClaw.ps1" %*
set "launchResult=%errorlevel%"
popd
if not "%launchResult%"=="0" (
  echo.
  pause
)
exit /b %launchResult%
