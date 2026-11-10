// Sub-agent system — fork-return pattern with built-in + custom agent types.
// 子代理系统 —— 采用 fork-return（派生并返回）模式，支持内置和自定义两类代理类型。
// Mirrors Claude Code's AgentTool: explore (read-only), plan (structured), general (full tools),
// 模仿 Claude Code 的 AgentTool：explore（只读）、plan（结构化）、general（完整工具集），
// plus user-defined agents via .claude/agents/*.md.
// 此外还支持通过 .claude/agents/*.md 文件自定义代理类型。

import { existsSync, readdirSync, readFileSync } from "fs"; // 文件系统操作：判断存在、读取目录、读取文件
import { join } from "path"; // 路径拼接工具
import { homedir } from "os"; // 获取用户主目录（用于读取用户级配置）
import type { ToolDef } from "./tools.js"; // 工具定义的类型（仅类型导入，不参与运行时）
import { toolDefinitions } from "./tools.js"; // 所有可用工具的定义列表
import { parseFrontmatter } from "./frontmatter.js"; // 解析 Markdown 文件的 frontmatter（YAML 元数据头）

// ─── Types ──────────────────────────────────────────────────
// ─── 类型定义 ──────────────────────────────────────────────

export type SubAgentType = string; // Built-in or custom agent type name
// 子代理类型，使用字符串表示（可以是内置类型名或自定义类型名）

export interface SubAgentConfig {
  // 子代理配置：包含系统提示词和该代理可用的工具集合
  systemPrompt: string; // 系统提示词，定义代理的行为和角色
  tools: ToolDef[]; // 该代理被允许使用的工具列表
}

interface CustomAgentDef {
  // 自定义代理定义：从 .claude/agents/*.md 文件中解析得到的结构
  name: string; // 代理名称（用于调用时指定）
  description: string; // 代理描述（用于在系统提示词中展示）
  allowedTools?: string[]; // 允许使用的工具名列表（可选，不填则使用除 agent 外的全部工具）
  systemPrompt: string; // 代理的系统提示词正文
}

// ─── Read-only tools (for explore and plan agents) ──────────
// ─── 只读工具（供 explore 和 plan 代理使用）──────────────────

// 只读工具名集合：这些工具仅用于读取/搜索，不会修改任何文件或系统状态
const READ_ONLY_TOOLS = new Set(["read_file", "list_files", "grep_search"]);

// 从全部工具定义中筛选出只读工具
// 返回值：ToolDef[] —— 仅包含读取/列表/搜索类工具的定义数组
function getReadOnlyTools(): ToolDef[] {
  return toolDefinitions.filter((t) => READ_ONLY_TOOLS.has(t.name));
}

// ─── Built-in agent type prompts ────────────────────────────
// ─── 内置代理类型的系统提示词 ────────────────────────────────

// explore 代理提示词：专注于快速、只读的代码库搜索和探索
const EXPLORE_PROMPT = `You are a file search specialist for Mini Claude Code. You excel at thoroughly navigating and exploring codebases.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY exploration task. You are STRICTLY PROHIBITED from:
- Creating new files (no write_file, touch, or file creation of any kind)
- Modifying existing files (no edit_file operations)
- Deleting files (no rm or deletion)
- Running ANY commands that change system state

Your role is EXCLUSIVELY to search and analyze existing code.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
- Use list_files for broad file pattern matching
- Use grep_search for searching file contents with regex
- Use read_file when you know the specific file path you need to read
- Adapt your search approach based on the thoroughness level specified by the caller

NOTE: You are meant to be a fast agent that returns output as quickly as possible. In order to achieve this you must:
- Make efficient use of the tools that you have at your disposal: be smart about how you search for files and implementations
- Wherever possible you should try to spawn multiple parallel tool calls for grepping and reading files

Complete the user's search request efficiently and report your findings clearly.`;

// plan 代理提示词：只读子代理，专门用于设计结构化的实现方案
const PLAN_PROMPT = `You are a Plan agent — a READ-ONLY sub-agent specialized for designing implementation plans.

IMPORTANT CONSTRAINTS:
- You are READ-ONLY. You only have access to read_file, list_files, and grep_search.
- Do NOT attempt to modify any files.

Your job:
- Analyze the codebase to understand the current architecture
- Design a step-by-step implementation plan
- Identify critical files that need modification
- Consider architectural trade-offs

Return a structured plan with:
1. Summary of current state
2. Step-by-step implementation steps
3. Critical files for implementation
4. Potential risks or considerations`;

// general 代理提示词：通用代理，拥有完整的工具集，可独立完成各类任务
const GENERAL_PROMPT = `You are an agent for Mini Claude Code. Given the user's message, you should use the tools available to complete the task. Complete the task fully—don't gold-plate, but don't leave it half-done. When you complete the task, respond with a concise report covering what was done and any key findings — the caller will relay this to the user, so it only needs the essentials.

Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Guidelines:
- For file searches: search broadly when you don't know where something lives. Use read_file when you know the specific file path.
- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.
- Be thorough: Check multiple locations, consider different naming conventions, look for related files.
- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one.`;

// ─── Custom agent discovery ─────────────────────────────────
// ─── 自定义代理发现 ─────────────────────────────────────────

// 自定义代理缓存：首次加载后缓存，避免重复读取文件系统
let cachedCustomAgents: Map<string, CustomAgentDef> | null = null;

// 发现并加载所有自定义代理（来自 .claude/agents/*.md 文件）
// 返回值：Map<string, CustomAgentDef> —— 代理名称到定义的映射
// 说明：使用缓存机制，仅首次调用时扫描文件系统
function discoverCustomAgents(): Map<string, CustomAgentDef> {
  // 如果已有缓存，直接返回
  if (cachedCustomAgents) return cachedCustomAgents;

  const agents = new Map<string, CustomAgentDef>();

  // User-level (lower priority)
  // 用户级目录（优先级较低）：~/.claude/agents/
  loadAgentsFromDir(join(homedir(), ".claude", "agents"), agents);
  // Project-level (higher priority, overwrites)
  // 项目级目录（优先级较高，会覆盖同名的用户级代理）：.claude/agents/
  loadAgentsFromDir(join(process.cwd(), ".claude", "agents"), agents);

  // 缓存结果
  cachedCustomAgents = agents;
  return agents;
}

// 从指定目录加载所有 .md 代理定义文件
// 参数：
//   dir —— 要扫描的目录路径
//   agents —— 目标 Map，解析出的代理会被写入（同名则覆盖）
function loadAgentsFromDir(dir: string, agents: Map<string, CustomAgentDef>): void {
  // 目录不存在则跳过
  if (!existsSync(dir)) return;
  let entries: string[];
  // 读取目录内容，失败则静默跳过
  try { entries = readdirSync(dir); } catch { return; }

  // 遍历目录中的每个条目
  for (const entry of entries) {
    // 只处理 Markdown 文件
    if (!entry.endsWith(".md")) continue;
    const filePath = join(dir, entry);
    try {
      // 读取文件原始内容
      const raw = readFileSync(filePath, "utf-8");
      // 解析 frontmatter 元数据和正文
      const { meta, body } = parseFrontmatter(raw);
      // 代理名称：优先使用 frontmatter 中的 name，否则用文件名（去掉 .md 后缀）
      const name = meta.name || entry.replace(/\.md$/, "");
      // 允许的工具列表：解析 frontmatter 中的 allowed-tools 字段（逗号分隔）
      const allowedTools = meta["allowed-tools"]
        ? meta["allowed-tools"].split(",").map((s: string) => s.trim())
        : undefined;
      // 将解析出的代理定义写入 Map
      agents.set(name, {
        name,
        description: meta.description || "",
        allowedTools,
        systemPrompt: body, // 正文作为系统提示词
      });
    } catch {} // 解析失败则静默跳过该文件
  }
}

// ─── Main config function ───────────────────────────────────
// ─── 主配置函数 ─────────────────────────────────────────────

// 根据代理类型获取子代理配置（系统提示词 + 可用工具）
// 参数：
//   type —— 代理类型名称（自定义类型优先，其次内置类型）
// 返回值：SubAgentConfig —— 包含系统提示词和工具列表的配置对象
export function getSubAgentConfig(type: SubAgentType): SubAgentConfig {
  // Check custom agents first
  // 优先检查自定义代理
  const custom = discoverCustomAgents().get(type);
  if (custom) {
    // 如果自定义代理指定了允许的工具列表，则只筛选这些工具
    // 否则使用除 agent（防止无限嵌套）外的所有工具
    const tools = custom.allowedTools
      ? toolDefinitions.filter((t) => custom.allowedTools!.includes(t.name))
      : toolDefinitions.filter((t) => t.name !== "agent");
    return { systemPrompt: custom.systemPrompt, tools };
  }

  // Built-in types
  // 内置类型匹配
  switch (type) {
    case "explore": // 探索模式：只读工具
      return { systemPrompt: EXPLORE_PROMPT, tools: getReadOnlyTools() };
    case "plan": // 规划模式：只读工具
      return { systemPrompt: PLAN_PROMPT, tools: getReadOnlyTools() };
    case "general": // 通用模式：除 agent 外的全部工具
    default: // 默认使用 general 配置
      return {
        systemPrompt: GENERAL_PROMPT,
        tools: toolDefinitions.filter((t) => t.name !== "agent"),
      };
  }
}

// ─── Available agent types (for system prompt) ──────────────
// ─── 可用代理类型（用于构建系统提示词）──────────────────────

// 获取所有可用的代理类型列表（内置 + 自定义）
// 返回值：{ name, description }[] —— 代理类型名称和描述的数组
export function getAvailableAgentTypes(): { name: string; description: string }[] {
  // 内置代理类型列表
  const types: { name: string; description: string }[] = [
    { name: "explore", description: "Fast, read-only codebase search and exploration" }, // 快速只读的代码库搜索与探索
    { name: "plan", description: "Read-only analysis with structured implementation plans" }, // 只读分析，产出结构化实现方案
    { name: "general", description: "Full tools for independent tasks" }, // 拥有完整工具集，用于独立任务
  ];

  // 追加自定义代理类型
  for (const [name, def] of discoverCustomAgents()) {
    types.push({ name, description: def.description });
  }

  return types;
}

// 构建自定义代理类型的描述文本（用于拼接到主系统提示词中）
// 返回值：string —— 如果没有自定义代理则返回空字符串，否则返回 Markdown 格式的描述
export function buildAgentDescriptions(): string {
  const types = getAvailableAgentTypes();
  // Only built-in types, already in system prompt
  // 仅内置类型时返回空字符串（内置类型已在系统提示词中硬编码）
  if (types.length <= 3) return "";

  // 从第4个开始都是自定义代理
  const custom = types.slice(3);
  const lines = ["\n# Custom Agent Types", ""]; // Markdown 标题
  for (const t of custom) {
    // 每个自定义代理渲染为一行 Markdown 列表项
    lines.push(`- **${t.name}**: ${t.description}`);
  }
  return lines.join("\n");
}

// Reset cache (for testing)
// 重置缓存（主要用于测试场景，强制下次重新扫描代理文件）
export function resetAgentCache(): void {
  cachedCustomAgents = null;
}
