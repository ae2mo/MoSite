@echo off
REM Publishes the current code in this folder to github.com/ae2mo/MoSite.
REM Personal data, backups and API keys are left out by .gitignore.
REM Safe to run any time - it only uploads what changed.

cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
  echo Git isn't installed. Install it from https://git-scm.com/download/win
  echo then run this file again.
  pause
  exit /b 1
)

if not exist ".git" (
  echo First run: linking this folder to github.com/ae2mo/MoSite ...
  git init -b main
  git remote add origin https://github.com/ae2mo/MoSite.git
  git fetch origin main || goto :failed
  REM Start from what's already on GitHub, then layer this folder on top.
  git reset origin/main
  git branch --set-upstream-to=origin/main main
)

git config user.name >nul 2>nul || git config user.name "ae2mo"
git config user.email >nul 2>nul || git config user.email "ae2mo@users.noreply.github.com"

git pull --rebase origin main >nul 2>nul

git add -A
git diff --cached --quiet
if not errorlevel 1 (
  echo Nothing new to sync - GitHub is already up to date.
  goto :done
)

echo Files being published:
git diff --cached --stat
git commit -m "Sync from local copy %date% %time%" || goto :failed
git push origin main || goto :failed
echo.
echo Done - GitHub is up to date.
goto :done

:failed
echo.
echo Something went wrong (see above). Nothing personal was uploaded.

:done
pause
