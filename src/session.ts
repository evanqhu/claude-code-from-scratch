// 文件系统操作：读取文件、写入文件、判断存在性、创建目录、读取目录
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
// 路径操作：拼接路径
import { join } from "path";
// 操作系统模块：获取用户家目录
import { homedir } from "os";

// 会话文件存储目录：~/.mini-claude/sessions/
const SESSION_DIR = join(homedir(), ".mini-claude", "sessions");

/**
 * 会话元数据接口：描述一个会话的基本信息。
 */
interface SessionMetadata {
  // 会话唯一标识符
  id: string;
  // 使用的模型名称
  model: string;
  // 会话启动时的工作目录
  cwd: string;
  // 会话启动时间（ISO 字符串）
  startTime: string;
  // 消息数量
  messageCount: number;
}

/**
 * 会话数据接口：包含元数据和对话消息历史。
 */
interface SessionData {
  // 会话元数据
  metadata: SessionMetadata;
  // Anthropic 格式的消息数组（可选）
  anthropicMessages?: any[];
  // OpenAI 格式的消息数组（可选）
  openaiMessages?: any[];
}

/**
 * 确保会话存储目录存在，不存在则递归创建。
 */
function ensureDir() {
  if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
}

/**
 * 保存会话数据到 JSON 文件。
 * @param id - 会话唯一标识符
 * @param data - 会话数据（包含元数据和消息历史）
 */
export function saveSession(
  id: string,
  data: Omit<SessionData, "metadata"> & { metadata: SessionMetadata }
): void {
  // 确保目录存在
  ensureDir();
  // 将会话数据以 JSON 格式写入 {id}.json 文件（缩进 2 空格）
  writeFileSync(join(SESSION_DIR, `${id}.json`), JSON.stringify(data, null, 2));
}

/**
 * 根据会话 ID 加载会话数据。
 * @param id - 会话唯一标识符
 * @returns 会话数据对象；若文件不存在或解析失败则返回 null
 */
export function loadSession(id: string): SessionData | null {
  // 构造会话文件路径
  const file = join(SESSION_DIR, `${id}.json`);
  // 文件不存在返回 null
  if (!existsSync(file)) return null;
  try {
    // 读取并解析 JSON 文件
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    // 解析失败返回 null
    return null;
  }
}

/**
 * 列出所有已保存的会话元数据。
 * @returns 会话元数据数组；读取/解析失败的会话会被跳过
 */
export function listSessions(): SessionMetadata[] {
  // 确保目录存在
  ensureDir();
  // 读取目录下所有 .json 文件
  const files = readdirSync(SESSION_DIR).filter((f) => f.endsWith(".json"));
  return files
    .map((f) => {
      try {
        // 读取并解析每个会话文件，提取其元数据
        const data = JSON.parse(readFileSync(join(SESSION_DIR, f), "utf-8"));
        return data.metadata as SessionMetadata;
      } catch {
        // 解析失败的文件返回 null（后续会被过滤掉）
        return null;
      }
    })
    // 过滤掉解析失败的 null 值，并进行类型断言
    .filter(Boolean) as SessionMetadata[];
}

/**
 * 获取最近一次会话的 ID。
 * 通过比较所有会话的启动时间，返回时间最新的会话 ID。
 * @returns 最近会话的 ID；若没有任何会话则返回 null
 */
export function getLatestSessionId(): string | null {
  // 获取所有会话列表
  const sessions = listSessions();
  // 没有会话则返回 null
  if (sessions.length === 0) return null;
  // 按启动时间降序排序（最新的在前）
  sessions.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
  // 返回最新会话的 ID
  return sessions[0].id;
}
