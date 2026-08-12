#!/usr/bin/env node
// Shebang 行：使该文件可作为可执行脚本直接运行（通过 node 解释执行）

import * as readline from "readline"; // Node.js 逐行读取模块，用于构建交互式 REPL
import { Agent } from "./agent.js"; // 核心 Agent 类，负责与 LLM 交互和工具调用编排
// UI 输出工具函数：欢迎信息、用户提示符、错误、信息、计划展示等
import { printWelcome, printUserPrompt, printError, printInfo, printPlanForApproval, printPlanApprovalOptions } from "./ui.js";
import { loadSession, getLatestSessionId } from "./session.js"; // 会话管理：加载历史会话、获取最新会话 ID
import { listMemories } from "./memory.js"; // 记忆管理：列出已保存的记忆条目
// 技能（Skills）系统：发现、解析、查找和执行技能
import { discoverSkills, resolveSkillPrompt, getSkillByName, executeSkill } from "./skills.js";
import type { PermissionMode } from "./tools.js"; // 权限模式类型（仅类型导入）

// 命令行参数解析结果接口
interface ParsedArgs {
  permissionMode: PermissionMode; // 权限模式：default/bypassPermissions/plan/acceptEdits/dontAsk/auto
  model: string; // 使用的模型名称
  apiBase?: string; // API 基础地址（OpenAI 兼容端点）
  prompt?: string; // 一次性提示词（非交互模式）
  resume?: boolean; // 是否恢复上一次会话
  thinking?: boolean; // 是否启用扩展思考模式（仅 Anthropic）
  maxCost?: number; // 最大花费上限（美元），超过则停止
  maxTurns?: number; // 最大代理轮次，超过则停止
}

// 解析命令行参数
// 返回值：ParsedArgs —— 解析后的参数对象
function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2); // 去掉前两个元素（node 路径和脚本路径）
  let permissionMode: PermissionMode = "default"; // 默认权限模式
  let thinking = false; // 默认不启用扩展思考
  // 模型：优先使用环境变量 MINI_CLAUDE_MODEL，否则默认 claude-opus-4-6
  let model = process.env.MINI_CLAUDE_MODEL || "claude-opus-4-6";
  let apiBase: string | undefined; // API 基础地址
  let resume = false; // 是否恢复会话
  let maxCost: number | undefined; // 最大花费上限
  let maxTurns: number | undefined; // 最大轮次
  const positional: string[] = []; // 位置参数（非选项参数）收集器

  // 逐个遍历命令行参数
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--yolo" || args[i] === "-y") {
      // 跳过所有确认提示（bypassPermissions 模式）
      permissionMode = "bypassPermissions";
    } else if (args[i] === "--plan") {
      // 计划模式：只读，描述变更但不执行
      permissionMode = "plan";
    } else if (args[i] === "--accept-edits") {
      // 自动批准文件编辑，但仍确认危险命令
      permissionMode = "acceptEdits";
    } else if (args[i] === "--dont-ask") {
      // 自动拒绝所有需要确认的操作（适用于 CI 环境）
      permissionMode = "dontAsk";
    } else if (args[i] === "--auto") {
      // 自动模式：由 LLM 分类器判断每个操作是否安全
      permissionMode = "auto";
    } else if (args[i] === "--thinking") {
      // 启用扩展思考（仅 Anthropic 支持）
      thinking = true;
    } else if (args[i] === "--model" || args[i] === "-m") {
      // 指定模型，取下一个参数作为模型名
      model = args[++i] || model;
    } else if (args[i] === "--api-base") {
      // 指定 OpenAI 兼容 API 端点
      apiBase = args[++i];
    } else if (args[i] === "--resume") {
      // 恢复上次会话
      resume = true;
    } else if (args[i] === "--max-cost") {
      // 设置最大花费上限（美元）
      const v = parseFloat(args[++i]);
      if (!isNaN(v)) maxCost = v;
    } else if (args[i] === "--max-turns") {
      // 设置最大代理轮次
      const v = parseInt(args[++i], 10);
      if (!isNaN(v)) maxTurns = v;
    } else if (args[i] === "--help" || args[i] === "-h") {
      // 显示帮助信息后退出
      console.log(`
Usage: mini-claude [options] [prompt]

Options:
  --yolo, -y          Skip all confirmation prompts (bypassPermissions mode)
  --plan              Plan mode: read-only, describe changes without executing
  --accept-edits      Auto-approve file edits, still confirm dangerous shell
  --dont-ask          Auto-deny anything needing confirmation (for CI)
  --auto              Auto Mode: an LLM classifier judges each action instead of asking
  --thinking          Enable extended thinking (Anthropic only)
  --model, -m         Model to use (default: claude-opus-4-6, or MINI_CLAUDE_MODEL env)
  --api-base URL      Use OpenAI-compatible API endpoint (key via env var)
  --resume            Resume the last session
  --max-cost USD      Stop when estimated cost exceeds this amount
  --max-turns N       Stop after N agentic turns
  --help, -h          Show this help

REPL commands:
  /clear              Clear conversation history
  /plan               Toggle plan mode (read-only ↔ normal)
  /cost               Show token usage and cost
  /compact            Manually compact conversation
  /goal <condition>   Pursue a goal across turns until an evaluator judges it met
  /goal               Show the active goal's status
  /loop [interval] <prompt>  Re-run a prompt on an interval (5m/2h) or self-paced
  /memory             List saved memories
  /skills             List available skills
  /<skill-name>       Invoke a skill (e.g. /commit "fix types")

Examples:
  mini-claude "fix the bug in src/app.ts"
  mini-claude --yolo "run all tests and fix failures"
  mini-claude --plan "how would you refactor this?"
  mini-claude --accept-edits "add error handling to api.ts"
  mini-claude --max-cost 0.50 --max-turns 20 "implement feature X"
  OPENAI_API_KEY=sk-xxx mini-claude --api-base https://aihubmix.com/v1 --model gpt-4o "hello"
  mini-claude --resume
  mini-claude  # starts interactive REPL
`);
      process.exit(0); // 输出帮助后正常退出
    } else {
      // 非选项参数收集为位置参数（作为提示词）
      positional.push(args[i]);
    }
  }

  // 返回解析结果
  return {
    permissionMode,
    model,
    apiBase,
    resume,
    thinking,
    maxCost,
    maxTurns,
    // 位置参数拼接为提示词字符串
    prompt: positional.length > 0 ? positional.join(" ") : undefined,
  };
}

// 运行交互式 REPL（读取-求值-打印循环）
// 参数：agent —— 已初始化的 Agent 实例
async function runRepl(agent: Agent) {
  // 创建 readline 接口，用于从标准输入读取用户输入
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Provide confirmFn that reuses this readline instance, avoiding the
  // classic Node.js bug where a second readline on the same stdin kills
  // the first one when closed.
  // 提供确认函数，复用当前 readline 实例，避免经典 Node.js bug：
  // 在同一个 stdin 上创建第二个 readline 并关闭时，会杀死第一个 readline。
  agent.setConfirmFn((_message: string) => {
    return new Promise((resolve) => {
      rl.question("  Allow? (y/n): ", (answer) => {
        // 用户输入以 y 开头则确认为"允许"
        resolve(answer.toLowerCase().startsWith("y"));
      });
    });
  });

  // Plan approval callback: interactive multi-option selection
  // 计划审批回调：交互式多选项选择
  agent.setPlanApprovalFn((planContent: string) => {
    return new Promise((resolve) => {
      printPlanForApproval(planContent); // 打印计划内容供用户审阅
      printPlanApprovalOptions(); // 打印可选的操作选项

      // 递归询问用户选择，直到输入有效选项
      const askChoice = () => {
        rl.question("  Enter choice (1-4): ", (answer) => {
          const choice = answer.trim();
          if (choice === "1") {
            // 清空当前对话并执行计划
            resolve({ choice: "clear-and-execute" });
          } else if (choice === "2") {
            // 直接执行计划（保留对话历史）
            resolve({ choice: "execute" });
          } else if (choice === "3") {
            // 手动执行（仅展示，不自动执行）
            resolve({ choice: "manual-execute" });
          } else if (choice === "4") {
            // 继续规划：收集用户反馈，让代理修改计划
            rl.question("  Feedback (what to change): ", (feedback) => {
              resolve({ choice: "keep-planning", feedback: feedback.trim() || undefined });
            });
          } else {
            // 无效输入，提示并重新询问
            console.log("  Invalid choice. Enter 1, 2, 3, or 4.");
            askChoice();
          }
        });
      };
      askChoice();
    });
  });

  // Ctrl+C handling
  // Ctrl+C 信号处理
  let sigintCount = 0; // 连续按 Ctrl+C 的次数计数
  process.on("SIGINT", () => {
    // Always signal a running /loop or /goal to stop — during its inter-tick
    // wait or between-turn evaluation the agent isn't "processing", so the abort
    // path below wouldn't catch it.
    // 始终通知正在运行的 /loop 或 /goal 停止 —— 在它的间隔等待或轮次间评估期间，
    // 代理并未处于"处理中"状态，因此下方的 abort 路径无法捕获到。
    agent.stopLoop();
    agent.stopGoal();
    if (agent.isProcessing) {
      // 代理正在处理中：中断当前操作
      agent.abort();
      console.log("\n  (interrupted)");
      sigintCount = 0; // 重置计数
      printUserPrompt();
    } else {
      // 代理空闲：累加 Ctrl+C 计数
      sigintCount++;
      if (sigintCount >= 2) {
        // 连续两次 Ctrl+C：退出程序
        console.log("\nBye!\n");
        // Disconnect MCP first or lingering subprocesses/timers keep the
        // process alive (issue #8)
        // 先断开 MCP 连接，否则残留的子进程/定时器会导致进程无法退出（issue #8）
        agent.close().finally(() => process.exit(0));
        return;
      }
      // 首次 Ctrl+C：提示再按一次退出
      console.log("\n  Press Ctrl+C again to exit.");
      printUserPrompt();
    }
  });

  // 打印欢迎信息
  printWelcome();

  // 核心问答循环函数：显示提示符，读取用户输入并分发处理
  const askQuestion = (): void => {
    printUserPrompt(); // 显示用户输入提示符
    // 使用 once（而非 on）监听单行输入，在处理完后再递归调用，形成循环
    rl.once("line", async (line) => {
      const input = line.trim(); // 去除首尾空白
      sigintCount = 0; // 每次输入后重置 Ctrl+C 计数

      // 空输入：直接重新提问
      if (!input) {
        askQuestion();
        return;
      }
      // 输入 exit 或 quit：关闭并退出
      if (input === "exit" || input === "quit") {
        console.log("\nBye!\n");
        rl.close();
        await agent.close(); // 清理资源（断开 MCP 等）
        process.exit(0);
      }

      // REPL commands
      // ─── REPL 斜杠命令处理 ───

      // /clear：清空对话历史
      if (input === "/clear") {
        agent.clearHistory();
        askQuestion();
        return;
      }
      // /plan：切换计划模式（只读 ↔ 正常）
      if (input === "/plan") {
        const newMode = agent.togglePlanMode();
        askQuestion();
        return;
      }
      // /cost：显示 token 使用量和花费
      if (input === "/cost") {
        agent.showCost();
        askQuestion();
        return;
      }
      // /compact：手动压缩对话（减少上下文长度）
      if (input === "/compact") {
        try {
          await agent.compact();
        } catch (e: any) {
          printError(e.message);
        }
        askQuestion();
        return;
      }
      // /goal [condition]：设定并追求一个目标条件
      if (input === "/goal" || input.startsWith("/goal ")) {
        // 提取 /goal 后面的条件文本
        const condition = input.slice("/goal".length).trim();
        if (!condition) {
          // 无条件参数：显示当前目标状态
          agent.showGoal();
          askQuestion();
          return;
        }
        // 设置目标并获取指令
        const directive = agent.setGoal(condition);
        try {
          // 追求目标直到完成或中断
          await agent.pursueGoal(directive);
        } catch (e: any) {
          // 忽略中止错误，仅打印其他错误
          if (e.name !== "AbortError" && !e.message?.includes("aborted")) printError(e.message);
        }
        askQuestion();
        return;
      }
      // /loop [interval] <prompt>：按间隔或自节奏重复运行提示
      if (input === "/loop" || input.startsWith("/loop ")) {
        // 提取 /loop 后面的参数
        const rest = input.slice("/loop".length).trim();
        try {
          await agent.runLoop(rest);
        } catch (e: any) {
          // 忽略中止错误，仅打印其他错误
          if (e.name !== "AbortError" && !e.message?.includes("aborted")) printError(e.message);
        }
        askQuestion();
        return;
      }
      // /memory：列出已保存的记忆
      if (input === "/memory") {
        const memories = listMemories();
        if (memories.length === 0) {
          printInfo("No memories saved yet.");
        } else {
          printInfo(`${memories.length} memories:`);
          for (const m of memories) {
            // 每条记忆：[类型] 名称 — 描述
            console.log(`    [${m.type}] ${m.name} — ${m.description}`);
          }
        }
        askQuestion();
        return;
      }
      // /skills：列出所有可用的技能
      if (input === "/skills") {
        const skills = discoverSkills();
        if (skills.length === 0) {
          printInfo("No skills found. Add skills to .claude/skills/<name>/SKILL.md");
        } else {
          printInfo(`${skills.length} skills:`);
          for (const s of skills) {
            // 用户可调用的技能显示为 /名称，否则只显示名称
            const tag = s.userInvocable ? `/${s.name}` : s.name;
            console.log(`    ${tag} (${s.source}) — ${s.description}`);
          }
        }
        askQuestion();
        return;
      }

      // Skill invocation: /<skill-name> [args]
      // 技能调用：以 / 开头的命令尝试匹配技能
      if (input.startsWith("/")) {
        // 查找第一个空格，分离命令名和参数
        const spaceIdx = input.indexOf(" ");
        const cmdName = spaceIdx > 0 ? input.slice(1, spaceIdx) : input.slice(1);
        const cmdArgs = spaceIdx > 0 ? input.slice(spaceIdx + 1) : "";
        const skill = getSkillByName(cmdName); // 按名称查找技能
        if (skill && skill.userInvocable) {
          // 技能存在且用户可调用
          printInfo(`Invoking skill: ${skill.name}`);
          try {
            if (skill.context === "fork") {
              // Fork mode: use skill tool which creates a sub-agent
              // Fork 模式：使用 skill 工具创建子代理来执行
              const forkResult = executeSkill(skill.name, cmdArgs);
              if (forkResult) {
                await agent.chat(`Use the skill tool to invoke "${skill.name}" with args: ${cmdArgs || "(none)"}`);
              }
            } else {
              // Inline mode: inject resolved prompt
              // Inline 模式：将解析后的技能提示词注入对话
              const resolved = resolveSkillPrompt(skill, cmdArgs);
              await agent.chat(resolved);
            }
          } catch (e: any) {
            // 忽略中止错误，仅打印其他错误
            if (e.name !== "AbortError" && !e.message?.includes("aborted")) {
              printError(e.message);
            }
          }
          askQuestion();
          return;
        }
        // Unknown command — treat as regular input
        // 未知命令 —— 作为普通输入交给代理处理
      }

      // 普通对话：将用户输入发送给代理处理
      try {
        await agent.chat(input);
      } catch (e: any) {
        if (e.name === "AbortError" || e.message?.includes("aborted")) {
          // Already handled by SIGINT handler
          // 中止错误已由 SIGINT 处理器处理，此处无需重复处理
        } else {
          printError(e.message); // 打印其他错误
        }
      }

      // 处理完毕，递归调用继续下一轮提问
      askQuestion();
    });
  };

  // 启动问答循环
  askQuestion();
}

// 主函数：程序的入口点
async function main() {
  // 解析命令行参数
  const { permissionMode, model, apiBase, prompt, resume, thinking, maxCost, maxTurns } = parseArgs();

  // Resolve API config from env vars (API keys only via env, not CLI)
  // 从环境变量解析 API 配置（API 密钥仅通过环境变量传入，不通过命令行）
  let resolvedApiBase = apiBase;
  let resolvedApiKey: string | undefined;
  // 是否使用 OpenAI 兼容格式（若指定了 apiBase 则默认为是）
  let resolvedUseOpenAI = !!apiBase;

  // Check OPENAI env vars first (if OPENAI_BASE_URL is set, use OpenAI format)
  // 优先检查 OPENAI 环境变量（若设置了 OPENAI_BASE_URL，则使用 OpenAI 格式）
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL) {
    resolvedApiKey = process.env.OPENAI_API_KEY;
    resolvedApiBase = resolvedApiBase || process.env.OPENAI_BASE_URL;
    resolvedUseOpenAI = true;
  } else if (process.env.ANTHROPIC_API_KEY) {
    // 其次检查 Anthropic 密钥
    resolvedApiKey = process.env.ANTHROPIC_API_KEY;
    resolvedApiBase = resolvedApiBase || process.env.ANTHROPIC_BASE_URL;
    resolvedUseOpenAI = false;
  } else if (process.env.OPENAI_API_KEY) {
    // 最后检查仅有 OPENAI_API_KEY 的情况
    resolvedApiKey = process.env.OPENAI_API_KEY;
    resolvedApiBase = resolvedApiBase || process.env.OPENAI_BASE_URL;
    resolvedUseOpenAI = true;
  }

  // --api-base without env key: check if any key is available
  // 指定了 --api-base 但没有环境密钥：检查是否有任何可用密钥
  if (!resolvedApiKey && apiBase) {
    resolvedApiKey = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
    resolvedUseOpenAI = true;
  }

  // 没有找到任何 API 密钥：报错并退出
  if (!resolvedApiKey) {
    printError(
      `API key is required.\n` +
        `  Set ANTHROPIC_API_KEY (+ optional ANTHROPIC_BASE_URL) for Anthropic format,\n` +
        `  or OPENAI_API_KEY + OPENAI_BASE_URL for OpenAI-compatible format.`
    );
    process.exit(1);
  }

  // 创建 Agent 实例，传入所有解析后的配置
  const agent = new Agent({
    permissionMode, // 权限模式
    model, // 模型名称
    thinking, // 是否启用扩展思考
    maxCostUsd: maxCost, // 最大花费（美元）
    maxTurns, // 最大轮次
    // OpenAI 模式时传入 apiBase，否则为 undefined
    apiBase: resolvedUseOpenAI ? resolvedApiBase : undefined,
    // Anthropic 模式时传入 base URL，否则为 undefined
    anthropicBaseURL: !resolvedUseOpenAI ? resolvedApiBase : undefined,
    apiKey: resolvedApiKey, // API 密钥
  });

  // Resume session if requested
  // 如有 --resume 标志，恢复上一次会话
  if (resume) {
    const sessionId = getLatestSessionId(); // 获取最新会话 ID
    if (sessionId) {
      const session = loadSession(sessionId); // 从存储加载会话数据
      if (session) {
        // 将历史消息恢复到代理中
        agent.restoreSession({
          anthropicMessages: session.anthropicMessages, // Anthropic 格式消息
          openaiMessages: session.openaiMessages, // OpenAI 格式消息
        });
      } else {
        printInfo("No session found to resume."); // 会话文件存在但无法加载
      }
    } else {
      printInfo("No previous sessions found."); // 没有任何历史会话
    }
  }

  if (prompt) {
    // One-shot mode
    // 一次性模式：执行单条提示词后退出
    try {
      await agent.chat(prompt);
    } catch (e: any) {
      printError(e.message);
      process.exit(1);
    } finally {
      // Without this, MCP subprocesses/timers keep the one-shot process
      // alive after the answer is printed (issue #8)
      // 若不调用 close()，MCP 子进程/定时器会在答案打印后仍保持进程存活（issue #8）
      await agent.close();
    }
  } else {
    // Interactive REPL mode
    // 交互式 REPL 模式：启动持续对话循环
    await runRepl(agent);
  }
}

// 启动主函数
main();
