@echo off
setlocal
title NemoClaw project tests
rem The project root is this file's own folder, so it works from any current directory.
pushd "%~dp0"
node "%~dp0tests\run-tests.mjs" %*
set "result=%errorlevel%"
popd
echo.
if "%result%"=="0" (echo All tests passed.) else (echo Tests failed. Exit code %result%.)
pause
exit /b %result%
