# Cherry Studio Agent 安装与更新指南

本指南适合在 Windows 上把 amz-cli 接入 Cherry Studio。无需新建 Agent，也无需把 Git 仓库长期设为工作目录。正式安装会先完成用户级 CLI 和通用 Skill 安装；随后还要用 Cherry Studio 内置的 `skills` 工具完成一次登记，才能在不依赖项目工作目录的新会话中持续使用。

## 一、安装前准备

需要：

- Node.js 20 或更高版本（自带 npm / npx）
- Cherry Studio Agent 的终端/Bash 工具权限
- 管理员提供的本地凭证文件，或 Broker 地址、团队令牌、店铺代号和默认区域

在 PowerShell 检查：

```powershell
node --version
npm --version
```

`node --version` 必须是 `v20` 或更高。npm 安装不要求同事拥有 GitHub 账号，也不要求安装 Git。

## 二、安装 CLI 与通用 Skill

可先只看计划，不修改系统、不安装全局包：

```powershell
npx amz-cli@latest install --dry-run
```

确认后正式安装：

```powershell
npx amz-cli@latest install
```

安装器会完成：

1. 安装或升级全局 `amz-cli` 与 `amz-cli-mcp` 命令。
2. 从这个 npm 包中把完全同版本的 Agent Skill 安装到通用全局目录 `~/.agents/skills/amz-cli`，不从 GitHub `main` 混用其他版本。
3. 首次安装时创建不含真实凭证的 `%USERPROFILE%\.amz-cli\.env` 模板；已有文件绝不覆盖。

验证：

```powershell
amz-cli --version
amz-cli --help
amz-cli config path
Test-Path "$env:USERPROFILE\.agents\skills\amz-cli\SKILL.md"
```

`--help` 应显示 `auth / listing / orders / sales / ads` 等命令组；最后一项应返回 `True`。这只证明通用 Skill 已安装，**不代表 Cherry Studio 已经登记该 Skill**。

> 首次 npm 版本正式发布前，`npx amz-cli@latest` 会返回 404。此时使用本指南后面的“源码开发与应急安装”，不要下载来源不明的同名包。

### Cherry Studio 持久注册（必须）

如果由 Cherry Studio Agent 协助安装，把下面整段要求交给它。这里的 `skills` 指 Cherry Studio 注入给 Agent 的内置工具，不是 PowerShell 中的 `npx skills` 命令：

```text
请完成 amz-cli 的 Cherry Studio 持久注册：

1. 先确认 amz-cli --version 成功，并确认
   ~/.agents/skills/amz-cli/SKILL.md 存在。
2. 调用 Cherry Studio 内置 skills 工具的 init 操作，name=amz-cli，
   取得 Cherry 全局技能目录。不要用 npx skills 代替。
3. 将 ~/.agents/skills/amz-cli/ 中的全部文件复制到 init 返回的目录，
   不修改文件内容。
4. 如果目标目录存在来源不明的同名文件，立即停止并告诉我，不要覆盖，
   也不要直接修改 Cherry Studio 数据库。
5. 确认目标目录包含 SKILL.md 后，调用 Cherry 内置 skills 工具的
   register 操作，name=amz-cli。
6. 调用 Cherry 内置 skills list，确认 amz-cli 已登记并为当前 Agent
   启用；最后只报告安装路径和启用状态，不输出任何 .env 内容。
```

Cherry 内置 `register` 会把目录登记到 Cherry 的技能库，并为当前 Agent 启用。只运行外部 `npx skills add`、只看到 `~/.agents/skills/amz-cli`，或者只把 Git 仓库加入工作目录，都不等于完成了 Cherry 注册。

注册后检查：

```powershell
Test-Path "$env:APPDATA\CherryStudio\Data\Skills\amz-cli\SKILL.md"
```

结果应为 `True`，并且 Cherry Studio 的“设置 → Skills”中应出现 `amz-cli`。如果内置 `skills list` 显示已登记，但这个固定路径不存在，以内置工具返回的实际路径为准，不要手动修改 Cherry 数据库。

## 三、配置凭证

默认用户配置路径：

```text
C:\Users\你的用户名\.amz-cli\.env
```

CLI 的配置优先级是：

```text
系统环境变量 > 当前项目中含 amz-cli 配置的 .env > ~/.amz-cli/.env
```

项目配置和用户配置不会混合，防止不同店铺、区域或 Broker 身份串用。

### 方案 A：暂不部署 Broker，使用本地凭证

安装器创建的模板来自 `.env.local.example`。只填写实际需要的店铺和区域：

```dotenv
LWA_CLIENT_ID=
LWA_CLIENT_SECRET=
LWA_REFRESH_TOKEN_NA=
SP_API_REGION=na
SELLER_ID_NA=

# 使用广告功能时再填写
ADS_CLIENT_ID=
ADS_CLIENT_SECRET=
ADS_REFRESH_TOKEN=
ADS_REGION=na
```

欧洲或远东账号分别填写 `_EU` / `_FE`。本地模式不要设置 `BROKER_URL`、`TEAM_TOKEN`、`STORE`。

本地凭证模式可以直接使用，但 Refresh Token 和 Client Secret 会保存在同事电脑。只适合经过授权的可信电脑和小范围试用；不要把你自己的完整 `.env` 原样分发给所有人。

### 方案 B：Broker 模式

同事电脑只保存下面四项，不保存 Amazon Refresh Token 或 Client Secret：

```dotenv
BROKER_URL=https://你的-broker-域名
TEAM_TOKEN=管理员单独发给该同事的团队令牌
STORE=SHOP_A
SP_API_REGION=na
```

注意：

- 每位同事使用独立 `TEAM_TOKEN`，方便吊销和审计。
- `STORE`、API 和区域是否可用，由 Broker 的 `TEAM_ACCESS` 决定。
- `listing mine/sku/schema/update` 要求 Broker 为对应店铺和区域配置 Seller ID；`--seller-id` 不能替代 Broker 缺失的身份。
- CLI 与 Broker 协同更新时，先部署并验证 Broker 配置，再通知同事升级 CLI。

### 凭证传递纪律

- 真实 `.env` 不得发送到普通聊天、邮件、工单或 GitHub。
- 使用加密文件传递，密码通过另一条渠道发送。
- 不要截图，不要让 Agent 输出文件内容。
- 同事离职、电脑丢失或怀疑泄露时，立即撤销或轮换相关凭证。

## 四、接入现有 Cherry Studio Agent

1. 打开 Cherry Studio 的 Agent 编辑页面。
2. 进入“技能”，确认已登记的 `amz-cli` 对当前 Agent 启用；若没有，点击“添加更多技能”进入 Skills 管理页面检查注册结果。
3. 在“工具”或“权限模式”中，允许 Agent 执行终端/Bash 命令。
4. 保存后新开一个会话，让 Skill 清单重新加载。

完成 npm 安装和 Cherry `register` 后，不要求把 amz-cli Git 仓库设为工作目录。已有 Agent 可以直接启用；同一个 Agent 的新会话会继续使用该技能，换另一个 Agent 后需要在那个 Agent 中启用。如果希望隔离 Amazon 权限，也可以建立专用 Agent，但这属于安全管理选择，不是技术要求。

不要把整份 `docs/AGENT.md` 粘贴进系统提示词。支持 Skill 的环境使用已安装的 `amz-cli` Skill；`docs/AGENT.md` 只作为不支持 Skill 的兼容说明。

## 五、可选：安全写操作 MCP

普通查询、普通 CLI 命令和所有 `--dry-run` 都不依赖 MCP。只有希望实现“AI 展示预览 → 你在 Cherry 审批卡点允许 → Agent 正式执行并回查”时才配置。当前覆盖 Listing 修改、Feed 提交、广告活动创建/启停/预算、关键词竞价、否定关键词和完整关键词广告。

查找全局 MCP 服务文件：

```powershell
$npmRoot = npm root -g
$mcpServer = Join-Path $npmRoot 'amz-cli\dist\mcp-server.js'
$node = Get-Command node | Select-Object -ExpandProperty Source
$node
$mcpServer
Test-Path $mcpServer
```

在 Cherry Studio 的 MCP 服务器设置中新增 `stdio` 服务：

```text
名称: Amazon Safe Writes
类型: stdio
命令: 上面 $node 输出的完整路径
参数: 上面 $mcpServer 输出的完整路径
环境变量:
  AMZ_MCP_ALLOW_WRITES=true
  AMZ_MCP_ALLOWED_WRITES=listing.update,ads.campaign-create,ads.campaign-state,ads.campaign-budget,ads.keyword-bid,ads.negative-keyword,ads.keyword-campaign-launch
```

只有确实需要 Feed 批量提交的运营环境才在白名单追加 `feed.submit`。不要为了省事使用 `*`。白名单的取值语义：

- **未设置** `AMZ_MCP_ALLOWED_WRITES`：为兼容旧版只开放 `ads.keyword-campaign-launch`，其他正式写工具安全拒绝。
- **显式设置为空**（`AMZ_MCP_ALLOWED_WRITES=` 留空）：拒绝全部正式写入，包括旧默认操作。想吊销所有写权限时用这个。
- **设置了列表**：只开放列表内的操作；旧默认操作如仍需要必须显式列入。

注意：`prepare_*` 不受写开关和白名单限制（预览本来就是希望 Agent 自动完成的部分），但它会使用配置的凭证发起真实 Amazon API 调用——包括只读查询和 Listing 的 `VALIDATION_PREVIEW` PATCH（官方保证不落库、不产生变更）。`prepare_*` 的返回里有 `applyAllowed` 字段，预告当前环境是否会放行对应的 `apply_*`；为 `false` 时令牌无法兑现，不要发起审批。

MCP 默认也会回退读取 `%USERPROFILE%\.amz-cli\.env`。只有明确希望它读取某个项目目录的 `.env` 时，才额外设置：

```text
AMZ_CLI_PROJECT_DIR=C:\你的\项目目录
```

安全设置必须同时满足：

1. Agent 权限模式使用 `default`，禁止 `bypassPermissions`。
2. 所有 `apply_*` 和 `launch_keyword_campaign` 每次调用都需要人工批准，不能加入自动批准列表。
3. `prepare_*` 只做本地检查、只读查询或 Amazon `VALIDATION_PREVIEW`；`apply_*` / `launch_*` 才会正式写入。
4. 审批卡中的站点、账号、SKU、文件、预算、竞价、关键词或最终状态与预览不一致时，拒绝审批并重新 prepare。
5. 聊天文字里的“确认”“Y”不能代替 Cherry 工具审批卡。

MCP 工具采用成对设计：

- `prepare_listing_update` / `apply_listing_update`
- `prepare_feed_submit` / `apply_feed_submit`
- `prepare_ads_campaign_create` / `apply_ads_campaign_create`
- `prepare_ads_campaign_state` / `apply_ads_campaign_state`
- `prepare_ads_campaign_budget` / `apply_ads_campaign_budget`
- `prepare_ads_keyword_bid` / `apply_ads_keyword_bid`
- `prepare_ads_negative_keyword` / `apply_ads_negative_keyword`
- `prepare_keyword_campaign` / `launch_keyword_campaign`

预览令牌 15 分钟有效且只能使用一次，并绑定业务参数、账号、区域、凭证环境、文件内容，以及 Listing/预算/竞价等操作预览时的远端当前状态。执行前状态有变化会拒绝旧令牌。Listing 正式提交后的即时回读可能仍是旧值；Feed 返回 `SUBMITTED`/队列状态后还必须等待 `DONE` 并读取结果文档，不能提前宣称全部成功。

不配置 MCP 不影响 CLI 安全性；正式写执行仍可由本人在 PowerShell 中运行 `--confirm --preview-token ...`。

## 六、分步测试

### 1. 纯本地帮助测试

对 Agent 说：

```text
请使用 amz-cli Skill，只查看 sales stats 的帮助，不调用 Amazon API，也不要执行写操作。
```

Agent 应执行：

```powershell
amz-cli sales stats --help
```

### 2. 只读凭证测试

对 Agent 说：

```text
请使用 amz-cli 执行只读的 auth whoami，告诉我当前账号有哪些 Amazon 市场，不要执行任何写操作。
```

对应命令：

```powershell
amz-cli auth whoami
```

这一步会访问 Amazon，但只读取账号参与市场，不修改数据。

### 3. 业务只读测试

```text
请查询 US 店铺最近 7 天的销售情况，用中文汇总订单数、销量和销售额，不要执行写操作。
```

Agent 应先按 Skill 或 `--help` 自查，再执行 `sales stats`。

### 4. 意图判断测试

明确请求：

```text
查 ASIN B0XXXXXXXX 在 US 站最近 30 天的销量和销售额，只读查询。
```

Agent 应选择 `sales stats --asin`，不应创建全店报告。

有重大歧义的请求：

```text
帮我做个销售报告。
```

Agent 应询问需要“单个商品表现、全店汇总，还是导出全店明细文件”，不应直接调用 CLI；若上下文已明确站点、商品和时间范围，不应重复询问。

### 5. MCP 写操作预览测试

```powershell
amz-cli ads keyword-campaign-launch --plan .\my-keyword-campaign.json --dry-run
```

若已配置 MCP，完整关键词广告应调用 `prepare_keyword_campaign`；普通 Listing/Feed/广告修改应调用对应的 `prepare_*`。预览必须展示目标、改动、风险和预览令牌，正式工具在用户批准审批卡前不得调用。

首次真实写入只使用 Amazon Ads 测试账户或明确指定的非核心商品。任一子对象失败时，结果必须显示 Campaign 保持暂停，不得报告“已经启动”。

## 七、更新与卸载

更新 CLI 和同版本 Skill：

```powershell
npx amz-cli@latest install
amz-cli --version
```

安装器会保留 `%USERPROFILE%\.amz-cli\.env`，不会覆盖凭证。更新命令会刷新 `~/.agents/skills/amz-cli`，但不会自动改写 Cherry 内部登记；随后应让 Cherry Agent 用内置 `skills list` 找到现有 `amz-cli` 路径，把通用目录中的同版本文件同步过去，再调用 `register name=amz-cli`。如果现有目录不是 Cherry 管理的 `amz-cli`，或含有来源不明的同名文件，应停止并让用户核对，不得盲目覆盖。完成后新开 Cherry 会话，避免旧会话继续使用更新前的 Skill 上下文。

卸载前先在 Cherry Studio 的 Skills 管理页面卸载 `amz-cli`，让 Cherry 清理登记和 Agent 链接；然后卸载程序和通用 Skill：

```powershell
npm uninstall -g amz-cli
npx skills remove amz-cli -g -y
```

卸载不会自动删除 `%USERPROFILE%\.amz-cli`，防止误删凭证和预览状态。确认不再使用后，由本人单独处理该目录。

## 八、源码开发与应急安装

首次 npm 版本尚未发布、npm 不可用或需要参与开发时：

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

`npm link` 让全局 `amz-cli` 指向这个源码目录。开发更新时：

```powershell
git pull --ff-only
npm ci
npm run build
$skillPath = (Resolve-Path .\skills\amz-cli).Path
npx skills add $skillPath -y -g
```

如果 `git pull --ff-only` 提示本地文件冲突，不要删除目录或强制重置；先检查本地修改。

## 九、常见问题

### Agent 说找不到 amz-cli Skill

```powershell
amz-cli --version
Test-Path "$env:USERPROFILE\.agents\skills\amz-cli\SKILL.md"
Test-Path "$env:APPDATA\CherryStudio\Data\Skills\amz-cli\SKILL.md"
```

按结果判断：

- CLI 不存在：重新运行正式安装。
- CLI 存在，但第一个 `Test-Path` 为 `False`：通用 Skill 没有安装完整，重新运行正式安装。
- 第一个为 `True`、第二个为 `False`：CLI 和通用 Skill 已安装，但尚未登记到 Cherry；按本指南“Cherry Studio 持久注册”执行 `init` / `register`。
- 两项均为 `True`，但当前 Agent 找不到：在当前 Agent 的“技能”页面启用 `amz-cli` 并新开会话。

重新安装命令：

```powershell
npx amz-cli@latest install
```

不要把 Skill 项目级安装进一个无关项目来绕过注册，否则容易出现当前工作目录能找到、换会话就消失，或者 CLI 与凭证路径不一致。

### PowerShell 找不到 `amz-cli`

关闭并重新打开 PowerShell，再检查：

```powershell
npm prefix -g
Get-Command amz-cli
```

如果 npm 全局目录不在 `PATH`，修复 Node.js/npm 安装后重新运行安装器。

### `npx amz-cli@latest` 返回 404

说明 npm 首次版本还没有发布，或当前 npm registry/mirror 尚未同步。确认 registry 后使用“源码开发与应急安装”，不要安装来源不明的同名包。

### Agent 能查帮助，但店铺查询失败

查看错误 JSON 中的 `hint_human`。常见原因是本地凭证不完整、Broker 四项不完整、团队令牌被吊销、店铺/API/区域不在授权范围，或 Broker 没有配置该区域 Seller ID。

### 是否必须新建 Agent

不需要。已有 Cherry Agent 可以启用 Cherry 技能库中已登记的 `amz-cli`。只有希望把 Amazon 凭证和其他项目隔离时，才建议建立专用 Agent。Cherry 的启用状态按 Agent 保存，因此换另一个 Agent 后需要为它单独启用。
