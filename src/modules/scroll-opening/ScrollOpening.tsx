import { useEffect, useState } from "react";

const OPENING_DURATION_MS = 1_400;

export function ScrollOpening() {
  // The opening is a required part of entering the notebook, regardless of host motion preferences.
  const [isVisible, setIsVisible] = useState(true);
  const dismiss = () => setIsVisible(false);

  useEffect(() => {
    if (!isVisible) return;

    const timer = window.setTimeout(() => setIsVisible(false), OPENING_DURATION_MS);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsVisible(false);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isVisible]);

  if (!isVisible) return null;

  return <div className="scroll-opening" role="dialog" aria-modal="true" aria-label="时空探索手札启卷" onPointerDown={dismiss}>
    <div className="scroll-opening-scroll" aria-hidden="true">
      <div className="scroll-opening-sheet">
        <span className="scroll-opening-cloud scroll-opening-cloud-left" />
        <span className="scroll-opening-cloud scroll-opening-cloud-right" />
        <div className="scroll-opening-inscription">
          <span className="scroll-opening-kicker">以笔为引 · 由此入卷</span>
          <strong>时空探索手札</strong>
          <span className="scroll-opening-seal">札</span>
        </div>
      </div>
      <span className="scroll-opening-roller scroll-opening-roller-left" />
      <span className="scroll-opening-roller scroll-opening-roller-right" />
    </div>
    <button className="scroll-opening-skip" type="button" onClick={dismiss}>轻触略过</button>
  </div>;
}
