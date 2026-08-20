import { useEffect, useState } from "react";
import type { ChapterDetail } from "../types";

// 用 import.meta.glob 收集所有按章拆分的详情文件，按需懒加载（Vite 会把每个
// ./data/<id>.json 拆成独立 chunk）。访问过的章节缓存在内存，二次进入即时返回。
const loaders = import.meta.glob("../data/*.json") as Record<
  string,
  () => Promise<{ default: ChapterDetail }>
>;

const cache = new Map<string, ChapterDetail>();

export function useChapterDetail(id: string | null) {
  const [detail, setDetail] = useState<ChapterDetail | null>(() =>
    id ? cache.get(id) ?? null : null
  );
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!id) {
      setDetail(null);
      return;
    }
    if (cache.has(id)) {
      setDetail(cache.get(id)!);
      return;
    }
    const key = `../data/${id}.json`;
    const load = loaders[key];
    if (!load) {
      setDetail(null);
      return;
    }
    setLoading(true);
    let alive = true;
    load().then((m) => {
      if (!alive) return;
      cache.set(id, m.default);
      setDetail(m.default);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [id]);

  return { detail, loading };
}
