// 导入 Node.js 内置的 readline 模块，用于读取用户在终端的逐行输入
import * as readline from "readline";
// 导入 pathToFileURL：把文件路径转成 file:// URL，用于判断脚本是否被直接执行
import { pathToFileURL } from "url";
// 导入核心的 Agent 类，它是整个助手的大脑（负责调用模型和工具）
import { Agent } from "./agent.js";
//#step >=4
// 第 4 章起引入：会话的保存与加载，让对话可以跨进程恢复
import { saveSession, loadSession } from "./session.js";
//#endstep
//#step >=9
// 第 9 章起引入：技能解析，把 "/name ..." 形式的输入映射到技能模板
import { resolveSkill } from "./skills.js";
//#endstep

// A tiny REPL: read a line, hand it to the agent, repeat. One-shot mode runs a
// single prompt from argv and exits (handy for scripts and testing). Exported as
// runCli(argv) so it can be driven in-process without spawning a shell.
// 一个微型 REPL（读取-求值-打印循环）：读取一行输入，交给 agent 处理，然后重复。
// 单次模式（one-shot）会从命令行参数取一个 prompt 执行一次后退出，
// 这对脚本和测试很方便。导出为 runCli(argv)，这样无需新开 shell 就能在进程内调用它。
export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  // 检查是否设置了 API Key，没有就提示并退出
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Set ANTHROPIC_API_KEY (and optionally ANTHROPIC_BASE_URL) first.");
    process.exit(1);
  }

  // 创建 agent 实例，它是处理消息、调用工具的核心对象
  const agent = new Agent();
//#step >=4
  // --resume: reload the saved conversation before doing anything else.
  // --resume：在开始任何操作前，先把上次保存的对话历史加载回来
  const resume = argv.includes("--resume");
  argv = argv.filter((a) => a !== "--resume");
  if (resume) {
    const saved = loadSession();
    if (saved) { agent.loadHistory(saved as any); console.log(`(resumed ${saved.length} messages)`); }
  }
//#endstep
//#step >=10
  // --plan: read-only mode. The agent may read and think, but not write or run shell.
  // --plan：只读模式。agent 可以读取和思考，但不能写文件或执行 shell 命令
  if (argv.includes("--plan")) { agent.setMode("plan"); argv = argv.filter((a) => a !== "--plan"); console.log("(plan mode: read-only)"); }
//#endstep
//#step >=15
  // --auto: a classifier gates each write instead of asking; --goal pursues a condition.
  // --auto：用一个分类器（classifier）来决定每次写入是否放行，而不再逐次询问用户
  if (argv.includes("--auto")) { agent.setMode("auto"); argv = argv.filter((a) => a !== "--auto"); console.log("(auto mode: a classifier gates each write)"); }
  // --goal：让 agent 朝着一个"目标条件"持续推进
  const goalIdx = argv.indexOf("--goal");
  if (goalIdx >= 0) {
    // --goal 后面第一个参数是达成条件，其余参数是初始指令
    const condition = argv[goalIdx + 1] || "";
    await agent.pursueGoal(condition, argv.slice(goalIdx + 2).join(" "));
    saveSession(agent.history());
    return;
  }
//#endstep

  // 把剩余的命令行参数拼成一个一次性的 prompt
  const oneShot = argv.join(" ").trim();
  if (oneShot) {
//#step >=9
    // "/name ..." runs a skill's prompt template; anything else is a plain message.
    // "/name ..." 会触发对应技能的 prompt 模板；其它输入则当作普通消息处理
    const input = resolveSkill(oneShot) ?? oneShot;
//#step <=8
    const input = oneShot;
//#endstep
    // 把输入交给 agent 进行一次对话
    await agent.chat(input);
//#step >=4
    // 对话结束后保存历史，便于下次 --resume 恢复
    saveSession(agent.history());
//#endstep
    return;
  }

  // 进入交互式 REPL 模式：从标准输入读、写到标准输出
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("mini-claude — type a message, or 'exit' to quit.\n");
  // 用一个 Promise 包住整个问答循环，使函数变成可 await 的异步流程
  await new Promise<void>((resolve) => {
    // ask() 是一个递归的提问函数：每次回答完后再调用自身，实现循环
    const ask = () => {
      rl.question("you: ", async (line) => {
        const input = line.trim();
        // 输入 exit 或 quit 时关闭输入流并结束循环
        if (input === "exit" || input === "quit") { rl.close(); resolve(); return; }
//#step >=4
        // /clear：清空对话历史并保存，然后继续提问
        if (input === "/clear") { agent.clearHistory(); saveSession(agent.history()); console.log("(history cleared)"); ask(); return; }
//#endstep
//#step >=9
        // 非空输入先尝试解析为技能，否则当作普通消息发送给 agent
        if (input) await agent.chat(resolveSkill(input) ?? input);
//#step <=8
        // 非空输入直接当作普通消息发送给 agent
        if (input) await agent.chat(input);
//#endstep
//#step >=4
        // 每轮对话后保存历史
        if (input) saveSession(agent.history());
//#endstep
        ask();
      });
    };
    ask();
  });
}

// Run only when executed directly (not when imported for tests/demos).
// 只有当本文件被直接执行（而非被测试或示例 import）时才启动 CLI。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli();
