@echo off
rem ===== ShortReserve server process (started minimized by the launcher) =====
rem ASCII only. Japanese text breaks .bat parsing on a Japanese Windows (CP932 vs UTF-8).
rem Kept as a separate file so the launcher can start it without fragile nested quotes.
cd /d "%~dp0"
"C:\Program Files\nodejs\npm.cmd" run start -- -p 3002
rem If npm exits (error), keep the window so the message is visible.
echo.
echo The server has stopped. Close this window or press a key.
pause >nul
