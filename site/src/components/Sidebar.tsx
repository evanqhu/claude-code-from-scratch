import { useMemo } from "react";
import type { ChapterMeta } from "../types";
import type { Route } from "../lib/useHashRoute";

interface Props {
  chapters: ChapterMeta[];
  route: Route;
  navigate: (r: Route) => void;
  done: Set<string>;
  onToggleDone: (id: string) => void;
  onToggleTheme: () => void;
  theme: "dark" | "light";
  open?: boolean;
}

// 章节按 phase 分组的顺序
const PHASE_ORDER = [
  "intro",
  "Phase 1 · 构建可用的 Coding Agent",
  "Phase 2 · 进阶能力",
  "Phase 3 · 自主运行",
  "总结",
];
const PHASE_LABEL: Record<string, string> = {
  intro: "开始",
  "Phase 1 · 构建可用的 Coding Agent": "Phase 1 · 构建可用的 Coding Agent",
  "Phase 2 · 进阶能力": "Phase 2 · 进阶能力",
  "Phase 3 · 自主运行": "Phase 3 · 自主运行",
  总结: "总结",
};

export function Sidebar({
  chapters,
  route,
  navigate,
  done,
  onToggleDone,
  onToggleTheme,
  theme,
  open,
}: Props) {
  const groups = useMemo(() => {
    const map = new Map<string, ChapterMeta[]>();
    for (const c of chapters) {
      if (!map.has(c.phase)) map.set(c.phase, []);
      map.get(c.phase)!.push(c);
    }
    return PHASE_ORDER.filter((p) => map.has(p)).map((p) => ({
      phase: p,
      items: map.get(p)!,
    }));
  }, [chapters]);

  const totalCode = chapters.filter((c) => c.hasCode).length;
  const doneCode = chapters.filter((c) => c.hasCode && done.has(c.id)).length;
  const pct = totalCode ? Math.round((doneCode / totalCode) * 100) : 0;

  return (
    <aside className={`sidebar ${open ? "open" : ""}`}>
      <div className="sidebar-head">
        <button
          className="brand"
          onClick={() => navigate({ name: "overview" })}
          title="返回首页"
        >
          <span className="brand-mark">CC</span>
          <span>FROM SCRATCH<small>源码学习实验室</small></span>
        </button>
        <button
          className="theme-btn"
          onClick={onToggleTheme}
          title="切换深/浅色"
        >
          {theme === "dark" ? "LIGHT" : "DARK"}
        </button>
      </div>

      <div className="progress-wrap" title={`已完成 ${doneCode}/${totalCode} 个代码章`}>
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="progress-text">
          {doneCode}/{totalCode} 章
        </span>
      </div>

      <nav className="nav-groups">
        {groups.map((g) => (
          <div className="nav-group" key={g.phase}>
            <div className="nav-phase">{PHASE_LABEL[g.phase]}</div>
            {g.items.map((c) => {
              const active =
                route.name === "chapter" && route.id === c.id;
              const isDone = done.has(c.id);
              return (
                <div
                  key={c.id}
                  className={`nav-item ${active ? "active" : ""}`}
                >
                  <button
                    className="nav-link"
                    onClick={() => navigate({ name: "chapter", id: c.id })}
                  >
                    <span className="nav-num">{c.id}</span>
                    <span className="nav-title">{c.title}</span>
                    {c.hasCode && c.fileNames.length > 0 && (
                      <span className="nav-badge">{c.fileNames.length}</span>
                    )}
                  </button>
                  <button
                    className={`check ${isDone ? "checked" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleDone(c.id);
                    }}
                    title={isDone ? "标记为未完成" : "标记为已完成"}
                  >
                    {isDone ? "✓" : ""}
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="sidebar-foot">
        <span className="sidebar-edition">COURSE EDITION / 2026</span>
        <a
          className="repo-link"
          href="https://github.com/Windy3f3f3f3f/claude-code-from-scratch"
          target="_blank"
          rel="noreferrer"
        >
          项目仓库 ↗
        </a>
      </div>
    </aside>
  );
}
