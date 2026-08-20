import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";

interface Props {
  markdown: string;
}

// 去掉正文顶部的 "## 本章目标" 段（章节头已单独展示 goals，避免重复）。
function stripGoals(md: string): string {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => /^##\s+本章目标/.test(l));
  if (start === -1) return md;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(0, start).concat(lines.slice(end)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function ConceptTab({ markdown }: Props) {
  const body = useMemo(() => stripGoals(markdown), [markdown]);
  return (
    <div className="concept prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <>{children}</>,
          code: (props) => <CodeBlock {...props} />,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
