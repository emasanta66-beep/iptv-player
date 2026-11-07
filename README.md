# IPTV Player

Reproductor de escritorio (Electron) para listas **Xtream Codes** y **M3U**.

## Funciones
- Xtream Codes: En vivo, Películas y Series con categorías y búsqueda
- Listas M3U por URL o archivo local
- Series: al terminar un capítulo empieza el siguiente automáticamente (cuenta regresiva de 5 s, se puede cancelar o desactivar)
- Favoritos y "Continuar viendo" (recuerda el minuto donde lo dejaste)
- Guía de programación (EPG): Xtream (`get_short_epg`) y XMLTV para M3U (`url-tvg` o URL manual, acepta `.gz`)
- Reparación automática de audio: si el video no suena (audio AC3/DTS) o no se ve, convierte al vuelo con ffmpeg (incluido vía `npm install`). También hay un botón "Reparar audio"
- Botón "Abrir en VLC" cuando el reproductor integrado no soporta el formato
- Atajos: `N` siguiente, `P` anterior, `F` pantalla completa

## Cómo ejecutarlo
1. Instala Node.js (https://nodejs.org, versión LTS).
2. En esta carpeta abre una terminal y ejecuta:
   ```
   npm install
   npm start
   ```
3. Pulsa **+ Añadir** y completa servidor (`http://host:puerto`), usuario y contraseña.

## Crear un instalador (opcional)
```
npm install --save-dev electron-builder
npx electron-builder
```

## Notas
- El video en vivo usa `.m3u8` (HLS) con hls.js. Si tu servidor no lo ofrece, usa "Abrir en VLC".
- Los datos (listas, favoritos, progreso) se guardan localmente en la app.

## Sin escribir comandos
- `iniciar.bat`: doble clic para abrir la app (instala lo necesario la primera vez).
- `crear-exe.bat`: doble clic para generar un instalador en la carpeta `dist` (`IPTV Player Setup 1.0.0.exe`). Al instalarlo crea un acceso directo en el escritorio.

## Actualizaciones automáticas
La app instalada busca versiones nuevas en GitHub Releases al abrirse, las descarga y pregunta si reiniciar.
1. Crea un repositorio **público** en GitHub (por ejemplo `iptv-player`).
2. En `package.json`, sección `build > publish`, cambia `TU_USUARIO_GITHUB` por tu usuario (y `repo` si usaste otro nombre).
3. Crea un token en GitHub (Settings > Developer settings > Personal access tokens > Tokens (classic), permiso `repo`).
4. Para publicar una versión: sube `version` en `package.json` y ejecuta `publicar.bat`.
