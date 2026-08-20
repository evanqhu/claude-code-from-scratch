import { useEffect, useState } from "react";
import type { ChapterFile } from "../types";
import { tokensFor, type ColoredLine } from "../lib/shiki";

interface Props {
  file: ChapterFile;
  chapterNumber: number;
}

// 双栏逐行注解视图：左栏代码（Shiki 逐行高亮 + 行号），右栏紧贴上方的注释。
// 这是"每一行在干什么"的主场。
export function AnnotatedSource({ file, chapterNumber }: Props) {
  const [lines, setLines] = useState<ColoredLine[] | null>(null);

  useEffect(() => {
    let alive = true;
    setLines(null);
    tokensFor(file.fullSource, "typescript").then((l) => {
      if (alive) setLines(l);
    });
    return () => {
      alive = false;
    };
  }, [file.name, file.fullSource]);

  if (!lines) {
    return <div className="annot-loading">正在高亮 {file.name} …</div>;
  }

  const totalLines = file.fullSource.split("\n").length;
  const withComment = file.annotations.filter((a) => a.comment).length;

  return (
    <div className="annot">
      <div className="annot-meta">
        <span className="file-pill">{file.name}</span>
        <span className="annot-stats">
          {totalLines} 行 · {file.annotations.length} 个代码块 ·{" "}
          {withComment} 处带注释
        </span>
        <a
          className="src-ref"
          href={`https://github.com/Windy3f3f3f3f/claude-code-from-scratch/blob/main/${file.srcRef}`}
          target="_blank"
          rel="noreferrer"
          title="查看生产版完整实现"
        >
          生产版 {file.srcRef} ↗
        </a>
      </div>

      <div className="annot-rows">
        {file.annotations.map((unit, idx) => {
          return (
            <div
              className={`annot-row ${unit.comment ? "has-note" : "no-note"}`}
              key={`${unit.lineNo}-${idx}`}
            >
              <div className="annot-code">
                {unit.code.map((_, i) => {
                  const lineIdx = unit.lineNo + i - 1; // 0-based 对应 lines 数组
                  const toks = lines[lineIdx] || [];
                  return (
                    <div className="code-line" key={lineIdx}>
                      <span className="ln">{unit.lineNo + i}</span>
                      <span className="lc">
                        {toks.length === 0 ? (
                          "\u00A0"
                        ) : (
                          toks.map((t, j) => (
                            <span
                              className="tok"
                              key={j}
                              style={
                                {
                                  ["--c-dk"]: t.colorDark || "inherit",
                                  ["--c-lt"]: t.colorLight || "inherit",
                                } as React.CSSProperties
                              }
                            >
                              {t.content}
                            </span>
                          ))
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
              <div className="annot-note">
                {unit.comment ? (
                  unit.comment.split("\n").map((line, k) => (
                    <p key={k}>{line}</p>
                  ))
                ) : (
                  <span className="annot-note-empty">—</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="annot-foot">
        注：以上为第 {chapterNumber} 章结束时该文件的完整快照（来自
        steps/canonical，标记已剥离）。
      </div>
    </div>
  );
}
