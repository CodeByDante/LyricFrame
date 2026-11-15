const byId = (id) => document.getElementById(id);
const audioInput = byId("audio-file");
const backgroundInput = byId("background-file");
const lyricsInput = byId("lyrics-text");
const lrcInput = byId("lrc-file");
const titleInput = byId("video-title");
const audio = byId("audio");
const play = byId("play");
const seek = byId("seek");
const markNext = byId("mark-next");
const list = byId("cue-list");
const stage = byId("stage");
const previewText = byId("preview-lyrics");
const previewTitle = byId("preview-title-text");
const previewImage = byId("preview-image");
const previewVideo = byId("preview-video");
const canvas = byId("waveform");
const paint = canvas.getContext("2d");
const exportButton = byId("export");
const cancel = byId("cancel-export");
const download = byId("download");
const exportStatus = byId("export-status");
const exportProgress = byId("export-progress");
const ratioInputs = [...document.querySelectorAll(".ratio-input")];
const backgroundPreset = byId("background-preset");
const videoFont = byId("video-font");
const videoAnimation = byId("video-animation");
const videoPalette = byId("video-palette");
const exportEngine = byId("export-engine");
const designControls = [backgroundPreset, videoFont, videoAnimation, videoPalette];

let cues = [];
let activeIndex = -2;
let sourceFile;
let backgroundFile;
let sourceURL;
let backgroundURL;
let resultURL;
let backgroundIsVideo = false;
let rendering;
let audioContext;
let analyser;
let samples;
let frame;
let exampleFrame;
let previewWords = [];
let previewWordWeight = 0;
let waveColor = "#b0a69b";

function updateStatus(element, text, error = false) {
  element.textContent = text;
  element.hidden = !text;
  element.classList.toggle("error", error);
}

function formatTime(seconds) {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  const minutes = Math.floor(centiseconds / 6000);
  const remaining = String(Math.floor(centiseconds / 100) % 60).padStart(2, "0");
  const fraction = String(centiseconds % 100).padStart(2, "0");
  return minutes + ":" + remaining + "." + fraction;
}

function parseTime(value) {
  const text = value.trim().replace(",", ".");
  if (/^\d+(?:\.\d{1,3})?$/.test(text)) {
    return Number(text);
  }
  const clock = /^(\d+):([0-5]\d)(?:\.(\d{1,3}))?$/.exec(text);
  if (!clock) return null;
  return Number(clock[1]) * 60 + Number(clock[2]) + Number("0." + (clock[3] || "0"));
}

function timedCue(text, time = null, raw = "") {
  return { text, time, raw };
}

function setEmphasis(element, text) {
  const children = [];
  const pattern = /\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;
  let position = 0;
  for (const match of text.matchAll(pattern)) {
    children.push(document.createTextNode(text.slice(position, match.index)));
    const highlighted = document.createElement("strong");
    highlighted.textContent = match[1] ?? match[2];
    children.push(highlighted);
    position = match.index + match[0].length;
  }
  children.push(document.createTextNode(text.slice(position)));
  element.replaceChildren(...children);
}

function setPreviewWords(text) {
  setEmphasis(previewText, text);
  const elements = [...previewText.childNodes];
  previewWords = [];
  for (const element of elements) {
    if (element.nodeType === 1) {
      previewWords.push(element);
      continue;
    }
    const tokens = element.textContent.split(/(\s+)/).filter(Boolean);
    element.replaceWith(...tokens.map((token) => {
      if (/^\s+$/.test(token)) return document.createTextNode(token);
      const word = document.createElement("span");
      word.className = "karaoke-word";
      word.textContent = token;
      previewWords.push(word);
      return word;
    }));
  }
  previewWordWeight = previewWords.reduce((sum, word) => sum + word.textContent.length, 0);
}

function paintAnimation(elapsed, cueLength) {
  const kind = videoAnimation.value;
  const timed = Number.isFinite(cueLength);
  const enter = Math.min(0.28, cueLength * 0.46);
  const fade = Math.min(0.175, cueLength * 0.20);
  const remaining = timed ? 1 - Math.min(1, elapsed / enter) : 0;
  const shortSide = stage.dataset.ratio === "9:16" ? 1 : 9 / 16;
  const hyperframes = exportEngine.value === "hyperframes";
  const rise = (hyperframes ? (18 / 1080 * 100) : 2.8) * shortSide;
  let pop = 1;
  if (kind === "pop" && timed) {
    const progress = 1 - remaining;
    if (hyperframes) pop = 1 - remaining * 0.06;
    else if (progress < 0.66) pop = 0.84 + progress / 0.66 * 0.24;
    else pop = 1 + remaining / 0.34 * 0.08;
  }
  previewText.style.opacity = timed ? Math.max(0, Math.min(1, elapsed / fade, (cueLength - elapsed) / fade)) : 1;
  previewText.style.setProperty("--cue-shift", kind === "rise" ? remaining * rise + "cqw" : "0px");
  previewText.style.setProperty("--cue-scale-x", hyperframes ? String(pop) : "1");
  previewText.style.setProperty("--cue-scale-y", String(pop));
  const singing = timed && kind === "karaoke";
  previewText.dataset.singing = String(singing);
  if (singing) {
    const activeWeight = previewWordWeight * Math.min(1, elapsed / (cueLength * 0.89));
    let previous = 0;
    for (const word of previewWords) {
      const length = word.textContent.length;
      const progress = Math.max(0, Math.min(1, (activeWeight - previous) / length));
      word.style.setProperty("--word-progress", progress * 100 + "%");
      previous += length;
    }
  }
}

function animateExample() {
  cancelAnimationFrame(exampleFrame);
  exampleFrame = undefined;
  if (!audio.paused || activeIndex >= 0) {
    updateActiveCue();
    return;
  }
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    paintAnimation(1, Infinity);
    return;
  }
  const started = performance.now();
  function step(now) {
    const elapsed = Math.max(0, now - started) / 1000;
    paintAnimation(elapsed, 0.9);
    if (elapsed < 0.95) {
      exampleFrame = requestAnimationFrame(step);
    } else {
      exampleFrame = undefined;
      paintAnimation(1, Infinity);
    }
  }
  exampleFrame = requestAnimationFrame(step);
}

function syncDesign() {
  const engineChanged = stage.dataset.engine !== exportEngine.value;
  stage.dataset.engine = exportEngine.value;
  stage.dataset.background = backgroundPreset.value;
  stage.dataset.font = videoFont.value;
  stage.dataset.palette = videoPalette.value;
  const hasStars = backgroundPreset.value === "stars" || (backgroundPreset.value === "aurora" && exportEngine.value === "hyperframes");
  byId("stars").hidden = Boolean(backgroundFile) || !hasStars;
  byId("engine-help").hidden = exportEngine.value !== "hyperframes";
  waveColor = window.getComputedStyle(stage).getPropertyValue("--wave-color").trim() || "#b0a69b";
  if (engineChanged) placeStars();
  drawWaveform();
}

function removeResult() {
  if (resultURL) URL.revokeObjectURL(resultURL);
  resultURL = undefined;
  download.removeAttribute("href");
  download.hidden = true;
  if (!rendering) updateStatus(exportStatus, "");
}

function refreshControls() {
  const loading = audio.readyState < 1;
  const locked = Boolean(rendering);
  for (const control of [audioInput, backgroundInput, lyricsInput, lrcInput, titleInput, byId("clear-background"), exportEngine, ...designControls, ...ratioInputs]) {
    control.disabled = locked;
  }
  play.disabled = loading;
  seek.disabled = loading || !Number.isFinite(audio.duration) || audio.duration <= 0;
  markNext.disabled = loading || locked || !cues.some((cue) => cue.time === null);
  for (const button of list.querySelectorAll("button")) button.disabled = loading || locked;
  for (const input of list.querySelectorAll("input")) input.disabled = locked;
  exportButton.disabled = !sourceFile || !cues.length || locked;
  cancel.hidden = !locked;
  exportProgress.hidden = !locked;
  exportButton.textContent = locked ? "Generando…" : "Generar MP4";
}

function reconcileLines() {
  const texts = lyricsInput.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const previous = cues;
  const matching = new Map();
  for (const cue of previous) {
    if (!matching.has(cue.text)) matching.set(cue.text, []);
    matching.get(cue.text).push(cue);
  }
  const firstPass = texts.map((text) => matching.get(text)?.shift());
  const matched = new Set(firstPass);
  cues = texts.map((text, index) => {
    const exact = firstPass[index];
    if (exact) return exact;
    const corresponding = previous[index];
    const editedInPlace = texts.length === previous.length && corresponding && !matched.has(corresponding);
    return editedInPlace ? timedCue(text, corresponding.time, corresponding.raw) : timedCue(text);
  });
  removeResult();
  updateStatus(byId("lyrics-status"), "");
  renderCues();
}

function renderCues() {
  const rows = cues.map((cue, index) => {
    const row = document.createElement("li");
    row.className = "cue";
    const timeInput = document.createElement("input");
    timeInput.type = "text";
    timeInput.inputMode = "decimal";
    timeInput.maxLength = 14;
    timeInput.className = "cue-time";
    timeInput.value = cue.raw;
    if (cue.raw && cue.time === null) timeInput.setAttribute("aria-invalid", "true");
    timeInput.placeholder = "0:00.00";
    timeInput.setAttribute("aria-label", "Tiempo de la línea " + (index + 1));
    timeInput.dataset.index = index;
    const label = document.createElement("span");
    label.className = "cue-text";
    setEmphasis(label, cue.text);
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.index = index;
    button.className = "button tiny secondary";
    button.textContent = "Marcar";
    button.setAttribute("aria-label", "Marcar la línea " + (index + 1) + " al tiempo actual");
    row.append(timeInput, label, button);
    return row;
  });
  list.replaceChildren(...rows);
  list.hidden = !rows.length;
  byId("cue-empty").hidden = rows.length > 0;
  activeIndex = -2;
  refreshControls();
  updateTimeline();
}

function updateActiveCue() {
  let current = -1;
  let latest = -Infinity;
  cues.forEach((cue, index) => {
    if (cue.time !== null && cue.time <= audio.currentTime && cue.time >= latest) {
      latest = cue.time;
      current = index;
    }
  });
  if (current !== activeIndex) {
    list.children[activeIndex]?.classList.remove("active");
    list.children[current]?.classList.add("active");
    activeIndex = current;
    let text = cues[current]?.text ?? "";
    if (!cues.length) text = "Todo empieza con *una voz*";
    else if (!cues.some((cue) => cue.time !== null)) text = cues[0].text;
    setPreviewWords(text);
  }
  if (current >= 0) {
    const start = cues[current].time;
    const next = cues.reduce((nextTime, cue) => cue.time !== null && cue.time > start ? Math.min(nextTime, cue.time) : nextTime, Infinity);
    const end = Math.min(Number.isFinite(audio.duration) ? audio.duration : Infinity, next);
    const length = Math.max(0.01, Number.isFinite(end) ? end - start : 2.5);
    paintAnimation(audio.currentTime - start, length);
  } else if (exampleFrame === undefined) {
    paintAnimation(1, Infinity);
  }
}

function updateTimeline() {
  const current = audio.currentTime;
  const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
  seek.max = duration;
  seek.value = current;
  seek.setAttribute("aria-valuetext", formatTime(current) + " de " + formatTime(duration));
  byId("time-current").textContent = formatTime(current);
  byId("time-total").textContent = formatTime(duration);
  updateActiveCue();
}

function drawWaveform() {
  if (!paint) return;
  const width = canvas.width;
  const height = canvas.height;
  paint.clearRect(0, 0, width, height);
  const bars = 60;
  const step = width / bars;
  paint.fillStyle = waveColor;
  if (analyser && !audio.paused) analyser.getByteTimeDomainData(samples);
  for (let index = 0; index < bars; index++) {
    let amplitude;
    if (analyser && !audio.paused) {
      const begin = Math.floor(index * samples.length / bars);
      const end = Math.floor((index + 1) * samples.length / bars);
      amplitude = 0;
      for (let point = begin; point < end; point++) {
        amplitude = Math.max(amplitude, Math.abs(samples[point] - 128) / 128);
      }
      amplitude = Math.min(1, amplitude * 2.8);
    } else {
      amplitude = sourceFile ? 0.027 : 0.29 * Math.sin(index / bars * Math.PI) * Math.abs(Math.sin(index * 1.82));
    }
    const bar = Math.max(1.6, amplitude * height);
    paint.fillRect(index * step + 1.4, (height - bar) / 2, Math.max(1, step * 0.42), bar);
  }
}

function tick() {
  updateActiveCue();
  drawWaveform();
  if (!audio.paused) frame = requestAnimationFrame(tick);
}

function alignBackground() {
  if (!backgroundIsVideo || !Number.isFinite(previewVideo.duration) || previewVideo.duration <= 0) return;
  const target = audio.currentTime % previewVideo.duration;
  if (Math.abs(previewVideo.currentTime - target) > 0.35) previewVideo.currentTime = target;
}

function startWaveform() {
  const WaveAudioContext = window.AudioContext || window.webkitAudioContext;
  if (WaveAudioContext && !audioContext) {
    try {
      audioContext = new WaveAudioContext();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      samples = new Uint8Array(analyser.fftSize);
      const media = audioContext.createMediaElementSource(audio);
      media.connect(analyser);
      analyser.connect(audioContext.destination);
    } catch {
      analyser = undefined;
    }
  }
  if (audioContext?.state === "suspended") audioContext.resume().catch(() => {});
}

function editTime(index, raw) {
  const cue = cues[index];
  if (!cue) return;
  cue.time = parseTime(raw);
  cue.raw = raw;
  const input = list.children[index].querySelector("input");
  if (raw && cue.time === null) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
  removeResult();
  activeIndex = -2;
  for (const row of list.querySelectorAll(".active")) row.classList.remove("active");
  refreshControls();
  updateActiveCue();
}

function mark(index) {
  if (audio.readyState < 1 || rendering) return;
  const time = formatTime(audio.currentTime);
  const input = list.children[index].querySelector("input");
  input.value = time;
  editTime(index, time);
}

function importLrc(text) {
  const offset = Number(/^\[offset:([+-]?\d+)\]\s*$/im.exec(text)?.[1] || 0) / 1000;
  const timed = [];
  for (const line of text.split(/\r?\n/)) {
    const timestamps = [...line.matchAll(/\[(\d+:[0-5]\d(?:[.,]\d{1,3})?)\]/g)];
    if (!timestamps.length) continue;
    const label = line.slice(timestamps.at(-1).index + timestamps.at(-1)[0].length).trim();
    if (!label) continue;
    for (const timestamp of timestamps) {
      const time = Math.max(0, Math.round((parseTime(timestamp[1]) + offset) * 1000) / 1000);
      timed.push({ time, text: label });
    }
  }
  timed.sort((left, right) => left.time - right.time);
  const combined = [];
  for (const cue of timed) {
    const last = combined.at(-1);
    if (last?.time === cue.time) {
      if (last.text !== cue.text) last.text += " · " + cue.text;
    } else {
      combined.push(timedCue(cue.text, cue.time, formatTime(cue.time)));
    }
  }
  return combined;
}

function updateBackground(file) {
  previewVideo.pause();
  previewVideo.removeAttribute("src");
  previewVideo.load();
  previewImage.removeAttribute("src");
  if (backgroundURL) URL.revokeObjectURL(backgroundURL);
  backgroundFile = file;
  backgroundURL = file ? URL.createObjectURL(file) : undefined;
  backgroundIsVideo = Boolean(file && (file.type.startsWith("video/") || /\.(mp4|webm|mov)$/i.test(file.name)));
  previewImage.hidden = !file || backgroundIsVideo;
  previewVideo.hidden = !backgroundIsVideo;
  syncDesign();
  byId("background-name").textContent = file?.name || "Imagen o video opcional";
  byId("clear-background").hidden = !file;
  if (backgroundIsVideo) previewVideo.src = backgroundURL;
  else if (file) previewImage.src = backgroundURL;
  removeResult();
}

function exportIssue() {
  if (!sourceFile) return "Elige un archivo de audio.";
  if (!cues.length) return "Escribe o importa la letra.";
  for (let index = 0; index < cues.length; index++) {
    const time = cues[index].time;
    if (!Number.isFinite(time)) return "Falta un tiempo válido en la línea " + (index + 1) + ".";
    if (index > 0 && time <= cues[index - 1].time) return "El tiempo de la línea " + (index + 1) + " debe ser mayor que el de la anterior.";
    if (Number.isFinite(audio.duration) && time >= audio.duration) return "La línea " + (index + 1) + " empieza después del final del audio.";
  }
  return "";
}

function outputName(title) {
  const stem = title || sourceFile?.name.replace(/\.[^.]+$/, "") || "LyricFrame";
  const safe = stem.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim().slice(0, 100).replace(/[. ]+$/, "");
  if (!safe) return "LyricFrame.mp4";
  if (/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(safe)) return "_" + safe + ".mp4";
  return safe + ".mp4";
}

audioInput.addEventListener("change", () => {
  const file = audioInput.files[0];
  if (!file) return;
  audio.pause();
  if (sourceURL) URL.revokeObjectURL(sourceURL);
  sourceFile = file;
  sourceURL = URL.createObjectURL(file);
  audio.src = sourceURL;
  byId("audio-name").textContent = file.name;
  updateStatus(byId("audio-status"), "");
  removeResult();
  refreshControls();
  drawWaveform();
});

backgroundInput.addEventListener("change", () => {
  const file = backgroundInput.files[0];
  if (file) updateBackground(file);
});

byId("clear-background").addEventListener("click", () => {
  backgroundInput.value = "";
  updateBackground(undefined);
});

titleInput.addEventListener("input", () => {
  previewTitle.textContent = titleInput.value.trim();
  previewTitle.hidden = !previewTitle.textContent;
  removeResult();
});

lyricsInput.addEventListener("input", reconcileLines);
lrcInput.addEventListener("change", async () => {
  const file = lrcInput.files[0];
  lrcInput.value = "";
  if (!file) return;
  try {
    const imported = importLrc(await file.text());
    if (!imported.length) {
      updateStatus(byId("lyrics-status"), "El archivo LRC no tiene líneas con tiempo válido.", true);
      return;
    }
    if (rendering) return;
    cues = imported;
    lyricsInput.value = cues.map((cue) => cue.text).join("\n");
    removeResult();
    renderCues();
    updateStatus(byId("lyrics-status"), cues.length + " líneas importadas.");
  } catch {
    updateStatus(byId("lyrics-status"), "No se pudo leer el archivo LRC.", true);
  }
});

list.addEventListener("input", ({ target }) => {
  if (target.matches(".cue-time")) editTime(Number(target.dataset.index), target.value.trim());
});
list.addEventListener("click", ({ target }) => {
  const button = target.closest("button[data-index]");
  if (button) mark(Number(button.dataset.index));
});
markNext.addEventListener("click", () => {
  const firstUntimed = cues.findIndex((cue) => cue.time === null);
  if (firstUntimed >= 0) mark(firstUntimed);
});

for (const ratioInput of ratioInputs) {
  ratioInput.addEventListener("change", () => {
    stage.dataset.ratio = ratioInput.value;
    byId("resolution").textContent = ratioInput.value === "9:16" ? "1080 × 1920 · MP4" : "1920 × 1080 · MP4";
    placeStars();
    removeResult();
  });
}

for (const control of designControls) {
  control.addEventListener("change", () => {
    syncDesign();
    if (control === videoAnimation) animateExample();
    removeResult();
  });
}
exportEngine.addEventListener("change", () => {
  syncDesign();
  removeResult();
});

play.addEventListener("click", () => {
  if (audio.paused) {
    startWaveform();
    audio.play().catch(() => updateStatus(byId("audio-status"), "No se pudo reproducir el audio.", true));
  } else {
    audio.pause();
  }
});
seek.addEventListener("input", () => {
  audio.currentTime = Number(seek.value);
  updateTimeline();
  alignBackground();
});
audio.addEventListener("loadedmetadata", () => {
  updateTimeline();
  refreshControls();
});
audio.addEventListener("emptied", () => {
  updateTimeline();
  refreshControls();
});
audio.addEventListener("timeupdate", () => {
  updateTimeline();
  alignBackground();
});
audio.addEventListener("play", () => {
  play.classList.add("playing");
  play.setAttribute("aria-label", "Pausar");
  updateStatus(byId("audio-status"), "");
  cancelAnimationFrame(frame);
  cancelAnimationFrame(exampleFrame);
  exampleFrame = undefined;
  tick();
  alignBackground();
  if (backgroundIsVideo) previewVideo.play().catch(() => {});
});
function resetPlayback() {
  play.classList.remove("playing");
  play.setAttribute("aria-label", "Reproducir");
  previewVideo.pause();
  cancelAnimationFrame(frame);
  updateTimeline();
  drawWaveform();
}
audio.addEventListener("pause", resetPlayback);
audio.addEventListener("ended", resetPlayback);
audio.addEventListener("error", () => {
  updateStatus(byId("audio-status"), "El navegador no puede previsualizar este archivo. Puedes editar los tiempos manualmente.", true);
  refreshControls();
});
previewVideo.addEventListener("loadedmetadata", () => {
  alignBackground();
  if (!audio.paused) previewVideo.play().catch(() => {});
});

exportButton.addEventListener("click", async () => {
  const issue = exportIssue();
  if (issue) {
    updateStatus(exportStatus, issue, true);
    return;
  }
  if (rendering) return;
  removeResult();
  const request = new AbortController();
  rendering = request;
  refreshControls();
  updateStatus(exportStatus, "Generando video. El tiempo depende de la duración de la canción.");
  const title = titleInput.value.trim();
  const form = new FormData();
  form.append("audio", sourceFile);
  if (backgroundFile) form.append("background", backgroundFile);
  form.append("settings", JSON.stringify({
    ratio: stage.dataset.ratio,
    title,
    backgroundPreset: backgroundPreset.value,
    font: videoFont.value,
    animation: videoAnimation.value,
    palette: videoPalette.value,
    engine: exportEngine.value,
    cues: cues.map(({ time, text }) => ({ time, text })),
  }));

  try {
    const response = await fetch("/export", { method: "POST", body: form, signal: request.signal });
    if (!response.ok) throw new Error((await response.text()).trim() || "No se pudo generar el video.");
    if (rendering !== request) return;
    updateStatus(exportStatus, "Preparando la descarga…");
    const video = await response.blob();
    if (!video.size) throw new Error("El archivo generado está vacío.");
    if (rendering !== request) return;
    resultURL = URL.createObjectURL(video);
    download.href = resultURL;
    download.download = outputName(title);
    download.hidden = false;
    updateStatus(exportStatus, "Video listo.");
  } catch (error) {
    if (rendering !== request) return;
    updateStatus(exportStatus, request.signal.aborted ? "Exportación cancelada." : (error.message || "No se pudo generar el video."), !request.signal.aborted);
  } finally {
    if (rendering === request) {
      rendering = undefined;
      refreshControls();
    }
  }
});

cancel.addEventListener("click", () => {
  rendering?.abort();
  rendering = undefined;
  refreshControls();
  updateStatus(exportStatus, "Exportación cancelada.");
  exportButton.focus();
});

function placeStars() {
  const fragment = document.createDocumentFragment();
  const width = stage.dataset.ratio === "9:16" ? 1080 : 1920;
  const hyperframes = exportEngine.value === "hyperframes";
  let seed = 3000;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  for (let index = 0; index < (hyperframes ? 220 : 270); index++) {
    const star = document.createElement("span");
    star.style.left = random() * 100 + "%";
    star.style.top = random() * 100 + "%";
    const brightness = random() ** 3;
    const radius = hyperframes ? 1 : 0.85 + random() ** 2 * 1.75;
    const size = Math.max(0.55, 2 * radius / width * stage.clientWidth);
    star.style.width = size + "px";
    star.style.height = size + "px";
    star.style.opacity = String(hyperframes ? 0.10 + brightness * 0.55 : (22 + brightness * 128) / 255);
    fragment.append(star);
  }
  byId("stars").replaceChildren(fragment);
}

renderCues();
syncDesign();
