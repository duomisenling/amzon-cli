# amz-broker

amz-cli 的 Token Broker(部署在 Zeabur)。集中保管所有店铺的亚马逊长期凭证,
团队成员的 CLI 只能通过它领取 **1 小时短期令牌**——同事电脑上永远不出现
refresh_token(规格 §5.1)。

零依赖、单文件(`server.mjs`)、无构建,Node ≥ 20。

## 部署(Zeabur)

1. 把 `amz-broker` 目录推到一个 Git 仓库(私有),Zeabur 新建服务指向它
   (识别 package.json,启动命令 `npm start`)
2. 在 Zeabur 控制台配置下面的环境变量
3. 部署后访问 `https://<你的域名>/health` 应返回 `{"ok":true,...}`

## 环境变量(在 Zeabur 控制台配置)

| 变量 | 说明 | 示例 |
|---|---|---|
| `TEAM_TOKENS` | 团队令牌白名单,`名字:令牌` 逗号分隔。**删条目=立即吊销** | `member_a:tok_a1b2...,member_b:tok_c3d4...` |
| `TEAM_ACCESS` | 成员到店铺/API/区域的 JSON 权限策略；缺失策略默认拒绝 | `{"member_a":{"stores":["SHOP_A"],"apis":["sp-api"],"regions":["na"]}}` |
| `LWA_CLIENT_ID` | SP-API 应用 client_id | `amzn1.application-oa2-client.xxx` |
| `LWA_CLIENT_SECRET` | SP-API 应用 client_secret | `amzn1.oa2-cs.v1.xxx` |
| `RT_SP_<店铺>_<区域>` | 各店铺 SP refresh_token,区域 NA/EU/FE | `RT_SP_SHOP_A_NA=Atzr\|xxx` |
| `SELLER_ID_<店铺>_<区域>` | 对应店铺、区域的 Seller ID；Listing 命令需要 | `SELLER_ID_SHOP_A_NA=A1EXAMPLE` |
| `ADS_CLIENT_ID` | 广告应用 client_id(拿到广告准入后配) | 同上格式 |
| `ADS_CLIENT_SECRET` | 广告应用 client_secret | |
| `RT_ADS_<店铺>` | 各店铺广告 refresh_token | `RT_ADS_SHOP_A=Atzr\|yyy` |

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
     → 404 店铺未配置 | 502 refresh token 失效
```

## 审计日志(规格 §9:留存 ≥90 天)

每次发放/拒绝都输出一行 JSON 到 stdout(Zeabur 日志面板可查):

```json
{"ts":"2026-07-13T12:00:00.000Z","kind":"audit","event":"mint","member":"member_a","store":"SHOP_A","api":"sp-api","region":"na","ok":true}
```

⚠️ 请确认 Zeabur 的日志保留时长;若不足 90 天,需把日志转存到外部
(飞书 Bitable / 对象存储均可)。

## 安全设计

- 团队令牌用恒定时间比较(防时序攻击)
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
