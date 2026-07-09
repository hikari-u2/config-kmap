@echo off
REM One-click launcher for the Config Knowledge Map PowerShell server.
REM Double-click this file (or pin a shortcut to it) to start the server
REM and open the app in your default browser.

setlocal
cd /d "%~dp0"

set "PORT=8080"

REM Open the browser shortly after the server starts listening.
start "" /min cmd /c "timeout /t 2 >nul & start "" http://localhost:%PORT%"

where pwsh >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    pwsh -NoLogo -File "%~dp0server.ps1" -Port %PORT%
) else (
    powershell -NoLogo -ExecutionPolicy Bypass -File "%~dp0server.ps1" -Port %PORT%
)

echo.
echo Server stopped.
pause
