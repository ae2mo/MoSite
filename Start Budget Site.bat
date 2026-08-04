@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem ---- Auto-update from GitHub, if this copy was made with "git clone" ----
rem Runs before anything else so you're always launching the latest pushed
rem version. Safe by design: git reset --hard only touches files tracked by
rem git (the site's code) - data.json, meals_data.json, backups/, and any
rem config files with secrets are all listed in .gitignore, so they're never
rem tracked and this can never overwrite your personal data. Skips quietly
rem (never blocks startup) if git isn't installed, this folder didn't come
rem from "git clone" (no .git folder), or there's no internet right now.
where git >nul 2>nul
if !errorlevel!==0 (
    if exist ".git" (
        echo Checking for updates...
        git fetch --quiet origin >nul 2>nul
        if !errorlevel!==0 (
            set GITBRANCH=
            for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set GITBRANCH=%%b
            if not "!GITBRANCH!"=="" (
                git reset --hard origin/!GITBRANCH! --quiet >nul 2>nul
                if !errorlevel!==0 (
                    echo Up to date.
                ) else (
                    echo Couldn't apply updates ^(unusual git state^) - continuing with the current version.
                )
            )
        ) else (
            echo No internet, or couldn't reach GitHub - continuing with the current version.
        )
        echo.
    )
)

set PYCMD=
where python >nul 2>nul
if !errorlevel!==0 set PYCMD=python
if "!PYCMD!"=="" (
    where py >nul 2>nul
    if !errorlevel!==0 set PYCMD=py
)

if "!PYCMD!"=="" (
    echo Could not find Python. Install it from https://www.python.org/downloads/
    echo and make sure "Add python.exe to PATH" is checked during setup, then
    echo run this file again.
    pause
    goto :eof
)

echo Checking requirements (only needed the first time, or after an update)...
echo.
!PYCMD! -m pip install --disable-pip-version-check -r requirements-stocks.txt -r requirements-tray.txt -r requirements-statement-import.txt
if not !errorlevel!==0 (
    echo.
    echo Warning: couldn't install some requirements. The Stock Trader page
    echo needs internet the first time; the tray icon needs pystray/Pillow;
    echo the Budget page's Import Statement feature needs pdfplumber. The
    echo rest of the Budget page and the Meal Planner page need nothing
    echo extra either way.
    echo.
)

rem Prefer starting with no console window at all - just a small icon in
rem the system tray, near the clock, like most other background apps.
rem Falls back to a normal console window if pythonw isn't available.
rem tray_launcher.py itself handles a missing pystray/Pillow (logs to
rem tray_launcher_error.log and exits) - no need to duplicate that check
rem here in batch.
set PYWCMD=
where pythonw >nul 2>nul
if !errorlevel!==0 set PYWCMD=pythonw
if "!PYWCMD!"=="" (
    where pyw >nul 2>nul
    if !errorlevel!==0 set PYWCMD=pyw
)

if "!PYWCMD!"=="" (
    echo Starting Home Budget Planner ^(console window^)...
    echo.
    !PYCMD! server.py
    echo.
    echo Server stopped.
    pause
    goto :eof
)

echo Starting Home Budget Planner in the system tray...
del /f /q "tray_launcher_error.log" >nul 2>nul
start "" "!PYWCMD!" "%~dp0tray_launcher.py"

echo Waiting for it to come up...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ok=$false; for($i=0;$i -lt 12;$i++){try{$r=Invoke-WebRequest -Uri 'http://127.0.0.1:8000/' -UseBasicParsing -TimeoutSec 3; if($r.StatusCode -eq 200){$ok=$true; break}}catch{Start-Sleep -Milliseconds 500}}; if(-not $ok){exit 1}"

if !errorlevel!==0 (
    echo.
    echo Success - the site is responding at http://localhost:8000
    echo Look for the blue $ icon in the system tray ^(near the clock^).
    timeout /t 4 >nul
    goto :eof
)

echo.
echo The site isn't responding yet. Checking for a startup error...
if exist "tray_launcher_error.log" (
    echo.
    echo ---- tray_launcher_error.log ----
    type "tray_launcher_error.log"
    echo ----------------------------------
) else (
    echo No tray_launcher_error.log was written, so the tray process may
    echo still be starting slowly, or Windows Firewall/antivirus may be
    echo prompting for permission in a window that's hidden behind this one.
    echo Try again in a few seconds, or run "!PYCMD! server.py" directly to
    echo see everything in a console window.
)
echo.
pause
