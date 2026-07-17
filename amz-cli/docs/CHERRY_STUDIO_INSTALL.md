# Cherry Studio Agent 安装与更新指南

本指南适合在 Windows 上把 amz-cli 接入 Cherry Studio。无需新建 Agent，也无需把 Git 仓库长期设为工作目录；正式安装后，CLI 和 Skill 都是用户级安装，可在任意工作目录使用。

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

## 二、一条命令安装

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
2. 从这个 npm 包中安装完全同版本的 Agent Skill，不从 GitHub `main` 混用其他版本。
3. 首次安装时创建不含真实凭证的 `%USERPROFILE%\.amz-cli\.env` 模板；已有文件绝不覆盖。

验证：

```powershell
amz-cli --version
amz-cli --help
npx skills ls -g
amz-cli config path
```

`--help` 应显示 `auth / listing / orders / sales / ads` 等命令组；Skills 列表应出现 `amz-cli`。

> 首次 npm 版本正式发布前，`npx amz-cli@latest` 会返回 404。此时使用本指南后面的“源码开发与应急安装”，不要下载来源不明的同名包。

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
2. 进入“技能”，确认 `amz-cli` 已启用；若没有，点击“添加更多技能”进入 Skills 管理页面检查安装结果。
3. 在“工具”或“权限模式”中，允许 Agent 执行终端/Bash 命令。
4. 保存后新开一个会话，让 Skill 清单重新加载。

正式 npm 安装后不要求把 amz-cli Git 仓库设为工作目录。已有 Agent 可以直接使用；如果希望隔离 Amazon 权限，也可以建立专用 Agent，但这属于安全管理选择，不是技术要求。

不要把整份 `docs/AGENT.md` 粘贴进系统提示词。支持 Skill 的环境使用已安装的 `amz-cli` Skill；`docs/AGENT.md` 只作为不支持 Skill 的兼容说明。

## 五、可选：完整关键词广告 MCP

普通查询、普通 CLI 命令和所有 `--dry-run` 都不依赖 MCP。只有希望实现“AI 展示完整广告方案 → 你在 Cherry 审批 → 自动创建并在校验后启动”时才配置。

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
名称: Amazon Ads Safe Launch
类型: stdio
命令: 上面 $node 输出的完整路径
参数: 上面 $mcpServer 输出的完整路径
环境变量:
  AMZ_MCP_ALLOW_WRITES=true
```

MCP 默认也会回退读取 `%USERPROFILE%\.amz-cli\.env`。只有明确希望它读取某个项目目录的 `.env` 时，才额外设置：

```text
AMZ_CLI_PROJECT_DIR=C:\你的\项目目录
```

安全设置必须同时满足：

1. Agent 权限模式使用 `default`，禁止 `bypassPermissions`。
2. `launch_keyword_campaign` 每次调用都需要人工批准，不能加入自动批准列表。
3. `prepare_keyword_campaign` 是只读预览；`launch_keyword_campaign` 会创建广告并可能开始花钱。
4. 审批卡中的预算、商品、关键词数量或最终状态与预览不一致时，拒绝审批并重新 prepare。

MCP 的两个工具：

- `prepare_keyword_campaign`：本地校验完整方案，零 Amazon 写请求，返回 15 分钟有效的一次性 `previewToken`。
- `launch_keyword_campaign`：只接受同一方案和对应令牌；方案、账户、环境发生变化，或令牌过期/已使用，都会拒绝。

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

### 5. 完整关键词广告预览测试

```powershell
amz-cli ads keyword-campaign-launch --plan .\my-keyword-campaign.json --dry-run
```

若已配置 MCP，Agent 应调用 `prepare_keyword_campaign`。两条路径都必须展示 PAUSED 创建、全部关键词、日预算、最终是否启用和预览令牌，并且不能产生 Amazon 写请求。

首次真实写入只使用 Amazon Ads 测试账户或明确指定的非核心商品。任一子对象失败时，结果必须显示 Campaign 保持暂停，不得报告“已经启动”。

## 七、更新与卸载

更新 CLI 和同版本 Skill：

```powershell
npx amz-cli@latest install
amz-cli --version
```

安装器会保留 `%USERPROFILE%\.amz-cli\.env`，不会覆盖凭证。更新后新开 Cherry 会话，避免旧会话继续使用更新前的 Skill 上下文。

卸载程序和 Skill：

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
npx skills ls -g
amz-cli --version
```

若 CLI 存在但 Skills 列表没有 `amz-cli`，重新运行：

```powershell
npx amz-cli@latest install
```

然后在 Cherry 的 Agent“技能”页面启用它并新开会话。不要把 Skill 项目级安装进一个无关项目来绕过问题，否则容易出现 Skill 找到了、CLI 或凭证路径却不一致。

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

不需要。已有 Cherry Agent 可以启用全局 `amz-cli` Skill。只有希望把 Amazon 凭证和其他项目隔离时，才建议建立专用 Agent。
