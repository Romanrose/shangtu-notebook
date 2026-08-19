export type DemoCase = "evidence" | "ambiguous" | "gap";
export type DemoJourneyRoute = "life" | "space" | "work";
export type SourceReference = { label: string; url: string };

export type TraceOutcome =
  | {
      kind: "evidence";
      transcription: string;
      evidence: string;
      association: string | null;
      source: SourceReference[];
      path: string[];
      places?: string[];
      timeline?: Array<{ year: number; label: string }>;
      timeHints?: string[];
    }
  | {
      kind: "ambiguous";
      transcription: string;
      clarification: string;
      candidates: string[];
    }
  | {
      kind: "gap";
      transcription: string;
      gap: string;
      association: string | null;
    };

/**
 * A deliberately explicit, offline demonstration adapter. It is only a
 * fallback for rehearsing the three required states before a vision model and
 * Pi model are configured. The UI marks its non-evidence content as 联想 and
 * never creates a pretend source.
 */
export function getDemoCase(): DemoCase | null {
  const candidate = new URLSearchParams(window.location.search).get("demo");
  if (candidate === "ambiguous" || candidate === "gap" || candidate === "evidence") return candidate;
  return null;
}

export function isJourneyDemo() {
  return new URLSearchParams(window.location.search).get("demo") === "journey";
}

export function makeDemoJourneyOutcome(route: DemoJourneyRoute): TraceOutcome {
  if (route === "work") {
    return {
      kind: "evidence",
      transcription: "前赤壁赋",
      evidence: "演练档案记录：苏轼的《前赤壁赋》中记有赤壁。",
      association: null,
      source: [{ label: "演练固定来源 · 前赤壁赋", url: "https://zh.wikisource.org/wiki/%E5%89%8D%E8%B5%A4%E5%A3%81%E8%B3%A6" }],
      path: ["苏轼", "作者", "前赤壁赋", "记有", "赤壁"],
      places: ["赤壁"],
      timeline: [{ year: 1082, label: "苏轼 → 前赤壁赋" }],
    };
  }
  if (route === "life") {
    return {
      kind: "evidence",
      transcription: "黄州时期",
      evidence: "演练档案记录：黄州时期被作为苏轼人生路线中的一段经历。",
      association: null,
      source: [{ label: "演练固定来源 · 苏轼人物档案", url: "https://zh.wikisource.org/wiki/%E8%98%87%E8%BB%BE" }],
      path: ["苏轼", "经历", "黄州时期", "路线词", "转折"],
      places: ["黄州"],
      timeHints: ["五載"],
    };
  }
  return {
    kind: "evidence",
    transcription: "黄州",
    evidence: "演练档案记录：苏轼曾以黄州作为人物行旅线索。",
    association: null,
    source: [{ label: "演练固定来源 · 苏轼黄州路线", url: "https://zh.wikisource.org/wiki/%E5%BF%B5%E5%A5%B4%E5%AC%8C%C2%B7%E8%B5%A4%E5%A3%81%E6%80%80%E5%8F%A4" }],
    path: ["苏轼", "行旅", "黄州", "时间词", "五載"],
    places: ["黄州"],
    timeHints: ["五載"],
  };
}

export function makeDemoOutcome(kind: DemoCase): TraceOutcome {
  if (kind === "ambiguous") {
    return {
      kind,
      transcription: "苏轼在黄州写了什么",
      clarification: "这一笔像“苏轼”，也可能是“苏辙”。你想寻哪一位？",
      candidates: ["苏轼", "苏辙"],
    };
  }

  if (kind === "gap") {
    return {
      kind,
      transcription: "苏轼与未署名古画有什么关联？",
      gap: "我暂未在当前可核验的图谱记录中找到这条直接关联。",
      association: "联想：可以补一处题跋、地点或作品名，我再为你缩小寻迹范围。",
    };
  }

  return {
    kind,
    transcription: "苏轼与赤壁有什么关联？",
    evidence: "固定文献记录：苏轼于1082年作《前赤壁赋》，文中记有赤壁。",
    association: "联想：沿着赤壁这一页，也许能继续写下山水如何改变苏轼的阅读与表达。",
    source: [{
      label: "维基文库《前赤壁赋》固定版本 · 苏轼时空演示夹具",
      url: "https://zh.wikisource.org/w/index.php?title=%E5%89%8D%E8%B5%A4%E5%A3%81%E8%B3%A6&oldid=7908010",
    }],
    path: ["苏轼", "于1082年作", "前赤壁赋", "记有", "赤壁"],
  };
}

/** Resolve the offline ambiguity rehearsal without touching real services. */
export function makeDemoCandidateOutcome(candidate: string): TraceOutcome {
  if (candidate === "苏轼") {
    const evidence = makeDemoOutcome("evidence");
    return { ...evidence, transcription: candidate };
  }
  return {
    kind: "gap",
    transcription: candidate,
    gap: "当前演练图谱没有这位人物的可核验路径。",
    association: "联想：可以补充作品名或地点，再继续缩小寻迹范围。",
  };
}
