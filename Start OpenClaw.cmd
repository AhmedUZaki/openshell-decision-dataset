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
echo.
if "%launchResult%"=="0" (
  echo ============================================================
  echo  OpenClaw has started. The dashboard is open in your browser:
  echo  http://127.0.0.1:18789/
  echo.
  echo  Chat with the Agent there. The OpenShell panel on the right
  echo  shows its tool calls, their results and OpenShell decisions.
  echo ============================================================
  echo.
  echo Press any key to close this window. OpenClaw keeps running.
) else (
  echo OpenClaw did not start. Review the error above.
  echo Press any key to close this window.
)
pause >nul
exit /b %launchResult%
