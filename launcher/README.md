# Lanzador de LyricFrame

Compila `LyricFrame.exe` para Windows x64 desde Linux con Node.js y npm. Ejecuta estos comandos desde la carpeta `launcher`.

```sh
build_dir=$(mktemp -d)
npm install --prefix "$build_dir" --no-audit --no-fund @oven/zig-linux-x64@0.12.0-dev.1286
zig="$build_dir/node_modules/@oven/zig-linux-x64/zig"
"$zig" rc -- lyricframe.rc "$build_dir/lyricframe.res"
"$zig" cc -target x86_64-windows-gnu -std=c11 -Wl,--subsystem,windows -Os -s \
  -Wall -Wextra -Wpedantic -Werror main.c "$build_dir/lyricframe.res" \
  -o "$build_dir/LyricFrame.exe" -luser32 -ladvapi32
file "$build_dir/LyricFrame.exe"
```

Para armar el ZIP portátil, coloca el ejecutable junto a `server.mjs`, en el directorio que contiene `runtime/`.
