---
name: amz-cli
description: 使用 amz-cli 安全查询和运营 Amazon 卖家店铺。适用于销售、订单、库存、Listing、FBA 货件、报告、费用、价格、Feed 和广告等请求；当用户以自然语言询问亚马逊店铺经营数据或要求执行相应 CLI 操作时使用。
---

# Amazon CLI Operator

使用已安装的编译版 CLI：`amz-cli <domain> <command> [flags]`。不确定命令或参数时，先执行 `amz-cli <domain> <command> --help`；不要猜测参数，也不要把完整命令表塞进上下文。若系统找不到 `amz-cli`，停止业务操作并让用户重新运行安装命令，不得改用未编译源码绕过门禁。

## 命令选择

| 用户意图 | 首选命令 |
|---|---|
| 单个 ASIN/SKU 或全店的销售额、销量、日报 | `sales stats`（单品带 `--asin` 或 `--sku`） |
| 订单、单笔订单、商品明细 | `orders list/get/items` |
| FBA 库存 | `inventory list` |
| FBA 货件和收货差异 | `shipments list/items` |
| 自己的 Listing 或修改 Listing | `listing mine/sku/update` |
| 产品类型有哪些可填字段、字段结构 | `listing schema`（`--grep` 找字段、`--attribute` 看单字段定义） |
| 商品目录、竞品、Buy Box | `listing search/get`、`pricing competitive/foep` |
| 费用预估 | `fees estimate` |
| 全量导出、全店明细文件、差评报告 | `report run`、`feedback run` |
| 批量库存或 Listing 修改 | `feed submit` |
| 广告账户、活动、关键词、报表 | `ads profiles/campaigns/keywords/report-run` |
| 用已经选好的关键词建立完整 SP 广告 | `ads keyword-campaign-launch`（JSON 方案；先 dry-run） |

## 意图判定与追问

先利用当前对话已经出现的店铺、站点、ASIN/SKU、时间范围和业务目标，不要重复询问。意图及必要参数明确时，直接运行最小、最快的只读命令；不要为了确认而确认。

只有不同理解会明显改变查询对象、范围、等待时间、输出形态或产生费用时，先用运营能理解的话追问，再调用 CLI：

- “看看这个产品卖得怎么样”，但上下文没有商品编号：询问 ASIN 或 SKU；时间未指定时可提议默认最近 30 天。
- “做个销售报告”，无法判断是单品、全店汇总还是导出文件：询问需要哪一种。
- 明确说“ASIN B0... 最近 30 天销量”：直接用 `sales stats --asin ... --days 30`，不要创建全店报告。
- 明确说“最近 7 天全店经营情况”：直接用不带 ASIN/SKU 的 `sales stats`。
- 明确说“导出、全量、全店明细、报表文件”：再使用 `report run`。Reports API 的 ASIN 筛选不是通用能力，不要自行添加不存在的参数。
- 问“某个 ASIN 的差评”：先说明 `feedback run` 是全店卖家反馈，不能按 ASIN 过滤，再确认是否仍要查全店反馈；不要把卖家反馈说成商品评价。

对可安全使用的文档默认值，可以直接采用并在回答中说明；缺少会改变业务含义的参数时必须追问，不得猜测。

使用 `--marketplace` 指定国家码。欧洲广告还必须使用 `--region eu` 和欧洲对应的 `profileId`。列表响应含 `nextToken` 时，用同一命令加 `--next-token <值>` 继续翻页。

Broker 模式下，`listing mine/sku/schema/update` 的 Seller ID 必须来自 Broker；`--seller-id` 只能核对，不能在服务端缺配置时兜底。`listing update` 的 `add`/`replace`/`merge` 必须带对象数组 `value`；`merge` 只允许 `fulfillment_availability` 和 `purchasable_offer` 两个官方支持属性。

订单使用字段白名单剥离买家姓名、地址和邮箱；反馈报告会删除 Amazon 原始报告中的 `Rater Email`。不要主动请求受限 PII 报告，也不要把敏感报告保存到共享目录。

## 输出与错误

- 只从 stdout 解析成功 JSON；stderr 是进度和错误 JSON。
- `fix_param`：根据 `hint_human` 修改参数后再试。
- `backoff_and_retry`：只读请求可等待后重试。
- `reauthorize`、`report_to_human`：原样向用户说明 `hint_human`，不要编造原因。
- 写请求的 5xx、网络超时或 `write_result_unknown`：不得自动重试。先让用户用只读状态/列表命令或后台核对是否已生效。

报告的 `--timeout` 单位为分钟，只接受 1–60 的有限数字。超时只停止本次等待，不会取消 Amazon 服务端已经创建的报告；店铺报告可用 `report status/download` 继续，广告报告用 `ads report-status --profile-id <ID> --report-id <ID>` 查询。

## 写操作：最高优先级

写操作包括 Listing 修改、Feed 提交和所有广告创建/修改。

1. dry-run 前确认会改变业务含义的目标和参数，例如店铺/站点、商品、预算、竞价、匹配方式和期望状态；不确定就追问，不能替用户拍板。
2. 普通 CLI/终端工具中，Agent 只可以执行 `--dry-run`，不得执行或建议绕过 `--confirm`。
3. 将 dry-run 的改动、人类可读风险和 `meta.preview_token` 总结给用户。
4. 给出业务参数完全相同的最终命令：`--confirm --preview-token <token>`。
5. 要求用户本人在交互式 PowerShell 终端运行；CLI 会再次要求 `y` 或不可撤销 Feed 的随机确认码。

`ads campaign-create` 仍只创建 Campaign 外壳。用户说“用这些关键词建广告”时，应使用 `ads keyword-campaign-launch`：先确认 profile/区域、ASIN 或 SKU、预算、日期、竞价策略、广告组默认竞价、每个关键词的匹配方式与竞价，以及创建后是否启用；生成固定 JSON 方案并 dry-run。正式流程先建 PAUSED Campaign，所有子对象回读成功后才启用。

若当前 Cherry 已配置项目自带的 `amz-cli-mcp`，Listing、Feed 和运营广告写操作可使用对应的 `prepare_*` 预览，再由用户在 Cherry 审批卡批准对应 `apply_*`；完整关键词广告使用 `prepare_keyword_campaign` → `launch_keyword_campaign`。不得自动批准正式工具，不得使用 `bypassPermissions`，聊天中的“确定/Y”不能替代工具审批。业务参数、文件、账户、区域或预览依据的远端状态变化后必须重新 prepare。

MCP 正式写工具还受管理员配置的 `AMZ_MCP_ALLOWED_WRITES` 白名单限制；被拒绝时报告给管理员，不得自行扩大权限。Feed 返回 `SUBMITTED` 后继续用只读状态/结果查询，只有 `DONE` 且结果文档核对完成才能报告各行成功。Listing 正式提交的 `ACCEPTED` 和即时回读也不代表前台目录已最终生效。

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
