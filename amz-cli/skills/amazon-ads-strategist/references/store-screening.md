# 全店差商品广告筛选

## 目标

用户不提供ASIN时，从一个已明确的店铺和站点筛出最多20个需要进一步解释的商品，再判断广告是否是主要问题。候选是诊断入口，不是自动处罚清单。

## 1. 本店候选

优先运行：

```powershell
amz-cli --account <店铺> sales product-performance --marketplace <站点> --days 30 --limit 20
```

默认以昨天（UTC）为最后一个完整日期，比较两个相邻的30天等长周期，使用Amazon `GET_SALES_AND_TRAFFIC_REPORT` 的子ASIN数据。被子体引用的父ASIN汇总行会排除。候选原因：

- `sales-decline`：前期至少3件，当前销量相对下降至少30%。
- `traffic-no-conversion`：当前至少20 Sessions但销量为0。
- `conversion-decline`：前后两期均至少20 Sessions，单位访问转化率相对下降至少30%。
- `buybox-decline`：当前至少20 Sessions，Buy Box比例下降至少20个百分点。

这些是默认粗筛门槛，可按公司策略调整。不得把候选分数称为健康分、利润分或广告优化优先级。

补充候选：

- `inventory slow-moving`：发现有货但可售天数过长的商品。
- `ads performance`：发现高ACOS或有花费零销售的Campaign/广告组。
- `ads wasted-spend`：只作为搜索词候选入口。

月销约0–5单的长尾品达不到 `--min-prior-units 3` 和 `--min-sessions 20` 的默认门槛，结构上不会出现在候选里。运营点名要给这类商品投广告时，改从 `inventory slow-moving` / `inventory aged` 取，或直接使用运营给出的ASIN列表，并转 [low-volume.md](low-volume.md)；不得把这种列表说成是全店销量筛选的结果。

`sales product-performance` 权限不足或报告不可用时，明确降级为用户提供1–20个ASIN，或只分析广告/库存命中的候选；不得宣称完成了全店销售筛选。

## 1.1 批次连续性

命令返回 `scanId`、`asOf`、`totalCandidates`、`offset`、`hasMore` 和 `nextOffset`。一次只诊断最多20个ASIN，但不必为下一批重跑全新逻辑：

1. 首批固定返回的 `asOf` 和门槛。若 `hasMore=true`，用相同店铺、站点、`--as-of` 和门槛，传 `--offset <nextOffset> --limit 20` 获取下一批。
2. 每次把本页ASIN登记到本地扫描记录；同一个 `scanId` 会合并后续页，不会重复创建：

```powershell
node "<本 skill 目录>/scripts/scan-state.mjs" create --scan-id <scanId> --account <店铺> --marketplace <站点> --as-of <asOf> --asins <本页ASIN列表> --offset <offset> --total-candidates <totalCandidates>
node "<本 skill 目录>/scripts/scan-state.mjs" next --scan-id <scanId> --account <店铺> --marketplace <站点> --limit 20
```

3. 完成诊断、预览或执行后更新本批状态：

```powershell
node "<本 skill 目录>/scripts/scan-state.mjs" mark --scan-id <scanId> --account <店铺> --marketplace <站点> --asins <ASIN列表> --status diagnosed --note <摘要>
```

状态可用 `diagnosed / prepared / applied / blocked / reviewing / improved / deferred`。`next` 只返回 `new / continued`，因此不会把已处理、阻断或复盘中的商品反复交给运营。五店环境下，即使不同店铺产生相同 `scanId`，状态记录也按店铺和站点隔离；`next / mark / show` 始终显式传店铺和站点。

“继续这一批”使用当前 `scanId`；“重新扫描店铺”不复用旧 `asOf`，允许滚动窗口产生新排名。新扫描中再次出现的未处理商品标记 `continued`，已执行或复盘中的商品标记 `reviewing`，阻断项保留 `blocked`。本地状态只用于排队，每次判断仍须重新查询Amazon事实。

## 2. 阻断检查

对候选批量解析ASIN→唯一SKU，再检查可售性、Listing issues、库存和Buy Box：

- 不可售、被压制、严重错误：先修Listing，不扩广告。
- 库存不足或补货风险：不扩预算和竞价。
- Buy Box明显下降或丢失：标记为非广告主因，不用加广告掩盖。
- 多SKU映射或共享Campaign归属不清：暂停该对象的写入预览。

止损类广告动作仍可研究，但必须说明它们是在控制浪费，不是在解决根因。

## 3. 广告根因

只有映射到有效广告对象后才进入广告诊断：

- 流量下降、市场需求稳定且广告曝光/点击同步下降：研究覆盖、预算和竞价。
- 流量充足但多个高相关词普遍不转化：优先标记Listing/价格/Review承接问题。
- 广告浪费集中在少数不相关搜索词：研究否定词与匹配方式。
- 健康转化词受预算限制：经济边界验证后才研究扩量。
- 没有有效广告：根据商品阶段转新品/冷启动方案，不把“没广告”自动判成错误。

## 4. 市场解释

对优先候选按品类和搜索意图分组，再调用Sorftime、SIF或其他只读市场MCP：

- 本店下降、市场需求稳定：更可能是本店广告覆盖、竞争或承接问题。
- 本店与核心词市场需求同时下降：标季节性/需求风险，不盲目提价或加预算。
- 市场词存在但本店无覆盖：进入关键词扩展研究。

第三方估算不得替代本店销量。相同品类、关键词和竞品结果在本轮复用，不为20个ASIN机械重复调用。

## 5. 输出与分流

先输出候选总览：ASIN、当前/前期指标、候选原因、阻断项、广告覆盖、市场方向和置信度。随后分为：

- 广告可优化：进入 `optimize-existing.md`。
- 新品/无有效广告：进入 `campaign-plan.md`。
- 非广告主因：列出原因，不生成扩量动作。
- 数据不足：继续观察或请求最少补充信息。

用户已明确要求“直接生成审批”时，只对广告可优化且对象身份、样本和目标值均明确的动作prepare。
