@echo off
REM Starts invest-monitor from a portable bundle (built by packaging/build-bundle.mjs). Double-click this
REM file, or run it from any directory; it locates the bundle root from its own path.
setlocal

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "NODE_BIN=%ROOT%\node\node.exe"
if not exist "%NODE_BIN%" (
  echo invest-monitor: no bundled Node runtime at %ROOT%\node; looking for a system 'node' on PATH 1>&2
  set "NODE_BIN="
)
if not defined NODE_BIN (
  where node >nul 2>nul
  if errorlevel 1 (
    echo invest-monitor: no Node runtime found at %ROOT%\node\node.exe and no system 'node' on PATH. 1>&2
    exit /b 1
  )
  for /f "delims=" %%N in ('where node') do if not defined NODE_BIN set "NODE_BIN=%%N"
)

set "NODE_ENV=production"

REM Sensible bundle-local defaults. Each only applies when the variable is not already set in the calling
REM environment, so setting API_PORT before running this script still overrides it; secrets come only from
REM the bundle's own .env, loaded further down. UI_AUTH_MODE stays fixed at "password" here, matching every
REM other distribution mode (Docker hardcodes the same value) rather than being user-overridable.
if not defined APP_CONFIG_PATH set "APP_CONFIG_PATH=%ROOT%\config\portfolio.yaml"
if not defined APP_CONFIG_EXAMPLE_PATH set "APP_CONFIG_EXAMPLE_PATH=%ROOT%\config\portfolio.example.yaml"
if not defined SQLITE_PATH set "SQLITE_PATH=%ROOT%\data\invest.sqlite"
if not defined MARKET_HOT_PATH set "MARKET_HOT_PATH=%ROOT%\data\market-hot\market.sqlite"
if not defined MARKET_ARCHIVE_DIR set "MARKET_ARCHIVE_DIR=%ROOT%\data\market-archive"
if not defined LOG_DIR set "LOG_DIR=%ROOT%\data\logs"
set "UI_AUTH_MODE=password"
if not defined UI_AUTH_TOKEN_FILE set "UI_AUTH_TOKEN_FILE=%ROOT%\secrets\ui_auth_token"
if not defined API_BIND_HOST set "API_BIND_HOST=127.0.0.1"
if not defined API_PORT set "API_PORT=8080"
if not defined WEB_DIST_DIR set "WEB_DIST_DIR=%ROOT%\apps\web\dist"

if not exist "%ROOT%\data\market-hot" mkdir "%ROOT%\data\market-hot"
if not exist "%ROOT%\data\market-archive" mkdir "%ROOT%\data\market-archive"
if not exist "%ROOT%\data\logs" mkdir "%ROOT%\data\logs"
for %%D in ("%UI_AUTH_TOKEN_FILE%") do if not exist "%%~dpD" mkdir "%%~dpD"

REM UI_AUTH_MODE=password still requires UI_AUTH_TOKEN_FILE to be a readable, non-empty file at startup
REM (the password itself is stored separately, in the database); create one on first run if missing/empty.
set "NEED_TOKEN="
if not exist "%UI_AUTH_TOKEN_FILE%" set "NEED_TOKEN=1"
if exist "%UI_AUTH_TOKEN_FILE%" (
  for %%F in ("%UI_AUTH_TOKEN_FILE%") do if %%~zF==0 set "NEED_TOKEN=1"
)
if defined NEED_TOKEN (
  "%NODE_BIN%" -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('hex'))" > "%UI_AUTH_TOKEN_FILE%"
  echo invest-monitor: generated %UI_AUTH_TOKEN_FILE% 1>&2
)

echo invest-monitor: starting on http://%API_BIND_HOST%:%API_PORT% (data: %ROOT%\data) 1>&2
"%NODE_BIN%" --env-file-if-exists="%ROOT%\.env" "%ROOT%\apps\server\dist\main.js"
