@echo off
cd /d "%~dp0"
echo ================================================
echo  Creando el instalador de IPTV Player...
echo  Esto puede tardar varios minutos.
echo ================================================
call npm install
call npm run dist
echo.
echo Si todo salio bien, el instalador esta en la carpeta "dist".
echo Ejecuta "IPTV Player Setup 1.0.0.exe" para instalar la app.
pause
if exist dist explorer dist
