import type { ChapterFile } from "../types";

interface Props {
  file: ChapterFile;
  chapterNumber: number;
}

interface DiffLine {
  type: "add" | "del" | "ctx" | "hunk" | "blank";
  text: string;
}

function parseDiff(diff: string): DiffLine[] {
  return diff.split("\n").map((raw) => {
    if (raw === "") return { type: "blank", text: "" };
    if (/^@@/.test(raw)) return { type: "hunk", text: raw };
    if (/^\+\+\+/.test(raw) || /^---/.test(raw)) return { type: "ctx", text: raw };
    if (raw[0] === "+") return { type: "add", text: raw.slice(1) };
    if (raw[0] === "-") return { type: "del", text: raw.slice(1) };
    if (raw[0] === " ") return { type: "ctx", text: raw.slice(1) };
    return { type: "ctx", text: raw };
  });
}

// 本章新增 diff 视图：按行着色（增/删/上下文/hunk）。
// 深入的逐行学习请在「逐行注解」标签里进行——这里聚焦"这章改了什么结构"。
export function DiffTab({ file, chapterNumber }: Props) {
  if (!file.diff.trim()) {
    return (
      <div className="diff-empty">
        <code>{file.name}</code> 在第 {chapterNumber} 章没有变化（相对上一章）。
      </div>
    );
  }
  const lines = parseDiff(file.diff);
  const adds = lines.filter((l) => l.type === "add").length;
  const dels = lines.filter((l) => l.type === "del").length;

  return (
    <div className="diff">
      <div className="annot-meta">
        <span className="file-pill">{file.name}</span>
        <span className="diff-stats">
          <span className="add-n">+{adds}</span>{" "}
          <span className="del-n">-{dels}</span>
        </span>
      </div>
      <pre className="diff-pre">
        {lines.map((l, i) => (
          <div className={`diff-line diff-${l.type}`} key={i}>
            <span className="diff-sign">
              {l.type === "add" ? "+" : l.type === "del" ? "-" : " "}
            </span>
            <span className="diff-text">{l.text || "\u00A0"}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}
