import type { Metadata } from "next";
import type { ReactNode } from "react";
import "../src/styles/index.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://mini-claude.evanqhu.me"),
  title: "Claude Code From Scratch · 源码学习实验室",
  description: "从零构建 Coding Agent 的交互式中文源码课程。逐章理解设计、阅读源码、查看增量并运行验证。",
  openGraph: {
    type: "website",
    title: "Claude Code From Scratch · 源码学习实验室",
    description: "从空循环开始，逐章造出一个会自主工作的 Coding Agent。",
    images: ["/og.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "Claude Code From Scratch · 源码学习实验室",
    description: "理解设计 · 读懂源码 · 运行验证",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
