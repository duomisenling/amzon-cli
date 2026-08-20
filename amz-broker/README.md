# amz-broker

amz-cli 的 Token Broker(部署在 Zeabur)。集中保管所有店铺的亚马逊长期凭证,
团队成员的 CLI 只能通过它领取 **1 小时短期令牌**——同事电脑上永远不出现
refresh_token(规格 §5.1)。

单文件(`server.mjs`)、无构建,Node ≥ 20。只依赖 `undici`(为了按店铺走出口代理)。

## 部署

有依赖了,所以启动前要 `npm ci`(平台构建步骤一般会自动跑)。

**A. Zeabur(独立一台)**

1. 把 `amz-broker` 目录推到一个 Git 仓库(私有),Zeabur 新建服务指向它
   (识别 package.json,启动命令 `npm start`)
2. 在控制台配置下面的环境变量
3. 部署后访问 `https://<你的域名>/health` 应返回 `{"ok":true}`

**B. 与出口代理同机(自有 VPS,如轻量服务器 + squid)**

配齐 `PROXY_<店铺>` 后 Broker 不再直连亚马逊,与某个主体的代理同机不构成牵连。
每个店铺的 `PROXY_<店铺>` 指向该店自己的出口代理(同机的可用 `http://user:pass@127.0.0.1:38128`,
异机的用公网地址):

- Broker 设 `HOST=127.0.0.1` 只监听本机,对外由 caddy/nginx 反代终结 TLS,
  不额外开公网端口(CLI 强制 BROKER_URL 为 HTTPS,需要一个域名指到本机)
- 用 systemd 独立系统用户运行(`NoNewPrivileges` + `ProtectSystem=strict`),
  凭证放 `EnvironmentFile`(权限 600,属主为该用户),与代理进程互不可读
- 代理密码、各人的 `TEAM_TOKEN` 必须是不同的串,不要复用

## 环境变量(在 Zeabur 控制台配置)

| 变量 | 说明 | 示例 |
|---|---|---|
| `HOST` | 监听地址;平台部署不填(0.0.0.0),自有 VPS 走反代时**必须**设 `127.0.0.1` | `127.0.0.1` |
| `TEAM_TOKENS` | 团队令牌白名单,`名字:令牌` 逗号分隔。**删条目=立即吊销** | `member_a:tok_a1b2...,member_b:tok_c3d4...` |
| `TEAM_ACCESS` | 成员到店铺/API/区域的 JSON 权限策略；缺失策略默认拒绝 | `{"member_a":{"stores":["SHOP_A"],"apis":["sp-api"],"regions":["na"]}}` |
| `LWA_CLIENT_ID` | SP-API 应用 client_id(全店铺共用的兜底) | `amzn1.application-oa2-client.xxx` |
| `LWA_CLIENT_SECRET` | SP-API 应用 client_secret | `amzn1.oa2-cs.v1.xxx` |
| `LWA_CLIENT_ID_<店铺>` | 该店铺自己注册的 app;多主体隔离时每店一套,未配则回落全局 | `LWA_CLIENT_ID_SHOP_A=...` |
| `LWA_CLIENT_SECRET_<店铺>` | 同上 | |
| `RT_SP_<店铺>_<区域>` | 各店铺 SP refresh_token,区域 NA/EU/FE | `RT_SP_SHOP_A_NA=Atzr\|xxx` |
| `SELLER_ID_<店铺>_<区域>` | 对应店铺、区域的 Seller ID；Listing 命令需要 | `SELLER_ID_SHOP_A_NA=A1EXAMPLE` |
| `PROXY_<店铺>` | 该店铺的出口代理;配了就从这个店铺自己的 IP 兑换令牌 | `PROXY_SHOP_A=http://user:pass@tinyproxy:8888` |
| `EGRESS_LABEL_<店铺>` | 出口标签,只写进审计日志便于核对(不含密码) | `EGRESS_LABEL_SHOP_A=shop-a-hk` |
| `ADS_CLIENT_ID` | 广告应用 client_id(拿到广告准入后配) | 同上格式 |
| `ADS_CLIENT_SECRET` | 广告应用 client_secret | |
| `ADS_CLIENT_ID_<店铺>` / `ADS_CLIENT_SECRET_<店铺>` | 按店铺覆盖广告应用凭证 | |
| `RT_ADS_<店铺>` | 各店铺广告 refresh_token | `RT_ADS_SHOP_A=Atzr\|yyy` |

### 按店铺出口代理(多主体隔离)

配了 `PROXY_<店铺>`,该店铺的 LWA 令牌兑换就从这个店铺自己的出口 IP 发出:

```
Broker ──► SHOP_A 代理(IP_A) ──► api.amazon.com   刷 A 的票
       ──► SHOP_B 代理(IP_B) ──► api.amazon.com   刷 B 的票
```

**Broker 本机的 IP 对亚马逊完全不可见**,所以 Broker 与某个主体的代理同机部署不再构成牵连,
也就同时拿到了"凭证集中可吊销"和"连刷新令牌都各走各 IP"两个好处。

两条约定与 amz-cli 的 `net/egress.ts` 一致:

1. **未配置 = 直连**。单主体部署不需要任何开关,不填即可。
2. **配置了代理但连不上 = 直接失败,绝不回退直连**(返回 `502 proxy_unreachable`)。
   这里比 CLI 那边更要紧:一旦静默回退,Broker 的真实 IP 就直接暴露给亚马逊,而且没有人会发现。

代理的目的地白名单需要放行 `api.amazon.com`(egress-proxy 的 `amazon-only.filter` 默认已包含)。
Broker 与代理同机时直接指向容器内网地址即可(如 `http://user:pass@tinyproxy:8888`),
不必绕出去再从 nginx 443 回来。

### Listing 升级部署顺序

Broker 返回的 Seller ID 与同一次颁发的店铺/区域 access token 共同构成 Listing 身份。CLI 在 Broker 模式下不会接受本地 `.env` 或 `--seller-id` 作为缺失配置的兜底；显式 `--seller-id` 只用于检测身份是否一致。

因此升级顺序必须是：

1. 为 `TEAM_ACCESS` 已授权的每个 `店铺 × SP-API 区域` 配齐 `SELLER_ID_<店铺>_<区域>`。
2. 先部署并验证新版 Broker。
3. 对每个组合执行一次只读 `listing mine` 或 `listing sku` 冒烟测试。
4. 再让同事更新 CLI。

缺少某个组合只会影响需要 Seller ID 的 `listing mine/sku/schema/update`；公开目录的 `listing search/get` 不受影响。

团队令牌自己生成即可(推荐 PowerShell:
`-join ((1..32) | %% { '{0:x}' -f (Get-Random -Max 16) })`,
或任何 32+ 位随机字符串)。

## 接口

```
GET  /health
     → {ok:true}(不公开店铺名称)

POST /token/mint
     Headers: X-Team-Token: <团队令牌>
     Body:    {"store":"SHOP_A", "api":"sp-api"|"ads", "region":"na"}
              (也接受 "marketplace":"US" 代替 region,自动映射)
     → 200 {access_token, expires_in, endpoint[, client_id][, seller_id]}
     → 400 参数错误 | 401 团队令牌无效 | 403 无店铺/API/区域权限
     → 413 请求体超过 16 KiB
     → 404 店铺未配置 | 502 refresh token 失效 / 代理不可达
```

`expires_in` 是这张票的**真实剩余寿命**,不是铸票时的 3600 —— 缓存命中时按真实到期时刻重算。
不能回填固定值:CLI 会按 `expires_in - 60` 缓存,回填 3600 会让常驻进程(MCP)
把一张只剩两分钟的票当新票用近一小时,期间全部请求 401,而 CLI 报的是
"授权已过期,请重新授权",完全指错方向。回归测试见 `tests/token-lifetime.test.mjs`。

## 审计日志(规格 §9:留存 ≥90 天)

每次发放/拒绝都输出一行 JSON 到 stdout(Zeabur 日志面板可查):

```json
{"ts":"2026-07-13T12:00:00.000Z","kind":"audit","event":"mint","member":"member_a","store":"SHOP_A","api":"sp-api","region":"na","ok":true,"egress":"shop-a-hk","cached":false}
```

- `egress` —— 这次令牌兑换从哪个出口发出(`EGRESS_LABEL_<店铺>`,未配则用脱敏后的代理地址,直连记 `direct`)。
  用来事后核对多主体隔离是否真的生效。
- `cached` —— `true` 表示命中进程内缓存、没有真的去 LWA,所以这一次没走出口。

⚠️ 请确认 Zeabur 的日志保留时长;若不足 90 天,需把日志转存到外部
(飞书 Bitable / 对象存储均可)。

## 安全设计

- 团队令牌用恒定时间比较(防时序攻击)
- 配了 `PROXY_<店铺>` 就只走代理,连不上直接失败,绝不回退直连(防 Broker 真实 IP 暴露)
- 报错与日志里的代理地址一律脱敏,不含用户名密码
- 每个成员必须通过 `TEAM_ACCESS` 显式获准店铺、API 和区域；未配置默认拒绝
- 任何响应都不包含 refresh_token / client_secret
- `api` 只接受 `sp-api` 或 `ads`，非法值不会静默回退；请求体限制为 16 KiB
- SP-API 响应可包含与获准店铺、区域绑定的 `seller_id`，用于 CLI 构造 Listing 路径
- token 进程内缓存(提前 120 秒过期),减少对 LWA 的调用
- 只有 `/token/mint` 一个功能接口——不代理业务请求,攻击面最小
- 生产部署必须使用 HTTPS；CLI 仅允许 localhost/127.0.0.1 开发环境使用 HTTP
- CLI 会校验 Broker 返回的 endpoint 必须与 API 类型和区域对应的 Amazon 官方地址完全一致，防止把短期 access token 发往自定义或错误端点
- 当前 Broker 不支持 SP-API sandbox；CLI 检测到 `BROKER_URL` 与 `SP_API_SANDBOX=true` 同时启用时会直接拒绝，避免误打生产环境

## 重要安全边界

当前 Broker 会把 Amazon 短期 bearer token 返回给 CLI。拿到团队令牌的进程仍可绕过 CLI，直接调用该成员获准店铺/API/区域内的 Amazon 接口；`TEAM_ACCESS` 只能限制横向访问，不能区分读写请求。

如果安全目标是“Agent 技术上绝不能写”，不要向 Agent 环境下发具写权限的 bearer token。应使用独立只读 Amazon 应用/角色，或把 Broker 升级为持有写凭证的审批代理，由它校验路径、方法和外部人工批准后代发写请求。
