---
name: amazon-title-compliance
description: 优化 Amazon listing 文案——标题（≤75 字符）、商品亮点 Item Highlights（≤125 字符）、五点描述，按 2026-07-27 新规改写，支持单条和批量。适用于「优化这条 listing 的文案」「标题超长要改」「按新规批量整改这批 SKU」「补商品亮点/Item Highlights」「五点没写全帮我补」「标题被亚马逊 AI 改写前先自己改」等请求。事实只能来自素材，查不到就问用户，绝不编造；生成稿一律先过机器校验字符数，再列出「当前值 → 新值」交用户确认；用户明确同意后才走 amz-cli 的预览与写入门禁。不管广告投放、竞价、否词和预算。
---

# Amazon 文案合规（加载器）

这份文件只是入口。**完整规则、参考资料和校验脚本随 npm 包分发，在本机上，请先读取后再执行任何操作。**

## 第一步：读取完整说明（每次会话首次使用本技能时做一次）

1. 运行 `npm root -g` 取得全局包目录。
2. 记 `SKILL_DIR = <上一步输出>/amz-cli/skills/amazon-title-compliance`。
3. 读取 `<SKILL_DIR>/SKILL.md` 的**全文**，之后一切以它为准。它会按需指引你读取 `<SKILL_DIR>/references/` 下的参考文件，并调用 `<SKILL_DIR>/scripts/check-copy.mjs` 做字符数机器校验——路径都以 `SKILL_DIR` 为前缀。

## 找不到时怎么办

若 `npm root -g` 失败，或该路径下没有 `SKILL.md`，说明这台机器还没安装（或未升级）命令行。**停止操作**，让用户运行：

```powershell
npx.cmd --yes amz-cli@latest install
```

装完新建一个会话再试。不要凭这份加载器本身的内容改写文案——它不包含任何字数规则或改写方法。

## 为什么这样设计

完整规则跟着 npm 包走，升级 `amz-cli` 即同步更新，无需在 Cherry Studio 里卸载重装本技能。因此本文件应保持稳定，除非触发描述（frontmatter 的 `description`）需要调整。
