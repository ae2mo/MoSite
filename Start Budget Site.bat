@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem ---- Which Python to use ------------------------------------------------
rem 1) A Python already installed on this computer, if there is one.
rem 2) Otherwise a private, portable copy kept in the "python-embed" folder
rem    next to this file. It's downloaded automatically the first time
rem    (about 25 MB from python.org), needs no admin rights, and installs
rem    nothing on Windows itself - delete the folder to remove it.
set "EMBED_DIR=%~dp0python-embed"
set PYVER=3.12.10
set PYTAG=312

set PYCMD=
set PYWCMD=

rem Actually run each candidate: Windows ships a "python" shortcut that only
rem opens the Microsoft Store, so just finding the name isn't enough.
for %%c in (python py) do (
    if "!PYCMD!"=="" (
        %%c -c "import sys" >nul 2>nul
        if !errorlevel!==0 set PYCMD=%%c
    )
)

if not "!PYCMD!"=="" (
    where pythonw >nul 2>nul
    if !errorlevel!==0 set PYWCMD=pythonw
    if "!PYWCMD!"=="" (
        where pyw >nul 2>nul
        if !errorlevel!==0 set PYWCMD=pyw
    )
) else (
    if not exist "!EMBED_DIR!\python.exe" call :install_embedded_python
    if exist "!EMBED_DIR!\python.exe" (
        set "PYCMD=!EMBED_DIR!\python.exe"
        set "PYWCMD=!EMBED_DIR!\pythonw.exe"
        echo Using the portable Python in the python-embed folder.
    )
)

if "!PYCMD!"=="" (
    echo.
    echo Couldn't find or set up Python. Check the internet connection and run
    echo this file again, or install Python yourself from
    echo https://www.python.org/downloads/ ^(tick "Add python.exe to PATH"^).
    pause
    goto :eof
)

echo Checking requirements (only needed the first time, or after an update)...
echo.
"!PYCMD!" -m pip install --disable-pip-version-check --no-warn-script-location -r requirements-stocks.txt -r requirements-tray.txt -r requirements-statement-import.txt
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
if "!PYWCMD!"=="" (
    echo Starting Home Budget Planner ^(console window^)...
    echo.
    "!PYCMD!" server.py
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
    echo Try again in a few seconds, or run "!PYCMD!" server.py directly to
    echo see everything in a console window.
)
echo.
pause
goto :eof


rem ---- First-run setup of the portable Python -----------------------------
:install_embedded_python
echo.
echo Python isn't installed on this computer, so a private copy is being set
echo up inside this folder. This happens once and takes a minute or two -
echo nothing is installed on Windows itself.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;" ^
    "$d='%EMBED_DIR%'; $zip=Join-Path $env:TEMP 'mosite-python-embed.zip';" ^
    "Write-Host 'Downloading Python %PYVER% (portable)...';" ^
    "Invoke-WebRequest -UseBasicParsing -Uri 'https://www.python.org/ftp/python/%PYVER%/python-%PYVER%-embed-amd64.zip' -OutFile $zip;" ^
    "if(Test-Path $d){Remove-Item $d -Recurse -Force}; Expand-Archive $zip -DestinationPath $d -Force; Remove-Item $zip;" ^
    "$pth=Join-Path $d 'python%PYTAG%._pth'; $lines=@(Get-Content $pth | ForEach-Object { $_ -replace '^#\s*import site','import site' }); $lines += '..'; Set-Content $pth $lines -Encoding ASCII;" ^
    "Write-Host 'Downloading pip...';" ^
    "Invoke-WebRequest -UseBasicParsing -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile (Join-Path $d 'get-pip.py')"
if not !errorlevel!==0 (
    echo.
    echo Download failed - check the internet connection.
    if exist "%EMBED_DIR%" rmdir /s /q "%EMBED_DIR%"
    goto :eof
)
echo Setting up pip...
"%EMBED_DIR%\python.exe" "%EMBED_DIR%\get-pip.py" --no-warn-script-location
if not !errorlevel!==0 (
    echo.
    echo Couldn't set up pip for the portable Python.
    if exist "%EMBED_DIR%" rmdir /s /q "%EMBED_DIR%"
    goto :eof
)
del /f /q "%EMBED_DIR%\get-pip.py" >nul 2>nul
echo Portable Python is ready.
echo.
goto :eof
