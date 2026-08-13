#!/usr/bin/env node
// Enter the code state at the end of chapter <N> and run it.
// 进入第 <N> 章结束时的代码状态并运行它。
//
//   node steps/run.mjs --list            # steps + what each can do
//   node steps/run.mjs --list            # 列出所有章节及各自能做什么
//   node steps/run.mjs 2                 # DEFAULT: no-key demo (local mock model)
//   node steps/run.mjs 2                 # 默认：免 API Key 演示（本地模拟模型）
//   node steps/run.mjs 2 --py            # ...in Python
//   node steps/run.mjs 2 --py            # 用 Python 版本演示
//   node steps/run.mjs 2 --diff          # what chapter 2 added vs chapter 1
//   node steps/run.mjs 2 --diff          # 查看第 2 章相比第 1 章新增了什么
//   node steps/run.mjs 2 --live          # real model (needs .env), REPL
//   node steps/run.mjs 2 --live          # 使用真实模型（需要 .env），交互式 REPL
//   node steps/run.mjs 2 --live -- "hi"  # real model, one-shot
//   node steps/run.mjs 2 --live -- "hi"  # 使用真实模型，单次提问
//
// The demo needs no API key: it runs the step's real Agent against a local mock
// that replays a scripted scenario, so anyone can watch the chapter work.
// 演示不需要 API Key：它用本地 mock 服务器回放预设的场景脚本来驱动真实的 Agent 代码，
// 因此任何人都能直接看到该章节的功能是如何工作的。

// ===== 依赖导入 =====
// startMock：启动一个本地 HTTP 服务器，伪装成 Anthropic API，按脚本回放响应
import { startMock } from "./mock-anthropic.mjs";
// 文件系统操作：读/写/判断存在/创建目录/创建临时目录/列目录
import { existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, readdirSync } from "fs";
// 路径处理：join 拼接、dirname 取目录名
import { join, dirname } from "path";
// URL ↔ 文件路径互转（用于动态 import 编译后的 .js 文件）
import { pathToFileURL, fileURLToPath } from "url";
// spawnSync：同步启动子进程（用于调 tsc 编译 TypeScript）
import { spawnSync } from "child_process";
// tmpdir：获取系统临时目录（用于创建演示沙箱）
import { tmpdir } from "os";

// 当前脚本所在目录（steps/）
const HERE = dirname(fileURLToPath(import.meta.url));
// 项目根目录（repo 根）
const REPO = dirname(HERE);
// dist 目录：build.mjs 生成的各章节代码快照都在这里
const DIST = join(HERE, "dist");
// scenarios 目录：预设的场景脚本（JSON），定义了 mock 模型该怎么回放
const SCEN = join(HERE, "scenarios");
// ch12: point the MCP client at the bundled demo server (inherited by child procs).
// 第 12 章需要 MCP：把 MCP demo 服务器的路径设到环境变量，子进程会继承它。
if (!process.env.MINI_MCP_SERVER) process.env.MINI_MCP_SERVER = join(HERE, "mcp-demo-server.mjs");

// 每个章节的一句话描述，供 --list 和帮助信息使用
const STEP_INFO = {
  1: "agent loop — talk to the model and call one tool (read_file)",
  //  第1章：Agent 循环 —— 对话 + 调用一个工具（read_file）
  2: "tools — read, write, edit, list, grep, run shell",
  //  第2章：工具集 —— 读、写、编辑、列文件、搜索、执行 shell
  3: "system prompt — behave like a coding agent",
  //  第3章：系统提示词 —— 让模型表现得像个编程助手
  4: "CLI & sessions — arg parsing, /clear, save & --resume a conversation",
  //  第4章：CLI 与会话 —— 参数解析、/clear、保存和 --resume 恢复对话
  5: "streaming — the model call becomes a stream; text appears as it is generated",
  //  第5章：流式输出 —— 模型回复变成流式，文字边生成边显示
  6: "permissions — a gate checks each tool call; dangerous shell commands are blocked",
  //  第6章：权限 —— 每次工具调用前检查；危险 shell 命令被拦截
  7: "context — when the history grows too long, older messages are summarized (compacted)",
  //  第7章：上下文管理 —— 历史太长时，旧消息被摘要压缩
  8: "memory — recall facts saved across sessions and inject them into the prompt",
  //  第8章：记忆 —— 跨会话召回已保存的事实并注入提示词
  9: "skills — /name runs a reusable prompt template loaded from a file",
  //  第9章：技能 —— /name 运行从文件加载的可复用提示词模板
  10: "plan mode — --plan makes the agent read-only; writes and shell are denied",
  //  第10章：计划模式 —— --plan 让 Agent 只读；写入和 shell 被拒绝
  11: "multi-agent — the agent tool forks a read-only sub-agent to investigate",
  //  第11章：多 Agent —— agent 工具派生只读子 Agent 去调查
  12: "MCP — connect an external stdio JSON-RPC tool server and call its tools",
  //  第12章：MCP —— 连接外部 stdio JSON-RPC 工具服务器并调用其工具
  15: "autonomy — /goal keeps working until an evaluator judges the condition met; --auto gates writes with a classifier",
  //  第15章：自主性 —— /goal 持续工作直到评估器判定条件满足；--auto 用分类器把关写操作
};

// ===== 命令行参数解析 =====
const args = process.argv.slice(2);        // 去掉 node 和脚本路径，只留用户参数
// 判断某个 flag 是否存在（如 --py、--diff、--live）
const flag = (f) => args.includes(f);
// 取某个 flag 后面的值（如 --case foo → "foo"）
const argVal = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
// 找到纯数字参数，就是要跑的章节号（如 "1"、"15"）
const stepArg = args.find((a) => /^\d+$/.test(a));
// "--" 之后的参数会作为自定义 prompt 传给模型（用于 --live 模式）
const dashDash = args.indexOf("--");
const promptArgs = dashDash >= 0 ? args.slice(dashDash + 1) : [];
// 是否使用 Python 版本
const usePy = flag("--py");
// --case：有些章节有多个场景，用这个指定跑哪一个
const caseId = argVal("--case"); // pick a specific scenario for steps with several

// 如果 dist 目录不存在，先跑 build.mjs 从 canonical 源码生成各章节快照
if (!existsSync(DIST)) spawnSync("node", [join(HERE, "build.mjs")], { stdio: "inherit" });
// 读取 dist 下已有的章节目录列表，按名字排序
const stepDirs = existsSync(DIST) ? readdirSync(DIST).sort() : [];
// 根据章号找到对应的目录名（如 1 → "01-agent-loop"）
const nameOf = (n) => stepDirs.find((s) => s.startsWith(String(n).padStart(2, "0") + "-"));

// ===== --list 模式：列出所有章节 =====
if (flag("--list") || !stepArg) {
  console.log("Steps (node steps/run.mjs <N>):");
  for (const s of stepDirs) console.log(`  ${s.slice(0, 2)}  ${s}  —  ${STEP_INFO[Number(s.slice(0, 2))] || ""}`);
  process.exit(0);
}
// 解析章号，找到对应目录
const n = Number(stepArg);
const name = nameOf(n);
if (!name) { console.error(`Step ${n} not found. Have: ${stepDirs.join(", ")}`); process.exit(1); }

// ===== --diff 模式：对比本章和上一章的代码差异 =====
if (flag("--diff")) {
  // the previous GENERATED step (chapters 13/14 add no code, so ch15 diffs vs ch12)
  // 找到前一个有代码的章节（第13/14章没有代码，所以第15章会和第12章对比）
  let prev = null;
  for (let k = n - 1; k >= 1; k--) { const p = nameOf(k); if (p) { prev = p; break; } }
  if (!prev) { console.log(`Step ${n} is the first step — nothing to diff.`); process.exit(0); }
  // 根据语言选择对比 .ts 还是 .py
  const lang = usePy ? "py" : "ts";
  const ext = usePy ? ".py" : ".ts";
  // 收集两个章节中所有源文件的并集
  const srcFiles = new Set([...listSrc(join(DIST, prev, lang), ext), ...listSrc(join(DIST, name, lang), ext)]);
  for (const f of [...srcFiles].sort()) {
    // a file new in this chapter has no previous version — diff against /dev/null
    // 新增的文件对比 /dev/null（即整个文件都是新增的）
    const a = existsSync(join(DIST, prev, lang, f)) ? join(DIST, prev, lang, f) : "/dev/null";
    const b = existsSync(join(DIST, name, lang, f)) ? join(DIST, name, lang, f) : "/dev/null";
    spawnSync("git", ["--no-pager", "diff", "--no-index", "--", a, b], { stdio: "inherit" });
  }
  process.exit(0);
}
// 辅助函数：列出某目录下所有指定扩展名的文件
function listSrc(dir, ext) {
  try { return readdirSync(dir).filter((f) => f.endsWith(ext)); } catch { return []; }
}

// ===== --live 模式：使用真实模型（需要 .env 中的 API Key）=====
if (flag("--live")) {
  const env = { ...process.env };
  // 清除代理设置，避免代理干扰 API 请求
  for (const k of ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) delete env[k];
  // 从项目根目录的 .env 文件加载环境变量（API Key 等）
  const envFile = join(REPO, ".env");
  if (existsSync(envFile)) for (const line of readFileSync(envFile, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/); if (m) env[m[1]] = m[2];
  }
  // Python 路径：直接用 .venv 里的 Python 跑
  if (usePy) {
    const r = spawnSync(join(REPO, ".venv", "bin", "python"), [join(DIST, name, "py", "__main__.py"), ...promptArgs], { stdio: "inherit", env, cwd: REPO });
    process.exit(r.status ?? 0);
  }
  // TypeScript 路径：
  const tsDir = join(DIST, name, "ts");
  const tsc = join(REPO, "node_modules", ".bin", "tsc");
  // 第1步：用 tsc 编译该章节的 cli.ts（入口文件），输出到同目录
  const b = spawnSync(tsc, ["--module", "nodenext", "--moduleResolution", "nodenext", "--target", "es2022", "--skipLibCheck", "--outDir", tsDir, join(tsDir, "cli.ts")], { stdio: "inherit", env });
  if (b.status !== 0) process.exit(b.status ?? 1);
  // 第2步：用 node 运行编译后的 cli.js，promptArgs 作为命令行参数传入
  const r = spawnSync("node", [join(tsDir, "cli.js"), ...promptArgs], { stdio: "inherit", env, cwd: REPO });
  process.exit(r.status ?? 0);
}

// ===== 默认模式：免 API Key 的本地 mock 演示 =====
// 这是 `node steps/run.mjs 1` 走的路径。

// 加载场景映射表 _map.json（章号 → 场景配置）
const map = JSON.parse(readFileSync(join(SCEN, "_map.json"), "utf-8"));
// A step may map to several scenarios (e.g. ch15); --case picks one, else first.
// 有些章节（如第15章）有多个场景，--case 选择具体一个，否则取第一个
const mapEntry = map[String(n)];
const confs = Array.isArray(mapEntry) ? mapEntry : [mapEntry];
const conf = caseId ? confs.find((c) => c.scenario === caseId) : confs[0];
if (!conf) { console.error(`Step ${n} has no scenario "${caseId}". Have: ${confs.map((c) => c.scenario).join(", ")}`); process.exit(1); }
// 读取场景脚本 JSON（定义了 mock 模型的每一轮回复）
const scenarioPath = join(SCEN, conf.scenario + ".json");
const scenario = JSON.parse(readFileSync(scenarioPath, "utf-8"));
// expect：运行后需要验证的期望结果（文件内容、工具调用、停止原因等）
const expect = conf.expect || {};
// 如果用户传了自定义 prompt，提示他们演示是固定脚本
if (promptArgs.length) console.log("(the demo replays a scripted scenario; use --live for your own prompt)\n");
// 创建一个临时沙箱目录，演示的所有文件操作都在这个隔离目录里进行
const workdir = mkdtempSync(join(tmpdir(), `stepdemo-${n}-`));
// 把场景需要预设的文件写入沙箱（如 greeting.txt = "hello from step one"）
for (const [f, c] of Object.entries(scenario.setup?.files || {})) { const p = join(workdir, f); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); }

// 打印演示信息
console.log(`▶ step ${n} demo (no API key — local mock model)   sandbox: ${workdir}`);
// 如果场景定义了 runs（多条 CLI 命令），展示它们
if (scenario.runs) { for (const r of scenario.runs) console.log(`  $ mini-claude ${r.argv.join(" ")}`); console.log(); }
// 否则展示单条 prompt
else console.log(`  you: ${scenario.prompt}\n`);

// After the run, show a real check of the side effect so it isn't just talk.
// 运行结束后，验证实际的副作用（文件是否被正确创建/修改），而不只是看模型嘴上说的
function verify() {
  for (const [f, content] of Object.entries(expect.files || {})) {
    const p = join(workdir, f);
    const ok = existsSync(p) && readFileSync(p, "utf-8") === content;
    console.log(`\n  ✓ verified: ${f} ${ok ? `contains "${content}"` : "MISSING/incorrect"}`);
  }
}

// ===== Python 演示路径 =====
if (usePy) {
  const env = { ...process.env };
  for (const k of ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) delete env[k];
  // 用 _pydriver.py 驱动 Python 版本的 Agent，传入场景路径和沙箱目录
  const r = spawnSync(join(REPO, ".venv", "bin", "python"), [join(HERE, "_pydriver.py"), join(DIST, name, "py"), scenarioPath, join(workdir, "_events.jsonl"), workdir], { stdio: "inherit", env });
  verify();
  process.exit(r.status ?? 0);
}

// ===== TypeScript 演示路径（`node steps/run.mjs 1` 走这里）=====
// TS demo: in-process mock + the step's real code (CLI for runs, Agent for chat).
// TS 演示：进程内 mock + 该章节的真实代码（有 runs 的走 CLI 入口，否则走 Agent.chat）

// 该章节的 TS 源码目录
const tsDir = join(DIST, name, "ts");
// tsc 编译器路径
const tsc = join(REPO, "node_modules", ".bin", "tsc");
// 入口文件：场景有 runs（多命令）时编译 cli.ts，否则编译 agent.ts
const entry = scenario.runs ? "cli.ts" : "agent.ts";
// 第1步：用 tsc 编译该章节的入口文件，输出 .js 到同目录
const b = spawnSync(tsc, ["--module", "nodenext", "--moduleResolution", "nodenext", "--target", "es2022", "--skipLibCheck", "--outDir", tsDir, join(tsDir, entry)], { encoding: "utf-8" });
if (b.status !== 0) { console.error(b.stdout + b.stderr); process.exit(1); }
// 第2步：启动本地 mock Anthropic 服务器
// mock 会根据场景脚本（scenario.turns）回放预设的模型回复
// logPath 记录每次请求/响应到 JSONL 文件，供测试断言用
const mock = await startMock({ scenario, logPath: join(workdir, "_events.jsonl") });
// 第3步：设置环境变量，让 Agent 的 SDK 指向本地 mock 而非真实 API
process.env.ANTHROPIC_BASE_URL = mock.url;   // API 地址指向 mock
process.env.ANTHROPIC_API_KEY = "test";       // 假 Key，mock 不校验
// 切换工作目录到沙箱，这样工具操作的文件都在隔离环境中
process.chdir(workdir);
// 第4步：运行该章节的真实代码
if (scenario.runs) {
  // 有 runs：动态 import 编译后的 cli.js，依次调用 runCli(argv) 执行每条命令
  const mod = await import(pathToFileURL(join(tsDir, "cli.js")).href);
  for (const r of scenario.runs) await mod.runCli(r.argv);
} else {
  // 无 runs：动态 import 编译后的 agent.js，直接调 Agent.chat(prompt)
  // 这就是 `node steps/run.mjs 1` 的核心执行点：
  //   new Agent()  →  创建 Agent（SDK 会读取刚才设置的环境变量连到 mock）
  //   .chat(prompt)  →  进入对话循环：发请求 → mock 回放 tool_use → Agent 真正执行工具 → 结果喂回 → mock 回放最终文字
  const mod = await import(pathToFileURL(join(tsDir, "agent.js")).href);
  await new mod.Agent().chat(scenario.prompt);
}
// 第5步：关闭 mock 服务器
await mock.close();
// 第6步：验证副作用（文件是否被正确创建/修改）
verify();
// 退出
process.exit(0);
