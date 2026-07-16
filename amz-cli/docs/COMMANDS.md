# amz-cli 命令使用手册

给运营同事和 AI Agent 看的完整命令说明。所有命令的输出都是 JSON(stdout),进度和错误在另一个通道(stderr),Agent 和自动化脚本可以放心解析。

> 开发阶段运行方式:`npx tsx src/cli.ts <命令>`(在项目目录下)。
> 正式发布后:`amz-cli <命令>`。下文示例统一用 `amz-cli` 开头。

---

## 目录

- [快速开始](#快速开始)
- [基础概念(先读这个)](#基础概念先读这个)
- [命令总览](#命令总览)
- [账号与凭证 auth / ads auth](#账号与凭证)
- [商品 listing](#商品-listing)
- [订单 orders](#订单-orders)
- [销售统计 sales](#销售统计-sales)
- [库存 inventory](#库存-inventory)
- [费用预估 fees](#费用预估-fees)
- [货件 shipments](#货件-shipments)
- [报告 report](#报告-report)
- [卖家反馈 feedback](#卖家反馈-feedback)
- [价格战情报 pricing](#价格战情报-pricing)
- [批量修改 feed(写)](#批量修改-feed写)
- [广告 ads](#广告-ads)
- [写操作怎么执行(必读)](#写操作怎么执行必读)
- [报错了怎么办](#报错了怎么办)

---

## 快速开始

```powershell
# 1. 验证凭证是否配置正确(第一条命令永远跑这个)
amz-cli auth whoami

# 2. 查最近 7 天卖了多少
amz-cli sales stats --marketplace US --days 7 --granularity Total

# 3. 看看 FBA 库存还剩多少
amz-cli inventory list --marketplace US
```

## 基础概念(先读这个)

**市场代号**:`--marketplace` 用国家码,当前支持 `US / CA / MX / BR / UK / DE / FR / IT / ES`。

**跨区域(北美 + 欧洲)**:命令按 `--marketplace` 自动路由区域——查 `DE` 自动用欧洲端点和欧洲凭证,无需任何切换动作。前提是 `.env` 里配了对应区域的 token(`LWA_REFRESH_TOKEN_EU` 等);没配时会明确提示。按订单号/报告号查询的跟进命令(orders get、report status 等)查欧洲数据时带上可选的 `--marketplace DE`。

**多账号(店铺)**:所有命令支持全局 `--account <名称>` 切换账号:
- 本地模式:凭证读 `~/.amz-cli/accounts/<名称>.env`(格式同 `.env.example`,每个店铺一份);
- Broker 模式:直接切换店铺代号,权限由 Broker 端的 TEAM_ACCESS 策略控制;
- 不传 `--account` = 用项目目录的默认 `.env`,行为与从前完全一致;
- 账号不存在会**明确报错**,绝不会静默用默认凭证冒充所选账号。

```powershell
amz-cli sales stats --account shop-b --marketplace US --days 7
```

**只读 vs 写操作**:
- 绝大多数命令是**只读**的——查数据,不改任何东西,随便跑。
- 带 🔒 标记的是**写操作**——会修改亚马逊后台。写操作有强制的两步流程(先 `--dry-run` 预览并取得一次性令牌,再人工在终端用 `--confirm --preview-token <令牌>` 执行)。普通非交互 Agent 会被 CLI 拒绝,详见[写操作怎么执行](#写操作怎么执行必读)。

**数据边界**:
- 公开数据(商品目录、Buy Box 报价)任何商品都能查,包括竞品;
- 私有数据(订单、库存、listing)只能查自己店铺的;
- 买家的姓名/地址/邮箱在任何输出里都不会出现(合规要求,程序层面剥离);
- BSR 是排名不是销量;任何卖家的销量数字都查不到。

**沙盒模式**:仅本地凭证模式可在 `.env` 里设 `SP_API_SANDBOX=true`，所有 SP-API 调用走亚马逊沙盒。Broker 协议暂不支持沙盒；同时设置 `BROKER_URL` 和 `SP_API_SANDBOX=true` 时 CLI 会安全拒绝，绝不会回退到生产端点。

**网络超时与重试**:

- Broker/LWA 换令牌最长等 30 秒，普通 SP-API/Ads API 请求最长等 60 秒，Feed 上传和报告下载最长等 120 秒；达到时限只停止本次客户端请求，不代表 Amazon 一定没有收到请求。
- 429 限流和安全的只读 GET/HEAD 遇到临时故障可以自动退避重试。
- POST/PUT 写请求遇到 5xx 不自动重放。此时结果可能已经生效，必须先用只读命令或 Seller Central/广告后台核对，确认未生效后再决定是否重新执行。

---

## 命令总览

| 域 | 命令 | 说明 | 读/写 |
|---|---|---|---|
| auth | `whoami` | 验证凭证,列出参与的市场 | 读 |
| listing | `search` | 搜索亚马逊公开商品目录(含竞品) | 读 |
| listing | `get` | 按 ASIN 查商品公开详情(图片/BSR) | 读 |
| listing | `mine` | 列出自己店铺的 listing | 读 |
| listing | `sku` | 查自己单个 SKU 的完整 listing | 读 |
| listing | `update` | 编辑 listing(价格/图片等) | 🔒 写 |
| orders | `list` | 订单列表(状态/金额/件数) | 读 |
| orders | `get` | 单订单状态 | 读 |
| orders | `items` | 订单商品明细(SKU/数量/单价) | 读 |
| sales | `stats` | 销售统计(按天/周/月聚合) | 读 |
| inventory | `list` | FBA 实时库存(秒回) | 读 |
| fees | `estimate` | 费用预估(佣金+FBA 费) | 读 |
| shipments | `list` | FBA 货件列表与状态 | 读 |
| shipments | `items` | 货件明细(发了多少收了多少) | 读 |
| report | `types` | 列出常用报告类型 | 读 |
| report | `create / status / download` | 报告分步操作 | 读 |
| report | `run` | 报告一条龙(发起→等待→下载) | 读 |
| feedback | `run` | 卖家差评/中评报告 | 读 |
| pricing | `competitive` | 任意 ASIN 的 Buy Box/报价概览 | 读 |
| pricing | `foep` | 自己 SKU 的 Buy Box 预期价 | 读 |
| feed | `submit` | Feed 批量修改 | 🔒🔒 写(不可撤销) |
| feed | `status / result` | Feed 进度与处理结果 | 读 |
| ads | `auth-url / auth-exchange` | 广告授权辅助(管理员一次性；exchange 只允许交互终端) | 敏感管理 |
| ads | `profiles` | 广告账户列表(拿 profileId) | 读 |
| ads | `campaigns` | 广告活动列表 | 读 |
| ads | `keywords` | 投放的关键词列表 | 读 |
| ads | `report-run / report-status` | 广告报表(5 种预设) | 读 |
| ads | `campaign-create` | 创建广告活动 | 🔒 写 |
| ads | `campaign-state` | 启用/暂停广告活动 | 🔒 写 |
| ads | `campaign-budget` | 调整日预算 | 🔒 写 |
| ads | `keyword-bid` | 调整关键词竞价 | 🔒 写 |
| ads | `negative-keyword` | 添加否定关键词 | 🔒 写 |
| ads | `test-account-create / status` | 广告测试账户(沙盒) | 🔒 写 / 读 |

---

## 账号与凭证

### auth whoami — 验证凭证

装好 CLI 后的第一条命令。凭证、网络、权限任何一环有问题,这里最先暴露。

```powershell
amz-cli auth whoami
```

返回该账号参与的所有市场。`isSalesChannel: true` 的是真实销售站点,false 的是亚马逊内部市场(忽略即可)。

### ads auth-url / auth-exchange — 广告授权(管理员一次性操作)

广告 API 与 SP-API 是两套凭证。首次接入广告时由管理员执行,详见输出里的分步指引:

```powershell
amz-cli ads auth-url                      # 生成授权链接,浏览器打开授权
amz-cli ads auth-exchange --code <授权码>  # 换 refresh token(输出含敏感令牌,自己跑,勿外发)
```

需要创建广告测试账户时，授权链接必须额外申请测试 scope：`amz-cli ads auth-url --test-account`。`auth-exchange` 会处理长期凭证，Agent、n8n 和非交互管道会被 CLI 拒绝。

---

## 商品 listing

### listing search — 搜索商品目录(任意商品,含竞品)

```powershell
# 关键词搜索
amz-cli listing search --marketplace US --keywords "dog bed" --page-size 10
# 按 ASIN 批量查(最多 20 个)
amz-cli listing search --marketplace US --asins "B0XXXXXXXX,B0YYYYYYYY"
# 按品牌过滤
amz-cli listing search --marketplace US --keywords "pet fence" --brand "某品牌"
```

| 参数 | 说明 |
|---|---|
| `--marketplace` | 必填,国家码 |
| `--keywords` / `--asins` | 二选一,各最多 20 个(逗号分隔) |
| `--include` | 额外数据集:`images`(图片)`salesRanks`(BSR 排名)等 |
| `--page-size` | 每页 1-20,默认 10;翻页用 `--page-token` |

注意:查的是**公开目录信息**(等于商品页上任何人可见的内容);拿不到任何卖家的销量/库存。

### listing get — 单个商品详情

```powershell
amz-cli listing get --marketplace US --asin B0XXXXXXXX --include summaries,images,salesRanks
```

返回标题/品牌/型号/主图链接/大类小类 BSR 排名。**BSR 是排名不是销量**。

### listing mine — 自己店铺的 listing 列表

```powershell
amz-cli listing mine --marketplace US
# 只看有问题的 listing
amz-cli listing mine --marketplace US --with-issue-severity ERROR
```

需要卖家编号:在 `.env` 配置 `SELLER_ID=...`(或每次传 `--seller-id`)。

### listing sku — 自己单个 SKU 详情

```powershell
amz-cli listing sku --marketplace US --sku "你的SKU"
```

返回该 SKU 的状态、问题列表、报价、库存可用性;加 `--include attributes,productTypes` 可看完整属性(编辑前先看这个)。

### listing schema — 查产品类型能填哪些字段(编辑 listing 前先看这个)

```powershell
# 先查某 SKU 的产品类型
amz-cli listing sku --marketplace US --sku "你的SKU" --include productTypes
# 再查这个产品类型的最新 schema(所有可填字段)
amz-cli listing schema --marketplace US --product-type ROTATING_TRAY
# 只找标题/亮点相关字段
amz-cli listing schema --marketplace US --product-type ROTATING_TRAY --grep title
# 看某个字段的完整定义(结构/规则/字数限制)
amz-cli listing schema --marketplace US --product-type ROTATING_TRAY --attribute item_name
```

拉的是亚马逊**最新、卖家专属**的 schema(自动带上 .env 里的 SELLER_ID)。编辑 listing 前先用它拿到字段的确切名字和结构,再用 `listing update` 照着改,避免凭空拼错被拒。

两个进阶参数:
- `--requirements-enforced`:默认 `NOT_ENFORCED`(适合改单个字段的局部 patch,不把完整提交的全部必填约束套上来);要检查完整提交时显式传 `ENFORCED`;
- `--parentage-level`:有变体时传 `NONE / CHILD / PARENT`,拿到对应层级更准确的结构。

**常见字段对照(最终以你的产品类型 schema 实际返回为准,不同类型可能不同)**:
- 标题 = `item_name`
- 五点/卖点 = `bullet_point`
- 商品亮点(Item Highlights)按市场和产品类型逐步开放——某产品类型实测字段名为 `title_differentiation`(标题少于 75 字符时才显示,填卖点短语、别重复标题),**其他类型务必先 `--grep title` / `--grep highlight` 查到再用**,查不到 = 该类型还没开放

### listing update 🔒 — 编辑 listing

```powershell
# 第一步:预览(会先拉当前值做对照,再调亚马逊官方校验,不落库)
amz-cli listing update --marketplace US --sku "你的SKU" --product-type <产品类型> --patches "<JSON Patch 数组>" --dry-run
# 第二步:人工核对预览后,在终端执行
amz-cli listing update ... --confirm --preview-token <preview_token>
```

`--product-type` 用 `listing sku --include productTypes` 查;`--patches` 是 JSON Patch 格式(让 Agent 帮你拼,人只负责核对预览)。

两个实测过的坑:
- **预览报 8560(信息不足以匹配 ASIN)**:如果你的 SKU 是挂靠型 listing(卖家数据层只有报价/图片,没有标题品牌),patch 里加一条 `{"op":"add","path":"/attributes/merchant_suggested_asin","value":[{"marketplace_id":"...","value":"该SKU自己的ASIN"}]}` 即可通过;
- **商品亮点报 100476**:亚马逊强制"标题 ≤75 字符才能用 Item Highlights"——想加亮点,先把 `item_name` 压到 75 字符以内(这不只是展示规则,校验层直接拦)。

---

## 订单 orders

```powershell
# 最近 7 天订单(默认);--days 换时间;--status 过滤状态
amz-cli orders list --marketplace US --days 30 --status Unshipped,Shipped
# 单订单状态
amz-cli orders get --order-id 111-1234567-1234567
# 订单买了什么(SKU/数量/单价)
amz-cli orders items --order-id 111-1234567-1234567
# 返回 nextToken 时继续取下一页
amz-cli orders items --order-id 111-1234567-1234567 --next-token <nextToken>
```

订单状态可选:`Pending / Unshipped / PartiallyShipped / Shipped / Canceled / Unfulfillable / PendingAvailability / InvoiceUnconfirmed`。

**输出永远不含买家姓名/地址/邮箱**(程序层白名单剥离,合规要求)。

---

## 销售统计 sales

### sales stats — 日报/周报一条命令

```powershell
# 最近 30 天,按天(默认)
amz-cli sales stats --marketplace US
# 最近 7 天合计
amz-cli sales stats --marketplace US --days 7 --granularity Total
# 某个 ASIN 的月度走势
amz-cli sales stats --marketplace US --asin B0XXXXXXXX --granularity Month --days 90
# 只看 FBA 订单
amz-cli sales stats --marketplace US --fulfillment AFN
```

返回每个时段的:订单数、销量、销售额、客单价,外加汇总。`--granularity` 可选 `Hour / Day / Week / Month / Year / Total`。

---

## 库存 inventory

### inventory list — FBA 实时库存(秒回,不用等报告)

```powershell
amz-cli inventory list --marketplace US
# 只查指定 SKU(最多 50 个)
amz-cli inventory list --marketplace US --skus "SKU1,SKU2"
```

每个 SKU 返回:可售(fulfillable)、在途(inbound)、预留(reserved)、不可售(unfulfillable)。
注意:翻页的 `nextToken` **只有 30 秒有效**,拿到要立即用。

---

## 费用预估 fees

### fees estimate — 卖这个价,亚马逊抽多少?

```powershell
amz-cli fees estimate --marketplace US --asin B0XXXXXXXX --price 19.99
# 按自己 SKU 估;--fbm 按自发货估(默认按 FBA)
amz-cli fees estimate --marketplace US --sku "你的SKU" --price 19.99 --fbm
```

返回:总费用、逐项明细(佣金 ReferralFee / FBA 配送费 FBAFees 等)、**售价减费用后的到手金额**(不含货物成本和头程)。改价前配合 `pricing foep` 用:先看降到多少能拿 Buy Box,再算那个价还赚不赚。

---

## 货件 shipments

```powershell
# 进行中的货件(默认列 WORKING 到 RECEIVING 全部进行中状态)
amz-cli shipments list --marketplace US
# 按货件编号查
amz-cli shipments list --marketplace US --shipment-ids FBA15XXXXXX
# 货件明细:每个 SKU 发了多少、亚马逊收了多少
amz-cli shipments items --shipment-id FBA15XXXXXX
# 列表或明细返回 nextToken 时继续翻页
amz-cli shipments list --marketplace US --next-token <nextToken>
amz-cli shipments items --shipment-id FBA15XXXXXX --next-token <nextToken>
```

`shipments items` 的"发/收"对比可以直接发现少收多收。货件的**确认/取消**操作(不可撤销)本期不开放,请在 Seller Central 操作。

---

## 报告 report

### report run — 一条龙(推荐)

```powershell
amz-cli report run --type GET_MERCHANT_LISTINGS_ALL_DATA --marketplace US
# 大报告存文件
amz-cli report run --type GET_MERCHANT_LISTINGS_ALL_DATA --marketplace US --out D:\报告.tsv
```

发起 → 每 15 秒查一次进度 → 生成后自动下载解析。`--timeout` 单位为分钟，默认 10，只接受 1–60 的有限数字；`NaN`、`Infinity`、0 和超过 60 的值会在发出 API 请求前被拒绝。达到等待时限只停止本次轮询，不会取消 Amazon 服务端的报告；保留 `reportId`，稍后用 `report status` / `report download` 继续处理。

### report types / create / status / download — 分步操作

```powershell
amz-cli report types                                  # 看有哪些常用报告类型
amz-cli report create --type <类型> --marketplace US   # 发起,立即返回 reportId
amz-cli report status --report-id <编号>               # 查进度
amz-cli report download --report-id <编号>             # DONE 后下载
```

适合 Agent 处理超长报告:先 create,过几分钟再来取,不用挂着等。

**已知注意事项**:
- FBA 库存类报告(`GET_FBA_MYI_*`)必须有开始时间——CLI 会自动补 24 小时前,不用你操心;
- **同类型报告短时间内重复请求会被亚马逊拒绝(FATAL)**,等几小时再试;
- 报告显示 CANCELLED 通常表示"该时间段没有数据",不一定是故障。

---

## 卖家反馈 feedback

```powershell
amz-cli feedback run --marketplace US --days 90
```

返回最近 N 天的**1-3 星差评和中评**。拿不到 4-5 星好评——这是亚马逊 API 的限制。没有差评时报告会是 CANCELLED(好事)。

---

## 价格战情报 pricing

### pricing competitive — 任意 ASIN 的 Buy Box 概况

```powershell
amz-cli pricing competitive --marketplace US --asins "B0XXXXXXXX,B0YYYYYYYY"
```

返回每个 ASIN 的 Buy Box 状况、参考价、Prime/非 Prime 客群占比。竞品也能查(公开信息)。一次最多 20 个。

### pricing foep — 自己 SKU 的 Buy Box 预期价

```powershell
amz-cli pricing foep --marketplace US --skus "你的SKU"
```

亚马逊官方给出的"降到什么价位有望拿到 Buy Box"。`OFFER_NOT_FOUND` 表示该 SKU 当前没有参与竞价的活跃报价(正常业务结果)。

---

## 批量修改 feed(写)

### feed submit 🔒🔒 — 不可撤销,门槛最高

```powershell
# 预览:只做本地 TSV 格式检查与内容摘要,不上传到亚马逊
amz-cli feed submit --marketplace US --type POST_FLAT_FILE_INVLOADER_DATA --file D:\库存.tsv --dry-run
# 执行:必须人工在终端跑,输入屏幕上的随机 6 位确认码
amz-cli feed submit ... --confirm --preview-token <preview_token>
```

dry-run 不代表亚马逊已经完成业务校验；正式提交后才会由 Amazon 解析各行。**Feed 一旦处理完成无法撤回**,只能再提交一次覆盖，所以执行要求预览令牌和随机确认码。

```powershell
amz-cli feed status --feed-id <编号>    # 查处理进度
amz-cli feed result --feed-id <编号>    # 看哪些行成功/失败及原因
```

---

## 广告 ads

> 广告命令需要单独的广告 API 凭证(`.env` 里的 `ADS_*`),与 SP-API 凭证不通用。
>
> **查欧洲广告**:广告凭证全区域通用,不需要新授权——任何 ads 命令加 `--region eu` 即可。注意 profileId 是分区域的:先 `ads profiles --region eu` 拿欧洲账户的 profileId,后续命令配同样的 `--region eu` 使用。

### 读:账户 / 活动 / 关键词

```powershell
amz-cli ads profiles                                       # 广告账户列表,拿 profileId(第一步)
amz-cli ads campaigns --profile-id <ID> --state ENABLED    # 正在投放的广告活动
amz-cli ads keywords --profile-id <ID> --campaign-id <ID>  # 某活动投的词(含竞价)
```

### 读:广告报表(5 种预设)

```powershell
amz-cli ads report-run --profile-id <ID> --type <预设> --start 2026-07-01 --end 2026-07-13
```

| `--type` | 内容 | 回答什么问题 |
|---|---|---|
| `campaigns`(默认) | 花费日报 | 每天每个活动花多少、带来多少单 |
| `search-terms` | 买家搜索词 | 顾客搜什么词找到我的广告 |
| `targeting` | 关键词表现 | 我投的词哪个赚哪个亏 |
| `advertised-products` | 广告商品 | 哪个产品的广告在赚钱/烧钱 |
| `purchased-products` | 购买商品 | 点了广告最后买走了什么 |

报表在亚马逊侧排队，可能要几分钟到几十分钟。`--timeout` 单位为分钟，默认 10，只接受 1–60 的有限数字；超时只停止本次轮询，不会取消服务端报告。用 `amz-cli ads report-status --profile-id <ID> --report-id <编号>` 继续查询；完成响应会保留 Amazon 返回的下载信息。当前版本没有按既有 `reportId` 单独下载的 `ads report-download` 命令，重新运行 `ads report-run` 会创建新报告，不是恢复原任务。

### 写 🔒:建广告 / 启停 / 调预算 / 调竞价 / 否定词

```powershell
# 建广告活动(默认创建为暂停状态,不花钱;启用必须另走 campaign-state 的独立预览)
amz-cli ads campaign-create --profile-id <ID> --name "活动名" --targeting-type AUTO --daily-budget 10 --start 2026-08-01 --dry-run
amz-cli ads campaign-create ... --confirm --preview-token <preview_token>

# 暂停/启用某个广告活动
amz-cli ads campaign-state --profile-id <ID> --campaign-id <ID> --state PAUSED --dry-run
amz-cli ads campaign-state ... --confirm --preview-token <preview_token>

# 调日预算(dry-run 显示"当前 → 新"对照)
amz-cli ads campaign-budget --profile-id <ID> --campaign-id <ID> --daily-budget 15 --dry-run
amz-cli ads campaign-budget ... --confirm --preview-token <preview_token>

# 调关键词竞价(dry-run 显示"当前 → 新"对照)
amz-cli ads keyword-bid --profile-id <ID> --keyword-id <ID> --bid 1.2 --dry-run
amz-cli ads keyword-bid ... --confirm --preview-token <preview_token>

# 否定某个搜索词(不再触发广告,省废流量的钱)
amz-cli ads negative-keyword --profile-id <ID> --campaign-id <ID> --ad-group-id <ID> --text "废词" --dry-run
amz-cli ads negative-keyword ... --confirm --preview-token <preview_token>
```

典型广告优化循环:`report-run --type search-terms` 找废词 → `negative-keyword` 否掉 / `keyword-bid` 降竞价 / `campaign-budget` 给表现好的加预算。

### 广告沙盒:测试账户

```powershell
amz-cli ads auth-url --test-account          # 管理员首次授权时申请测试账户 scope
amz-cli ads test-account-create --dry-run   # 然后 --confirm --preview-token <preview_token>
amz-cli ads test-account-status
```

测试账户里的广告**不投放、不花钱**,写操作先在这里验证。

---

## 写操作怎么执行(必读)

> ⚠️ **写操作只能用编译版执行**:先 `npm run build`,再用 `node dist/cli.js ...`。
> 开发用的 `npx tsx src/cli.ts` 会吞掉终端确认输入、让门槛失效,所以 CLI **主动禁止**在这种模式下执行写操作(会报 `dev_mode_write_forbidden`)。
> 同事使用的正式版(`npm install -g` 装的)本来就是编译版,天然安全,这条只影响开发者本机测试。

所有 🔒 写操作遵循同一个铁律,**任何一步都不能跳过**:

```
第 1 步  --dry-run 预览            ← Agent 可以代跑,输出"将改什么"和 preview_token
第 2 步  人工核对预览               ← 人看;令牌 15 分钟有效
第 3 步  人工在 PowerShell 终端运行 --confirm --preview-token <令牌>
         → 屏幕复述:"将对 XX 做 XX(后果)"
         → 普通写操作:输入 y 确认
         → 不可撤销操作(feed submit):输入屏幕上的随机 6 位确认码
```

`preview_token` 只能使用一次，并绑定预览时的命令、全部业务参数、Feed/patch 文件内容哈希，以及当前 `BROKER_URL`、店铺、Seller ID、SP/Ads 区域、Client ID 和凭证哈希。敏感凭证明文不会写入令牌记录。缺少令牌、令牌过期、已经使用、确认命令改变业务参数、输入文件变化或运行环境切换，CLI 都会拒绝执行并要求重新预览。

**普通非交互 Agent、n8n、管道带 `--confirm` 会被 CLI 拒绝**。Agent 的正确做法是运行 dry-run，把预览和带令牌的最终命令交给人。

安全边界说明：TTY、确认码和本地 preview token 主要防误操作，不能证明终端背后一定是真人，也不能阻止同权限恶意程序伪造本地状态或直接使用 Amazon bearer token。生产环境若要求“Agent 技术上绝不能写”，必须使用独立只读 Amazon 凭证，或由隔离的审批代理持有写凭证并代理写请求。

另一道保险:广告创建默认是**暂停状态**,就算确认执行了也不花钱,启用才开始投放。

---

## 报错了怎么办

所有错误输出到 stderr,JSON 格式,`hint_human` 字段是中文人话说明,先看它。

| exit code | 错误 type | 意思 | 通常怎么办 |
|---|---|---|---|
| 2 | invalid_param | 参数传错了 | 按 `hint_human` 改参数 |
| 3 | auth_expired / insufficient_scope | 凭证过期或权限不够 | 联系管理员 |
| 4 | rate_limited | 接口繁忙(已自动重试过) | 过几分钟再试 |
| 1 | upstream_error | 网络或亚马逊侧出错 | 只读请求可按提示重试；写请求先核对是否已生效 |
| 10 | confirmation_required | 写操作没走确认流程 | 按提示先 dry-run,人工执行 |
| 5 | internal | CLI 自身 bug | 把完整报错发给管理员 |

常见情况速查:

- **所有命令突然全部报 auth_expired**:大概率是年度授权到期(SP-API 自我授权的 refresh token 一年一续),管理员去开发者中心重新授权即可;
- **ads 命令报 401/403**:广告凭证问题(没准入/权限不对),见 `hint_human` 指引;
- **报告 FATAL**:看提示——通常是缺开始时间(CLI 已自动处理)或短时间内重复请求了同类型报告(等几小时);
- **限流(429)**:CLI 内置自动退避重试,一般无感;报出来说明重试也没救,等几分钟;
- **`write_result_unknown` 或写请求网络超时**:不要直接重试。Amazon 可能已经执行成功，先用状态/列表查询或后台核对，确认未生效后再决定是否重新走预览和人工确认。
