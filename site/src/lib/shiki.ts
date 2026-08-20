// Shiki 高亮器单例（精简打包 + 懒加载）。
//
// 设计要点：
//   1. shiki 的核心/语言/主题/引擎全部用动态 import()，让 Vite 把它们拆成独立的
//      懒加载 chunk——首页（无代码）不会加载 shiki，只有渲染代码块/注解时才加载。
//   2. 用 shiki/core（而非完整 shiki），只显式装入 typescript/diff 两个语法，
//      避免 Rollup 把整套 bundledLanguages 注册表都打进来。
//   3. 引擎用轻量 JS 正则引擎（createJavaScriptRegexEngine），免去 oniguruma wasm。
//
// 语言/主题通过 shiki/dist/* 通配导出导入（shiki 的 exports 未开放 ./langs/*）。
import type { HighlighterCore, ThemedToken } from "shiki/core";

const DARK = "github-dark";
const LIGHT = "github-light";

let _hl: Promise<HighlighterCore> | null = null;

export function getHighlighter(): Promise<HighlighterCore> {
  if (!_hl) {
    _hl = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, ts, dff, dark, light] =
        await Promise.all([
          import("shiki/core"),
          import("shiki/engine/javascript"),
          import("shiki/dist/langs/typescript.mjs"),
          import("shiki/dist/langs/diff.mjs"),
          import("shiki/dist/themes/github-dark.mjs"),
          import("shiki/dist/themes/github-light.mjs"),
        ]);
      return createHighlighterCore({
        themes: [dark.default, light.default],
        langs: [ts.default, dff.default],
        engine: createJavaScriptRegexEngine(),
      });
    })();
  }
  return _hl;
}

export interface ColoredToken {
  content: string;
  colorDark?: string;
  colorLight?: string;
}
export type ColoredLine = ColoredToken[];

/** 把一段代码切成逐行 token，每个 token 带深/浅两套颜色（供主题切换）。 */
export async function tokensFor(
  code: string,
  lang: "typescript" | "diff"
): Promise<ColoredLine[]> {
  const hl = await getHighlighter();
  const dark = hl.codeToTokens(code, { lang, theme: DARK }).tokens;
  const light = hl.codeToTokens(code, { lang, theme: LIGHT }).tokens;
  const lines: ColoredLine[] = [];
  for (let i = 0; i < dark.length; i++) {
    const dln = dark[i] || [];
    const lln = light[i] || [];
    const out: ColoredToken[] = [];
    for (let j = 0; j < dln.length; j++) {
      const dt: ThemedToken = dln[j];
      const lt: ThemedToken | undefined = lln[j];
      out.push({
        content: dt.content,
        colorDark: dt.color,
        colorLight: lt?.color,
      });
    }
    lines.push(out);
  }
  return lines;
}
