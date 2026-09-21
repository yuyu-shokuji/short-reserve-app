@echo off
rem ===== ShortReserve launcher (local trial, self-healing) =====
rem ASCII only. Japanese text breaks .bat parsing on a Japanese Windows (CP932 vs UTF-8).
rem Port 3002 so it does not collide with meal-app (3000).
setlocal
cd /d "%~dp0"
title ShortReserve launcher
set URL=http://localhost:3002

echo.
echo   Short Reserve - starting up
echo   ----------------------------------------
echo.

rem 1) If a server on 3002 actually RESPONDS, just open the browser.
curl -s -o nul --max-time 3 "%URL%/" && (
    echo   Already running. Opening the browser.
    start "" "%URL%"
    exit /b 0
)

rem 2) Not responding. Kill any stale/orphaned process still LISTENING on 3002.
for /f "tokens=5" %%p in ('netstat -ano ^| find ":3002 " ^| find "LISTENING"') do (
    echo   Cleaning up a stale server ^(PID %%p^)...
    taskkill /F /PID %%p >nul 2>&1
)

rem 3) Wait until nothing is LISTENING on 3002 any more (up to ~10s).
rem    Only LISTENING counts: sockets left in TIME_WAIT do not stop a new server
rem    from binding, and waiting for them used to add ~40s of doing nothing.
rem    Use ping as the delay (timeout fails when stdin is redirected).
set /a w=0
:waitfree
netstat -an | find ":3002 " | find "LISTENING" >nul 2>&1
if errorlevel 1 goto build
set /a w+=1
if %w% geq 10 goto build
ping -n 2 127.0.0.1 >nul
goto waitfree

:build
rem Build once if there is no production build yet.
if not exist ".next\BUILD_ID" (
    echo   Building the app. This takes a minute the first time...
    call "C:\Program Files\nodejs\npm.cmd" run build
    if errorlevel 1 goto builderror
)

rem 4) Start the server in its own window (run-server.bat avoids fragile nested quotes).
echo   Starting the server...
start "ShortReserve server" /min cmd /k "%~dp0run-server.bat"

set /a count=0
:waitup
curl -s -o nul --max-time 2 "%URL%/" && goto ready
set /a count+=1
if %count% geq 60 goto timeoutmsg
set /a sec=%count%*2
echo   waiting for the server... %sec%s
ping -n 3 127.0.0.1 >nul
goto waitup

:ready
echo.
echo   Ready. Opening the browser.
start "" "%URL%"
exit /b 0

:builderror
echo.
echo   The build failed. Read the messages above.
echo.
pause
exit /b 1

:timeoutmsg
echo.
echo   Could not confirm the server started.
echo   Check the "ShortReserve server" window in the taskbar for errors.
echo   Opening the browser anyway: %URL%
echo.
start "" "%URL%"
pause
exit /b 1
