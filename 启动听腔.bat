@echo off
chcp 65001 >nul
cd /d "%~dp0"
python scripts\serve.py 8000 --open
pause
