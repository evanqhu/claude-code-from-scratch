// Skills system — discover, parse, and execute .claude/skills/*/SKILL.md
// 技能系统 —— 发现、解析并执行 .claude/skills/*/SKILL.md 文件
// Mirrors Claude Code's skill architecture: frontmatter metadata + prompt templates.
// 镜像 Claude Code 的技能架构：frontmatter 元数据 + 提示词模板

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
// 引入文件系统模块，用于读取文件、判断存在性、遍历目录
import { join, basename } from "path";
// 引入路径处理工具：join 拼接路径，basename 获取文件/目录名
import { homedir } from "os";
// 引入 os 模块，用于获取用户 home 目录（定位用户级技能）
import { parseFrontmatter } from "./frontmatter.js";
// 引入 frontmatter 解析工具，用于解析 SKILL.md 的 YAML 元数据头

// ─── Types ──────────────────────────────────────────────────
// ─── 类型定义 ──────────────────────────────────────────────────

/**
 * 技能定义结构
 * 描述一个技能的元数据、提示词模板以及执行方式。
 */
export interface SkillDefinition {
  name: string; // 技能名称
  description: string; // 技能描述
  whenToUse?: string; // 使用时机说明（可选）
  allowedTools?: string[]; // 该技能允许使用的工具列表（可选）
  userInvocable: boolean; // 是否可被用户通过 /<name> 直接调用
  context: "inline" | "fork";   // inline = inject into conversation, fork = run in sub-agent
  // context: "inline" | "fork";   // inline = 注入到当前对话中, fork = 在子代理中运行
  promptTemplate: string; // 技能的提示词模板（正文内容）
  source: "project" | "user"; // 技能来源：项目级或用户级
  skillDir: string; // 技能所在的目录路径
}

// ─── Discovery ──────────────────────────────────────────────
// ─── 技能发现（扫描并加载技能）──────────────────────────────

// 技能列表缓存，避免重复扫描文件系统
let cachedSkills: SkillDefinition[] | null = null;

/**
 * 发现并加载所有可用技能
 * 先加载用户级技能（优先级低），再加载项目级技能（优先级高，会覆盖同名用户级技能）。
 * 结果会被缓存，后续调用直接返回缓存。
 * @returns 技能定义数组
 */
export function discoverSkills(): SkillDefinition[] {
  if (cachedSkills) return cachedSkills; // 命中缓存则直接返回

  const skills = new Map<string, SkillDefinition>();

  // User-level skills (lower priority)
  // 用户级技能（优先级较低），位于 ~/.claude/skills
  const userDir = join(homedir(), ".claude", "skills");
  loadSkillsFromDir(userDir, "user", skills);

  // Project-level skills (higher priority, overwrites user-level)
  // 项目级技能（优先级较高，会覆盖同名的用户级技能），位于当前项目 .claude/skills
  const projectDir = join(process.cwd(), ".claude", "skills");
  loadSkillsFromDir(projectDir, "project", skills);

  cachedSkills = Array.from(skills.values()); // 缓存结果
  return cachedSkills;
}

/**
 * 从指定目录加载技能
 * 遍历目录下的子目录，每个包含 SKILL.md 的子目录视为一个技能。
 * @param baseDir - 技能根目录
 * @param source - 技能来源（user 或 project）
 * @param skills - 用于存储技能的 Map（以技能名为键，后加载的会覆盖先加载的）
 */
function loadSkillsFromDir(
  baseDir: string,
  source: "project" | "user",
  skills: Map<string, SkillDefinition>
): void {
  if (!existsSync(baseDir)) return; // 目录不存在则直接返回
  let entries: string[];
  try {
    entries = readdirSync(baseDir); // 读取目录内容
  } catch { return; } // 读取失败则返回

  for (const entry of entries) {
    const skillDir = join(baseDir, entry);
    try {
      if (!statSync(skillDir).isDirectory()) continue; // 跳过非目录项
    } catch { continue; }
    const skillFile = join(skillDir, "SKILL.md"); // 技能定义文件路径
    if (!existsSync(skillFile)) continue; // 缺少 SKILL.md 则跳过

    const skill = parseSkillFile(skillFile, source, skillDir);
    if (skill) skills.set(skill.name, skill); // 存入 Map，同名会覆盖
  }
}

/**
 * 解析单个 SKILL.md 文件为技能定义
 * 读取文件内容，解析 frontmatter 元数据和正文，构造 SkillDefinition。
 * @param filePath - SKILL.md 文件路径
 * @param source - 技能来源
 * @param skillDir - 技能所在目录
 * @returns 技能定义对象；解析失败时返回 null
 */
function parseSkillFile(
  filePath: string,
  source: "project" | "user",
  skillDir: string
): SkillDefinition | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const { meta, body } = parseFrontmatter(raw); // 解析 frontmatter 和正文

    const name = meta.name || basename(skillDir) || "unknown"; // 名称：优先 frontmatter，其次目录名
    const userInvocable = meta["user-invocable"] !== "false"; // 默认可被用户调用
    const context = meta.context === "fork" ? "fork" as const : "inline" as const; // 默认 inline

    // Parse allowed-tools (comma or JSON array format)
    // 解析 allowed-tools 字段（支持逗号分隔或 JSON 数组两种格式）
    let allowedTools: string[] | undefined;
    if (meta["allowed-tools"]) {
      const raw = meta["allowed-tools"];
      if (raw.startsWith("[")) {
        // 以方括号开头，尝试按 JSON 数组解析；失败则作为逗号分隔处理
        try { allowedTools = JSON.parse(raw); } catch {
          allowedTools = raw.replace(/[\[\]]/g, "").split(",").map((s) => s.trim());
        }
      } else {
        // 否则按逗号分隔处理
        allowedTools = raw.split(",").map((s) => s.trim());
      }
    }

    return {
      name,
      description: meta.description || "",
      whenToUse: meta.when_to_use || meta["when-to-use"], // 兼容下划线和连字符两种命名
      allowedTools,
      userInvocable,
      context,
      promptTemplate: body, // 正文作为提示词模板
      source,
      skillDir,
    };
  } catch {
    return null; // 读取或解析失败时返回 null
  }
}

// ─── Resolution ─────────────────────────────────────────────
// ─── 技能解析与执行 ─────────────────────────────────────────

/**
 * 根据名称获取技能定义
 * @param name - 技能名称
 * @returns 技能定义；未找到时返回 null
 */
export function getSkillByName(name: string): SkillDefinition | null {
  return discoverSkills().find((s) => s.name === name) || null;
}

/**
 * 解析技能的提示词模板，替换其中的占位符
 * 将 $ARGUMENTS / ${ARGUMENTS} 替换为传入的参数，
 * 将 ${CLAUDE_SKILL_DIR} 替换为技能所在目录路径。
 * @param skill - 技能定义
 * @param args - 传入的参数字符串
 * @returns 替换后的提示词
 */
export function resolveSkillPrompt(skill: SkillDefinition, args: string): string {
  let prompt = skill.promptTemplate;
  // Replace $ARGUMENTS and ${ARGUMENTS}
  // 替换参数占位符（支持 $ARGUMENTS 和 ${ARGUMENTS} 两种写法）
  prompt = prompt.replace(/\$ARGUMENTS|\$\{ARGUMENTS\}/g, args);
  // Replace ${CLAUDE_SKILL_DIR}
  // 替换技能目录占位符
  prompt = prompt.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skill.skillDir);
  return prompt;
}

/**
 * 执行指定技能
 * 根据技能名查找技能，解析提示词模板，返回执行所需的全部信息。
 * @param skillName - 技能名称
 * @param args - 传入技能的参数字符串
 * @returns 包含提示词、允许工具和上下文模式的对象；技能不存在时返回 null
 */
export function executeSkill(
  skillName: string,
  args: string
): { prompt: string; allowedTools?: string[]; context: "inline" | "fork" } | null {
  const skill = getSkillByName(skillName);
  if (!skill) return null; // 技能不存在则返回 null
  return {
    prompt: resolveSkillPrompt(skill, args),
    allowedTools: skill.allowedTools,
    context: skill.context,
  };
}

// ─── System prompt section ──────────────────────────────────
// ─── 系统提示词段落（向 AI 描述可用技能）─────────────────────

/**
 * 构建技能描述的系统提示词段落
 * 将所有技能分类（用户可调用 / 自动调用）并格式化，
 * 供 AI 在系统提示词中了解可用的技能及其使用方式。
 * @returns 技能描述字符串；无技能时返回空字符串
 */
export function buildSkillDescriptions(): string {
  const skills = discoverSkills();
  if (skills.length === 0) return ""; // 没有技能则返回空

  const lines = ["# Available Skills", ""];
  // 按是否可被用户调用进行分类
  const invocable = skills.filter((s) => s.userInvocable); // 用户可调用技能
  const autoOnly = skills.filter((s) => !s.userInvocable); // 仅自动调用技能

  if (invocable.length > 0) {
    lines.push("User-invocable skills (user types /<name> to invoke):");
    for (const s of invocable) {
      lines.push(`- **/${s.name}**: ${s.description}`);
      if (s.whenToUse) lines.push(`  When to use: ${s.whenToUse}`); // 附带使用时机
    }
    lines.push("");
  }

  if (autoOnly.length > 0) {
    lines.push("Auto-invocable skills (use the skill tool when appropriate):");
    for (const s of autoOnly) {
      lines.push(`- **${s.name}**: ${s.description}`);
      if (s.whenToUse) lines.push(`  When to use: ${s.whenToUse}`);
    }
    lines.push("");
  }

  lines.push(
    "To invoke a skill programmatically, use the `skill` tool with the skill name and optional arguments."
  );
  return lines.join("\n");
}

// Reset cache (useful for testing)
// 重置技能缓存（在测试时非常有用，可强制重新扫描技能）
export function resetSkillCache(): void {
  cachedSkills = null; // 清空缓存，下次调用 discoverSkills 会重新扫描
}
