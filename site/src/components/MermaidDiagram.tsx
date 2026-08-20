import { useEffect, useRef, useState } from "react";

interface Props {
  source: string;
}

// 把 mermaid 源码渲染成 SVG。mermaid 很大（~1MB），用动态 import 懒加载，
// 只有真正遇到 mermaid 图时才下载。主题随站点深/浅切换。
let _mermaidLoaded: Promise<typeof import("mermaid").default> | null = null;
let _currentTheme: "dark" | "light" = "dark";

async function loadMermaid(theme: "dark" | "light") {
  const mermaid = (await import("mermaid")).default;
  if (!_mermaidLoaded || _currentTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      theme: theme === "dark" ? "dark" : "default",
      securityLevel: "loose",
      fontFamily: "inherit",
    });
    _currentTheme = theme;
    _mermaidLoaded = Promise.resolve(mermaid);
  }
  return mermaid;
}

export function MermaidDiagram({ source }: Props) {
  const [svg, setSvg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const id = useRef(`mmd-${Math.random().toString(36).slice(2, 9)}`);
  const theme = (document.documentElement.getAttribute("data-theme") as "dark" | "light") || "dark";

  useEffect(() => {
    let alive = true;
    loadMermaid(theme)
      .then(async (m) => {
        try {
          const { svg: out } = await m.render(id.current, source);
          if (alive) setSvg(out);
        } catch (e: unknown) {
          if (alive) setErr((e as Error).message);
        }
      });
    return () => {
      alive = false;
    };
    // 主题变化时重渲染（依赖 theme 字符串）
  }, [source, theme]);

  if (err) {
    return (
      <div className="mermaid-placeholder">
        <div className="mermaid-tag">🖼 mermaid 图（渲染失败）</div>
        <pre className="code-plain">{source}</pre>
      </div>
    );
  }
  if (!svg) {
    return (
      <div className="mermaid-placeholder">
        <div className="mermaid-tag">渲染 mermaid 图中…</div>
      </div>
    );
  }
  return (
    <div
      className="mermaid-diagram"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
