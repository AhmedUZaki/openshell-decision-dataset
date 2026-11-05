@echo off
setlocal
chcp 65001 >nul
title NemoClaw Safety Router Dataset
rem The one launcher for the Safety Router Dataset. It takes no options; everything is chosen from the menu:
rem   1  Collect new data   the numbered collector (setup\Generate-Dataset.ps1 -> safety-router-dataset\collect-data\menu.mjs); real experiments, nothing starts until you type RUN
rem   2  Create Dataset     in ONE step: builds the Dataset from the saved Bundles (only read), validates it, verifies it independently, checks that the build
rem                         is deterministic, and saves it in a NEW folder named with its UTC creation time:
rem                         .local\safety-router\datasets\safety-router-dataset-YYYYMMDDTHHMMSSmmmZ\   (never overwrites anything)
if not "%~1"=="" (
  echo This launcher takes no options. Run it without arguments and use the menu.
  exit /b 2
)
pushd "%~dp0"
set /a bad=0
:menu
cls
echo ============================================================
echo   NemoClaw Safety Router Dataset
echo ============================================================
echo.
echo   1. Collect new data    (real experiments; nothing starts until you type RUN)
echo   2. Create Dataset      (build, validate, verify and save it in a timestamped folder)
echo   0. Exit
echo.
set "choice="
set /p "choice=Choose 0-2: "
if "%choice%"=="1" goto collect
if "%choice%"=="2" goto create
if "%choice%"=="0" goto done
echo.
echo Please type 0, 1 or 2.
set /a bad+=1
if %bad% GEQ 10 (echo No valid choice was given. Exiting.& goto done)
pause
goto menu

:collect
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\Generate-Dataset.ps1"
set "result=%errorlevel%"
goto again

:create
where node >nul 2>nul || (echo Node.js was not found. Run Install Everything.cmd first.& set "result=2"& goto again)
node "%~dp0safety-router-dataset\create-dataset\export-single-action-policy-tests.mjs"
set "result=%errorlevel%"
goto again

:again
echo.
if "%result%"=="0" (echo Finished.) else (echo Finished with errors: %result%)
pause
goto menu

:done
popd
exit /b 0