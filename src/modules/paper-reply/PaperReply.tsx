import { useEffect, useMemo, useState } from "react";
import type { TraceOutcome } from "../../demo-agent";

type Anchor = { left: number; top: number; right: number; bottom: number };

function replyText(outcome: TraceOutcome) {
  if (outcome.kind === "evidence") return outcome.evidence;
  if (outcome.kind === "ambiguous") return outcome.clarification;
  return outcome.gap;
}

function replySeal(outcome: TraceOutcome) {
  if (outcome.kind === "evidence") return "据";
  if (outcome.kind === "ambiguous") return "问";
  return "缺";
}

export function PaperReply({ outcome, anchor, index }: { outcome: TraceOutcome; anchor: Anchor; index: number }) {
  const text = replyText(outcome);
  const characters = useMemo(() => Array.from(text), [text]);
  const [visibleCount, setVisibleCount] = useState(0);

  useEffect(() => {
    let next = 0;
    setVisibleCount(0);
    let timer = window.setTimeout(reveal, 260);

    function reveal() {
      next += 1;
      setVisibleCount(next);
      if (next >= characters.length) return;
      const previous = characters[next - 1];
      const pause = /[，、；：]/.test(previous) ? 130 : /[。！？]/.test(previous) ? 280 : 48;
      timer = window.setTimeout(reveal, pause);
    }

    return () => window.clearTimeout(timer);
  }, [characters]);

  const style = {
    left: `${Math.max(10, Math.min(54, anchor.left * 100))}%`,
    top: `${Math.max(31, Math.min(74, anchor.bottom * 100 + 5 + (index % 2) * 4))}%`,
  };
  const complete = visibleCount >= characters.length;

  return <p className="paper-reply" style={style} aria-hidden="true">
    <span className="paper-reply-seal">{replySeal(outcome)}</span>
    <span>{characters.slice(0, visibleCount).join("")}</span>
    {!complete && <span className="paper-reply-caret" />}
  </p>;
}
