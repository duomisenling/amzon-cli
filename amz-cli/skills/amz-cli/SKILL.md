---
name: amz-cli
description: 使用 amz-cli 安全查询和运营 Amazon 卖家店铺。适用于销售、订单、库存、Listing、FBA 货件、报告、费用、价格、Feed 和广告等请求；当用户以自然语言询问亚马逊店铺经营数据或要求执行相应 CLI 操作时使用。
---

# Amazon CLI Operator

使用已安装的编译版 CLI：`amz-cli <domain> <command> [flags]`。不确定命令或参数时，先执行 `amz-cli <domain> <command> --help`；不要猜测参数，也不要把完整命令表塞进上下文。若系统找不到 `amz-cli`，停止业务操作并让用户重新运行安装命令，不得改用未编译源码绕过门禁。

`amz-cli` 不依赖 Python，运行它不需要 Python 环境。因此不要为本工具探测或安装 Python（如 `which python`、`python --version`）——这对 amz-cli 没有意义，只会浪费时间。直接运行 `amz-cli ...` 即可。

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

**开始任何写操作前，先做通道判断（这一步决定后续走法，不能跳过）：**

- **看当前会话的工具清单里有没有本项目的 `prepare_*` / `apply_*`（或 `prepare_keyword_campaign` / `launch_keyword_campaign`）MCP 工具。**
- **有 → 必须走「A. MCP 通道」**。这是运营在 Cherry 审批卡里批准写操作的设计初衷；此时**不要**退回 CLI `--dry-run`，也不要让用户去 PowerShell 跑 `--confirm`。
- **没有 → 才走「B. CLI 通道」**。

无论哪条通道，预览（prepare 或 dry-run）前都要先确认会改变业务含义的目标和参数（店铺/站点、商品、预算、竞价、匹配方式、期望状态）；不确定就追问，不能替用户拍板。

**每次写操作在用户批准前，必须把"将写入什么"逐项列清，用中文摆给用户看，不能只说"改好了/即将修改"这类含糊话：**

- **改动对象**：店铺/站点、精确的 SKU 或广告活动/关键词 ID（不是笼统的 ASIN 或名称）。
- **逐个字段的"当前值 → 新值"**：Listing 列出每个被改属性的旧值和新值；预算/竞价列出旧金额→新金额；状态列出旧状态→新状态。
- **完整提交内容**：Feed 列出类型、行数、表头和首行；建广告列出每个关键词、匹配方式、竞价、日预算、创建后状态。
- **不可逆或花钱的后果**：如"启用后立即开始投放花钱""Feed 处理后无法撤回"。

列清后再让用户在审批卡（MCP 通道）或终端（CLI 通道）确认；用户核对无误才执行。预览返回里有 issues/警告的，一并原文转达，不要略过。

**用户只给了 ASIN、但写操作需要 SKU 时（Listing 修改、建广告等），先解析再写，不要让写命令自己猜：**

1. 先用只读命令解析该 ASIN 对应本店铺的 SKU：`listing mine --marketplace <站点> --asin <ASIN>`（返回里的 `matchedSkus` 就是命中的 SKU）。
2. 按结果分三种处理：
   - **正好 1 个 SKU**：明确告诉用户「ASIN X 对应你店铺的 SKU Y，本次将对 Y 操作」，然后用这个明确的 SKU 进入预览。
   - **多个 SKU**：**必须列出来让用户选**哪个，绝不自行挑一个写入。
   - **0 个**：说明这个 ASIN 不在该站点的本店铺商品里，请用户确认站点是否正确或直接给 SKU；不要继续。
3. 站点要对齐：ASIN→SKU 的查询站点必须和后续写操作的站点一致（北美/欧洲凭证隔离，德国站要 `--marketplace DE`）。

绝不把"从 ASIN 推断 SKU"塞进写操作内部自动完成——写操作只接受明确的 SKU，且这个 SKU 必须在预览/审批卡里被用户看到。

**A. MCP 通道（工具清单里有 `prepare_*` 时——优先）**

1. 调对应的 `prepare_*` 工具（不是 `--dry-run` 命令），读回预览：当前值 → 改动、issues、`previewToken`、`applyAllowed`。
2. 把改动、人类可读风险和预览摘要报给用户，说明这是预览、尚未写入。
3. `applyAllowed` 为 `false` 时，说明当前环境未放行该正式写入，令牌无法兑现，**不要**发起审批，把原因告诉用户。
4. 用户认可后调用对应的 `apply_*`（完整关键词广告用 `launch_keyword_campaign`）。真正的人工把关是 **Cherry 弹出的工具审批卡**：由用户在卡上核对参数并批准。不得自动批准，不得使用 `bypassPermissions`，聊天里的“确定/Y”不能替代审批卡。
5. 业务参数、文件、账户、区域或预览依据的远端状态变化后，必须重新 `prepare_*`。

**B. CLI 通道（工具清单里没有上述 MCP 工具时）**

1. 普通 CLI/终端工具中，Agent 只可以执行 `--dry-run`，不得执行或建议绕过 `--confirm`。
2. 将 dry-run 的改动、人类可读风险和 `meta.preview_token` 总结给用户。
3. 给出业务参数完全相同的最终命令：`--confirm --preview-token <token>`。
4. 要求用户本人在交互式 PowerShell 终端运行；CLI 会再次要求 `y` 或不可撤销 Feed 的随机确认码。

**广告创建一律分两个阶段，绝不在创建那一步就开启投放（开启=开始花钱）：**

`ads campaign-create` 只创建 Campaign 外壳；用户说“用这些关键词建广告”时用 `ads keyword-campaign-launch`（MCP 通道对应 `prepare_keyword_campaign` → `launch_keyword_campaign`）。

**第一阶段——创建为暂停：**
1. 先确认 profile/区域、ASIN 或 SKU（只给 ASIN 时按上面的 ASIN→SKU 规则解析）、日预算、日期、广告组默认竞价、每个关键词的匹配方式与竞价。
2. 方案里 `enableAfterCreate` 一律设为 `false`（`campaign-create` 用 `state=PAUSED`）——**不要一步创建成启用**。
3. 走完整逐项预览 + 审批卡批准后创建。创建成功后是【暂停】状态，不产生任何花费。

**第二阶段——列清、说明、再问是否开启：**
4. 创建成功后，把已创建的内容**完整再列一遍**：广告活动名称与日预算、广告组、投放的商品（ASIN/SKU）、以及每个关键词及其匹配方式与竞价。
5. **逐条说明作用**，并明确告知“开启后广告立即开始投放并产生花费”。
6. **主动询问用户：是否要开启（可以全部开启，也可以选择部分/暂不开启）。** 不要替用户决定，也不要默认帮他开。
7. 用户明确要开启后，把“开启”作为**独立的第二次写操作**执行：对创建返回的 campaignId 走 `ads campaign-state --state ENABLED`（MCP 通道用 `prepare_ads_campaign_state` → `apply_ads_campaign_state`），同样要逐项预览 + 审批卡批准。

MCP 正式写工具还受管理员配置的 `AMZ_MCP_ALLOWED_WRITES` 白名单限制；被拒绝时报告给管理员，不得自行扩大权限。

**写操作结果必须如实转达，不得把“不确定”说成“已完成”：**

- 广告写操作返回 `verificationStatus`。只有 `VERIFIED` 才能说“已确认生效”。`PENDING_OR_MISMATCH` 必须明说“已提交但即时回读未能确认，请你稍后用只读命令或广告后台核对”，不得说成已完成；同时若返回里有 `readbackError`，一并转达，不要略去。**收到 `PENDING_OR_MISMATCH` 或 `readbackError` 时不得自动重试写入。**
- `verificationStatus: SERVER_RESPONSE_ONLY`（否定关键词）表示只拿到 Amazon 创建响应、没有回读手段：如实说明“以 Amazon 响应为准，未二次核实”，让用户到后台确认。
- Feed 返回 `SUBMITTED` 后继续用只读状态/结果查询，只有 `DONE` 且结果文档核对完成才能报告各行成功。
- Listing 返回 `processingStatus: SUBMITTED`、正式提交的 `ACCEPTED`、以及 `immediateReadback` 都不代表前台目录已最终生效；`immediateReadback` 可能仍是旧值，不要把它当成“新值已生效”的证据。有 `readbackError` 时如实转达。

不要尝试伪造 TTY、预览令牌或直接使用 Amazon bearer token 绕过 CLI。不要在聊天、提示词或输出中记录 refresh token、team token、client secret。

`--dry-run` 与 `--confirm` 不能同时使用。预览令牌 15 分钟内有效且只能使用一次，并绑定命令、业务参数、文件内容与运行环境；任何变化都应重新预览。

## 改 Listing 字段的固定流程（标题/五点/亮点/图片等）

1. `listing sku --include productTypes` 查该 SKU 的产品类型。
2. `listing schema --product-type <类型>` 查字段确切名字；`--attribute <字段>` 看结构、字数限制、条数限制。**不要凭记忆或其他产品类型的经验拼 patch**——每个产品类型的 schema 不同。
3. 照 schema 拼 patch JSON 写入临时文件，用 `--patches @文件路径` 传入。若预览报 8560，不要自动添加字段：先读本次 issues，并确认当前 schema 是否包含 `merchant_suggested_asin`、ASIN 是否已核对；只有两者都满足时才按 schema 结构补充并重新预览。
4. 预览（按上面「写操作」的通道判断二选一）：
   - **MCP 通道**：调 `prepare_listing_update`（内部即走官方 `VALIDATION_PREVIEW`），读回 `status`、issues、`previewToken`、`applyAllowed`。
   - **CLI 通道**：`listing update --dry-run`（同样走 `VALIDATION_PREVIEW`）。
   两者判读一致：`status=VALID` 且没有 ERROR issue 才算预览通过（`ACCEPTED` 是正式提交的状态，不是预览状态）；`INVALID` 时把 issues 原文报给用户。
5. 执行（与第 4 步同一通道）：
   - **MCP 通道**：报预览摘要，用户认可后调用 `apply_listing_update`，由 Cherry 审批卡人工把关；不要给用户 CLI confirm 命令。
   - **CLI 通道**：把带预览令牌的 confirm 命令交给用户本人在 PowerShell 执行。

商品亮点（Item Highlights）等新字段按市场和产品类型逐步开放，字段名可能因类型而异。Amazon 公告要求标题 ≤75 字符；但某个错误码不能单独证明只是标题长度问题。**只有当前产品类型的 `listing schema` 实际返回的字段才能用**，不要把一个类型的字段名或结构照搬到其他类型。用户给出优化后的文案时，按本流程转换并校验，不要直接替用户执行写入。

## 回答方式

先将用户问题转换为最小只读查询，拿到 JSON 后用中文总结业务结论、金额、时间范围和异常项。不要直接倾倒原始 JSON；需要精确字段或不确定 API 行为时，再调用 `--help` 自查。
