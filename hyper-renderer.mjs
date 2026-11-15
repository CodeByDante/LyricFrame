import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./", import.meta.url));
const packageRoot = join(root, "node_modules", "hyperframes");
const windows = process.platform === "win32";
const photos = new Set([".png", ".jpeg", ".jpg", ".webp", ".bmp"]);
const palettes = { gold: "#c9ae85", mint: "#9de3c1", rose: "#e3a6bb" };
const types = { serif: "Lyric Serif", sans: "Lyric Sans", mono: "Lyric Mono" };

function run(executable, args, { workdir, signal, env = process.env, binary = false, onOutput }) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: workdir, env, windowsHide: true, signal, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let tail = "";
    const chunks = [];
    child.stdout.on("data", (part) => {
      if (binary) chunks.push(part);
      else stdout = (stdout + part.toString()).slice(-12000);
      onOutput?.(part.toString());
    });
    child.stderr.on("data", (part) => {
      tail = (tail + part.toString()).slice(-12000);
      onOutput?.(part.toString());
    });
    child.once("error", (error) => reject(signal?.aborted ? signal.reason : error));
    child.once("close", (code) => {
      if (signal?.aborted) return reject(signal.reason);
      if (code !== 0) {
        const detail = (tail.trim() || stdout.trim()).split(/\r?\n/).slice(-8).join("\n");
        return reject(new Error(detail || "El proceso terminó sin crear el archivo."));
      }
      return resolve(binary ? Buffer.concat(chunks) : stdout);
    });
  });
}

async function findBrowser() {
  const explicit = process.env.HYPERFRAMES_BROWSER_PATH;
  const bases = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean);
  const candidates = explicit ? [explicit] : (windows ? [
    ...bases.map((p) => join(p, "Google", "Chrome", "Application", "chrome.exe")),
    ...bases.map((p) => join(p, "Microsoft", "Edge", "Application", "msedge.exe")),
  ] : ["/usr/bin/chromium", "/usr/bin/google-chrome", "/usr/bin/microsoft-edge"]);
  for (const candidate of candidates) {
    try {
      await access(candidate, windows ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error("Para renderizar con HyperFrames, abre el proyecto en una computadora con Chrome, Edge o Chromium instalado.");
}

async function executablePath(name) {
  const candidates = isAbsolute(name) || /[\\/]/.test(name) ? [resolve(name)] :
    (process.env.PATH || "").split(delimiter).filter(Boolean).map((directory) =>
      resolve(directory, name + (windows && !extname(name) ? ".exe" : "")));
  for (const candidate of candidates) {
    try {
      await access(candidate, windows ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error("No se encontró el ejecutable " + name + ".");
}

const escape = (input) => String(input).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
})[character]);

function lyricMarkup(text) {
  return [...String(text).matchAll(/\*\*([^*\r\n]+)\*\*|\*([^*\r\n]+)\*|[^\s*]+|\*|[ \t]+|\r?\n/g)]
    .map((match) => {
      if (/^\r?\n$/.test(match[0])) return "<br>";
      if (/^\s+$/.test(match[0])) return " ";
      const emphasis = match[1] ?? match[2];
      return '<span class="word' + (emphasis ? ' gold' : '') + '">' + escape(emphasis ?? match[0]) + "</span>";
    }).join("");
}

function backdrop(width, height, preset) {
  if (preset === "black") return "";
  let state = width + height;
  const rand = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  return Array.from({ length: 220 }, () => {
    const x = rand() * width;
    const y = rand() * height;
    const alpha = (0.10 + rand() ** 3 * .55).toFixed(2);
    return '<i style="left:' + x.toFixed(1) + 'px;top:' + y.toFixed(1) + 'px;opacity:' + alpha + '"></i>';
  }).join("");
}

function waveLevels(pcm) {
  const levels = [];
  for (let offset = 0; offset + 1 < pcm.length; offset += 320) {
    let peak = 0;
    for (let at = offset; at + 1 < Math.min(pcm.length, offset + 320); at += 2) {
      peak = Math.max(peak, Math.abs(pcm.readInt16LE(at)) / 32768);
    }
    levels.push(Math.min(255, Math.round(Math.sqrt(peak) * 310)));
  }
  return levels;
}

function composition({ width, height, duration, settings, background, levels }) {
  const size = Math.round(Math.min(width, height) * .056);
  const accent = palettes[settings.palette] || palettes.gold;
  const font = types[settings.font] || types.serif;
  const backdropClass = settings.backgroundPreset === "aurora" ? " aurora" : "";
  const cues = settings.cues.filter((cue) => cue.time < duration);
  const clips = cues.map((cue, index) => {
    const time = cues[index + 1]?.time ?? duration;
    const longest = cue.text.split(/\s+/).reduce((length, word) =>
      Math.max(length, word.replace(/\*/g, "").length), 1);
    const fontSize = Math.max(10, Math.min(size, Math.floor(width * .79 / (longest * .82))));
    return '<section id="cue-' + index + '" class="clip cue" data-start="' + cue.time + '" data-duration="'
      + (time - cue.time) + '" data-track-index="2"><div class="line" style="font-size:' + fontSize
      + 'px">' + lyricMarkup(cue.text) + "</div></section>";
  }).join("\n");
  const bg = background === "background.mp4"
    ? '<video id="backdrop" class="clip background" src="background.mp4" data-start="0" data-duration="' + duration + '" data-track-index="0" data-has-audio="false" muted playsinline></video>'
    : background
      ? '<img id="backdrop" class="clip background" src="' + escape(background) + '" data-start="0" data-duration="' + duration + '" data-track-index="0" alt="">'
      : '<div class="stars' + backdropClass + '">' + backdrop(width, height, settings.backgroundPreset) + "</div>";
  const bars = Array.from({ length: 60 }, () => "<b></b>").join("");
  const animation = ["fade", "karaoke", "rise", "pop"].includes(settings.animation) ? settings.animation : "karaoke";

  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<script src="gsap.min.js"></script>
<style>
@font-face{font-family:"Lyric Serif";src:url("fonts/DejaVuSerif.ttf")}
@font-face{font-family:"Lyric Sans";src:url("fonts/DejaVuSans.ttf")}
@font-face{font-family:"Lyric Sans";font-weight:700;src:url("fonts/DejaVuSans-Bold.ttf")}
@font-face{font-family:"Lyric Mono";src:url("fonts/DejaVuSansMono.ttf")}
*{box-sizing:border-box}
html,body{margin:0;overflow:hidden;background:#050505;color:#f3eee6}
#root{position:relative;isolation:isolate;width:${width}px;height:${height}px;overflow:hidden;background:#050505}
.background,.stars{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0}
.stars i{width:2px;height:2px;border-radius:100%;background:white;position:absolute}
.aurora{background:radial-gradient(ellipse at 25% 105%,#283125,transparent 61%),radial-gradient(ellipse at 80% -10%,#312334,transparent 61%),#09090e}
.shade{z-index:1;position:absolute;inset:0;background:radial-gradient(ellipse,transparent,#0006),#0004}
.cue{position:absolute;inset:0;z-index:3;pointer-events:none}
.line{position:absolute;left:8%;right:8%;top:44%;transform:translateY(-50%);text-align:center;font-family:"${font}",serif;line-height:1.19;text-shadow:0 3px 12px #000}
.word{display:inline-block}
.word.gold{color:${accent};font:700 1.44em/1 "Lyric Sans",sans-serif}
.title{position:absolute;z-index:3;top:9%;left:8%;right:8%;text-align:center;overflow-wrap:anywhere;font:700 ${Math.round(size * .43)}px/1.23 "Lyric Sans",sans-serif;letter-spacing:.04em;color:${accent};text-shadow:0 3px 12px #000}
.wave{position:absolute;z-index:3;left:10%;right:10%;top:87%;transform:translateY(-50%);height:${Math.round(Math.min(width,height)*.065)}px;display:flex;gap:3px;align-items:center;opacity:.7}
.wave b{background:${accent};border-radius:2px;flex:1;height:5%;display:block}
</style></head><body>
<div id="root" data-composition-id="root" data-start="0" data-width="${width}" data-height="${height}" data-duration="${duration}">
${bg}${background ? '<div class="shade"></div>' : ""}
<audio id="track" class="clip" src="track.wav" data-start="0" data-duration="${duration}" data-track-index="1"></audio>
${settings.title ? '<div class="title">' + escape(settings.title) + "</div>" : ""}
${clips}
<div class="wave" aria-hidden="true">${bars}</div>
</div>
<script>
const tl=gsap.timeline({paused:true});
window.__timelines=window.__timelines||{};
window.__timelines.root=tl;
const mode=${JSON.stringify(animation)}, accent=${JSON.stringify(accent)};
for(const cue of document.querySelectorAll(".cue")){
 const at=Number(cue.dataset.start), length=Number(cue.dataset.duration), line=cue.querySelector(".line");
 const fade=Math.min(.175,length/5), start={opacity:0}, finish={opacity:1,duration:fade,immediateRender:false};
 if(mode==="rise"){start.y=18;finish.y=0}
 if(mode==="pop"){start.scale=.94;finish.scale=1}
 tl.fromTo(line,start,finish,at);
 tl.to(line,{opacity:0,duration:fade},at+length-fade);
 if(mode==="karaoke"){
  const words=[...line.querySelectorAll(".word")];
  let total=words.reduce((sum,word)=>sum+word.textContent.length,0), elapsed=0;
  for(const word of words){
   const step=length*word.textContent.length/Math.max(1,total);
   if(!word.classList.contains("gold")){
    tl.fromTo(word,{color:"#b0a69b"},{color:"#f3eee6",duration:Math.min(.13,step),ease:"none",immediateRender:false},at+elapsed);
   }else{
    tl.fromTo(word,{opacity:.69},{opacity:1,duration:Math.min(.13,step),ease:"none",immediateRender:false},at+elapsed);
   }
   elapsed+=step;
  }
 }
}
const levels=${JSON.stringify(levels)}, bars=[...document.querySelectorAll(".wave b")], wave={frame:0};
function draw(){
 const center=Math.round(wave.frame);
 for(let i=0;i<bars.length;i++){
  const amplitude=(levels[center+i-30]||0)/255;
  bars[i].style.height=(4+amplitude*85)+"%";
 }
}
tl.to(wave,{frame:${levels.length},duration:${duration},ease:"none",onUpdate:draw},0);
draw();
</script></body></html>`;
}

export async function renderHyper({ ffmpeg, audio, background, settings, workdir, signal, onProgress }) {
  const project = join(workdir, "hyperframes-project");
  const browser = await findBrowser();
  ffmpeg = await executablePath(ffmpeg);
  const probe = windows ? "ffprobe.exe" : "ffprobe";
  const ffprobe = await executablePath(process.env.LYRICFRAME_FFPROBE || join(dirname(ffmpeg), probe))
    .catch(async (error) => {
      if (process.env.LYRICFRAME_FFPROBE) throw error;
      return await executablePath(probe);
    });
  const gsapRoot = join(packageRoot, "dist", "vendor", "npm");
  const gsap = (await readdir(gsapRoot)).find((name) => name.startsWith("gsap@"));
  if (!gsap) throw new Error("Falta la biblioteca de animación que acompaña a HyperFrames.");
  await mkdir(join(project, "fonts"), { recursive: true });
  await Promise.all([
    copyFile(join(gsapRoot, gsap, "dist", "gsap.min.js"), join(project, "gsap.min.js")),
    ...["DejaVuSerif.ttf", "DejaVuSans.ttf", "DejaVuSans-Bold.ttf", "DejaVuSansMono.ttf"].map((name) =>
      copyFile(join(root, "fonts", name), join(project, "fonts", name))),
  ]);
  const options = { workdir: project, signal };
  const track = join(project, "track.wav");
  await run(ffmpeg, ["-v", "error", "-nostdin", "-y", "-i", audio, "-map", "0:a:0", "-c:a", "pcm_s16le", track], options);
  const duration = Number((await run(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", track], options)).trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("No se pudo determinar la duración del audio.");
  const [width, height] = settings.ratio === "9:16" ? [1080, 1920] : [1920, 1080];

  let backgroundName = "";
  if (background) {
    const extension = extname(background).toLowerCase();
    if (photos.has(extension)) {
      backgroundName = "background" + extension;
      await copyFile(background, join(project, backgroundName));
    } else {
      backgroundName = "background.mp4";
      await run(ffmpeg, [
        "-v", "error", "-nostdin", "-y", "-stream_loop", "-1", "-i", background, "-map", "0:v:0", "-an",
        "-vf", "scale=" + width + ":" + height + ":force_original_aspect_ratio=increase,crop=" + width + ":" + height + ",setsar=1",
        "-t", String(duration), "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        join(project, backgroundName),
      ], options);
    }
  }
  const pcm = await run(ffmpeg, ["-v", "error", "-nostdin", "-i", track, "-ar", "4800", "-ac", "1", "-f", "s16le", "pipe:1"], { ...options, binary: true });
  const html = composition({ width, height, duration, settings, background: backgroundName, levels: waveLevels(pcm) });
  await writeFile(join(project, "index.html"), html, "utf8");
  onProgress?.(7);
  const output = join(workdir, "LyricFrame.mp4");
  const env = {
    ...process.env,
    PATH: [join(root, "runtime"), process.env.PATH].filter(Boolean).join(delimiter),
    HYPERFRAMES_BROWSER_PATH: browser,
    HYPERFRAMES_FFMPEG_PATH: ffmpeg,
    HYPERFRAMES_FFPROBE_PATH: ffprobe,
    HYPERFRAMES_NO_TELEMETRY: "1",
    HYPERFRAMES_NO_UPDATE_CHECK: "1",
    HYPERFRAMES_SKIP_SKILLS: "1",
    HYPERFRAMES_NO_OPTIONAL_INSTALL: "1",
    NO_COLOR: "1",
  };
  try {
    await run(process.execPath, [
      join(packageRoot, "bin", "hyperframes.mjs"), "render", project,
      "--format", "mp4", "--output", output, "--fps", "30", "--workers", "1",
      "--low-memory-mode", "--no-browser-gpu", "--quality", "standard",
    ], {
      ...options, env,
      onOutput(text) {
        const values = [...text.matchAll(/(?:^|\s)(\d{1,3})%/g)];
        if (values.length) onProgress?.(Math.max(7, Math.min(99, Number(values.at(-1)[1]))));
      },
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error("HyperFrames no pudo renderizar la composición.\n" + error.message);
  }
  if (!(await stat(output)).size) throw new Error("HyperFrames produjo un archivo vacío.");
  onProgress?.(100);
  return output;
}
