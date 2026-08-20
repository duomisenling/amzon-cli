# 运行环境与调用约定

**先读这个，再动手。** 调错通道会直接失败，而且失败信息往往指向错误的方向（看起来像"API 不支持"，其实是工具不存在）。

## amz-cli 有两条通道，能力不重叠

| | 终端（`amz-cli <域> <命令>`） | MCP（Cherry Studio 工具） |
|---|---|---|
| **读数据** | ✅ 全部 | ❌ **一个都没有** |
| 查 Schema | ✅ `listing schema` | ✅ `inspect_listing_schema` |
| **写入** | ⚠️ 只能到 `--dry-run` | ✅ `prepare_*` → `apply_*` |

### ⚠️ amz-cli 的 MCP **没有任何读数据的工具**

它暴露的工具**只有这些**：

```
inspect_listing_schema                    ← 唯一的只读工具
prepare_listing_update / apply_listing_update
prepare_listing_create / apply_listing_create
prepare_feed_submit    / apply_feed_submit
prepare_ads_*          / apply_ads_*
prepare_keyword_campaign / launch_keyword_campaign
```

**没有** `get_listing`、`list_listings`、`get_catalog` 这类工具。想要当前标题、五点、属性、产品类型、广告报表——**一律走终端**。

不要因为"MCP 里找不到读工具"就得出「amz-cli 查不了 listing」的结论，也**不要凭猜测调用不存在的工具名**。工具名以当前会话实际 schema 为准。

### 终端不可用时

读不到素材就**不要改标题**——没有当前值做对照的改写是盲改。如实告诉用户终端不可用，请他检查 amz-cli 安装。

## 多店铺：`account` / `--account` 必填

Cherry Studio 装的是**多店铺 MCP**，每个 `prepare_*` / `apply_*` 都有**必填 `account`**；终端命令同样要显式带 `--account <店铺代号>`。

- 用当前对话已经明确的店铺代号。
- **没明确店铺就先问**，不要靠 ASIN、站点或历史习惯猜，也不要遍历几个店铺去找 SKU。
- 同一个任务里每次调用都带**同一个** `account`，不要中途换。

## 校验脚本怎么调

脚本在**本 skill 目录**下，不在项目仓库里：

```
<本 SKILL.md 所在目录>/scripts/check-copy.mjs
```

Cherry Studio 里 skill 是安装到全局 skills 目录的，路径**不是** `skills/amazon-title-compliance/...`。调用时用本 SKILL.md 所在目录拼出绝对路径：

```bash
node "<skill 目录>/scripts/check-copy.mjs" check --file "<草稿.json>" --complete
```

找不到时先定位再报错：

```bash
node -e "console.log(process.version)"          # 确认 node 可用
```

脚本**零依赖**，只用 Node 内置模块，不需要 `npm install`，也不需要在项目目录里跑。

### 脚本跑不了时的降级

**不要自己数字符数顶上。** 模型估的字符数经常差 10 位以上，德语复合词尤其严重，而 75 是硬上限——差一个字符就会被亚马逊 AI 接管标题。

降级做法：照常生成文案，但**明确告诉用户「字符数未经校验」**，并请他自己数一遍再决定是否写入。不要说"标题 68 字符"这种没验过的数字。

## Cherry Studio 的 task 模式

Cherry 能把任务交给 Agent 连续跑。用它跑批量时，把流程**切成两段**：

**第 1 段（可以全自动跑完）**：取素材 → 选词 → 生成 → 机器校验 → 反复重写直到全过 → 出汇总表和待确认清单。
这段是耗时大头（20 条要拉三轮数据、生成、可能重写几轮），交给 task 正合适。

**第 2 段（必须人在场）**：写入。`apply_listing_update` **每次都弹审批卡**，人不点就停在那里——task 不会、也不得自动批准，禁止 `bypassPermissions`。

⚠️ **不要让 task 一口气 prepare 完整批然后挂着等审批。** 预览令牌**只有 15 分钟**，人没及时点完就整批过期，白跑一遍。做法是**分小组**（一组 5~8 条）：prepare 一组 → 人审完这组 → 再 prepare 下一组。

素材有缺口时，task 应该**停下来出待确认清单**，不要替用户假设答案继续跑。

## 临时文件放哪

草稿 JSON 和 patch 文件要落盘（`--patches @文件` 只能从文件读）。放**系统临时目录**，不要写进用户的项目目录或 skill 目录。文件里会有店铺 SKU 和文案，**不要提交进任何 git 仓库**。

## 写入通道：Cherry Studio 用 MCP

装了 MCP 就走 MCP，**不要给用户 CLI confirm 命令**——终端的 `--confirm` 要求交互式 TTY，运营在 Cherry 里跑不通，只会得到 `interactive_terminal_required` 报错。

完整写入流程见 [writing.md](writing.md)。
