@echo off
REM Run from Windows Command Prompt or PowerShell:
REM   .\run.cmd
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed ^(or not on PATH^).
  echo Install Node 20+ from https://nodejs.org then reopen this terminal.
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm is not installed ^(or not on PATH^).
  exit /b 1
)

call npm run bot
exit /b %ERRORLEVEL%
