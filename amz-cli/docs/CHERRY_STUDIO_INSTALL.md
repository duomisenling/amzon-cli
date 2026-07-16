# Cherry Studio Agent 安装与更新指南

本指南适合在 Windows 上把 amz-cli 接入 Cherry Studio。无需新建 Agent：已有 Agent 也可以直接添加本项目工作目录。

## 一、安装前准备

需要：

- Git
- Node.js 20 或更高版本
- 管理员发放的 Broker 地址、团队令牌、店铺代号和默认区域
- Cherry Studio Agent 的终端/Bash 工具权限

在 PowerShell 检查：

```powershell
git --version
node --version
npm --version
```

`node --version` 必须是 `v20` 或更高。

## 二、从 GitHub 安装

建议安装到固定目录，例如 `C:\Tools`：

```powershell
cd C:\Tools
git clone https://github.com/duomisenling/amzon-cli.git
cd C:\Tools\amzon-cli\amz-cli
npm ci
npm run build
node dist\cli.js --help
```

最后一条命令显示 `auth / listing / orders / sales / ads` 等命令组，即表示程序构建成功。

- 公开仓库：同事不需要 GitHub 账号即可克隆和更新。
- 私有仓库：每位同事都必须获得仓库权限并完成 GitHub 登录，否则无法拉取。
- 不推荐下载 ZIP 作为日常安装方式；ZIP 能运行，但以后无法用 `git pull` 增量更新。

仓库有两层同名相近目录，这是最容易选错的地方：

```text
C:\Tools\amzon-cli\          ← Git 仓库外层，不要选作 Cherry 工作目录
├─ amz-broker\
└─ amz-cli\                  ← CLI 项目，也是 Cherry 工作目录
   ├─ dist\
   ├─ .claude\skills\amz-cli\SKILL.md
   └─ package.json
```

## 三、配置同事版凭证

同事电脑使用 Broker，不保存 Amazon refresh token 或 Client Secret。

```powershell
cd C:\Tools\amzon-cli\amz-cli
Copy-Item .env.example .env
notepad .env
```

至少配置下面四项：

```dotenv
BROKER_URL=https://你的-broker-域名
TEAM_TOKEN=管理员单独发给该同事的团队令牌
STORE=SHOP_A
SP_API_REGION=na
```

注意：

- `.env` 不能发送到聊天、邮件或 GitHub。
- 每位同事应使用独立 `TEAM_TOKEN`，方便吊销和审计。
- `STORE`、API 和区域是否可用，由 Broker 的 `TEAM_ACCESS` 决定。
- 同事版不要填写 `LWA_REFRESH_TOKEN`、`LWA_CLIENT_SECRET`、`ADS_REFRESH_TOKEN`。

## 四、接入现有 Cherry Studio Agent

1. 打开 Cherry Studio 的 Agent 编辑页面。
2. 找到“工作目录”，点击 `+`。
3. 选择精确目录：

   ```text
   C:\Tools\amzon-cli\amz-cli
   ```

4. 在“工具”或“权限模式”中，允许 Agent 读取项目文件并执行终端/Bash 命令。
5. 保存配置，建议新开一个会话，让工作目录和 Skill 清单重新加载。

Cherry Studio 会扫描工作目录中的：

```text
.claude\skills\amz-cli\SKILL.md
```

因此不需要把整份 `docs/AGENT.md` 粘贴进系统提示词，也不需要另外运行 `npx skills add`。`docs/AGENT.md` 只用于不支持项目 Skill 自动发现的环境。

## 五、可选：接入完整关键词广告 MCP

只添加工作目录时，Cherry 已经能直接运行绝大多数 CLI 命令和所有 `--dry-run`。如果还希望实现“AI 展示完整广告方案 → 你在 Cherry 审批 → 自动创建并在校验后启动”，再配置本项目的本地 MCP；普通查询并不依赖它。

先确认 MCP 构建成功：

```powershell
cd C:\Tools\amzon-cli\amz-cli
npm ci
npm run build
Test-Path .\dist\mcp-server.js
```

在 Cherry Studio 的 MCP 服务器设置中新增一个 `stdio` 服务器：

```text
名称: Amazon Ads Safe Launch
类型: stdio
命令: C:\Program Files\nodejs\node.exe
参数: C:\Tools\amzon-cli\amz-cli\dist\mcp-server.js
环境变量:
  AMZ_CLI_PROJECT_DIR=C:\Tools\amzon-cli\amz-cli
  AMZ_MCP_ALLOW_WRITES=true
```

如果 Node 安装在其他目录，用 `Get-Command node | Select-Object -ExpandProperty Source` 查询真实路径。`AMZ_CLI_PROJECT_DIR` 用来让 MCP 从项目目录读取 `.env`；不要把 `.env` 内容复制进 MCP 参数或聊天。

安全设置必须同时满足：

1. Agent 权限模式使用 `default`，禁止 `bypassPermissions`。
2. `launch_keyword_campaign` 必须保留为每次调用都需要人工批准，不能加入自动批准列表。
3. `prepare_keyword_campaign` 是只读预览，可以自动调用；`launch_keyword_campaign` 会创建广告并可能开始花钱。
4. 审批卡中展示的预算、商品、关键词数量和最终状态与预览不一致时，拒绝审批并重新 prepare。

MCP 的两个工具：

- `prepare_keyword_campaign`：本地校验完整方案，零 Amazon 写请求，返回 15 分钟有效的一次性 `previewToken`。
- `launch_keyword_campaign`：只接受同一份方案和对应令牌；方案任何字段变化、环境/账户变化、令牌过期或已经使用都会拒绝。

如果不配置 MCP，安全性不受影响，只是正式创建需要把 CLI 给出的 `--confirm --preview-token ...` 命令交给本人在 PowerShell 中运行。

## 六、分步测试

### 1. 纯本地帮助测试（不访问 Amazon）

对 Agent 说：

```text
请读取当前项目的 amz-cli Skill，只查看 sales stats 的帮助，不调用 Amazon API，也不要执行写操作。
```

Agent 应在工作目录执行类似命令：

```powershell
node dist/cli.js sales stats --help
```

### 2. 只读凭证测试

对 Agent 说：

```text
请使用 amz-cli 执行只读的 auth whoami，告诉我当前账号有哪些 Amazon 市场，不要执行任何写操作。
```

对应命令：

```powershell
node dist/cli.js auth whoami
```

这一步会连接 Broker 和 Amazon，但只读取账号参与市场，不修改数据。

### 3. 业务只读测试

对 Agent 说：

```text
请查询 US 店铺最近 7 天的销售情况，用中文汇总订单数、销量和销售额，不要执行写操作。
```

Agent 应先按 Skill 或 `--help` 自查，再执行 `sales stats`。确认只读链路稳定后，才测试写命令的 `--dry-run`。未配置 MCP 时，真正的 `--confirm` 必须由本人在 PowerShell 终端运行；配置了安全 MCP 时，只有 `launch_keyword_campaign` 可以改由 Cherry 逐次审批执行。

### 4. 意图判断测试

先说一个明确请求：

```text
查 ASIN B0XXXXXXXX 在 US 站最近 30 天的销量和销售额，只读查询。
```

Agent 应直接选择 `sales stats --asin`，不应创建全店报告。再说一个有重大歧义的请求：

```text
帮我做个销售报告。
```

Agent 应先询问你需要“单个商品表现、全店汇总，还是导出全店明细文件”，不应直接调用 CLI。若上下文已经给过站点、商品和时间范围，Agent 不应重复询问。

### 5. 完整关键词广告预览测试（不写 Amazon）

把 `examples/keyword-campaign-plan.example.json` 复制一份并替换成测试数据，然后对 Agent 说：

```text
读取 my-keyword-campaign.json，只预览完整关键词广告，不要正式创建。
```

CLI 路径应调用：

```powershell
node dist\cli.js ads keyword-campaign-launch --plan .\my-keyword-campaign.json --dry-run
```

若已配置 MCP，Agent 应调用 `prepare_keyword_campaign`。两条路径都必须展示 PAUSED 创建、全部关键词、日预算、最终是否启用和预览令牌，并且不能产生 Amazon 写请求。

首次真实写入只使用 Amazon Ads 测试账户或你明确指定的非核心商品。确认审批后，如果任一子对象失败，结果必须显示 Campaign 保持暂停；不得报告“已经启动”。

## 七、以后如何更新

不需要删除旧目录，也不需要重新配置 Cherry Agent：

```powershell
cd C:\Tools\amzon-cli
git pull --ff-only
cd amz-cli
npm ci
npm run build
node dist\cli.js --version
```

Cherry 工作目录没有变化，新的代码、帮助和 Skill 会继续从原目录加载。更新后新开一个 Agent 会话，避免旧会话仍使用更新前的 Skill 上下文。

如果 `git pull --ff-only` 提示本地文件冲突，不要删除目录或强制重置；先联系管理员检查本地修改。

## 八、常见问题

### Agent 说找不到 amz-cli Skill

依次检查：

```powershell
cd C:\Tools\amzon-cli\amz-cli
Test-Path .claude\skills\amz-cli\SKILL.md
Test-Path skills\amz-cli\SKILL.md
```

两项都应返回 `True`。然后确认 Cherry 工作目录选的是内层 `amz-cli`，保存后新开会话。

### 找不到 `dist\cli.js`

```powershell
cd C:\Tools\amzon-cli\amz-cli
npm ci
npm run build
```

`dist` 是本机构建产物，不会随 Git 仓库提交；只克隆仓库还不能直接运行。

### `npm ci` 失败

确认当前目录同时存在 `package.json` 和 `package-lock.json`，并检查 Node.js 是否至少为 20。

### GitHub 要求登录或拉取失败

先在浏览器打开仓库地址。若仓库是私有的，同事必须被授予权限；若希望同事不使用 GitHub 账号，需要把仓库设为公开，或由管理员提供公司内部的发布渠道。

### Agent 能查帮助，但执行店铺查询失败

查看错误 JSON 中的 `hint_human`。常见原因是 `.env` 的 Broker 四项不完整、团队令牌被吊销、店铺/API/区域不在 `TEAM_ACCESS` 授权范围，或 Broker 没有配置该区域店铺。

### 是否必须新建 Agent

不需要。同一个 Cherry Agent 可以添加多个工作目录；把本项目内层 `amz-cli` 目录加入现有 Agent 即可。若希望把 Amazon 权限与其他项目隔离，也可以另建专用 Agent，但这属于管理选择，不是技术要求。
