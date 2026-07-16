---
name: amz-cli
description: 使用 amz-cli 安全查询和运营 Amazon 卖家店铺。适用于销售、订单、库存、Listing、FBA 货件、报告、费用、价格、Feed 和广告等请求；当用户以自然语言询问亚马逊店铺经营数据或要求执行相应 CLI 操作时使用。
---

# Amazon CLI Operator

使用编译版 CLI：在项目目录执行 `node dist/cli.js <domain> <command> [flags]`。不确定命令或参数时，先执行 `node dist/cli.js <domain> <command> --help`；不要猜测参数，也不要把完整命令表塞进上下文。

## 命令选择

| 用户意图 | 首选命令 |
|---|---|
| 销售额、销量、日报 | `sales stats` |
| 订单、单笔订单、商品明细 | `orders list/get/items` |
| FBA 库存 | `inventory list` |
| FBA 货件和收货差异 | `shipments list/items` |
| 自己的 Listing 或修改 Listing | `listing mine/sku/update` |
| 产品类型有哪些可填字段、字段结构 | `listing schema`（`--grep` 找字段、`--attribute` 看单字段定义） |
| 商品目录、竞品、Buy Box | `listing search/get`、`pricing competitive/foep` |
| 费用预估 | `fees estimate` |
| 店铺报告、差评报告 | `report run`、`feedback run` |
| 批量库存或 Listing 修改 | `feed submit` |
| 广告账户、活动、关键词、报表 | `ads profiles/campaigns/keywords/report-run` |

使用 `--marketplace` 指定国家码。欧洲广告还必须使用 `--region eu` 和欧洲对应的 `profileId`。列表响应含 `nextToken` 时，用同一命令加 `--next-token <值>` 继续翻页。

## 输出与错误

- 只从 stdout 解析成功 JSON；stderr 是进度和错误 JSON。
- `fix_param`：根据 `hint_human` 修改参数后再试。
- `backoff_and_retry`：只读请求可等待后重试。
- `reauthorize`、`report_to_human`：原样向用户说明 `hint_human`，不要编造原因。
- 写请求的 5xx、网络超时或 `write_result_unknown`：不得自动重试。先让用户用只读状态/列表命令或后台核对是否已生效。

报告的 `--timeout` 单位为分钟，只接受 1–60 的有限数字。超时只停止本次等待，不会取消 Amazon 服务端已经创建的报告；店铺报告可用 `report status/download` 继续，广告报告用 `ads report-status --profile-id <ID> --report-id <ID>` 查询。

## 写操作：最高优先级

写操作包括 Listing 修改、Feed 提交和所有广告创建/修改。

1. Agent 只可以执行 `--dry-run`，不得执行或建议绕过 `--confirm`。
2. 将 dry-run 的改动、人类可读风险和 `meta.preview_token` 总结给用户。
3. 给出业务参数完全相同的最终命令：`--confirm --preview-token <token>`。
4. 要求用户本人在交互式 PowerShell 终端运行；CLI 会再次要求 `y` 或不可撤销 Feed 的随机确认码。

不要尝试伪造 TTY、预览令牌或直接使用 Amazon bearer token 绕过 CLI。不要在聊天、提示词或输出中记录 refresh token、team token、client secret。

`--dry-run` 与 `--confirm` 不能同时使用。预览令牌 15 分钟内有效且只能使用一次，并绑定命令、业务参数、文件内容与运行环境；任何变化都应重新预览。

## 改 Listing 字段的固定流程（标题/五点/亮点/图片等）

1. `listing sku --include productTypes` 查该 SKU 的产品类型。
2. `listing schema --product-type <类型>` 查字段确切名字；`--attribute <字段>` 看结构、字数限制、条数限制。**不要凭记忆或其他产品类型的经验拼 patch**——每个产品类型的 schema 不同。
3. 照 schema 拼 patch JSON 写入临时文件，用 `--patches @文件路径` 传入。若预览报 8560，不要自动添加字段：先读本次 issues，并确认当前 schema 是否包含 `merchant_suggested_asin`、ASIN 是否已核对；只有两者都满足时才按 schema 结构补充并重新预览。
4. `listing update --dry-run`：走 Amazon 官方 `VALIDATION_PREVIEW` 校验，`status=VALID` 且没有 ERROR issue 才算预览通过（`ACCEPTED` 是正式提交的状态，不是预览状态）；`INVALID` 时把 issues 原文报给用户。
5. 带预览令牌的 confirm 命令交给用户本人执行。

商品亮点（Item Highlights）等新字段按市场和产品类型逐步开放，字段名可能因类型而异。Amazon 公告要求标题 ≤75 字符；但某个错误码不能单独证明只是标题长度问题。**只有当前产品类型的 `listing schema` 实际返回的字段才能用**，不要把一个类型的字段名或结构照搬到其他类型。用户给出优化后的文案时，按本流程转换并校验，不要直接替用户执行写入。

## 回答方式

先将用户问题转换为最小只读查询，拿到 JSON 后用中文总结业务结论、金额、时间范围和异常项。不要直接倾倒原始 JSON；需要精确字段或不确定 API 行为时，再调用 `--help` 自查。
