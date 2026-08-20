# 写入：预览与确认

**前提：用户已经明确同意写入。** 没同意就不要走到这里。

写入永远是「先查 Schema → 拼 patch → 官方预览 → 人工确认 → 提交」，两条通道二选一，**不能混用**（预览令牌绑定通道和参数）。

## 通道判断

- 当前对话有 `prepare_listing_update` / `apply_listing_update` 工具 → **MCP 通道**（Cherry Studio 装了多店铺 MCP，默认走这条）
- 只有终端 → **CLI 通道**

两条都在时走 MCP。**不要在 MCP 环境里给用户 CLI confirm 命令**——终端 confirm 强制要求交互式 TTY，运营在 Cherry 里跑只会拿到 `interactive_terminal_required` 报错。

## MCP 通道（Cherry Studio 主用）

```
prepare_listing_update(account, marketplace, sku, productType, patches)
```

- **`account` 必填**，用当前对话已明确的店铺代号；没明确就先问，不要猜、不要遍历店铺试。
- `patches` 是**内联数组**（不是 `@文件` 路径）——把 `check-copy.mjs patches` 生成的 patch 文件内容读出来内联传入。
- `marketplace`、`sku`、`productType` 必须和取素材、查 schema 时用的完全一致。

读回 `schemaValidation` / `status` / `issues` / `previewToken` / `applyAllowed`，把预览摘要报给用户：

> SKU DEMO-TRAY-01（DE 站）
> 标题：`<当前值>`（187 字符）→ `<新值>`（59 字符）
> 亮点：（空）→ `<新值>`（52 字符）
> 亚马逊服务端校验：VALID，无 ERROR
> 确认写入吗？

用户认可后调 `apply_listing_update`。**每次都会弹审批卡由真人批准**——禁止自动批准，禁止 `bypassPermissions`。`apply_*` 还受 `AMZ_MCP_ALLOW_WRITES=true` 和白名单约束。

方案在确认后有**任何变化**（改了一个词、换了一条 SKU）→ 废弃旧预览重新 prepare，不要拿旧令牌硬套。不要连续 prepare 多个试探版本。

## CLI 通道（只有终端时）

### 预览

```bash
amz-cli listing update --account <店铺> --marketplace <站点> --sku "<SKU>" \
  --product-type <类型> --patches @<目录>/<sku>.patch.json --dry-run
```

`--patches @文件` 是从文件读，**PowerShell 里一定用文件**，别把 JSON 塞命令行——引号转义会把你坑死。

预览会做三件事：
1. 拉当前值做对照（`changes.current_values`）
2. **强制核对卖家专属 Schema**：属性不存在或 `editable=false` 时，在调用亚马逊校验前就停下，不签发令牌
3. 调官方 `VALIDATION_PREVIEW`（同步跑与正式提交完全相同的校验，但不落库）

**判读**：`status=VALID` 且没有 ERROR issue 才算通过。`ACCEPTED` 是正式提交的状态，不是预览状态。`INVALID` 就把 issues 原文报给用户。

### 确认执行

```bash
amz-cli listing update --account <店铺> --marketplace <站点> --sku "<SKU>" \
  --product-type <类型> --patches @<目录>/<sku>.patch.json \
  --confirm --preview-token <预览令牌>
```

⚠️ **这条命令你跑不了，也不要尝试跑。** CLI 强制要求交互式终端：非 TTY（Agent、n8n、管道）执行会被 `interactive_terminal_required` 直接拒绝。listing update 是 reversible 写操作，用户会在终端看到操作复述并输入 `y`。

你要做的是：**把这条命令原样交给用户，让他自己在 PowerShell 里跑。**

令牌规则：
- **15 分钟有效，只能用一次**
- 绑定命令、业务参数、patch 文件内容和运行环境——**任何一样变了就要重新预览**
- Schema 版本或校验值变化后旧令牌自动失效
- `--dry-run` 和 `--confirm` 不能同时用

## 预览报错怎么办

| 情况 | 处理 |
|---|---|
| `listing.schema_attribute_not_found` | 属性名错了。回去用 `--grep <业务名称>` 重搜，**不要换几个猜测名反复试** |
| `listing.schema_attribute_not_editable` | 该属性明确不可编辑。向用户说明这次的 Schema 证据，不要换字段名绕 |
| `INVALID` + issue **100476** | 属性不受支持。先确认标题确实 ≤75，再查 Schema 是否真开放了 Item Highlights。**「试了几个字段名都失败」不是证据** |
| `INVALID` + issue **8560** | 商品身份信息不足。**不要无条件加 `merchant_suggested_asin`**——先读本次 issues，确认当前 schema 确实有该字段、ASIN 已核对，两者都满足才按 schema 结构补充后重新预览 |
| 字符数被拒 | 校验器已经拦过一道，还被拒说明该产品类型 schema 的字数限制比通用规则更严。读 schema 的 `maxLength` 按实际值重写 |

## 提交后怎么汇报

**如实转达，不得把"不确定"说成"已完成"：**

- `processingStatus: SUBMITTED` + `submission.status: ACCEPTED` 表示**亚马逊接受了这次提交**，不代表前台目录已最终生效。
- `immediateReadback` **可能仍是旧值**——亚马逊继续异步处理目录数据，回读旧值是正常的，不能把它当成「新值已生效」的证据，也不能当成失败。
- 有 `readbackError` 就一并说明，不要略去。**收到 readbackError 不要自动重试写入**——PATCH 可能已经成功，重试会造成重复提交。

标准说法：

> 已提交，亚马逊返回 ACCEPTED。目录数据是异步处理的，前台可能要等几分钟到几小时。稍后用下面这条命令复核：
> ```bash
> amz-cli listing sku --account <店铺> --marketplace <站点> --sku <SKU> --include attributes,issues
> ```

批量时给成功/失败/未确认三栏的汇总，失败项列出 SKU 和原因原文。
