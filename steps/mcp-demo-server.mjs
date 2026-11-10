#!/usr/bin/env node
// A tiny stdio MCP server used by the ch12 demo/tests (a fixture, like the mock
// model). It speaks line-delimited JSON-RPC over stdin/stdout and offers one
// tool, "add". Any real MCP server the reader plugs in works the same way.
// 一个极简的 stdio MCP 服务器，供第 12 章的 demo/测试使用（和 mock 模型一样，属于测试夹具）。
// 它通过 stdin/stdout 按行收发 JSON-RPC 消息，只提供 "add" 一个工具。
// 读者想换成任意真实 MCP 服务器，接入方式都是一样的。
import { createInterface } from "readline";

const rl = createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

rl.on("line", (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "demo", version: "1.0" } } });
  } else if (method === "notifications/initialized") {
    // notification: no response
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: [{
      name: "add",
      description: "Add two numbers and return the sum.",
      inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
    }] } });
  } else if (method === "tools/call") {
    if (params?.name === "add") {
      const sum = (params.arguments?.a ?? 0) + (params.arguments?.b ?? 0);
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(sum) }] } });
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool ${params?.name}` } });
    }
  }
});
