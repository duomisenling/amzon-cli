# MCP职责与路由

## 本店事实

本店销量、销售额、Sessions、库存、Buy Box、Listing状态、广告花费、广告销售、订单、ACOS、CPC、CTR、CVR、Campaign和搜索词只以 `amz-cli` 的Amazon数据为准。每次调用显式带当前店铺；禁止跨五个店铺探测ASIN。

查询广告profile前，先由目标marketplace确定广告region，并始终显式执行 `amz-cli ads profiles --account <店铺> --region <na|eu|fe>`。当前CLI已知映射为NA：US/CA/MX/BR；EU：UK/GB/DE/FR/IT/ES；FE：JP/AU/SG仅在CLI已支持该marketplace时使用。其他站点先按CLI当前marketplace映射或帮助核实，不猜region。`prepare_keyword_campaign`/`launch_keyword_campaign` 的profileId、region和marketplace必须来自同一区域；例如DE必须使用 `--region eu` 返回的profileId。

## 市场研究MCP

Sorftime、SIF和Cherry运行时提供的其他相关只读MCP用于：关键词需求与趋势、竞品发现、流量词、市场CPC、竞争度和推广可行性。它们不能证明本店实际销量、实际广告订单或利润。

新品快速开广告时，市场MCP只研究市场/关键词/竞品：从本店Listing提取种子词，发现市场词和竞品ASIN，再反查竞品。除非用户明确要求分析本品收录或自然流量词，否则禁止用Sorftime/SIF反查本店新品ASIN；也禁止用这些MCP检查本店广告是否存在。

调用顺序：

1. 全店筛选任务先用本店数据缩到最多20个候选；用户直接给新品ASIN时跳过筛选和广告历史调查。
2. 按品类、核心搜索意图和站点分组。
3. 每组先用最少调用取得核心市场词和竞品，复用重复关键词与竞品结果。
4. 仅反查已确认的竞品ASIN；只有证据不足时才追加机会筛选，足以决策后停止。
5. 记录工具、站点、查询对象和时间；不同来源冲突时并列展示。

工具名称和参数以Cherry当前工具schema为准。文档中的Sorftime/SIF工具名只是常见示例；不存在时不得猜造调用。外部MCP不得接收Amazon密钥、refresh token、cookie、完整成本表或与任务无关的敏感经营数据。

## Amazon写入MCP

广告正式修改只走项目自带的安全 `prepare_*` → Cherry审批 → `apply_*`/`launch_*`。市场研究MCP没有Amazon写权限，也不得被当作审批通道。

- 用户只说分析/给方案：只读，不prepare。
- 用户说新品开广告、创建广告、方案后开或直接优化：先输出竞品、关键词证据、Campaign拆分、预算、竞价和最终状态，询问是否确认当前版本；创建意图不能替代结构确认。
- 用户明确确认当前方案后才prepare。prepare后展示待审预览与花费风险；正式launch/apply仍须Cherry真人审批。
- 方案在确认后发生任何变化，废弃旧确认和旧preview，重新展示并询问；不得连续prepare多个试探版本。
- prepare返回的是待审预览，不代表已执行。
- 正式工具逐次弹出审批卡，禁止自动批准和 `bypassPermissions`。
- apply后必须回读；结果不明不自动重放。

## 降级

- 一个市场MCP失败：使用其他可用来源，降低置信度。
- 所有市场MCP失败：已有广告仍可用本店数据诊断；不虚构市场需求、CPC或竞品流量。
- 销售与流量报告权限不足：不声称完成全店筛选，改为用户给ASIN或从广告/库存候选开始。
- 安全写入MCP缺失：只生成CLI `--dry-run`，正式确认交给运营本人。
