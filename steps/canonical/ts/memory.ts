// 导入文件系统同步读取/判断等方法
import { readdirSync, readFileSync, existsSync } from "fs";
// 导入路径拼接工具
import { join } from "path";

// Cross-session memory: small facts saved as files under .mini-memory/. Before
// each turn we recall the ones relevant to what the user asked and drop them
// into the system prompt. Recall is deterministic keyword overlap — no model
// call, no embeddings — enough to see the mechanism.
// 跨会话记忆：把一些小事实以文件形式保存在 .mini-memory/ 目录下。
// 每轮对话前，我们召回与用户提问相关的内容，并放进系统提示词里。
// 召回采用的是确定性的关键词重叠匹配 —— 不调用模型、不用向量嵌入，
// 这足以演示记忆机制的工作原理。

// 记忆文件存放目录：当前工作目录下的 .mini-memory 文件夹
const MEMORY_DIR = join(process.cwd(), ".mini-memory");

//#region recall
// 召回（recall）区域标记，供构建工具切片使用

// 根据用户输入的查询，召回相关的记忆片段
// query —— 用户本轮的输入文本
// 返回拼好的记忆提示字符串（若没有相关记忆则返回空字符串）
export function recallMemories(query: string): string {
  // 如果记忆目录不存在，说明还没有任何记忆，直接返回空
  if (!existsSync(MEMORY_DIR)) return "";
  // 把查询拆成单词集合（小写、按非单词字符分割），过滤掉长度 <= 2 的短词
  const queryWords = new Set(query.toLowerCase().split(/\W+/).filter((w) => w.length > 2));

  // 用于存放每个记忆文件及其匹配得分
  const scored: { text: string; score: number }[] = [];
  // 遍历 .mini-memory 目录下所有 .md 文件
  for (const file of readdirSync(MEMORY_DIR).filter((f) => f.endsWith(".md"))) {
    // 读取记忆文件的纯文本内容并去除首尾空白
    const text = readFileSync(join(MEMORY_DIR, file), "utf-8").trim();
    // 把记忆文本也拆成单词集合（小写）
    const words = new Set(text.toLowerCase().split(/\W+/));
    // 统计查询词在该记忆文件中出现的个数（即关键词重叠得分）
    let score = 0;
    for (const w of queryWords) if (words.has(w)) score++;
    // 只要有重叠，就加入候选列表
    if (score > 0) scored.push({ text, score });
  }
  // 如果没有任何相关记忆，返回空字符串
  if (scored.length === 0) return "";

  // 按得分从高到低排序，取前 3 条，拼成列表项字符串
  const top = scored.sort((a, b) => b.score - a.score).slice(0, 3).map((s) => `- ${s.text}`).join("\n");
  // 返回格式化的记忆提示块，会追加到系统提示词中
  return `\n\n# Memory (things you remember about the user and project)\n${top}`;
}
//#endregion
