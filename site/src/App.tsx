"use client";

import { useEffect, useMemo, useState } from "react";
import meta from "./meta.json";
import type { Chapter, SiteMeta } from "./types";
import { useHashRoute } from "./lib/useHashRoute";
import { useChapterDetail } from "./lib/useChapterDetail";
import {
  loadProgress,
  toggleProgress,
  loadTheme,
  saveTheme,
  saveLast,
  type Theme,
} from "./lib/storage";
import { Sidebar } from "./components/Sidebar";
import { Overview } from "./components/Overview";
import { ChapterView } from "./components/ChapterView";

const site = meta as unknown as SiteMeta;

export default function App() {
  const [route, navigate] = useHashRoute();
  const [done, setDone] = useState<Set<string>>(() => loadProgress());
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    saveTheme(theme);
  }, [theme]);

  useEffect(() => {
    setSidebarOpen(false);
  }, [route]);

  const currentMeta = useMemo(() => {
    if (route.name !== "chapter") return null;
    return site.chapters.find((c) => c.id === route.id) ?? null;
  }, [route]);

  // 懒加载当前章节详情（按章 chunk，访问后缓存）
  const { detail, loading } = useChapterDetail(
    route.name === "chapter" ? route.id : null
  );

  useEffect(() => {
    if (route.name === "chapter") saveLast(route.id);
  }, [route]);

  // 找不到章节 → 回首页
  useEffect(() => {
    if (route.name === "chapter" && !currentMeta) {
      navigate({ name: "overview" });
    }
  }, [route, currentMeta, navigate]);

  const ordered = site.chapters;
  const prevId = useMemo(() => {
    if (!currentMeta) return null;
    const i = ordered.findIndex((c) => c.id === currentMeta.id);
    return i > 0 ? ordered[i - 1].id : null;
  }, [currentMeta]);
  const nextId = useMemo(() => {
    if (!currentMeta) return null;
    const i = ordered.findIndex((c) => c.id === currentMeta.id);
    return i >= 0 && i < ordered.length - 1 ? ordered[i + 1].id : null;
  }, [currentMeta]);

  // 合并 meta + detail 成完整 Chapter
  const fullChapter: Chapter | null =
    currentMeta && detail
      ? { ...currentMeta, bodyMarkdown: detail.bodyMarkdown, transcripts: detail.transcripts, files: detail.files }
      : null;

  return (
    <div className="layout">
      <button
        className="menu-btn"
        onClick={() => setSidebarOpen((o) => !o)}
        aria-label="菜单"
      >
        ☰
      </button>
      <div
        className={`overlay ${sidebarOpen ? "show" : ""}`}
        onClick={() => setSidebarOpen(false)}
      />
      <Sidebar
        chapters={site.chapters}
        route={route}
        navigate={navigate}
        done={done}
        onToggleDone={(id) => setDone((d) => toggleProgress(d, id))}
        onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        theme={theme}
        open={sidebarOpen}
      />
      <main className="main">
        {route.name === "overview" || !currentMeta ? (
          <Overview chapters={site.chapters} navigate={navigate} done={done} />
        ) : !fullChapter || loading ? (
          <div className="loading">正在加载第 {currentMeta.number} 章…</div>
        ) : (
          <ChapterView
            chapter={fullChapter}
            isDone={done.has(currentMeta.id)}
            onToggleDone={() => setDone((d) => toggleProgress(d, currentMeta.id))}
            onNavigate={(id) => navigate({ name: "chapter", id })}
            prevId={prevId}
            nextId={nextId}
          />
        )}
      </main>
    </div>
  );
}
