// 导入文件读取和存在性判断方法
import { readFileSync, existsSync } from "fs";
// 导入路径拼接工具
import { join } from "path";

// A skill is a reusable prompt template in .mini-skills/<name>.md. Typing
// "/commit ..." loads it and runs its prompt (with any extra text appended) as
// if you'd typed the whole thing — install-and-use like a shell script.
// 技能（skill）是一个可复用的提示词模板，存放在 .mini-skills/<名称>.md 文件里。
// 输入 "/commit ..." 时会加载对应模板，并把后面附加的文字拼进去，整体当作提示词运行，
// 就像你亲手输入了全部内容一样 —— 类似 shell 脚本的"安装即用"。

// 技能文件存放目录：当前工作目录下的 .mini-skills 文件夹
const SKILLS_DIR = join(process.cwd(), ".mini-skills");

//#region skill
// 技能（skill）区域标记，供构建工具切片使用

// 解析用户输入是否触发了某个技能（以 "/" 开头）
// input —— 用户原始输入
// 返回解析后的完整提示词；若不是技能调用则返回 null
export function resolveSkill(input: string): string | null {
  // 不以 "/" 开头的输入不是技能调用，直接返回 null
  if (!input.startsWith("/")) return null;
  // 去掉 "/" 后按空格拆分：第一段是技能名，其余是附加参数
  const [name, ...rest] = input.slice(1).split(" ");
  // 拼出技能文件路径：.mini-skills/<技能名>.md
  const file = join(SKILLS_DIR, `${name}.md`);
  // 如果该技能文件不存在，返回 null（未匹配到技能）
  if (!existsSync(file)) return null;
  // 读取技能模板内容并去除首尾空白
  const prompt = readFileSync(file, "utf-8").trim();
  // 把附加参数重新拼成字符串
  const args = rest.join(" ").trim();
  // 如果有附加参数，拼到模板后面；否则只返回模板本身
  return args ? `${prompt}\n\n${args}` : prompt;
}
//#endregion
