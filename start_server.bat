@echo off
cd /d "%~dp0"
echo Starting local server at http://localhost:8090 ...
python -m http.server 8090
