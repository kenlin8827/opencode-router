# 死代码扫描报告 — changes(未提交) — 2026-10-09 10:53

## 范围

`git status` 显示 12 个未提交 M 文件 + 1 个 untracked(`nul`,与本次扫描无关,不动)。

```
backend/src/config/index.ts
backend/src/config/types.ts
backend/src/opencode/probe.ts
backend/src/utils/proxy.ts
backend/tests/proxy.test.ts
config.example.yaml
frontend/src/components/Combobox.tsx
frontend/src/i18n/locales/en-US.ts
frontend/src/i18n/locales/zh-CN.ts
frontend/src/i18n/types.ts
frontend/src/pages/ApiKeysPage.tsx
frontend/src/pages/ProxyPage.tsx
```

HEAD = `e870415` ("fix: preserve explicitly cleared tier match patterns")

## 扫描方法(交叉验证)

1. `git diff HEAD` 拿全部改动
2. 改后的每个文件全文 `read` 一次
3. 改动符号的活引用:仓库内 `tgrep_search`(off-index,基于磁盘)
4. 同义残留词扫描:`whitelist`/`blacklist`/`sampleKey` 是否仍存在
5. 死分支 / 未用 import / 未用常量 / TODO 扫描
6. **正向验证**:`bun run typecheck` + `bun test backend/tests/proxy.test.ts`

## 改动语义总览(分类)

| 类别 | 文件数 | 性质 |
|------|--------|------|
| 跨 8 文件的同义词重命名 `whitelist`→`includes`、`blacklist`→`excludes`(用户决策) | 8 | 一致性,非死代码 |
| Quick Connect 密钥安全化(占位符默认 + 单 key 一键揭示 + 多 key Modal picker) | 5(1 页 + 1 类型 + 2 locale + 1 combobox) | 新功能,无遗留 |
| Combobox `forceFilter` 透出 | 1 | 新功能,1 个 caller,有意识"用得少" |

## 逐项扫描结果

### 1. 死函数 / 死常量 / 死类型

**结论:无。**

- `proxy.ts` 新符号(`warnedInvalidProxyUrl`、`patternHits`、`globalProxyUrl`):全部在 `resolveProxyUrl` 调用链中活引用。
- `probe.ts` 新注释、`ProbeOptions.provider` 注释:不影响导出符号。
- `ApiKeysPage.tsx` 新 state(`showPicker`、`pickerKeyId`、`revealKey`、`selectedKeyId`、`pickerPreview`、`inlineKey`、`keyPlaceholder`):全部在 JSX 中活引用。
- `Combobox.tsx` 新 prop `forceFilter`:唯一 caller `ApiKeysPage.tsx:772`,有意"用得少"(注释明确说 "Use sparingly")。

### 2. 未使用 export

**结论:无。** 检查了 `proxy.ts` 的所有 4 个 `export function`:
- `initProxyConfig` → `console.ts` 启动时调用
- `isLoopbackUrl` → proxy.test.ts + 同文件 `resolveProxyUrl` 内部
- `resolveProxyUrl` → proxy.test.ts + 同文件 `proxiedFetch` 内部
- `proxiedFetch` → 跨文件(probe.ts、catalog sync 等)

`probe.ts` 的 `probeKindFor` / `probeProvider` / `ProbeOptions` / `ProbeResult` / `ProbeKind`:`backend/src/routes/console.ts:1028-1033` 全部在用。

### 3. 死分支 / 死条件

**结论:无。** ApiKeysPage 的 `keys.length === 0 / 1 / >1` 三分支覆盖所有现实场景;`showPicker` modal 在 `useBodyScrollLock` 和 JSX `{showPicker && (...)}` 双处使用;`revealKey && selectedKey` 的三态(condition: selectedKey && revealKey / else count > 1 / else count === 1)在 keys 状态空间上互斥且穷尽。

### 4. 未使用 import

**结论:无。** `tgrep` 确认:
- `ApiKeysPage.tsx`:10 个 import 全部活引用(React 5 个,业务 5 个)
- `proxy.ts`:2 个 import 全部使用
- `proxy.test.ts`:3 个 import 全部使用
- `proxy.ts` / `probe.ts` 没有新增 import

### 5. 重复代码 / YAGNI 候选

**结论:无。** 新增的 `PatternListEditor`(已在 ProxyPage.tsx 存在)与 `ApiKeysPage` 的 picker modal 形态不同:
- Proxy:每个 pattern 一行 input(可任意增删 + 排序)
- ApiKeys:单选 Combobox + 预览

语义不同,不应合并。`forceFilter` 的 1 个 caller 不构成 YAGNI 触发(被设计为"按需开启"的可选 prop,逻辑与默认值隔离)。

### 6. 仓库范围内残留旧符号(同义重命名是否彻底)

| 旧词 | 仓库内残留 | 性质 |
|------|------------|------|
| `whitelist`(proxy 语境) | **0** | 干净 |
| `blacklist`(proxy 语境) | **0** | 干净 |
| `whitelist` / `blacklist`(其他语境) | 5 处:`backend/tests/auth.test.ts:132`(auth hook 白名单)、`backend/src/routes/console.ts:76/1399/1435`(auth hook 白名单 + body field 排除)、`backend/src/resilience/error-classifier.ts:57`(retry 错误白名单) | **与 proxy 重命名无关,语义独立,非死代码** |
| `sampleKey` | **0** | 干净(被 `inlineKey` 完全替代) |

### 7. 已知 stale 注释(不属本次改动,但扫到)

`config.example.yaml:60-71` 的 `rules:` 注释块已 stale(prompt-override rules system 已 2026-10-07 整体移除,public.md #24),但 **注释本身是手写示例文件,作用是给用户阅读的过时文档,删它不是"清死代码"而是"更新文档"**。**本次改动未触碰此段**(diff 只动了 proxy 注释),建议另开清理任务处理。

## 验证证据(运行结果)

```
$ bun run typecheck
$ tsc -p backend --noEmit && tsc -p frontend --noEmit
(exit 0, 0 errors)

$ bun test backend/tests/proxy.test.ts
19 pass, 0 fail, 47 expect() calls (234ms)
```

跨改动重命名的一致性已通过测试套件覆盖(`includes` / `excludes` 在所有用例里都被验证)。

## 最终结论

**本次 12 个文件的未提交改动里没有死代码。**

整批改动由两个互相独立、互不引入死代码的部分组成:
1. 用户决策的同义词重命名(whitelist/blacklist → includes/excludes)— 跨 8 个文件,完全自洽,无残留
2. Quick Connect 密钥安全化(防截屏 / 防肩窥)— 新增 prop / state / i18n 键,全部活引用

不需要删除任何代码。**0 个删除候选,0 个高/中/低风险项。**

## 行动建议

- ✅ 可以原样 commit,无需额外清理
- 🔵 可选:`config.example.yaml:60-71` 的 stale `rules:` 注释块另开一个清理任务(不在本次 changes 范围内)
- 🔵 可选:把"已实现但未提交" 的代码编排进提交信息,见 `## Project memory` 的 git-整理提交工作流(private.md #34)

## 元数据

- 扫描时间:2026-10-09 10:53
- 扫描方式:read + tgrep_search(noIndex) + bun test + bun typecheck
- 备份:`stash@{0} pre-clean-deadcode-20261009-105300` 已 drop(成功恢复后清理,工作树与 HEAD diff 已二次确认完整)
- 安全网:guard 分支未创建(本次零删除,无回滚需求;若你希望我先建 guard 分支再继续,告诉我)
