// 学习进度持久化（localStorage）+ 主题持久化
const PROGRESS_KEY = "mc:progress:v1"; // 已完成章节 id 集合
const THEME_KEY = "mc:theme"; // "dark" | "light"
const LAST_KEY = "mc:last"; // 上次访问的章节 id

export type Theme = "dark" | "light";

export function loadProgress(): Set<string> {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function saveProgress(done: Set<string>) {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify([...done]));
  } catch {
    /* ignore */
  }
}

export function toggleProgress(done: Set<string>, id: string): Set<string> {
  const next = new Set(done);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  saveProgress(next);
  return next;
}

export function loadTheme(): Theme {
  const t = (typeof localStorage !== "undefined" && localStorage.getItem(THEME_KEY)) as Theme | null;
  return t === "light" ? "light" : "dark";
}

export function saveTheme(t: Theme) {
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* ignore */
  }
}

export function loadLast(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

export function saveLast(id: string) {
  try {
    localStorage.setItem(LAST_KEY, id);
  } catch {
    /* ignore */
  }
}
