# 五店铺环境文件模板

本目录只保存空模板，不能填写或提交真实凭证。当前多店铺方案没有共享配置和默认店铺：每个账号文件都保存该店铺自己的完整 SP-API、Ads 应用凭证和运行设置。每次查询或写入都必须明确选择店铺。

## 文件放置

把 `account.env.example` 复制五份，分别命名为：

```text
%USERPROFILE%\.amz-cli\accounts\shop-a.env
%USERPROFILE%\.amz-cli\accounts\shop-b.env
%USERPROFILE%\.amz-cli\accounts\shop-c.env
%USERPROFILE%\.amz-cli\accounts\shop-d.env
%USERPROFILE%\.amz-cli\accounts\shop-e.env
```

不要覆盖已经存在且内容来源不明的配置文件；先备份并请管理员核对。

## 填写规则

- 每个店铺文件：填写该店铺自己的完整 `LWA_CLIENT_ID`、`LWA_CLIENT_SECRET`、各区域 Refresh Token、各区域 Seller ID、完整的 `ADS_CLIENT_ID`、`ADS_CLIENT_SECRET`、`ADS_REFRESH_TOKEN`，以及 `SP_API_REGION`、`SP_API_SANDBOX`、`ADS_REGION`。
- NA 和 EU 的 SP-API Refresh Token 要分别授权；没有使用的 FE 字段保持为空。
- 一个店铺尚未开通广告时，可以将该店铺文件中的三个 `ADS_*` 字段全部留空；SP-API 查询仍可使用，广告命令会明确报告缺少广告凭证，不会回退到 SP-API 凭证。
- 账号文件中的 `SP_API_REGION=na` 和 `ADS_REGION=na` 只是未明确区域时的默认值，不代表默认店铺；明确站点或区域的命令会覆盖它们。
- 本地模式不要填写 `BROKER_URL`、`TEAM_TOKEN`、`STORE`。
- 店铺文件名大小写必须与 MCP 里的 `account` 一致。
- 代理 `SP_API_PROXY`、`ADS_PROXY`、`EGRESS_LABEL`（可选）：让该账号的请求通过指定的代理服务器发出。**只写在各账号自己的文件里**，不要写进共享 `.env` 或系统环境变量。留空即直连，所以"某个账号就是要直连"不需要任何开关。
- 配好代理后用 `amz-cli --account <账号> doctor egress` 自检：它会打印实际的出口 IP，并检查代理的目的地限制是否生效。

多店铺模式不需要 `%USERPROFILE%\.amz-cli\.env`。切换账号时，CLI 会先清除上一个账号的 Client ID、Secret、Refresh Token、Seller ID 和出口代理配置，再加载新账号文件；每个账号文件必须自包含，不能依赖主 `.env` 或其他店铺。

## 安全要求

真实 Client ID、Refresh Token 和 Client Secret 不得发到普通聊天、邮件、工单或 GitHub。需要交给同事时使用加密文件，密码通过另一条渠道发送；离职、丢机或疑似泄露时立即吊销并重新授权。

配置完成并重启 Cherry Studio 后，可以逐店验证：

```powershell
amz-cli --account shop-b auth whoami --region na
amz-cli --account shop-b auth whoami --region eu
```

验证命令会调用 Amazon 只读接口，不会修改店铺数据。其他店铺把 `shop-b` 换成对应代号即可。
