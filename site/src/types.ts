// 站点数据模型类型（对应 build-data.mjs 产出的 data.json）

export interface AnnotationUnit {
  /** 该单元首行行号（1-based） */
  lineNo: number;
  /** 该单元的源码行（原文，含缩进） */
  code: string[];
  /** 紧贴上方的注释（已剥离 // 等前导符）；无注释则为空串 */
  comment: string;
}

export interface ChapterFile {
  name: string;
  /** 本章结束时该文件的完整快照（标记已剥离） */
  fullSource: string;
  /** 本章相比上一章的 diff（git diff --no-index，剥头与标记） */
  diff: string;
  /** 逐行注解单元 */
  annotations: AnnotationUnit[];
  /** 对应的生产版源码路径，如 src/agent.ts */
  srcRef: string;
}

export interface Transcript {
  command: string;
  output: string;
  caseId: string | null;
}

export interface Chapter {
  id: string;
  number: number;
  slug: string;
  title: string;
  phase: string;
  goals: string;
  runCommand: string | null;
  transcripts: Transcript[];
  /** TS-only 渲染正文（Python 已剥离） */
  bodyMarkdown: string;
  files: ChapterFile[];
}

/** 轻量章节元信息（打包进主 bundle，供侧栏/首页用）。 */
export interface ChapterMeta {
  id: string;
  number: number;
  slug: string;
  title: string;
  phase: string;
  goals: string;
  runCommand: string | null;
  hasCode: boolean;
  fileNames: string[];
}

/** 单章详情（按需懒加载）：正文 + transcripts + 源码文件。 */
export interface ChapterDetail {
  id: string;
  bodyMarkdown: string;
  transcripts: Transcript[];
  files: ChapterFile[];
}

export interface FileMapEntry {
  file: string;
  firstChapter: number;
  firstChapterId: string;
}

export interface SiteMeta {
  generatedAt: string;
  chapters: ChapterMeta[];
  fileMap: FileMapEntry[];
  codeSteps: number[];
}
