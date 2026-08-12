import chalk from "chalk";
// 引入 chalk 库，用于在终端中输出彩色文本（终端着色工具）

/**
 * 打印欢迎信息
 * 在程序启动时显示标题横幅，以及可用的斜杠命令列表。
 */
export function printWelcome() {
  console.log(
    chalk.bold.cyan("\n  Mini Claude Code") +
      chalk.gray(" — A minimal coding agent\n")
  );
  console.log(chalk.gray("  Type your request, or 'exit' to quit."));
  console.log(chalk.gray("  Commands: /clear /plan /cost /compact /memory /skills\n"));
}

/**
 * 打印用户输入提示符
 * 在终端中显示一个绿色的 "> " 提示符，等待用户输入。
 */
export function printUserPrompt() {
  process.stdout.write(chalk.bold.green("\n> "));
}

/**
 * 打印助手（AI）返回的文本内容
 * @param text - 助手生成的文本，直接写入标准输出
 */
export function printAssistantText(text: string) {
  process.stdout.write(text);
}

/**
 * 打印工具调用信息（工具名称、图标和参数摘要）
 * @param name - 工具名称，例如 read_file、edit_file
 * @param input - 工具的输入参数对象
 */
export function printToolCall(name: string, input: Record<string, any>) {
  const icon = getToolIcon(name); // 根据工具名获取对应的图标
  const summary = getToolSummary(name, input); // 根据工具名和参数生成简短摘要
  console.log(chalk.yellow(`\n  ${icon} ${name}`) + chalk.gray(` ${summary}`));
}

/**
 * 打印工具执行结果
 * 对文件编辑/写入类结果进行特殊的彩色 diff 显示；其他结果做截断后以暗色输出。
 * @param name - 工具名称
 * @param result - 工具返回的结果字符串
 */
export function printToolResult(name: string, result: string) {
  // Edit/write results get special colorized display
  // 对编辑/写入类工具的结果使用特殊的高亮显示
  if ((name === "edit_file" || name === "write_file") && !result.startsWith("Error")) {
    printFileChangeResult(name, result);
    return;
  }
  // 其他类型结果的最大显示长度（超过则截断）
  const maxLen = 500;
  const truncated =
    result.length > maxLen
      ? result.slice(0, maxLen) + chalk.gray(`\n  ... (${result.length} chars total)`)
      : result;
  // 为每一行添加两空格缩进，并用暗色（dim）显示
  const lines = truncated.split("\n").map((l) => "  " + l);
  console.log(chalk.dim(lines.join("\n")));
}

/**
 * 打印文件变更结果（带 diff 着色）
 * 第一行是成功提示信息，后续行是文件内容预览或差异对比（diff）。
 * @param name - 工具名称
 * @param result - 工具返回的结果字符串
 */
function printFileChangeResult(name: string, result: string) {
  const lines = result.split("\n");
  // First line is the success message
  // 第一行是操作成功的提示信息
  console.log(chalk.dim("  " + lines[0]));

  // Rest is content preview or diff
  // 其余部分是文件内容预览或 diff 内容
  const maxDisplayLines = 40;
  const contentLines = lines.slice(1);
  const displayLines = contentLines.slice(0, maxDisplayLines);

  for (const line of displayLines) {
    if (!line.trim()) continue;
    if (line.startsWith("@@")) {
      // Diff header
      // diff 的块头部（如 @@ -1,3 +1,4 @@），用青色显示
      console.log(chalk.cyan("  " + line));
    } else if (line.startsWith("- ")) {
      // Removed line
      // 被删除的行，用红色显示
      console.log(chalk.red("  " + line));
    } else if (line.startsWith("+ ")) {
      // Added line
      // 新增的行，用绿色显示
      console.log(chalk.green("  " + line));
    } else {
      // File content preview (line numbers)
      // 文件内容预览（带行号），用暗色显示
      console.log(chalk.dim("  " + line));
    }
  }
  if (contentLines.length > maxDisplayLines) {
    // 如果内容行数超过最大显示行数，提示剩余行数
    console.log(chalk.gray(`  ... (${contentLines.length - maxDisplayLines} more lines)`));
  }
}

/**
 * 打印错误信息（红色）
 * @param msg - 错误消息内容
 */
export function printError(msg: string) {
  console.error(chalk.red(`\n  Error: ${msg}`));
}

/**
 * 打印危险命令确认提示
 * 当检测到潜在危险的 shell 命令时，向用户展示警告。
 * @param command - 待确认的命令字符串
 */
export function printConfirmation(command: string): void {
  console.log(
    chalk.yellow("\n  ⚠ Dangerous command: ") + chalk.white(command)
  );
}

/**
 * 打印分隔线
 * 用于在输出中视觉上分隔不同区块。
 */
export function printDivider() {
  console.log(chalk.gray("\n  " + "─".repeat(50)));
}

/**
 * 打印本次会话的 token 用量和费用估算
 * 按照 Claude API 的计费规则估算总费用。
 * @param inputTokens - 输入 token 数
 * @param outputTokens - 输出 token 数
 * @param cacheRead - 缓存读取的 token 数（默认 0）
 * @param cacheCreation - 缓存创建的 token 数（默认 0）
 */
export function printCost(inputTokens: number, outputTokens: number, cacheRead = 0, cacheCreation = 0) {
  // Cache read is billed 0.1x, cache write 1.25x (see agent getCurrentCostUsd).
  // 缓存读取按 0.1 倍计费，缓存写入按 1.25 倍计费（详见 agent 的 getCurrentCostUsd）
  const total =
    (inputTokens / 1_000_000) * 3 +
    (cacheRead / 1_000_000) * 0.3 +
    (cacheCreation / 1_000_000) * 3.75 +
    (outputTokens / 1_000_000) * 15;
  const cacheStr = cacheRead ? `, ${cacheRead} cached` : "";
  console.log(
    chalk.gray(
      `\n  Tokens: ${inputTokens} in / ${outputTokens} out${cacheStr} (~$${total.toFixed(4)})`
    )
  );
}

/**
 * 打印重试提示信息
 * 当 API 调用失败需要重试时，向用户展示当前重试次数与原因。
 * @param attempt - 当前重试次数（第几次）
 * @param max - 最大重试次数
 * @param reason - 触发重试的原因
 */
export function printRetry(attempt: number, max: number, reason: string) {
  console.log(
    chalk.yellow(`\n  ↻ Retry ${attempt}/${max}: ${reason}`)
  );
}

/**
 * 打印普通提示信息（青色）
 * @param msg - 要显示的提示文本
 */
export function printInfo(msg: string) {
  console.log(chalk.cyan(`\n  ℹ ${msg}`));
}

// ─── Spinner for API calls ──────────────────────────────────
// ─── API 调用时使用的旋转加载动画 ──────────────────────────

// 旋转动画的帧序列（使用 Braille 盲文字符实现旋转效果）
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

let spinnerTimer: ReturnType<typeof setInterval> | null = null; // 旋转动画的定时器句柄
let spinnerFrame = 0; // 当前显示的帧索引

/**
 * 启动旋转加载动画
 * 在等待 API 响应时显示一个旋转动画和提示文字。
 * @param label - 动画旁显示的标签文字，默认为 "Thinking"
 */
export function startSpinner(label = "Thinking") {
  if (spinnerTimer) return; // already running
  // 如果动画已经在运行，则直接返回，避免重复启动
  spinnerFrame = 0;
  process.stdout.write(chalk.gray(`\n  ${SPINNER_FRAMES[0]} ${label}...`));
  spinnerTimer = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
    // Move cursor to start of line, clear, rewrite
    // 将光标移到行首，清空当前行后重新写入新的动画帧
    process.stdout.write(`\r${chalk.gray(`  ${SPINNER_FRAMES[spinnerFrame]} ${label}...`)}`);
  }, 80); // 每 80 毫秒刷新一帧
}

/**
 * 停止旋转加载动画
 * 清除定时器并擦除当前行的动画内容。
 */
export function stopSpinner() {
  if (spinnerTimer) {
    clearInterval(spinnerTimer); // 清除定时器
    spinnerTimer = null;
    // Clear the spinner line
    // 使用 ANSI 转义序列 \x1b[K 清除当前行
    process.stdout.write("\r\x1b[K");
  }
}

// ─── Plan approval display ──────────────────────────────────
// ─── 计划审批显示 ──────────────────────────────────────────

/**
 * 打印待审批的计划内容
 * 在 plan 模式下，将 AI 生成的计划展示给用户审批。
 * @param planContent - 计划的完整文本内容
 */
export function printPlanForApproval(planContent: string) {
  console.log(chalk.cyan("\n  ━━━ Plan for Approval ━━━"));
  const lines = planContent.split("\n");
  const maxLines = 60; // 最多显示 60 行
  const display = lines.slice(0, maxLines);
  for (const line of display) {
    console.log(chalk.white("  " + line));
  }
  if (lines.length > maxLines) {
    // 计划过长时提示剩余行数
    console.log(chalk.gray(`  ... (${lines.length - maxLines} more lines)`));
  }
  console.log(chalk.cyan("  ━━━━━━━━━━━━━━━━━━━━━━━━\n"));
}

/**
 * 打印计划审批的可选项
 * 向用户列出审批计划时可以选择的操作（清空上下文执行、保留上下文执行等）。
 */
export function printPlanApprovalOptions() {
  console.log(chalk.yellow("  Choose an option:"));
  console.log(chalk.white("    1) Yes, clear context and execute") + chalk.gray(" — fresh start with auto-accept edits"));
  console.log(chalk.white("    2) Yes, and execute") + chalk.gray(" — keep context, auto-accept edits"));
  console.log(chalk.white("    3) Yes, manually approve edits") + chalk.gray(" — keep context, confirm each edit"));
  console.log(chalk.white("    4) No, keep planning") + chalk.gray(" — provide feedback to revise"));
}

// ─── Sub-agent display ──────────────────────────────────────
// ─── 子代理（Sub-agent）显示 ──────────────────────────────

/**
 * 打印子代理启动信息
 * @param type - 子代理类型（例如 general、research 等）
 * @param description - 子代理任务的描述
 */
export function printSubAgentStart(type: string, description: string) {
  console.log(
    chalk.magenta(`\n  ┌─ Sub-agent [${type}]: ${description}`)
  );
}

/**
 * 打印子代理完成信息
 * @param type - 子代理类型
 * @param description - 子代理任务的描述
 */
export function printSubAgentEnd(type: string, description: string) {
  console.log(
    chalk.magenta(`  └─ Sub-agent [${type}] completed`)
  );
}

// ─── Tool icons and summaries ───────────────────────────────
// ─── 工具图标与摘要生成 ───────────────────────────────────

/**
 * 根据工具名称返回对应的 emoji 图标
 * @param name - 工具名称
 * @returns 对应的图标字符串；未匹配时返回默认的 "🔨"
 */
function getToolIcon(name: string): string {
  // 工具名到图标的映射表
  const icons: Record<string, string> = {
    read_file: "📖", // 读取文件
    write_file: "✏️", // 写入文件
    edit_file: "🔧", // 编辑文件
    list_files: "📁", // 列出文件
    grep_search: "🔍", // 搜索内容
    run_shell: "💻", // 执行 shell 命令
    skill: "⚡", // 调用技能
    agent: "🤖", // 调用子代理
  };
  return icons[name] || "🔨"; // 未匹配时返回默认图标
}

/**
 * 根据工具名称和输入参数生成简短摘要
 * 不同工具提取不同的关键字段作为摘要展示。
 * @param name - 工具名称
 * @param input - 工具输入参数
 * @returns 人类可读的摘要字符串
 */
function getToolSummary(name: string, input: Record<string, any>): string {
  switch (name) {
    case "read_file":
      return input.file_path; // 读取文件：显示文件路径
    case "write_file":
      return input.file_path; // 写入文件：显示文件路径
    case "edit_file":
      return input.file_path; // 编辑文件：显示文件路径
    case "list_files":
      return input.pattern; // 列出文件：显示匹配模式
    case "grep_search":
      return `"${input.pattern}" in ${input.path || "."}`; // 搜索：显示搜索内容和路径
    case "run_shell":
      // 执行命令：超过 60 字符则截断并加省略号
      return input.command.length > 60
        ? input.command.slice(0, 60) + "..."
        : input.command;
    case "skill":
      return input.skill_name; // 调用技能：显示技能名称
    case "agent":
      return `[${input.type || "general"}] ${input.description || ""}`; // 子代理：显示类型和描述
    default:
      return ""; // 未知工具：返回空字符串
  }
}
