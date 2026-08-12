// 文件系统操作：读取、写入、判断存在性、创建目录、读取目录、获取文件状态
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
// 子进程操作：execSync 同步执行命令（继承shell），execFileSync 同步执行指定文件（不经过shell，更安全）
import { execSync, execFileSync } from "child_process";
// glob 模式匹配库：用于按通配符模式查找文件
import { glob } from "glob";
// 路径处理工具：dirname 目录名、join 拼接、basename 文件名、extname 扩展名、resolve 绝对路径
import { dirname, join, basename, extname, resolve } from "path";
// os 模块：homedir 获取用户主目录（用于定位 ~/.claude/settings.json）
import { homedir } from "os";

// 判断当前操作系统是否为 Windows（影响 shell 命令和 grep 的选择）
const isWin = process.platform === "win32";
// 从 memory 模块导入获取记忆目录的函数（用于写入记忆文件时自动更新索引）
import { getMemoryDir } from "./memory.js";
// Anthropic SDK 的类型定义（用于工具的 input_schema 类型）
import type Anthropic from "@anthropic-ai/sdk";
// Note: skill execution is handled in agent.ts (supports fork mode)
// 注意：skill 的执行在 agent.ts 中处理（支持 fork 模式）

// ─── Permission modes ──────────────────────────────────────
// ─── 权限模式 ──────────────────────────────────────────────
// Five permission modes inspired by common Coding Agent permission UX patterns.
// 五种权限模式，灵感来自常见的编程 Agent 权限交互模式。

/** 权限模式类型：
 *  - default: 默认模式，危险操作需确认
 *  - plan: 计划模式，只读（仅可写计划文件）
 *  - acceptEdits: 自动批准文件编辑
 *  - bypassPermissions: 跳过所有确认（--yolo）
 *  - dontAsk: 非交互模式，需确认的操作自动拒绝
 *  - auto: 自动模式（由 LLM 分类器决定） */
export type PermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk" | "auto";

// 只读工具集合：这些工具在所有模式下都自动允许（无副作用）
const READ_TOOLS = new Set(["read_file", "list_files", "grep_search", "web_fetch"]);
// 编辑工具集合：write_file 和 edit_file
const EDIT_TOOLS = new Set(["write_file", "edit_file"]);

// Concurrency-safe tools can run in parallel (read-only, no side effects)
// 并发安全工具可以并行运行（只读，无副作用）
export const CONCURRENCY_SAFE_TOOLS = new Set(["read_file", "list_files", "grep_search", "web_fetch"]);

// Tool definition type for Claude API (with optional deferred flag)
// Claude API 的工具定义类型（带可选的 deferred 延迟加载标志）
// deferred=true 的工具只发送名称（节省 token），需要通过 tool_search 激活后才发送完整 schema
export type ToolDef = Anthropic.Tool & { deferred?: boolean };

// ─── Tool definitions ───────────────────────────────────────
// ─── 工具定义 ───────────────────────────────────────────────
// 以下定义了所有可供模型调用的工具及其 JSON Schema（输入参数规范）

// 工具定义数组：每个工具包含名称、描述和输入参数的 JSON Schema
export const toolDefinitions: ToolDef[] = [
  // ─── 读取文件工具 ───
  {
    name: "read_file",
    description:
      "Read the contents of a file. Returns the file content with line numbers.",
    input_schema: {
      type: "object" as const,
      properties: {
        // 要读取的文件路径
        file_path: {
          type: "string",
          description: "The path to the file to read",
        },
      },
      required: ["file_path"],
    },
  },
  // ─── 写入文件工具 ───
  {
    name: "write_file",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does.",
    input_schema: {
      type: "object" as const,
      properties: {
        // 要写入的文件路径
        file_path: {
          type: "string",
          description: "The path to the file to write",
        },
        // 要写入的文件内容
        content: {
          type: "string",
          description: "The content to write to the file",
        },
      },
      required: ["file_path", "content"],
    },
  },
  // ─── 编辑文件工具（精确字符串替换）───
  {
    name: "edit_file",
    description:
      "Edit a file by replacing an exact string match with new content. The old_string must match exactly (including whitespace and indentation).",
    input_schema: {
      type: "object" as const,
      properties: {
        // 要编辑的文件路径
        file_path: {
          type: "string",
          description: "The path to the file to edit",
        },
        // 要查找并替换的原始字符串（必须精确匹配，包括空白和缩进）
        old_string: {
          type: "string",
          description: "The exact string to find and replace",
        },
        // 替换后的新字符串
        new_string: {
          type: "string",
          description: "The string to replace it with",
        },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
  // ─── 列出文件工具（glob 模式匹配）───
  {
    name: "list_files",
    description:
      "List files matching a glob pattern. Returns matching file paths.",
    input_schema: {
      type: "object" as const,
      properties: {
        // glob 匹配模式，如 "**/*.ts"、"src/**/*"
        pattern: {
          type: "string",
          description:
            'Glob pattern to match files (e.g., "**/*.ts", "src/**/*")',
        },
        // 搜索的基础目录，默认为当前目录
        path: {
          type: "string",
          description:
            "Base directory to search from. Defaults to current directory.",
        },
      },
      required: ["pattern"],
    },
  },
  // ─── 正则搜索工具 ───
  {
    name: "grep_search",
    description:
      "Search for a pattern in files. Returns matching lines with file paths and line numbers.",
    input_schema: {
      type: "object" as const,
      properties: {
        // 要搜索的正则表达式模式
        pattern: {
          type: "string",
          description: "The regex pattern to search for",
        },
        // 搜索的目录或文件，默认为当前目录
        path: {
          type: "string",
          description: "Directory or file to search in. Defaults to current directory.",
        },
        // 文件名通配符过滤，如 "*.ts"、"*.py"
        include: {
          type: "string",
          description:
            'File glob pattern to include (e.g., "*.ts", "*.py")',
        },
      },
      required: ["pattern"],
    },
  },
  // ─── 执行 Shell 命令工具 ───
  {
    name: "run_shell",
    description:
      "Execute a shell command and return its output. Use this for running tests, installing packages, git operations, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        // 要执行的 shell 命令
        command: {
          type: "string",
          description: "The shell command to execute",
        },
        // 超时时间（毫秒），默认 30000
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (default: 30000)",
        },
      },
      required: ["command"],
    },
  },
  // ─── Skill tool ─────────────────────────────────────────────
  // ─── 技能工具 ─────────────────────────────────────────────────
  {
    name: "skill",
    description:
      "Invoke a registered skill by name. Skills are prompt templates loaded from .claude/skills/. Returns the skill's resolved prompt to follow.",
    input_schema: {
      type: "object" as const,
      properties: {
        // 要调用的技能名称
        skill_name: {
          type: "string",
          description: "The name of the skill to invoke",
        },
        // 传给技能的可选参数
        args: {
          type: "string",
          description: "Optional arguments to pass to the skill",
        },
      },
      required: ["skill_name"],
    },
  },
  // ─── Web fetch tool ──────────────────────────────────────────
  // ─── 网络抓取工具 ──────────────────────────────────────────────
  {
    name: "web_fetch",
    description:
      "Fetch a URL and return its content as text. For HTML pages, tags are stripped to return readable text. For JSON/text responses, content is returned directly.",
    input_schema: {
      type: "object" as const,
      properties: {
        // 要抓取的 URL 地址
        url: { type: "string", description: "The URL to fetch" },
        // 最大返回内容长度（字符数），默认 50000
        max_length: {
          type: "number",
          description: "Maximum content length in characters (default 50000)",
        },
      },
      required: ["url"],
    },
  },
  // ─── Plan mode tools ────────────────────────────────────────
  // ─── 计划模式工具 ────────────────────────────────────────────
  // 这两个工具是延迟加载的（deferred: true），需要通过 tool_search 激活
  {
    name: "enter_plan_mode",
    description:
      "Enter plan mode to switch to a read-only planning phase. In plan mode, you can only read files and write to the plan file. Use this when you need to explore the codebase and design an implementation plan before making changes.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
    deferred: true,  // 延迟加载：节省 token，需 tool_search 激活
  },
  {
    name: "exit_plan_mode",
    description:
      "Exit plan mode after you have finished writing your plan to the plan file. The user will review and approve the plan before you proceed with implementation.",
    input_schema: {
      type: "object" as const,
      properties: {},
    },
    deferred: true,  // 延迟加载：节省 token，需 tool_search 激活
  },
  // ─── Agent tool ─────────────────────────────────────────────
  // ─── 子代理工具 ─────────────────────────────────────────────
  {
    name: "agent",
    description:
      "Launch a sub-agent to handle a task autonomously. Sub-agents have isolated context and return their result. Types: 'explore' (read-only, fast search), 'plan' (read-only, structured planning), 'general' (full tools).",
    input_schema: {
      type: "object" as const,
      properties: {
        // 子代理任务的简短描述（3-5个词）
        description: {
          type: "string",
          description: "Short (3-5 word) description of the sub-agent's task",
        },
        // 子代理的详细任务指令
        prompt: {
          type: "string",
          description: "Detailed task instructions for the sub-agent",
        },
        // 代理类型：explore（只读搜索）、plan（只读规划）、general（全功能）
        type: {
          type: "string",
          enum: ["explore", "plan", "general"],
          description: "Agent type: explore (read-only), plan (planning), general (full tools). Default: general",
        },
      },
      required: ["description", "prompt"],
    },
  },
  // ─── Tool search (deferred tool loader) ─────────────────────
  // ─── 工具搜索（延迟工具加载器）─────────────────────────────
  {
    name: "tool_search",
    description:
      "Search for available tools by name or keyword. Returns full schema definitions for matching deferred tools so you can use them.",
    input_schema: {
      type: "object" as const,
      properties: {
        // 工具名称或搜索关键词
        query: { type: "string", description: "Tool name or search keywords" },
      },
      required: ["query"],
    },
  },
];

// ─── Deferred tool activation ───────────────────────────────
// ─── 延迟工具激活 ───────────────────────────────────────────
// Deferred tools only send their name (not schema) to save tokens.
// When the model calls tool_search, matching tools get activated
// and their full schemas are included in subsequent API calls.
// 延迟工具只发送名称（不发送 schema）以节省 token。
// 当模型调用 tool_search 时，匹配的工具会被激活，
// 其完整 schema 会包含在后续的 API 调用中。

// 已激活的延迟工具名称集合
const activatedTools = new Set<string>();

/** 重置已激活的工具集合（清空所有已激活的延迟工具）。用于测试或新会话开始时。 */
export function resetActivatedTools(): void {
  activatedTools.clear();
}

/** 获取当前活跃的工具定义列表（用于发送给 API）。
 *  非延迟工具始终包含；延迟工具仅在已激活时包含。
 *  返回时会剥离内部的 deferred 标志（API 不需要此字段）。
 *  @param allTools - 可选的自定义工具列表，默认使用 toolDefinitions
 *  @returns 符合 Anthropic.Tool 格式的工具数组 */
export function getActiveToolDefinitions(allTools?: ToolDef[]): Anthropic.Tool[] {
  const tools = allTools || toolDefinitions;
  return tools
    .filter(t => !t.deferred || activatedTools.has(t.name))  // 非延迟或已激活
    .map(({ deferred, ...rest }) => rest);  // 剥离 deferred 标志
}

/** 获取尚未激活的延迟工具名称列表（用于提示模型可以通过 tool_search 发现更多工具）。
 *  @param allTools - 可选的自定义工具列表，默认使用 toolDefinitions
 *  @returns 尚未激活的延迟工具名称数组 */
export function getDeferredToolNames(allTools?: ToolDef[]): string[] {
  const tools = allTools || toolDefinitions;
  return tools
    .filter(t => t.deferred && !activatedTools.has(t.name))  // 延迟且未激活
    .map(t => t.name);
}

// ─── Tool execution ─────────────────────────────────────────
// ─── 工具执行 ─────────────────────────────────────────────────

/** 读取文件内容并添加行号。
 *  @param input.file_path - 要读取的文件路径
 *  @returns 带行号格式的文件内容，或错误信息 */
function readFile(input: { file_path: string }): string {
  try {
    const content = readFileSync(input.file_path, "utf-8");  // 同步读取文件，UTF-8 编码
    const lines = content.split("\n");  // 按换行符分割成行数组
    // 为每行添加行号前缀（右对齐，宽度4），格式如 "   1 | 内容"
    const numbered = lines
      .map((line, i) => `${String(i + 1).padStart(4)} | ${line}`)
      .join("\n");
    return numbered;
  } catch (e: any) {
    return `Error reading file: ${e.message}`;  // 读取失败返回错误信息
  }
}

/** 写入内容到文件。如果目录不存在会自动创建。
 *  @param input.file_path - 目标文件路径
 *  @param input.content - 要写入的内容
 *  @returns 成功信息（含内容预览）或错误信息 */
function writeFile(input: { file_path: string; content: string }): string {
  try {
    const dir = dirname(input.file_path);  // 获取目标目录
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });  // 目录不存在则递归创建
    writeFileSync(input.file_path, input.content);  // 同步写入文件
    // Auto-update memory index when writing to memory directory
    // 写入记忆目录时自动更新记忆索引
    autoUpdateMemoryIndex(input.file_path);
    // Return content preview for UI display
    // 返回内容预览供 UI 显示
    const lines = input.content.split("\n");  // 分割行用于预览
    const lineCount = lines.length;  // 总行数
    // 生成前30行的预览（带行号）
    const preview = lines.slice(0, 30).map((l, i) =>
      `${String(i + 1).padStart(4)} | ${l}`
    ).join("\n");
    // 超过30行则显示截断提示
    const truncNote = lineCount > 30 ? `\n  ... (${lineCount} lines total)` : "";
    return `Successfully wrote to ${input.file_path} (${lineCount} lines)\n\n${preview}${truncNote}`;
  } catch (e: any) {
    return `Error writing file: ${e.message}`;  // 写入失败返回错误信息
  }
}

/** 当写入记忆目录中的 .md 文件时，自动重建 MEMORY.md 索引文件。
 *  索引会扫描所有记忆文件，提取 name/type/description 元数据并生成目录列表。
 *  @param filePath - 刚写入的文件路径 */
function autoUpdateMemoryIndex(filePath: string): void {
  try {
    const memDir = getMemoryDir();  // 获取记忆目录路径
    // 仅当文件在记忆目录内、是 .md 文件、且不是 MEMORY.md 本身时才更新索引
    if (filePath.startsWith(memDir) && filePath.endsWith(".md") && !filePath.endsWith("MEMORY.md")) {
      // Rebuild the index from all memory files. NOTE: must use the ESM
      // import from the top of this file — `require()` does not exist at
      // runtime in ESM, and the throw was silently swallowed by the outer
      // catch, so the index was never rebuilt.
      // 从所有记忆文件重建索引。注意：必须使用本文件顶部的 ESM 导入——
      // `require()` 在 ESM 运行时中不存在，且抛出的异常被外层 catch 静默吞掉，
      // 导致索引从未被重建。
      // 读取记忆目录中所有 .md 文件（排除 MEMORY.md 索引文件本身）
      const files = readdirSync(memDir).filter(
        (f: string) => f.endsWith(".md") && f !== "MEMORY.md"
      );
      const lines = ["# Memory Index", ""];  // 索引文件标题
      for (const file of files) {
        try {
          const raw = readFileSync(join(memDir, file), "utf-8");  // 读取记忆文件内容
          // 从 frontmatter 中提取 name/type/description 元数据
          const nameMatch = raw.match(/^name:\s*(.+)$/m);
          const typeMatch = raw.match(/^type:\s*(.+)$/m);
          const descMatch = raw.match(/^description:\s*(.+)$/m);
          if (nameMatch && typeMatch) {
            // 格式化为 Markdown 列表项，包含名称链接、类型和描述
            lines.push(`- **[${nameMatch[1].trim()}](${file})** (${typeMatch[1].trim()}) — ${descMatch?.[1]?.trim() || ""}`);
          }
        } catch { /* skip */ }  // 单个文件读取失败则跳过
      }
      writeFileSync(join(memDir, "MEMORY.md"), lines.join("\n"));  // 写入更新后的索引
    }
  } catch { /* non-critical */ }  // 索引更新失败不影响主流程
}

// ─── Edit helpers: quote normalization + diff ───────────────
// ─── 编辑辅助：引号归一化 + diff 生成 ───────────────────────

/** 将弯引号（curly quotes）和撇号（prime）归一化为直引号。
 *  处理模型可能输出的 Unicode 弯引号，使其能与文件中的直引号匹配。
 *  @param s - 待归一化的字符串
 *  @returns 引号归一化后的字符串 */
function normalizeQuotes(s: string): string {
  return s
    .replace(/[\u2018\u2019\u2032]/g, "'")   // curly single quotes, prime
                                             // 弯单引号（左右）、撇号 → 直单引号
    .replace(/[\u201C\u201D\u2033]/g, '"');   // curly double quotes, double prime
                                              // 弯双引号（左右）、双撇号 → 直双引号
}

/** 在文件内容中查找实际匹配的字符串。
 *  先尝试精确匹配（最快），失败后再尝试引号归一化匹配。
 *  @param fileContent - 文件内容
 *  @param searchString - 要搜索的字符串
 *  @returns 匹配到的实际字符串（可能因引号归一化而与输入不同），或 null */
function findActualString(fileContent: string, searchString: string): string | null {
  // Direct match first (cheapest)
  // 先尝试直接精确匹配（开销最小）
  if (fileContent.includes(searchString)) return searchString;
  // Try with normalized quotes
  // 尝试引号归一化后匹配
  const normSearch = normalizeQuotes(searchString);  // 归一化搜索字符串
  const normFile = normalizeQuotes(fileContent);  // 归一化文件内容
  const idx = normFile.indexOf(normSearch);  // 在归一化后的内容中查找
  if (idx !== -1) return fileContent.substring(idx, idx + searchString.length);  // 返回原始文件中对应位置的子串
  return null;  // 未找到
}

/** 生成类 unified diff 格式的差异输出。
 *  @param oldContent - 修改前的完整文件内容
 *  @param _newContent - 修改后的完整文件内容（未使用，保留参数以匹配签名）
 *  @param oldString - 被替换的原始字符串
 *  @param newString - 替换后的新字符串
 *  @returns 格式化的 diff 字符串 */
function generateDiff(
  oldContent: string, _newContent: string,
  oldString: string, newString: string
): string {
  // 计算变更起始行号：统计被替换字符串之前的换行符数量
  const beforeChange = oldContent.split(oldString)[0];
  const lineNum = (beforeChange.match(/\n/g) || []).length + 1;
  const oldLines = oldString.split("\n");  // 旧内容按行分割
  const newLines = newString.split("\n");  // 新内容按行分割

  // 生成 diff 头部：@@ -旧行号,旧行数 +新行号,新行数 @@
  const parts: string[] = [`@@ -${lineNum},${oldLines.length} +${lineNum},${newLines.length} @@`];
  // Show removed lines
  // 显示被删除的行（前缀 -）
  for (const l of oldLines) parts.push(`- ${l}`);
  // Show added lines
  // 显示新增的行（前缀 +）
  for (const l of newLines) parts.push(`+ ${l}`);

  return parts.join("\n");  // 用换行符拼接
}

/** 编辑文件：精确字符串替换。
 *  要求 old_string 唯一匹配（多次匹配会报错）。
 *  支持引号归一化回退匹配。
 *  @param input.file_path - 文件路径
 *  @param input.old_string - 要替换的字符串
 *  @param input.new_string - 替换后的字符串
 *  @returns 成功信息（含 diff）或错误信息 */
function editFile(input: {
  file_path: string;
  old_string: string;
  new_string: string;
}): string {
  try {
    const content = readFileSync(input.file_path, "utf-8");  // 读取当前文件内容

    // Find the actual string (with quote normalization fallback)
    // 查找实际匹配的字符串（带引号归一化回退）
    const actual = findActualString(content, input.old_string);
    if (!actual) {
      return `Error: old_string not found in ${input.file_path}`;  // 未找到匹配
    }

    // 统计匹配次数：用 split 计算子串出现次数
    const count = content.split(actual).length - 1;
    if (count > 1)
      return `Error: old_string found ${count} times in ${input.file_path}. Must be unique.`;  // 多次匹配，要求唯一

    // Use split/join to avoid $ special chars in String.replace()
    // 使用 split/join 而非 String.replace()，避免 replacement 字符串中的 $ 被当作特殊字符
    const newContent = content.split(actual).join(input.new_string);  // 全局替换
    writeFileSync(input.file_path, newContent);  // 写入修改后的内容

    // Generate diff for result
    // 为结果生成 diff
    const diff = generateDiff(content, newContent, actual, input.new_string);
    // 如果通过引号归一化匹配，添加提示
    const quoteNote = actual !== input.old_string ? " (matched via quote normalization)" : "";
    return `Successfully edited ${input.file_path}${quoteNote}\n\n${diff}`;
  } catch (e: any) {
    return `Error editing file: ${e.message}`;  // 编辑失败返回错误信息
  }
}

/** 列出匹配 glob 模式的文件。
 *  @param input.pattern - glob 匹配模式
 *  @param input.path - 搜索基础目录（可选）
 *  @returns 匹配的文件路径列表，或提示信息/错误信息 */
async function listFiles(input: {
  pattern: string;
  path?: string;
}): Promise<string> {
  try {
    // 使用 glob 库异步匹配文件
    const files = await glob(input.pattern, {
      cwd: input.path || process.cwd(),  // 工作目录
      nodir: true,  // 不包含目录，仅文件
      ignore: ["node_modules/**", ".git/**"],  // 忽略 node_modules 和 .git
    });
    if (files.length === 0) return "No files found matching the pattern.";  // 无匹配
    // 最多返回200个文件，超出则提示剩余数量
    return files.slice(0, 200).join("\n") +
      (files.length > 200 ? `\n... and ${files.length - 200} more` : "");
  } catch (e: any) {
    return `Error listing files: ${e.message}`;  // 出错返回错误信息
  }
}

/** 在文件中搜索正则模式。优先使用系统 grep（更快），Windows 上用纯 JS 实现。
 *  @param input.pattern - 正则表达式模式
 *  @param input.path - 搜索目录或文件（可选）
 *  @param input.include - 文件名通配符过滤（可选）
 *  @returns 匹配的行（含路径和行号），或提示信息/错误信息 */
function grepSearch(input: {
  pattern: string;
  path?: string;
  include?: string;
}): string {
  // Try system grep first (available on Linux/macOS and Windows with Git in PATH)
  // 首先尝试系统 grep（Linux/macOS 自带，Windows 需 PATH 中有 Git）
  if (!isWin) {
    try {
      // 构建 grep 命令参数
      const args = ["--line-number", "--color=never", "-r"];  // 显示行号、无颜色、递归
      if (input.include) args.push(`--include=${input.include}`);  // 文件名过滤
      args.push("--", input.pattern);  // 搜索模式（-- 表示后面都是参数而非选项）
      args.push(input.path || ".");  // 搜索路径，默认当前目录
      // 同步执行 grep 命令
      const result = execFileSync("grep", args, {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,  // 最大缓冲区 10MB
        timeout: 10000,  // 超时 10 秒
      });
      const lines = result.split("\n").filter(Boolean);  // 分割并过滤空行
      // 最多返回100条匹配
      return lines.slice(0, 100).join("\n") +
        (lines.length > 100 ? `\n... and ${lines.length - 100} more matches` : "");
    } catch (e: any) {
      if (e.status === 1) return "No matches found.";  // grep 退出码1表示无匹配（非错误）
      if (e.code === "ENOBUFS") {
        // Huge match sets overflow the exec buffer before we can slice —
        // return a usable error instead of a bare spawn failure.
        // 海量匹配结果在切片前就溢出了执行缓冲区——
        // 返回可用的错误信息而非裸的 spawn 失败。
        return "Error: too many matches to buffer; narrow the pattern, path, or include filter.";
      }
      return `Error: ${e.message}`;  // 其他错误
    }
  }
  // Pure JS fallback for Windows
  // Windows 上的纯 JS 回退实现
  return grepJS(input.pattern, input.path || ".", input.include);
}

/** 纯 JavaScript 实现的 grep（Windows 回退方案）。
 *  递归遍历目录，逐文件逐行匹配正则表达式。
 *  @param pattern - 正则表达式模式字符串
 *  @param dir - 搜索的起始目录
 *  @param include - 可选的文件名通配符过滤（如 "*.ts"）
 *  @returns 匹配结果字符串 */
function grepJS(pattern: string, dir: string, include?: string): string {
  let re: RegExp;
  try {
    re = new RegExp(pattern);  // 编译正则表达式
  } catch (e: any) {
    // A model-supplied bad regex must come back as a tool error string,
    // not crash the agent loop.
    // 模型提供的错误正则必须作为工具错误字符串返回，
    // 而非导致 agent 循环崩溃。
    return `Error: invalid regex pattern: ${e.message}`;
  }
  // 将文件名通配符（* ?）转换为正则表达式
  const includeRe = include ? new RegExp(include.replace(/\*/g, ".*").replace(/\?/g, ".")) : null;
  const matches: string[] = [];  // 收集匹配结果
  let extra = 0;  // 记录被省略的匹配数
  // 递归遍历目录的内部函数
  function walk(d: string) {
    let entries: string[];
    try { entries = readdirSync(d); } catch { return; }  // 读取目录失败则跳过
    for (const name of entries) {
      if (name.startsWith(".") || name === "node_modules") continue;  // 跳过隐藏文件和 node_modules
      const full = join(d, name);  // 拼接完整路径
      let st;
      try { st = statSync(full); } catch { continue; }  // 获取文件状态失败则跳过
      if (st.isDirectory()) { walk(full); continue; }  // 目录则递归
      if (includeRe && !includeRe.test(name)) continue;  // 不匹配文件名过滤则跳过
      try {
        const text = readFileSync(full, "utf-8");  // 读取文件内容
        const lines = text.split("\n");  // 按行分割
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            // Show at most 100 matches, but keep counting so the model
            // knows how many were omitted.
            // 最多显示100条匹配，但继续计数让模型知道省略了多少条。
            if (matches.length < 100) matches.push(`${full}:${i + 1}:${lines[i]}`);  // 格式：路径:行号:内容
            else extra++;  // 超过100条只计数
          }
        }
      } catch {}  // 读取文件失败静默跳过
    }
  }
  walk(dir);  // 从起始目录开始遍历
  if (matches.length === 0) return "No matches found.";  // 无匹配
  return matches.join("\n") +
    (extra ? `\n... and ${extra} more matches` : "");  // 拼接结果，有省略则提示
}

/** 执行 shell 命令并返回输出。
 *  @param input.command - 要执行的命令
 *  @param input.timeout - 超时时间（毫秒，默认30000）
 *  @returns 命令输出，或超时/失败信息 */
function runShell(input: { command: string; timeout?: number }): string {
  try {
    // 同步执行命令
    const result = execSync(input.command, {
      encoding: "utf-8",
      maxBuffer: 5 * 1024 * 1024,  // 最大缓冲区 5MB
      timeout: input.timeout || 30000,  // 超时时间
      stdio: ["pipe", "pipe", "pipe"],  // 管道捕获标准输入/输出/错误
      shell: isWin ? "powershell.exe" : "/bin/sh",  // Windows 用 PowerShell，其他用 sh
    });
    return result || "(no output)";  // 空输出时返回提示
  } catch (e: any) {
    const stderr = e.stderr ? `\nStderr: ${e.stderr}` : "";  // 提取标准错误
    const stdout = e.stdout ? `\nStdout: ${e.stdout}` : "";  // 提取标准输出
    // Timeout kills leave status null — report it as a timeout like the
    // Python version instead of "exit code null"
    // 超时杀死进程后 status 为 null——像 Python 版本那样报告为超时，
    // 而非"退出码 null"
    if (e.code === "ETIMEDOUT" || (e.signal === "SIGTERM" && e.status === null)) {
      return `Command timed out after ${input.timeout || 30000}ms${stdout}${stderr}`;
    }
    return `Command failed (exit code ${e.status})${stdout}${stderr}`;  // 其他失败
  }
}

// ─── Dangerous command patterns ─────────────────────────────
// ─── 危险命令模式 ─────────────────────────────────────────────
// 用于检测 shell 命令中的危险操作，触发时需要用户确认

// 危险命令的正则模式列表：匹配到任一模式则标记为危险
const DANGEROUS_PATTERNS = [
  /\brm\s/,                              // rm 删除文件/目录
  /\bgit\s+(push|reset|clean|checkout\s+\.)/,  // git 危险操作：推送、重置、清理、检出覆盖
  /\bsudo\b/,                            // sudo 提权执行
  /\bmkfs\b/,                            // mkfs 格式化文件系统
  /\bdd\s/,                              // dd 磁盘级读写
  />\s*\/dev\//,                         // 重定向写入 /dev/ 设备文件
  /\bkill\b/,                            // kill 终止进程
  /\bpkill\b/,                           // pkill 按名称终止进程
  /\breboot\b/,                          // reboot 重启系统
  /\bshutdown\b/,                        // shutdown 关机
  // Windows dangerous commands
  // Windows 危险命令
  /\bdel\s/i,                            // del 删除文件
  /\brmdir\s/i,                          // rmdir 删除目录
  /\bformat\s/i,                         // format 格式化
  /\btaskkill\s/i,                       // taskkill 终止进程
  /\bRemove-Item\s/i,                    // PowerShell Remove-Item 删除
  /\bStop-Process\s/i,                   // PowerShell Stop-Process 终止进程
];

/** 检查命令是否匹配危险模式。
 *  @param command - 待检查的 shell 命令
 *  @returns true 表示命令包含危险操作 */
export function isDangerous(command: string): boolean {
  return DANGEROUS_PATTERNS.some((p) => p.test(command));
}

// ─── Permission rules (.claude/settings.json) ───────────────
// ─── 权限规则（.claude/settings.json）──────────────────────
// 支持从用户级和项目级 settings.json 加载 allow/deny 规则

/** 解析后的单条权限规则 */
interface ParsedRule {
  /** 规则适用的工具名称，如 "run_shell"、"write_file" */
  tool: string;
  /** 可选的模式字符串（如通配符路径或命令前缀），null 表示匹配该工具的所有调用 */
  pattern: string | null;
}

/** 权限规则集合 */
interface PermissionRules {
  /** 允许规则列表（匹配则自动放行） */
  allow: ParsedRule[];
  /** 拒绝规则列表（匹配则阻止，优先级高于 allow） */
  deny: ParsedRule[];
}

// 权限规则缓存：避免每次调用都重新读取和解析 settings.json
let cachedRules: PermissionRules | null = null;

/** 解析单条规则字符串为 ParsedRule 结构。
 *  支持两种格式：
 *    - "tool(pattern)" —— 带模式参数，如 run_shell(npm test*)
 *    - "tool" —— 无模式，匹配该工具的所有调用
 *  @param rule - 规则字符串
 *  @returns 解析后的 ParsedRule */
function parseRule(rule: string): ParsedRule {
  const match = rule.match(/^([a-z_]+)\((.+)\)$/);  // 匹配 tool(pattern) 格式
  if (match) {
    return { tool: match[1], pattern: match[2] };  // 提取工具名和模式
  }
  return { tool: rule, pattern: null };  // 无模式的简单格式
}

/** 加载 settings.json 文件并解析为对象。
 *  @param filePath - settings.json 文件路径
 *  @returns 解析后的配置对象，文件不存在或解析失败返回 null */
function loadSettings(filePath: string): any {
  if (!existsSync(filePath)) return null;  // 文件不存在返回 null
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));  // 读取并解析 JSON
  } catch { return null; }  // 解析失败返回 null
}

/** 加载权限规则（带缓存）。合并用户级和项目级 settings.json 的规则。
 *  @returns 包含 allow 和 deny 规则的 PermissionRules 对象 */
export function loadPermissionRules(): PermissionRules {
  if (cachedRules) return cachedRules;  // 命中缓存直接返回

  const allow: ParsedRule[] = [];  // 收集允许规则
  const deny: ParsedRule[] = [];  // 收集拒绝规则

  // Load from user-level settings (~/.claude/settings.json)
  // 从用户级配置加载（~/.claude/settings.json）
  const userSettings = loadSettings(join(homedir(), ".claude", "settings.json"));
  // Load from project-level settings (.claude/settings.json)
  // 从项目级配置加载（.claude/settings.json）
  const projectSettings = loadSettings(join(process.cwd(), ".claude", "settings.json"));

  // 依次处理用户级和项目级配置（项目级会追加到列表后面）
  for (const settings of [userSettings, projectSettings]) {
    if (!settings?.permissions) continue;  // 无 permissions 字段则跳过
    if (Array.isArray(settings.permissions.allow)) {
      for (const r of settings.permissions.allow) allow.push(parseRule(r));  // 解析并添加允许规则
    }
    if (Array.isArray(settings.permissions.deny)) {
      for (const r of settings.permissions.deny) deny.push(parseRule(r));  // 解析并添加拒绝规则
    }
  }

  cachedRules = { allow, deny };  // 存入缓存
  return cachedRules;
}

/** 判断某次工具调用是否匹配给定的权限规则。
 *  @param rule - 权限规则
 *  @param toolName - 被调用的工具名称
 *  @param input - 工具调用的输入参数
 *  @returns true 表示匹配该规则 */
function matchesRule(rule: ParsedRule, toolName: string, input: Record<string, any>): boolean {
  if (rule.tool !== toolName) return false;  // 工具名不匹配则返回 false
  if (!rule.pattern) return true; // Matches all invocations of this tool
                                  // 无模式则匹配该工具的所有调用

  // Get the value to match against
  // 获取用于匹配的值：run_shell 用 command，其他用 file_path
  let value = "";
  if (toolName === "run_shell") value = input.command || "";
  else if (input.file_path) value = input.file_path;
  else return true; // No specific value, tool name match is enough
                    // 无特定值可匹配，工具名匹配即可

  const pattern = rule.pattern;
  // Wildcard matching: pattern ending with * is prefix match
  // 通配符匹配：以 * 结尾的模式表示前缀匹配
  if (pattern.endsWith("*")) {
    return value.startsWith(pattern.slice(0, -1));  // 检查值是否以模式（去掉末尾*）开头
  }
  return value === pattern;  // 精确匹配
}

/** 检查权限规则，判断该工具调用是被允许还是拒绝。
 *  deny 规则优先级高于 allow。
 *  @param toolName - 工具名称
 *  @param input - 工具输入参数
 *  @returns "deny"=拒绝, "allow"=允许, null=无匹配规则（走默认逻辑） */
function checkPermissionRules(
  toolName: string,
  input: Record<string, any>
): "allow" | "deny" | null {
  const rules = loadPermissionRules();

  // Deny rules checked first (higher priority)
  // 先检查 deny 规则（优先级更高）
  for (const rule of rules.deny) {
    if (matchesRule(rule, toolName, input)) return "deny";
  }
  // Then allow rules
  // 再检查 allow 规则
  for (const rule of rules.allow) {
    if (matchesRule(rule, toolName, input)) return "allow";
  }
  return null; // No matching rule, fall through to default logic
              // 无匹配规则，回退到默认逻辑
}

// ─── Unified permission check ───────────────────────────────
// ─── 统一权限检查 ───────────────────────────────────────────
// Returns: { action, message? }
//   - allow: proceed without confirmation
//   - deny: block the tool call
//   - confirm: ask user for approval (message is the description)
//
// 返回值: { action, message? }
//   - allow: 无需确认直接执行
//   - deny: 阻止工具调用
//   - confirm: 请求用户批准（message 是描述信息）

/** 统一权限检查：综合权限规则、模式、危险模式检测来决定工具调用是否允许。
 *  @param toolName - 工具名称
 *  @param input - 工具输入参数
 *  @param mode - 当前权限模式（默认 "default"）
 *  @param planFilePath - 计划模式下的计划文件路径（仅此文件可写）
 *  @returns 包含 action（allow/deny/confirm）和可选 message 的对象 */
export function checkPermission(
  toolName: string,
  input: Record<string, any>,
  mode: PermissionMode = "default",
  planFilePath?: string
): { action: "allow" | "deny" | "confirm"; message?: string } {
  // Step 1: Deny rules always win — even bypassPermissions (--yolo) is
  // constrained by deny rules (docs/06-permissions.md), so check them before
  // any mode shortcut.
  // 步骤1：deny 规则始终优先——即使 bypassPermissions（--yolo）也受 deny 规则
  // 约束（见 docs/06-permissions.md），因此在任何模式快捷方式之前检查。
  const ruleResult = checkPermissionRules(toolName, input);
  if (ruleResult === "deny") {
    return { action: "deny", message: `Denied by permission rule for ${toolName}` };
  }

  // Step 2: Plan mode's read-only contract beats allow rules and bypass:
  // only the plan file itself is writable, and shell stays blocked (docs/10).
  // 步骤2：计划模式的只读契约优先于 allow 规则和 bypass：
  // 只有计划文件本身可写，shell 始终被阻止（见 docs/10）。
  if (mode === "plan") {
    if (EDIT_TOOLS.has(toolName)) {
      const filePath = input.file_path || input.path;
      // 如果写入的是计划文件本身则允许
      if (planFilePath && filePath === planFilePath) {
        return { action: "allow" };
      }
      return { action: "deny", message: `Blocked in plan mode: ${toolName}` };  // 其他写入操作阻止
    }
    if (toolName === "run_shell") {
      return { action: "deny", message: "Shell commands blocked in plan mode" };  // 计划模式下 shell 全部阻止
    }
  }

  // bypassPermissions (--yolo): skip confirmations for everything else
  // bypassPermissions（--yolo）：跳过其他所有操作的确认
  if (mode === "bypassPermissions") return { action: "allow" };

  // 命中 allow 规则则直接放行
  if (ruleResult === "allow") {
    return { action: "allow" };
  }

  // Step 3: Mode-specific logic
  // 步骤3：模式特定逻辑
  // Read tools are always allowed in all modes
  // 只读工具在所有模式下都允许
  if (READ_TOOLS.has(toolName)) return { action: "allow" };

  // plan mode tools: always allow (handled in agent.ts)
  // 计划模式工具：始终允许（实际处理在 agent.ts 中）
  if (toolName === "enter_plan_mode" || toolName === "exit_plan_mode") {
    return { action: "allow" };
  }

  // acceptEdits: auto-approve file writes/edits
  // acceptEdits 模式：自动批准文件写入/编辑
  if (mode === "acceptEdits" && EDIT_TOOLS.has(toolName)) {
    return { action: "allow" };
  }

  // Step 3: Built-in dangerous pattern checks
  // 步骤3（继续）：内置危险模式检查
  let needsConfirm = false;  // 是否需要确认
  let confirmMessage = "";   // 确认提示信息

  // 危险 shell 命令需要确认
  if (toolName === "run_shell" && isDangerous(input.command)) {
    needsConfirm = true;
    confirmMessage = input.command;
  // 写入新文件（文件不存在）需要确认
  } else if (toolName === "write_file" && !existsSync(input.file_path)) {
    needsConfirm = true;
    confirmMessage = `write new file: ${input.file_path}`;
  // 编辑不存在的文件需要确认
  } else if (toolName === "edit_file" && !existsSync(input.file_path)) {
    needsConfirm = true;
    confirmMessage = `edit non-existent file: ${input.file_path}`;
  }

  if (needsConfirm) {
    // dontAsk: auto-deny anything that would need confirmation (for CI / non-interactive)
    // dontAsk 模式：自动拒绝任何需要确认的操作（用于 CI / 非交互场景）
    if (mode === "dontAsk") {
      return { action: "deny", message: `Auto-denied (dontAsk mode): ${confirmMessage}` };
    }
    return { action: "confirm", message: confirmMessage };  // 其他模式请求用户确认
  }

  return { action: "allow" };  // 默认放行
}

// Legacy exports for backward compatibility
// 为向后兼容保留的旧版导出
/** 旧版兼容函数：检查工具调用是否需要用户确认。
 *  @param toolName - 工具名称
 *  @param input - 工具输入参数
 *  @returns 需要确认时返回确认消息字符串，否则返回 null */
export function needsConfirmation(
  toolName: string,
  input: Record<string, any>
): string | null {
  const result = checkPermission(toolName, input);
  if (result.action === "confirm") return result.message || null;
  return null;
}

// ─── Truncate long tool results ─────────────────────────────
// ─── 截断过长的工具结果 ─────────────────────────────────────

// 工具结果的最大字符数上限
const MAX_RESULT_CHARS = 50000;

/** 截断过长的工具结果：保留首尾各一部分，中间用省略提示替代。
 *  @param result - 原始结果字符串
 *  @returns 截断后的字符串（超长时头尾保留+中间省略，未超长则原样返回） */
export function truncateResult(result: string): string {
  if (result.length <= MAX_RESULT_CHARS) return result;  // 未超长直接返回
  const keepEach = Math.floor((MAX_RESULT_CHARS - 60) / 2);  // 计算每端保留的字符数（预留60字符给省略提示）
  return (
    result.slice(0, keepEach) +               // 保留前半段
    "\n\n[... truncated " +                   // 省略提示开始
    (result.length - keepEach * 2) +          // 被省略的字符数
    " chars ...]\n\n" +                       // 省略提示结束
    result.slice(-keepEach)                   // 保留后半段
  );
}

// ─── Execute a tool call ────────────────────────────────────
// ─── 执行工具调用 ────────────────────────────────────────────
// The "agent" tool is handled in agent.ts to avoid circular deps.
// "agent" 工具在 agent.ts 中处理，以避免循环依赖。

/** 执行工具调用的核心函数：根据工具名分发到对应的处理函数。
 *  支持文件读写新鲜度检查（防止覆盖外部修改）、超时控制等安全机制。
 *  @param name - 工具名称
 *  @param input - 工具输入参数
 *  @param readFileState - 可选的文件读取状态 Map（路径→mtimeMs），用于新鲜度校验
 *  @returns 工具执行结果字符串 */
export async function executeTool(
  name: string,
  input: Record<string, any>,
  readFileState?: Map<string, number>
): Promise<string> {
  let result: string;
  switch (name) {
    case "read_file": {
      result = readFile(input as { file_path: string });
      // Track mtime so edit_file/write_file can verify freshness
      // 记录文件修改时间（mtime），以便 edit_file/write_file 后续验证文件是否被外部修改
      if (readFileState && !result.startsWith("Error")) {
        const absPath = resolve(input.file_path);  // 转为绝对路径
        try { readFileState.set(absPath, statSync(absPath).mtimeMs); } catch {}  // 记录当前 mtime
      }
      break;
    }
    case "write_file": {
      const absPath = resolve(input.file_path);  // 转为绝对路径
      // Existing files require a prior read; new files skip the check
      // 已存在的文件要求先读取过；新文件跳过此检查
      if (readFileState && existsSync(absPath)) {
        if (!readFileState.has(absPath)) {
          return "Error: You must read this file before writing. Use read_file first to see its current contents.";  // 未读取过则拒绝写入
        }
        const cur = statSync(absPath).mtimeMs;  // 获取当前 mtime
        const rec = readFileState.get(absPath)!;  // 获取记录的 mtime
        if (cur !== rec) {
          return `Warning: ${input.file_path} was modified externally since your last read. Please read_file again before writing.`;  // mtime 不一致说明被外部修改
        }
      }
      result = writeFile(input as { file_path: string; content: string });
      // 写入成功后更新 mtime 记录
      if (readFileState && !result.startsWith("Error")) {
        try { readFileState.set(absPath, statSync(absPath).mtimeMs); } catch {}
      }
      break;
    }
    case "edit_file": {
      const absPath = resolve(input.file_path);  // 转为绝对路径
      // 编辑前的文件新鲜度检查（逻辑同 write_file）
      if (readFileState && existsSync(absPath)) {
        if (!readFileState.has(absPath)) {
          return "Error: You must read this file before editing. Use read_file first to see its current contents.";  // 未读取过则拒绝编辑
        }
        const cur = statSync(absPath).mtimeMs;
        const rec = readFileState.get(absPath)!;
        if (cur !== rec) {
          return `Warning: ${input.file_path} was modified externally since your last read. Please read_file again before editing.`;  // 被外部修改则警告
        }
      }
      result = editFile(
        input as { file_path: string; old_string: string; new_string: string }
      );
      // 编辑成功后更新 mtime 记录
      if (readFileState && existsSync(absPath) && !result.startsWith("Error")) {
        try { readFileState.set(absPath, statSync(absPath).mtimeMs); } catch {}
      }
      break;
    }
    case "list_files":
      result = await listFiles(input as { pattern: string; path?: string });
      break;
    case "grep_search":
      result = grepSearch(
        input as { pattern: string; path?: string; include?: string }
      );
      break;
    case "run_shell":
      result = runShell(input as { command: string; timeout?: number });
      break;
    case "web_fetch": {
      const url = input.url as string;  // 要抓取的 URL
      const maxLength = (input.max_length as number) || 50000;  // 最大返回长度，默认50000
      const controller = new AbortController();  // 用于超时取消请求
      const timeout = setTimeout(() => controller.abort(), 30000);  // 30秒后中止请求
      try {
        // 发起 HTTP 请求
        const res = await fetch(url, {
          signal: controller.signal,  // 绑定中止信号
          headers: { "User-Agent": "mini-claude/1.0" },  // 自定义 UA
        });
        clearTimeout(timeout);  // 请求成功则清除超时定时器
        if (!res.ok) {
          result = `HTTP error: ${res.status} ${res.statusText}`;  // HTTP 错误状态码
          break;
        }
        const contentType = res.headers.get("content-type") || "";  // 获取内容类型
        let text = await res.text();  // 读取响应文本
        // 如果是 HTML 页面，进行标签清理，提取可读文本
        if (contentType.includes("html")) {
          text = text
            .replace(/<script[\s\S]*?<\/script>/gi, "")  // 移除 script 标签
            .replace(/<style[\s\S]*?<\/style>/gi, "")    // 移除 style 标签
            .replace(/<[^>]*>/g, " ")                     // 移除所有 HTML 标签
            .replace(/&nbsp;/g, " ")                      // HTML 实体：不间断空格
            .replace(/&amp;/g, "&")                       // HTML 实体：&
            .replace(/&lt;/g, "<")                        // HTML 实体：<
            .replace(/&gt;/g, ">")                        // HTML 实体：>
            .replace(/&quot;/g, '"')                      // HTML 实体："
            .replace(/\s{2,}/g, " ")                      // 压缩多余空白
            .replace(/\n{3,}/g, "\n\n")                   // 压缩多余空行
            .trim();                                       // 去除首尾空白
        }
        // 超过最大长度则截断
        if (text.length > maxLength) {
          text = text.slice(0, maxLength) + `\n\n[... truncated at ${maxLength} characters]`;
        }
        result = text || "(empty response)";  // 空响应则返回提示
      } catch (err: any) {
        clearTimeout(timeout);  // 出错也要清除定时器
        if (err.name === "AbortError") {
          result = "Error: Request timed out (30s)";  // 请求超时
        } else {
          result = `Error fetching ${url}: ${err.message}`;  // 其他抓取错误
        }
      }
      break;
    }
    case "tool_search": {
      const query = (input.query as string || "").toLowerCase();  // 搜索关键词（转小写）
      const deferred = toolDefinitions.filter(t => t.deferred);  // 获取所有延迟工具
      // 按名称或描述匹配
      const matches = deferred.filter(t =>
        t.name.toLowerCase().includes(query) ||
        (t.description || "").toLowerCase().includes(query)
      );
      if (matches.length === 0) return "No matching deferred tools found.";  // 无匹配
      // 激活所有匹配的工具（使其 schema 在后续 API 调用中可用）
      for (const m of matches) activatedTools.add(m.name);
      // 返回匹配工具的完整 schema 定义
      return JSON.stringify(matches.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      })), null, 2);
    }
    // "skill" and "agent" are handled in agent.ts (to support fork mode and avoid circular deps)
    // "skill" 和 "agent" 在 agent.ts 中处理（以支持 fork 模式并避免循环依赖）
    default:
      return `Unknown tool: ${name}`;  // 未知工具名
  }
  // Return the full result untruncated: the agent layer persists large
  // results to disk first (persistLargeResult), then truncates as a safety
  // net. Truncating here would destroy data before persistence (issue #6).
  // 返回未截断的完整结果：agent 层会先将大结果持久化到磁盘
  // （persistLargeResult），然后再作为安全网截断。在此处截断会在持久化前
  // 破坏数据（见 issue #6）。
  return result;
}

// Reset permission cache (for testing)
// 重置权限缓存（用于测试）
/** 重置权限规则缓存，使下次调用 loadPermissionRules 时重新从文件加载。 */
export function resetPermissionCache(): void {
  cachedRules = null;
}
