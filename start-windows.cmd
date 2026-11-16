@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto missing_node
where npm >nul 2>nul
if errorlevel 1 goto missing_node
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 goto missing_node
if exist "node_modules\.bin\tsx.cmd" goto start_server
echo First start: installing dependencies. Internet connection is required.
call npm ci
if errorlevel 1 goto failed
:start_server
echo Open http://127.0.0.1:8787/ after the server starts.
echo Keep this window open. Press Ctrl+C to stop the server.
call npm start
if errorlevel 1 goto failed
exit /b 0
:missing_node
echo Please install Node.js 22 or newer, then reopen this file.
pause
exit /b 1
:failed
echo InkAsk could not start. Please check the error shown above.
pause
exit /b 1
