import type { ChapterMeta } from "../types";
import type { Route } from "../lib/useHashRoute";
import { loadLast } from "../lib/storage";

interface Props {
  chapters: ChapterMeta[];
  navigate: (r: Route) => void;
  done: Set<string>;
}

const phaseCopy: Record<string, { label: string; title: string; note: string }> = {
  intro: { label: "序章", title: "先看全貌", note: "跑起来，再拆开看" },
  "Phase 1 · 构建可用的 Coding Agent": { label: "路径 01", title: "造出核心", note: "循环、工具、会话与安全" },
  "Phase 2 · 进阶能力": { label: "路径 02", title: "补齐能力", note: "记忆、技能、多 Agent 与 MCP" },
  "Phase 3 · 自主运行": { label: "路径 03", title: "走向自治", note: "目标、循环与自动决策" },
  总结: { label: "收尾", title: "验证与扩展", note: "测试完整系统" },
};

export function Overview({ chapters, navigate, done }: Props) {
  const codeChapters = chapters.filter((chapter) => chapter.hasCode);
  const completed = codeChapters.filter((chapter) => done.has(chapter.id)).length;
  const progress = codeChapters.length ? Math.round((completed / codeChapters.length) * 100) : 0;
  const lastId = loadLast();
  const nextChapter = chapters.find((chapter) => chapter.id === lastId) ?? codeChapters.find((chapter) => !done.has(chapter.id)) ?? chapters[0];
  const phases = Array.from(new Set(chapters.map((chapter) => chapter.phase))).map((phase) => ({
    phase,
    chapters: chapters.filter((chapter) => chapter.phase === phase),
    copy: phaseCopy[phase] ?? { label: "阶段", title: phase, note: "继续构建" },
  }));

  return (
    <div className="overview">
      <section className="learning-hero">
        <div className="hero-copy">
          <div className="kicker"><span>BUILD LOG / 001</span><span>中文源码课</span></div>
          <h1>不只是“使用” Agent。<em>亲手把它造出来。</em></h1>
          <p className="hero-lead">一条从空循环到自主 Coding Agent 的源码学习路径。每一章只增加一个关键能力，让你同时看见设计理由、真实代码、增量变化和可运行结果。</p>
          <div className="hero-actions">
            <button className="btn-primary" onClick={() => navigate({ name: "chapter", id: nextChapter.id })}>
              {lastId ? "继续上次学习" : "开始第一章"}<span aria-hidden="true">↗</span>
            </button>
            <a className="btn-ghost" href="https://github.com/Windy3f3f3f3f/claude-code-from-scratch" target="_blank" rel="noreferrer">查看源码仓库</a>
          </div>
          <div className="hero-stats" aria-label="课程统计">
            <div><strong>{codeChapters.length}</strong><span>个可运行章节</span></div>
            <div><strong>12</strong><span>个核心源码文件</span></div>
            <div><strong>0</strong><span>学习所需 API Key</span></div>
          </div>
        </div>

        <div className="agent-model" aria-label="Agent 循环示意">
          <div className="model-top"><span className="model-dots">● ● ●</span><span>agent.ts</span></div>
          <div className="model-body">
            <p className="model-comment">// 一个 Coding Agent 的心脏</p>
            <p><span className="syntax-key">while</span> (<span className="syntax-value">task</span>.unfinished) {'{'}</p>
            <div className="loop-stack">
              <div><span>01</span><b>THINK</b><small>模型判断下一步</small></div>
              <div><span>02</span><b>ACT</b><small>调用工具执行</small></div>
              <div><span>03</span><b>OBSERVE</b><small>结果回到上下文</small></div>
            </div>
            <p>{'}'}</p>
            <div className="model-output"><span>›</span>从 17 行循环开始，逐章长成完整系统<span className="cursor">_</span></div>
          </div>
          <div className="model-label">THE LOOP IS THE PRODUCT</div>
        </div>
      </section>

      <section className="progress-strip">
        <div><span className="section-index">你的进度</span><strong>{completed} / {codeChapters.length} 章</strong></div>
        <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
        <span>{progress}%</span>
      </section>

      <section className="course-section">
        <header className="section-heading">
          <div><span className="section-index">01 / 学习路线</span><h2>从循环，到一个会自主工作的 Agent</h2></div>
          <p>按阶段走，也可以直接跳进你最感兴趣的能力。</p>
        </header>
        <div className="phase-list">
          {phases.map(({ phase, chapters: items, copy }, phaseIndex) => (
            <article className="phase-row" key={phase}>
              <div className="phase-intro"><span>{copy.label}</span><h3>{copy.title}</h3><p>{copy.note}</p></div>
              <div className="chapter-rail">
                {items.map((chapter) => (
                  <button key={chapter.id} className={`chapter-ticket ${done.has(chapter.id) ? "is-done" : ""}`} onClick={() => navigate({ name: "chapter", id: chapter.id })}>
                    <span className="ticket-number">{chapter.id}</span>
                    <span className="ticket-copy"><b>{chapter.title.replace(/\s*[—：].*$/, "")}</b><small>{chapter.fileNames.length ? `${chapter.fileNames.length} 个源码文件` : "概念与路线"}</small></span>
                    <span className="ticket-arrow">{done.has(chapter.id) ? "✓" : "↗"}</span>
                  </button>
                ))}
              </div>
              <span className="phase-watermark">0{phaseIndex + 1}</span>
            </article>
          ))}
        </div>
      </section>

      <section className="method-section">
        <header className="section-heading inverse"><div><span className="section-index">02 / 学习方法</span><h2>每一章，完成一次完整的认知闭环</h2></div></header>
        <div className="method-grid">
          {[
            ["01", "先理解", "用架构图和设计问题理解为什么需要这个能力。"],
            ["02", "再读代码", "逐行注解紧贴源码，不在文章和文件之间来回跳。"],
            ["03", "只看增量", "对比上一章，聚焦这一步到底新增了什么。"],
            ["04", "亲手运行", "复制命令，用本地 mock 验证行为，无需 API Key。"],
          ].map(([number, title, body]) => <div className="method-card" key={number}><span>{number}</span><h3>{title}</h3><p>{body}</p></div>)}
        </div>
      </section>

      <FileMapSection chapters={chapters} navigate={navigate} />
    </div>
  );
}

function FileMapSection({ chapters, navigate }: { chapters: ChapterMeta[]; navigate: (r: Route) => void }) {
  const files = new Map<string, ChapterMeta[]>();
  for (const chapter of chapters) {
    for (const file of chapter.fileNames) files.set(file, [...(files.get(file) ?? []), chapter]);
  }

  return (
    <section className="file-section">
      <header className="section-heading">
        <div><span className="section-index">03 / 源码地图</span><h2>12 个文件，构成完整系统</h2></div><p>数字表示该文件会在哪些章节出现。</p>
      </header>
      <div className="file-grid">
        {[...files].map(([file, items]) => (
          <div className="file-card" key={file}>
            <div><span className="file-icon">TS</span><code>{file}</code></div>
            <div className="file-chapters">{items.map((chapter) => <button key={chapter.id} onClick={() => navigate({ name: "chapter", id: chapter.id })}>{chapter.id}</button>)}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
