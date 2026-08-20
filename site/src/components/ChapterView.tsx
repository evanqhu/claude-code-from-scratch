import { useEffect, useState } from "react";
import type { Chapter } from "../types";
import { ConceptTab } from "./ConceptTab";
import { AnnotatedSource } from "./AnnotatedSource";
import { DiffTab } from "./DiffTab";
import { RunBar } from "./RunBar";
import { CodeBlock } from "./CodeBlock";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Mode = "concept" | "annotated" | "diff";

interface Props {
  chapter: Chapter;
  isDone: boolean;
  onToggleDone: () => void;
  onNavigate: (id: string) => void;
  prevId: string | null;
  nextId: string | null;
}

// 选出本章变化最大的文件作为默认（无变化则取第一个）
function pickDefaultFile(chapter: Chapter): number {
  if (chapter.files.length === 0) return 0;
  let best = 0;
  let bestScore = -1;
  chapter.files.forEach((f, i) => {
    const score = f.diff.split("\n").filter((l) => l.startsWith("+")).length;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

export function ChapterView({
  chapter,
  isDone,
  onToggleDone,
  onNavigate,
  prevId,
  nextId,
}: Props) {
  const hasCode = chapter.files.length > 0;
  const [mode, setMode] = useState<Mode>(hasCode ? "annotated" : "concept");
  const [fileIdx, setFileIdx] = useState(() => pickDefaultFile(chapter));

  // 切换章节时重置模式与默认文件
  useEffect(() => {
    setMode(hasCode ? "annotated" : "concept");
    setFileIdx(pickDefaultFile(chapter));
    window.scrollTo({ top: 0 });
  }, [chapter.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const file = hasCode ? chapter.files[fileIdx] : null;

  const modes: { key: Mode; label: string; show: boolean }[] = [
    { key: "concept", label: "01  理解设计", show: true },
    { key: "annotated", label: "02  读懂源码", show: hasCode },
    { key: "diff", label: "03  查看增量", show: hasCode },
  ];

  return (
    <div className="chapter">
      <header className="ch-header">
        <div className="ch-eyebrow">
          <span className="phase-tag">CHAPTER {String(chapter.number).padStart(2, "0")} / {chapter.phase === "intro" ? "START HERE" : chapter.phase}</span>
          <button
            className={`mark-done ${isDone ? "done" : ""}`}
            onClick={onToggleDone}
          >
            {isDone ? "✓ 已完成" : "标记完成"}
          </button>
        </div>
        <h1 className="ch-title">
          <span className="ch-num">{chapter.number ? `${chapter.number}. ` : ""}</span>
          {chapter.title}
        </h1>

        {chapter.goals && (
          <div className="goals-card">
            <div className="goals-title"><span>LEARNING BRIEF</span> 本章完成后，你将理解</div>
            <div className="goals-body prose">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  pre: ({ children }) => <>{children}</>,
                  code: (props) => <CodeBlock {...props} />,
                }}
              >
                {chapter.goals}
              </ReactMarkdown>
            </div>
          </div>
        )}

        {chapter.runCommand && (
          <RunBar
            runCommand={chapter.runCommand}
            transcripts={chapter.transcripts}
          />
        )}
      </header>

      <div className="mode-tabs">
        {modes.filter((m) => m.show).map((m) => (
          <button
            key={m.key}
            className={`mode-tab ${mode === m.key ? "active" : ""}`}
            onClick={() => setMode(m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="ch-body">
        {mode !== "concept" && hasCode && (
          <div className="file-tabs">
            {chapter.files.map((f, i) => (
              <button
                key={f.name}
                className={`file-tab ${i === fileIdx ? "active" : ""}`}
                onClick={() => setFileIdx(i)}
              >
                {f.name}
              </button>
            ))}
          </div>
        )}

        {mode === "concept" && <ConceptTab markdown={chapter.bodyMarkdown} />}
        {mode === "annotated" && file && (
          <AnnotatedSource file={file} chapterNumber={chapter.number} />
        )}
        {mode === "diff" && file && (
          <DiffTab file={file} chapterNumber={chapter.number} />
        )}
      </div>

      <nav className="ch-pager">
        <button
          className="pager-btn"
          disabled={!prevId}
          onClick={() => prevId && onNavigate(prevId)}
        >
          ← 上一章
        </button>
        <button
          className="pager-btn"
          disabled={!nextId}
          onClick={() => nextId && onNavigate(nextId)}
        >
          下一章 →
        </button>
      </nav>
    </div>
  );
}
