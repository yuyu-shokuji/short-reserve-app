@echo off
rem ===== ShortReserve launcher (local trial, self-healing) =====
rem ASCII only. Japanese text breaks .bat parsing on a Japanese Windows (CP932 vs UTF-8).
rem Port 3002 so it does not collide with meal-app (3000).
cd /d "%~dp0"

rem 1) If a server on 3002 actually RESPONDS, just open the browser.
curl -s -o nul --max-time 3 "http://localhost:3002/" && (
    start "" http://localhost:3002
    exit /b 0
)

rem 2) Port 3002 is not responding. Kill any stale/orphaned process holding it.
for /f "tokens=5" %%p in ('netstat -ano ^| find ":3002 " ^| find "LISTENING"') do taskkill /F /PID %%p >nul 2>&1

rem 3) Wait until port 3002 is fully released (up to 40s).
rem    Use ping as the delay (timeout fails when stdin is redirected / launched non-interactively).
set /a w=0
:waitfree
netstat -an | find ":3002 " >nul 2>&1
if errorlevel 1 goto build
set /a w+=1
if %w% geq 40 goto build
ping -n 2 127.0.0.1 >nul
goto waitfree

:build
rem Build once if there is no production build yet.
if not exist ".next\BUILD_ID" (
    echo Building the app... this may take a minute. Please wait.
    call "C:\Program Files\nodejs\npm.cmd" run build
)

rem 4) Start the server in a separate minimized window.
start "ShortReserve" /min cmd /k "%~dp0run-server.bat"

echo Starting the app... please wait.
set /a count=0
:waitup
curl -s -o nul --max-time 2 "http://localhost:3002/" && (
    start "" http://localhost:3002
    exit /b 0
)
set /a count+=1
if %count% geq 90 goto timeoutmsg
ping -n 2 127.0.0.1 >nul
goto waitup

:timeoutmsg
echo Could not confirm startup. Opening the browser anyway.
start "" http://localhost:3002
exit /b 0
