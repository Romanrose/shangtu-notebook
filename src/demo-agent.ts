export type DemoCase = "evidence" | "ambiguous" | "gap";
export type SourceReference = { label: string; url: string };

export type TraceOutcome =
  | {
      kind: "evidence";
      transcription: string;
      evidence: string;
      association: string | null;
      source: SourceReference[];
      path: string[];
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
      association: string;
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

export function makeDemoOutcome(kind: DemoCase): TraceOutcome {
  if (kind === "ambiguous") {
    return {
      kind,
      transcription: "我想知道李贺和长安有什么关联",
      clarification: "这一笔像“李贺”，也可能是“李白”。你想寻哪一位？",
      candidates: ["李贺", "李白"],
    };
  }

  if (kind === "gap") {
    return {
      kind,
      transcription: "珊瑚与唐诗有什么关联？",
      gap: "我暂未在当前可核验的图谱记录中找到这条直接关联。",
      association: "联想：可以从“海物意象”或具体诗句继续写，我再为你缩小寻迹范围。",
    };
  }

  return {
    kind,
    transcription: "李白写过《将进酒》吗？",
    evidence: "当前图谱夹具记录：李白是《将进酒》的作者。",
    association: "联想：把“长安”当作阅读线索，也许能从仕进理想与行旅视角再读这些诗。",
    source: [{
      label: "维基文库《将进酒（李白）》固定版本 · CNKGraph 演示夹具",
      url: "https://zh.wikisource.org/w/index.php?title=%E5%B0%87%E9%80%B2%E9%85%92_(%E6%9D%8E%E7%99%BD)&oldid=5977390",
    }],
    path: ["李白", "作者", "将进酒"],
  };
}
