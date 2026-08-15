"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Area = "zampona" | "charango";
type ZEvent = { row: "S" | "I"; tube: number; duration: number };
type ChordHit = { time: number; chord: string; confidence: number };
type SavedWork = {
  id: string;
  title: string;
  kind: Area;
  createdAt: string;
  result: string;
};

const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const EASY_CHORDS = new Set(["C", "D", "E", "F", "G", "A", "Am", "Dm", "Em"]);
const CHORD_SHAPES: Record<string, string> = {
  C: "0·0·0·3·3", D: "2·2·2·0·0", E: "4·4·4·2·2", F: "2·0·1·0·1",
  G: "0·2·3·2·0", A: "2·1·0·0·0", Am: "2·0·0·0·0", Dm: "2·2·1·0·0",
  Em: "4·3·2·0·0",
};
const DEFAULT_TUBES = Array.from({ length: 23 }, (_, index) => {
  const top = index < 12;
  const tube = top ? index + 1 : index - 11;
  const midi = (top ? 81 : 80) - tube + 1;
  const center = 440 * 2 ** ((midi - 69) / 12);
  return { row: (top ? "S" : "I") as "S" | "I", tube, min: center * 0.98, max: center * 1.02 };
});

function parseSequence(text: string): ZEvent[] {
  return text.trim().split(/\s+/).flatMap((token) => {
    const match = token.match(/^([SI])(\d{1,2})(?::([\d.]+))?$/i);
    if (!match) return [];
    return [{ row: match[1].toUpperCase() as "S" | "I", tube: Number(match[2]), duration: Number(match[3] || 1) }];
  });
}
function sequenceText(events: ZEvent[]) {
  return events.map((event) => `${event.row}${event.tube}${event.duration === 1 ? "" : `:${event.duration}`}`).join(" ");
}
function downloadText(name: string, content: string) {
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}
function rms(buffer: Float32Array) {
  let sum = 0;
  for (const value of buffer) sum += value * value;
  return Math.sqrt(sum / buffer.length);
}
function autoPitch(buffer: Float32Array, sampleRate: number, minHz = 120, maxHz = 1400) {
  if (rms(buffer) < 0.008) return 0;
  const minLag = Math.floor(sampleRate / maxHz);
  const maxLag = Math.min(Math.floor(sampleRate / minHz), buffer.length / 2);
  let bestLag = 0, best = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0, a = 0, b = 0;
    for (let i = 0; i < buffer.length - lag; i++) {
      corr += buffer[i] * buffer[i + lag];
      a += buffer[i] * buffer[i];
      b += buffer[i + lag] * buffer[i + lag];
    }
    const score = corr / Math.sqrt(a * b || 1);
    if (score > best) { best = score; bestLag = lag; }
  }
  return best > 0.62 && bestLag ? sampleRate / bestLag : 0;
}
function nearestTube(freq: number, tubes: typeof DEFAULT_TUBES) {
  if (!freq) return null;
  const candidates = tubes.map((tube) => {
    const center = Math.sqrt(tube.min * tube.max);
    const outside = freq < tube.min ? tube.min - freq : freq > tube.max ? freq - tube.max : 0;
    return { ...tube, score: outside * 10 + Math.abs(freq - center) };
  }).sort((a, b) => a.score - b.score);
  return candidates[0];
}
async function decodeAudio(file: File) {
  const context = new AudioContext();
  const decoded = await context.decodeAudioData(await file.arrayBuffer());
  const mono = new Float32Array(decoded.length);
  for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
    const data = decoded.getChannelData(channel);
    for (let i = 0; i < data.length; i++) mono[i] += data[i] / decoded.numberOfChannels;
  }
  await context.close();
  return { mono, sampleRate: decoded.sampleRate, duration: decoded.duration };
}
function analyzeZamponaAudio(mono: Float32Array, sampleRate: number, tubes: typeof DEFAULT_TUBES, bpm: number) {
  const frame = 2048;
  const hop = Math.max(512, Math.floor(sampleRate * 0.055));
  const hits: { at: number; key: string; row: "S" | "I"; tube: number }[] = [];
  for (let start = 0; start + frame < mono.length; start += hop) {
    const slice = mono.subarray(start, start + frame);
    const pitch = autoPitch(slice, sampleRate);
    const tube = nearestTube(pitch, tubes);
    if (tube && pitch) hits.push({ at: start / sampleRate, key: tube.row + tube.tube, row: tube.row, tube: tube.tube });
  }
  const groups: { start: number; end: number; row: "S" | "I"; tube: number }[] = [];
  for (const hit of hits) {
    const last = groups.at(-1);
    if (last && last.row === hit.row && last.tube === hit.tube && hit.at - last.end < 0.16) last.end = hit.at + hop / sampleRate;
    else groups.push({ start: hit.at, end: hit.at + hop / sampleRate, row: hit.row, tube: hit.tube });
  }
  const beat = 60 / bpm;
  const values = [0.5, 1, 1.5, 2, 3, 4];
  return groups.filter((group) => group.end - group.start > 0.07).map((group) => {
    const raw = (group.end - group.start) / beat;
    const duration = values.reduce((a, b) => Math.abs(b - raw) < Math.abs(a - raw) ? b : a);
    return { row: group.row, tube: group.tube, duration };
  });
}
function chromaFrame(samples: Float32Array, sampleRate: number) {
  const chroma = Array(12).fill(0);
  for (let midi = 40; midi <= 88; midi++) {
    const freq = 440 * 2 ** ((midi - 69) / 12);
    let real = 0, imag = 0;
    const step = 2 * Math.PI * freq / sampleRate;
    for (let i = 0; i < samples.length; i += 2) {
      const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / samples.length);
      real += samples[i] * window * Math.cos(step * i);
      imag -= samples[i] * window * Math.sin(step * i);
    }
    chroma[midi % 12] += Math.sqrt(real * real + imag * imag);
  }
  const total = chroma.reduce((a, b) => a + b, 0) || 1;
  return chroma.map((value) => value / total);
}
function estimateKey(chroma: number[]) {
  const major = [6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88];
  const minor = [6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
  let best = { score: -Infinity, root: 0, mode: "mayor" };
  for (let root = 0; root < 12; root++) for (const [profile, mode] of [[major,"mayor"],[minor,"menor"]] as const) {
    const score = chroma.reduce((sum, value, pc) => sum + value * profile[(pc - root + 12) % 12], 0);
    if (score > best.score) best = { score, root, mode };
  }
  return best;
}
function chordFor(chroma: number[], key: ReturnType<typeof estimateKey>, beginner: boolean) {
  const roots = key.mode === "mayor" ? [0,2,4,5,7,9] : [0,2,3,5,7,8,10];
  let best = { score: -Infinity, chord: "" };
  for (const offset of roots) {
    const root = (key.root + offset) % 12;
    const minorOffsets = key.mode === "mayor" ? new Set([2,4,9]) : new Set([0,5,7]);
    const minor = minorOffsets.has(offset);
    const third = (root + (minor ? 3 : 4)) % 12;
    const fifth = (root + 7) % 12;
    const name = NOTE_NAMES[root].replace("♯", "#") + (minor ? "m" : "");
    let score = chroma[root] * 1.2 + chroma[third] + chroma[fifth];
    if (beginner && EASY_CHORDS.has(name)) score += 0.12;
    if (score > best.score) best = { score, chord: name };
  }
  return { chord: best.chord, confidence: Math.min(99, Math.round(best.score * 100)) };
}
function analyzeHarmony(mono: Float32Array, sampleRate: number, beginner: boolean) {
  const maxLength = Math.min(mono.length, sampleRate * 120);
  const global = Array(12).fill(0);
  const frames: { time: number; chroma: number[] }[] = [];
  const frameSize = 4096;
  const hop = sampleRate * 2;
  for (let start = 0; start + frameSize < maxLength; start += hop) {
    const chroma = chromaFrame(mono.subarray(start, start + frameSize), sampleRate);
    chroma.forEach((value, index) => global[index] += value);
    frames.push({ time: start / sampleRate, chroma });
  }
  const key = estimateKey(global);
  const progression: ChordHit[] = frames.map((frame) => ({ time: frame.time, ...chordFor(frame.chroma, key, beginner) }))
    .filter((hit, index, all) => index === 0 || hit.chord !== all[index - 1].chord);
  return { key: `${NOTE_NAMES[key.root]} ${key.mode}`, root: key.root, mode: key.mode, progression };
}

function Card({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <section className="tool-card"><div className="tool-head"><div><h3>{title}</h3><p>{description}</p></div></div>{children}</section>;
}
function FilePicker({ onFile, accept = "audio/*" }: { onFile: (file: File) => void; accept?: string }) {
  return <label className="file-picker"><span>Seleccionar audio</span><input type="file" accept={accept} onChange={(event) => event.target.files?.[0] && onFile(event.target.files[0])} /></label>;
}

export default function LabClient() {
  const [area, setArea] = useState<Area>("zampona");
  const [bpm, setBpm] = useState(90);
  const [taps, setTaps] = useState<number[]>([]);
  const [audio, setAudio] = useState<{ file: File; url: string; mono: Float32Array; sampleRate: number; duration: number } | null>(null);
  const [busy, setBusy] = useState("");
  const [zEvents, setZEvents] = useState<ZEvent[]>([]);
  const [manual, setManual] = useState("");
  const [tubes, setTubes] = useState(DEFAULT_TUBES);
  const [profileName, setProfileName] = useState("Zampoña principal");
  const [reference, setReference] = useState("S8 I9 S8 I7");
  const [trainer, setTrainer] = useState({ running: false, index: 0, correct: 0, mistakes: 0, heard: "—" });
  const [works, setWorks] = useState<SavedWork[]>([]);
  const [setlist, setSetlist] = useState<string[]>([]);
  const [newSong, setNewSong] = useState("");
  const [sourceType, setSourceType] = useState("audio completo");
  const [beginner, setBeginner] = useState(true);
  const [harmony, setHarmony] = useState<ReturnType<typeof analyzeHarmony> | null>(null);
  const [transpose, setTranspose] = useState(0);
  const micStop = useRef<null | (() => void)>(null);

  useEffect(() => {
    setWorks(JSON.parse(localStorage.getItem("cautivo-works") || "[]"));
    setSetlist(JSON.parse(localStorage.getItem("cautivo-setlist") || "[]"));
    const savedTubes = JSON.parse(localStorage.getItem("cautivo-tubes") || "null");
    if (savedTubes) setTubes(savedTubes);
    return () => { if (audio) URL.revokeObjectURL(audio.url); micStop.current?.(); };
  }, []);
  useEffect(() => { setManual(sequenceText(zEvents)); }, [zEvents]);
  const refEvents = useMemo(() => parseSequence(reference), [reference]);
  const comparison = useMemo(() => {
    if (!refEvents.length || !zEvents.length) return null;
    const total = Math.max(refEvents.length, zEvents.length);
    let notes = 0, rhythm = 0;
    for (let index = 0; index < Math.min(refEvents.length, zEvents.length); index++) {
      if (refEvents[index].row === zEvents[index].row && refEvents[index].tube === zEvents[index].tube) notes++;
      if (refEvents[index].duration === zEvents[index].duration) rhythm++;
    }
    return { notes: Math.round(notes / total * 100), rhythm: Math.round(rhythm / total * 100) };
  }, [refEvents, zEvents]);

  async function loadAudio(file: File) {
    setBusy("Preparando audio…");
    try {
      if (audio) URL.revokeObjectURL(audio.url);
      const decoded = await decodeAudio(file);
      setAudio({ file, url: URL.createObjectURL(file), ...decoded });
    } finally { setBusy(""); }
  }
  function tapTempo() {
    const now = performance.now();
    const recent = [...taps.filter((tap) => now - tap < 4000), now].slice(-8);
    setTaps(recent);
    if (recent.length > 1) {
      const intervals = recent.slice(1).map((tap, index) => tap - recent[index]);
      setBpm(Math.round(60000 / (intervals.reduce((a, b) => a + b, 0) / intervals.length)));
    }
  }
  async function analyzeZ() {
    if (!audio) return;
    setBusy("Analizando melodía y duraciones…");
    await new Promise((resolve) => setTimeout(resolve, 30));
    setZEvents(analyzeZamponaAudio(audio.mono, audio.sampleRate, tubes, bpm));
    setBusy("");
  }
  async function analyzeC() {
    if (!audio) return;
    setBusy("Calculando tonalidad y acordes…");
    await new Promise((resolve) => setTimeout(resolve, 30));
    setHarmony(analyzeHarmony(audio.mono, audio.sampleRate, beginner));
    setBusy("");
  }
  function saveWork(kind: Area, result: string) {
    const title = prompt("Nombre del trabajo", audio?.file.name.replace(/\.[^.]+$/, "") || "Borrador");
    if (!title) return;
    const next = [{ id: crypto.randomUUID(), title, kind, createdAt: new Date().toISOString(), result }, ...works];
    setWorks(next); localStorage.setItem("cautivo-works", JSON.stringify(next));
  }
  function saveTubes() {
    localStorage.setItem("cautivo-tubes", JSON.stringify(tubes));
    localStorage.setItem("cautivo-tube-profile", profileName);
    alert("Perfil de calibración guardado en este dispositivo.");
  }
  async function startTrainer() {
    if (trainer.running) { micStop.current?.(); return; }
    const target = refEvents;
    if (!target.length) return alert("Escribe primero una secuencia de referencia.");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const context = new AudioContext();
    const analyser = context.createAnalyser(); analyser.fftSize = 2048;
    context.createMediaStreamSource(stream).connect(analyser);
    let stopped = false, index = 0, correct = 0, mistakes = 0, stable = "", stableFrames = 0;
    setTrainer({ running: true, index, correct, mistakes, heard: "Escuchando…" });
    const tick = () => {
      if (stopped) return;
      const data = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(data);
      const tube = nearestTube(autoPitch(data, context.sampleRate), tubes);
      const heard = tube ? tube.row + tube.tube : "";
      stableFrames = heard === stable ? stableFrames + 1 : 0; stable = heard;
      if (heard && stableFrames === 2 && index < target.length) {
        const expected = target[index].row + target[index].tube;
        if (heard === expected) { correct++; index++; } else mistakes++;
        setTrainer({ running: true, index, correct, mistakes, heard });
        if (index >= target.length) micStop.current?.();
      }
      requestAnimationFrame(tick);
    };
    micStop.current = () => {
      stopped = true; stream.getTracks().forEach((track) => track.stop()); context.close();
      setTrainer((value) => ({ ...value, running: false }));
    };
    tick();
  }
  const transposedProgression = harmony?.progression.map((hit) => {
    const minor = hit.chord.endsWith("m");
    const root = NOTE_NAMES.findIndex((note) => note.replace("♯", "#") === hit.chord.replace("m", ""));
    return { ...hit, chord: NOTE_NAMES[(root + transpose + 12) % 12].replace("♯", "#") + (minor ? "m" : "") };
  }) || [];

  return <main>
    <header className="hero">
      <div className="brand-mark">†</div>
      <div><p className="eyebrow">HERRAMIENTAS DE APOYO</p><h1>Laboratorio Musical del Cautivo</h1><p>Analiza, registra, practica y prepara acompañamientos sin enviar tu audio a servidores.</p></div>
      <div className="privacy-pill">● Procesamiento local</div>
    </header>
    <nav className="area-tabs" aria-label="Instrumentos">
      <button className={area === "zampona" ? "active" : ""} onClick={() => setArea("zampona")}><span>▥</span> Ideas Zampoñas</button>
      <button className={area === "charango" ? "active" : ""} onClick={() => setArea("charango")}><span>♫</span> Ideas Charango</button>
    </nav>
    <section className="workspace">
      <aside className="control-rail">
        <h2>Sesión musical</h2>
        <FilePicker onFile={loadAudio} />
        <label>Enlace de referencia<input placeholder="YouTube u otra fuente" /></label>
        <p className="hint">El enlace queda como referencia. Para analizar, sube el audio o grábalo.</p>
        {audio && <audio className="audio" controls src={audio.url} />}
        <div className="tempo"><label>Tempo<input type="number" min="30" max="240" value={bpm} onChange={(event) => setBpm(Number(event.target.value))} /></label><button onClick={tapTempo}>TAP</button></div>
        <p className="hint">Pulsa TAP siguiendo el ritmo.</p>
        {busy && <div className="busy">{busy}</div>}
        <h3>Biblioteca local</h3>
        <div className="saved-list">{works.length ? works.slice(0, 8).map((work) => <button key={work.id} onClick={() => {
          setArea(work.kind);
          if (work.kind === "zampona") setZEvents(parseSequence(work.result));
        }}><b>{work.title}</b><small>{work.kind === "zampona" ? "Zampoña" : "Charango"} · {new Date(work.createdAt).toLocaleDateString("es-PE")}</small></button>) : <p className="empty">Aún no hay trabajos guardados.</p>}</div>
      </aside>

      <div className="tools">
        {area === "zampona" ? <>
          <div className="section-title"><p className="eyebrow">IDEAS ZAMPOÑAS</p><h2>Del sonido a una secuencia practicable</h2><p>Todos los módulos trabajan con el mismo borrador y perfil de tubos.</p></div>
          <Card title="1. Analizador de audio grabado" description="Detecta tubos y cuantiza su duración según el BPM.">
            <div className="actions"><button className="primary" disabled={!audio || !!busy} onClick={analyzeZ}>Analizar audio</button><button onClick={() => setZEvents([])}>Limpiar resultado</button></div>
            <div className="timeline">{zEvents.length ? zEvents.map((event, index) => <button key={index} className="note-chip" onClick={() => {
              const duration = Number(prompt("Duración", event.duration));
              if (duration > 0) setZEvents(zEvents.map((item, i) => i === index ? { ...item, duration } : item));
            }}><b>{event.row}{event.tube}</b><small>×{event.duration}</small></button>) : <p className="empty">Sube un audio y pulsa Analizar.</p>}</div>
          </Card>
          <Card title="2. Constructor visual y conversor" description="Agrega, corrige, reordena y exporta tubos sin aprender sintaxis complicada.">
            <div className="builder-controls"><select id="row"><option>S</option><option>I</option></select><input id="tube" type="number" min="1" max="12" defaultValue="1" /><select id="duration"><option value=".5">½</option><option value="1">1</option><option value="1.5">1½</option><option value="2">2</option><option value="3">3</option><option value="4">4</option></select><button onClick={() => {
              const row = (document.querySelector("#row") as HTMLSelectElement).value as "S" | "I";
              const tube = Number((document.querySelector("#tube") as HTMLInputElement).value);
              const duration = Number((document.querySelector("#duration") as HTMLSelectElement).value);
              setZEvents([...zEvents, { row, tube, duration }]);
            }}>＋ Añadir</button><button onClick={() => setZEvents(zEvents.slice(0, -1))}>↶ Deshacer</button></div>
            <textarea value={manual} onChange={(event) => setManual(event.target.value)} placeholder="S8:2 I9 S8:0.5" />
            <div className="actions"><button onClick={() => setZEvents(parseSequence(manual))}>Aplicar texto</button><button onClick={() => navigator.clipboard.writeText(manual)}>Copiar</button><button onClick={() => downloadText("secuencia-zampona.txt", manual)}>Descargar</button><button className="primary" onClick={() => saveWork("zampona", manual)}>Guardar borrador</button></div>
          </Card>
          <Card title="3. Calibrador profesional" description="Perfiles con frecuencia mínima y máxima para tus 23 tubos.">
            <label>Nombre del perfil<input value={profileName} onChange={(event) => setProfileName(event.target.value)} /></label>
            <div className="tube-table"><div className="tube-row tube-header"><b>Tubo</b><span>Mínimo</span><span>Máximo</span><span>Centro</span></div>{tubes.map((tube, index) => <div className="tube-row" key={tube.row + tube.tube}><b>{tube.row}{tube.tube}</b><input type="number" step=".1" value={tube.min.toFixed(1)} onChange={(event) => setTubes(tubes.map((item, i) => i === index ? { ...item, min: Number(event.target.value) } : item))} /><input type="number" step=".1" value={tube.max.toFixed(1)} onChange={(event) => setTubes(tubes.map((item, i) => i === index ? { ...item, max: Number(event.target.value) } : item))} /><span>{Math.sqrt(tube.min * tube.max).toFixed(1)} Hz</span></div>)}</div>
            <div className="actions"><button className="primary" onClick={saveTubes}>Guardar perfil</button><button onClick={() => downloadText("perfil-zampona.json", JSON.stringify({ name: profileName, tubes }, null, 2))}>Exportar perfil</button></div>
          </Card>
          <Card title="4. Entrenamiento y comparación" description="La página escucha si tocas la secuencia esperada y compara el borrador detectado.">
            <label>Secuencia correcta<textarea value={reference} onChange={(event) => setReference(event.target.value)} /></label>
            <div className="trainer-panel"><div><span>Siguiente</span><strong>{refEvents[trainer.index] ? refEvents[trainer.index].row + refEvents[trainer.index].tube : "✓"}</strong></div><div><span>Escuchado</span><strong>{trainer.heard}</strong></div><div><span>Aciertos</span><strong>{trainer.correct}</strong></div><div><span>Intentos errados</span><strong>{trainer.mistakes}</strong></div></div>
            <div className="actions"><button className="primary" onClick={startTrainer}>{trainer.running ? "Detener escucha" : "Practicar con micrófono"}</button></div>
            {comparison && <div className="scores"><div><b>{comparison.notes}%</b><span>Precisión de notas</span></div><div><b>{comparison.rhythm}%</b><span>Precisión rítmica</span></div></div>}
          </Card>
          <Card title="5. Biblioteca, tempo y ensayo grupal" description="Organiza grabaciones, orden de ensayo y resultados en este dispositivo.">
            <div className="setlist-add"><input value={newSong} onChange={(event) => setNewSong(event.target.value)} placeholder="Nombre de la canción" /><button onClick={() => { if (!newSong.trim()) return; const next = [...setlist, newSong.trim()]; setSetlist(next); setNewSong(""); localStorage.setItem("cautivo-setlist", JSON.stringify(next)); }}>Añadir</button></div>
            <ol className="setlist">{setlist.map((song, index) => <li key={index}><span>{song}</span><button onClick={() => { const next = setlist.filter((_, i) => i !== index); setSetlist(next); localStorage.setItem("cautivo-setlist", JSON.stringify(next)); }}>Quitar</button></li>)}</ol>
            <p className="hint">Tempo actual: <b>{bpm} BPM</b>. Tus borradores, perfiles y lista permanecen guardados localmente.</p>
          </Card>
        </> : <>
          <div className="section-title"><p className="eyebrow">IDEAS CHARANGO</p><h2>De la melodía a un acompañamiento posible</h2><p>La herramienta propone acordes; tú escuchas, comparas y eliges.</p></div>
          <Card title="1. Analizador armónico" description="Estima tonalidad y cambios de acorde a partir de un audio cargado.">
            <div className="form-grid"><label>Tipo de fuente<select value={sourceType} onChange={(event) => setSourceType(event.target.value)}><option>audio completo</option><option>voz sola</option><option>Zampoña sola</option></select></label><label>Objetivo<select value={beginner ? "easy" : "faithful"} onChange={(event) => setBeginner(event.target.value === "easy")}><option value="easy">Acompañamiento fácil</option><option value="faithful">Más cercano al original</option></select></label></div>
            <div className="actions"><button className="primary" disabled={!audio || !!busy} onClick={analyzeC}>Detectar tonalidad y acordes</button></div>
            {!audio && <p className="empty">Selecciona un audio desde el panel izquierdo.</p>}
            {sourceType !== "audio completo" && <p className="notice">Con una melodía sola existen varias armonizaciones válidas. Mostraremos la opción más compatible, no una verdad absoluta.</p>}
          </Card>
          <Card title="2. Progresión sugerida" description="Cambios de acorde, confianza y comparación auditiva.">
            {harmony ? <><div className="key-result"><span>Tonalidad probable</span><strong>{harmony.key}</strong></div><label>Transportar<select value={transpose} onChange={(event) => setTranspose(Number(event.target.value))}>{Array.from({ length: 13 }, (_, index) => index - 6).map((value) => <option key={value} value={value}>{value > 0 ? "+" : ""}{value} semitonos</option>)}</select></label><div className="chord-timeline">{transposedProgression.map((hit, index) => <article key={index}><small>{Math.floor(hit.time / 60)}:{String(Math.floor(hit.time % 60)).padStart(2, "0")}</small><b>{hit.chord}</b><span>{hit.confidence}%</span></article>)}</div></> : <p className="empty">Aquí aparecerán la tonalidad y la progresión.</p>}
          </Card>
          <Card title="3. Digitaciones y modo principiante" description="Prioriza acordes cómodos y muestra una guía rápida de posiciones.">
            <div className="diagram-grid">{[...new Set(transposedProgression.map((hit) => hit.chord))].map((chord) => <article className="chord-card" key={chord}><h4>{chord}</h4><div className="strings">{(CHORD_SHAPES[chord] || "· · · · ·").split("·").map((fret, index) => <span key={index}><i style={{ height: `${8 + Number(fret || 0) * 8}px` }}></i><b>{fret || "?"}</b></span>)}</div><small>{CHORD_SHAPES[chord] ? "Digitación de referencia" : "Revisar digitación"}</small></article>)}</div>
            {!transposedProgression.length && <p className="empty">Analiza un audio para generar las digitaciones.</p>}
          </Card>
          <Card title="4. Comparador y editor" description="Prueba alternativas, simplifica cambios y corrige la propuesta.">
            <textarea value={transposedProgression.map((hit) => hit.chord).join(" – ")} readOnly placeholder="G – D – Em – C" />
            <div className="actions"><button onClick={() => navigator.clipboard.writeText(transposedProgression.map((hit) => hit.chord).join(" "))}>Copiar progresión</button><button onClick={() => downloadText("progresion-charango.txt", `Tonalidad: ${harmony?.key || "—"}\nAcordes: ${transposedProgression.map((hit) => hit.chord).join(" ")}`)}>Descargar</button><button className="primary" disabled={!harmony} onClick={() => saveWork("charango", JSON.stringify(harmony))}>Guardar análisis</button></div>
            <p className="hint">Consejo: reproduce el audio original y prueba la progresión. Si una zona no encaja, conserva las alternativas que compartan las notas principales de la melodía.</p>
          </Card>
          <Card title="5. Flujo hacia el cancionero" description="Resultado listo para copiar al editor de Charango.">
            <div className="export-preview"><p><b>Tonalidad:</b> {harmony?.key || "—"}</p><p><b>Modo:</b> {beginner ? "Principiante" : "Fiel"}</p><p><b>Fuente:</b> {sourceType}</p><p><b>Progresión:</b> {transposedProgression.map((hit) => hit.chord).join(" – ") || "—"}</p><p><b>BPM:</b> {bpm}</p></div>
            <button className="primary" disabled={!harmony} onClick={() => navigator.clipboard.writeText(JSON.stringify({ tonalidad: harmony?.key, bpm, modo: beginner ? "principiante" : "fiel", fuente: sourceType, progresion: transposedProgression }, null, 2))}>Copiar ficha completa</button>
          </Card>
        </>}
      </div>
    </section>
    <footer><span>†</span><p>Laboratorio Musical del Cautivo</p><small>Herramienta independiente · los resultados automáticos siempre deben revisarse con el oído.</small></footer>
  </main>;
}
