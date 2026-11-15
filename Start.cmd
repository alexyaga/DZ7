@echo off
setlocal
pushd "%~dp0" || goto :failed

set "ANALYZER_NODE=node.exe"
where.exe node.exe >nul 2>&1
if errorlevel 1 (
    set "ANALYZER_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
)
if not "%ANALYZER_NODE%"=="node.exe" if not exist "%ANALYZER_NODE%" (
    echo Node.js 24 was not found. Install it and try again.
    popd
    goto :failed
)

"%ANALYZER_NODE%" scripts/start.js
if errorlevel 1 (
    popd
    goto :failed
)
start "" "http://localhost:5173/"
popd
exit /b 0

:failed
pause
exit /b 1
