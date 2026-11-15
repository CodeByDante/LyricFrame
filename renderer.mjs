import { spawn } from "node:child_process";
import { cp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fonts = fileURLToPath(new URL("./fonts/", import.meta.url));
const photos = new Set([".png", ".jpeg", ".jpg", ".webp", ".bmp", ".ppm"]);
const ivory = "&H00E6EEF3";
const palettes = {
  gold: "&H0085AEC9",
  mint: "&H00BFE686",
  rose: "&H00BDA6F2",
};
const families = {
  serif: "DejaVu Serif",
  sans: "DejaVu Sans",
  mono: "DejaVu Sans Mono",
};

function run(executable, args, { workdir, signal, onLine, allowFailure = false }) {
  signal?.throwIfAborted();

  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["-hide_banner", "-nostdin", ...args], {
      cwd: workdir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const cancel = () => child.kill();
    let stderr = "";
    let pending = "";

    signal?.addEventListener("abort", cancel, { once: true });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (part) => {
      stderr = (stderr + part).slice(-24576);
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (part) => {
      if (!onLine) return;
      const lines = (pending + part).split("\n");
      pending = lines.pop();
      for (const line of lines) onLine(line.trim());
    });
    child.once("error", (error) => {
      signal?.removeEventListener("abort", cancel);
      reject(new Error("No se pudo iniciar FFmpeg. " + error.message));
    });
    child.once("close", (status) => {
      signal?.removeEventListener("abort", cancel);
      if (signal?.aborted) {
        reject(signal.reason);
      } else if (status !== 0 && !allowFailure) {
        const detail = stderr.trim().split(/\r?\n/).slice(-4).join("\n");
        reject(new Error("FFmpeg no pudo procesar los archivos." + (detail ? "\n" + detail : "")));
      } else {
        resolve(stderr);
      }
    });
  });
}

function seconds(value) {
  const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(value);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0;
}

async function audioDuration(ffmpeg, audio, options) {
  const metadata = await run(ffmpeg, ["-i", audio], { ...options, allowFailure: true });
  if (!/Stream[^\n]*Audio:/i.test(metadata)) {
    throw new Error("El archivo seleccionado no contiene una pista de audio compatible.");
  }
  const duration = seconds(/Duration:\s*([^,\n]+)/.exec(metadata)?.[1] ?? "");
  if (duration > 0) return duration;

  let decodedTime = 0;
  await run(ffmpeg, ["-v", "error", "-progress", "pipe:1", "-i", audio, "-map", "0:a:0", "-f", "null", "-"], {
    ...options,
    onLine(line) {
      if (line.startsWith("out_time=")) decodedTime = seconds(line.slice(9));
    },
  });
  if (!decodedTime) throw new Error("No se pudo determinar la duración del audio.");
  return decodedTime;
}

function ppm(width, height, pixels) {
  return Buffer.concat([Buffer.from("P6\n" + width + " " + height + "\n255\n"), pixels]);
}

function auroraBackdrop(width, height) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let row = 0; row < height; row++) {
    const y = row / height;
    for (let column = 0; column < width; column++) {
      const x = column / width;
      const teal = Math.exp(-14 * (x - 0.23 + 0.18 * y) ** 2 - 13 * (y - .30 + .13 * x) ** 2);
      const violet = Math.exp(-12 * (x - 0.85 + 0.2 * y) ** 2 - 15 * (y - .73 + .10 * x) ** 2);
      const offset = (row * width + column) * 3;
      pixels[offset] = 5 + teal * 5 + violet * 35;
      pixels[offset + 1] = 6 + teal * 44 + violet * 11;
      pixels[offset + 2] = 9 + teal * 35 + violet * 49;
    }
  }
  return ppm(width, height, pixels);
}

function starBackdrop(width, height, preset) {
  const pixels = Buffer.alloc(width * height * 3, 4);
  if (preset === "black") return ppm(width, height, pixels);
  if (preset === "aurora") return auroraBackdrop(width / 2, height / 2);
  let state = width + height;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const set = (x, y, value) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const offset = (y * width + x) * 3;
    pixels.fill(Math.max(value, pixels[offset]), offset, offset + 3);
  };

  for (let i = 0; i < 270; i++) {
    const x = Math.floor(random() * width);
    const y = Math.floor(random() * height);
    const intensity = Math.floor(22 + random() ** 3 * 128);
    const radius = 0.85 + random() ** 2 * 1.75;
    const edge = Math.ceil(radius * 1.7);
    for (let dy = -edge; dy <= edge; dy++) {
      for (let dx = -edge; dx <= edge; dx++) {
        const falloff = Math.exp(-1.3 * (dx ** 2 + dy ** 2) / radius ** 2);
        set(x + dx, y + dy, intensity * falloff);
      }
    }
  }
  return ppm(width, height, pixels);
}

function assTime(time) {
  const total = Math.max(0, Math.round(time * 100));
  const hours = Math.floor(total / 360000);
  const minutes = Math.floor(total / 6000) % 60;
  const seconds = Math.floor(total / 100) % 60;
  const fraction = total % 100;
  return hours + ":" + [minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":")
    + "." + String(fraction).padStart(2, "0");
}

function plainAss(text) {
  return text.replace(/[\\{}]/g, (character) => ({ "\\": "＼", "{": "｛", "}": "｝" })[character])
    .replace(/[\r\t\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ");
}

function lyricTokens(text) {
  return [...text.matchAll(/\*\*([^*\r\n]+)\*\*|\*([^*\r\n]+)\*|[^\s*]+|\*|\r?\n/g)].map((match) => ({
    text: match[1] ?? match[2] ?? match[0],
    gold: match[1] !== undefined || match[2] !== undefined,
    newline: match[0].endsWith("\n"),
  }));
}

function lyricTransition(animation, x, y, duration, rise) {
  const fade = Math.min(175, Math.floor(duration * .20));
  const enter = Math.min(280, Math.floor(duration * .46));
  let placement = "\\pos(" + x + "," + y + ")";
  if (animation === "rise" && enter > 0) {
    placement = "\\move(" + x + "," + (y + rise) + "," + x + "," + y + ",0," + enter + ")";
  }
  if (animation === "pop" && enter > 1) {
    const peak = Math.floor(enter * .66);
    placement += "\\fscy84\\t(0," + peak + ",\\fscy108)\\t(" + peak + "," + enter + ",\\fscy100)";
  }
  return placement + "\\fad(" + fade + "," + fade + ")";
}

function lyricDialogue(text, start, end, width, height, base, { animation, family, accent }) {
  const tokens = lyricTokens(text);
  const words = tokens.filter((token) => !token.newline);
  if (!words.length) return null;

  const available = width * 0.83;
  const longest = Math.max(...words.map((word) => word.text.length * (word.gold ? 0.82 : 0.58)));
  const size = Math.max(12, Math.min(base, Math.floor(available / longest)));
  const emphasisSize = Math.round(size * 1.44);
  let weight = words.reduce((total, word) => total + Math.max(1, word.text.length), 0);
  let remaining = Math.max(1, Math.round((end - start) * 89));
  let currentWidth = 0;
  let content = "";

  for (const token of tokens) {
    if (token.newline) {
      content += "\\N";
      currentWidth = 0;
      continue;
    }

    const estimatedWidth = token.text.length * (token.gold ? emphasisSize * .53 : size * .51);
    const spacing = currentWidth > 0 ? size * .32 : 0;
    if (currentWidth > 0 && currentWidth + spacing + estimatedWidth > available) {
      content += "\\N";
      currentWidth = 0;
    }
    if (currentWidth) content += " ";
    currentWidth += estimatedWidth + (currentWidth > 0 ? spacing : 0);

    const tokenWeight = Math.max(1, token.text.length);
    const length = Math.max(0, Math.round(remaining * tokenWeight / weight));
    remaining -= length;
    weight -= tokenWeight;

    const emphasis = token.gold ? "\\fnDejaVu Sans\\b1\\fscx85\\fs" + emphasisSize + "\\1c" + accent + "&"
      : "\\fn" + family + "\\b0\\fscx100\\fs" + size + "\\1c" + ivory + "&";
    const karaoke = animation === "karaoke" ? "\\kf" + length : "";
    content += "{" + emphasis + karaoke + "}" + plainAss(token.text);
  }

  return "Dialogue: 0," + assTime(start) + "," + assTime(end) + ",Lyric,,0,0,0,,"
    + "{" + lyricTransition(animation, Math.round(width / 2), Math.round(height * .44),
      (end - start) * 1000, Math.round(Math.min(width, height) * .028)) + "}"
    + content;
}

function subtitles(settings, duration, width, height) {
  const size = Math.round(Math.min(width, height) * .056);
  const accent = palettes[settings.palette] ?? palettes.gold;
  const family = families[settings.font] ?? families.serif;
  const animation = settings.animation ?? "karaoke";
  const info = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: " + width,
    "PlayResY: " + height,
    "ScaledBorderAndShadow: yes",
    "WrapStyle: 2",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Lyric," + family + "," + size + "," + ivory + ",&H00616161,&H40000000,&H50000000,0,0,0,0,100,100,0,0,1,2,2,5,0,0,0,1",
    "Style: Title,DejaVu Sans," + Math.round(size * .43) + "," + accent + "," + accent + ",&H40000000,&H50000000,-1,0,0,0,100,100,0,0,1,1,1,5,0,0,0,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const cues = settings.cues.filter((cue) => cue.time < duration);
  for (const [index, cue] of cues.entries()) {
    const end = cues[index + 1]?.time ?? duration;
    if (assTime(cue.time) === assTime(end)) continue;
    const dialogue = lyricDialogue(cue.text, cue.time, end, width, height, size, { animation, family, accent });
    if (dialogue) info.push(dialogue);
  }

  const title = plainAss(settings.title ?? "").replace(/\n/g, " ").trim();
  if (title) {
    const titleSize = Math.max(10, Math.min(Math.round(size * .43), Math.floor(width * 1.46 / title.length)));
    info.push("Dialogue: 1,0:00:00.00," + assTime(duration) + ",Title,,0,0,0,,{\\fs" + titleSize
      + "\\pos(" + Math.round(width / 2) + "," + Math.round(height * .11) + ")}" + title);
  }
  return info.join("\n") + "\n";
}

export async function render({ ffmpeg, audio, background, settings, workdir, signal, onProgress }) {
  const options = { workdir, signal };
  const duration = await audioDuration(ffmpeg, audio, options);
  const [width, height] = settings.ratio === "9:16" ? [1080, 1920] : [1920, 1080];
  const graphWidth = Math.round(width * .80);
  const graphHeight = Math.round(Math.min(width, height) * .065);
  const graphY = Math.round(height * .87 - graphHeight / 2);
  const lyrics = path.join(workdir, "lyrics.ass");

  if (!background) {
    background = path.join(workdir, "stars.ppm");
    await writeFile(background, starBackdrop(width, height, settings.backgroundPreset));
  }
  await Promise.all([
    writeFile(lyrics, subtitles(settings, duration, width, height), "utf8"),
    cp(fonts, path.join(workdir, "fonts"), { recursive: true }),
  ]);

  const source = photos.has(path.extname(background).toLowerCase())
    ? ["-f", "image2", "-pattern_type", "none", "-framerate", "30", "-loop", "1", "-i", background]
    : ["-stream_loop", "-1", "-i", background];
  const filter = [
    "[0:v:0]scale=" + width + ":" + height + ":force_original_aspect_ratio=increase,crop="
      + width + ":" + height + ",setsar=1,fps=30[bg]",
    "[1:a:0]asplit=2[song][waveaudio]",
    "[waveaudio]aformat=channel_layouts=mono,aresample=48000,showwaves=s=864x" + graphHeight
      + ":mode=cline:colors=0xB0A69B:r=30:scale=sqrt,scale=" + graphWidth + ":" + graphHeight
      + ",format=rgba,colorkey=black:0.035:0.00,colorchannelmixer=aa=0.63[wave]",
    "[bg][wave]overlay=x=(W-w)/2:y=" + graphY + ":eof_action=pass,ass=lyrics.ass:fontsdir=fonts[out]",
  ].join(";");
  const output = path.join(workdir, "LyricFrame.mp4");

  await run(ffmpeg, [
    "-y", "-loglevel", "error", "-nostats", "-progress", "pipe:1",
    ...source, "-i", audio, "-filter_complex_threads", "2", "-filter_complex", filter,
    "-map", "[out]", "-map", "[song]", "-t", duration.toFixed(3), "-shortest",
    "-c:v", "libx264", "-threads", "3", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", output,
  ], {
    ...options,
    onLine(line) {
      if (line.startsWith("out_time=")) onProgress?.(Math.min(99, Math.round(seconds(line.slice(9)) / duration * 100)));
    },
  });
  onProgress?.(100);
  return output;
}
