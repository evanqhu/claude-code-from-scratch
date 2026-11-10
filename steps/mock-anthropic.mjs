// A local server that speaks the real Anthropic Messages API (POST /v1/messages,
// both blocking and SSE streaming) and replays a *scripted* scenario. The agent
// code is unmodified — only ANTHROPIC_BASE_URL points here — so there is no test
// branch in the teaching code.
// 一个本地 HTTP 服务器，讲真实的 Anthropic Messages API（POST /v1/messages，
// 同时支持阻塞和 SSE 流式两种返回方式），按*预设脚本*回放一个场景。Agent 代码
// 完全不被修改——只是把 ANTHROPIC_BASE_URL 环境变量指到这里——因此教学代码里
// 没有任何专门为测试而写的分支。
//
// Which scripted turn to return is derived from the request itself: the number
// of assistant messages already in `messages` is the index of the next turn.
// That is stateless and matches however the client replays history.
// 该返回脚本里的哪一轮，是从请求本身推导出来的：`messages` 里已有的 assistant
// 消息数量，就是"下一轮"的索引。这是无状态的——无论客户端如何回放历史（比如
// 多轮 tool_use / 摘要压缩后重新提交），都能对上正确的轮次。
//
// A scenario is { id, turns: [ turn, ... ] } where a turn is:
//   { "tools": [ { "name": "...", "input": {...} } ], "text": "optional preamble" }  -> stop_reason tool_use
//   { "text": "..." }                                                                 -> stop_reason end_turn
//   optional per-turn { "usage": { "input_tokens": N, "output_tokens": M } }
// 一个场景（scenario）的结构是 { id, turns: [ turn, ... ] }，其中每一轮（turn）是：
//   { "tools": [ { "name": "...", "input": {...} } ], "text": "可选的开场白" }  -> 返回 stop_reason = tool_use
//   { "text": "..." }                                                             -> 返回 stop_reason = end_turn
//   每一轮还可以可选地带 { "usage": { "input_tokens": N, "output_tokens": M } } 指定 token 用量
//
// Every request is appended to MOCK_LOG (JSONL) as an event the tests assert on.
// 每个请求都会追加写入日志文件（JSONL 格式，即传入的 logPath），作为测试要断言的日志事件。

import { createServer } from "http";
// Node 内置 http 模块，用来起一个本地服务器
import { appendFileSync } from "fs";
// 同步追加写文件，用来把每次请求/响应记成 JSONL 日志

// 把一个脚本轮次（turn）转换成一条完整的 assistant 消息：
// 组装 content 数组（可选的 text 开头 + 若干 tool_use 块）、stop_reason、usage。
function messageFromTurn(turn, model, reqIndex) {
  const content = [];
  if (turn.text && (turn.tools?.length)) content.push({ type: "text", text: turn.text });
  else if (turn.text) content.push({ type: "text", text: turn.text });
  (turn.tools || []).forEach((t, j) => {
    // 给每个工具调用生成一个稳定的假 id（带请求序号和位置），Agent 回传 tool_result 时要用它对应上
    content.push({ type: "tool_use", id: `toolu_mock_${reqIndex}_${j}`, name: t.name, input: t.input ?? {} });
  });
  // 有 tools 就表示"模型想调工具"（stop_reason=tool_use），否则就是正常结束（end_turn）
  const stop_reason = turn.tools?.length ? "tool_use" : "end_turn";
  const usage = turn.usage || { input_tokens: 100, output_tokens: 20 };
  return { id: `msg_mock_${reqIndex}`, type: "message", role: "assistant", model, content, stop_reason, stop_sequence: null, usage };
}

// 阻塞式返回：把整条消息 JSON 序列化后一次性写出。用于 body.stream 为 false 的请求。
function writeBlocking(res, msg) {
  const body = JSON.stringify(msg);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(body);
}

// 写一条 SSE 事件：`event: <事件名>\ndata: <JSON>\n\n`。这是流式传输的基本单元。
function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// 流式返回：把一条消息按 Anthropic 的 SSE 事件序列逐步写出。
// 完整序列：message_start → content_block_start → content_block_delta* → content_block_stop
//          → message_delta → message_stop
async function writeStreaming(res, msg) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  // 先发 message_start：宣告一条消息开始，content 为空、stop_reason 尚未确定
  sse(res, "message_start", { type: "message_start", message: { ...msg, content: [], stop_reason: null, usage: { ...msg.usage, output_tokens: 0 } } });
  msg.content.forEach((block, i) => {
    if (block.type === "text") {
      // 文本块：开始 → 分成若干 delta 逐段推送 → 结束
      sse(res, "content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
      // Split text into a few chunks so streaming is observably chunked.
      // 把文本切成若干小段，让"边生成边输出"的效果可以被肉眼观察到（而不是一次性全来）
      const chunks = block.text.match(/.{1,24}(\s|$)|.+$/g) || [block.text];
      for (const c of chunks) sse(res, "content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: c } });
      sse(res, "content_block_stop", { type: "content_block_stop", index: i });
    } else {
      // tool_use 块：开始 → 把 input 作为 input_json_delta 一次推完 → 结束
      sse(res, "content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
      sse(res, "content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
      sse(res, "content_block_stop", { type: "content_block_stop", index: i });
    }
  });
  // 最后发 message_delta（带最终的 stop_reason 和 token 用量）和 message_stop 收尾
  sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: { output_tokens: msg.usage.output_tokens } });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

// Start the mock. Returns { url, close, port }.
// A scenario is either flat ({turns}) — one "main" track — or multi-track
// ({tracks: {main: {turns}, compact: {match, turns}, ...}}). Each request is
// routed to a track by a substring its `match` finds in the system prompt (so an
// aux call like compaction can be told apart from the main loop); "main" is the
// fallback. Each track has its own request counter, so aux calls don't disturb
// the main loop's turn index.
// 启动 mock 服务器，返回 { url, close, port }。
// 一个场景要么是扁平的（{turns}）——只有一条 "main" 轨；要么是多轨的
// （{tracks: {main: {turns}, compact: {match, turns}, ...}}）。每个请求通过它的
// `match` 子串在 system prompt 中匹配来路由到某条轨（这样像"摘要压缩"之类的辅助调用
// 就能和主循环区分开）；"main" 是兜底轨。每条轨有自己独立的请求计数器，因此辅助调用
// 不会打乱主循环的轮次索引。
export function startMock({ scenario, logPath } = {}) {
  // 没有显式 tracks 时，把扁平的 turns 包成一条 "main" 轨
  const tracks = scenario?.tracks || { main: { turns: scenario?.turns || [] } };
  // 每条轨各自的请求计数器（记录该轨已经回放到了第几轮）
  const counters = {};
  // 全局请求序号，用来生成稳定的消息/工具 id
  let reqIndex = 0;

  const server = createServer((req, res) => {
    // 只接受 POST /v1/messages，其余一律 404
    if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) {
      res.writeHead(404); res.end("not found"); return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      let body;
      try { body = JSON.parse(raw); } catch { res.writeHead(400); res.end("bad json"); return; }

      // 把 system 统一成字符串（可能是 string，也可能是 content block 数组），用于 track 匹配
      const system = typeof body.system === "string" ? body.system : (Array.isArray(body.system) ? body.system.map((b) => b.text).join("") : "");
      // 取出第一条 user 消息的文本，用于 firstUserContains 匹配
      const firstUserText = (() => { const m = (body.messages || []).find((x) => x.role === "user"); return typeof m?.content === "string" ? m.content : ""; })();
      // 本次请求声明的所有工具名，用于 toolsInclude 匹配
      const toolNames = (body.tools || []).map((t) => t.name);
      // Route to an aux track by a structured match (system substring + optional
      // firstUser / tools). Check ALL tracks, not first-hit, and fail loudly on
      // ambiguity — a request must never match two tracks (that's a scenario bug,
      // or a track marker string that collided with the main system prompt).
      // 通过结构化匹配（system 子串 + 可选的第一条用户文本 / 工具名）把请求路由到某条辅助轨。
      // 检查所有轨而非命中即止，并且在歧义时大声报错——一个请求绝不允许同时匹配两条轨
      //（那要么是场景脚本写错了，要么是某条轨的标记字符串和主 system prompt 撞了）。
      const matches = (t) =>
        (!t.match || system.includes(t.match)) &&
        (!t.firstUserContains || firstUserText.includes(t.firstUserContains)) &&
        (!t.toolsInclude || t.toolsInclude.every((n) => toolNames.includes(n)));
      const hits = Object.entries(tracks).filter(([name, t]) => name !== "main" && t.match && matches(t));
      let track = "main";
      if (hits.length > 1) {
        // 匹配到多条轨：属于场景配置错误，直接 500 并写日志，绝不静默选一条
        const err = { type: "error", error: { type: "mock_ambiguous_route", message: `request matched multiple tracks: ${hits.map(([n]) => n).join(", ")}` } };
        if (logPath) appendFileSync(logPath, JSON.stringify({ type: "ambiguous", req: reqIndex, tracks: hits.map(([n]) => n), system }) + "\n");
        res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify(err)); return;
      }
      if (hits.length === 1) track = hits[0][0];
      // 该轨当前应回放第几轮（首次请求是第 0 轮）
      const turnIndex = counters[track] || 0;
      const turn = (tracks[track]?.turns || [])[turnIndex];

      // tool_result blocks the agent sent back — proof the tool actually ran,
      // with its real output (a broken tool shows up here as wrong content).
      // 收集 Agent 回传的 tool_result 块——这是"工具真的执行了、带着真实输出"的证据
      //（如果某个工具实现坏了，这里就会显示错误的内容）。
      const toolResults = [];
      for (const m of body.messages || []) {
        if (Array.isArray(m.content)) for (const b of m.content) {
          if (b.type === "tool_result") toolResults.push({ tool_use_id: b.tool_use_id, content: typeof b.content === "string" ? b.content : JSON.stringify(b.content) });
        }
      }
      if (logPath) {
        // 记录一条 request 事件，包含所有测试可能要断言的信息
        appendFileSync(logPath, JSON.stringify({
          type: "request",
          req: reqIndex,
          track,
          turnIndex,
          system,
          tools: toolNames,
          toolResults,
          messageCount: (body.messages || []).length,
          firstUserText,
          stream: !!body.stream,
        }) + "\n");
      }

      // Queue exhausted: fail loudly. A false green is worse than a red test.
      // 脚本队列已耗尽：大声失败。一个"假绿灯"比一个"红测试"更糟（宁可报错也不能假装通过）。
      if (!turn) {
        const err = { type: "error", error: { type: "mock_exhausted", message: `mock track "${track}" has no turn ${turnIndex}` } };
        if (logPath) appendFileSync(logPath, JSON.stringify({ type: "exhausted", req: reqIndex, track, turnIndex }) + "\n");
        res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify(err)); return;
      }
      // 推进该轨的计数器（下次请求回放下一轮）
      counters[track] = turnIndex + 1;

      // 把脚本轮次转成 assistant 消息，记录 response 事件，然后按需流式或阻塞返回
      const msg = messageFromTurn(turn, body.model || "mock", reqIndex);
      if (logPath) appendFileSync(logPath, JSON.stringify({
        type: "response", req: reqIndex, stop_reason: msg.stop_reason,
        tool_use: msg.content.filter((b) => b.type === "tool_use").map((b) => ({ name: b.name, input: b.input })),
      }) + "\n");
      reqIndex++;

      if (body.stream) await writeStreaming(res, msg);
      else writeBlocking(res, msg);
    });
  });

  // 监听 127.0.0.1 的随机空闲端口（listen(0)），启动完成后 resolve 出 url 和 close
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ url: `http://127.0.0.1:${port}`, port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
