# Lanzador de LyricFrame

Compila los lanzadores para Windows x64 desde Linux con Node.js, npm y Python 3. Ejecuta los comandos desde la carpeta `launcher`.

```sh
build_dir=$(mktemp -d)
npm install --prefix "$build_dir" --no-audit --no-fund @oven/zig-linux-x64@0.12.0-dev.1286
zig="$build_dir/node_modules/@oven/zig-linux-x64/zig"
"$zig" rc -- lyricframe.rc "$build_dir/lyricframe.res"
"$zig" cc -target x86_64-windows-gnu -std=c11 -Wl,--subsystem,windows -Os -s \
  -Wall -Wextra -Wpedantic -Werror main.c "$build_dir/lyricframe.res" \
  -o "$build_dir/desktop.exe" -luser32 -ladvapi32
```

El ejecutable exterior prepara los archivos y arranca el lanzador de escritorio desde una carpeta temporal.

```sh
curl -fL https://codeload.github.com/richgel999/miniz/tar.gz/refs/tags/3.0.2 \
  -o "$build_dir/miniz.tar.gz"
printf '%s  %s\n' c4b4c25a4eb81883448ff8924e6dba95c800094a198dc9ce66a292ac2ef8e018 "$build_dir/miniz.tar.gz" | sha256sum -c -
tar -xzf "$build_dir/miniz.tar.gz" -C "$build_dir"
miniz="$build_dir/miniz-3.0.2"
printf '#define MINIZ_EXPORT\n' > "$miniz/miniz_export.h"
"$zig" cc -target x86_64-windows-gnu -std=c11 -Wl,--subsystem,windows -Os -s \
  -DMINIZ_NO_DEFLATE_APIS -I "$miniz" \
  portable.c "$miniz/miniz.c" "$miniz/miniz_tinfl.c" "$miniz/miniz_zip.c" \
  "$build_dir/lyricframe.res" -o "$build_dir/portable.exe" -luser32 -lgdi32 -lbcrypt
```

Usa el ZIP de Windows x64 de la [versión 1.0.2](https://github.com/CodeByDante/LyricFrame/releases/tag/v1.0.2) como fuente de Node.js, FFmpeg y las dependencias de Node. Los archivos del editor se toman del código actual.

```sh
python3 package_portable.py --stub "$build_dir/portable.exe" --launcher "$build_dir/desktop.exe" \
  --runtime-zip /ruta/LyricFrame-Portable-Windows-x64.zip --output "$build_dir/LyricFrame.exe"
```
