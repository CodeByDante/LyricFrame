# Guía de LyricFrame

## Abrir en Windows

1. Descarga el [ZIP portátil para Windows de 64 bits](https://github.com/CodeByDante/LyricFrame/releases/download/v1.0.2/LyricFrame-Portable-Windows-x64.zip) y extráelo completo.
2. Haz doble clic en **LyricFrame.exe**. El editor se abre en su propia ventana usando Edge o Chrome instalado en tu PC. Cierra esa ventana para salir.
3. Selecciona el audio, pega la letra y marca los tiempos. Elige el formato y pulsa **Generar MP4**.

Puedes elegir fondo estrellado, aurora o negro, o cargar tu propia imagen o video. El editor permite cambiar la tipografía, la paleta y la animación. Usa *asteriscos* en la letra para destacar una palabra.

**Rápido (FFmpeg)** usa el motor incluido en el ZIP. **HyperFrames** usa Chrome o Edge instalado en tu equipo.

## Ejecutar desde el código

Con Node.js 22 o posterior y FFmpeg disponible, ejecuta lo siguiente y abre la dirección local que se imprime en la terminal.

    npm ci
    npm start

En Windows, configura LYRICFRAME_FFMPEG con la ruta de ffmpeg.exe o colócalo en runtime. HyperFrames también requiere FFprobe y un navegador compatible. Consulta [LEEME.txt](LEEME.txt) para el uso portátil y [los avisos de terceros](licenses/TERCEROS.md) para los componentes distribuidos.

Las pruebas de exportación con ambos motores se realizaron en Linux. El arranque del ejecutable queda por verificar en Windows.
