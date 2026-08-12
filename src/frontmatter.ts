// Shared YAML frontmatter parser for memory and skills files.
// 共享的 YAML frontmatter（前置元数据）解析器，用于记忆文件和技能文件。
// Handles simple `key: value` pairs between `---` delimiters.
// 处理 `---` 分隔符之间的简单 `key: value` 键值对。

/**
 * frontmatter 解析结果。
 */
export interface FrontmatterResult {
  // 元数据键值对集合
  meta: Record<string, string>;
  // 正文内容（去除 frontmatter 后的部分）
  body: string;
}

/**
 * 解析包含 YAML frontmatter 的文本内容。
 * frontmatter 格式为以 `---` 开头和结尾的块，其中包含若干 `key: value` 行。
 * @param content - 原始文本内容
 * @returns 包含 meta（元数据）和 body（正文）的对象
 *
 * 示例输入：
 * ---
 * name: my-skill
 * description: 一个技能
 * ---
 * 这里是正文内容。
 *
 * 解析结果：meta = { name: "my-skill", description: "一个技能" }, body = "这里是正文内容。"
 */
export function parseFrontmatter(content: string): FrontmatterResult {
  // 按行分割文本
  const lines = content.split("\n");
  // 第一行必须是 "---"，否则认为没有 frontmatter，直接返回全部内容为正文
  if (lines[0]?.trim() !== "---") return { meta: {}, body: content };

  // 查找 frontmatter 的结束分隔符 "..."
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") { endIdx = i; break; }
  }
  // 没找到结束分隔符，认为格式无效，返回全部内容为正文
  if (endIdx === -1) return { meta: {}, body: content };

  // 解析 frontmatter 中的每一行键值对
  const meta: Record<string, string> = {};
  for (let i = 1; i < endIdx; i++) {
    // 查找第一个冒号作为键值分隔符
    const colonIdx = lines[i].indexOf(":");
    // 没有冒号的行跳过
    if (colonIdx === -1) continue;
    // 提取键（冒号前的内容，去除空白）
    const key = lines[i].slice(0, colonIdx).trim();
    // 提取值（冒号后的内容，去除空白）
    const value = lines[i].slice(colonIdx + 1).trim();
    // 键非空时存入 meta 对象
    if (key) meta[key] = value;
  }

  // 正文为结束分隔符之后的所有行（去除首尾空白）
  const body = lines.slice(endIdx + 1).join("\n").trim();
  return { meta, body };
}

/**
 * 将元数据和正文格式化为带 frontmatter 的文本。
 * @param meta - 元数据键值对
 * @param body - 正文内容
 * @returns 格式化后的文本（以 `---` 开头，包含 frontmatter 和正文）
 *
 * 示例输出：
 * ---
 * name: my-skill
 * ---
 *
 * 这里是正文内容。
 */
export function formatFrontmatter(meta: Record<string, string>, body: string): string {
  // 从 frontmatter 开始分隔符 "---" 开始
  const lines = ["---"];
  // 遍历所有键值对，每对生成一行 "key: value"
  for (const [key, value] of Object.entries(meta)) {
    lines.push(`${key}: ${value}`);
  }
  // 结束分隔符
  lines.push("---");
  // 空行分隔 frontmatter 和正文
  lines.push("");
  // 追加正文内容
  lines.push(body);
  // 用换行符连接所有行
  return lines.join("\n");
}
