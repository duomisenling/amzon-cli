---
name: amazon-ads-strategist
description: 筛选、分析和优化 Amazon Sponsored Products 广告，支持全店发现近期销售/转化下降商品，或处理单个及批量最多20个ASIN。适用于“找出销售不好的商品并优化广告”“直接生成广告优化审批”“给新品做广告方案”“批量优化这些ASIN的广告”“这批品一个月只出一两单要不要投广告”“给滞销/长尾品做个小预算广告方案”“降低ACOS”“找浪费词”“重新分配预算”“调研竞品和关键词”等请求；编排 amz-cli 本店真实数据与 Cherry Studio 已启用的 Sorftime、SIF及其他相关只读MCP，区分新品策划、已有广告优化和非广告阻断，输出证据、动作预览及优先级。正式写入始终需要Cherry真人审批。
---

# Amazon 广告策略

为运营生成可审阅、可解释、可落地的广告方案。用 `amz-cli` 读取本店事实，用 Sorftime/SIF 补充市场、竞品和关键词信号；不要把第三方估算当作本店销量或广告转化。

## 开始前

1. 使用Cherry当前已提供的终端、`amz-cli` Skill和市场MCP；不要在开始时枚举、探测或同步全部工具。只有执行到具体步骤缺少工具时，才查找该项能力；正式落地需要amz-cli安全写入MCP。
2. 接受两种入口：用户提供1–20个ASIN；或用户要求从当前店铺筛选近期销售/转化下降商品，默认最多取20个候选。超过20个明确拆批，不截断或静默漏掉。
3. 最低充分输入是店铺代号；ASIN列表或“全店筛选”的意图二选一。若当前连续对话已经明确店铺，应立即开始，不要重复索要。
4. CLI绑定多个店铺时，若当前上下文没有明确店铺，只询问店铺代号。禁止根据ASIN、站点、历史习惯或默认环境猜店铺，也禁止遍历五个店铺寻找ASIN。店铺明确后，每次CLI调用都显式传入同一 `--account <店铺代号>`。
5. 站点、预算、目标ACOS、利润率、测试周期、痛点和竞品ASIN均为可选信息，优先复用上下文。用户可提供最多5个竞品ASIN，核验相关性后优先使用；未提供时再自动发现。店铺只有一个适用站点时可读取账户配置后采用并说明；存在多个可能站点时再询问站点，不猜测。
6. 不要在查询前要求用户补齐利润率、目标ACOS或痛点。缺少这些字段仍须继续；新品使用明确标注的测试默认值，已有广告按可用样本分析。无法验证盈利安全性的精确出价或预算标记“经济性未验证”，不要声称其利润安全。

### 最小交互

- 店铺未明确：只回复“请告诉我店铺代号；可以同时给1–20个ASIN，也可以让我从全店筛选。目标ACOS、利润率和痛点都可以不填。”
- 店铺已明确且收到1–20个ASIN：直接开始只读查询，不发送信息收集清单。
- 店铺已明确且用户要求找销售不好的商品：读取 [references/store-screening.md](references/store-screening.md)，直接执行全店候选筛选。
- 用户只说“优化这些ASIN”时默认做完整诊断，不再追问主要痛点。

## 路由

先识别用户目标，再只读取该路径需要的参考文件：

- 未提供ASIN且要求全店筛选：先读取 [references/store-screening.md](references/store-screening.md)，每批最多处理20个候选；同一次扫描可连续取下一批，再进入批量流程。
- 用户明确说新品、冷启动、没怎么投过，且目标是新建/开启广告：信任该业务上下文，直接走“新品快速开广告”，只先读取 [references/campaign-plan.md](references/campaign-plan.md) 和 [references/research.md](references/research.md)；遇到具体的数据来源、MCP或写入边界问题时再读取对应参考文件。不要一次性读取所有流程文档，也不要为了证明它是新品而查询广告覆盖、历史Campaign、搜索词或广告报表。
- 已有广告且用户要求诊断、优化或降ACOS：读取 [references/optimize-existing.md](references/optimize-existing.md)。
- 用户给出一批已上架一段时间、月销约0–5单的滞销/长尾品，并希望给它们也投广告：读取 [references/low-volume.md](references/low-volume.md)。这类商品样本永远不够、ACOS在小样本上没有意义，必须按累计点击而不是3/7/14天判断，不要套用新品或常规优化流程。
- 用户没有说明阶段，或明确要求核对、复用、避免与旧广告重复：读取 [references/batch-workflow.md](references/batch-workflow.md)，查询最小必要的广告覆盖后分流。
- 混合批次：读取 [references/batch-workflow.md](references/batch-workflow.md)，两条流程同时使用，最终统一做跨ASIN预算排序。

所有任务都按需读取：

- [references/data-contract.md](references/data-contract.md)：数据证据和MCP降级
- [references/mcp-routing.md](references/mcp-routing.md)：本店事实、市场MCP和写入MCP的职责边界
- [references/research.md](references/research.md)：竞品ASIN和关键词研究
- [references/calculations.md](references/calculations.md)：ACOS、CPA、CPC及样本门槛
- [references/review-cycle.md](references/review-cycle.md)：执行记录和第3/7/14天复盘闭环

## 前置检查

- 遵守 `amz-cli` Skill；找不到编译版CLI时停止店铺查询，不改用源码绕过。
- 一次 `listing mine --asin "ASIN1,..."` 解析最多20个ASIN。唯一SKU才继续；0个或多个匹配逐项列出并暂停该ASIN，不影响其他有效商品的只读分析。
- 新品快速路径只从这次批量映射读取已有的标题、品类、价格、Listing状态和问题。只有返回信息不能判断是否可投时，才增加一次可批量的定向检查；不要默认分别查询销量、费用、图片、A+、广告覆盖、Campaign、关键词或报表。
- 新品仅将无有效SKU、不可售/严重压制、无库存或无Featured Offer/Buy Box等会阻止Sponsored Products投放的状态列为硬阻断。单个ASIN阻断不影响其他ASIN继续生成方案和预览。
- 已有广告优化和阶段不明的任务才按需查询广告覆盖与商品广告映射。用户明确说明新品并要求新建广告时，不用历史广告数据验证其说法。
- 全店候选只表示表现需要解释，不表示广告有错；先排除库存、可售性、Buy Box、价格和Listing承接问题，再决定是否生成广告动作。

## 工具调用纪律

- 新品快速路径在形成方案前的默认目标是两件不同商品约4–8次读取/研究调用：1次批量ASIN→SKU/Listing映射；0–1次批量硬阻断补查；全批按产品组复用2–4次市场研究。方案后的prepare数量取决于最终Campaign数量；审批、正式launch和用户要求的追加研究不计入该目标。
- Sorftime/SIF只研究市场、关键词和竞品。新品默认不反查本店ASIN，也不使用市场MCP查询本店广告、销量、库存或Listing事实。
- 同一店铺、站点、产品组、关键词或竞品的结果本轮复用，不按ASIN重复调用；先拿到足以决策的证据就停止研究。
- 不扫描文件系统寻找CLI，不猜命令、子命令或参数。严格使用 `amz-cli` Skill中的规范命令；特定命令不确定时只读取该命令一次 `--help`，修正一次后仍失败就降级并说明。

## 输出

先给批次总览，再逐ASIN展开：

1. 店铺、站点、时间窗口、数据完整性
2. ASIN→SKU映射、商品状态、路由结果（新品方案/已有优化/阻断/无法解析）
3. 跨ASIN优先级：加预算、维持、收缩、暂停研究、先修Listing
4. 每个ASIN的当前证据、主要问题、竞品与关键词依据
5. 新品：Campaign、匹配方式、关键词、预算、竞价和14天测试节奏
6. 已有广告：保留、扩量、降价、否定、暂停和结构调整清单
7. 总预算变化、理论最高花费、缺失数据、风险和置信度

每个数字说明依据。第三方数据冲突时并列来源和时间，不擅自选择有利数字。

## 广告方案确认门禁

调用 `prepare_keyword_campaign` 前必须同时满足：

- 已按目标站点显式查询正确region的广告profile，且方案中的profileId、region和marketplace严格一致。
- 已核验用户提供的竞品，或在未提供时自动发现竞品；新品至少反查1–2个最匹配TOP竞品的ABA/关键词脚印。
- 每个Exact词都有外部数据来源、数值型流量指标、指标周期和购买意图匹配结论；没有数值证据的直觉词不得进入Exact。
- 已按“同一ASIN、同一匹配方式默认合并”检查Campaign结构；例外拆分具有明确的风险、预算或实验理由。
- 已输出“关键词—来源—指标及周期—购买意图—商品匹配度—匹配方式”表，未把估算值冒充Amazon官方值。
- 已把竞品选择、全部关键词、Campaign拆分、日预算、竞价和创建后状态一次性交给用户，并收到对当前版本方案的明确确认。

任一项未通过时，只给方案和缺口，不prepare。用户确认后方案任一字段发生变化，必须展示新版本并重新确认。

## 写入边界

- “分析、优化、给方案、看看怎么投”均为只读，不自动prepare或写入。
- “新品开广告”“给方案然后开”“直接创建广告”只说明最终目标，不等于用户认可Agent生成的具体结构。先给完整方案并询问；用户明确确认当前版本后，才调用 `prepare_keyword_campaign`。
- “直接优化并生成审批”“能改的直接让我审批”等表达也不能跳过方案核对。先列出拟调整对象、依据和参数；用户确认后才调用匹配的 `prepare_*`。
- prepare返回待审预览后，再展示花费风险和完整内容，由用户决定是否在Cherry审批卡中批准正式 `apply_*`/`launch_*`。聊天确认不能替代审批卡。
- 用户明确要求创建或执行调整后，重新核实店铺、站点、SKU、活动/广告组身份、预算、竞价、关键词和目标状态。
- 完整手动关键词广告走 `prepare_keyword_campaign`；向已有活动追加词/商品走 `prepare_ads_campaign_extend`；批量竞价、预算、状态和否定词使用对应 `prepare_ads_*_batch`。
- 没有安全MCP时仅运行CLI `--dry-run`。展示完整预览和花费风险后，由运营本人在终端执行确认。
- Cherry正式工具必须逐次弹出审批卡并由真人批准；禁止自动批准或 `bypassPermissions`。
- 竞价、否定词、预算、状态和新Campaign分开prepare。没有利润率或目标ACOS时不准备扩预算；暂停/启用默认只建议，除非用户已明确允许状态调整。
- 多个新Campaign分别prepare和审批。批量优化可将同类改动合成一张批量预览，但不得把不同操作类型或不同店铺混进同一令牌。
- 当前CLI不能完整创建的自动定向或商品/竞品ASIN定向，只列为Seller Central人工项。
- 结果不明、部分成功或回读不一致时不自动重试，按`amz-cli`规则核对。

## 持续复盘

- 用户要求“持续优化”“到期复盘”“检查今天的任务”或完成一次已审批的广告调整后，读取 [references/review-cycle.md](references/review-cycle.md)。
- 分析和预览不等于已执行。只有正式写入成功且回读一致后，才写入本地复盘记录并启动第3/7/14天观察周期；仅给方案时不创建到期任务。
- 本地状态脚本在**本 skill 目录**下，不在项目仓库里。Cherry把skill安装到全局skills目录，因此路径**不是** `skills/amazon-ads-strategist/...`；调用时用本SKILL.md所在目录拼出绝对路径并加引号：`node "<本 skill 目录>/scripts/<脚本>.mjs" <子命令> ...`。相对路径 `node scripts/...` 会因当前工作目录不是skill目录而失败。
- 使用 `node "<本 skill 目录>/scripts/review-state.mjs"` 管理本地复盘记录。常规投放用默认的3/7/14节点；低销量长尾品创建时传 `--cadence low-volume` 生成7/30/90节点，并按 [references/low-volume.md](references/low-volume.md) 的累计点击门槛判断，不套用3/7/14的结论标准。该工具只保存运营元数据，不读取凭证，不调用Amazon，也不替代 `amz-cli` 的查询、预览、审批和回读。
- 使用 `node "<本 skill 目录>/scripts/scan-state.mjs"` 管理全店扫描批次。它只记录扫描ID、店铺、站点、ASIN顺序和处理状态，用于区分新候选、延续候选、阻断项和复盘中商品；不得把这些本地状态当成Amazon实时事实。
- 定时器只能唤醒或列出到期任务；不得在无人审批时执行 `apply_*`、`launch_*` 或CLI确认命令。

## 降级

任一外部MCP不可用时继续使用可用证据并降低置信度。两者都不可用时，不虚构搜索量、市场CPC、竞品流量或机会分数；已有广告仍可依本店真实数据诊断，新品只能给初步结构。
