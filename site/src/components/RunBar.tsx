import { useState } from "react";
import type { Transcript } from "../types";

interface Props {
  runCommand: string;
  transcripts: Transcript[];
}

// 跑这一章：展示可复制的运行命令 + 折叠的预录 transcript（确定性 mock 输出）。
// 说明：agent 需要 Node fs/子进程/API，无法在浏览器内真跑；这里展示等价的预录输出。
export function RunBar({ runCommand, transcripts }: Props) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard?.writeText(runCommand).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="runbar">
      <div className="runbar-row">
        <span className="runbar-label">RUN / 无需 API KEY</span>
        <code className="runbar-cmd">{runCommand}</code>
        <button className="runbar-copy" onClick={copy}>
          {copied ? "已复制 ✓" : "复制命令"}
        </button>
        {transcripts.length > 0 && (
          <button
            className="runbar-toggle"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "收起输出 ▲" : "查看运行输出 ▼"}
          </button>
        )}
      </div>
      {open && transcripts.length > 0 && (
        <div className="runbar-transcripts">
          <div className="runbar-hint">
            以下是该命令的预录输出（本地 mock 模型回放，确定性，无需联网）：
          </div>
          {transcripts.map((t, i) => (
            <pre className="runbar-output" key={i}>
              <span className="runbar-cmd-line">{t.command}</span>
              {"\n"}
              {t.output}
            </pre>
          ))}
        </div>
      )}
    </div>
  );
}
