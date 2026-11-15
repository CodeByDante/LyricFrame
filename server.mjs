import http from "node:http";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Busboy from "busboy";
import { render } from "./renderer.mjs";

const root = fileURLToPath(new URL("./", import.meta.url));
const windows = process.platform === "win32";
const ffmpeg = process.env.LYRICFRAME_FFMPEG || (windows ? join(root, "runtime", "ffmpeg.exe") : "ffmpeg");
const audioExtensions = new Set([".mp3", ".wav", ".m4a", ".mp4", ".aac", ".flac", ".ogg", ".webm", ".mov"]);
const backgroundExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".mp4", ".mov", ".webm", ".mkv"]);
const publicFiles = {
  "/": ["web/index.html", "text/html; charset=utf-8"],
  "/app.js": ["web/app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["web/styles.css", "text/css; charset=utf-8"],
  "/assets/lyricframe-logo.png": ["web/assets/lyricframe-logo.png", "image/png"],
  "/fonts/DejaVuSerif.ttf": ["fonts/DejaVuSerif.ttf", "font/ttf"],
  "/fonts/DejaVuSans-Bold.ttf": ["fonts/DejaVuSans-Bold.ttf", "font/ttf"],
  "/fonts/DejaVuSans.ttf": ["fonts/DejaVuSans.ttf", "font/ttf"],
  "/fonts/DejaVuSansMono.ttf": ["fonts/DejaVuSansMono.ttf", "font/ttf"],
};

class InputError extends Error {}

function settingsFrom(source) {
  let input;
  try {
    input = JSON.parse(source);
  } catch {
    throw new InputError("La información del proyecto no se pudo leer.");
  }
  if (!["9:16", "16:9"].includes(input?.ratio) || !Array.isArray(input.cues) || !input.cues.length) {
    throw new InputError("Selecciona un formato y marca el tiempo de al menos una línea.");
  }
  let previous = -1;
  const cues = input.cues.map((cue) => {
    if (!Number.isFinite(cue?.time) || cue.time < 0 || cue.time <= previous || typeof cue.text !== "string" || !cue.text.trim()) {
      throw new InputError("Las líneas deben tener texto y tiempos en orden ascendente.");
    }
    previous = cue.time;
    return { time: cue.time, text: cue.text.trim() };
  });
  const option = (value, options) => options.includes(value) ? value : options[0];
  return {
    ratio: input.ratio,
    title: typeof input.title === "string" ? input.title.trim() : "",
    cues,
    backgroundPreset: option(input.backgroundPreset, ["stars", "aurora", "black"]),
    font: option(input.font, ["serif", "sans", "mono"]),
    animation: option(input.animation, ["karaoke", "fade", "rise", "pop"]),
    palette: option(input.palette, ["gold", "mint", "rose"]),
    engine: option(input.engine, ["fast", "hyperframes"]),
  };
}

async function readProject(req, workdir, signal) {
  let form;
  try {
    form = Busboy({ headers: req.headers, limits: { files: 2, fields: 1, parts: 4, fieldSize: 2 * 1024 * 1024 } });
  } catch {
    throw new InputError("Selecciona el audio y vuelve a pulsar Exportar MP4.");
  }
  const uploads = [];
  const files = {};
  let rawSettings;
  let problem;
  const invalid = (message) => { problem ??= new InputError(message); };
  form.on("file", (field, stream, info) => {
    const allowed = field === "audio" ? audioExtensions : (field === "background" ? backgroundExtensions : null);
    const extension = extname(info.filename ?? "").toLowerCase();
    if (!allowed?.has(extension) || files[field]) {
      invalid(field === "audio" ? "Usa un archivo de audio o un video MP4 válido." : "El fondo debe ser una imagen o un video compatible.");
      stream.resume();
      return;
    }
    const path = join(workdir, field + extension);
    files[field] = path;
    if (field === "audio") files.sourceName = basename(info.filename, extname(info.filename));
    const upload = pipeline(stream, createWriteStream(path), { signal });
    upload.catch(() => {});
    uploads.push(upload);
  });
  form.on("field", (name, value, info) => {
    if (name !== "settings" || info.valueTruncated) {
      invalid("No se pudo leer la letra del proyecto.");
      return;
    }
    rawSettings = value;
  });
  for (const event of ["partsLimit", "fieldsLimit", "filesLimit"]) {
    form.on(event, () => invalid("Elige una pista de audio y un fondo opcional."));
  }
  try {
    await pipeline(req, form, { signal });
    await Promise.all(uploads);
  } catch (error) {
    await Promise.allSettled(uploads);
    if (signal.aborted) throw error;
    if (error.code === "ENOSPC") throw new InputError("Falta espacio libre para guardar los archivos temporales.");
    throw new InputError("No se pudo leer el archivo seleccionado.");
  }
  if (problem) throw problem;
  if (!files.audio || !(await stat(files.audio)).size) throw new InputError("Selecciona un archivo de audio que contenga sonido.");
  if (files.background && !(await stat(files.background)).size) throw new InputError("El archivo de fondo está vacío.");
  return { ...files, settings: settingsFrom(rawSettings) };
}

function send(res, status, message, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type });
  res.end(message);
}

let exporting = false;
const server = http.createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'self'; media-src 'self' blob:; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'");
  if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin)) {
    send(res, 403, "Abre LyricFrame desde su dirección local.");
    return;
  }
  const path = req.url?.split("?")[0];
  if ((req.method === "GET" || req.method === "HEAD") && Object.hasOwn(publicFiles, path)) {
    const [filename, type] = publicFiles[path];
    try {
      const content = await readFile(join(root, filename));
      send(res, 200, req.method === "HEAD" ? undefined : content, type);
    } catch {
      send(res, 500, "No se pudieron cargar los archivos de LyricFrame. Extrae el ZIP completo.");
    }
    return;
  }
  if (req.method !== "POST" || path !== "/export") {
    send(res, 404, "Página no encontrada.");
    return;
  }
  if (exporting) {
    send(res, 409, "Ya hay una exportación en curso. Espera a que termine.");
    return;
  }
  exporting = true;
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  let workdir;
  try {
    workdir = await mkdtemp(join(tmpdir(), "LyricFrame-"));
    const project = await readProject(req, workdir, controller.signal);
    const exportVideo = project.settings.engine === "hyperframes"
      ? (await import("./hyper-renderer.mjs")).renderHyper
      : render;
    const output = await exportVideo({ ...project, ffmpeg, workdir, signal: controller.signal });
    const details = await stat(output);
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": details.size,
      "Content-Disposition": 'attachment; filename="LyricFrame.mp4"',
    });
    await pipeline(createReadStream(output), res, { signal: controller.signal });
  } catch (error) {
    if (!controller.signal.aborted && !res.headersSent && !res.destroyed) {
      send(res, error instanceof InputError ? 400 : 422, error.message || "No se pudo exportar el video.");
    }
  } finally {
    try {
      if (workdir) await rm(workdir, { recursive: true, force: true });
    } catch (error) {
      console.error("No se pudo limpiar la carpeta de exportación:", error.message);
    }
    exporting = false;
  }
});

server.requestTimeout = 0;
if (windows) {
  await access(ffmpeg).catch(() => {
    console.error("Falta runtime\\ffmpeg.exe. Extrae el ZIP completo antes de abrir LyricFrame.");
    process.exit(1);
  });
}

let host;
let origin;
const desktop = process.argv.includes("--desktop");
server.listen(0, "127.0.0.1", () => {
  host = "127.0.0.1:" + server.address().port;
  origin = "http://" + host;
  if (desktop) {
    process.stdin.once("end", () => {
      server.close();
      server.closeAllConnections();
    });
    process.stdin.resume();
  }
  console.log("LyricFrame listo. Abre " + origin);
  if (windows && !desktop && !process.argv.includes("--no-open")) {
    const browser = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", origin], { stdio: "ignore", detached: true, windowsHide: true });
    browser.on("error", () => console.log("Copia la dirección de arriba en tu navegador."));
    browser.unref();
  }
});
