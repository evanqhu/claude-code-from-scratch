// Memory system — 4-type file-based memory with MEMORY.md index.
// 记忆系统 —— 基于 4 种类型文件的记忆机制，使用 MEMORY.md 作为索引
// Mirrors Claude Code's memory architecture: semantic recall via sideQuery.
// 镜像 Claude Code 的记忆架构：通过 sideQuery 实现语义检索

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync,
  unlinkSync, statSync,
} from "fs";
// 引入 Node.js 文件系统模块，用于读写文件、判断存在性、遍历目录等
import { join } from "path";
// 引入路径处理工具，用于跨平台拼接路径
import { homedir } from "os";
// 引入 os 模块，用于获取当前用户的 home 目录
import { createHash } from "crypto";
// 引入 crypto 模块，用于生成项目路径的哈希值（区分不同项目）
import { parseFrontmatter, formatFrontmatter } from "./frontmatter.js";
// 引入 frontmatter 解析与格式化工具（YAML 元数据头）

/** A function that sends a prompt and returns the model's text response. */
/** 一个发送提示词并返回模型文本响应的函数类型（用于语义检索时调用模型） */
export type SideQueryFn = (system: string, userMessage: string, signal?: AbortSignal) => Promise<string>;

// ─── Types ──────────────────────────────────────────────────
// ─── 类型定义 ──────────────────────────────────────────────────

// 记忆的类型：user（用户信息）/ feedback（反馈纠正）/ project（项目信息）/ reference（外部引用）
export type MemoryType = "user" | "feedback" | "project" | "reference";

// 单条记忆条目的结构定义
export interface MemoryEntry {
  name: string; // 记忆名称
  description: string; // 一句话描述
  type: MemoryType; // 记忆类型
  filename: string; // 存储文件名
  content: string; // 记忆正文内容
}

// 所有合法的记忆类型集合，用于校验
const VALID_TYPES = new Set<MemoryType>(["user", "feedback", "project", "reference"]);
const MAX_INDEX_LINES = 200; // 记忆索引的最大行数限制
const MAX_INDEX_BYTES = 25000; // 记忆索引的最大字节数限制（约 25KB）

// ─── Paths ──────────────────────────────────────────────────
// ─── 路径相关 ──────────────────────────────────────────────────

/**
 * 根据当前工作目录生成一个 16 位的 SHA-256 哈希值
 * 用于为每个项目创建独立的存储目录，避免不同项目间记忆混淆。
 * @returns 16 位十六进制哈希字符串
 */
function getProjectHash(): string {
  return createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
}

/**
 * 获取当前项目的记忆存储目录
 * 目录位于用户 home 下的 ~/.mini-claude/projects/<项目哈希>/memory
 * 如果目录不存在会自动创建。
 * @returns 记忆目录的绝对路径
 */
export function getMemoryDir(): string {
  const dir = join(homedir(), ".mini-claude", "projects", getProjectHash(), "memory");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); // 递归创建目录
  return dir;
}

/**
 * 获取记忆索引文件 MEMORY.md 的完整路径
 * @returns 索引文件路径
 */
function getIndexPath(): string {
  return join(getMemoryDir(), "MEMORY.md");
}

// ─── Slugify ────────────────────────────────────────────────
// ─── Slug 化（将文本转为合法的文件名片段）────────────────────────

/**
 * 将任意文本转换为适合用作文件名的 slug
 * 转为小写，非字母数字字符替换为下划线，去除首尾下划线，截断至 40 字符。
 * @param text - 原始文本
 * @returns slug 化后的字符串
 */
function slugify(text: string): string {
  return text
    .toLowerCase() // 转为小写
    .replace(/[^a-z0-9]+/g, "_") // 非字母数字连续字符替换为单个下划线
    .replace(/^_|_$/g, "") // 去除首尾的下划线
    .slice(0, 40); // 截断到 40 个字符以内
}

// ─── CRUD ───────────────────────────────────────────────────
// ─── 增删改查（CRUD）操作 ───────────────────────────────────────

/**
 * 列出所有记忆条目
 * 遍历记忆目录下的所有 .md 文件（排除索引文件），解析 frontmatter，
 * 返回按修改时间倒序排列的记忆列表。
 * @returns 记忆条目数组（最新修改的在前）
 */
export function listMemories(): MemoryEntry[] {
  const dir = getMemoryDir();
  // 读取目录下所有 .md 文件，排除 MEMORY.md 索引文件
  const files = readdirSync(dir).filter(
    (f) => f.endsWith(".md") && f !== "MEMORY.md"
  );
  const entries: MemoryEntry[] = [];
  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), "utf-8");
      const { meta, body } = parseFrontmatter(raw);
      // 缺少 name 或 type 的文件视为无效，跳过
      if (!meta.name || !meta.type) continue;
      entries.push({
        name: meta.name,
        description: meta.description || "",
        type: (VALID_TYPES.has(meta.type as MemoryType) ? meta.type : "project") as MemoryType,
        filename: file,
        content: body,
      });
    } catch { /* skip corrupt files */ }
    // 捕获异常时跳过损坏的文件
  }
  // Sort by mtime desc
  // 按文件修改时间倒序排列（最新的排前面）
  entries.sort((a, b) => {
    try {
      const statA = statSync(join(dir, a.filename));
      const statB = statSync(join(dir, b.filename));
      return statB.mtimeMs - statA.mtimeMs;
    } catch { return 0; }
  });
  return entries;
}

/**
 * 保存一条记忆到文件
 * 文件名格式为 {type}_{slug(name)}.md，包含 frontmatter 元数据和正文，
 * 保存后会自动更新 MEMORY.md 索引。
 * @param entry - 记忆条目（不含 filename 字段）
 * @returns 生成的文件名
 */
export function saveMemory(entry: Omit<MemoryEntry, "filename">): string {
  const dir = getMemoryDir();
  const filename = `${entry.type}_${slugify(entry.name)}.md`; // 生成文件名
  const content = formatFrontmatter(
    { name: entry.name, description: entry.description, type: entry.type },
    entry.content
  );
  writeFileSync(join(dir, filename), content); // 写入文件
  updateMemoryIndex(); // 更新索引
  return filename;
}

/**
 * 删除一条记忆文件
 * @param filename - 要删除的文件名
 * @returns 是否删除成功（文件不存在则返回 false）
 */
export function deleteMemory(filename: string): boolean {
  const filepath = join(getMemoryDir(), filename);
  if (!existsSync(filepath)) return false; // 文件不存在则返回 false
  unlinkSync(filepath); // 删除文件
  updateMemoryIndex(); // 更新索引
  return true;
}

// ─── Index ──────────────────────────────────────────────────
// ─── 索引管理 ──────────────────────────────────────────────────

/**
 * 更新 MEMORY.md 索引文件
 * 根据当前所有记忆条目重新生成索引内容，每条记忆一行。
 */
function updateMemoryIndex(): void {
  const memories = listMemories();
  const lines = ["# Memory Index", ""];
  for (const m of memories) {
    lines.push(`- **[${m.name}](${m.filename})** (${m.type}) — ${m.description}`);
  }
  writeFileSync(getIndexPath(), lines.join("\n"));
}

/**
 * 加载 MEMORY.md 索引内容
 * 如果索引超过行数或字节数限制会进行截断。
 * @returns 索引内容字符串；索引不存在时返回空字符串
 */
export function loadMemoryIndex(): string {
  const indexPath = getIndexPath();
  if (!existsSync(indexPath)) return ""; // 索引不存在返回空
  let content = readFileSync(indexPath, "utf-8");
  // Truncate to limits (matching Claude Code: 200 lines, 25KB)
  // 截断到限制范围内（与 Claude Code 保持一致：200 行、25KB）
  const lines = content.split("\n");
  if (lines.length > MAX_INDEX_LINES) {
    content = lines.slice(0, MAX_INDEX_LINES).join("\n") +
      "\n\n[... truncated, too many memory entries ...]";
  }
  if (Buffer.byteLength(content) > MAX_INDEX_BYTES) {
    content = content.slice(0, MAX_INDEX_BYTES) +
      "\n\n[... truncated, index too large ...]";
  }
  return content;
}

// ─── Memory Header (lightweight scan) ──────────────────────
// ─── 记忆头部信息（轻量扫描，仅读取 frontmatter）──────────────

/**
 * 记忆头部信息结构（轻量版，不包含完整内容）
 * 用于快速扫描和语义选择，避免读取全部内容。
 */
export interface MemoryHeader {
  filename: string; // 文件名
  filePath: string; // 完整文件路径
  mtimeMs: number; // 最后修改时间（毫秒时间戳）
  description: string | null; // 描述
  type: MemoryType | undefined; // 记忆类型
}

const MAX_MEMORY_FILES = 200; // 最多扫描的记忆文件数
const MAX_MEMORY_BYTES_PER_FILE = 4096; // 单个记忆文件读取的最大字节数
const MAX_SESSION_MEMORY_BYTES = 60 * 1024; // 60KB cumulative per session
// 每个会话累计注入记忆的最大字节数（60KB）

/** Scan memory directory — read only frontmatter (first 30 lines) for speed. */
/** 扫描记忆目录 —— 为提升速度，仅读取 frontmatter（前 30 行）。 */
export function scanMemoryHeaders(): MemoryHeader[] {
  const dir = getMemoryDir();
  const files = readdirSync(dir).filter(
    (f) => f.endsWith(".md") && f !== "MEMORY.md"
  );
  const headers: MemoryHeader[] = [];
  for (const file of files) {
    try {
      const filePath = join(dir, file);
      const stat = statSync(filePath);
      const raw = readFileSync(filePath, "utf-8");
      // Only parse frontmatter (first 30 lines)
      // 仅解析前 30 行的 frontmatter 部分
      const first30 = raw.split("\n").slice(0, 30).join("\n");
      const { meta } = parseFrontmatter(first30);
      headers.push({
        filename: file,
        filePath,
        mtimeMs: stat.mtimeMs,
        description: meta.description || null,
        type: VALID_TYPES.has(meta.type as MemoryType) ? (meta.type as MemoryType) : undefined,
      });
    } catch { /* skip corrupt files */ }
    // 损坏文件跳过
  }
  // Sort newest first, cap at 200
  // 按修改时间倒序，最多保留 200 条
  headers.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return headers.slice(0, MAX_MEMORY_FILES);
}

/** Format manifest for semantic selector: one line per memory. */
/** 为语义选择器格式化清单：每条记忆一行。 */
export function formatMemoryManifest(headers: MemoryHeader[]): string {
  return headers
    .map((h) => {
      const tag = h.type ? `[${h.type}] ` : ""; // 类型标签
      const ts = new Date(h.mtimeMs).toISOString(); // ISO 时间戳
      return h.description
        ? `- ${tag}${h.filename} (${ts}): ${h.description}`
        : `- ${tag}${h.filename} (${ts})`;
    })
    .join("\n");
}

// ─── Memory Age / Freshness ────────────────────────────────
// ─── 记忆时效 / 新鲜度 ────────────────────────────────

/**
 * 返回记忆相对于当前时间的人类可读年龄描述
 * @param mtimeMs - 记忆的最后修改时间（毫秒时间戳）
 * @returns 如 "today"、"yesterday"、"3 days ago"
 */
export function memoryAge(mtimeMs: number): string {
  const days = Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/**
 * 返回记忆过期警告文本
 * 当记忆超过 1 天时会生成提醒，提示记忆是某一时刻的观察，可能已过时，需对照当前代码核实。
 * @param mtimeMs - 记忆的最后修改时间（毫秒时间戳）
 * @returns 警告字符串；记忆较新时返回空字符串
 */
export function memoryFreshnessWarning(mtimeMs: number): string {
  const days = Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000));
  if (days <= 1) return ""; // 1 天内视为新鲜，不警告
  return `This memory is ${days} days old. Memories are point-in-time observations, not live state — claims about code behavior may be outdated. Verify against current code before asserting as fact.`;
}

// ─── Semantic Recall (sideQuery) ────────────────────────────
// ─── 语义检索（通过 sideQuery 调用模型）────────────────────

// 用于让模型挑选相关记忆的系统提示词
const SELECT_MEMORIES_PROMPT = `You are selecting memories that will be useful to an AI coding assistant as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a JSON object with a "selected_memories" array of filenames for the memories that will clearly be useful (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful, do not include it.
- If no memories would clearly be useful, return an empty array.`;

/**
 * 检索到的相关记忆结构
 * 包含完整内容和用于注入的头部文本。
 */
export interface RelevantMemory {
  path: string; // 记忆文件路径
  content: string; // 记忆完整内容
  mtimeMs: number; // 修改时间
  header: string; // 注入时使用的头部说明文本
}

/**
 * Call the model to semantically select relevant memories.
 * Uses the same model the user configured (not a separate small model).
 *
 * 调用模型进行语义检索，挑选与当前查询相关的记忆。
 * 使用用户配置的同一模型（而非单独的小模型）。
 * @param query - 用户的查询内容
 * @param sideQuery - 调用模型的函数
 * @param alreadySurfaced - 已经展示过的记忆路径集合（避免重复）
 * @param signal - 可选的中断信号
 * @returns 相关记忆数组（最多 5 条）
 */
export async function selectRelevantMemories(
  query: string,
  sideQuery: SideQueryFn,
  alreadySurfaced: Set<string>,
  signal?: AbortSignal,
): Promise<RelevantMemory[]> {
  const headers = scanMemoryHeaders();
  if (headers.length === 0) return []; // 没有记忆则直接返回空

  // Filter out already-surfaced memories before sending to selector
  // 在发送给选择器之前，过滤掉已经展示过的记忆
  const candidates = headers.filter((h) => !alreadySurfaced.has(h.filePath));
  if (candidates.length === 0) return [];

  const manifest = formatMemoryManifest(candidates); // 格式化候选清单

  try {
    const text = await sideQuery(
      SELECT_MEMORIES_PROMPT,
      `Query: ${query}\n\nAvailable memories:\n${manifest}`,
      signal,
    );

    // Extract JSON from response (model might wrap in markdown code block)
    // 从模型响应中提取 JSON（模型可能将其包裹在 markdown 代码块中）
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return []; // 未匹配到 JSON 则返回空

    const parsed = JSON.parse(jsonMatch[0]);
    const selectedFilenames: string[] = parsed.selected_memories || [];

    // Map filenames back to headers, read full content
    // 将选中的文件名映射回头部信息，并读取完整内容
    const filenameSet = new Set(selectedFilenames);
    const selected = candidates.filter((h) => filenameSet.has(h.filename));

    return selected.slice(0, 5).map((h) => {
      let content = readFileSync(h.filePath, "utf-8");
      // Truncate to per-file limit
      // 超过单文件字节限制时截断
      if (Buffer.byteLength(content) > MAX_MEMORY_BYTES_PER_FILE) {
        content = content.slice(0, MAX_MEMORY_BYTES_PER_FILE) +
          "\n\n[... truncated, memory file too large ...]";
      }
      const freshness = memoryFreshnessWarning(h.mtimeMs);
      // 如果有过期警告，头部带上警告文本；否则带上保存时间的友好描述
      const headerText = freshness
        ? `${freshness}\n\nMemory: ${h.filePath}:`
        : `Memory (saved ${memoryAge(h.mtimeMs)}): ${h.filePath}:`;

      return { path: h.filePath, content, mtimeMs: h.mtimeMs, header: headerText };
    });
  } catch (err: any) {
    // Silently fail — memory recall should never block the main loop
    // 静默失败 —— 记忆检索不应阻塞主循环
    if (signal?.aborted) return []; // 用户中断时直接返回空
    console.error(`[memory] semantic recall failed: ${err.message}`);
    return [];
  }
}

// ─── Prefetch Handle ────────────────────────────────────────
// ─── 预取句柄（用于异步预加载记忆）────────────────────────────

/**
 * 记忆预取句柄结构
 * 用于异步启动记忆检索，并轮询其结果状态。
 */
export interface MemoryPrefetch {
  promise: Promise<RelevantMemory[]>; // 检索结果的 Promise
  settled: boolean; // 是否已完成（无论成功或失败）
  consumed: boolean; // 结果是否已被消费
}

/**
 * Start async memory prefetch. Returns a handle to poll for results.
 * Gate conditions (matching Claude Code):
 *   - Input must have multiple words
 *   - Session memory budget not exceeded
 *
 * 异步启动记忆预取。返回一个句柄用于轮询结果。
 * 触发条件（与 Claude Code 保持一致）：
 *   - 输入必须包含多个单词（或 CJK 字符）
 *   - 会话记忆预算未超限
 */
/** Check if query contains enough meaningful content (CJK chars or multi-word). */
/** 检查查询是否包含足够的实质内容（中日韩字符或多词输入）。 */
function isQuerySubstantial(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length === 0) return false; // 空字符串不触发

  // Check for CJK characters (Chinese, Japanese, Korean)
  // 检查是否包含中日韩（CJK）字符
  const cjkRegex = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g;
  const cjkMatches = trimmed.match(cjkRegex);
  if (cjkMatches && cjkMatches.length >= 2) return true; // 至少 2 个 CJK 字符

  // Fallback: multi-word input (contains whitespace)
  // 兜底：多词输入（包含空白字符）
  if (/\s/.test(trimmed)) return true;

  return false;
}

/**
 * 启动记忆预取
 * 在满足触发条件时，异步启动语义检索，返回可轮询的句柄。
 * @param query - 用户查询
 * @param sideQuery - 模型调用函数
 * @param alreadySurfaced - 已展示的记忆集合
 * @param sessionMemoryBytes - 当前会话已用的记忆字节数
 * @param signal - 可选中断信号
 * @returns 预取句柄；不满足条件时返回 null
 */
export function startMemoryPrefetch(
  query: string,
  sideQuery: SideQueryFn,
  alreadySurfaced: Set<string>,
  sessionMemoryBytes: number,
  signal?: AbortSignal,
): MemoryPrefetch | null {
  // Gate: substantial input (CJK chars or multi-word)
  // 触发条件一：输入内容足够实质（包含 CJK 字符或多词）
  if (!isQuerySubstantial(query)) return null;

  // Gate: session budget
  // 触发条件二：会话预算未超限
  if (sessionMemoryBytes >= MAX_SESSION_MEMORY_BYTES) return null;

  // Gate: memories must exist
  // 触发条件三：必须存在记忆文件
  const dir = getMemoryDir();
  const hasMemories = readdirSync(dir).some(
    (f) => f.endsWith(".md") && f !== "MEMORY.md"
  );
  if (!hasMemories) return null;

  const handle: MemoryPrefetch = {
    promise: selectRelevantMemories(query, sideQuery, alreadySurfaced, signal),
    settled: false,
    consumed: false,
  };
  // 标记 Promise 完成状态（无论成功或失败）
  handle.promise.then(() => { handle.settled = true; }).catch(() => { handle.settled = true; });
  return handle;
}

/** Format recalled memories for injection as user message content. */
/** 将检索到的记忆格式化为可注入用户消息的内容（用 system-reminder 标签包裹）。 */
export function formatMemoriesForInjection(memories: RelevantMemory[]): string {
  return memories
    .map((m) => `<system-reminder>\n${m.header}\n\n${m.content}\n</system-reminder>`)
    .join("\n\n");
}

// ─── System prompt section ──────────────────────────────────
// ─── 系统提示词段落（向 AI 说明记忆系统的用法）─────────────────

/**
 * 构建记忆系统的系统提示词段落
 * 向 AI 说明记忆目录位置、记忆类型、保存方式、不应保存的内容等，
 * 并附带当前的记忆索引内容。
 * @returns 系统提示词字符串
 */
export function buildMemoryPromptSection(): string {
  const index = loadMemoryIndex(); // 加载当前记忆索引
  const memoryDir = getMemoryDir(); // 获取记忆目录路径

  return `# Memory System

You have a persistent, file-based memory system at \`${memoryDir}\`.

## Memory Types
- **user**: User's role, preferences, knowledge level
- **feedback**: Corrections and guidance from the user (include Why + How to apply)
- **project**: Ongoing work, goals, deadlines, decisions
- **reference**: Pointers to external resources (URLs, tools, dashboards)

## How to Save Memories
Use the write_file tool to create a memory file with YAML frontmatter:

\`\`\`markdown
---
name: memory name
description: one-line description
type: user|feedback|project|reference
---
Memory content here.
\`\`\`

Save to: \`${memoryDir}/\`
Filename format: \`{type}_{slugified_name}.md\`

The MEMORY.md index is auto-updated when you write to the memory directory — do NOT update it manually.

## What NOT to Save
- Code patterns or architecture (read the code instead)
- Git history (use git log)
- Anything already in CLAUDE.md
- Ephemeral task details

## When to Recall
When the user asks you to remember or recall, or when prior context seems relevant.
${index ? `\n## Current Memory Index\n${index}` : "\n(No memories saved yet.)"}`;
}
