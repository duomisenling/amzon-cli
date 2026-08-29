---
name: amz-cli
description: 使用 amz-cli 安全查询和运营 Amazon 卖家店铺。适用于销售、订单、库存、Listing、FBA 货件、报告、费用、价格、Feed 和广告等请求；当用户以自然语言询问亚马逊店铺经营数据或要求执行相应 CLI 操作时使用。
---

# Amazon CLI Operator（加载器）

这份文件只是入口。**完整操作说明随 npm 包分发，在本机上，请先读取后再执行任何操作。**

## 第一步：读取完整说明（每次会话首次使用本技能时做一次）

1. 运行 `npm root -g` 取得全局包目录。
2. 读取 `<上一步输出>/amz-cli/skills/amz-cli/SKILL.md` 的**全文**。
3. 之后一切按该文件执行：命令用法、只读与写操作的通道判断、预览与审批门禁、报告格式，全部以它为准。

## 找不到时怎么办

若 `npm root -g` 失败，或该路径下没有 `SKILL.md`，说明这台机器还没安装（或未升级）命令行。**停止业务操作**，让用户运行：

```powershell
npx.cmd --yes amz-cli@latest install
```

装完新建一个会话再试。不要凭这份加载器本身的内容去猜命令、拼参数或执行写操作——它不包含任何业务规则。

## 为什么这样设计

完整说明跟着 npm 包走，升级 `amz-cli` 即同步更新，无需在 Cherry Studio 里卸载重装本技能。因此本文件应保持稳定，除非触发描述（frontmatter 的 `description`）需要调整。
