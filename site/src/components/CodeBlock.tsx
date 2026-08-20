import { useEffect, useState } from "react";
import { tokensFor, type ColoredLine } from "../lib/shiki";
import { MermaidDiagram } from "./MermaidDiagram";

// 把 react-markdown 的 code 元素渲染成 Shiki 高亮块 / 普通 <pre> / mermaid 占位。
// 判定 block：有 language- 类名 或 内容跨行；否则按行内 code 处理。
// 高亮采用逐行 token + 深/浅双色 CSS 变量，与 AnnotatedSource 共用，主题切换即生效。

const SHIKI_LANG: Record<string, "typescript" | "diff"> = {
  typescript: "typescript",
  ts: "typescript",
  diff: "diff",
};

interface Props {
  className?: string;
  children?: React.ReactNode;
}

export function CodeBlock({ className, children }: Props) {
  const code = String(children ?? "").replace(/\n$/, "");
  const isBlock = /language-/.test(className || "") || code.includes("\n");
  const langMatch = /language-(\w+)/.exec(className || "");
  const lang = langMatch ? langMatch[1] : "";

  // 行内代码
  if (!isBlock) {
    return <code className="inline-code">{children}</code>;
  }

  // mermaid 图：懒加载 mermaid 渲染成 SVG
  if (lang === "mermaid") {
    return <MermaidDiagram source={code} />;
  }

  const shikiLang = SHIKI_LANG[lang];
  if (!shikiLang) {
    // bash / json / 纯文本：不高亮
    return <pre className="code-plain">{code}</pre>;
  }

  return <ShikiBlock code={code} lang={shikiLang} />;
}

function ShikiBlock({ code, lang }: { code: string; lang: "typescript" | "diff" }) {
  const [lines, setLines] = useState<ColoredLine[] | null>(null);
  useEffect(() => {
    let alive = true;
    tokensFor(code, lang).then((l) => {
      if (alive) setLines(l);
    });
    return () => {
      alive = false;
    };
  }, [code, lang]);

  if (!lines) return <pre className="code-plain code-loading">{code}</pre>;
  return (
    <pre className="code-block">
      <code>
        {lines.map((toks, i) => (
          <div className="cb-line" key={i}>
            {toks.length === 0
              ? "\u00A0"
              : toks.map((t, j) => (
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
                ))}
          </div>
        ))}
      </code>
    </pre>
  );
}
