<h1 align="center">LyricFrame</h1>

<p align="center">Editor portátil de videos con letra sincronizada</p>

<p align="center">
  <a href="https://github.com/CodeByDante/LyricFrame/releases/latest">Descargar LyricFrame para Windows x64</a>
</p>

LyricFrame convierte tu pista de audio y su letra en un video MP4 Full HD en 9:16 o 16:9. Permite marcar la entrada de cada línea, importar archivos LRC y previsualizar la letra al ritmo de la pista.

## Abrir en Windows

1. Descarga el ZIP portátil desde [Releases](https://github.com/CodeByDante/LyricFrame/releases/latest) y extráelo completo.
2. Abre **Abrir LyricFrame.cmd**. El editor se abre localmente en tu navegador.
3. Selecciona el audio, pega la letra y marca los tiempos. Elige el formato y pulsa **Generar MP4**.

Puedes elegir fondo estrellado, aurora o negro, o cargar tu propia imagen o video. El editor permite cambiar la tipografía, la paleta y la animación. Usa *asteriscos* en la letra para destacar una palabra.

**Rápido (FFmpeg)** usa el motor incluido en el ZIP. **HyperFrames** usa Chrome o Edge instalado en tu equipo.

## Ejecutar desde el código

Con Node.js 22 o posterior y FFmpeg disponible, ejecuta lo siguiente y abre la dirección local que se imprime en la terminal.

    npm ci
    npm start

En Windows, configura LYRICFRAME_FFMPEG con la ruta de ffmpeg.exe o colócalo en runtime. HyperFrames también requiere FFprobe y un navegador compatible. Consulta [LEEME.txt](LEEME.txt) para el uso portátil y [los avisos de terceros](licenses/TERCEROS.md) para los componentes distribuidos.

Las pruebas de exportación con ambos motores se realizaron en Linux. El paquete incluye los binarios de Windows x64 y su arranque en Windows queda por verificar.
