// 导入 Anthropic 官方 SDK（用于 Claude 模型后端）
import Anthropic from "@anthropic-ai/sdk";
// 导入 OpenAI SDK（用于兼容 OpenAI 接口的模型后端）
import OpenAI from "openai";
// chalk：终端彩色输出库
import chalk from "chalk";
// 从 tools.js 导入工具定义、工具执行、权限检查、并发安全工具集等
import { toolDefinitions, executeTool, checkPermission, CONCURRENCY_SAFE_TOOLS, getActiveToolDefinitions, getDeferredToolNames, truncateResult, type ToolDef, type PermissionMode } from "./tools.js";
// 从 ui.js 导入各种终端 UI 输出函数（打印助手文本、工具调用、结果、错误等）
import {
  printAssistantText,
  printToolCall,
  printToolResult,
  printError,
  printConfirmation,
  printDivider,
  printCost,
  printRetry,
  printInfo,
  printSubAgentStart,
  printSubAgentEnd,
  startSpinner,
  stopSpinner,
} from "./ui.js";
// saveSession：将会话历史持久化到磁盘
import { saveSession } from "./session.js";
// 从 prompt.js 导入系统提示词构建相关函数（静态/动态分割、用户上下文提醒、CLAUDE.md 加载）
import { buildSystemPrompt, buildStaticSystemPrompt, buildDynamicSystemContext, buildUserContextReminder, loadClaudeMd } from "./prompt.js";
// 从 subagent.js 导入子代理配置获取函数及子代理类型
import { getSubAgentConfig, type SubAgentType } from "./subagent.js";
// 从 memory.js 导入记忆预取相关函数和类型（语义记忆检索）
import {
  startMemoryPrefetch, formatMemoriesForInjection,
  type MemoryPrefetch, type RelevantMemory, type SideQueryFn,
} from "./memory.js";
// McpManager：MCP（Model Context Protocol）服务器管理器
import { McpManager } from "./mcp.js";
// 从 autonomy.js 导入自主性相关常量和函数（/goal 目标追求、/loop 循环、Auto Mode 自动模式分类器）
import {
  goalDirective, GOAL_EVALUATOR_SYSTEM, GOAL_TRANSCRIPT_FRAMING, goalJudgeUserMessage,
  parseGoalVerdict, GOAL_MAX_ITERATIONS, type GoalVerdict,
  parseLoopInput, isDailyWording, OFFER_CLOUD_THRESHOLD_SECONDS,
  SCHEDULE_WAKEUP_TOOL, clampWakeupDelay, dynamicLoopDirective, LOOP_MAX_ITERATIONS,
  type LoopSpec,
  loadAutoModeRules, buildClassifierSystem, AUTO_MODE_FAST_PATH_TOOLS, DENIAL_LIMITS,
  buildClassifierTranscript, parseBlockVerdict, classifierUserMessage,
} from "./autonomy.js";
// readline：Node.js 内置逐行读取模块（用于交互式确认输入）
import * as readline from "readline";
// crypto.randomUUID：生成唯一标识符（会话 ID、文件名等）
import { randomUUID } from "crypto";
// fs 模块：文件系统操作（检查/读取/创建/写入文件）
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
// path.join：跨平台路径拼接
import { join } from "path";
// os.homedir：获取用户主目录路径
import { homedir } from "os";

// ─── Retry with exponential backoff ──────────────────────────
// 重试与指数退避：当 API 返回可重试错误（限流、过载、网络超时）时自动重试

// 判断一个错误是否值得重试（限流 429、服务不可用 503、过载 529、网络中断等）
function isRetryable(error: any): boolean {
  const status = error?.status || error?.statusCode;
  // 429 限流 / 503 服务不可用 / 529 过载 —— 这些状态码重试通常有效
  if ([429, 503, 529].includes(status)) return true;
  // 连接重置 / 连接超时 —— 瞬时网络问题，重试可恢复
  if (error?.code === "ECONNRESET" || error?.code === "ETIMEDOUT") return true;
  // 错误消息中包含 "overloaded"（服务端过载提示）
  if (error?.message?.includes("overloaded")) return true;
  return false;
}

// 带指数退避的重试包装器：包裹一个异步函数，失败时按指数退避策略重试
// 泛型 T：被包裹函数的返回类型
// fn：要执行的异步函数（接收可选的 AbortSignal 用于取消）
// signal：外部取消信号，若已取消则直接抛出不再重试
// maxRetries：最大重试次数（默认 3 次）
async function withRetry<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  maxRetries = 3
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      // 尝试执行函数，成功则直接返回结果
      return await fn(signal);
    } catch (error: any) {
      // 如果外部已发出取消信号，直接抛出错误，不重试
      if (signal?.aborted) throw error;
      // 已达最大重试次数，或错误不可重试，则抛出
      if (attempt >= maxRetries || !isRetryable(error)) throw error;
      // 计算退避延迟：基数 1秒 * 2^attempt，上限 30秒，再加 0~1秒随机抖动（避免多个客户端同步重试）
      const delay = Math.min(1000 * Math.pow(2, attempt), 30000) + Math.random() * 1000;
      // 提取错误原因描述，用于终端显示
      const reason = error?.status ? `HTTP ${error.status}` : error?.code || "network error";
      // 在终端打印重试信息（第几次重试 / 最大次数 / 原因）
      printRetry(attempt + 1, maxRetries, reason);
      // 等待退避延迟后进入下一次尝试
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ─── Model context windows ──────────────────────────────────
// 模型上下文窗口配置：记录各模型支持的最大上下文长度（token 数）

// 各模型 → 上下文窗口大小（单位：token）的映射表
const MODEL_CONTEXT: Record<string, number> = {
  "claude-opus-4-6": 200000,
  "claude-sonnet-4-6": 200000,
  "claude-sonnet-4-20250514": 200000,
  "claude-haiku-4-5-20251001": 200000,
  "claude-opus-4-20250514": 200000,
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
};

// 获取指定模型的上下文窗口大小，未知模型默认 200000
// model：模型名称字符串
// 返回：上下文窗口的 token 数
function getContextWindow(model: string): number {
  return MODEL_CONTEXT[model] || 200000;
}

// ─── Thinking support detection ─────────────────────────────
// 思维链（thinking）能力检测
// Following the general Claude 4.x thinking-mode guidance: adaptive for 4.6, enabled for older Claude 4, disabled for the rest.
// 遵循 Claude 4.x 思维模式通用指南：4.6 版本自适应，旧版 Claude 4 启用，其余禁用。

// 检测模型是否支持 thinking（思维链）功能
// model：模型名称
// 返回：true 表示支持 thinking
function modelSupportsThinking(model: string): boolean {
  const m = model.toLowerCase();
  // Claude 4+ models support thinking (not Claude 3.x)
  // Claude 4+ 模型支持 thinking（Claude 3.x 不支持）
  if (m.includes("claude-3-") || m.includes("3-5-") || m.includes("3-7-")) return false;
  // Claude 4 系列的 opus/sonnet/haiku 均支持 thinking
  if (m.includes("claude") && (m.includes("opus") || m.includes("sonnet") || m.includes("haiku"))) return true;
  return false; // non-Claude models (GPT, etc.) — no thinking
  // 非 Claude 模型（GPT 等）—— 不支持 thinking
}

// 检测模型是否支持"自适应"thinking 模式（模型自行决定是否思考）
// 仅 Claude 4.6（opus-4-6 / sonnet-4-6）支持自适应
function modelSupportsAdaptiveThinking(model: string): boolean {
  const m = model.toLowerCase();
  return m.includes("opus-4-6") || m.includes("sonnet-4-6");
}

// Max output tokens by model (following the same caps Claude Code uses publicly)
// 各模型最大输出 token 数（沿用 Claude Code 公开使用的上限）
// model：模型名称
// 返回：该模型单次响应的最大输出 token 数
function getMaxOutputTokens(model: string): number {
  const m = model.toLowerCase();
  if (m.includes("opus-4-6")) return 64000;       // Opus 4.6：64000
  if (m.includes("sonnet-4-6")) return 32000;      // Sonnet 4.6：32000
  if (m.includes("opus-4") || m.includes("sonnet-4") || m.includes("haiku-4")) return 32000; // 其他 Claude 4：32000
  return 16384; // safe default for unknown models
  // 未知模型的安全默认值：16384
}

// ─── Convert tools to OpenAI format ─────────────────────────
// 将内部工具定义转换为 OpenAI 函数调用格式
// OpenAI 使用 { type: "function", function: {...} } 结构，而 Anthropic 使用 input_schema

// tools：内部 ToolDef 工具定义数组
// 返回：OpenAI 兼容的 ChatCompletionTool 数组
function toOpenAITools(tools: ToolDef[]): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,                       // 工具名称
      description: t.description,         // 工具描述
      parameters: t.input_schema as Record<string, unknown>, // JSON Schema 参数定义
    },
  }));
}

// ─── Multi-tier compression constants ────────────────────────
// 多层级压缩常量配置
// 4-layer compression pipeline inspired by Claude Code's published design: budget → snip → microcompact → auto-compact
// 受 Claude Code 公开设计启发的 4 层压缩流水线：预算裁剪 → 剪切旧结果 → 微压缩 → 自动压缩

// 可被"剪切"的工具集合（这些工具产生的大结果可安全替换为占位符，需要时重新读取）
const SNIPPABLE_TOOLS = new Set(["read_file", "grep_search", "list_files", "run_shell"]);
// 剪切后替换的占位文本，提示模型可重新读取
const SNIP_PLACEHOLDER = "[Content snipped - re-read if needed]";
// 触发剪切的上下文利用率阈值（60%）—— 超过此利用率时开始剪切旧结果
const SNIP_THRESHOLD = 0.60;
// Above this utilization we snip even while the cache is hot: preserving the
// cache is not worth risking a context overflow. Below it, a hot cache is left
// untouched (see snip functions). Sits between SNIP_THRESHOLD and autocompact.
// 利用率超过此值时，即使缓存仍"热"也强制剪切：保留缓存不如避免上下文溢出重要。
// 低于此值时，热缓存保持不动（见 snip 相关函数）。该值介于 SNIP_THRESHOLD 和自动压缩之间。
const SNIP_HOT_OVERRIDE = 0.75;
// 微压缩触发条件：距离上次 API 调用超过 5 分钟（缓存已"冷却"）
const MICROCOMPACT_IDLE_MS = 5 * 60 * 1000; // 5 minutes（5 分钟）
// 压缩时保留的最近结果数量（保留最近 3 个工具结果完整不动）
const KEEP_RECENT_RESULTS = 3;

// ─── Agent ───────────────────────────────────────────────────
// Agent 类：本项目的核心，封装了一个完整的 LLM 编码助手代理。
// 支持双后端（Anthropic / OpenAI 兼容）、工具调用、流式输出、上下文压缩、
// 权限控制、目标追求（/goal）、循环执行（/loop）、自动模式（Auto Mode）、计划模式等。

// Agent 构造选项接口
interface AgentOptions {
  permissionMode?: PermissionMode;       // 权限模式（default/acceptEdits/bypassPermissions/plan/auto）
  yolo?: boolean;             // Legacy alias for bypassPermissions
  // yolo：bypassPermissions 的旧别名（跳过所有权限确认）
  model?: string;                        // 使用的模型名称
  apiBase?: string;           // OpenAI-compatible base URL
  // apiBase：OpenAI 兼容的 API 基础 URL（设置后启用 OpenAI 后端）
  anthropicBaseURL?: string;  // Anthropic base URL (e.g. proxy)
  // anthropicBaseURL：Anthropic 基础 URL（如代理地址）
  apiKey?: string;                       // API 密钥
  thinking?: boolean;                    // 是否启用思维链（thinking）
  maxCostUsd?: number;        // Budget: max USD spend
  // maxCostUsd：预算上限（最大美元花费）
  maxTurns?: number;          // Budget: max agentic turns
  // maxTurns：预算上限（最大代理回合数）
  confirmFn?: (message: string) => Promise<boolean>; // External confirmation callback
  // confirmFn：外部确认回调（用于 REPL 中复用现有 readline）
  // Sub-agent options
  // 子代理相关选项
  customSystemPrompt?: string;           // 自定义系统提示词（覆盖默认）
  customTools?: ToolDef[];               // 自定义工具列表（子代理用）
  isSubAgent?: boolean;                  // 是否为子代理（子代理不自动保存/打印分隔线）
}

export class Agent {
  // Anthropic SDK 客户端实例（使用 Claude 后端时存在）
  private anthropicClient?: Anthropic;
  // OpenAI SDK 客户端实例（使用 OpenAI 兼容后端时存在）
  private openaiClient?: OpenAI;
  // 是否使用 OpenAI 兼容后端（true = OpenAI，false = Anthropic）
  private useOpenAI: boolean;
  // 当前权限模式
  private permissionMode: PermissionMode;
  // 是否请求启用 thinking（用户意图）
  private thinking: boolean;
  // 实际生效的 thinking 模式（经模型能力检测后确定）
  private thinkingMode: "adaptive" | "enabled" | "disabled";
  // 当前使用的模型名称
  private model: string;
  // 当前完整的系统提示词（可能包含 plan 模式后缀）
  private systemPrompt: string;
  // 可用工具定义列表
  private tools: ToolDef[];
  // 累计输入 token 数（未命中缓存的部分）
  private totalInputTokens = 0;
  // 累计输出 token 数
  private totalOutputTokens = 0;
  private totalCacheReadTokens = 0;      // Prompt-cache hits (billed ~0.1x)
  // 累计缓存读取 token 数（提示缓存命中，按约 0.1 倍计费）
  private totalCacheCreationTokens = 0;  // Prompt-cache writes (billed ~1.25x)
  // 累计缓存创建 token 数（提示缓存写入，按约 1.25 倍计费）
  // 上一次 API 调用估算的输入 token 数（用于压缩触发判定）
  private lastInputTokenCount = 0;
  // 有效上下文窗口大小（= 模型窗口 - 预留的 20000 token 余量）
  private effectiveWindow: number;
  // 会话 ID（8 位随机字符串）
  private sessionId: string;
  // 会话开始时间（ISO 格式字符串）
  private sessionStartTime: string;
  // 是否为子代理
  private isSubAgent: boolean;

  // MCP integration
  // MCP（Model Context Protocol）集成
  // MCP 服务器管理器实例
  private mcpManager = new McpManager();
  // MCP 是否已初始化连接
  private mcpInitialized = false;

  // Budget control
  // 预算控制
  // 最大花费上限（美元），undefined 表示无限制
  private maxCostUsd?: number;
  // 最大回合数上限，undefined 表示无限制
  private maxTurns?: number;
  // 当前已执行的代理回合数
  private currentTurns = 0;

  // /goal — session-scoped Stop-hook condition, pursued across turns
  // /goal —— 会话级 Stop-hook 条件，跨多个回合持续追求
  // 活动目标的状态对象（null 表示无活动目标）
  private activeGoal: {
    condition: string;    // 目标条件描述
    iterations: number;   // 已迭代次数
    startedAt: number;    // 开始时间戳
    lastReason?: string;  // 上次未达成的理由
  } | null = null;

  private goalStop = false; // set on interrupt to break out of goal pursuit
  // goalStop：中断标志，设为 true 时跳出目标追求循环

  // /loop dynamic mode — set when the model calls schedule_wakeup during a tick,
  // read (and cleared) by the loop driver after the turn converges.
  // /loop 动态模式 —— 当模型在一个 tick 中调用 schedule_wakeup 时设置，
  // 由循环驱动器在回合收敛后读取（并清除）。
  // 待处理的唤醒请求（延迟秒数、理由、下次提示词）
  private pendingWakeup: { delaySeconds: number; reason: string; prompt: string } | null = null;
  private loopStop = false; // set on interrupt to break out of a running loop
  // loopStop：中断标志，设为 true 时跳出运行中的循环
  // schedule_wakeup is routed to the internal executor only while a dynamic loop
  // is active, so it can't shadow a same-named tool or be reached out of band.
  // schedule_wakeup 仅在动态循环激活时路由到内部执行器，因此不会遮蔽同名外部工具或被越权调用。
  // schedule_wakeup 是否已启用（仅在动态循环期间为 true）
  private scheduleWakeupEnabled = false;

  // Auto Mode — transcript-classifier denial tracking (auto_mode DENIAL_LIMITS).
  // Auto Mode —— 转录分类器拒绝次数追踪（auto_mode DENIAL_LIMITS）。
  // 连续拒绝次数（达到上限后交还人工）
  private autoConsecutiveDenials = 0;
  // 总拒绝次数（达到上限后交还人工）
  private autoTotalDenials = 0;

  // Multi-tier compression state
  // 多层级压缩状态
  // 上次 API 调用的时间戳（用于判断缓存是否已"冷却"）
  private lastApiCallTime = 0;

  // Abort support
  // 中断支持
  // 当前请求的 AbortController（null 表示无进行中的请求）
  private abortController: AbortController | null = null;

  // Permission whitelist: paths confirmed in this session
  // 权限白名单：本会话中已确认的路径（避免重复确认）
  private confirmedPaths: Set<string> = new Set();

  // Plan mode state
  // 计划模式（Plan mode）状态
  // 进入 plan 模式前的权限模式（用于退出时恢复）
  private prePlanMode: PermissionMode | null = null;
  // 当前计划文件的路径（plan 模式下模型唯一可写的文件）
  private planFilePath: string | null = null;
  // 基础系统提示词（不含 plan 模式后缀）
  private baseSystemPrompt: string = "";
  // Static/dynamic split for prefix caching: the static half is identical for
  // every session and sits behind a cache_control breakpoint; the dynamic half
  // (env, git, memory, CLAUDE.md) stays uncached. Mirrors Claude Code's
  // splitSysPromptPrefix (see how-claude-code-works ch3.6).
  // 为前缀缓存做的静态/动态分割：静态部分每个会话都相同，放在 cache_control 断点后；
  // 动态部分（环境、git、记忆、CLAUDE.md）不缓存。仿照 Claude Code 的 splitSysPromptPrefix。
  // 静态系统提示词核心（可缓存的稳定前缀）
  private staticSystemPrompt: string = "";
  // 动态系统上下文（环境/git/技能等，不缓存）
  private dynamicSystemContext: string = "";
  // CLAUDE.md + date, injected into the first user message (Claude Code's
  // prependUserContext) rather than the system prompt, so the system stays
  // project-independent and cacheable. Empty for custom system prompts.
  // CLAUDE.md + 日期，注入到第一条用户消息中（Claude Code 的 prependUserContext），
  // 而非放入系统提示词，以保持系统提示词的项目无关性和可缓存性。自定义提示词时为空。
  // 用户上下文提醒文本（注入首条用户消息）
  private userContextReminder: string = "";
  private contextCleared: boolean = false; // Set when plan approval clears context
  // contextCleared：计划审批清除上下文后设为 true，用于信号代理循环重新注入计划

  // External confirmation callback (avoids creating a second readline on stdin)
  // 外部确认回调（避免在 stdin 上创建第二个 readline 接口）
  private confirmFn?: (message: string) => Promise<boolean>;

  // Plan approval callback: returns { choice, feedback? }
  // 计划审批回调：返回 { choice（审批选择）, feedback?（反馈意见） }
  private planApprovalFn?: (planContent: string) => Promise<{
    choice: "clear-and-execute" | "execute" | "manual-execute" | "keep-planning";
    feedback?: string;
  }>;

  // Sub-agent output buffer (captures text instead of printing)
  // 子代理输出缓冲区（捕获文本而非直接打印到终端）
  private outputBuffer: string[] | null = null;

  // Read-before-edit: track file read timestamps (absolutePath → mtimeMs)
  // 先读后编：追踪文件读取时间戳（绝对路径 → 修改时间毫秒）
  // 用于检测编辑前是否已读取最新版本
  private readFileState: Map<string, number> = new Map();

  // Memory recall state — semantic prefetch per user turn. The handle lives
  // on the instance so a recall that settles after this turn's last API call
  // is carried over and injected next turn (issue #7).
  // 记忆召回状态 —— 每个用户回合的语义预取。句柄存在实例上，
  // 使得在本回合最后一次 API 调用后才完成的召回能延续到下一回合注入（issue #7）。
  // 已展示过的记忆路径集合（避免重复展示相同记忆）
  private alreadySurfacedMemories: Set<string> = new Set();
  // 本会话已注入的记忆总字节数（控制注入量）
  private sessionMemoryBytes = 0;
  // 当前进行中的记忆预取句柄
  private memoryPrefetch: MemoryPrefetch | null = null;

  // Separate message histories for each backend
  // 各后端各自维护独立的消息历史
  // Anthropic 格式的消息历史
  private anthropicMessages: Anthropic.MessageParam[] = [];
  // OpenAI 格式的消息历史
  private openaiMessages: OpenAI.ChatCompletionMessageParam[] = [];

  // 构造函数：初始化 Agent 实例
  // options：构造选项（可选，默认使用 Claude opus-4-6）
  constructor(options: AgentOptions = {}) {
    // Permission mode: explicit mode > yolo legacy > default
    // 权限模式优先级：显式指定 > yolo 旧别名 > 默认值
    this.permissionMode = options.permissionMode
      || (options.yolo ? "bypassPermissions" : "default");
    this.thinking = options.thinking || false;
    this.model = options.model || "claude-opus-4-6";
    // 根据用户意图和模型能力解析实际的 thinking 模式
    this.thinkingMode = this.resolveThinkingMode();
    // 有 apiBase 就用 OpenAI 后端
    this.useOpenAI = !!options.apiBase;
    this.isSubAgent = options.isSubAgent || false;
    // 子代理用自定义工具，主代理用默认全部工具定义
    this.tools = options.customTools || toolDefinitions;
    this.maxCostUsd = options.maxCostUsd;
    this.maxTurns = options.maxTurns;
    this.confirmFn = options.confirmFn;
    // 有效窗口 = 模型上下文窗口 - 20000（预留余量给工具结果和输出）
    this.effectiveWindow = getContextWindow(this.model) - 20000;
    // 会话 ID 取 UUID 前 8 位
    this.sessionId = randomUUID().slice(0, 8);
    this.sessionStartTime = new Date().toISOString();

    // Build system prompt with a static/dynamic split for prefix caching.
    // A custom system prompt overrides both halves (all of it is treated as
    // static). Otherwise the static core is cacheable, env/git/skills form the
    // dynamic tail, and CLAUDE.md + date go into the FIRST user message as a
    // <system-reminder> (Claude Code's prependUserContext) — see chat(). Keeping
    // project-specific content out of the system prompt maximizes cache sharing.
    // 构建系统提示词，做静态/动态分割以利于前缀缓存。
    // 自定义系统提示词会覆盖两半（整体视为静态）。
    // 否则静态核心可缓存，env/git/skills 组成动态尾部，
    // CLAUDE.md + 日期放入第一条用户消息（Claude Code 的 prependUserContext）—— 见 chat()。
    // 将项目特定内容排除出系统提示词可最大化缓存共享。
    if (options.customSystemPrompt) {
      // 自定义提示词：整体作为静态部分
      this.staticSystemPrompt = options.customSystemPrompt;
      this.dynamicSystemContext = "";
    } else {
      // 默认：构建静态核心 + 动态上下文 + 用户上下文提醒
      this.staticSystemPrompt = buildStaticSystemPrompt();
      this.dynamicSystemContext = buildDynamicSystemContext();
      this.userContextReminder = buildUserContextReminder();
    }
    // 基础系统提示词 = 静态部分 +（若有）动态部分
    this.baseSystemPrompt = this.dynamicSystemContext
      ? this.staticSystemPrompt + "\n\n" + this.dynamicSystemContext
      : this.staticSystemPrompt;
    // plan 模式下，在基础提示词后追加 plan 模式指令
    if (this.permissionMode === "plan") {
      this.planFilePath = this.generatePlanFilePath();
      this.systemPrompt = this.baseSystemPrompt + this.buildPlanModePrompt();
    } else {
      this.systemPrompt = this.baseSystemPrompt;
    }

    // Optional: cap the SDK's own retry layer (default 2). Set
    // MINI_CLAUDE_SDK_MAX_RETRIES=0 to isolate our withRetry() in tests (or to
    // opt out of double-retrying in production).
    // 可选：限制 SDK 自带的重试层（默认 2 次）。
    // 设置环境变量 MINI_CLAUDE_SDK_MAX_RETRIES=0 可在测试中隔离我们的 withRetry()
    // （或避免生产环境中双重重试）。
    const sdkRetries =
      process.env.MINI_CLAUDE_SDK_MAX_RETRIES != null && process.env.MINI_CLAUDE_SDK_MAX_RETRIES !== "" &&
      !Number.isNaN(Number(process.env.MINI_CLAUDE_SDK_MAX_RETRIES))
        ? { maxRetries: Number(process.env.MINI_CLAUDE_SDK_MAX_RETRIES) }
        : {};
    // 根据后端类型创建对应的 SDK 客户端
    if (this.useOpenAI) {
      // OpenAI 兼容后端
      this.openaiClient = new OpenAI({
        baseURL: options.apiBase,
        apiKey: options.apiKey,
        ...sdkRetries,
      });
      // OpenAI 格式：系统提示词作为第一条 system 消息
      this.openaiMessages.push({ role: "system", content: this.systemPrompt });
    } else {
      // Anthropic 后端
      this.anthropicClient = new Anthropic({
        apiKey: options.apiKey,
        ...(options.anthropicBaseURL ? { baseURL: options.anthropicBaseURL } : {}),
        ...sdkRetries,
      });
      // Anthropic 格式：系统提示词在 API 调用时作为 system 参数传入，不放消息数组
    }
  }

  // ─── Prefix caching (Anthropic) ─────────────────────────────
  // 前缀缓存（Anthropic 专用）
  // Build the `system` field as an array of text blocks with a cache_control
  // breakpoint on the static core. Everything up to and including that block
  // (the tool schemas render before `system`, so they are covered too) is
  // cached server-side; the dynamic tail sits after the breakpoint. This is
  // Claude Code's scope-omitted path — the exact bytes it emits when global
  // cache scope is unavailable. See how-claude-code-works ch3.6.
  // 将 system 字段构建为文本块数组，在静态核心上设置 cache_control 断点。
  // 该断点之前的所有内容（工具 schema 在 system 之前渲染，因此也包含在内）在服务端缓存；
  // 动态尾部位于断点之后。这是 Claude Code 在全局缓存范围不可用时发射的确切字节。
  // 返回：Anthropic TextBlockParam 数组（含缓存控制断点）
  private buildAnthropicSystem(): Anthropic.TextBlockParam[] {
    // plan 模式时追加 plan 指令后缀到动态部分
    const planSuffix = this.permissionMode === "plan" ? this.buildPlanModePrompt() : "";
    const dynamicText = (this.dynamicSystemContext + planSuffix).trim();
    const blocks: Anthropic.TextBlockParam[] = [
      // 静态核心：带 ephemeral（临时）缓存断点 —— 这是服务端缓存的边界
      { type: "text", text: this.staticSystemPrompt, cache_control: { type: "ephemeral" } },
    ];
    // 动态尾部：放在断点之后，不缓存
    if (dynamicText) blocks.push({ type: "text", text: dynamicText });
    return blocks;
  }

  // Return a COPY of the message list with a cache_control breakpoint on the
  // last message's final content block, so every prior turn stays in the cached
  // prefix and only the newest messages are processed. Pure: the persistent
  // history is never mutated with this API metadata (Claude Code clones request
  // params at the render layer for the same reason, keeping session save /
  // compact / restore clean). Faithful to CC's assistantMessageToMessageParam,
  // we look only at the very LAST block and skip it when it is a thinking block
  // (unstable content → marking it would hurt cache hits). Only 1 message
  // breakpoint + 1 system breakpoint per request, well under the API cap of 4.
  // 返回消息列表的副本，在最后一条消息的最后一个内容块上设置 cache_control 断点，
  // 使之前的所有回合保持在缓存前缀中，只有最新消息需要重新处理。
  // 纯函数：持久化历史永远不会被这些 API 元数据修改（保持 session save/compact/restore 干净）。
  // 忠实于 CC 的 assistantMessageToMessageParam：只看最后一个块，跳过 thinking 块
  //（内容不稳定 → 标记它会损害缓存命中）。每请求 1 个消息断点 + 1 个系统断点，远低于 API 上限 4。
  // messages：原始消息列表
  // 返回：带缓存断点的消息列表副本
  private withCacheBreakpoints(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
    if (messages.length === 0) return messages;
    // 浅拷贝，不修改原始数组
    const out = messages.slice();
    const idx = out.length - 1;
    const last = out[idx];
    // 统一 content 为数组形式以便处理
    const content = typeof last.content === "string"
      ? [{ type: "text", text: last.content } as any]
      : (last.content as any[]).slice();
    const tail = content[content.length - 1] as any;
    // 只在非 thinking/redacted_thinking 块上设置断点（thinking 内容不稳定，标记会损害缓存命中）
    if (tail && tail.type !== "thinking" && tail.type !== "redacted_thinking") {
      content[content.length - 1] = { ...tail, cache_control: { type: "ephemeral" } };
      out[idx] = { ...last, content } as Anthropic.MessageParam;
    }
    return out;
  }

  // 解析实际的 thinking 模式：综合用户意图和模型能力
  // 返回："adaptive"（自适应）/ "enabled"（启用）/ "disabled"（禁用）
  private resolveThinkingMode(): "adaptive" | "enabled" | "disabled" {
    if (!this.thinking) return "disabled";                              // 用户未请求
    if (!modelSupportsThinking(this.model)) return "disabled";          // 模型不支持
    if (modelSupportsAdaptiveThinking(this.model)) return "adaptive";   // 支持自适应
    return "enabled";                                                    // 普通启用
  }

  /** Build a sideQuery function for memory recall and the Auto Mode classifier,
   *  works with both backends. temperature:0 for a deterministic decision — the
   *  same input should always yield the same verdict (Claude Code runs the
   *  classifier at temperature 0). */
  // 构建一个 sideQuery（旁路查询）函数，用于记忆召回和 Auto Mode 分类器。
  // 兼容两个后端。temperature:0 确保确定性决策 —— 相同输入应始终产生相同判定
  //（Claude Code 的分类器也以 temperature 0 运行）。
  // 返回：SideQueryFn 函数，或 null（无可用后端时）
  private buildSideQuery(): SideQueryFn | null {
    if (this.anthropicClient) {
      // Anthropic 后端的旁路查询实现
      const client = this.anthropicClient;
      const model = this.model;
      return async (system, userMessage, signal) => {
        const resp = await client.messages.create({
          model, max_tokens: 256, system, temperature: 0,
          messages: [{ role: "user", content: userMessage }],
        }, { signal });
        // 提取文本块并拼接返回
        return resp.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text).join("");
      };
    }
    if (this.openaiClient) {
      // OpenAI 兼容后端的旁路查询实现
      const client = this.openaiClient;
      const model = this.model;
      return async (system, userMessage, _signal) => {
        const resp = await client.chat.completions.create({
          model, max_tokens: 256, temperature: 0,
          messages: [
            { role: "system", content: system },
            { role: "user", content: userMessage },
          ],
        });
        return resp.choices?.[0]?.message?.content || "";
      };
    }
    return null;
  }

  // 中止当前进行中的请求（通过 AbortController）
  abort() {
    this.abortController?.abort();
  }

  // 获取当前是否有请求正在处理
  get isProcessing(): boolean {
    return this.abortController !== null;
  }

  // 设置外部确认回调函数（REPL 模式下复用已有 readline）
  setConfirmFn(fn: (message: string) => Promise<boolean>) {
    this.confirmFn = fn;
  }

  // 设置计划审批回调函数
  // fn：接收计划内容，返回审批选择和可选反馈
  setPlanApprovalFn(fn: (planContent: string) => Promise<{
    choice: "clear-and-execute" | "execute" | "manual-execute" | "keep-planning";
    feedback?: string;
  }>) {
    this.planApprovalFn = fn;
  }

  /** Toggle plan mode from the REPL. Returns the new mode description. */
  // 从 REPL 切换计划模式（plan mode）。返回新模式描述。
  togglePlanMode(): string {
    if (this.permissionMode === "plan") {
      // Exit plan mode
      // 退出计划模式：恢复之前的权限模式
      this.permissionMode = this.prePlanMode || "default";
      this.prePlanMode = null;
      this.planFilePath = null;
      this.systemPrompt = this.baseSystemPrompt;
      // OpenAI 后端需同步更新消息数组中的 system 消息
      if (this.useOpenAI && this.openaiMessages.length > 0) {
        (this.openaiMessages[0] as any).content = this.systemPrompt;
      }
      printInfo(`Exited plan mode → ${this.permissionMode} mode`);
      return this.permissionMode;
    } else {
      // Enter plan mode
      // 进入计划模式：保存当前模式，切换为 plan，生成计划文件路径
      this.prePlanMode = this.permissionMode;
      this.permissionMode = "plan";
      this.planFilePath = this.generatePlanFilePath();
      this.systemPrompt = this.baseSystemPrompt + this.buildPlanModePrompt();
      if (this.useOpenAI && this.openaiMessages.length > 0) {
        (this.openaiMessages[0] as any).content = this.systemPrompt;
      }
      printInfo(`Entered plan mode. Plan file: ${this.planFilePath}`);
      return "plan";
    }
  }

  // 获取当前权限模式名称
  getPermissionMode(): string {
    return this.permissionMode;
  }

  // 获取累计的 token 使用量（输入和输出）
  getTokenUsage() {
    return { input: this.totalInputTokens, output: this.totalOutputTokens };
  }

  // 处理一条用户消息：主入口方法
  // userMessage：用户输入的文本消息
  async chat(userMessage: string): Promise<void> {
    // Lazily connect to MCP servers on first chat (main agent only)
    // 首次对话时延迟连接 MCP 服务器（仅主代理）
    if (!this.mcpInitialized && !this.isSubAgent) {
      this.mcpInitialized = true;
      try {
        // 加载并连接所有配置的 MCP 服务器
        await this.mcpManager.loadAndConnect();
        // 获取 MCP 提供的工具定义，合并到本代理的工具列表
        const mcpDefs = this.mcpManager.getToolDefinitions();
        if (mcpDefs.length > 0) {
          this.tools = [...this.tools, ...mcpDefs as ToolDef[]];
        }
      } catch (err: any) {
        console.error(`[mcp] Init failed: ${err.message}`);
      }
    }
    // 创建本次请求的中断控制器
    this.abortController = new AbortController();
    try {
      // 根据后端类型分派到对应的对话方法
      if (this.useOpenAI) {
        await this.chatOpenAI(userMessage);
      } else {
        await this.chatAnthropic(userMessage);
      }
    } finally {
      // 无论成功失败都清除中断控制器
      this.abortController = null;
    }
    // 主代理（非子代理）在对话结束后打印分隔线并自动保存会话
    if (!this.isSubAgent) {
      printDivider();
      this.autoSave();
    }
  }

  // ─── Sub-agent entry point ────────────────────────────────
  // 子代理入口点：运行一次对话并捕获输出文本

  // 子代理单次执行入口（被 agent 工具和 skill fork 调用）
  // prompt：传给子代理的提示词
  // 返回：{ text（输出文本）, tokens（本次消耗的输入/输出 token 数） }
  async runOnce(prompt: string): Promise<{ text: string; tokens: { input: number; output: number } }> {
    // 开启输出缓冲，捕获子代理的所有文本输出
    this.outputBuffer = [];
    // 记录执行前的 token 计数，用于计算本次增量
    const prevInput = this.totalInputTokens;
    const prevOutput = this.totalOutputTokens;
    await this.chat(prompt);
    // 拼接所有捕获的文本
    const text = this.outputBuffer.join("");
    // 关闭输出缓冲
    this.outputBuffer = null;
    return {
      text,
      tokens: {
        // 增量 token = 当前总量 - 执行前总量
        input: this.totalInputTokens - prevInput,
        output: this.totalOutputTokens - prevOutput,
      },
    };
  }

  // ─── Output helper (captures if sub-agent) ────────────────
  // 输出辅助方法：子代理时捕获到缓冲区，否则直接打印到终端

  // 统一的文本输出方法
  // text：要输出的文本
  private emitText(text: string): void {
    if (this.outputBuffer) {
      // 子代理模式：捕获到缓冲区（不打印）
      this.outputBuffer.push(text);
    } else {
      // 主代理模式：直接打印到终端
      printAssistantText(text);
    }
  }

  // ─── REPL commands ──────────────────────────────────────────
  // REPL（交互式命令行）命令处理方法

  // 清除对话历史（/clear 命令）
  clearHistory() {
    this.anthropicMessages = [];
    this.openaiMessages = [];
    // OpenAI 后端需重新放入 system 消息
    if (this.useOpenAI) {
      this.openaiMessages.push({ role: "system", content: this.systemPrompt });
    }
    // 重置所有 token 计数器
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalCacheReadTokens = 0;
    this.totalCacheCreationTokens = 0;
    this.lastInputTokenCount = 0;
    printInfo("Conversation cleared.");
  }

  // 显示当前费用和 token 使用统计（/cost 命令）
  showCost() {
    const total = this.getCurrentCostUsd();
    // 预算信息（若设置了上限）
    const budgetInfo = this.maxCostUsd ? ` / $${this.maxCostUsd} budget` : "";
    // 回合信息（若设置了上限）
    const turnInfo = this.maxTurns ? ` | Turns: ${this.currentTurns}/${this.maxTurns}` : "";
    const cached = this.totalCacheReadTokens;
    // 计费输入 = 非缓存输入 + 缓存写入 + 缓存读取
    const billedInput = this.totalInputTokens + this.totalCacheCreationTokens + cached;
    // 缓存命中率
    const hitRate = billedInput > 0 ? Math.round((cached / billedInput) * 100) : 0;
    const cacheInfo = (cached || this.totalCacheCreationTokens)
      ? `\n  Cache: ${cached} read / ${this.totalCacheCreationTokens} write (${hitRate}% of input from cache)`
      : "";
    printInfo(
      `Tokens: ${this.totalInputTokens} in / ${this.totalOutputTokens} out${cacheInfo}\n  Estimated cost: $${total.toFixed(4)}${budgetInfo}${turnInfo}`
    );
  }

  // ─── Budget control ────────────────────────────────────────
  // 预算控制相关方法

  // 计算当前累计花费（美元）
  // 基于 Claude Code 各模型层级使用的固定计费倍数
  private getCurrentCostUsd(): number {
    const M = 1_000_000; // 百万 token
    // Base input $3/Mtok. Cache read is 0.1x, cache write is 1.25x — the fixed
    // multipliers Claude Code uses across every model tier (utils/modelCost.ts).
    // 基础输入 $3/百万token。缓存读取 0.1x（$0.3），缓存写入 1.25x（$3.75）——
    // Claude Code 在所有模型层级使用的固定倍数。
    const costIn = (this.totalInputTokens / M) * 3;           // 非缓存输入：$3/M
    const costCacheRead = (this.totalCacheReadTokens / M) * 0.3; // 缓存读取：$0.3/M
    const costCacheWrite = (this.totalCacheCreationTokens / M) * 3.75; // 缓存写入：$3.75/M
    const costOut = (this.totalOutputTokens / M) * 15;        // 输出：$15/M
    return costIn + costCacheRead + costCacheWrite + costOut;
  }

  // 检查预算是否超限（费用上限或回合数上限）
  // 返回：{ exceeded（是否超限）, reason?（超限原因） }
  private checkBudget(): { exceeded: boolean; reason?: string } {
    // 检查费用上限
    if (this.maxCostUsd !== undefined && this.getCurrentCostUsd() >= this.maxCostUsd) {
      return { exceeded: true, reason: `Cost limit reached ($${this.getCurrentCostUsd().toFixed(4)} >= $${this.maxCostUsd})` };
    }
    // 检查回合数上限
    if (this.maxTurns !== undefined && this.currentTurns >= this.maxTurns) {
      return { exceeded: true, reason: `Turn limit reached (${this.currentTurns} >= ${this.maxTurns})` };
    }
    return { exceeded: false };
  }

  // 手动触发对话压缩（/compact 命令）
  async compact() {
    await this.compactConversation();
  }

  // ─── /goal pursuit ──────────────────────────────────────────
  // /goal（目标追求）实现
  // A prompt-based Stop hook: after each turn a separate evaluator model judges
  // the condition; not-met feeds its reason into the next turn, met/impossible
  // stop. See autonomy.ts for the (verbatim) evaluator prompt.
  // 基于提示词的 Stop hook：每个回合后，独立的评估模型判断条件是否达成；
  // 未达成则将其理由喂入下一回合，达成/不可能则停止。评估器提示词见 autonomy.ts。

  /** Set the active goal and return the first-turn directive to run. */
  // 设置活动目标，返回第一回合要执行的指令
  // condition：目标条件描述
  // 返回：第一回合指令文本
  setGoal(condition: string): string {
    // 初始化目标状态
    this.activeGoal = { condition, iterations: 0, startedAt: Date.now() };
    printInfo(`◎ /goal active — Stop hook condition: "${condition}"`);
    // 返回目标指令（告诉模型要达成什么）
    return goalDirective(condition);
  }

  /** `/goal` with no argument prints the current goal's status. */
  // `/goal`（无参数）打印当前目标的状态
  showGoal(): void {
    if (!this.activeGoal) {
      printInfo("No active goal. Set one with /goal <condition>.");
      return;
    }
    // 计算已耗时秒数
    const secs = ((Date.now() - this.activeGoal.startedAt) / 1000).toFixed(1);
    const last = this.activeGoal.lastReason ? `\n  last reason: ${this.activeGoal.lastReason}` : "";
    printInfo(
      `◎ /goal active\n  condition: ${this.activeGoal.condition}\n  iterations: ${this.activeGoal.iterations}\n  elapsed: ${secs}s${last}`
    );
  }

  /** Pursue the active goal: run the directive turn, then loop
   *  evaluate → (not met) feed reason back → next turn, until met, impossible,
   *  budget/iteration cap, or interrupt. */
  // 追求活动目标：执行指令回合，然后循环 评估 →（未达成）反馈理由 → 下一回合，
  // 直到达成、判定不可能、预算/迭代上限、或中断。
  // directive：第一回合指令
  async pursueGoal(directive: string): Promise<void> {
    if (!this.activeGoal) return;
    this.goalStop = false;
    try {
      // 先执行第一回合（指令回合）
      await this.chat(directive);
      // Evaluate the turn that just finished *before* any cap or next-turn
      // decision, so the final turn's output is never left unjudged.
      // 在任何上限检查或下一回合决策之前，评估刚结束的回合，
      // 确保最后一个回合的输出不会未被评判。
      while (this.activeGoal && !this.goalStop) {
        const verdict = await this.evaluateGoal(this.activeGoal.condition);
        if (verdict.ok) {
          // 目标已达成
          const turns = this.activeGoal.iterations + 1;
          const secs = ((Date.now() - this.activeGoal.startedAt) / 1000).toFixed(1);
          printInfo(`✓ Goal achieved (${turns} turn${turns === 1 ? "" : "s"}, ${secs}s): ${verdict.reason}`);
          break;
        }
        if (verdict.impossible) {
          // 目标被判定为不可能达成
          printInfo(`Hooks: Prompt hook condition judged impossible: ${verdict.reason}`);
          break;
        }

        // Not met: record and decide whether another turn is allowed.
        // 未达成：记录并决定是否允许下一回合
        this.activeGoal.iterations++;
        this.activeGoal.lastReason = verdict.reason;
        printInfo(`Hooks: Prompt hook condition was not met: ${verdict.reason}`);

        // 检查预算是否超限
        const budget = this.checkBudget();
        if (budget.exceeded) { printInfo(`Goal stopped: ${budget.reason}`); break; }
        // Hard ceiling regardless of --max-turns: --max-turns only counts
        // tool-executing turns (checkBudget), so a no-tool goal loop needs an
        // unconditional backstop of its own.
        // 无条件硬上限（不受 --max-turns 影响）：--max-turns 只计算工具执行回合，
        // 所以无工具的目标循环需要自己的无条件兜底。
        if (this.activeGoal.iterations >= GOAL_MAX_ITERATIONS) {
          printInfo(`Goal stopped: reached ${GOAL_MAX_ITERATIONS} iterations without meeting the condition.`);
          break;
        }
        if (this.goalStop) break;

        // 未达成但允许继续：将未达成理由反馈给下一回合
        await this.chat(
          `Hooks: Prompt hook condition was not met: ${verdict.reason}\n\nKeep working toward the goal.`
        );
      }
      if (this.goalStop) printInfo("Goal pursuit interrupted.");
    } catch (e: any) {
      // 非 abort 错误重新抛出
      if (e?.name !== "AbortError" && !e?.message?.includes("aborted")) throw e;
      // Interrupted (Ctrl+C) mid-turn: stop pursuing the goal.
      // 回合中途被中断（Ctrl+C）：停止追求目标。
      printInfo("Goal pursuit interrupted.");
    } finally {
      // Clear on any exit (met / impossible / capped / interrupted) so a stale
      // goal never lingers. Real Claude Code keeps it session-scoped and
      // resumable; we don't implement resume.
      // 任何退出情况（达成/不可能/超限/中断）都清除目标，避免残留过期目标。
      // 真正的 Claude Code 保持会话级可恢复；本教学版不实现恢复。
      this.activeGoal = null;
    }
  }

  /** One evaluator pass over the just-finished turn's transcript. The transcript
   *  is sent as its own assistant message (framed by a preceding user message
   *  as data-to-judge), so a crafted turn can't smuggle fake user/judge text
   *  into the evaluator's context — real Claude Code likewise sends the turn as
   *  a separate transcript message, not inlined into the judge prompt. */
  // 对刚结束回合的转录进行一次评估器判定。
  // 转录作为独立的 assistant 消息发送（前面有 user 消息作为待评判数据框定），
  // 这样精心构造的回合无法将伪造的 user/judge 文本走私进评估器上下文。
  // 真正的 Claude Code 也同样将回合作为独立转录消息发送，而非内联到 judge 提示词中。
  // condition：目标条件
  // 返回：GoalVerdict 判定结果（ok=达成 / impossible=不可能 / reason=理由）
  private async evaluateGoal(condition: string): Promise<GoalVerdict> {
    // 提取最近一次 assistant 回合的文本作为待评判转录
    const transcript = this.extractLastAssistantText();
    // 构建 3 条消息：框定指令 + 待评判转录 + 判定问题
    const messages = [
      { role: "user" as const, content: GOAL_TRANSCRIPT_FRAMING },         // 告诉模型这是待评判的数据
      { role: "assistant" as const, content: transcript || "(no assistant output)" }, // 转录
      { role: "user" as const, content: goalJudgeUserMessage(condition) }, // 判定问题
    ];
    try {
      const raw = await this.runEvaluatorQuery(GOAL_EVALUATOR_SYSTEM, messages);
      return parseGoalVerdict(raw);
    } catch (e: any) {
      // Evaluator error → treat as not-met (never accidentally clears the goal).
      // 评估器出错 → 视为未达成（绝不意外清除目标）。
      return { ok: false, reason: `evaluator error: ${e?.message ?? e}` };
    }
  }

  /** Send a role-separated evaluator query on whichever backend is configured
   *  and return the model's text. Like buildSideQuery but takes a full messages
   *  array (buildSideQuery is single-user-message, for memory recall). */
  // 在已配置的后端上发送角色分离的评估器查询，返回模型文本。
  // 类似 buildSideQuery，但接收完整的 messages 数组
  //（buildSideQuery 只接收单条 user 消息，用于记忆召回）。
  // system：系统提示词
  // messages：完整消息数组（含 user/assistant 角色）
  // 返回：模型文本输出
  private async runEvaluatorQuery(
    system: string,
    messages: { role: "user" | "assistant"; content: string }[],
  ): Promise<string> {
    if (this.anthropicClient) {
      // Anthropic 后端
      const resp = await this.anthropicClient.messages.create({
        model: this.model, max_tokens: 512, system, temperature: 0, messages,
      });
      return resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text).join("");
    }
    if (this.openaiClient) {
      // OpenAI 兼容后端：system 作为消息数组的首条
      const resp = await this.openaiClient.chat.completions.create({
        model: this.model, max_tokens: 512, temperature: 0,
        messages: [{ role: "system", content: system }, ...messages],
      });
      return resp.choices?.[0]?.message?.content || "";
    }
    throw new Error("no evaluator model available");
  }

  /** Single-message classifier query with a caller-chosen max_tokens, so the
   *  two Auto Mode stages can size their budgets differently (stage 1 is a tiny
   *  gate, stage 2 has room to think). temperature:0 for a deterministic
   *  verdict, matching Claude Code's classifier. */
  // 单消息分类器查询，调用方可指定 max_tokens，使 Auto Mode 两个阶段可设置不同预算
  //（阶段 1 是小型门控，阶段 2 有思考空间）。temperature:0 确保确定性判定，与 Claude Code 分类器一致。
  // system：系统提示词
  // user：用户消息
  // maxTokens：最大输出 token 数
  // 返回：模型文本输出
  private async runClassifierQuery(system: string, user: string, maxTokens: number): Promise<string> {
    if (this.anthropicClient) {
      // Anthropic 后端：支持 abort 信号
      const resp = await this.anthropicClient.messages.create({
        model: this.model, max_tokens: maxTokens, system, temperature: 0,
        messages: [{ role: "user", content: user }],
      }, { signal: this.abortController?.signal });
      return resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text).join("");
    }
    if (this.openaiClient) {
      // OpenAI 兼容后端
      const resp = await this.openaiClient.chat.completions.create({
        model: this.model, max_tokens: maxTokens, temperature: 0,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      });
      return resp.choices?.[0]?.message?.content || "";
    }
    throw new Error("no classifier model available");
  }

  /** The text of the most recent assistant turn, for the evaluator to judge.
   *  Transcript-only: real Claude Code feeds the whole transcript but the
   *  action under judgement is the latest turn. */
  // 提取最近一次 assistant 回合的文本，供评估器评判。
  // 仅取转录文本：真正的 Claude Code 喂入完整转录，但被评判的动作是最新回合。
  // 返回：最近 assistant 回合的文本内容
  private extractLastAssistantText(): string {
    if (this.useOpenAI) {
      // OpenAI 后端：从后往前找最近的 assistant 消息
      for (let i = this.openaiMessages.length - 1; i >= 0; i--) {
        const m: any = this.openaiMessages[i];
        if (m.role === "assistant" && typeof m.content === "string") return m.content;
      }
      return "";
    }
    // Anthropic 后端：从后往前找最近的 assistant 消息
    for (let i = this.anthropicMessages.length - 1; i >= 0; i--) {
      const m: any = this.anthropicMessages[i];
      if (m.role !== "assistant") continue;
      // 字符串形式直接返回
      if (typeof m.content === "string") return m.content;
      // 数组形式：提取所有文本块拼接
      if (Array.isArray(m.content)) {
        return m.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
      }
    }
    return "";
  }

  // ─── /loop — recurring or self-paced prompt ─────────────────
  // /loop（循环执行）—— 重复或自定步调的提示词执行
  // Unlike /goal (a stop-hook gate), /loop actively reschedules itself: a fixed
  // interval, or — with no interval — a pace the main model picks via the
  // schedule_wakeup tool. See autonomy.ts for the parser and tool schema.
  // 与 /goal（stop-hook 门控）不同，/loop 主动重新调度自身：固定间隔，
  // 或——无间隔时——由主模型通过 schedule_wakeup 工具自选步调。解析器和工具 schema 见 autonomy.ts。

  /** Entry point for the /loop command. Parses the input, then drives the
   *  matching mode. Returns without looping if the input is malformed. */
  // /loop 命令的入口点。解析输入，然后驱动匹配的模式。输入格式错误时直接返回不循环。
  // rawInput：用户输入的原始字符串
  async runLoop(rawInput: string): Promise<void> {
    // 解析输入为循环规格
    const spec = parseLoopInput(rawInput);
    if ("error" in spec) {
      // 格式错误，打印错误并返回
      printInfo(spec.error);
      return;
    }
    // Offer-cloud decision point (interval ≥60min or daily wording). Real Claude
    // Code asks whether to convert to a persistent cloud schedule that survives
    // the session; this teaching CLI has no cloud, so we only surface it.
    // 云调度提示决策点（间隔≥60分钟或含日常用语）。真正的 Claude Code 会询问是否转为
    // 持久化云调度（会话结束后仍运行）；本教学 CLI 无云端后端，仅提示。
    const wantsCloud =
      (spec.mode === "interval" && spec.intervalSeconds! >= OFFER_CLOUD_THRESHOLD_SECONDS) ||
      isDailyWording(rawInput);
    if (wantsCloud) {
      printInfo("(Real Claude Code would offer to convert this to a persistent cloud schedule that keeps running after the session ends. This teaching build has no cloud backend — continuing in-session.)");
    }

    this.loopStop = false;
    try {
      // 根据模式分派
      if (spec.mode === "interval") {
        await this.runLoopInterval(spec);
      } else {
        await this.runLoopDynamic(spec);
      }
    } catch (e: any) {
      // 非 abort 错误重新抛出
      if (e?.name !== "AbortError" && !e?.message?.includes("aborted")) throw e;
      printInfo("Loop interrupted.");
    }
  }

  /** Interval mode: re-run the prompt every N seconds until interrupted or the
   *  iteration cap. Corresponds to Claude Code's in-session CronCreate path
   *  (session-only, not persisted). We use a plain timer in place of the cron
   *  engine + KAIROS daemon. */
  // 间隔模式：每 N 秒重新执行提示词，直到中断或达到迭代上限。
  // 对应 Claude Code 的会话内 CronCreate 路径（仅会话内，不持久化）。
  // 我们用普通定时器替代 cron 引擎 + KAIROS 守护进程。
  // spec：循环规格（含间隔秒数和提示词）
  private async runLoopInterval(spec: LoopSpec): Promise<void> {
    printInfo(`⟳ /loop scheduled every ${spec.intervalLabel} (session-only, not persisted — dies when this process exits). Ctrl+C to stop.`);
    let iterations = 0;
    while (!this.loopStop && !this.abortController?.signal.aborted) {
      iterations++;
      printInfo(`⟳ loop tick ${iterations}`);
      // 执行一次提示词
      await this.chat(spec.prompt);

      // 检查预算
      const budget = this.checkBudget();
      if (budget.exceeded) { printInfo(`Loop stopped: ${budget.reason}`); break; }
      // --max-turns also bounds loop ticks: checkBudget's turn counter only
      // increments on tool-executing turns, so a plain-text loop would never
      // hit it — treat --max-turns as a tick limit here too.
      // --max-turns 也限制循环 tick：checkBudget 的回合计数器只在工具执行回合递增，
      // 所以纯文本循环永远不会触发它 —— 在这里也把 --max-turns 当作 tick 限制。
      if (this.maxTurns !== undefined && iterations >= this.maxTurns) {
        printInfo(`Loop stopped: tick limit reached (${iterations} >= ${this.maxTurns}).`);
        break;
      }
      // 硬性迭代上限
      if (iterations >= LOOP_MAX_ITERATIONS) {
        printInfo(`Loop stopped: reached ${LOOP_MAX_ITERATIONS} ticks.`);
        break;
      }
      // 等待间隔（可中断的睡眠）
      const interrupted = await this.interruptibleSleep(spec.intervalSeconds! * 1000);
      if (interrupted) { printInfo("Loop stopped."); break; }
    }
  }

  /** Dynamic mode: run the tick, then let the main model self-pace via
   *  schedule_wakeup. If it scheduled a wakeup, wait the (clamped) delay and run
   *  again with the prompt it passed back; if it didn't, the loop has converged.
   *  Faithful to "dynamic pacing is decided by the main model, no separate
   *  evaluator." schedule_wakeup is exposed only for the duration of the loop. */
  // 动态模式：执行 tick，然后让主模型通过 schedule_wakeup 自定步调。
  // 如果模型调度了唤醒，等待（钳制后的）延迟后用模型传回的提示词再次运行；
  // 如果没有调度，循环已收敛。忠实于"动态步调由主模型决定，无独立评估器"。
  // schedule_wakeup 仅在循环期间暴露。
  // spec：循环规格（含初始提示词）
  private async runLoopDynamic(spec: LoopSpec): Promise<void> {
    printInfo("⟳ /loop dynamic (self-paced) — the model schedules its own next run, or ends the loop. Ctrl+C to stop.");
    // 检查是否已有 schedule_wakeup 工具（避免重复添加）
    const hadTool = this.tools.some(t => t.name === "schedule_wakeup");
    if (!hadTool) this.tools = [...this.tools, SCHEDULE_WAKEUP_TOOL as ToolDef];
    this.scheduleWakeupEnabled = true;
    let prompt = spec.prompt;
    let iterations = 0;
    try {
      while (!this.loopStop && !this.abortController?.signal.aborted) {
        iterations++;
        // 清除上一轮的唤醒请求
        this.pendingWakeup = null;
        // 用动态循环指令执行一次（指令包含提示词）
        await this.chat(dynamicLoopDirective(prompt));

        // 模型未调度唤醒 → 循环已收敛
        if (!this.pendingWakeup) {
          printInfo(`⟳ Loop converged after ${iterations} tick${iterations === 1 ? "" : "s"} (model scheduled no wakeup).`);
          break;
        }
        // 预算检查
        const budget = this.checkBudget();
        if (budget.exceeded) { printInfo(`Loop stopped: ${budget.reason}`); break; }
        // tick 限制检查
        if (this.maxTurns !== undefined && iterations >= this.maxTurns) {
          printInfo(`Loop stopped: tick limit reached (${iterations} >= ${this.maxTurns}).`);
          break;
        }
        // 硬性迭代上限
        if (iterations >= LOOP_MAX_ITERATIONS) {
          printInfo(`Loop stopped: reached ${LOOP_MAX_ITERATIONS} ticks.`);
          break;
        }
        // 读取模型调度的唤醒请求
        const { delaySeconds, reason, prompt: nextPrompt } = this.pendingWakeup;
        printInfo(`⟳ next run in ${delaySeconds}s — ${reason}`);
        // 使用模型传回的提示词（或回退到原提示词）
        prompt = nextPrompt || prompt;
        // 等待延迟
        const interrupted = await this.interruptibleSleep(delaySeconds * 1000);
        if (interrupted) { printInfo("Loop stopped."); break; }
      }
    } finally {
      // Remove schedule_wakeup so it isn't exposed outside the dynamic loop.
      // 移除 schedule_wakeup，使其在动态循环之外不可用。
      if (!hadTool) this.tools = this.tools.filter(t => t.name !== "schedule_wakeup");
      this.scheduleWakeupEnabled = false;
      this.pendingWakeup = null;
    }
  }

  /** schedule_wakeup executor: record the requested wakeup for the loop driver.
   *  Delay is clamped to [60, 3600]; the driver reads pendingWakeup after the
   *  turn converges. */
  // schedule_wakeup 执行器：记录请求的唤醒供循环驱动器使用。
  // 延迟被钳制到 [60, 3600] 秒；驱动器在回合收敛后读取 pendingWakeup。
  // input：包含 delaySeconds、reason、prompt 的输入
  // 返回：确认消息
  private executeScheduleWakeup(input: Record<string, any>): string {
    // 钳制延迟到合理范围
    const delaySeconds = clampWakeupDelay(Number(input.delaySeconds));
    const reason = typeof input.reason === "string" ? input.reason : "";
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    // 记录唤醒请求
    this.pendingWakeup = { delaySeconds, reason, prompt };
    return `Wakeup scheduled in ${delaySeconds}s. The loop will resume then; end your turn now.`;
  }

  /** Sleep that resolves early (returning true) if the loop is stopped or the
   *  turn is aborted. Avoids blocking on a long interval past a Ctrl+C. */
  // 可中断的睡眠：如果循环被停止或回合被中断则提前返回（返回 true）。
  // 避免在 Ctrl+C 后仍阻塞在长间隔上。
  // ms：要睡眠的毫秒数
  // 返回：true=被中断，false=正常完成
  private interruptibleSleep(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const start = Date.now();
      // 每 200ms（或 ms，取较小值）检查一次是否被中断
      const tick = () => {
        if (this.loopStop || this.abortController?.signal.aborted) return resolve(true);
        if (Date.now() - start >= ms) return resolve(false);
        setTimeout(tick, Math.min(200, ms));
      };
      tick();
    });
  }

  /** Stop a running /loop (called from the REPL's interrupt handler). */
  // 停止运行中的 /loop（由 REPL 的中断处理器调用）。
  stopLoop(): void {
    this.loopStop = true;
  }

  /** Stop a running /goal pursuit (called from the REPL's interrupt handler).
   *  Takes effect at the next turn boundary — an in-flight turn is aborted
   *  separately via abort(). */
  // 停止运行中的 /goal 追求（由 REPL 的中断处理器调用）。
  // 在下一回合边界生效 —— 进行中的回合通过 abort() 单独中止。
  stopGoal(): void {
    this.goalStop = true;
  }

  // ─── Auto Mode — transcript-classifier permission gate ──────
  // Auto Mode（自动模式）—— 转录分类器权限门控
  // In `auto` mode the classifier replaces the human confirm prompt: deny rules
  // still hard-block, read-only tools fast-path through, everything else is
  // judged by an LLM reading a reasoning-blind transcript projection.
  // 在 `auto` 模式下，分类器替代人工确认提示：拒绝规则仍硬性阻断，
  // 只读工具快速通过，其余由读取推理盲转录投影的 LLM 判定。

  /** Decide a tool call in Auto Mode. Returns allow/deny like checkPermission,
   *  or "confirm" to hand back to a human once the denial limits trip.
   *
   *  Two-stage, mirroring Claude Code's `both` mode: stage 1 is an aggressive
   *  cheap gate (no user intent, no ALLOW exceptions — block if any rule *could*
   *  apply); if stage 1 allows, we're done in one call. If stage 1 blocks, stage
   *  2 does the careful adjudication that DOES weigh user intent and can clear
   *  the block. Stage 2's verdict is final. */
  // 在 Auto Mode 中判定一个工具调用。返回 allow/deny（如 checkPermission），
  // 或 "confirm"（拒绝次数达限后交还人工）。
  // 两阶段机制，仿照 Claude Code 的 `both` 模式：
  // 阶段 1 是激进廉价门控（不考虑用户意图，无 ALLOW 例外 —— 只要有规则*可能*适用就阻断）；
  // 如果阶段 1 放行，一次调用即可完成。如果阶段 1 阻断，
  // 阶段 2 做仔细裁定（确实权衡用户意图，可以清除阻断）。阶段 2 的判定是最终判定。
  // toolName：工具名称
  // input：工具输入
  // 返回：{ action: "allow"/"deny"/"confirm", message? }
  private async classifyToolCall(
    toolName: string,
    input: Record<string, any>,
  ): Promise<{ action: "allow" | "deny" | "confirm"; message?: string }> {
    // Hard floor first: deny rules bind even here.
    // 首先检查硬底线：拒绝规则在这里同样生效。
    const base = checkPermission(toolName, input, "default", this.planFilePath || undefined);
    if (base.action === "deny") return base;
    // Fast-path: read-only / side-effect-free tools skip the classifier.
    // 快速路径：只读/无副作用工具跳过分类器。
    if (AUTO_MODE_FAST_PATH_TOOLS.has(toolName)) return { action: "allow" };

    if (!this.anthropicClient && !this.openaiClient) {
      // No evaluator available → fail closed. Defer to a human if one is present
      // (interactive), else deny outright (headless: Claude Code aborts here).
      // 无可用评估器 → 安全失败。有交互人工则交还，否则直接拒绝（无头模式：Claude Code 在此中止）。
      return this.autoFallback(`${toolName} (auto-mode classifier unavailable)`);
    }
    let verdict: { block: boolean; reason: string };
    try {
      // 加载 Auto Mode 规则
      const rules = loadAutoModeRules();
      // 获取消息历史用于构建转录
      const history = this.useOpenAI ? this.openaiMessages : this.anthropicMessages;
      // 构建推理盲转录投影（移除推理过程，仅保留工具调用和结果）
      const transcript = buildClassifierTranscript(history as any, { toolName, input });
      // 构建分类器系统提示词
      const system = buildClassifierSystem(rules);
      // CLAUDE.md rides in the user message, not the system prompt — it is
      // untrusted repo content.
      // CLAUDE.md 放在用户消息中，而非系统提示词 —— 它是不可信的仓库内容。
      const claudeMd = loadClaudeMd();
      // Stage 1 — aggressive cheap gate (small token budget: just <block>…).
      // 阶段 1 —— 激进廉价门控（小 token 预算：只需输出 <block>…）。
      const s1raw = await this.runClassifierQuery(system, classifierUserMessage(rules, transcript, rules.suffix_stage1, claudeMd), 256);
      const s1 = parseBlockVerdict(s1raw);
      if (!s1.block) {
        verdict = s1;                 // stage 1 cleared it → allow (one call)
        // 阶段 1 放行 → 允许（一次调用完成）
      } else {
        // Stage 2 — careful adjudication (weighs user intent, can clear). More
        // tokens: stage 2 may emit a <thinking> block before its verdict.
        // 阶段 2 —— 仔细裁定（权衡用户意图，可清除阻断）。更多 token：
        // 阶段 2 可能在判定前输出 <thinking> 块。
        const s2raw = await this.runClassifierQuery(system, classifierUserMessage(rules, transcript, rules.suffix_stage2, claudeMd), 1024);
        verdict = parseBlockVerdict(s2raw);
      }
    } catch (e: any) {
      // Any setup or classifier error → fail closed (block), matching Claude
      // Code's iron gate. Wrapping the asset load here too keeps a missing/bad
      // rules file from crashing the turn and orphaning the tool_use.
      // 任何设置或分类器错误 → 安全失败（阻断），与 Claude Code 的铁门一致。
      // 在此包裹资源加载也防止缺失/损坏的规则文件导致回合崩溃和 tool_use 孤立。
      verdict = { block: true, reason: `classifier error: ${e?.message ?? e}` };
    }

    if (!verdict.block) {
      // 判定放行：重置连续拒绝计数
      this.autoConsecutiveDenials = 0;
      return { action: "allow" };
    }

    // 判定阻断：递增拒绝计数
    this.autoConsecutiveDenials++;
    this.autoTotalDenials++;
    if (
      this.autoConsecutiveDenials >= DENIAL_LIMITS.maxConsecutive ||
      this.autoTotalDenials >= DENIAL_LIMITS.maxTotal
    ) {
      // Too many denials — the classifier may be stuck. Hand back to a human if
      // interactive; deny in headless (Claude Code aborts the agent here).
      // 拒绝过多 —— 分类器可能卡住了。交互模式交还人工；无头模式拒绝（Claude Code 在此中止代理）。
      printInfo(`Auto Mode: denial limit reached — handing back to manual confirmation.`);
      return this.autoFallback(`[Auto Mode blocked] ${verdict.reason}`);
    }
    return { action: "deny", message: `[Auto Mode] ${verdict.reason}` };
  }

  /** Auto Mode fail-safe: defer to a human confirm if one is available, else
   *  deny (headless). Never returns "allow" — the point is to not run an
   *  unjudged action. Auto confirms carry a per-tool digest, not a bare reason,
   *  so a single approval doesn't whitelist a whole class of later actions. */
  // Auto Mode 安全兜底：有交互人工则交还确认，否则拒绝（无头模式）。
  // 永不返回 "allow" —— 目的是不执行未判定的动作。
  // Auto 确认携带每工具摘要而非裸理由，所以单次批准不会白名单整个后续同类动作。
  // message：确认/拒绝消息
  // 返回：{ action: "deny"/"confirm", message }
  private autoFallback(message: string): { action: "deny" | "confirm"; message: string } {
    if (this.confirmFn) return { action: "confirm", message };
    return { action: "deny", message: `${message} (headless — denied)` };
  }

  /** Permission mode a spawned sub-agent inherits. plan and auto must carry
   *  through — a sub-agent otherwise runs bypassPermissions, so in Auto Mode the
   *  main model could launder a blocked action through `agent(prompt="git push
   *  origin main")` and have the sub-agent run it unclassified. Claude Code puts
   *  every sub-agent tool call through canUseTool individually. */
  // 子代理继承的权限模式。plan 和 auto 必须传递 ——
  // 子代理否则以 bypassPermissions 运行，所以在 Auto Mode 下主模型可通过
  // `agent(prompt="git push origin main")` 洗白被阻断的动作让子代理未分类执行。
  // Claude Code 将每个子代理工具调用单独通过 canUseTool 检查。
  // 返回：子代理应使用的权限模式
  private childPermissionMode(): PermissionMode {
    if (this.permissionMode === "plan") return "plan";     // plan 模式传递
    if (this.permissionMode === "auto") return "auto";     // auto 模式传递
    return "bypassPermissions";                              // 其他模式：子代理跳过权限
  }

  // ─── Session restore ───────────────────────────────────────
  // 会话恢复相关方法

  // 从保存的数据恢复会话历史
  // data：包含消息历史的数据对象
  restoreSession(data: { anthropicMessages?: any[]; openaiMessages?: any[] }) {
    if (data.anthropicMessages) this.anthropicMessages = data.anthropicMessages;
    if (data.openaiMessages) this.openaiMessages = data.openaiMessages;
    printInfo(`Session restored (${this.getMessageCount()} messages).`);
  }

  // 获取当前消息历史中的消息数量（根据后端选择对应数组）
  private getMessageCount(): number {
    return this.useOpenAI ? this.openaiMessages.length : this.anthropicMessages.length;
  }

  // 自动保存当前会话到磁盘（每个对话回合后调用）
  private autoSave() {
    try {
      saveSession(this.sessionId, {
        metadata: {
          id: this.sessionId,
          model: this.model,
          cwd: process.cwd(),
          startTime: this.sessionStartTime,
          messageCount: this.getMessageCount(),
        },
        // 只保存当前使用的后端的消息历史
        anthropicMessages: this.useOpenAI ? undefined : this.anthropicMessages,
        openaiMessages: this.useOpenAI ? this.openaiMessages : undefined,
      });
    } catch {} // 静默失败：保存失败不应中断对话
  }

  // ─── Autocompact ───────────────────────────────────────────
  // 自动压缩（Autocompact）：上下文窗口快满时自动用 LLM 总结对话

  // 检查并在需要时触发自动压缩（利用率超过 85% 时触发）
  private async checkAndCompact(): Promise<void> {
    if (this.lastInputTokenCount > this.effectiveWindow * 0.85) {
      printInfo("Context window filling up, compacting conversation...");
      await this.compactConversation();
    }
  }

  // 压缩对话（根据后端分派）—— 第 4 层压缩：调用 LLM 总结
  private async compactConversation(): Promise<void> {
    if (this.useOpenAI) {
      await this.compactOpenAI();
    } else {
      await this.compactAnthropic();
    }
    printInfo("Conversation compacted.");
  }

  // Anthropic 后端的对话压缩：用 LLM 总结历史并替换消息数组
  private async compactAnthropic(): Promise<void> {
    // Invariant: caller must ensure the last message is a plain user-text
    // message (not a tool_result). We slice it off below; if it were a
    // tool_result, the preceding assistant's tool_use would be orphaned and
    // the API would reject the summarize call.
    // 不变式：调用方必须确保最后一条消息是纯文本用户消息（非 tool_result）。
    // 我们在下方切掉它；如果是 tool_result，前面 assistant 的 tool_use 会变成孤立，
    // API 会拒绝总结调用。
    if (this.anthropicMessages.length < 4) return;
    // 暂存最后一条用户消息（总结后保留）
    const lastUserMsg = this.anthropicMessages[this.anthropicMessages.length - 1];
    const summaryReq: Anthropic.MessageParam[] = [
      {
        role: "user",
        content:
          "Summarize the conversation so far in a concise paragraph, preserving key decisions, file paths, and context needed to continue the work.",
      },
    ];
    // 用历史（除最后一条）+ 总结请求调用 LLM
    const summaryResp = await this.anthropicClient!.messages.create({
      model: this.model,
      max_tokens: 2048,
      system: "You are a conversation summarizer. Be concise but preserve important details.",
      messages: [
        ...this.anthropicMessages.slice(0, -1),
        ...summaryReq,
      ],
    });
    const summaryText =
      summaryResp.content[0]?.type === "text"
        ? summaryResp.content[0].text
        : "No summary available.";
    // 用总结替换整个消息历史
    this.anthropicMessages = [
      { role: "user", content: `[Previous conversation summary]\n${summaryText}` },
      { role: "assistant", content: "Understood. I have the context from our previous conversation. How can I continue helping?" },
    ];
    // 如果最后一条是用户消息，追加回去（保留当前问题）
    if (lastUserMsg.role === "user") this.anthropicMessages.push(lastUserMsg);
    this.lastInputTokenCount = 0; // 重置 token 计数
  }

  // OpenAI 后端的对话压缩：逻辑同 compactAnthropic
  private async compactOpenAI(): Promise<void> {
    // Invariant: caller must ensure the last message is a plain user-text
    // message (not a `tool` role result). Same reasoning as compactAnthropic
    // — slicing off a tool result would orphan the preceding assistant's
    // tool_calls.
    // 不变式：调用方必须确保最后一条消息是纯文本用户消息（非 tool 角色结果）。
    // 理由同 compactAnthropic —— 切掉 tool 结果会使前面 assistant 的 tool_calls 孤立。
    if (this.openaiMessages.length < 5) return;
    // 保留 system 消息（索引 0）
    const systemMsg = this.openaiMessages[0];
    const lastUserMsg = this.openaiMessages[this.openaiMessages.length - 1];
    const summaryResp = await this.openaiClient!.chat.completions.create({
      model: this.model,
      max_tokens: 2048,
      messages: [
        { role: "system", content: "You are a conversation summarizer. Be concise but preserve important details." },
        ...this.openaiMessages.slice(1, -1), // 除 system 和最后一条
        { role: "user", content: "Summarize the conversation so far in a concise paragraph, preserving key decisions, file paths, and context needed to continue the work." },
      ],
    });
    const summaryText = summaryResp.choices[0]?.message?.content || "No summary available.";
    // 用 system + 总结替换历史
    this.openaiMessages = [
      systemMsg,
      { role: "user", content: `[Previous conversation summary]\n${summaryText}` },
      { role: "assistant", content: "Understood. I have the context from our previous conversation. How can I continue helping?" },
    ];
    // 追加最后一条用户消息
    if ((lastUserMsg as any).role === "user") this.openaiMessages.push(lastUserMsg);
    this.lastInputTokenCount = 0;
  }

  // ─── Multi-tier compression pipeline ──────────────────────
  // 多层级压缩流水线（第 1-3 层，零 API 成本）
  // 4-layer compression inspired by Claude Code's published design: budget → snip → microcompact → auto-compact
  // 受 Claude Code 公开设计启发的 4 层压缩：预算裁剪 → 剪切旧结果 → 微压缩 → 自动压缩
  // Tiers 1-3 are zero-API-cost, operating on the local message array.
  // 第 1-3 层是零 API 成本的，在本地消息数组上操作。

  // 运行压缩流水线：依次执行第 1-3 层压缩（在每次 API 调用前调用）
  private runCompressionPipeline(): void {
    if (this.useOpenAI) {
      this.budgetToolResultsOpenAI();
      this.snipStaleResultsOpenAI();
      this.microcompactOpenAI();
    } else {
      this.budgetToolResultsAnthropic();
      this.snipStaleResultsAnthropic();
      this.microcompactAnthropic();
    }
  }

  // Tier 1: Budget tool results — dynamically shrink large results as context fills
  // 第 1 层：预算工具结果 —— 随着上下文填充动态缩小大结果
  // Anthropic 后端版本
  private budgetToolResultsAnthropic(): void {
    const utilization = this.lastInputTokenCount / this.effectiveWindow;
    // 利用率低于 50% 时不做处理
    if (utilization < 0.5) return;
    // 利用率 >70% 时预算更激进（15000 字符），否则 30000 字符
    const budget = utilization > 0.7 ? 15000 : 30000;

    for (const msg of this.anthropicMessages) {
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
      for (let i = 0; i < msg.content.length; i++) {
        const block = msg.content[i] as any;
        // 超过预算的 tool_result 字符串：保留头尾各一半
        if (block.type === "tool_result" && typeof block.content === "string" && block.content.length > budget) {
          const keepEach = Math.floor((budget - 80) / 2); // 减去 80 字符给省略提示
          block.content = block.content.slice(0, keepEach) +
            `\n\n[... budgeted: ${block.content.length - keepEach * 2} chars truncated ...]\n\n` +
            block.content.slice(-keepEach);
        }
      }
    }
  }

  // 第 1 层：预算工具结果 —— OpenAI 后端版本
  private budgetToolResultsOpenAI(): void {
    const utilization = this.lastInputTokenCount / this.effectiveWindow;
    if (utilization < 0.5) return;
    const budget = utilization > 0.7 ? 15000 : 30000;

    for (const msg of this.openaiMessages) {
      // OpenAI 格式：tool 角色的消息存放工具结果
      if ((msg as any).role === "tool" && typeof (msg as any).content === "string") {
        const content = (msg as any).content as string;
        if (content.length > budget) {
          const keepEach = Math.floor((budget - 80) / 2);
          (msg as any).content = content.slice(0, keepEach) +
            `\n\n[... budgeted: ${content.length - keepEach * 2} chars truncated ...]\n\n` +
            content.slice(-keepEach);
        }
      }
    }
  }

  // Tier 2: Snip stale results — replace old/duplicate tool results with placeholder
  // 第 2 层：剪切旧结果 —— 用占位符替换旧的/重复的工具结果
  // Anthropic 后端版本
  private snipStaleResultsAnthropic(): void {
    // Cache-aware gate (mirrors Claude Code's cached-microcompact split): while
    // the prompt cache is still hot, rewriting an old tool_result in place would
    // invalidate the entire cached message prefix. Claude Code prunes hot caches
    // via a cache_edits API call unavailable on the public API, so we leave the
    // hot prefix alone — UNTIL utilization is high enough (SNIP_HOT_OVERRIDE)
    // that risking an overflow costs more than one cache rebuild. Below that we
    // wait for the cache to go cold.
    // 缓存感知门控（仿照 Claude Code 的 cached-microcompact 分割）：
    // 当提示缓存仍"热"时，原地重写旧 tool_result 会使整个缓存消息前缀失效。
    // Claude Code 通过公共 API 不可用的 cache_edits 调用修剪热缓存，
    // 所以我们保留热前缀不动 —— 直到利用率高到（SNIP_HOT_OVERRIDE）
    // 溢出风险大于一次缓存重建。低于此值我们等缓存冷却。
    const utilization = this.lastInputTokenCount / this.effectiveWindow;
    // 判断缓存是否"热"（5 分钟内有 API 调用）
    const cacheHot = this.lastApiCallTime > 0 && (Date.now() - this.lastApiCallTime) < MICROCOMPACT_IDLE_MS;
    // 缓存热且利用率低于 HOT_OVERRIDE → 不剪切（保护缓存）
    if (cacheHot && utilization < SNIP_HOT_OVERRIDE) return;
    // 利用率低于 SNIP_THRESHOLD（60%）→ 不需要剪切
    if (utilization < SNIP_THRESHOLD) return;

    // Collect all tool_result blocks with metadata
    // 收集所有 tool_result 块及其元数据
    const results: { msgIdx: number; blockIdx: number; toolName: string; filePath?: string }[] = [];
    for (let mi = 0; mi < this.anthropicMessages.length; mi++) {
      const msg = this.anthropicMessages[mi];
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
      for (let bi = 0; bi < msg.content.length; bi++) {
        const block = msg.content[bi] as any;
        if (block.type === "tool_result" && typeof block.content === "string" && block.content !== SNIP_PLACEHOLDER) {
          // Find the corresponding tool_use to get tool name and input
          // 找到对应的 tool_use 块以获取工具名和输入
          const toolUseId = block.tool_use_id;
          const toolInfo = this.findToolUseById(toolUseId);
          if (toolInfo && SNIPPABLE_TOOLS.has(toolInfo.name)) {
            results.push({ msgIdx: mi, blockIdx: bi, toolName: toolInfo.name, filePath: toolInfo.input?.file_path });
          }
        }
      }
    }

    // 结果太少（≤最近保留数）→ 无需剪切
    if (results.length <= KEEP_RECENT_RESULTS) return;

    // Strategy: snip duplicates and old results, keep recent N
    // 策略：剪切重复和旧的结果，保留最近 N 个
    const toSnip = new Set<number>();
    const seenFiles = new Map<string, number[]>(); // filePath → indices
    // 文件路径 → 结果索引列表

    // 按文件路径分组 read_file 结果
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.toolName === "read_file" && r.filePath) {
        const existing = seenFiles.get(r.filePath) || [];
        existing.push(i);
        seenFiles.set(r.filePath, existing);
      }
    }

    // Snip earlier reads of same file
    // 剪切同一文件的较早读取（保留最后一次）
    for (const indices of seenFiles.values()) {
      if (indices.length > 1) {
        for (let j = 0; j < indices.length - 1; j++) toSnip.add(indices[j]);
      }
    }

    // Snip oldest results beyond keep-recent threshold
    // 剪切超出最近保留阈值的最旧结果
    const snipBefore = results.length - KEEP_RECENT_RESULTS;
    for (let i = 0; i < snipBefore; i++) toSnip.add(i);

    // 执行剪切：替换为占位符
    for (const idx of toSnip) {
      const r = results[idx];
      const block = (this.anthropicMessages[r.msgIdx].content as any[])[r.blockIdx];
      block.content = SNIP_PLACEHOLDER;
    }
  }

  // 第 2 层：剪切旧结果 —— OpenAI 后端版本
  private snipStaleResultsOpenAI(): void {
    // Cache-aware gate — see snipStaleResultsAnthropic. OpenAI-compatible
    // providers cache prefixes automatically, so the same "don't rewrite a hot
    // prefix (unless utilization is high)" rule applies.
    // 缓存感知门控 —— 见 snipStaleResultsAnthropic。OpenAI 兼容提供商自动缓存前缀，
    // 所以同样的"不重写热前缀（除非利用率高）"规则适用。
    const utilization = this.lastInputTokenCount / this.effectiveWindow;
    const cacheHot = this.lastApiCallTime > 0 && (Date.now() - this.lastApiCallTime) < MICROCOMPACT_IDLE_MS;
    if (cacheHot && utilization < SNIP_HOT_OVERRIDE) return;
    if (utilization < SNIP_THRESHOLD) return;

    // Collect tool messages
    // 收集 tool 角色消息
    const toolMsgs: { idx: number; toolCallId: string }[] = [];
    for (let i = 0; i < this.openaiMessages.length; i++) {
      const msg = this.openaiMessages[i] as any;
      if (msg.role === "tool" && typeof msg.content === "string" && msg.content !== SNIP_PLACEHOLDER) {
        toolMsgs.push({ idx: i, toolCallId: msg.tool_call_id });
      }
    }

    if (toolMsgs.length <= KEEP_RECENT_RESULTS) return;

    // Snip all but the most recent N
    // 剪切除最近 N 个之外的所有结果
    const snipCount = toolMsgs.length - KEEP_RECENT_RESULTS;
    for (let i = 0; i < snipCount; i++) {
      (this.openaiMessages[toolMsgs[i].idx] as any).content = SNIP_PLACEHOLDER;
    }
  }

  // Tier 3: Microcompact — aggressively clear old results when prompt cache is cold
  // 第 3 层：微压缩 —— 当提示缓存冷却时积极清除旧结果
  // Anthropic 后端版本
  private microcompactAnthropic(): void {
    // 缓存仍热（5 分钟内有调用）→ 不微压缩
    if (!this.lastApiCallTime || (Date.now() - this.lastApiCallTime) < MICROCOMPACT_IDLE_MS) return;

    // Collect ALL tool_results across messages, clear all but recent N
    // 收集所有 tool_result 块，清除除最近 N 个之外的所有
    const allResults: { msgIdx: number; blockIdx: number }[] = [];
    for (let mi = 0; mi < this.anthropicMessages.length; mi++) {
      const msg = this.anthropicMessages[mi];
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
      for (let bi = 0; bi < msg.content.length; bi++) {
        const block = msg.content[bi] as any;
        if (block.type === "tool_result" && typeof block.content === "string" &&
            block.content !== SNIP_PLACEHOLDER && block.content !== "[Old result cleared]") {
          allResults.push({ msgIdx: mi, blockIdx: bi });
        }
      }
    }

    // 清除超出最近保留数的旧结果
    const clearCount = allResults.length - KEEP_RECENT_RESULTS;
    for (let i = 0; i < clearCount && i < allResults.length; i++) {
      const r = allResults[i];
      (this.anthropicMessages[r.msgIdx].content as any[])[r.blockIdx].content = "[Old result cleared]";
    }
  }

  // 第 3 层：微压缩 —— OpenAI 后端版本
  private microcompactOpenAI(): void {
    if (!this.lastApiCallTime || (Date.now() - this.lastApiCallTime) < MICROCOMPACT_IDLE_MS) return;

    const toolMsgs: number[] = [];
    for (let i = 0; i < this.openaiMessages.length; i++) {
      const msg = this.openaiMessages[i] as any;
      if (msg.role === "tool" && typeof msg.content === "string" &&
          msg.content !== SNIP_PLACEHOLDER && msg.content !== "[Old result cleared]") {
        toolMsgs.push(i);
      }
    }

    const clearCount = toolMsgs.length - KEEP_RECENT_RESULTS;
    for (let i = 0; i < clearCount && i < toolMsgs.length; i++) {
      (this.openaiMessages[toolMsgs[i]] as any).content = "[Old result cleared]";
    }
  }

  // Helper: find a tool_use block by its ID in assistant messages
  // 辅助方法：按 ID 在 assistant 消息中查找 tool_use 块
  // toolUseId：工具使用 ID
  // 返回：{ name（工具名）, input（输入）} 或 null
  private findToolUseById(toolUseId: string): { name: string; input: any } | null {
    for (const msg of this.anthropicMessages) {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      for (const block of msg.content as any[]) {
        if (block.type === "tool_use" && block.id === toolUseId) {
          return { name: block.name, input: block.input };
        }
      }
    }
    return null;
  }

  // ─── Execute tool (handles agent tool internally) ─────────
  // 执行工具（内部处理 agent/skill/plan 等特殊工具）

  // ─── Large result persistence ───────────────────────────────
  // 大结果持久化
  // When a tool result exceeds 30 KB, write it to disk and replace the
  // context entry with a short preview + file path.  The model can use
  // read_file to retrieve the full output later — no information is lost.
  // 当工具结果超过 30 KB 时，写入磁盘并用简短预览 + 文件路径替换上下文条目。
  // 模型可稍后用 read_file 获取完整输出 —— 不丢失任何信息。

  // 持久化大结果到磁盘，返回替换后的预览文本
  // toolName：工具名称（用于文件名）
  // result：原始完整结果字符串
  // 返回：原始结果（若≤30KB）或预览+路径的替换文本
  private persistLargeResult(toolName: string, result: string): string {
    const THRESHOLD = 30 * 1024; // 30 KB
    // 未超阈值，直接返回原结果
    if (Buffer.byteLength(result) <= THRESHOLD) return result;

    // 创建工具结果存储目录 ~/.mini-claude/tool-results/
    const dir = join(homedir(), ".mini-claude", "tool-results");
    mkdirSync(dir, { recursive: true });
    // uuid suffix: parallel tools can persist in the same millisecond — a
    // timestamp-only name would let the second write clobber the first.
    // uuid 后缀：并行工具可能在同一毫秒持久化 —— 纯时间戳文件名会让第二次写入覆盖第一次。
    const filename = `${Date.now()}-${randomUUID().slice(0, 8)}-${toolName}.txt`;
    const filepath = join(dir, filename);
    // 将完整结果写入磁盘
    writeFileSync(filepath, result);

    const lines = result.split("\n");
    // 预览：前 200 行
    const preview = lines.slice(0, 200).join("\n");
    const sizeKB = (Buffer.byteLength(result) / 1024).toFixed(1);

    // Truncate AFTER persisting: the full result is already safe on disk, so
    // this only guards against pathological previews (e.g. a single
    // multi-hundred-KB line). Order matters — see issue #6.
    // 持久化后再截断：完整结果已安全写入磁盘，所以这只防止病态预览
    //（如单行数百 KB）。顺序很重要 —— 见 issue #6。
    return truncateResult(`[Result too large (${sizeKB} KB, ${lines.length} lines). Full output saved to ${filepath}. You can use read_file to see the full result.]\n\nPreview (first 200 lines):\n${preview}`);
  }

  // ─── Memory prefetch lifecycle (shared by both backends) ────
  // 记忆预取生命周期（两个后端共享）

  // 如果记忆预取已就绪（settled）则消费它：将记忆文本注入到消息历史中
  // messages：消息数组（记忆会追加到最后一条 user 消息或作为新 user 消息）
  private async consumeMemoryPrefetchIfReady(messages: any[]): Promise<void> {
    const pf = this.memoryPrefetch;
    // 无预取 / 未完成 / 已消费 → 跳过
    if (!pf || !pf.settled || pf.consumed) return;
    pf.consumed = true; // 标记已消费（即使出错也不重试）
    try {
      const memories = await pf.promise;
      // 无记忆 → 跳过
      if (memories.length === 0) return;
      // 格式化记忆为注入文本
      const injectionText = formatMemoriesForInjection(memories);
      const last = messages[messages.length - 1];
      if (last && last.role === "user") {
        // Append to the existing user message to maintain alternation
        // 追加到已有的 user 消息以保持 user/assistant 交替
        if (typeof last.content === "string" || last.content == null) {
          last.content = (last.content || "") + "\n\n" + injectionText;
        } else if (Array.isArray(last.content)) {
          // 数组形式：追加文本块
          (last.content as any[]).push({ type: "text", text: injectionText });
        }
      } else {
        // 最后一条不是 user 消息 → 插入新 user 消息
        messages.push({ role: "user", content: injectionText });
      }
      // 记录已展示的记忆路径和字节量
      for (const m of memories) {
        this.alreadySurfacedMemories.add(m.path);
        this.sessionMemoryBytes += Buffer.byteLength(m.content);
      }
    } catch { /* prefetch errors already logged */ }
    // 预取错误已记录日志，此处静默
  }

  // Release external resources (MCP subprocesses and their timers) so the
  // Node process can exit cleanly — see issue #8.
  // 释放外部资源（MCP 子进程及其定时器），使 Node 进程能干净退出 —— 见 issue #8。
  async close(): Promise<void> {
    if (this.mcpInitialized) {
      await this.mcpManager.disconnectAll();
    }
  }

  // 为本回合启动记忆预取（先排干上一轮的遗留预取，再启动新的）
  // userMessage：用户消息（用于语义检索查询）
  // messages：消息数组（用于注入遗留预取）
  private async startMemoryPrefetchForTurn(userMessage: string, messages: any[]): Promise<void> {
    // Drain any carry-over prefetch from the previous turn — a recall that
    // settled after that turn's last API call would otherwise be dropped
    // (issue #7).
    // 排干上一轮的遗留预取 —— 在上一轮最后一次 API 调用后才完成的召回
    // 否则会被丢弃（issue #7）。
    await this.consumeMemoryPrefetchIfReady(messages);
    // 子代理不做记忆预取
    if (this.isSubAgent) return;
    const sq = this.buildSideQuery();
    if (sq) {
      // 启动异步记忆预取（不阻塞，在本次回合的 API 调用期间并行执行）
      this.memoryPrefetch = startMemoryPrefetch(
        userMessage, sq,
        this.alreadySurfacedMemories, this.sessionMemoryBytes,
        this.abortController?.signal,
      );
    }
  }

  // 执行工具调用（统一入口，处理内部特殊工具和外部/MCP工具）
  // name：工具名称
  // input：工具输入参数
  // 返回：工具执行结果字符串
  private async executeToolCall(
    name: string,
    input: Record<string, any>
  ): Promise<string> {
    // 计划模式工具：进入/退出 plan 模式
    if (name === "enter_plan_mode" || name === "exit_plan_mode") return await this.executePlanModeTool(name);
    // agent 工具：生成子代理执行任务
    if (name === "agent") return this.executeAgentTool(input);
    // skill 工具：执行技能
    if (name === "skill") return this.executeSkillTool(input);
    if (name === "schedule_wakeup") {
      // Only the internal dynamic-loop driver may route here; outside a dynamic
      // loop the tool isn't exposed, and this guard keeps a stray call (or a
      // same-named external tool) from reaching the executor.
      // 仅内部动态循环驱动器可路由到此处；动态循环外该工具不暴露，
      // 此防护防止杂散调用（或同名外部工具）到达执行器。
      if (!this.scheduleWakeupEnabled) return "schedule_wakeup is only available during /loop dynamic mode.";
      return this.executeScheduleWakeup(input);
    }
    // Route MCP tool calls to the MCP manager
    // MCP 工具调用路由到 MCP 管理器
    if (this.mcpManager.isMcpTool(name)) return this.mcpManager.callTool(name, input);
    // 普通工具：调用 tools.js 中的 executeTool
    return executeTool(name, input, this.readFileState);
  }

  // ─── Skill fork mode ─────────────────────────────────────
  // 技能分叉（fork）模式

  // 执行 skill 工具调用
  // input：{ skill_name（技能名）, args（参数） }
  // 返回：技能执行结果文本（inline 模式返回提示词，fork 模式返回子代理输出）
  private async executeSkillTool(input: Record<string, any>): Promise<string> {
    // 动态导入技能模块（避免循环依赖）
    const { executeSkill } = await import("./skills.js");
    const result = executeSkill(input.skill_name, input.args || "");
    // 未知技能
    if (!result) return `Unknown skill: ${input.skill_name}`;

    if (result.context === "fork") {
      // Fork mode: run in isolated sub-agent. Never pass schedule_wakeup down —
      // it's a driver-internal tool scoped to this agent's dynamic loop, not
      // something a forked skill should inherit.
      // Fork 模式：在隔离子代理中运行。绝不传递 schedule_wakeup ——
      // 它是限于本代理动态循环的驱动器内部工具，不应被分叉的技能继承。
      // 构建子代理工具列表：按 allowedTools 过滤，或排除 agent 工具，并排除 schedule_wakeup
      const tools = (result.allowedTools
        ? this.tools.filter(t => result.allowedTools!.includes(t.name))
        : this.tools.filter(t => t.name !== "agent"))
        .filter(t => t.name !== "schedule_wakeup");

      printSubAgentStart("skill-fork", input.skill_name);
      // 创建隔离子代理
      const subAgent = new Agent({
        model: this.model,
        apiBase: this.useOpenAI ? this.openaiClient?.baseURL : undefined,
        customSystemPrompt: result.prompt,   // 技能提供的系统提示词
        customTools: tools,
        isSubAgent: true,
        permissionMode: this.childPermissionMode(),
      });

      try {
        // 执行技能任务
        const subResult = await subAgent.runOnce(input.args || "Execute this skill task.");
        // 累加子代理的 token 消耗到父代理
        this.totalInputTokens += subResult.tokens.input;
        this.totalOutputTokens += subResult.tokens.output;
        printSubAgentEnd("skill-fork", input.skill_name);
        return subResult.text || "(Skill produced no output)";
      } catch (e: any) {
        printSubAgentEnd("skill-fork", input.skill_name);
        return `Skill fork error: ${e.message}`;
      }
    }

    // Inline mode: return prompt for injection into conversation
    // 内联模式：返回提示词注入到当前对话中
    return `[Skill "${input.skill_name}" activated]\n\n${result.prompt}`;
  }

  // ─── Plan mode helpers ──────────────────────────────────────
  // 计划模式（Plan mode）辅助方法

  // 生成计划文件的路径：~/.claude/plans/plan-<sessionId>.md
  private generatePlanFilePath(): string {
    const dir = join(homedir(), ".claude", "plans");
    // 目录不存在则创建
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return join(dir, `plan-${this.sessionId}.md`);
  }

  // 构建 plan 模式的系统提示词后缀（指导模型如何做计划）
  private buildPlanModePrompt(): string {
    return `

# Plan Mode Active

Plan mode is active. You MUST NOT make any edits (except the plan file below), run non-readonly tools, or make any changes to the system.

## Plan File: ${this.planFilePath}
Write your plan incrementally to this file using write_file or edit_file. This is the ONLY file you are allowed to edit.

## Workflow
1. **Explore**: Read code to understand the task. Use read_file, list_files, grep_search.
2. **Design**: Design your implementation approach. Use the agent tool with type="plan" if the task is complex.
3. **Write Plan**: Write a structured plan to the plan file including:
   - **Context**: Why this change is needed
   - **Steps**: Implementation steps with critical file paths
   - **Verification**: How to test the changes
4. **Exit**: Call exit_plan_mode when your plan is ready for user review.

IMPORTANT: When your plan is complete, you MUST call exit_plan_mode. Do NOT ask the user to approve — exit_plan_mode handles that.`;
  }

  // 执行计划模式工具（enter_plan_mode / exit_plan_mode）
  // name：工具名称（enter_plan_mode 或 exit_plan_mode）
  // 返回：工具执行结果文本（反馈给模型）
  private async executePlanModeTool(name: string): Promise<string> {
    if (name === "enter_plan_mode") {
      // 已在 plan 模式
      if (this.permissionMode === "plan") {
        return "Already in plan mode.";
      }
      // 进入 plan 模式：保存当前模式，切换为 plan
      this.prePlanMode = this.permissionMode;
      this.permissionMode = "plan";
      this.planFilePath = this.generatePlanFilePath();
      this.systemPrompt = this.baseSystemPrompt + this.buildPlanModePrompt();
      // OpenAI 后端同步更新 system 消息
      if (this.useOpenAI && this.openaiMessages.length > 0) {
        (this.openaiMessages[0] as any).content = this.systemPrompt;
      }
      printInfo("Entered plan mode (read-only). Plan file: " + this.planFilePath);
      return `Entered plan mode. You are now in read-only mode.\n\nYour plan file: ${this.planFilePath}\nWrite your plan to this file. This is the only file you can edit.\n\nWhen your plan is complete, call exit_plan_mode.`;
    }

    if (name === "exit_plan_mode") {
      // 不在 plan 模式
      if (this.permissionMode !== "plan") {
        return "Not in plan mode.";
      }
      // Read plan file content
      // 读取计划文件内容
      let planContent = "(No plan file found)";
      if (this.planFilePath && existsSync(this.planFilePath)) {
        planContent = readFileSync(this.planFilePath, "utf-8");
      }

      // Interactive approval flow
      // 交互式审批流程
      if (this.planApprovalFn) {
        const result = await this.planApprovalFn(planContent);

        if (result.choice === "keep-planning") {
          // User rejected — stay in plan mode, return feedback to model
          // 用户拒绝 —— 留在 plan 模式，返回反馈给模型
          const feedback = result.feedback || "Please revise the plan.";
          return `User rejected the plan and wants to keep planning.\n\nUser feedback: ${feedback}\n\nPlease revise your plan based on this feedback. When done, call exit_plan_mode again.`;
        }

        // User approved — determine the target mode
        // 用户批准 —— 确定目标权限模式
        let targetMode: PermissionMode;
        if (result.choice === "clear-and-execute") {
          targetMode = "acceptEdits";   // 清除上下文并执行 → acceptEdits
        } else if (result.choice === "execute") {
          targetMode = "acceptEdits";   // 直接执行 → acceptEdits
        } else {
          // manual-execute
          // 手动执行 → 恢复之前的模式
          targetMode = this.prePlanMode || "default";
        }

        // Exit plan mode
        // 退出 plan 模式
        this.permissionMode = targetMode;
        this.prePlanMode = null;
        const savedPlanPath = this.planFilePath;
        this.planFilePath = null;
        this.systemPrompt = this.baseSystemPrompt;
        if (this.useOpenAI && this.openaiMessages.length > 0) {
          (this.openaiMessages[0] as any).content = this.systemPrompt;
        }

        // Clear context if requested
        // 如果要求清除上下文（clear-and-execute 选项）
        if (result.choice === "clear-and-execute") {
          this.clearHistoryKeepSystem();
          this.contextCleared = true; // Signal the agent loop to inject plan as user message
          // contextCleared：信号代理循环将计划作为 user 消息注入
          printInfo(`Plan approved. Context cleared, executing in ${targetMode} mode.`);
          return `User approved the plan. Context was cleared. Permission mode: ${targetMode}\n\nPlan file: ${savedPlanPath}\n\n## Approved Plan:\n${planContent}\n\nProceed with implementation.`;
        }

        printInfo(`Plan approved. Executing in ${targetMode} mode.`);
        return `User approved the plan. Permission mode: ${targetMode}\n\n## Approved Plan:\n${planContent}\n\nProceed with implementation.`;
      }

      // Fallback: no approval function, just exit directly (e.g. sub-agents)
      // 兜底：无审批函数，直接退出（如子代理场景）
      this.permissionMode = this.prePlanMode || "default";
      this.prePlanMode = null;
      this.planFilePath = null;
      this.systemPrompt = this.baseSystemPrompt;
      if (this.useOpenAI && this.openaiMessages.length > 0) {
        (this.openaiMessages[0] as any).content = this.systemPrompt;
      }
      printInfo("Exited plan mode. Restored to " + this.permissionMode + " mode.");
      return `Exited plan mode. Permission mode restored to: ${this.permissionMode}\n\n## Your Plan:\n${planContent}`;
    }

    return `Unknown plan mode tool: ${name}`;
  }

  /** Clear history but keep system prompt intact (used for clear-context plan approval) */
  // 清除历史但保留系统提示词（用于清除上下文的计划审批）
  private clearHistoryKeepSystem() {
    this.anthropicMessages = [];
    this.openaiMessages = [];
    // OpenAI 后端需要重新放入 system 消息
    if (this.useOpenAI) {
      this.openaiMessages.push({ role: "system", content: this.systemPrompt });
    }
    this.lastInputTokenCount = 0;
  }

  // 执行 agent 工具调用：生成子代理执行特定类型的任务
  // input：{ type（子代理类型）, description（描述）, prompt（提示词） }
  // 返回：子代理输出文本
  private async executeAgentTool(input: Record<string, any>): Promise<string> {
    const type = (input.type || "general") as SubAgentType;
    const description = input.description || "sub-agent task";
    const prompt = input.prompt || "";

    printSubAgentStart(type, description);

    // 获取子代理类型的配置（系统提示词和工具列表）
    const config = getSubAgentConfig(type);
    // 创建子代理实例
    const subAgent = new Agent({
      model: this.model,
      apiKey: this.anthropicClient
        ? undefined  // Anthropic SDK reads from env
        // Anthropic SDK 从环境变量读取密钥
        : undefined,
      apiBase: this.useOpenAI ? this.openaiClient?.baseURL : undefined,
      customSystemPrompt: config.systemPrompt,
      customTools: config.tools,
      isSubAgent: true,
      permissionMode: this.childPermissionMode(),
    });

    try {
      const result = await subAgent.runOnce(prompt);
      // Add sub-agent token usage to parent
      // 将子代理的 token 消耗累加到父代理
      this.totalInputTokens += result.tokens.input;
      this.totalOutputTokens += result.tokens.output;
      printSubAgentEnd(type, description);
      return result.text || "(Sub-agent produced no output)";
    } catch (e: any) {
      printSubAgentEnd(type, description);
      return `Sub-agent error: ${e.message}`;
    }
  }

  // ─── Anthropic backend ───────────────────────────────────────
  // Anthropic 后端实现

  // Push a user message, prepending the CLAUDE.md/date <system-reminder> when
  // it is the first user message of a (possibly just-cleared) context — Claude
  // Code's prependUserContext, kept out of the cached system prompt. Embedded
  // in the user message rather than a standalone message to preserve
  // user/assistant alternation. Also used by the plan clear-and-execute path,
  // which rebuilds history from empty.
  // 推入用户消息，当它是（可能刚清除的）上下文的第一条用户消息时，
  // 前置 CLAUDE.md/日期 <system-reminder> —— Claude Code 的 prependUserContext，
  // 保持在缓存系统提示词之外。嵌入用户消息而非独立消息，以保持 user/assistant 交替。
  // 也用于 plan clear-and-execute 路径（从空重建历史）。
  // content：用户消息文本
  private pushAnthropicUserMessage(content: string): void {
    if (this.anthropicMessages.length === 0 && this.userContextReminder) {
      // 第一条用户消息且有上下文提醒：将提醒作为文本块 + 内容文本块
      this.anthropicMessages.push({
        role: "user",
        content: [
          { type: "text", text: this.userContextReminder },
          { type: "text", text: content },
        ],
      });
    } else {
      // 普通情况：直接推入
      this.anthropicMessages.push({ role: "user", content });
    }
  }

  // OpenAI 后端版本：推入用户消息（同上逻辑，OpenAI 格式）
  private pushOpenAIUserMessage(content: string): void {
    // 检查是否是第一条用户消息
    const isFirstUser = !this.openaiMessages.some((m) => m.role === "user");
    if (isFirstUser && this.userContextReminder) {
      // 第一条 + 有提醒：拼接提醒和内容
      this.openaiMessages.push({ role: "user", content: `${this.userContextReminder}\n\n${content}` });
    } else {
      this.openaiMessages.push({ role: "user", content });
    }
  }

  // Anthropic 后端主对话循环：处理用户消息、调用模型、执行工具、管理上下文
  // userMessage：用户输入文本
  private async chatAnthropic(userMessage: string): Promise<void> {
    // 推入用户消息（含首条消息的上下文提醒）
    this.pushAnthropicUserMessage(userMessage);
    // Auto-compact at turn boundary only — the last message is now plain
    // user text, so the slice in compactAnthropic won't sever a
    // tool_use ↔ tool_result pair from the previous turn's tool execution.
    // 仅在回合边界自动压缩 —— 最后一条消息现在是纯用户文本，
    // 所以 compactAnthropic 的切片不会切断上一回合工具执行的 tool_use ↔ tool_result 对。
    await this.checkAndCompact();

    // Memory prefetch: drain carry-over, then start fresh (issue #7)
    // 记忆预取：排干遗留，然后启动新的（issue #7）
    await this.startMemoryPrefetchForTurn(userMessage, this.anthropicMessages);

    let firstIteration = true;

    // 主循环：持续调用模型直到无工具调用或中断
    while (true) {
      if (this.abortController?.signal.aborted) break;

      // Run compression pipeline before API call (tiers 1-3 are zero-cost)
      // API 调用前运行压缩流水线（第 1-3 层零成本）
      this.runCompressionPipeline();

      // Consume memory prefetch if settled (non-blocking poll, zero-wait).
      // Checked every iteration so the model sees recalled memories ASAP.
      // 如果预取已就绪则消费（非阻塞轮询，零等待）。
      // 每次迭代都检查，使模型尽快看到召回的记忆。
      await this.consumeMemoryPrefetchIfReady(this.anthropicMessages);

      // 主代理显示加载动画
      if (!this.isSubAgent) startSpinner();

      // ── Streaming tool execution ──────────────────────────────
      // 流式工具执行
      // As each tool_use content block completes during streaming, check
      // if it's concurrency-safe and auto-allowed. If so, start execution
      // immediately — the tool runs while the model still generates.
      // 当每个 tool_use 内容块在流式中完成时，检查它是否并发安全且自动允许。
      // 如果是，立即开始执行 —— 工具在模型仍在生成时并行运行。
      // 提前执行的工具：tool_use_id → Promise（结果）
      const earlyExecutions = new Map<string, Promise<string>>();

      // 调用 Anthropic 流式 API，传入 tool_block_complete 回调
      const response = await this.callAnthropicStream((block) => {
        const input = block.input as Record<string, any>;
        // In Auto Mode, only fast-path (classifier-exempt) tools may start early
        // — otherwise a concurrency-safe-but-classified tool (e.g. web_fetch)
        // would run before the classifier ever sees it.
        // Auto Mode 下，仅 fast-path（分类器豁免）工具可提前执行 ——
        // 否则并发安全但需分类的工具（如 web_fetch）会在分类器看到之前就运行。
        if (this.permissionMode === "auto" && !AUTO_MODE_FAST_PATH_TOOLS.has(block.name)) return;
        // 并发安全工具 + 权限检查通过 → 提前启动执行
        if (CONCURRENCY_SAFE_TOOLS.has(block.name)) {
          const perm = checkPermission(block.name, input, this.permissionMode, this.planFilePath || undefined);
          if (perm.action === "allow") {
            earlyExecutions.set(block.id, this.executeToolCall(block.name, input));
          }
        }
      });
      if (!this.isSubAgent) stopSpinner();
      this.lastApiCallTime = Date.now(); // 记录 API 调用时间（用于缓存热度判断）
      // Anthropic reports cached tokens separately: `input_tokens` counts only
      // the uncached (freshly processed) prefix, while cache_read/cache_creation
      // are billed at 0.1x/1.25x. Track them apart for accurate cost.
      // Anthropic 单独报告缓存 token：`input_tokens` 仅计算未缓存（刚处理）的前缀，
      // 而 cache_read/cache_creation 按 0.1x/1.25x 计费。分开追踪以准确计算成本。
      const cacheRead = (response.usage as any).cache_read_input_tokens || 0;
      const cacheCreation = (response.usage as any).cache_creation_input_tokens || 0;
      this.totalInputTokens += response.usage.input_tokens;
      this.totalCacheReadTokens += cacheRead;
      this.totalCacheCreationTokens += cacheCreation;
      this.totalOutputTokens += response.usage.output_tokens;
      // Estimate next-turn context size for the compaction gauge: the full
      // prompt we just sent (input + cache_read + cache_creation) plus the
      // output we just generated, which becomes part of the next request.
      // 估算下一回合上下文大小（用于压缩触发）：刚发送的完整提示
      //（input + cache_read + cache_creation）加上刚生成的输出（成为下次请求的一部分）。
      this.lastInputTokenCount =
        response.usage.input_tokens + cacheRead + cacheCreation + response.usage.output_tokens;

      // 收集所有 tool_use 块
      const toolUses: Anthropic.ToolUseBlock[] = [];

      for (const block of response.content) {
        if (block.type === "tool_use") {
          toolUses.push(block);
        }
      }

      // 将 assistant 响应添加到消息历史
      this.anthropicMessages.push({
        role: "assistant",
        content: response.content,
      });

      if (toolUses.length === 0) {
        // 无工具调用 → 对话回合结束，打印费用
        if (!this.isSubAgent) {
          printCost(this.totalInputTokens, this.totalOutputTokens, this.totalCacheReadTokens, this.totalCacheCreationTokens);
        }
        break;
      }

      // Budget check after each turn
      // 每回合后检查预算
      this.currentTurns++;
      const budget = this.checkBudget();
      if (budget.exceeded) {
        printInfo(`Budget exceeded: ${budget.reason}`);
        // Every tool_use needs a paired tool_result or the message history
        // is invalid for the next API call. Pair each pending call with a
        // refusal instead of silently dropping it.
        // 每个 tool_use 需要配对的 tool_result，否则下次 API 调用的消息历史无效。
        // 为每个待处理调用配对拒绝结果，而非静默丢弃。
        this.anthropicMessages.push({
          role: "user",
          content: toolUses.map((tu) => ({
            type: "tool_result" as const,
            tool_use_id: tu.id,
            content: `Tool call not executed: ${budget.reason}`,
          })),
        });
        break;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      // Process tools: early-started ones (from streaming) just await their
      // result; others go through permission check + execution as before.
      // 处理工具：提前启动的（来自流式）只需等待结果；
      // 其余走权限检查 + 执行的常规流程。
      let contextBreak = false;
      for (const toolUse of toolUses) {
        if (contextBreak || this.abortController?.signal.aborted) break;
        const input = toolUse.input as Record<string, any>;
        printToolCall(toolUse.name, input);

        // Was this tool already started during streaming?
        // 这个工具是否已在流式期间提前启动？
        const earlyPromise = earlyExecutions.get(toolUse.id);
        if (earlyPromise) {
          // 等待提前执行的结果
          const raw = await earlyPromise;
          const res = this.persistLargeResult(toolUse.name, raw);
          printToolResult(toolUse.name, res);
          toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: res });
          continue;
        }

        // Permission check for tools not started early. Auto Mode routes
        // through the transcript classifier; other modes use static rules.
        // 未提前启动的工具做权限检查。Auto Mode 走转录分类器；其他模式用静态规则。
        const perm = this.permissionMode === "auto"
          ? await this.classifyToolCall(toolUse.name, input)
          : checkPermission(toolUse.name, input, this.permissionMode, this.planFilePath || undefined);
        if (perm.action === "deny") {
          // 权限拒绝
          printInfo(`Denied: ${perm.message}`);
          toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: `Action denied: ${perm.message}` });
          continue;
        }
        if (perm.action === "confirm" && perm.message) {
          // Auto Mode confirms carry a reason, not a path — never cache them, or
          // one approval would whitelist every later action with the same reason.
          // Auto Mode 确认携带理由而非路径 —— 永不缓存，否则一次批准会白名单
          // 所有后续同理由的动作。
          const cacheable = this.permissionMode !== "auto";
          // 非缓存或未确认过 → 弹出确认
          if (!cacheable || !this.confirmedPaths.has(perm.message)) {
            const confirmed = await this.confirmDangerous(perm.message);
            if (!confirmed) {
              // 用户拒绝
              toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: "User denied this action." });
              continue;
            }
            // 可缓存则加入白名单
            if (cacheable) this.confirmedPaths.add(perm.message);
          }
        }

        // 执行工具调用
        const raw = await this.executeToolCall(toolUse.name, input);
        const res = this.persistLargeResult(toolUse.name, raw);
        printToolResult(toolUse.name, res);

        // plan 模式 clear-and-execute 后上下文被清除
        if (this.contextCleared) {
          this.contextCleared = false;
          // History was just cleared — route through the helper so the rebuilt
          // context's first user message carries the CLAUDE.md/date reminder.
          // 历史刚被清除 —— 通过辅助方法路由，使重建上下文的首条 user 消息携带 CLAUDE.md/日期提醒。
          this.pushAnthropicUserMessage(res);
          contextBreak = true;
          break;
        }
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: res });
      }

      // 推入工具结果消息（若无上下文中断）
      if (!contextBreak && !this.contextCleared && toolResults.length > 0) {
        this.anthropicMessages.push({ role: "user", content: toolResults });
      }
      this.contextCleared = false;

      firstIteration = false;
    }
  }

  /**
   * Stream an Anthropic API call. When a tool_use content block finishes
   * during streaming, `onToolBlockComplete` fires immediately so the caller
   * can start execution before the full response arrives (streaming tool
   * execution — inspired by Claude Code's content_block_stop streaming pattern).
   */
  // 流式 Anthropic API 调用。
  // 当 tool_use 内容块在流式中完成时，`onToolBlockComplete` 回调立即触发，
  // 使调用方可在完整响应到达前开始执行（流式工具执行 ——
  // 受 Claude Code 的 content_block_stop 流式模式启发）。
  // onToolBlockComplete：工具块完成时的回调（用于提前启动工具执行）
  // 返回：完整的 Anthropic Message（流式结束后）
  private async callAnthropicStream(
    onToolBlockComplete?: (block: Anthropic.ToolUseBlock) => void,
  ): Promise<Anthropic.Message> {
    return withRetry(async (signal) => {
      const maxOutput = getMaxOutputTokens(this.model);
      // 构建创建消息的参数
      const createParams: any = {
        model: this.model,
        // thinking 启用时用模型最大输出，否则用默认 16384
        max_tokens: this.thinkingMode !== "disabled" ? maxOutput : 16384,
        system: this.buildAnthropicSystem(),   // 带缓存断点的 system
        tools: getActiveToolDefinitions(this.tools),
        // Rolling message-array cache breakpoint, applied to a copy so the
        // persistent history stays free of cache_control metadata.
        // 滚动消息数组缓存断点，应用到副本上，使持久化历史不受 cache_control 元数据影响。
        messages: this.withCacheBreakpoints(this.anthropicMessages),
      };

      // 设置 thinking 参数（adaptive 和 enabled 都启用，budget 为 maxOutput-1）
      if (this.thinkingMode === "adaptive") {
        createParams.thinking = { type: "enabled", budget_tokens: maxOutput - 1 };
      } else if (this.thinkingMode === "enabled") {
        createParams.thinking = { type: "enabled", budget_tokens: maxOutput - 1 };
      }

      // 开始流式请求
      const stream = this.anthropicClient!.messages.stream(createParams, { signal });

      // Stream text content (SDK high-level event)
      // 流式文本内容（SDK 高层事件）
      let firstText = true;
      stream.on("text", (text: string) => {
        // 第一段文本：停止动画，输出换行
        if (firstText) { stopSpinner(); this.emitText("\n"); firstText = false; }
        this.emitText(text);
      });

      // ── Unified streamEvent handler for thinking + tool tracking ──
      // 统一的 streamEvent 处理器（thinking 透传 + 工具追踪）
      // Track in-flight tool_use blocks by index. When content_block_stop
      // fires for a tool_use, parse accumulated JSON and notify caller
      // so it can start execution while later blocks still stream.
      // 按索引追踪进行中的 tool_use 块。当 content_block_stop 对 tool_use 触发时，
      // 解析累积的 JSON 并通知调用方，使其能在后续块仍在流式时开始执行。
      const toolBlocksByIndex = new Map<number, { id: string; name: string; inputJson: string }>();
      let inThinking = false;

      stream.on("streamEvent" as any, (event: any) => {
        // Thinking passthrough
        // thinking 内容透传
        if (event.type === "content_block_start" && event.content_block?.type === "thinking") {
          if (this.thinkingMode !== "disabled") {
            inThinking = true;
            stopSpinner();
            // 以暗色输出 [thinking] 标记
            this.emitText("\n" + chalk.dim("  [thinking] "));
          }
        } else if (event.type === "content_block_delta" && event.delta?.type === "thinking_delta" && inThinking) {
          // 流式输出 thinking 内容（暗色）
          this.emitText(chalk.dim(event.delta.thinking));
        }

        // Tool block tracking: accumulate input JSON as it streams
        // 工具块追踪：流式累积 input JSON
        if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
          // 记录 tool_use 块的 id、name，初始化 inputJson
          toolBlocksByIndex.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            inputJson: "",
          });
        } else if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
          // 累积部分 JSON 片段
          const tb = toolBlocksByIndex.get(event.index);
          if (tb) tb.inputJson += event.delta.partial_json;
        }

        // content_block_stop: finalize thinking or fire tool callback
        // content_block_stop：结束 thinking 或触发工具回调
        if (event.type === "content_block_stop") {
          if (inThinking) { this.emitText("\n"); inThinking = false; }
          const tb = toolBlocksByIndex.get(event.index);
          if (tb && onToolBlockComplete) {
            // 解析累积的 input JSON
            let parsedInput: Record<string, any> = {};
            try { parsedInput = JSON.parse(tb.inputJson || "{}"); } catch {}
            // 触发回调，让调用方提前启动工具执行
            onToolBlockComplete({ type: "tool_use", id: tb.id, name: tb.name, input: parsedInput });
            toolBlocksByIndex.delete(event.index);
          }
        }
      });

      // 等待流式结束，获取最终完整消息
      const finalMessage = await stream.finalMessage();

      // Filter out thinking blocks from stored history
      // 从存储的历史中过滤掉 thinking 块（不稳定内容）
      finalMessage.content = finalMessage.content.filter(
        (block: any) => block.type !== "thinking"
      );

      return finalMessage;
    }, this.abortController?.signal);
  }

  // ─── OpenAI-compatible backend ───────────────────────────────
  // OpenAI 兼容后端实现

  // OpenAI 后端主对话循环：处理用户消息、调用模型、执行工具、管理上下文
  // 逻辑与 chatAnthropic 对称，但使用 OpenAI 消息格式和工具调用约定
  // userMessage：用户输入文本
  private async chatOpenAI(userMessage: string): Promise<void> {
    this.pushOpenAIUserMessage(userMessage);
    // Auto-compact at turn boundary only — see chatAnthropic for rationale.
    // The last message is now plain user text, so the slice in compactOpenAI
    // won't orphan a tool_calls / tool message pair.
    // 仅在回合边界自动压缩 —— 理由见 chatAnthropic。
    // 最后一条消息现在是纯用户文本，所以 compactOpenAI 的切片不会使 tool_calls/tool 消息对孤立。
    await this.checkAndCompact();

    // Memory prefetch: drain carry-over, then start fresh (issue #7)
    // 记忆预取：排干遗留，然后启动新的（issue #7）
    await this.startMemoryPrefetchForTurn(userMessage, this.openaiMessages);

    // 主循环
    while (true) {
      if (this.abortController?.signal.aborted) break;

      // Run compression pipeline before API call
      // API 调用前运行压缩流水线
      this.runCompressionPipeline();

      // Consume memory prefetch if settled (non-blocking poll, zero-wait)
      // 如果预取已就绪则消费（非阻塞轮询，零等待）
      await this.consumeMemoryPrefetchIfReady(this.openaiMessages);

      if (!this.isSubAgent) startSpinner();
      // 调用 OpenAI 流式 API
      const response = await this.callOpenAIStream();
      if (!this.isSubAgent) stopSpinner();
      this.lastApiCallTime = Date.now();

      // Track tokens. OpenAI-compatible providers cache prefixes automatically
      // (no cache_control needed); the cached portion is included in
      // prompt_tokens, so split it out to avoid double-counting. Clamp to
      // [0, prompt_tokens] since compatible gateways don't guarantee the field.
      // NOTE: we price it at Anthropic's 0.1x for simplicity; actual cached
      // rates vary by provider (OpenAI ~0.5x, gateways vary), so the
      // OpenAI-path estimate may be off in either direction.
      // 追踪 token。OpenAI 兼容提供商自动缓存前缀（无需 cache_control）；
      // 缓存部分包含在 prompt_tokens 中，所以拆分出来避免重复计数。
      // 钳制到 [0, prompt_tokens] 因为兼容网关不保证该字段存在。
      // 注意：为简化按 Anthropic 的 0.1x 定价；实际缓存费率因提供商而异
      //（OpenAI 约 0.5x，网关各异），所以 OpenAI 路径的估算可能有偏差。
      if (response.usage) {
        const prompt = response.usage.prompt_tokens || 0;
        const rawCached = response.usage.prompt_tokens_details?.cached_tokens || 0;
        // 钳制缓存 token 到合理范围
        const cachedOA = Math.min(Math.max(rawCached, 0), prompt);
        this.totalInputTokens += prompt - cachedOA;  // 非缓存部分
        this.totalCacheReadTokens += cachedOA;        // 缓存部分
        this.totalOutputTokens += response.usage.completion_tokens;
        // Estimate next-turn context size: this prompt + the output we just
        // generated (which becomes part of the next request).
        // 估算下一回合上下文大小：本次提示 + 刚生成的输出（成为下次请求的一部分）。
        this.lastInputTokenCount = prompt + response.usage.completion_tokens;
      }

      const choice = response.choices?.[0];
      if (!choice) break;
      const message = choice.message;

      // Add assistant message to history
      // 将 assistant 消息添加到历史
      this.openaiMessages.push(message);

      // If no tool calls, we're done
      // 无工具调用 → 对话回合结束
      const toolCalls = message.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        if (!this.isSubAgent) {
          printCost(this.totalInputTokens, this.totalOutputTokens, this.totalCacheReadTokens, this.totalCacheCreationTokens);
        }
        break;
      }

      // Budget check after each turn
      // 每回合后检查预算
      this.currentTurns++;
      const budget = this.checkBudget();
      if (budget.exceeded) {
        printInfo(`Budget exceeded: ${budget.reason}`);
        // Same pairing requirement as the Anthropic path: every tool_call
        // needs a role:"tool" response.
        // 与 Anthropic 路径相同的配对要求：每个 tool_call 需要 role:"tool" 的响应。
        for (const tc of toolCalls) {
          this.openaiMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: `Tool call not executed: ${budget.reason}`,
          });
        }
        break;
      }

      // Phase 1: Parse & permission-check all tool calls (serial — user interaction)
      // 阶段 1：解析并权限检查所有工具调用（串行 —— 涉及用户交互）
      type OAIChecked = { tc: typeof toolCalls[0]; fnName: string; input: Record<string, any>; allowed: boolean; result?: string };
      const oaiChecked: OAIChecked[] = [];
      for (const tc of toolCalls) {
        if (this.abortController?.signal.aborted) break;
        if (tc.type !== "function") continue;
        const fnName = tc.function.name;
        // 解析工具参数 JSON
        let input: Record<string, any>;
        try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }

        printToolCall(fnName, input);

        // 权限检查：Auto Mode 走分类器，其他模式用静态规则
        const perm = this.permissionMode === "auto"
          ? await this.classifyToolCall(fnName, input)
          : checkPermission(fnName, input, this.permissionMode, this.planFilePath || undefined);
        if (perm.action === "deny") {
          printInfo(`Denied: ${perm.message}`);
          oaiChecked.push({ tc, fnName, input, allowed: false, result: `Action denied: ${perm.message}` });
          continue;
        }
        if (perm.action === "confirm" && perm.message) {
          // Auto Mode confirms carry a reason, not a path — never cache them, or
          // one approval would whitelist every later action with the same reason.
          // Auto Mode 确认携带理由而非路径 —— 永不缓存，否则一次批准会白名单所有后续同理由动作。
          const cacheable = this.permissionMode !== "auto";
          if (!cacheable || !this.confirmedPaths.has(perm.message)) {
            const confirmed = await this.confirmDangerous(perm.message);
            if (!confirmed) {
              oaiChecked.push({ tc, fnName, input, allowed: false, result: "User denied this action." });
              continue;
            }
            if (cacheable) this.confirmedPaths.add(perm.message);
          }
        }
        oaiChecked.push({ tc, fnName, input, allowed: true });
      }

      // Phase 2: Group & execute (parallel for consecutive safe tools)
      // 阶段 2：分组并执行（连续安全工具并行）
      type OAIBatch = { concurrent: boolean; items: OAIChecked[] };
      const oaiBatches: OAIBatch[] = [];
      // 将连续的并发安全工具归为一批并行执行，其余逐个串行
      for (const ct of oaiChecked) {
        const safe = ct.allowed && CONCURRENCY_SAFE_TOOLS.has(ct.fnName);
        // 如果是安全工具且上一批也是并发批 → 追加到上一批
        if (safe && oaiBatches.length > 0 && oaiBatches[oaiBatches.length - 1].concurrent) {
          oaiBatches[oaiBatches.length - 1].items.push(ct);
        } else {
          // 否则新开一批
          oaiBatches.push({ concurrent: safe, items: [ct] });
        }
      }

      let oaiContextBreak = false;
      for (const batch of oaiBatches) {
        if (oaiContextBreak || this.abortController?.signal.aborted) break;

        if (batch.concurrent) {
          // 并发批：用 Promise.all 同时执行所有工具
          const results = await Promise.all(
            batch.items.map(async (ct) => {
              const raw = await this.executeToolCall(ct.fnName, ct.input);
              const res = this.persistLargeResult(ct.fnName, raw);
              printToolResult(ct.fnName, res);
              return { ct, res };
            })
          );
          // 将所有结果推入消息历史
          for (const { ct, res } of results) {
            this.openaiMessages.push({ role: "tool", tool_call_id: ct.tc.id, content: res });
          }
        } else {
          // 串行批：逐个执行
          for (const ct of batch.items) {
            // 被拒绝的工具：推入拒绝结果
            if (!ct.allowed) {
              this.openaiMessages.push({ role: "tool", tool_call_id: ct.tc.id, content: ct.result! });
              continue;
            }
            const raw = await this.executeToolCall(ct.fnName, ct.input);
            const res = this.persistLargeResult(ct.fnName, raw);
            printToolResult(ct.fnName, res);

            // plan 模式 clear-and-execute 后上下文被清除
            if (this.contextCleared) {
              this.contextCleared = false;
              // History was just cleared — route through the helper so the
              // rebuilt context's first user message carries the reminder.
              // 历史刚被清除 —— 通过辅助方法路由，使重建上下文的首条 user 消息携带提醒。
              this.pushOpenAIUserMessage(res);
              oaiContextBreak = true;
              break;
            }
            this.openaiMessages.push({ role: "tool", tool_call_id: ct.tc.id, content: res });
          }
        }
      }

      this.contextCleared = false;
    }
  }

  // OpenAI 流式 API 调用：流式接收响应，累积文本和工具调用，最终组装为 ChatCompletion
  // 返回：组装完成的 ChatCompletion 对象（含 message、usage 等）
  private async callOpenAIStream(): Promise<OpenAI.ChatCompletion> {
    return withRetry(async (signal) => {
      // 创建流式请求
      const stream = await this.openaiClient!.chat.completions.create({
        model: this.model,
        max_tokens: 16384,
        tools: toOpenAITools(getActiveToolDefinitions(this.tools)),
        messages: this.openaiMessages,
        stream: true,                            // 启用流式
        stream_options: { include_usage: true }, // 最后一个 chunk 包含 usage
      }, { signal });

      // Accumulate the streamed response
      // 累积流式响应
      let content = "";
      let firstText = true;
      // 工具调用按索引累积（索引 → { id, name, arguments }）
      const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
      let finishReason = "";
      let usage: OpenAI.CompletionUsage | undefined;

      // 逐块处理流式响应
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;

        // Usage comes in the final chunk (no delta). Keep prompt_tokens_details
        // (its cached_tokens is the auto-cached portion) so cost accounting can
        // split it out — mirrors the Python path.
        // Usage 在最后一个 chunk 中到达（无 delta）。保留 prompt_tokens_details
        //（其 cached_tokens 是自动缓存部分）以便成本核算拆分 —— 与 Python 路径一致。
        if (chunk.usage) {
          usage = chunk.usage;
        }

        if (!delta) continue;

        // Stream text content
        // 流式输出文本内容
        if (delta.content) {
          if (firstText) { stopSpinner(); this.emitText("\n"); firstText = false; }
          this.emitText(delta.content);
          content += delta.content;
        }

        // Accumulate tool calls (arguments arrive in chunks)
        // 累积工具调用（arguments 分块到达）
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = toolCalls.get(tc.index);
            if (existing) {
              // 已有该索引的工具调用：追加 arguments 片段
              if (tc.function?.arguments) existing.arguments += tc.function.arguments;
            } else {
              // 新工具调用：记录 id、name、初始 arguments
              toolCalls.set(tc.index, {
                id: tc.id || "",
                name: tc.function?.name || "",
                arguments: tc.function?.arguments || "",
              });
            }
          }
        }

        // 记录结束原因
        if (chunk.choices[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
        }
      }

      // Reconstruct ChatCompletion from streamed chunks
      // 从流式块重建 ChatCompletion 对象
      // 按索引排序组装工具调用
      const assembledToolCalls = toolCalls.size > 0
        ? Array.from(toolCalls.entries())
            .sort(([a], [b]) => a - b)           // 按索引升序排序
            .map(([idx, tc]) => ({
              id: tc.id,
              type: "function" as const,
              function: { name: tc.name, arguments: tc.arguments },
            }))
        : undefined;

      // 构建完整的 ChatCompletion 响应对象
      return {
        id: "stream",
        object: "chat.completion",
        created: Date.now(),
        model: this.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant" as const,
              content: content || null,
              tool_calls: assembledToolCalls,
              refusal: null,
            },
            finish_reason: finishReason || "stop",
            logprobs: null,
          },
        ],
        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      } as OpenAI.ChatCompletion;
    }, this.abortController?.signal);
  }

  // ─── Shared ──────────────────────────────────────────────────
  // 共享方法（两个后端都用）

  // 确认危险操作：弹出确认提示，等待用户 y/n 输入
  // command：要确认的命令/路径描述
  // 返回：true=用户允许，false=用户拒绝
  private async confirmDangerous(command: string): Promise<boolean> {
    // 打印确认提示（高亮显示命令）
    printConfirmation(command);
    // Use external confirmFn if provided (REPL mode passes one that reuses
    // the existing readline, avoiding the classic Node.js bug where a second
    // readline.createInterface on the same stdin kills the first one on close).
    // 如果提供了外部 confirmFn 则使用它（REPL 模式传入一个复用现有 readline 的函数，
    // 避免经典 Node.js bug：在同一个 stdin 上创建第二个 readline 接口会在关闭时杀死第一个）。
    if (this.confirmFn) {
      return this.confirmFn(command);
    }
    // Fallback for one-shot / non-REPL usage: create a temporary readline
    // 兜底：一次性/非 REPL 使用时创建临时 readline 接口
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    return new Promise((resolve) => {
      rl.question("  Allow? (y/n): ", (answer) => {
        rl.close();
        // 以 y/Y 开头的回答视为允许
        resolve(answer.toLowerCase().startsWith("y"));
      });
    });
  }
}
