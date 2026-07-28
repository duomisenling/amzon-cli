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
| 哪些**以前好卖、现在断货/库存告急要补货**的品 | `inventory restock-candidates`（一步合并库存与近 N 天销量，别手动拼） |
| 哪些品**快断货了、该补货**（还有货但撑不了几天） | `inventory low-stock`（默认可售天数≤14，按紧急度升序） |
| 最近**亚马逊赔了多少钱**、什么原因 | `reimbursements list`（默认最近 30 天，合计+按原因/SKU 拆分） |
| 哪些货**库龄老、要清货**（在仓放太久，对应 ERP 库龄档） | `inventory aged`（按库龄天数筛，默认>90天，列出 0~30/31~60/… 各档明细） |
| 哪些是**滞留库存**（有货但 listing 失效卖不出去） | `inventory stranded` |
| 哪些是**周转慢/压货**（货能卖但可售天数过长，卖得慢） | `inventory slow-moving`（默认可售天数>90天，按可售天数降序） |
| 最近**哪些品退货多**、主要退货原因 | `returns by-sku`（默认最近 30 天，按 SKU 汇总退货量/笔数/主因） |
| **哪些搜索词白花钱**（点击多、0 订单，要加否定词） | `ads wasted-spend`（默认点击≥10、0 转化；结果可直接喂 `ads negative-keyword`） |
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
| 向已有 SP 广告活动/广告组追加商品或正向关键词 | `ads campaign-extend`（JSON 方案；先 dry-run） |

## 效率红线（减少无效调用）

一次自然语言查询要用尽量少的命令收敛；以下行为纯属浪费调用，禁止：

- **不要开场连查一串 `--help`。** 上面的命令选择表已给出首选命令，意图和参数明确时直接运行。只有真的不确定某个参数含义时才对**那一个命令**查一次 `--help`；不要把 amz-cli、子命令、参数逐层帮助全翻一遍再动手。
- **绝不探测或安装 Python**（`which python`、`python --version`、找可用解释器）。amz-cli 不依赖 Python，这类调用对本工具毫无意义。需要对大报告做筛选/聚合时，用 Node 一次性处理，不要先探测环境。
- **本店销量/销售数据只来自 `sales stats` 或 `report run`。** 绝不用 sorftime、OPS、`ops_get_*` 等第三方接口当本店销量源——它们返回的是第三方市场估算，不是本店真实销量，用了就是错。判断“以前好卖 / 卖得好不好”必须基于本店自己的销量数据。
- **翻页要一次翻完。** 复用同一命令加 `--next-token <值>` 连续翻页；分页 token 只在短时间内有效，不要拖到过期再从头重拉。

## 意图判定与追问

先利用当前对话已经出现的店铺、站点、ASIN/SKU、时间范围和业务目标，不要重复询问。意图及必要参数明确时，直接运行最小、最快的只读命令；不要为了确认而确认。

### 多店铺选择

- 用户或管理员给出的店铺代号对应全局 `--account <名称>`，例如 `amz-cli --account shop-a sales stats ...`。命令位置前后均可，但每次调用只能选择一个店铺。
- 当前请求或本轮连续对话中已经由用户明确店铺时，只读查询直接复用该店铺，不要重复追问；查询结果仍要明确报告店铺和站点。
- 用户没有明确店铺、同时提到多个店铺但目标不清，或中途说“换一家”却未给名称时，必须先让用户选择。绝不能把主 `.env` 当成默认店铺，也不能根据 ASIN/SKU、站点、品牌或历史习惯猜店铺。
- 多店铺 MCP 的每个 `prepare_*` / `apply_*`（以及 `prepare_keyword_campaign` / `launch_keyword_campaign`）都有必填 `account`。使用当前对话已明确的店铺填写；没有明确店铺时先追问，不能调用工具试错。旧的固定店铺 MCP 仍只能用于其标题所示店铺。
- 写操作不额外单独追问一次已经明确的店铺，而是把店铺、站点、对象和改动内容一起放进预览与 Cherry 审批卡供用户核对。`prepare` 与 `apply` 必须使用同一个 `account`；不得拿 A 店铺的预览令牌去调用 B 店铺。
- 报给用户的查询结果和写操作预览都要明确说出店铺代号与站点，不能只说“当前店铺”。

只有不同理解会明显改变查询对象、范围、等待时间、输出形态或产生费用时，先用运营能理解的话追问，再调用 CLI：

- “看看这个产品卖得怎么样”，但上下文没有商品编号：询问 ASIN 或 SKU；时间未指定时可提议默认最近 30 天。
- “做个销售报告”，无法判断是单品、全店汇总还是导出文件：询问需要哪一种。
- 明确说“ASIN B0... 最近 30 天销量”：直接用 `sales stats --asin ... --days 30`，不要创建全店报告。
- 明确说“最近 7 天全店经营情况”：直接用不带 ASIN/SKU 的 `sales stats`。
- 问“哪些以前好卖的品断货了 / 哪些要补货”：直接用 `inventory restock-candidates`（默认看最近 30 天销量、彻底断货的品；想含低库存加 `--stock-threshold`）。这条命令已在服务端合并库存与销量，**不要**自己逐页翻库存、再单独跑销售报告、再手动按 ASIN 对——那正是过去一句话炸几十个调用的根源。
- 明确说“导出、全量、全店明细、报表文件”：再使用 `report run`。Reports API 的 ASIN 筛选不是通用能力，不要自行添加不存在的参数。
- 问“某个 ASIN 的差评”：先说明 `feedback run` 是全店卖家反馈，不能按 ASIN 过滤，再确认是否仍要查全店反馈；不要把卖家反馈说成商品评价。

对可安全使用的文档默认值，可以直接采用并在回答中说明；缺少会改变业务含义的参数时必须追问，不得猜测。

**追问时要"带着用户给信息"，而不是甩一个干巴巴的问题——面对的是不懂技术操作的运营：**

- 不要只说"请提供 ASIN"。要说清**要什么、为什么、从哪拿、给个例子**，例如："我需要商品的 ASIN（商品详情页网址里 `/dp/` 后面那串 10 位编号，如 B0AAAAAAAA）才能查它的销量——发我一个就行。"
- 能给**默认值或选项**时，主动给，让用户挑而不是填空：例如"时间范围默认查最近 30 天，可以吗？还是你要 7 天 / 90 天？"
- 多字段的任务（建广告、改 Listing）**一次性把需要的信息列成清单**并各给一个示例，让用户照着补齐，而不是一个一个来回问。缺哪几项就只问哪几项，已经给过的不要再问。
- 用户给的信息不完整或明显不对时，**指出来并给正确示范**，不要直接报错或沉默。
- 术语要落地：说"广告活动名称"而不是"campaign name"，说"每天最多花多少钱（日预算）"而不是"budget"。

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

无论哪条通道，预览（prepare 或 dry-run）前都要确保会改变业务含义的目标和参数已经由用户明确（店铺/站点、商品、预算、竞价、匹配方式、期望状态）；缺少或有歧义就追问，不能替用户拍板。店铺已经在当前连续对话中明确时不单独重复确认，而是在写入预览和审批卡中与其他参数一起核对。

**每次写操作在用户批准前，必须把"将写入什么"逐项列清，用中文摆给用户看，不能只说"改好了/即将修改"这类含糊话：**

- **改动对象**：店铺/站点、精确的 SKU 或广告活动/关键词 ID（不是笼统的 ASIN 或名称）。
- **逐个字段的"当前值 → 新值"**：Listing 列出每个被改属性的旧值和新值；预算/竞价列出旧金额→新金额；状态列出旧状态→新状态。
- **完整提交内容**：Feed 列出类型、行数、表头和首行；建广告列出每个关键词、匹配方式、竞价、日预算、创建后状态。
- **不可逆或花钱的后果**：如"启用后立即开始投放花钱""Feed 处理后无法撤回"。

列清后再让用户在审批卡（MCP 通道）或终端（CLI 通道）确认；用户核对无误才执行。预览返回里有 issues/警告的，一并原文转达，不要略过。

**用户只给了 ASIN、但写操作需要 SKU 时，必须先得到本店真实 SKU，绝不猜测：**

1. 先用只读命令解析该 ASIN 对应本店铺的 SKU：`listing mine --marketplace <站点> --asin <ASIN>`。多个 ASIN 必须合并成一次批量查询，例如 `--asin "ASIN1,ASIN2,ASIN3"`（最多 20 个），不要逐个调用浪费时间。优先读取 `asinSkuMatches` 的逐个映射；`matchedSkus` 仅用于兼容旧输出。
2. 按结果分三种处理：
   - **正好 1 个 SKU**：明确告诉用户「ASIN X 对应你店铺的 SKU Y，本次将对 Y 操作」，然后用这个明确的 SKU 进入预览。
   - **多个 SKU**：**必须列出来让用户选**哪个，绝不自行挑一个写入。
   - **0 个**：说明这个 ASIN 不在该站点的本店铺商品里，请用户确认站点是否正确或直接给 SKU；不要继续。
3. 站点要对齐：ASIN→SKU 的查询站点必须和后续写操作的站点一致（北美/欧洲凭证隔离，德国站要 `--marketplace DE`）。
4. Listing 修改的 `prepare_listing_update` / `listing update` 可以直接接收 `asin`，程序会按当前店铺和站点查询 SKU：
   - 唯一匹配才进入预览，并在预览/审批卡显示最终 SKU。
   - 匹配多个时列出 SKU 并询问用户；用户选择后把 `asin` 与所选 `sku` 一起重新预览，程序会交叉核对。
   - 查不到或 ASIN/SKU 不一致时，原样转达错误并询问用户核对店铺、站点、ASIN 或 SKU；不得自动改用其他值。
5. 广告写入仍只接收已核实的 `products[].sku`；多个 ASIN 应先用一次批量 `listing mine --asin ...` 解析，不能把 ASIN 直接传给广告写接口。

**写操作/建广告执行前，先查一次商品 listing 做落地确认（既拿到 SKU，也确认商品真在自己店铺里）：**

- 建广告或改 Listing 前，用 `listing mine --marketplace <站点> --asin <ASIN>`（或 `--skus <SKU>`）确认这个商品**确实在本店铺该站点的目录里**。查不到就停下，告诉用户"这个商品不在你 XX 站点的在售 listing 里"，让他核对站点或商品，不要硬建。
- 需要看具体字段/当前值时，再用 `listing sku --marketplace <站点> --sku <SKU> --include ...` 拉商品详情，用于"逐项列清 当前值 → 新值"。
- 这样即便用户只给了 ASIN，也能先落到明确的 SKU 和真实商品上，再进入预览与审批，避免对不存在或不属于本店铺的商品下写操作。

**加否定关键词（negative-keyword）前，先确认广告组身份，别只对着裸 ID 下手：** 该操作按 `campaignId` + `adGroupId` 定位，预览默认只显示这两串数字。执行前先用 `ads keywords --profile-id <ID> --campaign-id <活动ID>` 列出该活动的关键词与广告组，确认 `adGroupId` 对应的是哪个广告组，并在报给用户时带上**活动/广告组的人话名称**（不是只有数字），避免把否定词下到错误的广告组。

**向已有广告活动追加商品/正向关键词时，不得重建活动：**

1. 用户只给 ASIN 时，先用一次批量 `listing mine --asin "ASIN1,ASIN2,..."` 解析并确认每个本店 SKU；Listing 修改也继续只使用这个已确认的 SKU，不把 ASIN 当 SKU。
2. 只读查询并确认目标 `campaignId`、`adGroupId`、活动/广告组名称、当前状态和归属关系。添加正向关键词时，目标活动必须是手动投放。
3. 使用 MCP `prepare_ads_campaign_extend`（无 MCP 时使用 `ads campaign-extend --plan <文件> --dry-run`），预览必须分别列出“已经存在”和“将新增”的 SKU/关键词，并明确不会修改预算、活动状态、广告组状态或已有竞价。
4. 目标活动已经启用时，提醒新增商品和关键词成功后可能立即参与投放并产生花费，再让用户审批 `apply_ads_campaign_extend`。
5. 部分成功、超时或回读不一致时，不得复用旧预览或重放整批内容；重新 prepare，系统会按远端现状只列出仍缺少的项目。

**A. MCP 通道（工具清单里有 `prepare_*` 时——优先）**

1. 调对应的 `prepare_*` 工具（不是 `--dry-run` 命令）；多店铺 MCP 必须同时传入当前对话已明确的 `account`。读回预览：店铺/站点、当前值 → 改动、issues、`previewToken`、`applyAllowed`。
2. 把改动、人类可读风险和预览摘要报给用户，说明这是预览、尚未写入。
3. `applyAllowed` 为 `false` 时，说明当前环境未放行该正式写入，令牌无法兑现，**不要**发起审批，把原因告诉用户。
4. 用户认可后调用对应的 `apply_*`（完整关键词广告用 `launch_keyword_campaign`），并传入与 prepare 完全相同的 `account`。真正的人工把关是 **Cherry 弹出的工具审批卡**：由用户同时核对店铺、站点和业务参数后批准。不得自动批准，不得使用 `bypassPermissions`，聊天里的“确定/Y”不能替代审批卡。
5. 业务参数、文件、账户、区域或预览依据的远端状态变化后，必须重新 `prepare_*`；跨店铺复用令牌属于错误，不能重试 apply。

**B. CLI 通道（工具清单里没有上述 MCP 工具时）**

1. 普通 CLI/终端工具中，Agent 只可以执行 `--dry-run`，不得执行或建议绕过 `--confirm`。
2. 将 dry-run 的改动、人类可读风险和 `meta.preview_token` 总结给用户。
3. 给出业务参数完全相同的最终命令：`--confirm --preview-token <token>`。
4. 要求用户本人在交互式 PowerShell 终端运行；CLI 会再次要求 `y` 或不可撤销 Feed 的随机确认码。

**完整广告默认一次审批后创建并投放：**

`ads campaign-create` 只创建 Campaign 外壳；用户说“用这些关键词建广告”时用 `ads keyword-campaign-launch`（MCP 通道对应 `prepare_keyword_campaign` → `launch_keyword_campaign`）。

用户说“把这些 SKU/关键词加入已有活动”时，使用 `ads campaign-extend`（MCP 对应 `prepare_ads_campaign_extend` → `apply_ads_campaign_extend`），不能改用 `keyword-campaign-launch` 创建新活动，也不能因旧 `launchId` 冲突而换一个 `launchId` 重建。

1. 先确认 profile/区域、商品、日预算、日期、广告组默认竞价、每个关键词的匹配方式与竞价。缺信息时**用一张清单带用户补齐**，别一个个逼问，例如：

   > 建这套广告我需要这几样，你发我就行（不用管格式）：
   > 1. 打哪个**商品**：给 ASIN 就行（可多个变体，如 B0AAA、B0BBB）
   > 2. **每天最多花多少钱**（日预算），如 20 美元
   > 3. 投放哪些**关键词**、每个词大概出价多少，如「soap bar 出 0.75」
   > 4. 广告放哪个**站点**（美国 / 德国…）
   > （开始日期、广告组默认竞价我可以给你建议默认值）

   - **一个活动支持多个商品**：用户给多个 ASIN/SKU（如同一商品的几个变体）时，先把所有 ASIN 一次批量解析为本店 SKU，再全部放进方案的 `products` 数组（1–20 个）。`products[].sku` 必填；`asin` 只能作为预览核对字段，不能代替 SKU，也不会发送给广告写接口。不要说"只支持一个"，也不要替用户拆成多个活动；用户明确要分开投放时才拆。
   - 把多个 ASIN 转成 `products` 数组是你的工作，不要求用户提供 JSON 或数组。
   - 只给 ASIN 时按上面的 ASIN→SKU 规则先批量解析并确认商品在店铺里。没有唯一 SKU 映射时必须停止，不能调用 `prepare_keyword_campaign` 试错。
   - 同时告知：同一广告组内的所有商品**共享同一套关键词和竞价**；预览时把每个商品逐个列出让用户核对。
2. 用户说“新建/创建广告”“开始投放”等正常创建意图时，方案明确设置 `enableAfterCreate=true`。这表示同一次预览和审批覆盖“创建完整广告并在校验成功后启用”，不再拆成第二次启用审批。
3. 只有用户明确说“保持暂停”“暂不投放”“先建好不要开启”时，才设置 `enableAfterCreate=false`。不要在用户已经表达正常创建意图时重复追问是否启用。
4. 预览必须逐项展示广告活动名称、日预算、广告组、全部商品（ASIN→SKU）、每个关键词、匹配方式、竞价，以及最终状态“ENABLED，创建完成后立即开始投放并产生花费”。运营在同一张审批卡中核对并批准。
5. 底层仍固定先创建 PAUSED Campaign，只有广告组、全部商品广告、全部关键词创建成功且逐项回读一致后才自动启用。任何部分失败、校验失败或结果不明确都保持暂停，不得报告已经投放。
6. 如果用户明确选择暂停创建，后续又要求开启，才将开启作为独立写操作：对返回的 campaignId 使用 `ads campaign-state --state ENABLED`（MCP 用 `prepare_ads_campaign_state` → `apply_ads_campaign_state`）。

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
2. 先查当前店铺、站点和商品类型的卖家专属 Schema：
   - **MCP 通道**：优先调用只读 `inspect_listing_schema`。用户说的是“Item Highlights/商品亮点”等业务名称时先传 `query` 搜索显示名称和说明；只有唯一匹配后，再用 `attribute` 读取真实属性的完整定义。
   - **CLI 通道**：`listing schema --product-type <类型> --grep <业务名称>` 搜索，再用 `--attribute <真实属性名>` 看结构、字数限制和条数限制。
   **不要凭记忆或其他产品类型的经验拼 patch**。查不到或匹配多个时，列出证据并询问用户；不得换几个猜测字段名反复调用预览。
3. 照 schema 拼 patch JSON 写入临时文件，用 `--patches @文件路径` 传入。若预览报 8560，不要自动添加字段：先读本次 issues，并确认当前 schema 是否包含 `merchant_suggested_asin`、ASIN 是否已核对；只有两者都满足时才按 schema 结构补充并重新预览。
4. 预览（按上面「写操作」的通道判断二选一）：
   - **MCP 通道**：调 `prepare_listing_update`。程序会再次强制获取卖家专属 Schema，核对补丁属性存在且未标记为不可编辑，并把 Schema 版本/校验值绑定进令牌；通过后才走官方 `VALIDATION_PREVIEW`。读回 `schemaValidation`、`status`、issues、`previewToken`、`applyAllowed`。
   - **CLI 通道**：`listing update --dry-run`（同样走 `VALIDATION_PREVIEW`）。
   两者判读一致：`status=VALID` 且没有 ERROR issue 才算预览通过（`ACCEPTED` 是正式提交的状态，不是预览状态）；`INVALID` 时把 issues 原文报给用户。
5. 执行（与第 4 步同一通道）：
   - **MCP 通道**：报预览摘要，用户认可后调用 `apply_listing_update`，由 Cherry 审批卡人工把关；不要给用户 CLI confirm 命令。
   - **CLI 通道**：把带预览令牌的 confirm 命令交给用户本人在 PowerShell 执行。

商品亮点（Item Highlights）等新字段按市场和产品类型逐步开放，字段名可能因类型而异。Amazon 公告要求标题 ≤75 字符；但某个错误码不能单独证明只是标题长度问题。**只有当前卖家、站点、产品类型的最新 Schema 实际返回且允许编辑的字段才能用**，不要把一个类型的字段名或结构照搬到其他类型。只有 `inspect_listing_schema`/`listing schema` 没有匹配项，或唯一匹配项明确 `editable=false`，才能向用户说明当前 API Schema 不支持；“尝试了几个字段名都失败”不是证据。

## 回答方式

先将用户问题转换为最小只读查询，拿到 JSON 后用中文总结业务结论、金额、时间范围和异常项。不要直接倾倒原始 JSON；需要精确字段或不确定 API 行为时，再调用 `--help` 自查。
