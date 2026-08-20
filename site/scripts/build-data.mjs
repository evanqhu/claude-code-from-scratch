#!/usr/bin/env node
// =============================================================================
// build-data.mjs — 把项目的学习资源编译成站点消费的 data.json (TS-only)
// -----------------------------------------------------------------------------
// 数据来源（全部为项目的"单一真相源"，永不与源码脱节）：
//   docs/NN-*.md          → 概念正文（抽取 TS-only：丢 Python tab/占位块）
//   steps/dist/<step>/ts/ → 每章结束时的完整 TS 快照（build.mjs 已剥离标记）
//   steps/dist 相邻章 diff → "本章新增了什么"
//
// 复用说明：docs-sync.mjs 的 diffBlock/prevStepName 是纯逻辑但未导出（import 会
// 触发其副作用），这里以等价实现复制，不改原项目文件。
// =============================================================================
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

const HERE = dirname(fileURLToPath(import.meta.url)); // site/scripts/
const SITE = dirname(HERE); // site/
const REPO = dirname(SITE); // repo root
const DOCS = join(REPO, "docs");
const DIST = join(REPO, "steps", "dist");

// ---------------------------------------------------------------------------
// 0. 重新生成 steps/dist 快照，保证与 canonical 一致（幂等）
// ---------------------------------------------------------------------------
const built = spawnSync("node", [join(REPO, "steps", "build.mjs")], {
  stdio: ["ignore", "pipe", "inherit"],
  encoding: "utf-8",
});
if (built.status !== 0) {
  console.error("steps/build.mjs failed");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 1. 章节元数据（与 build.mjs / _sidebar.md 对齐）
// ---------------------------------------------------------------------------
// 每个文件首次出现的章节（来自 build.mjs FILES.ts）
const FILES_TS = [
  { file: "agent.ts", from: 1 },
  { file: "tools.ts", from: 1 },
  { file: "cli.ts", from: 1 },
  { file: "prompt.ts", from: 3 },
  { file: "session.ts", from: 4 },
  { file: "permissions.ts", from: 6 },
  { file: "context.ts", from: 7 },
  { file: "memory.ts", from: 8 },
  { file: "skills.ts", from: 9 },
  { file: "subagent.ts", from: 11 },
  { file: "mcp.ts", from: 12 },
  { file: "autonomy.ts", from: 15 },
];

// 章节分组（来自 _sidebar.md）
function phaseOf(n) {
  if (n === 0) return "intro";
  if (n >= 1 && n <= 7) return "Phase 1 · 构建可用的 Coding Agent";
  if (n >= 8 && n <= 12) return "Phase 2 · 进阶能力";
  if (n === 15) return "Phase 3 · 自主运行";
  return "总结";
}

// 代码章节（有可运行快照的）：1-12, 15
const CODE_STEPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15];
const isCodeStep = (n) => CODE_STEPS.includes(n);

const distDirs = readdirSync(DIST).sort();
const stepName = (n) =>
  distDirs.find((s) => s.startsWith(String(n).padStart(2, "0") + "-"));
// 最大的、小于 n 的已生成步骤（ch13/14 无代码，ch15 diff vs ch12）
const prevStepName = (n) => {
  for (let k = n - 1; k >= 1; k--) {
    const s = stepName(k);
    if (s) return s;
  }
  return null;
};

// ---------------------------------------------------------------------------
// 2. TS-only markdown 抽取
//    契约（来自对 docs 的精确分析）：
//    - tabs:start/tabs:end 区间内：保留 #### **TypeScript** 到 #### **Python**
//      之间的内容；TS-only tab（无 Python 标签）整段保留；tab 标签行本身丢弃。
//    - 占位块 <!-- @snippet|diff|transcript attrs --> ... <!-- @endX -->：
//      lang=py 的 snippet/diff 整块丢弃；ts 的与所有 transcript（均 ts）保留
//      渲染内容、丢弃两侧包裹注释行。
//    - 区间外的独立代码块 0 个 Python，全部保留。
// ---------------------------------------------------------------------------
const PLACEHOLDER_OPEN = /^<!--\s*@(snippet|diff|transcript)\s+([^>]*?)\s*-->\s*$/;
const PLACEHOLDER_CLOSE = /^<!--\s*@end(snippet|diff|transcript)\s*-->\s*$/;

function parseAttrs(s) {
  const o = {};
  for (const m of s.matchAll(/(\w+)=(\S+)/g)) o[m[1]] = m[2];
  return o;
}

function extractTsOnly(md) {
  const lines = md.split("\n");
  const out = [];
  let inTabs = false; // 是否处于 tabs:start/tabs:end 区间内
  let emitting = false; // 区间内当前是否在 TS 子块（已见到 TS 标签、未见 Python）
  let mode = "normal"; // 'normal' | 'skip_py'（跳过 lang=py 占位块直到其 end 标签）
  let pendingEnd = null;

  for (const raw of lines) {
    const line = raw;
    const trimmed = raw.trim();

    // skip_py 模式：丢弃直到匹配的 end 标签（含该行）
    if (mode === "skip_py") {
      if (trimmed === pendingEnd) {
        mode = "normal";
        pendingEnd = null;
      }
      continue;
    }

    // tabs 区间边界
    if (/^<!--\s*tabs:start/.test(trimmed)) {
      inTabs = true;
      emitting = false;
      continue;
    }
    if (/^<!--\s*tabs:end/.test(trimmed)) {
      inTabs = false;
      emitting = false;
      continue;
    }

    // tab 标签（仅区间内有效）
    if (inTabs && /^#{4}\s*\*\*TypeScript\*\*/.test(trimmed)) {
      emitting = true;
      continue;
    }
    if (inTabs && /^#{4}\s*\*\*Python\*\*/.test(trimmed)) {
      emitting = false;
      continue;
    }

    // 占位块开标签
    const open = trimmed.match(PLACEHOLDER_OPEN);
    if (open) {
      const kind = open[1];
      const attrs = parseAttrs(open[2]);
      if ((kind === "snippet" || kind === "diff") && attrs.lang === "py") {
        mode = "skip_py";
        pendingEnd = `<!-- @end${kind} -->`;
      }
      // 否则（ts snippet/diff 或 transcript）：仅丢弃此开标签行，保留内部渲染内容
      continue;
    }

    // 占位块闭标签（丢弃包裹行；ts/transcript 的内部代码已在 normal 模式发出）
    if (PLACEHOLDER_CLOSE.test(trimmed)) continue;

    // 发出：区间外全部保留；区间内仅保留 TS 子块
    if (!inTabs || emitting) out.push(line);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// 3. 从原始 doc 抽取 @transcript 块（均 TS，standalone）
//    返回 [{ command, output }]
// ---------------------------------------------------------------------------
function extractTranscripts(md) {
  const out = [];
  const re = /<!--\s*@transcript\s+([^>]*?)\s*-->\n([\s\S]*?)<!--\s*@endtranscript\s*-->/g;
  let m;
  while ((m = re.exec(md))) {
    const attrs = parseAttrs(m[1]);
    const body = m[2].replace(/^```[a-z]*\n/, "").replace(/\n```$/, "").trim();
    const firstNl = body.indexOf("\n");
    const command = firstNl === -1 ? body : body.slice(0, firstNl).trim();
    const output = firstNl === -1 ? "" : body.slice(firstNl + 1).trim();
    out.push({ command, output, caseId: attrs.case || null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. goals：从「TS-only 正文」里取 ## 本章目标 到下一个 ## 之间的内容。
//    （必须用 tsOnly，否则会带入 Python tab；raw 里仍有 TS/Python 标签页。）
//    同时按行丢弃「▶ 跑这一章」blockquote 块——站点有自己的 RunBar，且原 callout
//    提到 --py 跑 Python 版，与 TS-only 站点定位不符。
// ---------------------------------------------------------------------------
function extractGoals(tsOnly) {
  const lines = tsOnly.split("\n");
  const start = lines.findIndex((l) => /^##\s+本章目标/.test(l));
  if (start === -1) return "";
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    body.push(lines[i]);
  }
  // 去掉「跑这一章」callout：以 > ▶ **跑这一章** 开头的 blockquote 整块（连续 > 行）
  const cleaned = [];
  for (let i = 0; i < body.length; i++) {
    if (/^>\s*▶\s*\*\*跑这一章\*\*/.test(body[i])) {
      while (i < body.length && /^>/.test(body[i])) i++; // 跳过连续 > 行
      i--; // 抵消 for 的 i++
      continue;
    }
    cleaned.push(body[i]);
  }
  return cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------------------
// 5. title：取 H1，去掉前导 "# " 与章号
// ---------------------------------------------------------------------------
function extractTitle(md) {
  const m = md.match(/^#\s+(.+?)\s*$/m);
  if (!m) return "";
  // 去掉 "N. " 前缀
  return m[1].replace(/^\d+\.\s*/, "");
}

// ---------------------------------------------------------------------------
// 6. diff：复制 docs-sync.mjs 的 diffBlock 逻辑（git diff --no-index，剥头与标记）
// ---------------------------------------------------------------------------
function diffBlock(prevPath, curPath) {
  const r = spawnSync(
    "git",
    ["--no-pager", "diff", "--no-index", "--unified=2", "--", prevPath, curPath],
    { encoding: "utf-8" }
  );
  // git diff --no-index 在文件不同时 exit 1（正常）；相同 exit 0
  const isMarker = (l) =>
    /^[-+ ]\s*(?:\/\/#|#)(?:region|endregion|step|endstep)\b/.test(l);
  const body = (r.stdout || "")
    .split("\n")
    .filter(
      (l) => /^[-+ @]/.test(l) && !/^(\+\+\+|---)/.test(l) && !isMarker(l)
    )
    .join("\n");
  return body.trim();
}

// ---------------------------------------------------------------------------
// 6.5 剥离 region 标记：build.mjs 只剥 #step，#region/#endregion 会残留在快照里。
//     它们是结构性标记（供 docs-sync 抽取代码段用），对学习者是噪音，显示前剔除。
// ---------------------------------------------------------------------------
const REGION_MARK = /^\s*(?:\/\/#|#)(?:region|endregion)\b.*$/;
function stripRegionMarkers(source) {
  return source
    .split("\n")
    .filter((l) => !REGION_MARK.test(l))
    .join("\n")
    .replace(/\s+$/, "\n");
}

// ---------------------------------------------------------------------------
// 7. 逐行注解：把"紧贴代码上方的注释块"与该代码配对成一个注解单元
//    canonical 注释风格统一为 // 注释位于被解释代码正上方
// ---------------------------------------------------------------------------
function stripCommentLeader(s) {
  return s
    .replace(/^\s*\/\/\s?/, "")
    .replace(/^\s*\/\*\s?/, "")
    .replace(/^\s*\*\s?/, "")
    .replace(/\s*\*\/\s*$/, "")
    .trim();
}

function annotate(source) {
  const lines = source.split("\n");
  const units = [];
  let pending = []; // 待配对的注释行（原文）
  let code = []; // 当前单元的代码行（原文）
  let startLine = null;

  const isComment = (t) =>
    /^\s*\/\//.test(t) ||
    /^\s*\/\*/.test(t) ||
    /^\s*\*/.test(t);

  const flush = () => {
    if (code.length) {
      units.push({
        lineNo: startLine,
        code: code.slice(),
        comment: pending.map((c) => stripCommentLeader(c)).join("\n").trim(),
      });
    }
    pending = [];
    code = [];
    startLine = null;
  };

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed === "") {
      if (code.length) flush(); // 空行结束当前代码单元
      // 否则：注释可能在空行下方仍有代码，保留 pending
    } else if (isComment(line)) {
      if (code.length) flush(); // 新注释块开始 → 先冲掉旧单元
      pending.push(line);
    } else {
      if (startLine === null) startLine = i + 1; // 1-based
      code.push(line);
    }
  });
  flush();
  return units;
}

// ---------------------------------------------------------------------------
// 8. 组装每章数据
// ---------------------------------------------------------------------------
const docFiles = readdirSync(DOCS)
  .filter((f) => /^(\d{2})-.*\.md$/.test(f))
  .sort();

const chapters = [];
for (const f of docFiles) {
  const number = Number(f.slice(0, 2));
  const raw = readFileSync(join(DOCS, f), "utf-8");
  const tsOnly = extractTsOnly(raw);
  const title = extractTitle(raw);
  const phase = phaseOf(number);
  const goals = extractGoals(tsOnly);
  const transcripts = extractTranscripts(raw);
  const runCommand = isCodeStep(number)
    ? `node steps/run.mjs ${number}`
    : null;

  const chapter = {
    id: String(number).padStart(2, "0"),
    number,
    slug: f.replace(/\.md$/, ""),
    title,
    phase,
    goals,
    runCommand,
    transcripts,
    bodyMarkdown: tsOnly,
    files: [],
  };

  // 代码章节：填充每个文件的快照 / diff / 注解
  if (isCodeStep(number)) {
    const cur = stepName(number);
    const prev = prevStepName(number);
    for (const { file, from } of FILES_TS) {
      if (from > number) continue;
      const curPath = join(DIST, cur, "ts", file);
      if (!existsSync(curPath)) continue;
      const fullSource = stripRegionMarkers(readFileSync(curPath, "utf-8"));

      // diff vs 上一章（若上一章没有该文件则 vs /dev/null）
      let diff = "";
      const prevPath =
        prev && existsSync(join(DIST, prev, "ts", file))
          ? join(DIST, prev, "ts", file)
          : "/dev/null";
      diff = diffBlock(prevPath, curPath);

      chapter.files.push({
        name: file,
        fullSource,
        diff,
        annotations: annotate(fullSource),
        srcRef: `src/${file}`,
      });
    }
  }

  chapters.push(chapter);
}

// ---------------------------------------------------------------------------
// 9. 文件 → 首次出现章节的映射（供 Overview 用）
// ---------------------------------------------------------------------------
const fileMap = FILES_TS.map(({ file, from }) => ({
  file,
  firstChapter: from,
  firstChapterId: String(from).padStart(2, "0"),
}));

// ---------------------------------------------------------------------------
// 10. 输出：拆分为「轻量 meta（打包进主 bundle）」+「每章详情（按需懒加载）」
//     - src/meta.json：章节列表/标题/phase/goals/运行命令/文件名清单（小，供侧栏与首页）
//     - src/data/<id>.json：单章的正文/transcripts/源码快照/diff/逐行注解（大，按章加载）
// ---------------------------------------------------------------------------
const meta = {
  generatedAt: new Date().toISOString(),
  chapters: chapters.map((c) => ({
    id: c.id,
    number: c.number,
    slug: c.slug,
    title: c.title,
    phase: c.phase,
    goals: c.goals,
    runCommand: c.runCommand,
    hasCode: c.files.length > 0,
    fileNames: c.files.map((f) => f.name),
  })),
  fileMap,
  codeSteps: CODE_STEPS,
};

const outDir = join(SITE, "src");
const dataDir = join(outDir, "data");
mkdirSync(dataDir, { recursive: true });

// 清理旧的 per-chapter 文件，避免删除章节后残留
for (const old of readdirSync(dataDir).filter((f) => f.endsWith(".json"))) {
  if (!chapters.some((c) => c.id + ".json" === old)) {
    rmSync(join(dataDir, old));
  }
}

writeFileSync(join(outDir, "meta.json"), JSON.stringify(meta));
for (const c of chapters) {
  writeFileSync(
    join(dataDir, `${c.id}.json`),
    JSON.stringify({
      id: c.id,
      bodyMarkdown: c.bodyMarkdown,
      transcripts: c.transcripts,
      files: c.files,
    })
  );
}

// ---------------------------------------------------------------------------
// 11. 抽查摘要
// ---------------------------------------------------------------------------
const metaBytes = JSON.stringify(meta).length;
let detailBytes = 0;
console.log(`✓ wrote site/src/meta.json  (${(metaBytes / 1024).toFixed(1)} KB)`);
console.log(`  chapters: ${chapters.length}`);
for (const c of chapters) {
  const fileCount = c.files.length;
  const annotUnits = c.files.reduce((s, f) => s + f.annotations.length, 0);
  const diffLines = c.files.reduce(
    (s, f) => s + f.diff.split("\n").filter((l) => /^[+-]/.test(l)).length,
    0
  );
  const hasPy =
    /```python/.test(c.bodyMarkdown) || /#### \*\*Python\*\*/.test(c.bodyMarkdown);
  const detail = JSON.stringify({
    id: c.id,
    bodyMarkdown: c.bodyMarkdown,
    transcripts: c.transcripts,
    files: c.files,
  });
  detailBytes += detail.length;
  console.log(
    `  · ch${c.id} ${c.title.slice(0, 26).padEnd(28)} files=${String(fileCount).padStart(2)} ` +
      `units=${String(annotUnits).padStart(3)} diff±=${String(diffLines).padStart(3)} ` +
      `detail=${(detail.length / 1024).toFixed(0).padStart(3)}KB ` +
      `${hasPy ? "⚠️PY-LEAK" : "✓no-py"}`
  );
}
console.log(`  detail total: ${(detailBytes / 1024).toFixed(0)} KB (split across ${chapters.length} lazy files)`);

