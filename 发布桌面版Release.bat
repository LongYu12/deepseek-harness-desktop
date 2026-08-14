@echo off
chcp 65001 >nul
title 发布桌面版 Release
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\release-desktop.ps1" %*
echo.
pause
