@echo off
rem Local plugin-store index server for the dsh desktop app.
rem Keep this window open while browsing/installing from the store.
cd /d "%~dp0"
node serve.mjs
pause
