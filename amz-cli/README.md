# amz-cli

给 AI Agent 用的亚马逊 SP-API 命令行工具(9 人运营团队内部使用)。

**📖 完整命令使用手册:[docs/COMMANDS.md](docs/COMMANDS.md)**(41 条命令的示例、参数、注意事项,给运营同事和 Agent 看)

**🍒 Cherry Studio 安装与更新:[docs/CHERRY_STUDIO_INSTALL.md](docs/CHERRY_STUDIO_INSTALL.md)**

架构参照飞书官方 [lark-cli](https://github.com/larksuite/cli) 的三层命令与错误契约设计。

## 开发环境运行

要求 Node.js ≥ 20。

```powershell
cd <仓库目录>\amz-cli
npm ci
copy .env.example .env      # 填入 LWA 凭证(见 .env.example 内注释)
npm run dev -- auth whoami  # 验证凭证链路
```

## AI Agent Skill

仓库内置可安装的 Agent Skill：[`skills/amz-cli/SKILL.md`](skills/amz-cli/SKILL.md)。它提供命令地图、`--help` 自查、JSON 错误处理和写操作安全规则，不重复展开全部命令。

在 Cherry Studio 中，CLI 与 Skill 必须分别安装。Cherry 需要访问 Git 仓库内层的 `amz-cli` 目录（同时包含 `package.json` 和 `dist`）；AI Skill 则按飞书 CLI 相同方式用 `npx skills add` 安装。已有 Agent 的当前工作目录在其他项目时，还要在该工作目录做一次项目级安装，让 `.claude/skills/amz-cli` 被当前会话发现。完整步骤见[安装指南](docs/CHERRY_STUDIO_INSTALL.md)。

发布到 GitHub 后，支持通用 Skills 安装器的 Agent 可按下面方式安装：

```powershell
npx skills add https://github.com/duomisenling/amzon-cli/tree/main/amz-cli/skills/amz-cli -y -g
```

确认安装：`npx skills ls -g` 的输出中应出现 `amz-cli`。

其他不自动发现项目 Skills 的环境，仍可把 [`docs/AGENT.md`](docs/AGENT.md) 作为系统提示词参考。

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
- 写操作必须 `--dry-run` 预览 → 人工确认 → `--confirm --preview-token <预览令牌>` 执行。令牌 15 分钟有效、只能使用一次，并且绑定命令、全部业务参数、Feed/patch 内容哈希以及当前店铺、Seller ID、区域和凭证环境；确认时任一项变化都会拒绝执行。
- Cherry Studio 可选用 `amz-cli-mcp`：`prepare_keyword_campaign` 只预览，`launch_keyword_campaign` 必须保留逐次人工审批；MCP 写入默认关闭，且不得使用 `bypassPermissions` 或把正式创建工具设为自动批准。
- 429 和安全的只读请求可自动退避重试；POST/PUT 写请求遇到 5xx 不自动重放，因为结果可能已经生效，必须先查询后台核对。
- 网络请求都有截止时间：Broker/LWA 30 秒、普通 SP-API/Ads API 60 秒、文件上传下载 120 秒，防止进程永久卡住。
- CLI 门禁用于防止误操作和普通非交互自动化，不是对同一电脑上恶意程序的强安全边界。若 Agent 能读取具写权限的 Amazon access token 或控制伪终端，必须依靠独立只读凭证或外部人工审批服务隔离。

## 数据边界(避免误解)

- **公开数据,任意商品可查**:商品目录(标题/图片/品牌/BSR 排名)、Buy Box 与报价概况——等同于商品页上任何人可见的信息,竞品也能查
- **私有数据,只能查自己店铺的**:订单、库存、listing、反馈——亚马逊服务端按凭证强制隔离,查不到任何其他卖家的私有数据
- **BSR 是排名不是销量**;任何卖家(包括竞品)的销量、库存、成本、广告数据都拿不到
- **已支持的买家数据会在 CLI 层脱敏**:订单输出经白名单剥离；卖家反馈报告会删除 Amazon 原始报告中的 `Rater Email` 列，无法识别格式时拒绝输出原文

## 安全

- 凭证只放 `.env`(已被 .gitignore 忽略)或已实现的 Token Broker,绝不写进代码
- access_token 只存进程内存,不落盘
- 运营同事的电脑上不允许出现 refresh_token(部署阶段走 broker 模式)
