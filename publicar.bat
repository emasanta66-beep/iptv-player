@echo off
cd /d "%~dp0"
echo ================================================
echo  Publicar una version nueva en GitHub
echo  (las apps instaladas se actualizaran solas)
echo ================================================
echo.
echo Recuerda: antes de publicar, sube el numero "version" en package.json
echo (por ejemplo de 1.0.0 a 1.0.1). Si no, no se detecta como nueva.
echo.
if "%GH_TOKEN%"=="" (
  set /p GH_TOKEN=Pega tu token de GitHub y presiona Enter:
)
call npm install
call npm run publish
echo.
echo Si no hubo errores, la version ya esta publicada en GitHub.
pause
