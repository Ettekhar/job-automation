@echo off
title Teletalk Autofill Assistant
cd /d "%~dp0"
echo ========================================================
echo Launching Google Chrome / Edge Teletalk Autofill Browser...
echo ========================================================
node scripts/autofill.mjs --url "https://bhtpa.teletalk.com.bd/" --post "Assistant Programmer"
pause
