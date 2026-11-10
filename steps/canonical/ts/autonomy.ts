// 导入 Anthropic SDK 的类型定义（仅作为类型使用）
import type Anthropic from "@anthropic-ai/sdk";

// Autonomy: keep the agent working across many turns without a human at each
// step. /goal attaches a stop condition and an independent evaluator judges,
// after every turn, whether it's met — reinjecting the reason if not. --auto
// replaces the confirmation prompt with a classifier that reads the transcript
// and decides allow/block. Both are one-shot side calls to the model, distinct
// from the main loop (they route to their own mock tracks).
// 自主性（autonomy）：让 Agent 跨越多轮持续工作，而不需要在每一步都等人介入。
// /goal 会附加一个停止条件，由独立的评估器在每一轮之后判断条件是否达成 ——
// 如果没达成，就把原因重新注入到下一轮。
// --auto 则用一个分类器取代确认提示，分类器读取对话记录后决定放行/拦截。
// 这两者都是对模型的一次性旁路调用，与主循环相互独立（各自路由到自己的模拟轨道）。

//#region goal
// 目标（goal）区域标记，供构建工具切片使用

// An independent evaluator judges whether the condition is met. Returns MET, or
// NOT_MET with a reason that gets reinjected into the next turn.
// 独立的评估器判断条件是否已满足。返回 MET（已达成），
// 或返回 NOT_MET 并附带原因，该原因会被重新注入到下一轮对话中。

// 评估目标条件是否达成
// condition —— 目标停止条件描述
// transcript —— 目前为止的对话记录文本
// client —— Anthropic 客户端实例
// model —— 使用的模型名称
// 返回 { met: 是否达成, reason: 原因 }
export async function evaluateGoal(
  condition: string, transcript: string, client: Anthropic, model: string,
): Promise<{ met: boolean; reason: string }> {
  const reply = await client.messages.create({
    model, max_tokens: 256,
    system: "You are a goal evaluator. Given a condition and a transcript, reply exactly 'MET' if the condition is satisfied, otherwise 'NOT_MET: <short reason>'.",
    messages: [{ role: "user", content: `Condition: ${condition}\n\nTranscript so far:\n${transcript}` }],
  });
  // 提取模型的纯文本回复
  const text = reply.content.filter((b) => b.type === "text").map((b: any) => b.text).join("").trim();
  // 以 MET 开头表示已达成
  if (text.startsWith("MET")) return { met: true, reason: "" };
  // 否则未达成，去掉 "NOT_MET:" 前缀后保留原因
  return { met: false, reason: text.replace(/^NOT_MET:?\s*/, "") };
}
//#endregion

//#region classifier
// 分类器（classifier）区域标记，供构建工具切片使用

// A security monitor reads the transcript and decides whether a tool call is
// safe to run without asking the user. Reply ALLOW or BLOCK: <reason>.
// 安全监控器读取对话记录，判断某次工具调用是否可以在不询问用户的情况下安全执行。
// 回复 ALLOW 或 BLOCK: <原因>。

// 对一次工具调用进行安全分类
// toolName —— 工具名称
// input —— 工具输入参数
// transcript —— 目前为止的对话记录文本
// client —— Anthropic 客户端实例
// model —— 使用的模型名称
// 返回 { allow: 是否放行, reason: 原因 }
export async function classifyAction(
  toolName: string, input: unknown, transcript: string, client: Anthropic, model: string,
): Promise<{ allow: boolean; reason: string }> {
  const reply = await client.messages.create({
    model, max_tokens: 256,
    system: "You are a security monitor for an autonomous coding agent. Given the transcript and a tool call, reply exactly 'ALLOW' if it is safe to run unattended, otherwise 'BLOCK: <short reason>'. Err on the side of blocking.",
    messages: [{ role: "user", content: `Transcript:\n${transcript}\n\nTool call: ${toolName}(${JSON.stringify(input)})` }],
  });
  // 提取模型的纯文本回复
  const text = reply.content.filter((b) => b.type === "text").map((b: any) => b.text).join("").trim();
  // 以 ALLOW 开头表示放行
  if (text.startsWith("ALLOW")) return { allow: true, reason: "" };
  // 否则拦截，去掉 "BLOCK:" 前缀后保留原因
  return { allow: false, reason: text.replace(/^BLOCK:?\s*/, "") };
}
//#endregion
