// 导入 Anthropic SDK 的类型定义（仅作为类型使用，不引入运行时实现）
import type Anthropic from "@anthropic-ai/sdk";

// When the conversation gets long, summarize the older messages into one so the
// context window doesn't overflow. Real agents count tokens; we count messages,
// which is enough to see the mechanism work.
// 当对话变得过长时，把较早的消息汇总成一条摘要，避免上下文窗口溢出。
// 真正的 Agent 会按 token 计数；这里用消息条数来计数，
// 这已经足以演示压缩机制的工作原理。

// 触发压缩的消息条数阈值：超过 6 条就压缩
const COMPACT_THRESHOLD = 6;
// 压缩时保留最近的、不被压缩的消息条数（保留最近的 2 条）
const KEEP_RECENT = 2;

//#region compact
// 压缩（compact）区域标记，供构建工具切片使用

// 压缩函数：在消息过多时，把旧消息总结成一条摘要
// messages —— 当前完整的对话消息列表
// client —— Anthropic 客户端实例，用于发起摘要请求
// model —— 使用的模型名称
// 返回压缩后的新消息列表（或者不满足阈值时原样返回）
export async function maybeCompact(
  messages: Anthropic.MessageParam[],
  client: Anthropic,
  model: string,
): Promise<Anthropic.MessageParam[]> {
  // 如果消息还没超过阈值，无需压缩，直接原样返回
  if (messages.length <= COMPACT_THRESHOLD) return messages;

  // 较早的消息：会被总结成摘要（前半部分）
  const older = messages.slice(0, messages.length - KEEP_RECENT);
  // 最近的消息：原样保留，拼到摘要之后（后半部分）
  const recent = messages.slice(messages.length - KEEP_RECENT);

  // One aux model call: summarize the older messages (rendered as plain text so
  // we never split a tool_use / tool_result pair).
  // 发起一次辅助模型调用：把较早的消息渲染成纯文本后做总结
  // （渲染成纯文本，这样永远不会把 tool_use / tool_result 这一对拆散，
  //  因为拆散会导致模型调用报错）。

  // 把每条消息拼成 "角色: 内容" 的文本形式；内容若不是字符串（即工具调用/结果）则用占位符
  const transcript = older
    .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : "[tool call / result]"}`)
    .join("\n");
  // 向模型请求一段简短的对话总结
  const reply = await client.messages.create({
    model, max_tokens: 1024,
    system: "Summarize the conversation so far in a few sentences, keeping key facts.",
    messages: [{ role: "user", content: transcript }],
  });
  // 从回复中提取纯文本部分作为摘要
  const summary = reply.content.filter((b) => b.type === "text").map((b: any) => b.text).join("");

  console.log(`  (compacted ${older.length} messages into a summary)`);
  // 返回新的消息列表：摘要在前，最近的消息在后
  return [{ role: "user", content: `[Summary of earlier conversation]\n${summary}` }, ...recent];
}
//#endregion
