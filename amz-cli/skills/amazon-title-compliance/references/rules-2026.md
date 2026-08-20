# Amazon 标题新规（2026-07-27 生效）

> 2026-08-17 核实。硬约束由亚马逊定，**这里的数字不要自行放宽**。
> 来源见文末；条款以卖家平台当前的品类风格指南为准，本文是操作口径。

## 硬上限

| 字段 | 政策上限 | schema `maxLength` | 说明 |
|---|---|---|---|
| 标题（`item_name`） | **75 字符**（含空格） | 200 | 除媒体类目外的**所有**类目。旧的 ~200 字符口径作废 |
| 标题（媒体类目） | **200 字符** | 200 | Books / Music / Video / DVD 保留旧限制 |
| 商品亮点（Item Highlights） | **125 字符** | 125 | 2026-07-27 新增字段。这个字段两者一致 |
| 五点单条（`bullet_point`） | 255?（**存疑**） | 700 | 见下方「255 这个数字存疑」 |
| 五点条数 | **5 条** | `maxUniqueItems: 10` | 卖家 5、vendor 10 |
| 后台搜索词（Search Terms） | **249 字节** | — | 是**字节**不是字符：重音字母、变音符号占 2 字节 |

### ⚠️ schema 上限 ≠ 政策上限

`maxLength` 是 **API 上限**。API 收得下，不代表政策允许——亚马逊靠**改写或删除**来执行政策，不靠拒绝写入。

所以 `VALIDATION_PREVIEW` 会给 191 字符的标题和 350 字符的五点返回 `VALID`，写入也会成功，然后被悄悄改掉。**dry-run 通过不是合规证据**，只有 `check-copy.mjs` 按政策卡。

标题 75 + 亮点 125 = **200 字符的可索引预算**，和改版前总量持平。亮点和标题**在搜索里权重相同**，亚马逊没有偏向任何一方。

## 商品亮点（Item Highlights）

- 展示在标题下方（搜索结果页 + 商品详情页）。桌面端一度用 `|` 与标题合并展示，2026-08-10 起两端统一改到标题下方。
- **前置条件：标题 ≤75 字符时才能填亮点。** 标题还超限就先改标题，不然亮点白填。
- 写法是**短语堆叠**，不是完整句子。通行分隔是 `·` 或逗号，例如 `Wheat straw · 22.5 x 31 cm · Dishwasher safe`。
- 内容取向：材质、尺寸、适用年龄、兼容信息、使用场景——**补标题没说的**，不是复述标题。

## 标题内容规则

- **品牌放最前**，品牌后紧跟主关键词。品牌不能删、不能挪位。
- **同一个词最多出现两次**，冠词 / 介词 / 连词除外。作用域**只是标题本身**，不含亮点和五点。
- **禁用特殊字符**：`!` `$` `?` `_` `{` `}` `^` `¬` `¦`——除非它本身是品牌名的一部分。`~` `#` `<` `>` `*` 视语境，能不用就不用。
- **禁全大写**。缩写（USB / LED / BPA）和品牌名里的大写不算。全大写被判定为「喊话」，按垃圾信息处理。
- **禁促销词与价格**：bestseller、free shipping、on sale、限时、立即购买、具体价格。
- **禁商品状况描述**（new / used 这类作为成色的词）。
- 数字用阿拉伯数字。
- 建议结构：**品牌 + 品类主词 + 关键属性 + 变体（尺寸/颜色）**。

## 不合规的后果

7-27 之后仍超过 75 字符的标题，**由亚马逊 AI 直接改写**——它按自己的相关性模型、你的后台搜索词和五点重新生成。**只有品牌备案卖家有 14 天复审窗口**，其余情况改写直接生效，很多时候没有通知。

这是本 skill 的紧迫性来源：**自己改还能控标题，等它改就彻底失去控制权。**

## 五点（Bullet Points）

- 最多 **5 条**，每条至少 10 字符。

#### ⚠️ 255 这个数字存疑，校验器只当警告

第三方资料普遍说卖家五点单条上限 255（2024-08-15 起）、vendor 500。但：

- **schema 说 700**，且没有任何 description 提到 255
- **实测反证**：同一店铺 30 条在架五点里 **57% 超过 255**，最长 382，而 250–260 区间**一条都没有**——如果亚马逊在截断，这里必然堆积

所以校验器把 700 当硬上限（error），255 只作为警告（`W_ABOVE_POLICY`，标 `evidence: third-party`）。**想验实：去卖家后台的品类风格指南查一次**，那是一手来源。
- **不要使用全大写单词**——这不是风格建议，是 `bullet_point` 的 schema 说明原文：「KEINE Wörter in Großbuchstaben oder Abkürzungen verwenden」。`EASY CLEANING — …` 这种普遍写法确实违反字段规范。
- **不要拿五点写材质成分、护理说明、原产国**——同一段 schema 说明原文，那些有专门的结构化字段（`material` 等）。材质可以嵌在利益描述里，但别写成纯规格条。
- 每条以大写字母开头，句子式大小写；不要结尾标点；禁特殊字符；禁保证/价格用语。
- 🚫 **禁 emoji —— 这是本店硬规矩**（校验器判 error，`evidence: house-rule`）。第三方资料也说亚马逊禁，但实测本店有五点以 🚴📱☔ 开头、370+ 字符、原样活着，**没观察到亚马逊执行**。所以它按店铺标准拦，不冒充合规要求 —— 两者结论一样：删掉。
- **第三方品牌在五点里是允许的**（「适配 Sony WH-CH720N」正是买家要核对的信息）——禁令只针对标题和亮点。

## 与本仓库既有文档的关系

`docs/COMMANDS.md` 和 `skills/amz-cli/SKILL.md` 里的「标题 ≤75 字符」与本文一致。仓库里关于 **8560 / 100476 错误码**的判读规则仍然有效：

- 遇 **100476**（属性不受支持）不要只靠缩短标题反复提交。先确认标题确实 ≤75，再查卖家专属 Schema 是否真开放了 Item Highlights。**「试了几个字段名都失败」不能作为「API 不支持」的证据**——只有业务名称搜索无匹配、或唯一匹配项明确 `editable=false` 才算。
- 遇 **8560** 不要无条件添加 `merchant_suggested_asin`，先读本次 issues。

## 来源

- [Amazon Introduces New Product Title Rules Effective July 27, 2026 — CedCommerce](https://cedcommerce.com/blog/amazon-introduces-new-product-title-rules-effective-july-27-2026/)
- [Amazon is cutting product titles to 75 characters — Zentail](https://www.zentail.com/blog/amazon-is-cutting-product-titles-to-75-characters-heres-what-sellers-need-to-know)
- [Optimize Amazon Product Titles: 75 Characters and Item Highlights — Amalytix](https://www.amalytix.com/en/knowledge/seo/amazon-product-title/)
- [Amazon Item Highlights 2026: The New 125-Character Searchable Field — SellerSprite](https://www.sellersprite.com/en/blog/amazon-item-highlights-2026)
- [Amazon Title Rules 2026: Banned Words & Fix Guide — PDMG](https://palmettodigitalmarketinggroup.com/amazon-listing-title-rules-2026/)
- [Stay Compliant: Amazon's Updated Bullet Point Guidelines — eComEngine](https://www.ecomengine.com/blog/amazon-bullet-point-guidelines)
- [Amazon Bullet Points: 255 Character Limit + 2026 Rules — ListingForge](https://www.listing-forge.com/blog/amazon-bullet-points)
- [Amazon Bullet Points: Guidelines & Character Limits — Amalytix](https://www.amalytix.com/en/knowledge/seo/amazon-bullet-points/)

> 以上为第三方解读。**最终以 `listing schema` 返回的卖家专属定义为准**——尤其是每个属性的 `description`，那是亚马逊针对你的店铺、站点和产品类型写的规范原文，等级高于本文和任何第三方文章。本文里「五点禁全大写」「五点不写材质成分/护理说明/原产国」两条就是从 schema `description` 里读到的，第三方文章没写全。
