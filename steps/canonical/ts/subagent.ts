// 导入 Anthropic SDK（运行时使用）
import Anthropic from "@anthropic-ai/sdk";
// 导入工具执行函数和工具定义列表（来自本地工具模块）
import { executeTool, toolDefinitions } from "./tools.js";

// Fork a read-only sub-agent to investigate a task in its own fresh context and
// report back a concise summary — divide and conquer without pouring all the
// intermediate steps into the main conversation. It runs its own little loop,
// in-process, and only the summary comes back.
// 派生一个只读子 Agent，在它自己全新的上下文里去调查某个任务，
// 然后返回一段简洁的总结 —— 分而治之，且不会把所有中间步骤灌进主对话。
// 它在进程内运行自己的小循环，最终只把总结结果带回来。

// 子 Agent 允许使用的只读工具集合（只能看，不能改）
const EXPLORE_TOOLS = ["read_file", "list_files", "grep_search"];

//#region subagent
// 子 Agent（subagent）区域标记，供构建工具切片使用

// 运行一个只读探索子 Agent
// task —— 交给子 Agent 的调查任务描述
// client —— Anthropic 客户端实例
// model —— 使用的模型名称
// 返回子 Agent 最终给出的文字总结
export async function runSubAgent(task: string, client: Anthropic, model: string): Promise<string> {
  // 子 Agent 的消息列表，初始只有用户下发的任务
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  // 从全部工具定义中筛选出子 Agent 允许使用的只读工具
  const tools = toolDefinitions.filter((t) => EXPLORE_TOOLS.includes(t.name));

  // 子 Agent 自身的 ReAct 循环：不断调用模型，直到它不再请求工具
  while (true) {
    const reply = await client.messages.create({
      model, max_tokens: 4096,
      system: "You are an explore sub-agent. Investigate read-only and report back a concise summary.",
      tools, messages,
    });
    // 把模型回复加入消息历史
    messages.push({ role: "assistant", content: reply.content });

    // 从回复中筛出所有工具调用块（类型守卫确保类型正确）
    const toolUses = reply.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    // 如果模型没有再请求工具，说明调查完成，返回它的文字总结
    if (toolUses.length === 0) {
      return reply.content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
    }
    // 收集每个工具调用的执行结果
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      // Read-only: a sub-agent can look but not touch.
      // 只读：子 Agent 只能看，不能改。

      // 只有允许的只读工具才真正执行；其他工具一律拒绝，返回拒绝提示
      const output = EXPLORE_TOOLS.includes(tu.name)
        ? await executeTool(tu.name, tu.input as Record<string, any>)
        : `Denied: the sub-agent is read-only.`;
      // 把工具结果封装成 tool_result 块，关联到对应的工具调用 id
      results.push({ type: "tool_result", tool_use_id: tu.id, content: output });
    }
    // 把工具结果作为 user 消息推入历史，供下一轮循环使用
    messages.push({ role: "user", content: results });
  }
}
//#endregion
