// 导入文件系统操作：同步读、同步写、判断文件是否存在
import { readFileSync, writeFileSync, existsSync } from "fs";
// 导入 join：跨平台地拼接路径
import { join } from "path";

// The session is just the message array on disk. Save after every turn; load it
// back on --resume. No database — the whole conversation is already a plain array.
// 会话本质上就是磁盘上的一个消息数组。每轮对话后保存一次，用 --resume 时再加载回来。
// 不需要数据库——整段对话本身就是一个普通的数组。
const SESSION_FILE = join(process.cwd(), ".mini-session.json");

//#region session
// 保存会话：把消息数组以 JSON 形式写入文件。出错时静默忽略，避免崩溃
export function saveSession(messages: unknown[]): void {
  try { writeFileSync(SESSION_FILE, JSON.stringify(messages, null, 2)); } catch {}
}

// 加载会话：文件不存在则返回 null；读取或解析失败也返回 null
export function loadSession(): unknown[] | null {
  if (!existsSync(SESSION_FILE)) return null;
  try { return JSON.parse(readFileSync(SESSION_FILE, "utf-8")); } catch { return null; }
}
//#endregion
