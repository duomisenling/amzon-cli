# 批量改写流程

2 条以上走这里。单条走 [single.md](single.md)。

**单批最多 50 条**，超出拆批。理由不是 API 限制，是人审——一次让用户核对 200 条标题，等于没审。

## 1. 圈定范围

先拿全店 listing，再筛出真正需要改的：

> 读数据一律走**终端**（MCP 没有读工具）；多店铺时 `--account` 必填。见 [runtime.md](runtime.md)。

**ASIN 是站点相关的**——同一个 ASIN 在 DE 和 UK 是两条不同的 listing。站点没明确就先问，不要猜。

### 入口 A：用户直接给了 ASIN（最常见）

`listing mine --asin` 支持**逗号分隔最多 20 个**，一次就能把 ASIN 解析成本店 SKU，并带回 `summaries`（含当前标题和产品类型）：

```bash
amz-cli listing mine --account <店铺> --marketplace <站点> \
  --asin "ASIN1,ASIN2,...,ASIN20" --page-size 20
```

> `--page-size` 上限 20、默认 10 —— 给 20 个 ASIN 不传这个参数会只回 10 条，剩下的要靠 `--page-token` 翻页。
> `--asin` 和 `--skus` **互斥**，不能同时传。
> `listing mine` **没有** `--include` 和 `--out` 参数，它只回 `summaries,issues`。要属性得用下面的 `listing batch`。

### 入口 B：从全店筛

```bash
amz-cli listing mine --account <店铺> --marketplace <站点> --page-size 20
# 返回 data.nextToken 时继续翻,其他参数保持不变(注意:是 data.nextToken,不是 data.pagination.nextToken)
amz-cli listing mine --account <店铺> --marketplace <站点> --page-size 20 --page-token <nextToken>
```

### 入口 C：跨站点复用（"用德国版改写成意大利版"）

一个站点改完并写入后，拿它当另一个站点的素材。**这是欧洲多站点最省力的路径**，但**不是翻译**。

**能直接继承的（同一个实物，与站点无关）：**

- 全部物理事实：材质、颜色、尺寸、重量、件数、认证
- 上一轮**用户口头补充**的事实（"是米色"、"有 LFGB 认证"）——依然成立，记进 `notes` 时注明来源是上一轮用户答复
- 上一轮记录的 `conflicts` 判定结果（既然已经判过"采用 Beige"，这轮别再判一遍）

已改好的站点在素材里标成 `<listing_other_site>`，**算 1 个独立出处**。跨语言不影响事实等价：`Weizenstroh` = `paglia di grano`，视同原文出现。

**必须重做的（换站点就变）：**

| 项 | 为什么 |
|---|---|
| **主关键词** | ⚠️ **最大的坑。** 意大利买家搜的不是 `Serviertablett` 的直译。主词必须按目标站的搜索行为重选（见 [keyword-choice.md](keyword-choice.md)），**翻译主词 = 拿到一个没人搜的词** |
| 目标字符区间 | 德语 55–72 → 意大利语 50–70。德语通常更长，翻过去会变短——**别浪费富余的字符**，多放一个有依据的词进去 |
| 违禁词表 | 换成目标语言（`garantito` / `migliore` / `sconto` …），德语词表不适用 |
| 重复词计数 | 按目标语言的冠词/介词表重数 |
| 目标站当前值 | **必须重新拉。** 不能假设 IT 的现状等于 DE 的旧状——IT 可能标题本来就没超限（那就别改），也可能亮点已经填了 |
| SKU / 产品类型 / Schema | 泛欧通常共用 SKU 但不保证；**产品类型和 schema 必须按目标站重查**，DE 的 schema 不能套 IT |
| 本地化细节 | 单位、拼写、认证机构（见 [writing-rules.md](writing-rules.md) 的「同语言不同站点也不一样」；欧盟内单位一致，但认证措辞要核） |

流程：照常走第 1 步取**目标站**的当前值和 schema → 第 2 步把已改好的站点作为 `<listing_other_site>` 放进素材 → **第 3 步选词要重跑** → 之后一样。

省下的是求证：待确认清单通常是空的（上一轮问过了），生成也快得多。

### 三个入口都要:拉完整属性

`summaries` 只有标题和产品类型，五点、亮点、后台属性要另拉。用 `listing batch`——它支持并发、断点续跑和失败隔离，别逐个查：

```bash
amz-cli listing batch --account <店铺> --marketplace <站点> \
  --skus "SKU1,SKU2,...,SKU20" \
  --include attributes,summaries,productTypes \
  --out <目录>/listings.jsonl --concurrency 4
```

> SKU 多时用 `--sku-file <每行一个SKU的文件>` 代替 `--skus`（两者二选一）。`--out` 是**必填**，断点续跑依赖它。

**不要手写提取脚本**，用 `extract`：

```bash
node "<本 skill 目录>/scripts/check-copy.mjs" extract --file "<目录>/listings.jsonl" \n  --marketplace <站点> --highlight-attr <亮点属性名> --out "<目录>/skeleton.json"
```

实测手写提取漏过 `product_description`，丢了一个真事实。`extract` 会一次取全这些：

```
item_name  bullet_point  title_differentiation  product_description
brand  color  material  unit_count  special_feature
```

`special_feature` 这类结构化属性经常是**第二个独立出处**——实测 `special_feature: Bruchfest` 让"不易碎"从"单一自述、不敢写"变成"可以写"。

补平台目录事实（`catalog batch` 上限也是 20 个 ASIN）：

```bash
amz-cli catalog batch --account <店铺> --marketplace <站点> \
  --asins "ASIN1,...,ASIN20" --out <目录>/catalog.json
```

> `listing batch` 是**只读**的（逐 SKU 拉 attributes），和写入无关。中断后重跑同一条命令会跳过已完成的 SKU，不从 0 开始；`--include` 改了就要换新的 `--out`，否则新旧数据集会混。

## 2. 筛出缺口

**筛的是「哪些 SKU 要进这一批」，不是「哪个字段要改」**——进了批次的 SKU，三个字段一次全写。

| 判据 | 处理 |
|---|---|
| `item_name` > 75 字符（媒体类目 200） | ✅ 进批次（**最紧急**：随时可能被亚马逊 AI 接管） |
| 亮点属性为空 | ✅ 进批次 |
| `bullet_point` 少于 3 条 | ✅ 进批次 |
| 三项都达标 | ⏭ **跳过**，不要碰 |

命中任意一条就进批次。**优先排「标题超长 + 亮点空」的**——那批既最紧急，砍掉的词又正好有地方接。

**做法：把现值直接当草稿喂校验器**，让它替你数字符、替你找问题：

```bash
node "<本 skill 目录>/scripts/check-copy.mjs" check --file "<现状.json>" --audit
```

> `--audit` 让**店铺自定规矩**（house-rule，如禁 emoji）对存量内容只出警告。**存量不追，只管新写的** —— 别拿它虚增改写理由，也别因为它把 SKU 拉进批次。

得到的错误清单就是**现状体检报告**——「23 条里 18 条标题超限、全部 115 条五点超政策线、全部全大写」。这既是筛选依据，也是给运营看"为什么必须改"的最有力材料，还免费得到优先级排序（错误多的先做）。

产品类型不同的 SKU **要分组**——schema 是按产品类型的，不能混着查。

⚠️ **别指望分组能省多少事。** 实测一个长尾铺货店铺：100 条里 38 条超限，分布在 **22 个产品类型**——产品类型数几乎等于 SKU 数。好消息是 schema 查询本身很便宜（实测 6–13 秒），所以**不要为了省调用跳过它**，但排工期时按"接近逐 SKU 查"来估。

### 跨条目检查（批量独有，逐条看不见）

整批 `check` 会额外做三项比对，结果在输出的 `batch` 字段里：

| code | 含义 |
|---|---|
| `E_DUPLICATE_TITLE` | **多条标题完全相同**。买家在搜索结果里分不出买哪个，直接报错、拒绝生成 patch |
| `W_SIMILAR_TITLE` | 只差 1–2 个实词。差异词一般就是区分维度，**确认它落在标题前 40 字符内** |
| `W_DUPLICATE_BULLETS` | 多条五点整组照搬，至少要有一条体现各自的区分维度 |

**同款多色/多规格的独立 listing，标题必须带自己的区分维度**（颜色/尺寸/数量，以各自的 `color`、`size`、`unit_count` 属性为准）。实测有店铺三条独立 listing 标题一字不差、都不提颜色——这种只有把整批放一起才看得出来。

## 3. 分组查 Schema

每个**产品类型**查一次就够，不要逐 SKU 查。

有 MCP 时优先用只读 `inspect_listing_schema`（先 `query` 按业务名称搜，唯一匹配后再 `attribute` 读定义）；只有终端时：

```bash
amz-cli listing schema --account <店铺> --marketplace <站点> --product-type <类型> --grep title
amz-cli listing schema --account <店铺> --marketplace <站点> --product-type <类型> --grep highlight
amz-cli listing schema --account <店铺> --marketplace <站点> --product-type <类型> --attribute <真实属性名>
```

记下每个产品类型的：真实属性名、value 对象结构、字数限制，**以及 `description` 原文**。

🔑 **`description` 是最高证据**——亚马逊针对这个卖家/站点/产品类型写的规范原文，等级高于本 skill 的任何文档。实测一次就读到「亮点仅在标题 <75 字符时显示」「五点不许全大写」「五点不要写材质成分/护理说明/原产国」这些别处查不到的规则。**不同产品类型的 description 可能不同，分组时逐个读，别套用。**

**搜不到或匹配多个就停下问用户**，不要换几个猜测名反复试——「试了几个都失败」不是「API 不支持」的证据。

## 4. 逐条生成，汇总成一个数组

草稿格式同 [single.md](single.md) 第 4 步，整批写成**一个 JSON 数组**。每条都要带自己的 `productType`、`brand`、`currentTitle`。

素材照样按来源分区。**跨 SKU 不要串味**——A 的材质不能拿去写 B，同系列变体也不行。

## 4.5 待确认清单：攒起来一次问

生成过程中遇到的存疑项**不要逐条打断用户**，也不要默默绕开。攒成一份清单，**按问题归类**（不是按 SKU 列），一次问完：

```
生成完了，有 3 组信息素材里查不到，你知道的话我补进去，不知道就先不写：

① 材质（影响 6 条标题）
   DEMO-A / DEMO-B / DEMO-C 这三个是小麦秸秆吗？货号里有 -WS 但目录没填材质。
   DEMO-D / DEMO-E / DEMO-F 完全查不到材质线索。

② 颜色对不上（影响 2 条）
   DEMO-G：五点写 pink，但货号和目录都是 Beige —— 按 Beige 写对吗？

③ BPA-free 有没有认证（影响 4 条）
   原五点写了 BPA-free，素材里没有认证名或报告编号。有证书的话给我认证名，
   我写进文案；没有的话这个词必须删掉。

不确定的直接说"不知道"，我就绕开不写。
```

规则：

- **按问题归类，不按 SKU 逐条**。20 条 listing 缺的往往是同一类信息，逐条问会问出 20 个问题。
- 每组说清**影响几条**，运营才知道值不值得去查。
- 明确给出「不知道也行」的出口——不要逼答，逼出来的答案比不答更危险。
- 用户答复**算独立出处**，记进 `notes`（「用户补充：材质为小麦秸秆」）。
- 答完只重生成**受影响的那些**，其余不动。

问完再进第 5 步。用户说"先出稿别问了"就跳过这一步，按绕开处理。

## 5. 整批校验

```bash
node "<本 skill 目录>/scripts/check-copy.mjs" check --file "<目录>/drafts.json" --complete
```

输出结构：

- `summary` —— **先看这个**。逐条问题按 code 聚合（`16 × W_BELOW_TARGET，涉及 5 条`）。20 条批量的逐条警告有上百行，不聚合等于没有。
- `batch` —— 跨条目问题（标题雷同等）。有 `severity: error` 的会让整批 `ok: false` 并拒绝生成 patch。
- `items` —— 逐条明细，需要定位到具体 SKU 时再翻。

`failed` 是没过的条数。**只重写没过的那些**，过了的别动（重跑会得到不同文案，白白让用户重审）。反复直到 `ok: true`。

## 6. 汇总报给用户

给**表格 + 文件路径**，不要把几十条原文倒进对话：

```
DE 站 23 条标题整改（产品类型 ROTATING_TRAY 18 条、SERVING_TRAY 5 条）

| SKU | 原标题字符 | 新标题字符 | 新亮点字符 | 备注 |
|-----|-----------|-----------|-----------|------|
| ... |    187    |    59     |    52     |      |
| ... |    142    |    64     |    58     | 五点由 2 条补到 5 条 |

- 全部 23 条通过机器校验
- 4 条有警告：3 条 BPA-free 缺认证依据（已删除该词），1 条标题偏短
- 未写入的信息共 11 项、素材矛盾 3 处 → 明细见 <目录>/drafts.json
- 矛盾项摘要：SKU-A 颜色（catalog/MSKU 说 Beige，五点说 pink → 采用 Beige）…

明细：<目录>/drafts.json
要写入吗？确认后我生成整批预览。
```

`conflicts` 是**源数据错误的线索**，别埋在文件里——摘要一定要进对话，那是用户去修 listing 源数据的唯一入口。

**在这里停住。** 等用户明确说写。

## 7. 生成 patch 文件

```bash
node "<本 skill 目录>/scripts/check-copy.mjs" patches \
  --file "<目录>/drafts.json" --out-dir "<目录>/patches" --account <店铺>
```

每条草稿要补上 `attributes` 和 `valueTemplate`（第 3 步查到的属性名 + 该 SKU 当前值对象去掉 `value` 键）。当前值天然带着这个卖家/站点/产品类型正确的 `marketplace_id`、`language_tag`，比照 schema 手拼可靠。首次填亮点没有当前值时，按 schema 结构给模板。

产出：
- `<sku>.patch.json` —— 每条一个 patch 文件
- `index.json` —— SKU → 文件 → 产品类型 → 站点
- `dry-run.txt` —— 每条的预览命令

校验没过的草稿会被**拒绝**生成 patch。

## 8. 写入

见 [writing.md](writing.md)。批量的关键差异：

- **没有"一次预览整批"的 listing 写入命令。** `ads bid-batch` 那种整批令牌只覆盖广告；listing 是**逐 SKU 一次 dry-run + 一次 confirm**。
- 预览令牌 **15 分钟有效、只能用一次**，且绑定命令、参数和文件内容。所以别一次性把 23 条全预览完再让用户慢慢跑——**分小组做**（一组 5~8 条），预览完立刻交给用户执行。
- 逐条记录结果（成功 / 失败 / 未确认），**失败隔离**：一条失败不影响其余，但要在最终汇报里如实列出。
- 不要因为某条返回不明确就自动重试写入。
