// 导入子进程启动方法（用于把 MCP 服务器作为子进程运行）
import { spawn } from "child_process";
// 导入按行读取的接口（用于逐行解析子进程 stdout 输出的 JSON-RPC 消息）
import { createInterface } from "readline";

// A minimal MCP client: spawn the server as a subprocess and speak
// line-delimited JSON-RPC over its stdio — initialize, then discover its tools,
// then call them. Real MCP has more (multiple transports, auth); the stdio
// handshake is the essence, and it's how you plug external tools into the agent
// without changing its code.
// 一个最小化的 MCP 客户端：把服务器作为子进程启动，通过它的标准输入输出
// 以"按行分隔的 JSON-RPC"进行通信 —— 先初始化，再发现它提供的工具，然后调用。
// 真正的 MCP 功能更多（多种传输方式、鉴权等）；stdio 握手是其中最核心的部分，
// 这正是把外部工具接入 Agent 而无需改动 Agent 代码的方式。

// MCP 工具的描述结构：名称、描述、输入参数 schema
export interface McpTool { name: string; description: string; input_schema: unknown; }
// MCP 连接结构：可用的工具列表 + 调用工具的方法 + 关闭连接的方法
export interface McpConnection { tools: McpTool[]; callTool(name: string, args: unknown): Promise<string>; close(): void; }

//#region mcp
// MCP 区域标记，供构建工具切片使用

// 连接一个 MCP 服务器：启动子进程，完成 JSON-RPC 握手，返回可用的工具和调用方法
// command —— 启动服务器的命令（如某个可执行程序）
// args —— 传给命令的参数数组
// 返回一个 McpConnection 对象
export async function connectMcp(command: string, args: string[]): Promise<McpConnection> {
  // 以子进程方式启动 MCP 服务器；stdin/stdout 用管道通信，stderr 直接继承到父进程
  const proc = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
  // 用 readline 逐行读取子进程的标准输出（每行是一个 JSON-RPC 消息）
  const rl = createInterface({ input: proc.stdout! });
  // 自增的请求 id，用于匹配请求与响应
  let nextId = 1;
  // 等待中的请求回调表：id -> resolve 函数
  const pending = new Map<number, (v: any) => void>();
  // 每收到一行就尝试解析为 JSON；若带有 id 且在等待表中，就触发对应的 resolve
  rl.on("line", (line) => {
    try { const msg = JSON.parse(line); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); } } catch {}
  });
  // 发送一个 JSON-RPC 请求并返回 Promise，响应到达时 resolve
  const request = (method: string, params?: unknown) =>
    new Promise<any>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      // 把请求写成 JSON-RPC 格式写入子进程 stdin（末尾加换行符表示一行）
      proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  // 1) 初始化握手：声明协议版本、能力、客户端信息
  await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mini-claude", version: "1.0" } });
  // 2) 发送 initialized 通知（无需响应，所以没有 id）
  proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  // 3) 列出服务器提供的所有工具
  const listed = await request("tools/list");
  // 把服务器返回的工具转换成本地使用的 McpTool 结构（注意 inputSchema -> input_schema 的命名映射）
  const tools: McpTool[] = (listed.result?.tools || []).map((t: any) => ({ name: t.name, description: t.description || "", input_schema: t.inputSchema }));

  // 返回连接对象，包含工具列表、调用工具方法、关闭方法
  return {
    tools,
    // 调用指定工具，返回其文本结果
    async callTool(name, args) {
      const r = await request("tools/call", { name, arguments: args });
      const content = r.result?.content || [];
      // 优先提取文本类型的内容；若没有文本则回退到整体 JSON 序列化
      return content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") || JSON.stringify(r.result ?? r.error);
    },
    // 关闭连接：直接杀掉子进程
    close() { proc.kill(); },
  };
}
//#endregion
