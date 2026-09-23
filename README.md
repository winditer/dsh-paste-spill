# dsh-paste-spill

DSH 的**入站**大文本粘贴处理：`dsh-spill` 管的是工具输出（出站），本插件补上方向相反的那一半。

| 层 | 阈值 | 行为 |
|---|---|---|
| 折叠层 | **4,000 – 50,000** UTF-8 字节 | 输入框里**只剩一枚 chip**（前 20 个字符 + "在文本框中显示 ›" + 右上角 `×`），**原文本不再显示**。文本由插件持有，提交时按原文发出去 |
| 转文件层 | ≥ **50,000** UTF-8 字节 | 文本变成**真附件**落盘，消息里是 `file` 块；turn tail 出现可点卡片，点击在右侧栏预览 |

两层相互独立：4,000 层改的是**输入框外观**，50,000 改的是模型所见。

## chip 是怎么做到"输入框里没有原文、却还能发送"的

**关键：chip 是编辑器里的一个真实节点，不是 DOM 装饰。** 它往草稿里贡献一个 `U+FFFC` 占位符，而

```js
"\uFFFC".trim() !== ""   // 占位符 trim 不掉
```

stock 判定可发送的规则是 `draft.trim() === "" && attachments.length === 0`，所以占位符让 `empty === false`，**发送按钮保持可用**；真身则在提交时由 chip 的 source `serialize(ref)` 取回，**替换掉占位符**：

```js
occurrences.map(o => inputTriggers.serializeReference(o.source, o.ref, ...))
```

**这和 stock 自己的图片 chip、`@file` chip 是同一套机制**，所以不需要改 stock。

注册源只需要接公开扩展点：

```js
const inputTriggers = ctx.get("inputTriggers");
ctx.effect(() => inputTriggers.registerSource(source), "...");
```

我们注册的 source 的 `codec.serialize(ref)` 返回**原文全文** —— 这就是 turn 里是原文、且**没有任何文件 chip** 的原因（不走附件）。

## 折叠芯片的两个动作

| 操作 | 行为 |
|---|---|
| 粘贴 4000–50000 字节 | 插入 chip：**整段草稿被替换成 chip**，原文本移出编辑器，由插件按 `ref` 持有 |
| 点芯片主体（`在文本框中显示 ›`） | 把持有的原文**写回编辑器**，释放持有，chip 消失 |
| 点右上角 `×` | **直接删除**：清除占位符并释放持有，输入框变空、发送按钮变灰 |
| **发送** | stock 提交时把 chip 序列化成**原文**；草稿与折叠记录一起清掉 |

`×` 的 onClick 必须 `stopPropagation()` —— 否则同一次点击既删除又展开。

## 两个真机上踩到的坑（都已写进测试）

**1. 插入必须在编辑器 update 之外做（Lexical #337）。** `reactToDraft` 由草稿订阅触发，而 stock 的 `onEditorUpdate` 是在**编辑器自己 update 内部**同步发布草稿的。此刻调 `insertReference`，stock 的 `applyEdit` 会走短路分支：

```js
if (this.editor._updating) { fn(); return; }   // 不设置 active editor
this.editor.update(...)                        // 只有这条会 oi = e
```

短路分支不设 active editor，Lexical 的 `$`-body 就抛 **#337「没有活跃编辑器」**，chip 静默失败。**解法：把插入推迟到微任务**，等 update 提交后再调。

**2. 插完 chip 不能再 `setDraft("")`。** `insertReference` 用的 span 是 `{start:0, end:draft.length}` —— **换入 chip 本身就是删除文本**。那之后再调 `setDraft("")` 会把刚插入的 chip 删掉（`setDraft` 内部 `root.clear()` 后从纯文本重建，且会剥掉 `REFERENCE_PLACEHOLDER_RE`，其范围包含 `U+FFFC`），结果输入框**全空**。

## 早先那套"真清空 + sidecar"为什么被推翻

（保留这段是因为它是本插件最大的一个设计教训。）

曾经的做法是：折叠时**真的清空输入框**，并用**附件链路**挂一个承载同样文本的 sidecar 文件，这样空输入框也发得出去。它产生了用户看到的三个症状：

| 症状 | 根因 |
|---|---|
| 输入框里有"看不见但光标会停住"的内容，发送后 turn 出现 JSON 块 | sidecar 是**真附件**，stock 会把它渲染成 JSON 文件 chip |
| 展开后删空输入框，发送按钮仍可点 | sidecar **还在**，而 stock 判定可发送是 `draft.trim()==="" && attachments.length===0`；空草稿 + 有附件 → 走**仅附件发送**分支，于是把 JSON 发了出去 |
| 反复折叠不断累积 `folded-text-1/3/5/7/9.json` | 展开**故意保留** sidecar，再次折叠挂新的时 `sidecarIds.set` 覆盖了旧 id，旧附件再也没法被卸载 |

**结论**：对"只是换个外观"这一层来说，任何附件都是缺陷。现在的实现**完全不含附件**，所以上述三条在结构上不可能再发生。

## 架构

```
浏览器半  dsh-client-ui-paste-spill
  草稿订阅（不是 DOM paste 监听）
    ≥ 50000  → 合成 File → 既有附件上传链路 → 真 file 块
    4000–50000 → 注册一个 chip source（inputTriggers.registerSource）
                 → 微任务里插入 chip：整段草稿被替换成 U+FFFC 占位符
                 → 原文按 ref 存进持有表，由 source 的 serialize(ref) 取回
                 → overlay 槽里渲染一枚 chip（前20字 + 展开动作 + ×）
                     点主体 → 原文写回编辑器，释放持有，chip 消失
                     点 ×   → 清占位符 + 释放持有（输入框变空、发送变灰）
                 │ 既有 remote 面 fileUploads.upload（仅 ≥50000 用）
                 ▼
宿主半    dsh-paste-spill
  agent/inbox/inserted  → 记录本轮粘贴附件的宿主路径（不 append）
  agent/pre-step        → session.append("deliverables/presented", {turn, callId, files})
                 │
                 ▼
  现成 dsh-client-ui-deliverables → turn tail 的 PresentedFileCard
                                  → 点击 → 右侧栏 documentpreview
```

**关键收益**：≥50,000 走真实附件上传，消息里就是合法 `file` 块，`dsh-llm` 的 `fileHandleText` **自动**给模型只读宿主路径。**零模型侧改动、零 session 格式改动、零 stock 包改动。**

## 安装

在本仓库根目录、于**沙箱外**执行：

```bash
./scripts/install-into-profile.sh
```

脚本会把两个包软链进 `~/.dsh/profiles/desktop/node_modules/` 并把包名加进该 profile 的 `dsh.profile.bundles`。

**装完需要重启 DSH 应用**（不是刷新页面）。原因：profile 的 `patchReload: "live"` 只让**补丁文件**热重载；`dsh.profile.bundles` 是在**启动时**一次性合成的（`dsh-app-boot/lib/index.js:240` 的 `bundlePatches` 只算一次，live 重合成复用内存里的 `composed.bundlePatches`，只重读补丁文件）。改 bundles 列表必须重启。

重启后可用以下命令自检合成结果（不会启动服务）：

```bash
# 在临时 profile 里验证两个包能被正确合成
mkdir -p /tmp/probe/node_modules && cd /tmp/probe
printf '{"name":"p","private":true,"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","dsh-paste-spill","dsh-client-ui-paste-spill"],"patchReload":"live"}}}\n' > package.json
printf '[]\n' > cordis.patch.yml
ln -s <本仓库>/dsh-paste-spill node_modules/dsh-paste-spill
ln -s <本仓库>/dsh-client-ui-paste-spill node_modules/dsh-client-ui-paste-spill
DSH_HOME=/tmp DSH_HOME_DIR=/tmp node "/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js" --profile probe --dump-config | grep -A 1 paste-spill
```

预期输出包含 `- id: paste-spill` / `name: dsh-paste-spill` 与 `- id: ui-paste-spill` / `name: dsh-client-ui-paste-spill` 两行。（`--profile desktop` 不能用来 dump：electron 应用独占管理该 profile。）

> 为什么安装必须在沙箱外：agent 的文件沙箱是 `workspace-write`，只能写本仓库，写不了 `~/.dsh/profiles/desktop/`。

## 卸载

```bash
rm ~/.dsh/profiles/desktop/node_modules/dsh-paste-spill \
   ~/.dsh/profiles/desktop/node_modules/dsh-client-ui-paste-spill
# 再从 ~/.dsh/profiles/desktop/package.json 的 dsh.profile.bundles 删掉这两个名字
```

## 测试

```bash
cd dsh-paste-spill && node --test
cd ../dsh-client-ui-paste-spill && node --test
```

## 设计文档与计划

- 设计：`docs/superpowers/specs/2026-09-20-dsh-paste-spill-design.md`
- 计划：`docs/superpowers/plans/2026-09-20-dsh-paste-spill.md`

## 已知限制

- chip 按会话跟踪**最近一次**大粘贴；连续多次大粘贴只显示最新的一次。
- 折叠期间若切换会话，持有文本仍在**内存**中（不落盘）；展开路径依赖同一个插件实例。
- chip 插入是一次 **revision CAS**：拿到的 `draftRev` 与调用时不一致就会被拒。被拒时**降级为"文本留在输入框 + CSS 钳制"**，绝不丢文本。
- 转文件层在附件上传失败时把原文补回编辑器（best-effort）；若补回失败，失败的附件卡仍带重试按钮，内容不会丢失。
- 交付卡带一个 `⌄` 菜单（"用默认应用打开 / 在 Finder 中显示"）。对粘贴文本属赘余，但它收在折叠菜单之后，且在宿主不可用时整体禁用。
