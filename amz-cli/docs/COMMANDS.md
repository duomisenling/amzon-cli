# amz-cli 命令使用手册

给运营同事和 AI Agent 看的完整命令说明。所有命令的输出都是 JSON(stdout),进度和错误在另一个通道(stderr),Agent 和自动化脚本可以放心解析。

> 正式安装与 Cherry Studio 统一运行全局编译版：`amz-cli <命令>`。
> 源码开发可用 `npx tsx src/cli.ts <命令>`；真实写执行必须改用已安装的 `amz-cli`，或先构建后运行 `node dist/cli.js`。
> 首次安装与更新见 [Cherry Studio 安装指南](CHERRY_STUDIO_INSTALL.md)。

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
# 0. 安装器与配置位置（安装详情见 Cherry 指南）
npx amz-cli@latest install
amz-cli config path

# 1. 验证凭证是否配置正确(第一条命令永远跑这个)
amz-cli auth whoami

# 2. 查最近 7 天卖了多少
amz-cli sales stats --marketplace US --days 7 --granularity Total

# 3. 看看 FBA 库存还剩多少
amz-cli inventory list --marketplace US
```

安装管理命令不会调用 Amazon API：

```powershell
amz-cli install --dry-run  # 仅显示当前版本的全局安装计划
amz-cli config path        # 显示 ~/.amz-cli/.env 的实际路径
amz-cli config init        # 首次创建空白模板；已有配置绝不覆盖
```

## 基础概念(先读这个)

**市场代号**:`--marketplace` 用国家码,当前支持 `US / CA / MX / BR / UK / DE / FR / IT / ES`。

**跨区域(北美 + 欧洲)**:命令按 `--marketplace` 自动路由区域——查 `DE` 自动用欧洲端点和欧洲凭证,无需任何切换动作。前提是 `.env` 里配了对应区域的 token(`LWA_REFRESH_TOKEN_EU` 等);没配时会明确提示。按订单号/报告号查询的跟进命令(orders get、report status 等)查欧洲数据时带上可选的 `--marketplace DE`。

**多账号(店铺)**:所有命令支持全局 `--account <名称>` 切换账号:
- 本地模式:凭证读 `~/.amz-cli/accounts/<名称>.env`(格式同 `.env.example`,每个店铺一份);
- Broker 模式:直接切换店铺代号,权限由 Broker 端的 TEAM_ACCESS 策略控制;
- Broker 的 `listing mine/sku/schema/update` 要求管理员在服务端配置对应的 `SELLER_ID_<店铺>_<区域>`。Broker 返回值是权威身份；命令行 `--seller-id` 只能核对是否一致，不能在服务端缺配置时兜底。部署时必须先配置并发布 Broker，再让同事更新 CLI;
- 不传 `--account` = 优先用当前项目的 amz-cli `.env`；没有时回退到 `~/.amz-cli/.env`;
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
- 订单输出使用字段白名单剥离姓名、地址和邮箱；反馈报告会删除 Amazon 原始报告里的 `Rater Email`；
- 通用 `report run/download` 支持 Amazon 的多种报告类型，Agent 不得主动请求受限 PII 报告，也不要把含敏感数据的报告保存到共享目录；
- BSR 是排名不是销量;任何卖家的销量数字都查不到。

**运营可以直接说人话**，Agent 应先判断意图，而不是看到“报告”就固定调用 `report run`：

| 运营说法 | Agent 应如何处理 |
|---|---|
| “B0XXX 最近 30 天卖了多少” | 直接用 `sales stats --asin` 查询 |
| “最近 7 天全店卖得怎么样” | 直接用全店 `sales stats` 查询 |
| “看看这个产品卖得怎么样”但没有商品编号 | 追问 ASIN/SKU；可说明默认查最近 30 天 |
| “做个销售报告” | 追问是单品、全店汇总还是导出全店明细文件 |
| “导出 US 站全店商品明细” | 使用 `report run` 生成文件 |
| “查这个 ASIN 的差评” | 说明卖家反馈是全店维度、不能按 ASIN 查商品评价，再确认是否查全店反馈 |

判断原则：上下文和必要参数明确时直接查，不要反复确认；不同理解会改变对象、范围、耗时、文件输出或费用时才追问。写操作缺少预算、商品、站点、匹配方式等业务决定时必须追问。

**沙盒模式**:仅本地凭证模式可在 `.env` 里设 `SP_API_SANDBOX=true`，所有 SP-API 调用走亚马逊沙盒。Broker 协议暂不支持沙盒；同时设置 `BROKER_URL` 和 `SP_API_SANDBOX=true` 时 CLI 会安全拒绝，绝不会回退到生产端点。

**网络超时与重试**:

- Broker/LWA 换令牌最长等 30 秒，普通 SP-API/Ads API 请求最长等 60 秒，Feed 上传和报告下载最长等 120 秒；达到时限只停止本次客户端请求，不代表 Amazon 一定没有收到请求。
- 429 限流和安全的只读 GET/HEAD 遇到临时故障可以自动退避重试。
- POST/PUT/PATCH 写请求遇到 5xx、网络断开、超时或无法解析的成功响应时不自动重放，也不会向 Agent 标记为可重试。此时结果可能已经生效，必须先用只读命令或 Seller Central/广告后台核对。

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
| ads | `keyword-campaign-launch` | 按固定方案创建完整手动关键词广告 | 🔒 写 |
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

需要卖家编号。本地凭证模式在 `.env` 配置 `SELLER_ID=...`(或每次传 `--seller-id`)；Broker 模式必须由管理员配置服务端 `SELLER_ID_<店铺>_<区域>`，本地 flag/env 不作为兜底。

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
- 商品亮点(Item Highlights)按市场和产品类型逐步开放。字段名和结构只能以当前店铺、市场、产品类型的 schema 为准；先用 `--grep title` / `--grep highlight` 查找，不能把其他类型见过的字段名直接套用。Amazon 公告中的标题限制是 **≤75 字符**。

### listing update 🔒 — 编辑 listing

```powershell
# 第一步:预览(会先拉当前值做对照,再调亚马逊官方校验,不落库)
amz-cli listing update --marketplace US --sku "你的SKU" --product-type <产品类型> --patches "<JSON Patch 数组>" --dry-run
# 第二步:人工核对预览后,在终端执行
amz-cli listing update ... --confirm --preview-token <preview_token>
```

`--product-type` 用 `listing sku --include productTypes` 查;`--patches` 是 JSON Patch 格式(让 Agent 帮你拼,人只负责核对预览)。

Patch 本地规则：

- `add`、`replace`、`merge` 必须提供对象数组 `value`；缺少时不会调用 Amazon。
- `merge` 按 Amazon 当前官方能力只允许 `/attributes/fulfillment_availability` 和 `/attributes/purchasable_offer`；其他属性请使用 schema 支持的 `add`/`replace`，并走官方 `VALIDATION_PREVIEW`。
- `delete` 是否需要带选择器 `value` 取决于属性 schema；CLI 不一刀切，由当前产品类型 schema 和官方预览判断。

遇到预览错误时，以本次响应的 `issues` 和当前 schema 为准：
- **8560** 可能与商品身份信息不足有关，但不能无条件添加 `merchant_suggested_asin`。只有当前 schema 确实包含该字段、ASIN 已核对且 issues 指向此类缺失时，才按 schema 结构补充后重新预览；
- **100476** 表示当前提交的属性不受支持时，不要只靠缩短标题反复提交。先确认标题符合 Amazon 公告的 ≤75 字符要求，再检查当前 schema 是否实际开放 Item Highlights；查不到对应字段就停止并向用户说明。

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

`report run` 适合全量导出或明细文件，不是单品销售查询的默认入口。要查一个 ASIN/SKU 的销量、订单数和销售额，优先使用 `sales stats --asin/--sku`；当前通用报告命令没有 `--asin` 参数。

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
- `GET_SELLER_FEEDBACK_DATA` 的买家邮箱列会在 CLI 层删除；若返回格式无法安全识别，CLI 会拒绝输出或保存原文。

---

## 卖家反馈 feedback

```powershell
amz-cli feedback run --marketplace US --days 90
```

返回最近 N 天的**1-3 星差评和中评**。拿不到 4-5 星好评——这是亚马逊 API 的限制。Amazon 原始报告中的 `Rater Email` 会在 CLI 层删除。没有差评时报告会是 CANCELLED(好事)。

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
# 返回 nextToken 时继续翻页，其他过滤参数保持不变
amz-cli ads campaigns --profile-id <ID> --state ENABLED --next-token <nextToken>
amz-cli ads keywords --profile-id <ID> --campaign-id <ID> --next-token <nextToken>
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

`campaign-create` 只创建 Campaign 外壳；完整手动关键词广告使用 `keyword-campaign-launch`。后者会创建 Campaign、Ad Group、Product Ad 和正向 Keyword，并在完整回读成功后按方案决定是否启用。

```powershell
# 建广告活动(默认创建为暂停状态,不花钱;启用必须另走 campaign-state 的独立预览)
amz-cli ads campaign-create --profile-id <ID> --name "活动名" --targeting-type AUTO --daily-budget 10 --start 2026-08-01 --dry-run
amz-cli ads campaign-create ... --confirm --preview-token <preview_token>

# 用固定 JSON 方案创建完整手动关键词广告
Copy-Item examples\keyword-campaign-plan.example.json .\my-keyword-campaign.json
# 编辑方案并逐项核对 profileId/region/ASIN或SKU/预算/关键词/匹配方式/竞价/enableAfterCreate
amz-cli ads keyword-campaign-launch --plan .\my-keyword-campaign.json --dry-run
amz-cli ads keyword-campaign-launch --plan .\my-keyword-campaign.json --confirm --preview-token <preview_token>

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

完整关键词广告方案格式见 `examples/keyword-campaign-plan.example.json`。`launchId` 必须是本次发布的唯一编号；方案要求 1–1000 个关键词，同一关键词文本与匹配方式不能重复。`product` 中 `asin` 和 `sku` 必须二选一。`enableAfterCreate=true` 并不表示一创建 Campaign 就花钱：执行顺序固定为 PAUSED Campaign → 广告组 → 商品广告 → 分批创建关键词 → 回读核对 ID/归属/数量 → 最后启用。

Amazon Ads 批量创建可能返回 `207 Multi-Status`。CLI 会逐项读取 `success/error`：部分失败时保留已成功 ID、Campaign 保持暂停；同一方案再次确认后只补缺项。写请求网络超时或结果不明确时不会自动重放，而是要求先到后台或用只读命令核对。

### 广告沙盒:测试账户

```powershell
amz-cli ads auth-url --test-account          # 管理员首次授权时申请测试账户 scope
amz-cli ads test-account-create --dry-run   # 然后 --confirm --preview-token <preview_token>
amz-cli ads test-account-status
```

测试账户里的广告**不投放、不花钱**,写操作先在这里验证。

---

## 写操作怎么执行(必读)

> ⚠️ **写操作只能用编译版执行**：正式使用 `amz-cli ...`；源码开发者先 `npm run build`，再用 `node dist/cli.js ...`。
> 开发用的 `npx tsx src/cli.ts` 会吞掉终端确认输入、让门槛失效,所以 CLI **主动禁止**在这种模式下执行写操作(会报 `dev_mode_write_forbidden`)。
> 同事按安装指南使用全局 `amz-cli`；这条只影响开发者本机直接运行源码。

所有 🔒 写操作遵循同一个铁律,**任何一步都不能跳过**:

```
第 1 步  --dry-run 预览            ← Agent 可以代跑,输出"将改什么"和 preview_token
第 2 步  人工核对预览               ← 人看;令牌 15 分钟有效
第 3 步  人工在 PowerShell 终端运行 --confirm --preview-token <令牌>
         → 屏幕复述:"将对 XX 做 XX(后果)"
         → 普通写操作:输入 y 确认
         → 不可撤销操作(feed submit):输入屏幕上的随机 6 位确认码
```

`preview_token` 只能使用一次，并绑定预览时的命令、全部业务参数、Feed/patch 文件内容哈希，以及当前 `BROKER_URL`、店铺、SP/Ads 区域、Client ID、凭证哈希；Listing 写操作还会绑定 Broker 实际返回的 Seller ID。敏感凭证明文不会写入令牌记录。缺少令牌、令牌过期、已经使用、确认命令改变业务参数、输入文件变化、运行环境或远端 Seller ID 映射切换，CLI 都会拒绝执行并要求重新预览。

**普通非交互 Agent、n8n、管道带 `--confirm` 会被 CLI 拒绝**。Agent 的正确做法是运行 dry-run，把预览和带令牌的最终命令交给人。完整关键词广告若使用项目自带 MCP，可由 Cherry 的逐次工具审批替代 PowerShell TTY，但必须先调用 `prepare_keyword_campaign`，且不得自动批准 `launch_keyword_campaign` 或启用 `bypassPermissions`。

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
