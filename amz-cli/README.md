# amz-cli

给 AI Agent 用的亚马逊 SP-API 命令行工具(9 人运营团队内部使用)。

**🗣️ 运营同事怎么跟 AI 助手开口:[docs/运营使用手册.md](docs/运营使用手册.md)**（不懂技术也能照着说，含查数据/改动审批的示范话术）

**📖 完整命令使用手册:[docs/COMMANDS.md](docs/COMMANDS.md)**（命令示例、参数和注意事项，给运营同事与 Agent 使用）

**🍒 Cherry Studio 安装与更新:[docs/CHERRY_STUDIO_INSTALL.md](docs/CHERRY_STUDIO_INSTALL.md)**

架构参照飞书官方 [lark-cli](https://github.com/larksuite/cli) 的三层命令与错误契约设计。

## 快速安装

要求 Node.js ≥ 20。

```powershell
npx amz-cli@latest install --dry-run  # 可选：先看安装计划，不改系统
npx amz-cli@latest install
amz-cli --version
amz-cli config path
# 管理员生成一次 Windows 便携多店铺 MCP；同事安装同版本后可直接导入
amz-cli config mcp --combined --portable --accounts shop-a,shop-b,shop-c,shop-d,shop-e --output .\amz-cli-mcp.json
```

安装器会锁定同一个 npm 版本，同时安装全局 `amz-cli` / `amz-cli-mcp` 命令和 Agent Skill，并在首次安装时创建不含真实凭证的 `~/.amz-cli/.env` 模板；已有配置绝不覆盖。首次 npm 版本发布前若返回 404，请暂时使用下方“源码开发与应急安装”。

`--portable` 生成的 Windows JSON 不包含管理员电脑的 Node、用户名或项目绝对路径，可以直接发给同事导入。每台同事电脑仍需先安装同版本 `amz-cli`、放好对应的 `~/.amz-cli/accounts/<店铺>.env`，并在安装后重启 Cherry Studio；JSON 只负责 MCP 启动配置，不包含程序或 Amazon 凭证。

完整的 Cherry Studio、凭证、测试和更新步骤见[安装指南](docs/CHERRY_STUDIO_INSTALL.md)。

### 由 Cherry Studio Agent 安装

Cherry Studio 的技能库与 `npx skills` 的通用全局目录是两套登记机制。上面的安装命令会把同版本 Skill 安装到 `~/.agents/skills/amz-cli`，但仅看到这个文件夹，不代表 Skill 已经登记到 Cherry Studio。

如果当前安装者是 Cherry Studio Agent，完成上面的命令后还必须：

1. 使用 Cherry Studio **内置的 `skills` 工具**调用 `init`，参数为 `name=amz-cli`，取得 Cherry 全局技能目录。不要用外部命令 `npx skills` 代替这一步。
2. 将 `~/.agents/skills/amz-cli/` 中的全部文件复制到 `init` 返回的目录，不修改文件内容。若目标目录已有来源不明的同名文件，停止并询问用户，不得直接覆盖。
3. 确认目标目录包含 `SKILL.md`，再使用 Cherry 内置 `skills` 工具调用 `register`，参数为 `name=amz-cli`。
4. 使用 Cherry 内置 `skills list` 确认 `amz-cli` 已登记并为当前 Agent 启用，然后新开当前 Agent 的会话验证。

不得直接编辑 Cherry Studio 数据库。若当前 Agent 没有 Cherry 内置 `skills` 工具，应明确报告“CLI 和通用 Skill 已安装，但 Cherry 注册尚未完成”，再让用户到 Cherry 的 Skills 管理页面处理。Cherry 对技能采用按 Agent 启用：同一 Agent 的新会话可继续使用，换另一个 Agent 后需要在那个 Agent 中启用。

## AI Agent Skill

仓库内置可安装的 Agent Skill：[`skills/amz-cli/SKILL.md`](skills/amz-cli/SKILL.md)。它提供命令地图、`--help` 自查、JSON 错误处理和写操作安全规则，不重复展开全部命令。

正式安装器从 npm 全局包中安装同版本通用 Skill，避免 CLI 与操作说明漂移。Cherry Studio 还需要按上面的 `init` / `register` 流程登记到其技能库；登记后无需粘贴整份系统提示词，在 Agent 的“技能”页面确认 `amz-cli` 已启用并新开会话即可。

源码开发者也可以从仓库安装 Skill：

```powershell
$skillPath = (Resolve-Path .\skills\amz-cli).Path
npx skills add $skillPath -y -g
```

其他不自动发现项目 Skills 的环境，仍可把 [`docs/AGENT.md`](docs/AGENT.md) 作为系统提示词参考。

## 源码开发与应急安装

```powershell
git clone https://github.com/duomisenling/amzon-cli.git
cd amzon-cli\amz-cli
npm ci
npm run build
npm link
$skillPath = (Resolve-Path .\skills\amz-cli).Path
npx skills add $skillPath -y -g
amz-cli --help
```

源码开发可继续使用 `npm run dev -- ...`；真实写执行必须使用全局编译版 `amz-cli`，或先构建后运行 `node dist/cli.js`。

## 目录结构

```
src/
├── cli.ts                 # 入口:commander 装配 + 总错误出口
├── tools/                 # Tool Definition Layer(一份定义、两处注册)
│   ├── types.ts           #   ToolDefinition 接口
│   └── registry.ts        #   注册中枢 + 写操作门槛(架构级强制)
├── shortcuts/             # 功能定义(一个功能一个文件)
│   └── auth/whoami.ts     #   验证凭证,列出参与市场
└── internal/
    ├── credential/        # 凭证抽象:local(.env)/ Token Broker(Zeabur)
    ├── client/            # 自封 fetch client + 限流 + 安全重试 + 请求超时
    └── errs/              # 错误契约:类型化错误 + stdout/stderr 分离
```

## 约定(Agent 与脚本依赖的契约)

- **stdout** 只输出成功结果 JSON:`{ok:true, data, meta?}`
- **stderr** 输出进度与错误 JSON:`{ok:false, error:{type, subtype, hint_agent, hint_human, ...}}`
- exit code 由错误 type 派生:参数错=2,凭证/权限=3,限流=4,上游=1,内部=5,需确认=10
- 写操作必须 `--dry-run` 预览 → 人工确认 → `--confirm --preview-token <预览令牌>` 执行。令牌 15 分钟有效、只能使用一次，并且绑定命令、全部业务参数、Feed/patch 内容哈希、当前店铺、Seller ID、区域、凭证环境，以及 Listing/预算/竞价等预览所依据的远端当前状态；确认时任一项变化都会拒绝执行。
- Cherry Studio 可选用 `amz-cli-mcp`：Listing、Feed 和运营广告写操作均提供 `prepare_*` 预览与 `apply_*` 正式执行工具；完整关键词广告沿用 `prepare_keyword_campaign` / `launch_keyword_campaign`。多店铺推荐用 `amz-cli config mcp --combined --accounts ...` 生成一个路由 MCP：所有写工具的 `account` 都是必填项，外层按账号路由到隔离的固定店铺子进程；预览令牌绑定账号，跨店执行会被拒绝。旧的每店一个 MCP 配置继续兼容。正式工具必须逐次人工审批，MCP 写入默认关闭并受 `AMZ_MCP_ALLOWED_WRITES` 白名单限制；不得使用 `bypassPermissions` 或自动批准。
- 429 和安全的只读请求可自动退避重试；POST/PUT 写请求遇到 5xx 不自动重放，因为结果可能已经生效，必须先查询后台核对。
- 网络请求都有截止时间：Broker/LWA 30 秒、普通 SP-API/Ads API 60 秒、文件上传下载 120 秒，防止进程永久卡住。
- CLI 门禁用于防止误操作和普通非交互自动化，不是对同一电脑上恶意程序的强安全边界。若 Agent 能读取具写权限的 Amazon access token 或控制伪终端，必须依靠独立只读凭证或外部人工审批服务隔离。

## 盘点命令(Listing 与广告完备性)

一组只读命令,把数据可靠取出并吐成结构化 JSON(`{ok:true,data}` 信封);差集/打分/阈值判定由下游脚本完成,CLI 不做业务判定。大结果集用 `--out <文件>`。

- **全量在售清单(盘点分母)** — 复用现有 `report run`:
  `amz-cli report run --type GET_MERCHANT_LISTINGS_ALL_DATA --marketplace UK --out listings_uk.json`
  一条龙创建→轮询→下载→解压→解析 TSV(已处理 gzip、欧洲站 cp1252 编码、FATAL/CANCELLED)。

- **A+ 覆盖** — `amz-cli aplus coverage --marketplace DE`
  输出有已发布 A+ 的 ASIN,每条 `{asin, contentReferenceKey, status}`。默认只收 `APPROVED`(官方 `ContentStatus` 无 "PUBLISHED",用 `--status` 可放宽)。不含 Premium A+。底层:`aplus documents` / `aplus asins --content-key <key>`。

- **图片/变体粗筛** — `amz-cli catalog batch --asin-file asins.txt --marketplace DE --include images,relationships`
  自动按 20 个/片分片;查不到的 ASIN 输出 `{asin, found:false}`(与"不合格"区分)。

- **自己 listing 的 attributes(最准)** — `amz-cli listing batch --sku-file skus.txt --marketplace UK --out attrs.jsonl --concurrency 4`
  逐 SKU 拉取,结果**增量写入 jsonl**;中途中断重跑会**从断点续跑**(跳过 --out 里已完成的 SKU);单个 SKU 失败不中断整批,失败写 `<out>.failures.jsonl` 并在 stderr 汇总。

- **广告投放盘点** — `amz-cli ads coverage --profile-id 1234567890`
  输出正在投放的标的 `{asin, sku, adGroupId, campaignId, state}`,默认排除 `ARCHIVED`(`--state` 可调)。底层:`ads product-ads`(原样透传)、`ads profiles`(建立"主体×站点→profileId"映射)。广告用独立 `ADS_*` 凭证,按 `profileId` 定位,与 SP-API 无关。

## 数据边界(避免误解)

- **公开数据,任意商品可查**:商品目录(标题/图片/品牌/BSR 排名)、Buy Box 与报价概况——等同于商品页上任何人可见的信息,竞品也能查
- **私有数据,只能查自己店铺的**:订单、库存、listing、反馈——亚马逊服务端按凭证强制隔离,查不到任何其他卖家的私有数据
- **BSR 是排名不是销量**;任何卖家(包括竞品)的销量、库存、成本、广告数据都拿不到
- **已支持的买家数据会在 CLI 层脱敏**:订单输出经白名单剥离；卖家反馈报告会删除 Amazon 原始报告中的 `Rater Email` 列，无法识别格式时拒绝输出原文

## 安全

- 凭证只放项目 `.env`、用户目录 `~/.amz-cli/.env` 或 Token Broker，绝不写进代码；这些真实凭证文件都不得提交
- access_token 只存进程内存,不落盘
- **审计日志(按店铺分目录)**:每次 SP-API / Ads API 请求自动记一行到 `~/.amz-cli/audit/<账号>/<YYYY-MM>.log`(一行一个 JSON:时间、账号、操作、接口路径、区域、HTTP 状态——**只记"访问了什么",不记 PII 具体值**)。默认开启;用 `AMZ_AUDIT_DIR` 改存储路径,`AMZ_AUDIT_DISABLE=1` 关闭。写日志失败不影响业务请求。多店铺用 `--account <店铺>` 区分,日志自动按店铺分开;未指定则记为 `default`
- 长期多人部署优先走 Broker；本地 refresh token 只用于经过授权的可信电脑和小范围试用
