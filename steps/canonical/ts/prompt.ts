// 导入 execSync：用于同步执行 shell 命令（这里用来获取 git 分支名）
import { execSync } from "child_process";
// 导入 os 模块：用于读取平台和 CPU 架构等系统信息
import * as os from "os";

// The static core: identity, rules, and tool preferences. Byte-identical across
// sessions, which is exactly what makes it cacheable (a real agent marks this
// block with cache_control).
// 静态核心部分：助手的身份、规则以及工具使用偏好。它在不同会话间逐字节相同，
// 这正是它能被缓存的原因（真实的 agent 会用 cache_control 标记这一段）。
//#region static_core
const STATIC_CORE = `You are Mini Claude Code, a small coding assistant CLI.
You help with software engineering tasks using the tools available to you.

# Doing tasks
 - Do not propose changes to code you haven't read. Read files first.
 - Do not create files unless necessary. Prefer editing existing files.
 - Avoid over-engineering. Only make changes that were requested.

# Executing actions with care
 - Prefer reversible actions. For risky or destructive ones (rm -rf, git push,
   dropping tables), confirm with the user before proceeding.

# Using your tools
 - Use read_file / edit_file / list_files / grep_search instead of shell cat,
   sed, ls, grep. Reserve run_shell for actual shell operations.
 - If several tool calls are independent, make them in parallel.

# Tone and style
 - Keep responses short and concise. Lead with the answer.
 - Reference code as file_path:line_number.`;
//#endregion

// The dynamic half: environment facts assembled fresh each run. Kept separate
// from the static core so it never pollutes the cache.
// 动态部分：每次运行时重新收集的环境信息。与静态核心分开存放，
// 这样它就不会污染（破坏）静态核心的缓存。
function buildEnvironmentContext(): string {
  // 尝试获取当前 git 分支名；失败则忽略（比如目录不是 git 仓库）
  let git = "";
  try {
    const opts = { encoding: "utf-8" as const, timeout: 3000, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"] };
    const branch = execSync("git rev-parse --abbrev-ref HEAD", opts).trim();
    git = `\nGit branch: ${branch}`;
  } catch {}
  // 组装环境信息：工作目录、平台架构、默认 shell 以及 git 分支
  return `# Environment
Working directory: ${process.cwd()}
Platform: ${os.platform()} ${os.arch()}
Shell: ${process.env.SHELL || "/bin/sh"}${git}`;
}

// Static core first, then the environment block.
// 先放静态核心，再拼接环境信息块，组成完整的 system prompt。
export function buildSystemPrompt(): string {
  return `${STATIC_CORE}\n\n${buildEnvironmentContext()}`;
}
