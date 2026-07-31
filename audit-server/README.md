# amz-cli 审计日志中央接收端 + 网页看板

一个极轻量的服务(纯 Node,无第三方依赖、无原生模块、无构建步骤),干两件事:

1. **接收**:各服务器 / 同事机器上的 `amz-cli` 把每次 API 请求的审计行 POST 到这里(用密钥校验)。
2. **查看**:你用浏览器打开本服务,输密码登录,按 **店铺 / 同事·机器 / 月份 / 状态** 筛选看表格,可导出 CSV。

只记录"**访问了什么**"(时间、店铺、机器、操作、接口路径、区域、HTTP 状态),**不含任何买家 PII**。

---

## 一、部署到你的服务器(Zeabur / 任意 Docker 环境)

本目录自带 `Dockerfile`,Zeabur 可直接从源码或镜像部署。

1. 把 `audit-server/` 这个目录部署为一个服务(Zeabur 识别 Dockerfile 自动构建)。
2. 配置**环境变量**(Zeabur 面板里设,或 `.env`,见 `.env.example`):

   | 变量 | 说明 |
   |---|---|
   | `AUDIT_TOKEN` | **上报密钥**。换成一个长随机串;CLI 端 `AMZ_AUDIT_TOKEN` 必须与它一致。**必填** |
   | `DASHBOARD_PASSWORD` | 看板登录密码(管理员)。**必填** |
   | `SESSION_SECRET` | 登录会话签名密钥,建议单独设一个随机串 |
   | `AUDIT_DATA_DIR` | 数据目录,默认 `/data` |
   | `PORT` | 监听端口,默认 `8080` |

3. **挂一个持久卷到 `/data`**(否则重启日志会丢)。Zeabur 里给该服务加一个 Volume,挂载路径 `/data`。
4. Zeabur 会给一个 HTTPS 域名(如 `https://audit.yourteam.zeabur.app`)。**务必用 HTTPS**(密钥和密码走网络)。

> 生成随机密钥可以用:`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`。

---

## 二、CLI 端配置(每台服务器 / 每个同事机器)

在跑 `amz-cli` 的机器上设三个环境变量(读操作 CLI 你统一配时带上即可):

```
AMZ_AUDIT_HTTP  = https://你的域名/audit
AMZ_AUDIT_TOKEN = 与服务器 AUDIT_TOKEN 完全一致
AMZ_AUDIT_NODE  = 这台机器/这个人的标识（如 entity-a-svr 或 zhangsan-PC）
```

- 之后每次跑命令,审计行会**本地照写一份**(`~/.amz-cli/audit/<店铺>/<年月>.log`),**同时**上报到你服务器。
- 上报是"额外一路":短超时、失败即忽略,**不拖慢也不阻断命令**;服务器没通时本地文件仍是完整底账。
- 多个主体从不同服务器发请求:各设不同 `AMZ_AUDIT_NODE`、跑各自 `--account`,都指向同一个 `AMZ_AUDIT_HTTP` 即可,**互不冲突**。
- 不想本地也留一份可设 `AMZ_AUDIT_DISABLE=1`(只关本地落盘,不影响上报)。

---

## 三、怎么看日志

浏览器打开服务域名 → 输 `DASHBOARD_PASSWORD` 登录 → 看板:

- 顶部按 **店铺 / 同事·机器 / 月份 / 状态(成功·失败)** 筛选,还能搜操作/接口。
- 表格:时间、店铺、同事·机器、操作(如 `orders list`)、接口路径、区域、状态。
- 右上 **导出 CSV**——亚马逊要审计时直接给。

---

## 四、安全说明

- 上报用 `AUDIT_TOKEN`(Bearer)校验;看板用密码登录 + 签名会话 cookie;两者都用 `timingSafeEqual` 防时序攻击。
- **只走 HTTPS**(Zeabur 自带)。
- 日志**只记元数据,不记买家 PII**(与 CLI 端一致)。
- 数据是本地 JSONL 文件(`<店铺>/<年月>.jsonl`),你完全掌控,可随时打包/归档/删除以满足留存策略。
