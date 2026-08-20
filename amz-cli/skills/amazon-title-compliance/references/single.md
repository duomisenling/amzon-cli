# 单条改写流程

改 1 条 listing 的**一整套**文案：标题 + 商品亮点 + 五点。批量走 [batch.md](batch.md)。

## 1. 取素材（只读，**走终端**）

> amz-cli 的 MCP 没有读数据的工具，读一律走终端；多店铺时 `--account` 必填。见 [runtime.md](runtime.md)。

```bash
# 当前标题、亮点、五点、后台属性、产品类型 —— 一条命令拿全
amz-cli listing sku --account <店铺> --marketplace <站点> --sku <SKU> \
  --include attributes,summaries,productTypes,issues
```

只有 ASIN 时先解析成本店 SKU（`listing update` 也会自己解析，但先拿到便于对话）：

```bash
amz-cli listing mine --account <店铺> --marketplace <站点> --asin <ASIN>
```

补充素材（按需，都是只读）：

```bash
# 平台目录数据:类目、BSR、颜色/尺寸/材质等平台侧字段
amz-cli catalog get --account <店铺> --marketplace <站点> --asin <ASIN>
# 同一商品在别的站点(他站 listing 是独立的 1 个出处)
amz-cli listing sku --account <店铺> --marketplace <另一站点> --sku <SKU> --include attributes
```

**取完直接用 `extract` 摊成草稿骨架，不要手写提取：**

```bash
node "<本 skill 目录>/scripts/check-copy.mjs" extract --file "<上一步的输出>" \n  --marketplace <站点> --highlight-attr <亮点属性名> --out "<草稿骨架.json>"
```

## 2. 把素材按来源分区

**这一步不能省。**「数独立出处」建立在分得清来源之上，混成一张属性表这套机制就失效了——而它是反编造的承重墙。

按这个结构整理给自己看（用 [writing-rules.md](writing-rules.md) 的六种标签）：

```
<amazon_catalog>      类目/排名 + 平台侧的颜色/尺寸/重量/材质
<listing_local>       品牌、当前标题(字符数)、五点、亮点、后台属性、商品描述
<listing_other_site>  他站同商品的五点和描述(有就放,标明站点)
<internal_record>     内部品名、MSKU、内部分类
<variant_sibling>     同款变体(标明变体维度:颜色还是尺寸)
<customer_reviews>    买家评论(有就放,标 [自有]/[竞品];只取用词和隐藏卖点,不算出处)
```

缺的写「（无）」，**不要留空**——留空会被当成可以自由发挥的地方。

## 3. 定要改哪些字段

**三个字段一次全写**：标题 + 亮点 + 五点。这是一套咬合的文案，不是三个独立补丁——标题砍掉的词由亮点承接，五点再覆盖剩下的维度。

先把现状记下来做对照（第 6 步要逐字段摆给用户）：

| 字段 | 记录什么 |
|---|---|
| 标题 | 原文 + 字符数（多半 >75，这是本次的起点） |
| 亮点 | 原文（多半是空，新规字段） |
| 五点 | **逐条**原文 + 条数 |
| **商品描述** | **原文必取**（见下） |

⚠️ **商品描述必须读，哪怕本次不改它。** 实测漏读一次的代价：丢了「颜色是涂层（farbenfrohe Beschichtung）」这个真事实，按不锈钢原色写了文案。而且改完三个字段后，描述会和新文案自相矛盾（五点删掉了 BPA-frei，描述里还写着）——矛盾同时砸掉关键词层和语义层。

把它填进草稿的 `currentDescription`，校验器会顺带审一遍（只出警告，不拦本次改动）。

后台搜索词默认不做。

## 4. 生成草稿 JSON

按 [writing-rules.md](writing-rules.md) 写文案，落成校验器吃的格式：

```json
{
  "sku": "DEMO-TRAY-01",
  "marketplace": "DE",
  "productType": "ROTATING_TRAY",
  "brand": "Demobrand",
  "mainKeyword": "Serviertablett",
  "title": "Demobrand Serviertablett aus Weizenstroh, 22,5 x 31 cm, stapelbar",
  "highlights": "Spülmaschinenfest · Leicht · Für Frühstück und Snacks",
  "bullets": [
    "Weizenstroh-Korpus trägt Teller und Tassen von der Küche zum Tisch.",
    "22,5 x 31 cm Fläche passt auf Beistelltische und Tabletts im Bett.",
    "Stapelbar, so verschwinden mehrere Tabletts flach im Schrank.",
    "Spülmaschinenfest, nach dem Frühstück einfach einräumen.",
    "Leichtes Eigengewicht, auch mit voller Beladung gut zu tragen."
  ],
  "currentTitle": "（原标题原文，用于对照和判断跨字段重复）",
  "currentHighlights": "",
  "currentBullets": ["（原五点逐条原文，report 要拿它做对照）"],
  "keywordEvidence": "主词 Serviertablett —— 广告搜索词报表 2026-07，clicks 214 / purchases7d 18",
  "thirdPartyBrands": ["Sony", "JBL"],
  "omitted": ["素材未提供板厚，未写"],
  "conflicts": [],
  "notes": "标题压到 59 字符；被砍掉的「可叠放/易清洁」搬进亮点，五点覆盖承载/尺寸/收纳/清洁/重量五个维度"
}
```

**三个字段缺一不可**（`--complete` 会检查）。五点至少 3 条——素材不足写不满 5 条是允许的，**但不许为凑数编造**。

写到临时目录，不要污染项目（本机 scratchpad 或 `local-delivery/` 下）。

## 4.5 存疑先问

素材里查不到、但会进标题的属性（颜色、材质、尺寸、认证），**先问运营**——他手里有实物和供应商资料，多半知道。问得让他能答：

> 这款托盘是米色的吗？五点里写的是 pink，但货号 `DEMO-TRAY-01` 和目录数据都指向米色。
> 另外 BPA-free 有认证名或报告编号吗？有的话我写进文案，没有就得删掉这个词。

用户答复**算独立出处**，记进 `notes`。用户说不知道、或让你先出稿 → 才绕开，记进 `omitted`。**不要写「可能」「据称」**。

## 5. 机器校验

```bash
node "<本 skill 目录>/scripts/check-copy.mjs" check --file "<草稿.json>" --complete
```

先把**现值**也过一遍，拿到现状体检（这是告诉用户"为什么必须改"的材料）：

```bash
node "<本 skill 目录>/scripts/check-copy.mjs" check --file "<现状.json>" --audit
```

- 退出码 0 → 通过（可能有 `warnings`，逐条看，别无视）
- 退出码 1 → 看 `errors` 里的 `code` 和 `message`，**回第 4 步重写**

常见错误的处理：

| code | 怎么办 |
|---|---|
| `E_TOO_LONG` | 砍词，不是砍事实。优先砍已在亮点里说过的、和泛化形容词 |
| `E_WORD_REPEAT` | 同义替换或直接删掉重复的那次 |
| `E_BANNED_WORD` | 换成素材里确有的**具体规格**（不写 `best quality steel`，写 `2 mm Corten steel`） |
| `E_THIRD_PARTY_BRAND` | 从标题/亮点删掉，兼容信息挪到五点或后台搜索词 |
| `E_TITLE_HIGHLIGHT_OVERLAP` | 亮点换个维度讲，别复述标题 |
| `E_HIGHLIGHTS_NOT_ELIGIBLE` | 标题还超限，必须和标题同批改 |
| `E_BRAND_NOT_FIRST` | 品牌提到最前 |
| `E_INCOMPLETE_SET` | 三个字段没交齐（五点至少 3 条）。补上缺的，别交半套 |
| `E_MAIN_KEYWORD_MISSING` | 砍标题时把主词本身砍掉了，加回来并紧跟品牌 |
| `W_MAIN_KEYWORD_LATE` | 主词超出前 40 字符（手机截断线），提到紧跟品牌的位置 |
| `W_WEAK_BULLET_OPENER` | 第 1 条五点别用虚词开头，句首放本条最重的词 |
| `W_BULLET_OVERLAP` / `W_HIGHLIGHT_BULLET_OVERLAP` | 两处讲同一件事，合并后空出来的写别的维度 |
| `W_BULLETS_NOT_FULL` | 五点没写满 5 条。素材够就补满，不够就保持——**不许编造** |
| `W_NEEDS_EVIDENCE` | 素材里找认证名/报告编号；找不到就删掉这个词并记进 `omitted` |

**不要为了过校验而编造信息**——校验器只管形式，铁律一管事实，它拦不住你。

## 6. 报给用户，等确认

**用命令生成，不要手写**：

```bash
node "<本 skill 目录>/scripts/check-copy.mjs" report --file "<草稿.json>"
```

输出逐字段「当前值 → 新值」（五点逐条）、现状体检、新版校验、`omitted`、`conflicts`、选词依据。原样贴给用户，末尾加一句"确认后我生成预览"。

> 手写会漏。实测漏过一次：只写了"五点各占一个维度"，没摆原文，用户不得不追问。命令漏不掉。

**在这里停住。** 用户明确说「写 / 提交 / 确认」才继续，见 [writing.md](writing.md)。

**逐字段摆对照是硬要求**——整套重写会覆盖运营已经写好的五点和亮点，用户必须看得见自己失去了什么。用户点名保留某个字段，就从 patch 里删掉那一项，**其余字段照常写**，不要整条跳过。
