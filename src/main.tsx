import { PointerEvent, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { getDemoCase, makeDemoOutcome, type TraceOutcome } from "./demo-agent";
import "./styles.css";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js"));
}

type Mode = "quiet" | "seek";
type InkState = "rest" | "awakening" | "reading" | "ready";
type InkImage = { data: string; mimeType: "image/png" };
type InkBounds = { left: number; top: number; right: number; bottom: number };
type TranscriptionProposal = { text: string; candidates: string[]; lines?: Array<{ text: string; box: { x: number; y: number; width: number; height: number } }> };
type PendingTranscription = { text: string; candidates: string[]; image: InkImage; isFixture: boolean };
type PageRecord = { ink: string | null; inkBounds: InkBounds | null; outcome: TraceOutcome | null; isCollected: boolean; transcription: PendingTranscription | null };

const INK_CAPTURE_PADDING = 18;

async function postJson(path: string, body: unknown) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json() as Promise<{ status: string; transcription?: TranscriptionProposal; providerStatus?: string; outcome?: TraceOutcome }>;
}

function unavailableMessage(status: string, subject: "转写" | "寻迹") {
  if (status === "vision_unconfigured") return "这页笔迹已保留；视觉转写尚未配置，暂不能生成机器转写。";
  if (status === "provider_not_implemented") return "视觉转写服务已预留，但尚未接入；这页笔迹会留在纸上。";
  if (status === "vision_timed_out") return "转写等候过久，已停止本次尝试；这页笔迹仍留在纸上。";
  if (status === "vision_unavailable") return "转写服务暂不可达；这页笔迹已保留。";
  if (status === "model_unconfigured") return "转写已确认；寻迹内核尚未配置，因此没有生成旁批。";
  if (status === "needs_transcription") return "请先确认这页的机器转写，再继续寻迹。";
  if (status === "invalid_ink") return "这页笔迹截图无法识别；请再写一笔后重试。";
  return `${subject}暂时没有完成；原始笔迹已保留。`;
}

function Notebook() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const hasInkRef = useRef(false);
  const inkBoundsRef = useRef<InkBounds | null>(null);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  const resultTimerRef = useRef<number | null>(null);
  const [mode, setMode] = useState<Mode>("seek");
  const [inkState, setInkState] = useState<InkState>("rest");
  const [hasInk, setHasInk] = useState(false);
  const [outcome, setOutcome] = useState<TraceOutcome | null>(null);
  const [pendingTranscription, setPendingTranscription] = useState<PendingTranscription | null>(null);
  const [systemNote, setSystemNote] = useState<string | null>(null);
  const [isCollected, setIsCollected] = useState(false);
  const [showTrace, setShowTrace] = useState(false);
  const [pages, setPages] = useState<PageRecord[]>([{ ink: null, inkBounds: null, outcome: null, isCollected: false, transcription: null }]);
  const [pageIndex, setPageIndex] = useState(0);

  const rememberPage = () => {
    const ink = hasInkRef.current ? canvasRef.current?.toDataURL() ?? null : null;
    setPages((current) => current.map((page, index) => index === pageIndex ? { ink, inkBounds: inkBoundsRef.current, outcome, isCollected, transcription: pendingTranscription } : page));
  };

  const restoreInk = (ink: string | null) => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!ink) return;
    const image = new Image();
    image.onload = () => {
      const rect = canvas.getBoundingClientRect();
      context.drawImage(image, 0, 0, rect.width, rect.height);
    };
    image.src = ink;
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const snapshot = hasInkRef.current ? canvas.toDataURL() : null;
      const scale = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * scale);
      canvas.height = Math.round(rect.height * scale);
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(scale, 0, 0, scale, 0, 0);
      context.lineCap = "round";
      context.lineJoin = "round";
      context.strokeStyle = "#25221d";
      context.lineWidth = 3;
      if (snapshot) {
        const image = new Image();
        image.onload = () => context.drawImage(image, 0, 0, rect.width, rect.height);
        image.src = snapshot;
      }
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  useEffect(() => () => {
    if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    if (resultTimerRef.current) window.clearTimeout(resultTimerRef.current);
  }, []);

  const pointFor = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const makeDot = (canvas: HTMLCanvasElement, point: { x: number; y: number }) => {
    const context = canvas.getContext("2d");
    if (!context) return;
    context.beginPath();
    context.arc(point.x, point.y, 1.5, 0, Math.PI * 2);
    context.fillStyle = "#25221d";
    context.fill();
  };

  const includeInInkBounds = (canvas: HTMLCanvasElement, point: { x: number; y: number }) => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = point.x / rect.width;
    const y = point.y / rect.height;
    const bounds = inkBoundsRef.current;
    inkBoundsRef.current = bounds
      ? { left: Math.min(bounds.left, x), top: Math.min(bounds.top, y), right: Math.max(bounds.right, x), bottom: Math.max(bounds.bottom, y) }
      : { left: x, top: y, right: x, bottom: y };
  };

  const begin = (event: PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drawingRef.current = true;
    const point = pointFor(event);
    lastPointRef.current = point;
    makeDot(event.currentTarget, point);
    includeInInkBounds(event.currentTarget, point);
    hasInkRef.current = true;
    setHasInk(true);
    if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    if (resultTimerRef.current) window.clearTimeout(resultTimerRef.current);
    setInkState("rest");
    setOutcome(null);
    setPendingTranscription(null);
    setSystemNote(null);
    setShowTrace(false);
    setIsCollected(false);
  };

  const draw = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || !lastPointRef.current) return;
    const context = event.currentTarget.getContext("2d");
    if (!context) return;
    const next = pointFor(event);
    context.beginPath();
    context.moveTo(lastPointRef.current.x, lastPointRef.current.y);
    context.lineTo(next.x, next.y);
    context.stroke();
    includeInInkBounds(event.currentTarget, next);
    lastPointRef.current = next;
  };

  const captureInk = (): InkImage | null => {
    const canvas = canvasRef.current;
    const bounds = inkBoundsRef.current;
    const rect = canvas?.getBoundingClientRect();
    if (!canvas || !hasInkRef.current || !bounds || !rect?.width || !rect.height) return null;
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const left = Math.max(0, Math.floor(bounds.left * canvas.width - INK_CAPTURE_PADDING * scaleX));
    const top = Math.max(0, Math.floor(bounds.top * canvas.height - INK_CAPTURE_PADDING * scaleY));
    const right = Math.min(canvas.width, Math.ceil(bounds.right * canvas.width + INK_CAPTURE_PADDING * scaleX));
    const bottom = Math.min(canvas.height, Math.ceil(bounds.bottom * canvas.height + INK_CAPTURE_PADDING * scaleY));
    const crop = document.createElement("canvas");
    crop.width = Math.max(1, right - left);
    crop.height = Math.max(1, bottom - top);
    crop.getContext("2d")?.drawImage(canvas, left, top, crop.width, crop.height, 0, 0, crop.width, crop.height);
    return { data: crop.toDataURL("image/png"), mimeType: "image/png" };
  };

  const requestTranscription = async (image: InkImage) => {
    try {
      const result = await postJson("/api/transcribe", { image });
      if (result.status === "ok" && result.transcription?.text) {
        setPendingTranscription({ image, text: result.transcription.text, candidates: result.transcription.candidates ?? [], isFixture: result.providerStatus === "fixture" });
      } else {
        setSystemNote(unavailableMessage(result.status, "转写"));
      }
    } catch {
      setSystemNote("转写服务暂不可达；这页笔迹已保留。");
    } finally {
      setInkState("ready");
    }
  };

  const confirmTranscription = async () => {
    if (!pendingTranscription?.text.trim()) return;
    setInkState("reading");
    setSystemNote(null);
    try {
      const result = await postJson("/api/seek", { transcription: pendingTranscription.text, image: pendingTranscription.image });
      if (result.status === "ok" && result.outcome) {
        setOutcome(result.outcome);
        setPendingTranscription(null);
      } else {
        setSystemNote(unavailableMessage(result.status, "寻迹"));
      }
    } catch {
      setSystemNote("寻迹服务暂不可达；原始笔迹与确认转写均已保留。");
    } finally {
      setInkState("ready");
    }
  };

  const beginSeeking = () => {
    setInkState("awakening");
    idleTimerRef.current = window.setTimeout(() => setInkState("reading"), 460);
    const demoCase = getDemoCase();
    if (demoCase) {
      resultTimerRef.current = window.setTimeout(() => {
        setOutcome(makeDemoOutcome(demoCase));
        setInkState("ready");
      }, 1150);
      return;
    }
    const image = captureInk();
    if (!image) {
      setInkState("ready");
      setSystemNote("这页还没有可供转写的笔迹。");
      return;
    }
    // Keep the local awakening legible before any service response can replace it.
    resultTimerRef.current = window.setTimeout(() => void requestTranscription(image), 480);
  };

  const finish = () => {
    drawingRef.current = false;
    lastPointRef.current = null;
    if (mode === "seek" && hasInkRef.current) {
      // No network work occurs before this local response is visible.
      idleTimerRef.current = window.setTimeout(beginSeeking, 280);
    }
  };

  const newPage = () => {
    rememberPage();
    setPages((current) => [...current, { ink: null, inkBounds: null, outcome: null, isCollected: false, transcription: null }]);
    setPageIndex((current) => current + 1);
    restoreInk(null);
    hasInkRef.current = false;
    inkBoundsRef.current = null;
    setHasInk(false);
    setInkState("rest");
    setOutcome(null);
    setPendingTranscription(null);
    setSystemNote(null);
    setIsCollected(false);
    setShowTrace(false);
  };

  const turnPage = (nextIndex: number) => {
    if (nextIndex < 0 || nextIndex >= pages.length || nextIndex === pageIndex) return;
    rememberPage();
    const next = pages[nextIndex];
    hasInkRef.current = Boolean(next.ink);
    inkBoundsRef.current = next.inkBounds;
    setHasInk(Boolean(next.ink));
    setOutcome(next.outcome);
    setPendingTranscription(next.transcription);
    setSystemNote(null);
    setIsCollected(next.isCollected);
    setShowTrace(false);
    setInkState(next.outcome ? "ready" : "rest");
    setPageIndex(nextIndex);
    restoreInk(next.ink);
  };

  const prompt = mode === "seek"
    ? "写下一段与人物、诗句或地点有关的念头。停笔后，书页会为你寻迹。"
    : "静读中：这页只记录你的笔迹。";

  return <main className="book-shell">
    <header className="book-spine">
      <div className="title-mark">时空探索手札</div>
      <button className="mode-toggle" onClick={() => setMode((current) => current === "seek" ? "quiet" : "seek")} aria-pressed={mode === "seek"}>
        {mode === "seek" ? "寻迹" : "静读"}
      </button>
    </header>
    <section className={`paper ink-${inkState} ${isCollected ? "is-collected" : ""}`} aria-label="可书写纸页">
      <div className="paper-grain" />
      <div className="page-number">札记 · {String(pageIndex + 1).padStart(2, "0")}</div>
      <p className="quiet-note">{prompt}</p>
      {outcome && !isCollected && <div className="relation-trail" aria-hidden="true"><i /><i /><i /></div>}
      <canvas ref={canvasRef} className="ink-canvas" onPointerDown={begin} onPointerMove={draw} onPointerUp={finish} onPointerCancel={finish} />
      {(inkState === "awakening" || inkState === "reading") && <aside className="awakening" aria-live="polite"><span className="ink-orb" />{inkState === "awakening" ? "识字中" : "寻人地 · 核对出处"}</aside>}
      {pendingTranscription && !outcome && <TranscriptionNote transcription={pendingTranscription} onChange={(text) => setPendingTranscription((current) => current ? { ...current, text } : current)} onChoose={(text) => setPendingTranscription((current) => current ? { ...current, text } : current)} onConfirm={confirmTranscription} />}
      {systemNote && !outcome && <aside className="margin-note service-note"><span className="note-seal">记</span><p>{systemNote}</p></aside>}
      {outcome && <MarginNotes outcome={outcome} showTrace={showTrace} onTrace={() => setShowTrace((shown) => !shown)} />}
      {outcome && <button className="stamp" onClick={() => setIsCollected((value) => !value)} aria-label={isCollected ? "展开寻迹" : "收为页边印章"}>{isCollected ? "寻" : "收为印"}</button>}
      <nav className="page-turns" aria-label="翻页"><button onClick={() => turnPage(pageIndex - 1)} disabled={pageIndex === 0}>前页</button><span>{pageIndex + 1} / {pages.length}</span><button onClick={() => turnPage(pageIndex + 1)} disabled={pageIndex === pages.length - 1}>后页</button></nav>
      <button className="new-page-mark" onClick={newPage} aria-label="新建一页札记">新页</button>
    </section>
  </main>;
}

function MarginNotes({ outcome, showTrace, onTrace }: { outcome: TraceOutcome; showTrace: boolean; onTrace: () => void }) {
  if (outcome.kind === "ambiguous") {
    return <aside className="margin-note clarification"><span className="note-seal">问</span><p>{outcome.clarification}</p><div className="candidate-row">{outcome.candidates.map((candidate) => <button key={candidate}>{candidate}</button>)}</div><small>转写：{outcome.transcription}</small></aside>;
  }
  if (outcome.kind === "gap") {
    return <aside className="margin-notes"><div className="margin-note gap"><span className="note-seal">缺</span><p>{outcome.gap}</p><small>转写：{outcome.transcription}</small></div><div className="margin-note association"><span className="note-seal">联想</span><p>{outcome.association}</p></div></aside>;
  }
  return <aside className="margin-notes"><button className="margin-note evidence" onClick={onTrace}><span className="note-seal">据</span><p>{outcome.evidence}</p><small>转写：{outcome.transcription}</small><em>点按展开寻迹</em></button>{outcome.association && <div className="margin-note association"><span className="note-seal">联想</span><p>{outcome.association}</p></div>}{showTrace && <section className="trace-card"><strong>寻迹卡</strong><p>识别：{outcome.path.join(" → ")}；已核对夹具中的有界来源。</p><ol>{outcome.path.map((node) => <li key={node}>{node}</li>)}</ol>{outcome.source.map((source) => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.label}</a>)}</section>}</aside>;
}

function TranscriptionNote({ transcription, onChange, onChoose, onConfirm }: { transcription: PendingTranscription; onChange: (text: string) => void; onChoose: (text: string) => void; onConfirm: () => void }) {
  const label = transcription.isFixture ? "演练转写（未调用视觉模型），请在纸页边确认：" : "机器转写，请在纸页边确认：";
  return <aside className="margin-note transcription-note"><span className="note-seal">识</span><p>{label}</p><div className="transcription-edit" contentEditable suppressContentEditableWarning role="textbox" aria-label="可编辑机器转写" onInput={(event) => onChange(event.currentTarget.textContent ?? "")}>{transcription.text}</div>{transcription.candidates.length > 0 && <div className="candidate-row" aria-label="候选转写"><span>候选：</span>{transcription.candidates.map((candidate) => <button key={candidate} type="button" onClick={() => onChoose(candidate)}>{candidate}</button>)}</div>}<button onClick={onConfirm}>以此寻迹</button></aside>;
}

createRoot(document.getElementById("root")!).render(<Notebook />);
