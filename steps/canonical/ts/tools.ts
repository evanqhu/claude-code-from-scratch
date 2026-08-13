// ===== 依赖导入 =====
// Node.js 文件系统模块：读取、写入、判断存在性、创建目录、读取目录、获取文件状态
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
// 子进程模块：同步执行 shell 命令
import { execSync, execFileSync } from "child_process";
// glob 库：按通配符模式匹配文件路径
import { glob } from "glob";
// 路径工具：提取目录名、拼接路径
import { dirname, join } from "path";
// Anthropic SDK 的类型定义（仅用于类型，不引入运行时依赖）
import type Anthropic from "@anthropic-ai/sdk";

// A tool is three things: a name, a description the model reads, and a function
// that does the work. The definitions below are exactly the shape the API wants.
// 一个工具由三部分组成：名称、模型可读的描述、以及真正干活的函数。
// 下面的定义结构正是 Anthropic API 所要求的格式。
// 工具定义表：每个条目声明一个工具的名称、描述和输入参数 schema
export const toolDefinitions: Anthropic.Tool[] = [
  {
    // read_file：读取文件内容，返回带行号的文本
    name: "read_file",
    description: "Read the contents of a file. Returns the file content with line numbers.",
    input_schema: {
      type: "object",
      properties: { file_path: { type: "string", description: "The path to the file to read" } },
      required: ["file_path"],
    },
  },
//#step >=2
  {
    // write_file：写入文件，不存在则创建，已存在则覆盖
    name: "write_file",
    description: "Write content to a file. Creates it if missing, overwrites if it exists.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "The path to the file to write" },
        content: { type: "string", description: "The content to write" },
      },
      required: ["file_path", "content"],
    },
  },
  {
    // edit_file：精确字符串替换；old_string 必须完全匹配且唯一
    name: "edit_file",
    description: "Replace an exact string in a file with new content. old_string must match exactly and be unique.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "The path to the file to edit" },
        old_string: { type: "string", description: "The exact string to find" },
        new_string: { type: "string", description: "The string to replace it with" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
  {
    // list_files：按 glob 模式列出匹配的文件
    name: "list_files",
    description: "List files matching a glob pattern (e.g. \"**/*.ts\").",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern to match files" },
        path: { type: "string", description: "Base directory. Defaults to cwd." },
      },
      required: ["pattern"],
    },
  },
  {
    // grep_search：正则搜索文件内容，返回匹配行及路径和行号
    name: "grep_search",
    description: "Search for a regex pattern in files. Returns matching lines with paths and line numbers.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The regex pattern to search for" },
        path: { type: "string", description: "Directory or file to search. Defaults to cwd." },
      },
      required: ["pattern"],
    },
  },
  {
    // run_shell：执行 shell 命令并返回输出（用于跑测试、git、安装依赖等）
    name: "run_shell",
    description: "Execute a shell command and return its output. For tests, git, package installs, etc.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string", description: "The shell command to execute" } },
      required: ["command"],
    },
  },
//#endstep
//#step >=11
  {
    // agent：把一个只读调查任务委托给子 Agent，它独立探索后返回摘要
    name: "agent",
    description: "Delegate a read-only investigation to a sub-agent. Give it a task; it explores on its own and reports back a summary.",
    input_schema: {
      type: "object",
      properties: { task: { type: "string", description: "The task for the sub-agent to investigate" } },
      required: ["task"],
    },
  },
//#endstep
];

// Dispatch a tool call by name. Unknown names return an error string instead of
// throwing, so a hallucinated tool name lets the model self-correct.
// 按名称分派工具调用。未知的工具名返回错误字符串而非抛出异常，
// 这样模型面对幻觉出的工具名时可以自行纠错。
//#region dispatch
// 工具执行入口：根据工具名路由到对应的实现函数
export async function executeTool(name: string, input: Record<string, any>): Promise<string> {
  switch (name) {
    case "read_file": return readFile(input as { file_path: string });
//#step >=2
    case "write_file": return writeFile(input as { file_path: string; content: string });
    case "edit_file": return editFile(input as { file_path: string; old_string: string; new_string: string });
    case "list_files": return listFiles(input as { pattern: string; path?: string });
    case "grep_search": return grepSearch(input as { pattern: string; path?: string });
    case "run_shell": return runShell(input as { command: string });
//#endstep
    // 未知工具：返回提示信息而非报错，交给模型自行修正
    default: return `Unknown tool: ${name}`;
  }
}
//#endregion

//#region read_file
// 读取文件内容，每行加上行号前缀（格式：行号右对齐4位 + " | " + 内容）
function readFile(input: { file_path: string }): string {
  try {
    const lines = readFileSync(input.file_path, "utf-8").split("\n");
    return lines.map((l, i) => `${String(i + 1).padStart(4)} | ${l}`).join("\n");
  } catch (e: any) {
    // 读取失败时返回错误信息而非抛异常，让模型能感知到问题
    return `Error reading file: ${e.message}`;
  }
}
//#endregion

//#step >=2
// 写入文件：如果所在目录不存在则自动创建，然后写入内容
function writeFile(input: { file_path: string; content: string }): string {
  try {
    const dir = dirname(input.file_path);
    // 目录不存在时递归创建，避免写入失败
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(input.file_path, input.content);
    // 统计写入的行数，在返回信息中告知模型
    const n = input.content.split("\n").length;
    return `Successfully wrote to ${input.file_path} (${n} lines)`;
  } catch (e: any) {
    return `Error writing file: ${e.message}`;
  }
}

// edit_file is the one tool with a real trap: the match must be unique, or you
// edit the wrong place. So we count occurrences and refuse if it isn't unique.
// edit_file 是唯一一个有真正陷阱的工具：匹配必须唯一，否则你会改错地方。
// 因此我们先统计出现次数，不唯一就拒绝执行。
//#region edit_file
// 编辑文件：将文件中唯一匹配的 old_string 替换为 new_string
function editFile(input: { file_path: string; old_string: string; new_string: string }): string {
  try {
    const content = readFileSync(input.file_path, "utf-8");
    // 完全找不到匹配字符串时报错
    if (!content.includes(input.old_string)) {
      return `Error: old_string not found in ${input.file_path}`;
    }
    // 通过 split 后的段数减一来计算出现次数
    const count = content.split(input.old_string).length - 1;
    // 出现多次则拒绝替换，避免歧义性修改
    if (count > 1) {
      return `Error: old_string found ${count} times in ${input.file_path}. Must be unique.`;
    }
    // split/join avoids $-substitution surprises from String.replace.
    // 用 split/join 而非 String.replace，避免 $ 替换符带来的意外行为。
    const updated = content.split(input.old_string).join(input.new_string);
    writeFileSync(input.file_path, updated);
    return `Successfully edited ${input.file_path}`;
  } catch (e: any) {
    return `Error editing file: ${e.message}`;
  }
}
//#endregion

// 列出匹配 glob 模式的文件（自动排除 node_modules 和 .git）
async function listFiles(input: { pattern: string; path?: string }): Promise<string> {
  try {
    const files = await glob(input.pattern, {
      cwd: input.path || process.cwd(),
      // 不返回目录，只返回文件
      nodir: true,
      // 排除依赖目录和 git 目录，避免噪声
      ignore: ["node_modules/**", ".git/**"],
    });
    if (files.length === 0) return "No files found matching the pattern.";
    // 最多返回 200 个结果，防止输出过长
    return files.slice(0, 200).join("\n");
  } catch (e: any) {
    return `Error listing files: ${e.message}`;
  }
}

// 正则搜索文件内容：返回匹配行及其路径和行号
function grepSearch(input: { pattern: string; path?: string }): string {
  // Prefer the system grep; fall back to a tiny JS walker if it isn't there.
  // 优先使用系统自带的 grep；如果系统没有 grep，则回退到一个简易的 JS 遍历器。
  try {
    const out = execFileSync("grep", ["--line-number", "--color=never", "-r", "--", input.pattern, input.path || "."], {
      encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 10000,
    });
    // 过滤空行，最多取 100 条匹配结果
    return out.split("\n").filter(Boolean).slice(0, 100).join("\n") || "No matches found.";
  } catch (e: any) {
    // grep 退出码 1 表示「无匹配」，属于正常情况，不算错误
    if (e.status === 1) return "No matches found.";
    // 其他错误（如 grep 不存在）回退到纯 JS 实现
    return grepJS(input.pattern, input.path || ".");
  }
}

// 纯 JS 实现的 grep：递归遍历目录，逐行做正则匹配（grep 不可用时的后备方案）
function grepJS(pattern: string, dir: string): string {
  let re: RegExp;
  // 先编译正则表达式，无效正则直接返回错误
  try { re = new RegExp(pattern); } catch (e: any) { return `Error: invalid regex: ${e.message}`; }
  const matches: string[] = [];
  // 递归遍历目录的内部函数
  const walk = (d: string) => {
    let entries: string[];
    try { entries = readdirSync(d); } catch { return; }
    for (const name of entries) {
      // 跳过隐藏文件和 node_modules 目录
      if (name.startsWith(".") || name === "node_modules") continue;
      const full = join(d, name);
      let st; try { st = statSync(full); } catch { continue; }
      // 如果是目录则递归遍历
      if (st.isDirectory()) { walk(full); continue; }
      // 逐行读取文件内容并做正则匹配
      try {
        readFileSync(full, "utf-8").split("\n").forEach((line, i) => {
          if (re.test(line) && matches.length < 100) matches.push(`${full}:${i + 1}:${line}`);
        });
      } catch {}
    }
  };
  walk(dir);
  return matches.length ? matches.join("\n") : "No matches found.";
}

// 执行 shell 命令并返回输出
function runShell(input: { command: string }): string {
  try {
    return execSync(input.command, {
      encoding: "utf-8", maxBuffer: 5 * 1024 * 1024, timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"], shell: "/bin/sh",
    }) || "(no output)";
  } catch (e: any) {
    // 命令失败时返回退出码和 stdout/stderr，方便模型诊断问题
    return `Command failed (exit ${e.status})${e.stdout ? `\nStdout: ${e.stdout}` : ""}${e.stderr ? `\nStderr: ${e.stderr}` : ""}`;
  }
}
//#endstep
