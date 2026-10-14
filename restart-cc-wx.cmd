@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\restart-cc-wx.ps1" %*
if errorlevel 1 pause
