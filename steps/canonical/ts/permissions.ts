// A tiny permission gate: dangerous shell commands are blocked, everything else
// runs. The real Claude Code has modes (ask / accept-edits / yolo) and layered
// rules; here we keep just the essential idea — check before you run.
// 一个微型的权限网关：危险的 shell 命令会被拦截，其它一律放行。
// 真正的 Claude Code 有多种模式（ask 询问 / accept-edits 接受编辑 / yolo 全自动）
// 以及分层的规则；这里只保留了最核心的思想——执行前先检查。
//#region permissions
// 危险命令的正则黑名单：只要命中其中任意一条，就拒绝执行
const DANGEROUS = [
  /\brm\s+-rf\b/,        // rm -rf：递归强制删除，极易误删
  /\bgit\s+push\b/,      // git push：推送远端，可能影响他人
  /\bgit\s+reset\s+--hard\b/, // git reset --hard：硬重置，会丢失未提交改动
  /\bsudo\b/,            // sudo：以管理员权限执行，风险高
  /\bmkfs\b/,            // mkfs：格式化磁盘，不可逆
  />\s*\/dev\//,         // > /dev/...：向设备文件写入，可能破坏设备
];

// 权限检查函数：返回 "allow"（放行）或 "deny"（拒绝）
// name 是工具名，input 是该工具的参数对象
export function checkPermission(name: string, input: Record<string, any>): "allow" | "deny" {
  // 仅对 run_shell 工具做检查：如果命令字符串命中任意危险正则，就拒绝
  if (name === "run_shell" && DANGEROUS.some((re) => re.test(String(input.command || "")))) {
    return "deny";
  }
  // 其它情况一律放行
  return "allow";
}
//#endregion
