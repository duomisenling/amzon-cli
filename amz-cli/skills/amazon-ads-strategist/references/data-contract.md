# 数据来源与证据契约

## 本店事实：amz-cli

只用 `amz-cli` 判断本店销量、订单、广告花费、广告销售额、ACOS、CPC、CTR、CVR、搜索词转化、库存、Listing、Buy Box 和实际投放结构。常用命令按需要最小调用：

- `listing mine/sku/issues/images`
- `aplus coverage`、`pricing buybox`、`inventory list`、`sales stats`、`sales product-performance`
- `ads profiles/campaigns/keywords/product-ads/coverage/performance/report-run/wasted-spend`

不要用 Sorftime/SIF 的估算销量代替本店销量。

### 按路由取数

- 新品快速开广告：最低契约是店铺、站点、一次批量ASIN→唯一SKU映射、Listing基本事实，以及必要时一次硬阻断补查。默认不需要本店销量、费用、广告覆盖、Campaign、关键词、搜索词或历史报表。
- 已有广告优化：按目标读取广告结构、表现和搜索词证据，不因命令可用就全部调用。
- 全店筛选：按筛选流程读取销售/流量候选；候选进入新品路径后仍遵守新品最低契约。
- 市场MCP永远不承担本店事实查询；安全写入MCP只负责prepare、审批后的apply/launch和回读。

## 外部市场信号：Sorftime/SIF

用于发现和交叉验证竞品ASIN反查词、延伸词、搜索需求、趋势、竞争、市场 CPC、核心词搜索结果竞品、竞品流量结构和关键词推广可行性。新品默认不反查本店ASIN；只有用户明确要求分析本品收录/流量词时才这样做。

Sorftime 常见能力可能显示为 `product_traffic_terms`、`keyword_extends` 等；SIF 常见工具包括 `market_get_asin_keyword_signals`、`market_screen_keyword_opportunities`、`market_discover_competitors`、`market_get_keyword_root_competitors` 和 `market_assess_keyword_promotion`。始终以 Cherry 实时工具 schema 为准。

## 工具选择

1. 先用少量核心查询取得候选词与竞品，不对每个词逐个重复查。
2. 对最终候选批量补充搜索量、趋势、竞争和 CPC；复用本轮已有结果。
3. 两家指标不直接相加。保留来源，在各自数据源内做高/中/低或分位数归一化。
4. 口径、站点或更新时间不同造成冲突时，并列展示并降低置信度。
5. 工具报权限、额度或连接错误时原样说明，不换用猜测值。

## 置信度

- 高：本店事实充分，两个市场来源方向一致。
- 中：本店事实充分，但仅一个市场来源可用或两者部分冲突。
- 低：新品无历史数据、市场数据缺失或关键成本未知。
