// ===== 依赖导入 =====
// Anthropic 官方 SDK，用于调用 Claude 模型
import Anthropic from "@anthropic-ai/sdk";
// 工具定义表与工具执行器，二者构成 Agent 的「手脚」
import { toolDefinitions, executeTool } from "./tools.js";
//#step >=3
// 系统提示词构建器：第 3 章引入，用环境信息增强静态核心提示词
import { buildSystemPrompt } from "./prompt.js";
//#endstep
//#step >=6
// 权限检查器：第 6 章引入，在执行工具前做安全拦截
import { checkPermission } from "./permissions.js";
//#endstep
//#step >=7
// 上下文压缩器：第 7 章引入，对话历史过长时自动摘要以腾出 token
import { maybeCompact } from "./context.js";
//#endstep
//#step >=8
// 记忆召回器：第 8 章引入，根据用户输入检索相关记忆注入提示词
import { recallMemories } from "./memory.js";
//#endstep
//#step >=11
// 子 Agent 运行器：第 11 章引入，用于派生只读子 Agent 处理独立任务
import { runSubAgent } from "./subagent.js";
//#endstep
//#step >=12
// MCP（Model Context Protocol）连接器：第 12 章引入，用于接入外部工具服务器
import { connectMcp, type McpConnection } from "./mcp.js";
//#endstep
//#step >=15
// 自主性模块：第 15 章引入，包含目标评估器与动作分类器
import { evaluateGoal, classifyAction } from "./autonomy.js";
//#endstep

// 使用的模型，优先取环境变量，否则回退到默认的 claude-sonnet
const MODEL = process.env.MINI_MODEL || "claude-sonnet-4-5-20250929";

//#step <=2
// A minimal, hard-coded system prompt. Chapter 3 replaces this with a real
// static-core-plus-environment prompt built in prompt.ts.
// 一个最简的硬编码系统提示词。第 3 章会用 prompt.ts 中构建的
// 「静态核心 + 环境信息」提示词来替换它。
const SYSTEM_PROMPT =
  "You are Mini Claude Code, a small coding assistant that helps with software " +
  "tasks. Use the tools to read and change files. Keep answers short.";
//#endstep

// The whole agent is one class holding a growing message array and a loop.
// 整个 Agent 就是一个类：内部维护一个不断增长的消息数组，外加一个对话循环。
export class Agent {
  // Anthropic SDK 客户端实例，负责实际调用模型 API
  private client: Anthropic;
  // 对话历史：随着对话推进不断累积，每次调用都整体发送给模型
  private messages: Anthropic.MessageParam[] = [];
//#step >=10
  mode = "default"; // "plan" makes the agent read-only
  // 运行模式；"plan" 模式下 Agent 变为只读，禁止写文件和执行 shell
//#endstep

  // 构造函数：创建 Anthropic 客户端
  constructor() {
    this.client = new Anthropic({
      // API 密钥从环境变量读取
      apiKey: process.env.ANTHROPIC_API_KEY,
      // Optional: point at an Anthropic-compatible relay via ANTHROPIC_BASE_URL.
      // 可选：通过 ANTHROPIC_BASE_URL 指向一个兼容 Anthropic 协议的中转服务。
      baseURL: process.env.ANTHROPIC_BASE_URL,
    });
  }

  // One user turn. Call the model; if it asks for tools, run them and feed the
  // results back; repeat until it answers with plain text.
  // 处理一轮用户对话：调用模型；如果模型请求调用工具，就执行工具并把
  // 结果回传给模型；如此循环，直到模型给出纯文本回复为止。
//#region loop
  async chat(userText: string): Promise<void> {
    // 先把用户的输入追加到对话历史
    this.messages.push({ role: "user", content: userText });
//#step >=12
    await this.ensureMcp(); // discover external MCP tools before the loop
    // 进入循环前先发现并连接外部 MCP 工具
//#endstep

    // 主循环：不断「调用模型 → 处理工具 → 再调用模型」，直到模型不再请求工具
    while (true) {
//#step >=7
      // Before each model call, compact the history if it has grown too long.
      // 每次调用模型前，如果历史太长就进行压缩摘要，腾出上下文空间。
      this.messages = await maybeCompact(this.messages, this.client, MODEL);
//#endstep
//#step >=3
      let system = buildSystemPrompt(); // 第 3 章起：用 prompt.ts 构建带环境信息的系统提示词
//#step <=2
      let system = SYSTEM_PROMPT; // 第 1-2 章：使用上面硬编码的简单提示词
//#endstep
//#step >=8
      // Recall memories relevant to what the user just asked, into the prompt.
      // 召回与用户当前问题相关的记忆，拼接到系统提示词末尾。
      system += recallMemories(userText);
//#endstep
//#step >=12
      // Merge in any external MCP tools, prefixed so we can route their calls back.
      // 合并外部 MCP 工具，统一加上前缀，以便后续把工具调用路由回对应服务器。
      const mcpTools: Anthropic.Tool[] = (this.mcp?.tools || []).map((t) => ({ name: `mcp__demo__${t.name}`, description: t.description, input_schema: t.input_schema as any }));
      // 将内置工具与 MCP 工具合并为完整工具集
      const tools = [...toolDefinitions, ...mcpTools];
//#endstep
      // Build the request once. Passing `tools` is the one line that makes the
      // model tool-aware. Chapter 5 turns the call itself into a stream.
      // 构建一次请求。传入 `tools` 是让模型「感知到工具」的关键那一行。
      // 第 5 章会把这次调用本身改成流式调用。
      const request = {
        model: MODEL,
        max_tokens: 4096,
        system,
//#step >=12
        tools,
//#step <=11
        tools: toolDefinitions,
//#endstep
        messages: this.messages,
      };

//#step >=5
      // Stream the reply so text shows up as it is generated, then collect the
      // finished message (same shape a non-streaming call would return).
      // 以流式方式获取回复，这样文字会边生成边显示；最后再收集完整的
      // 消息对象（与非流式调用返回的结构完全相同）。
      const stream = this.client.messages.stream(request);
      // 每收到一段文本就立即写入标准输出，实现打字机效果
      stream.on("text", (t) => process.stdout.write(t));
      const reply = await stream.finalMessage();
      process.stdout.write("\n");
//#step <=4
      const reply = await this.client.messages.create(request);
      // 遍历回复内容块，把文本块逐个输出（非流式写法）
      for (const block of reply.content) {
        if (block.type === "text") process.stdout.write(block.text);
      }
      process.stdout.write("\n");
//#endstep

      // Record the assistant's full reply (text + any tool calls).
      // 把助手这一轮的完整回复（文本 + 可能的工具调用）记入对话历史。
      this.messages.push({ role: "assistant", content: reply.content });

      // 从回复内容块中筛选出所有工具调用块
      const toolUses = reply.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );
      // No tool calls means the model is done with this turn.
      // 没有工具调用，说明模型认为本轮对话结束，直接返回。
      if (toolUses.length === 0) return;

      // Run every requested tool and send the outputs back as one user message.
      // 执行所有被请求的工具，然后把输出结果作为一条 user 消息回传给模型。
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        // 打印正在执行的工具名和参数，方便调试和观察
        console.log(`  → ${tu.name}(${JSON.stringify(tu.input)})`);
//#step >=11
        // The `agent` tool forks a read-only sub-agent with its own context.
        // `agent` 工具：派生一个拥有独立上下文的只读子 Agent 来处理任务。
        if (tu.name === "agent") {
          const summary = await runSubAgent(String((tu.input as any).task || ""), this.client, MODEL);
          results.push({ type: "tool_result", tool_use_id: tu.id, content: summary });
          continue;
        }
//#endstep
//#step >=12
        // MCP tools (mcp__server__tool) are routed to the MCP server, not run locally.
        // MCP 工具（mcp__server__tool 格式）被路由到 MCP 服务器执行，而非本地执行。
        if (tu.name.startsWith("mcp__")) {
          // mcp__<server>__<tool> → <tool>; drop the first two "__" segments so a
          // server name with underscores strips the same way Python's does.
          // mcp__<服务器>__<工具> → <工具>；截掉前两段 "__"，
          // 这样带下划线的服务器名也能正确解析（与 Python 端的截取方式一致）。
          const toolName = tu.name.split("__").slice(2).join("__");
          const output = this.mcp ? await this.mcp.callTool(toolName, tu.input) : "Denied: no MCP server connected.";
          results.push({ type: "tool_result", tool_use_id: tu.id, content: output });
          continue;
        }
//#endstep
//#step >=15
        // Auto mode: a classifier decides block/allow instead of asking a human.
        // 自动模式：由分类器决定是放行还是拦截，而不是询问人类确认。
        if (this.mode === "auto" && (tu.name === "write_file" || tu.name === "edit_file" || tu.name === "run_shell")) {
          const verdict = await classifyAction(tu.name, tu.input, this.transcriptText(), this.client, MODEL);
          if (!verdict.allow) {
            results.push({ type: "tool_result", tool_use_id: tu.id, content: `Blocked by auto-mode monitor: ${verdict.reason}` });
            continue;
          }
        }
//#endstep
//#step >=10
        // Plan mode is read-only: writes and shell are denied on top of the gate.
        // Plan 模式是只读的：在权限门控的基础上，额外拦截写文件和执行 shell。
        const blocked = checkPermission(tu.name, tu.input as Record<string, any>) === "deny"
          || (this.mode === "plan" && (tu.name === "write_file" || tu.name === "edit_file" || tu.name === "run_shell"));
        const output = blocked
          ? `Denied: ${tu.name} was blocked (${this.mode} mode).`
          : await executeTool(tu.name, tu.input as Record<string, any>);
//#step >=6
        // Check permission before running the tool; a denied call never runs.
        // 执行工具前先检查权限；被拒绝的调用永远不会真正执行。
        const output = checkPermission(tu.name, tu.input as Record<string, any>) === "deny"
          ? `Denied: ${tu.name} was blocked by the permission system.`
          : await executeTool(tu.name, tu.input as Record<string, any>);
//#step <=5
        // 第 1-5 章：直接执行工具，无权限检查
        const output = await executeTool(tu.name, tu.input as Record<string, any>);
//#endstep
        results.push({ type: "tool_result", tool_use_id: tu.id, content: output });
      }
      // 把所有工具结果作为一条 user 消息追加到历史，进入下一轮循环
      this.messages.push({ role: "user", content: results });
    }
  }
//#endregion
//#step >=4
  // Session support: expose the history so the CLI can save it and restore it.
  // 会话支持：暴露对话历史，让 CLI 能够保存和恢复会话状态。
  // 获取当前完整对话历史
  history(): Anthropic.MessageParam[] { return this.messages; }
  // 从外部恢复对话历史（如从磁盘加载已保存的会话）
  loadHistory(messages: Anthropic.MessageParam[]): void { this.messages = messages; }
  // 清空对话历史，开始全新会话
  clearHistory(): void { this.messages = []; }
//#endstep
//#step >=10
  // 设置运行模式（"default" / "plan" / "auto"）
  setMode(m: string): void { this.mode = m; }
//#endstep
//#step >=12
  // MCP 服务器连接实例，惰性初始化（首次使用时才连接）
  private mcp: McpConnection | null = null;
  // Connect to the MCP server named in MINI_MCP_SERVER once, on first use.
  // 在首次使用时连接 MINI_MCP_SERVER 环境变量指定的 MCP 服务器（只连接一次）。
  private async ensureMcp(): Promise<void> {
    // 已连接或未配置 MCP 服务器时直接返回
    if (this.mcp || !process.env.MINI_MCP_SERVER) return;
    this.mcp = await connectMcp("node", [process.env.MINI_MCP_SERVER]);
  }
//#endstep
//#step >=15
  // 把完整对话历史扁平化为一段纯文本，供评估器和分类器阅读
  private transcriptText(): string {
    return this.messages.map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : "[tool call / result]"}`).join("\n");
  }
  // Autonomy: keep working until an independent evaluator judges the condition met.
  // 自主性：持续工作，直到一个独立的评估器判定目标条件已满足为止。
  async pursueGoal(condition: string, prompt: string): Promise<void> {
    // 先执行一次初始提示
    await this.chat(prompt);
    // 最多重试 5 轮，每轮由评估器判断目标是否达成
    for (let i = 0; i < 5; i++) {
      const verdict = await evaluateGoal(condition, this.transcriptText(), this.client, MODEL);
      if (verdict.met) { console.log(`✓ goal met: ${condition}`); return; }
      // 未达成，打印原因并继续催促模型努力
      console.log(`  (goal not met — ${verdict.reason}; continuing)`);
      await this.chat(`The goal "${condition}" is not met yet: ${verdict.reason}. Keep working toward it.`);
    }
    // 5 轮仍未达成，放弃并告知用户
    console.log(`  (gave up after 5 iterations without meeting: ${condition})`);
  }
//#endstep
}
