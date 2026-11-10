/**
 * MCP Client — connects to stdio-based MCP servers, discovers and forwards tool calls.
 * MCP 客户端 —— 连接到基于 stdio（标准输入输出）的 MCP 服务器，发现并转发工具调用。
 * Uses raw JSON-RPC over stdio (no SDK dependency for simplicity).
 * 使用原生的 JSON-RPC 通过 stdio 通信（为保持简洁，不依赖任何 SDK）。
 *
 * Config is read from .claude/settings.json and ~/.claude/settings.json:
 * 配置从 .claude/settings.json 和 ~/.claude/settings.json 中读取：
 *   { "mcpServers": { "name": { "command": "...", "args": [...], "env": {...} } } }
 *
 * Each MCP tool is exposed with a "mcp__serverName__toolName" prefix to avoid conflicts.
 * 每个 MCP 工具都会以 "mcp__服务器名__工具名" 的前缀暴露，以避免命名冲突。
 */

import { spawn, type ChildProcess } from "child_process"; // 子进程管理：spawn 用于启动 MCP 服务器进程
import { readFileSync, existsSync } from "fs"; // 文件系统：读取和检查配置文件
import { join } from "path"; // 路径拼接
import { homedir } from "os"; // 获取用户主目录
import { createInterface, type Interface } from "readline"; // 逐行读取子进程的 stdout 输出

// ─── Types ──────────────────────────────────────────────────
// ─── 类型定义 ──────────────────────────────────────────────

// MCP 服务器配置：描述如何启动一个 MCP 服务器子进程
interface McpServerConfig {
  command: string; // 要执行的命令（如 "npx"、"node" 等）
  args?: string[]; // 命令参数列表
  env?: Record<string, string>; // 环境变量（会与 process.env 合并）
}

// MCP 工具信息：描述从服务器发现的单个工具
interface McpToolInfo {
  name: string; // 工具名称
  description?: string; // 工具描述
  inputSchema?: any; // 工具的输入参数 JSON Schema
  serverName: string; // 该工具所属的服务器名称（用于路由调用）
}

// Race a promise against a timeout WITHOUT leaking the timer: a bare
// Promise.race leaves the setTimeout pending after the promise wins,
// which keeps the Node event loop (and thus the process) alive.
// 将 Promise 与超时进行竞速，同时避免定时器泄漏：直接使用 Promise.race 会在
// 原始 Promise 先完成时，留下一个挂起的 setTimeout，这会导致 Node 事件循环
// （进而整个进程）无法正常退出。
// 参数：
//   promise —— 要等待的原始 Promise
//   ms —— 超时时间（毫秒）
// 返回值：原始 Promise 的结果；若超时则 reject 一个 Error
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined; // 定时器引用，用于在 finally 中清除
  try {
    return await Promise.race([
      promise, // 原始 Promise
      new Promise<never>((_, rej) => {
        // 超时 Promise：到时间后 reject
        timer = setTimeout(() => rej(new Error("timeout")), ms);
      }),
    ]);
  } finally {
    // 无论结果如何，都清除定时器，防止事件循环泄漏
    clearTimeout(timer);
  }
}

// ─── Single MCP connection (one per server) ─────────────────
// ─── 单个 MCP 连接（每个服务器一个实例）─────────────────────

// MCP 连接类：管理与单个 MCP 服务器子进程的完整生命周期和通信
class McpConnection {
  private process: ChildProcess | null = null; // 子进程引用
  private nextId = 1; // 下一个 JSON-RPC 请求的递增 ID
  // 待处理的请求映射：id -> { resolve, reject }，用于在收到响应时完成对应的 Promise
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private rl: Interface | null = null; // 逐行读取子进程 stdout 的接口

  // 构造函数：传入服务器名称和配置
  constructor(private serverName: string, private config: McpServerConfig) {}

  /** Spawn the server process and wire up JSON-RPC over stdio. */
  /** 启动服务器子进程，并建立基于 stdio 的 JSON-RPC 通信。 */
  async connect(): Promise<void> {
    // 合并环境变量：进程环境 + 服务器配置中的自定义环境
    const env = { ...process.env, ...(this.config.env || {}) };
    // 启动子进程，三个标准流都使用管道
    this.process = spawn(this.config.command, this.config.args || [], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    // Parse newline-delimited JSON-RPC from stdout
    // 从 stdout 逐行解析换行分隔的 JSON-RPC 消息
    this.rl = createInterface({ input: this.process.stdout! });
    this.rl.on("line", (line: string) => {
      try {
        const msg = JSON.parse(line); // 尝试解析每一行为 JSON
        // 如果该消息有 id 且在待处理映射中，说明是对之前请求的响应
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)!;
          this.pending.delete(msg.id); // 取出后从待处理映射中移除
          if (msg.error) {
            // 服务器返回了错误
            reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
          } else {
            // 成功响应
            resolve(msg.result);
          }
        }
      } catch {
        // ignore non-JSON lines (e.g. server logs)
        // 忽略非 JSON 行（如服务器的日志输出）
      }
    });

    // Surface stderr as warnings (don't crash)
    // 消费 stderr 输出（此处静默处理，不打印，避免干扰，也防止进程崩溃）
    this.process.stderr?.on("data", () => {});

    // 子进程发生错误时（如启动失败）
    this.process.on("error", (err) => {
      console.error(`[mcp:${this.serverName}] process error: ${err.message}`);
    });

    // 子进程退出时：拒绝所有尚未完成的请求
    this.process.on("exit", (code) => {
      // Reject all pending requests
      // 拒绝所有待处理的请求
      for (const [, { reject }] of this.pending) {
        reject(new Error(`MCP server '${this.serverName}' exited with code ${code}`));
      }
      this.pending.clear(); // 清空待处理映射
    });
  }

  /** Send a JSON-RPC request and wait for the response. */
  /** 发送 JSON-RPC 请求并等待响应。返回一个 Promise，在收到对应 id 的响应时完成。 */
  private sendRequest(method: string, params: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      // 检查子进程的 stdin 是否可写
      if (!this.process?.stdin?.writable) {
        return reject(new Error(`MCP server '${this.serverName}' is not connected`));
      }
      const id = this.nextId++; // 分配递增的唯一 id
      this.pending.set(id, { resolve, reject }); // 注册到待处理映射
      // 构造 JSON-RPC 2.0 请求并写入 stdin（以换行结尾）
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      this.process.stdin.write(msg);
    });
  }

  /** Send a JSON-RPC notification (no id, no response expected). */
  /** 发送 JSON-RPC 通知（无 id，不期望收到响应）。 */
  private sendNotification(method: string, params: any = {}): void {
    // 子进程未连接则直接返回
    if (!this.process?.stdin?.writable) return;
    // 通知消息不含 id 字段
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    this.process.stdin.write(msg);
  }

  /** Perform MCP initialize handshake. */
  /** 执行 MCP 初始化握手流程。 */
  async initialize(): Promise<void> {
    // 发送 initialize 请求，声明协议版本和客户端信息
    await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05", // MCP 协议版本
      capabilities: {}, // 客户端能力声明（此处为空）
      clientInfo: { name: "mini-claude", version: "1.0.0" }, // 客户端标识
    });
    // 初始化完成后发送 initialized 通知（通知无需等待响应）
    this.sendNotification("notifications/initialized");
  }

  /** Discover available tools from this server. */
  /** 从该服务器发现可用的工具列表。 */
  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.sendRequest("tools/list");
    // 防御性检查：结果中没有 tools 字段或不是数组则返回空
    if (!result?.tools || !Array.isArray(result.tools)) return [];
    // 将原始工具数据映射为 McpToolInfo 结构，并附带服务器名
    return result.tools.map((t: any) => ({
      name: t.name,
      description: t.description || "",
      inputSchema: t.inputSchema,
      serverName: this.serverName, // 记录来源服务器，便于后续路由
    }));
  }

  /** Call a tool and return the text result. */
  /** 调用指定工具并返回文本结果。 */
  async callTool(name: string, args: any): Promise<string> {
    const result = await this.sendRequest("tools/call", { name, arguments: args });
    // MCP returns { content: [{ type: "text", text: "..." }, ...] }
    // MCP 返回格式为 { content: [{ type: "text", text: "..." }, ...] }
    if (result?.content && Array.isArray(result.content)) {
      // 筛选出文本类型的内容并拼接为单个字符串
      return result.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");
    }
    // 非标准格式则直接序列化为 JSON 字符串
    return JSON.stringify(result);
  }

  /** Kill the server process. */
  /** 关闭并终止服务器子进程，释放资源。 */
  close(): void {
    this.rl?.close(); // 关闭 readline 接口
    this.process?.kill(); // 终止子进程
    this.process = null; // 清除引用
  }
}

// ─── MCP Manager (manages all connections) ──────────────────
// ─── MCP 管理器（管理所有服务器连接）─────────────────────────

// MCP 管理器：统一管理多个 MCP 服务器连接，负责配置加载、连接建立、工具发现和调用路由
export class McpManager {
  private connections = new Map<string, McpConnection>(); // 服务器名称到连接的映射
  private tools: McpToolInfo[] = []; // 所有已发现的工具列表（汇总自各服务器）
  private connected = false; // 是否已完成加载连接（防止重复初始化）

  /**
   * Read settings files, connect to all configured MCP servers,
   * and discover their tools. Safe to call multiple times (no-op after first).
   * 读取配置文件，连接所有已配置的 MCP 服务器，并发现它们的工具。
   * 可安全地多次调用（首次调用后为空操作）。
   */
  async loadAndConnect(): Promise<void> {
    // 幂等检查：已加载过则直接返回
    if (this.connected) return;
    this.connected = true;

    // 加载并合并所有配置文件的 MCP 服务器配置
    const configs = this.loadConfigs();
    // 没有任何配置则直接返回
    if (Object.keys(configs).length === 0) return;

    // 连接和发现工具的超时时间（15 秒）
    const TIMEOUT_MS = 15_000;

    // 逐个连接每个配置的服务器
    for (const [name, config] of Object.entries(configs)) {
      const conn = new McpConnection(name, config);
      try {
        await conn.connect(); // 启动子进程并建立通信
        await withTimeout(conn.initialize(), TIMEOUT_MS); // 执行初始化握手（带超时）
        const serverTools = await withTimeout(conn.listTools(), TIMEOUT_MS); // 发现工具（带超时）
        this.connections.set(name, conn); // 保存连接
        this.tools.push(...serverTools); // 汇总工具到全局列表
        console.error(`[mcp] Connected to '${name}' — ${serverTools.length} tools`); // 输出连接成功日志
      } catch (err: any) {
        // 单个服务器连接失败不影响其他服务器
        console.error(`[mcp] Failed to connect to '${name}': ${err.message}`);
        conn.close(); // 关闭失败的连接，释放资源
      }
    }
  }

  /**
   * Return tool definitions in Anthropic API format, with mcp__server__tool prefix.
   * 返回符合 Anthropic API 格式的工具定义，使用 mcp__服务器__工具 的前缀命名。
   */
  getToolDefinitions(): Array<{ name: string; description: string; input_schema: any }> {
    return this.tools.map((t) => ({
      // 使用前缀命名避免与内置工具命名冲突
      name: `mcp__${t.serverName}__${t.name}`,
      // 描述：优先使用工具自带描述，否则生成默认描述
      description: t.description || `MCP tool ${t.name} from ${t.serverName}`,
      // 输入 schema：优先使用工具自带 schema，否则提供一个空的默认对象 schema
      input_schema: t.inputSchema || { type: "object", properties: {} },
    }));
  }

  /** Check if a tool name is an MCP-prefixed tool. */
  /** 检查工具名是否为 MCP 前缀工具（即以 "mcp__" 开头）。 */
  isMcpTool(name: string): boolean {
    return name.startsWith("mcp__");
  }

  /** Route a prefixed tool call to the correct server. */
  /** 将带前缀的工具调用路由到正确的服务器并执行。 */
  async callTool(prefixedName: string, args: any): Promise<string> {
    // mcp__serverName__toolName → serverName, toolName
    // 拆分前缀名称：mcp__服务器名__工具名 -> [服务器名, 工具名]
    const parts = prefixedName.split("__");
    // 至少要有三段（mcp、服务器名、工具名）
    if (parts.length < 3) throw new Error(`Invalid MCP tool name: ${prefixedName}`);
    const serverName = parts[1]; // 第二段为服务器名
    const toolName = parts.slice(2).join("__"); // tool name might contain __
    // 工具名可能也包含 "__"，因此从第三段开始拼接
    const conn = this.connections.get(serverName); // 查找对应的服务器连接
    if (!conn) throw new Error(`MCP server '${serverName}' not connected`);
    return conn.callTool(toolName, args); // 在对应连接上调用工具
  }

  /** Disconnect all servers. */
  /** 断开所有服务器连接并清空状态。 */
  async disconnectAll(): Promise<void> {
    // 逐个关闭所有连接
    for (const [, conn] of this.connections) {
      conn.close();
    }
    this.connections.clear(); // 清空连接映射
    this.tools = []; // 清空工具列表
    this.connected = false; // 重置连接状态（允许重新加载）
  }

  // ─── Private: config loading ──────────────────────────────
  // ─── 私有方法：配置加载 ────────────────────────────────────

  // 加载并合并所有来源的 MCP 服务器配置
  // 返回值：Record<string, McpServerConfig> —— 服务器名到配置的映射
  private loadConfigs(): Record<string, McpServerConfig> {
    const merged: Record<string, McpServerConfig> = {};

    // 1. Global: ~/.claude/settings.json
    // 1. 全局配置：~/.claude/settings.json（优先级最低，最先加载）
    const globalPath = join(homedir(), ".claude", "settings.json");
    this.mergeConfigFile(globalPath, merged);

    // 2. Project: .claude/settings.json (cwd)
    // 2. 项目配置：.claude/settings.json（基于当前工作目录，优先级更高）
    const projectPath = join(process.cwd(), ".claude", "settings.json");
    this.mergeConfigFile(projectPath, merged);

    // 3. Also check .mcp.json (Claude Code convention)
    // 3. 同时检查 .mcp.json 文件（Claude Code 约定的配置文件）
    const mcpJsonPath = join(process.cwd(), ".mcp.json");
    this.mergeConfigFile(mcpJsonPath, merged);

    return merged;
  }

  // 读取单个配置文件并将其中的服务器配置合并到目标对象
  // 参数：
  //   filePath —— 配置文件路径
  //   target —— 合并目标对象（同名服务器会被后加载的覆盖）
  private mergeConfigFile(filePath: string, target: Record<string, McpServerConfig>): void {
    // 文件不存在则跳过
    if (!existsSync(filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8")); // 解析 JSON
      // 兼容两种格式：{ mcpServers: {...} } 或直接 {...}
      const servers = raw.mcpServers || raw;
      for (const [name, config] of Object.entries(servers)) {
        // 仅合并格式合法的配置
        if (this.isValidConfig(config)) {
          target[name] = config as McpServerConfig;
        }
      }
    } catch {
      // Silently skip malformed config files
      // 静默跳过格式错误的配置文件
    }
  }

  // 校验配置对象是否合法（必须是非空对象且包含字符串类型的 command 字段）
  private isValidConfig(config: any): boolean {
    return config && typeof config === "object" && typeof config.command === "string";
  }
}
