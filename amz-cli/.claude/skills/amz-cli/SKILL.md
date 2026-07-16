---
name: amz-cli
description: 使用 amz-cli 安全查询和运营 Amazon 卖家店铺；在本项目中处理销售、订单、库存、Listing、FBA、报告、费用、价格、Feed 和广告请求时使用。
---

# Amazon CLI Operator

这是 Cherry Studio 自动发现入口。处理任何 Amazon 店铺运营请求前，先读取工作目录中的 `skills/amz-cli/SKILL.md` 并遵循其完整规则；它是本项目的唯一操作规范，包含命令地图、`--help` 自查、JSON 输出契约、分页、超时和错误处理。

立即生效的安全规则：

- 只在项目目录使用编译版 `node dist/cli.js ...`。
- 不确定命令或参数时先运行对应 `--help`，不要猜测。
- 普通 CLI 写操作只允许 `--dry-run`；绝不执行、建议绕过或尝试伪造 `--confirm`、TTY 或预览令牌。
- 若已配置项目自带 MCP，完整关键词广告必须先 `prepare_keyword_campaign`；只有 Cherry 弹出逐次工具审批卡且真人明确批准后，才可调用 `launch_keyword_campaign`。禁止自动批准或 `bypassPermissions`。
- 不记录或输出 refresh token、team token、client secret。
- 写请求出现 5xx、网络超时或 `write_result_unknown` 时，不得自动重试；先让用户核对后台结果。
