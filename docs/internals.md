> **实现笔记（implementation log）** — 用户向文档见仓库根目录的 [README.md](../README.md)
> 与 [README.zh.md](../README.zh.md)。本文是开发过程中的实现细节与真机排查记录，内容保留原样，
> 供维护者排查回归用。

# dsh-paste-spill

DSH 的**入站**大文本粘贴处理：`dsh-spill` 管的是工具输出（出站），本插件补上方向相反的那一半。

| 层 | 阈值 | 行为 |
|---|---|---|
| 折叠层 | **4,000 – 50,000** UTF-8 字节 | 输入框里这段文本变成**一枚 chip**（前 20 个字符 + "在文本框中显示 ›" + 右上角 `×`），原文本移出编辑器、由插件按 `ref` 持有，提交时按原文发出去。**每次粘贴一枚 chip**，互不覆盖 |
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
| 粘贴 4000–50000 字节 | **只把这段粘贴**换成一枚 chip：原文本移出编辑器，由插件按 `ref` 持有。周围已输入的文字、已有 chip 都不动 |
| 点芯片主体（`在文本框中显示 ›`） | 把**这一枚** chip 的原文写回它的位置，释放持有，该 chip 消失 |
| 点右上角 `×` | **直接删除这一枚**：删掉 chip 节点（连同它自带的分隔空格）并释放持有 |
| **发送** | stock 提交时把每枚 chip 序列化成**原文**；草稿与折叠记录一起清掉 |

`×` 的 onClick 必须 `stopPropagation()` —— 否则同一次点击既删除又展开。

### 监听器装在哪：谁能证明"这个 composer 就在眼前"

折叠/转文件两条路都挂在**会话的草稿 watcher** 上。谁来装这个 watcher 是个真问题：
`sessions.list.current` 只是一个**选中态**，页面刚加载时它先是 `undefined`，而且它指着的会话未必就是屏幕上那个 composer。旧实现只在选中态变化时试一次、失败后**最多重试约 2 秒**——一旦 composer 的 binding 晚于 2 秒才出现，这个会话就**永久静默**：粘贴进去什么都不发生，没有任何报错（真机上就是这样：粘贴事件观测到了 6008 / 60154 字节、目标也确实在 `[data-composer-input]` 里，然后什么都没有）。

现在有两道保险：

- chip rail **自己**在自己的 layout effect 里调 `onMount(sessionId)`。rail 只可能在**已挂载的 composer**里、为**那个 composer 的会话**渲染，所以这个 id 是权威的、不会过期。
- 重试**永不放弃**：前 ~2 秒每帧一次，之后降到约 3 次/秒。一次 tick 只是一次 WeakMap 查询。

### 为什么"有的对话有 chip、有的没有"（每个环节都按会话存活）

用户实际报的现象：同一个 6K 粘贴，在 A 对话里出 chip，在 B 对话里原文留在输入框里。
查下来**每一个能弄丢粘贴的环节都是按会话存活的**，所以修的是这三个：

1. **shell 会被换掉。** `InputHub.shellFor(binding)` 每个会话 binding 只缓存一个 shell，
   会话 scope 退栈时 `shell.dispose(); shells.delete(binding)`——离开再进同一个对话就拿到
   **新的 shell**。旧代码 `watchers.has(id)` 直接短路、**连 shell 都不再看**，watcher 就永远挂在
   一个已经没人 publish 的 store 上：那个对话从此静默，而且没有任何报错。现在每次安装都
   重新解析 shell，变了就停掉旧的、订阅新的（诊断 `bySession.<id>.shellSwaps`）。
2. **粘贴属于哪个会话，只有 DOM 知道。** `paste` / `beforeinput` 事件不带会话 id，而
   `sessions.list.current` 只是个**选中态**（可能正指着别的对话）。rail（始终挂载，空的时候
   带 `data-empty` 且 `display:none`）在自己的 layout effect 里给 `[data-composer-card]`
   写 `data-dshps-session`；observer 从事件目标的卡片上读回会话 id 再 `inbox.record(text, source, sessionId)`，
   watcher 也 `inbox.take(sessionId)`。否则两个 composer 同时活着时，刚离开那个对话的粘贴会被
   别的会话"认领"——真正收到粘贴的对话反而没有测量值。
3. **stock 在 composer 忙的时候会拒绝插入 chip。** `insertReference` 的门是
   `phase !== "plain" && phase !== "claimed"`：前一条消息还在飞、或还在等审批
   （`submitting` / `adjudicating`）时，插入**一定**被拒。忙闲是**按会话**的，所以看起来
   "这个对话不行"。被拒之后不再把这次粘贴忘掉，而是**重新武装**（见下）。

**armed retry（保底那一次尝试）。** 每次 ≥ 4000 字节的粘贴都会记一条 armed 记录，每 200ms 试一次，
最多 5 分钟：composer 还忙就继续等（原文留在输入框，符合预期）；只要光标处的粘贴段还在、
`phase` 允许，就再走一次 `reactToDraft`（折叠/转文件共用同一条判定）。文本早就不在原处
（被删掉或改过）连续 30 次定位不到就放弃；用户点展开、点 `×`、或消息发出去，立即停止——
**展开/× 之后绝不会被重新折叠**。这样"哪个对话"不再决定 chip 出不出现。

同一次粘贴**只会折叠一次**，但**不靠比较文本**：两条路（草稿 watcher / armed retry）看的是同一份草稿，
先到的那条会把粘贴段换成 chip，后到的那条 `pastedRunSpan()` 就再也定位不到那段文本，于是自己停下。
「这段文本是否已经折过」必须按**每次插入**判断（录制带 `pasteId`），否则**同一段文本第二次粘贴会被误判成重复**——
真机上就是这样：`第一次有 chip，第二次粘贴同一段 6K 没有 chip，文本留在输入框`。

诊断都在 `localStorage["dsh.paste-spill.diag"].bySession.<sessionId>` 下（按会话分开，最多 8 个会话）：
`shellSwaps` / `watchInstalls` / `pasteBytes` / `verdict` / `chipDeferred` / `armed` /
`armedPhase` / `armedTries` / `spillCleaned` / `spillCleanupSkipped` / `sendCommitted` /
`watcherDropped`；顶层另有 `pasteUnmapped`（粘贴没有会话标记，只能靠草稿 diff 折）、
`foldRunLocatedBySearch`（光标已离开，按"全文唯一出现"定位到粘贴段）、
`foldRestoredOverLabel`（换了 shell 之后把原文写回，替掉 chip 的 label）、
`foldChipRolledBack`（记录已被撤销、落地的 chip 被清掉）。

### 真机序列：先粘 6K（chip），再粘 60K（转文件）→ 输入框只剩 "已折叠 5.9 KB"

这是用户报的第二个真机现象，根因是我自己在清理转文件原文时用了 `shell.setDraft()`：
`setDraft` 是**整篇重写**（草稿以纯文本回来），会把同一条 composer 里的 chip 节点**一起抹掉**，
只剩它的 footprint（也就是 label）。附件是对的，但那段 6K 已经**差一步就会被当成字符串
"已折叠 5.9 KB" 发出去**。

现在清理改成**就地写空**：用 `pastedRunSpan()` 定位那段粘贴文本自己的 detect span，写 `""` 覆盖它
（和插 chip 走同一条路），其它 chip、用户输入、光标、undo 全都不动。若是定位不到，就**保持原文不动**
（附件已经持有内容，原文留在输入框无害）—— 应用里**不再有**"setDraft 重写草稿"这条清理路径；
字符串回退只留给没有 span 能力的裸测试壳（诊断 `spillExcisedInPlace` / `spillCleanupSkipped`）。

### 对抗性评审查出来的四条"静默丢文本"路径（都已修 + 都有回归测试）

评审是独立一轮做的，每条都在真机前用探查脚本复现过。四条都属于"平时用就会中"：

1. **定位不到 ≠ 草稿是空的。** 清理转文件后的原文时把 `removePastedText` 的候选当成了编辑器里
   的真字符串，而它是**剪贴板原文**；编辑器把 CRLF 存成 LF，于是任何 Windows 来源的粘贴都
   "找不到"，旧代码 `return ""` 被当成新草稿写回去——**连带用户自己打的字一起删掉**。现在：
   先按编辑器可能的各种渲染去找（CRLF/LF、零宽、占位符），找不到就**原样不动**（原文与附件并存，
   可恢复），并且只在真的删掉东西时才写草稿（诊断 `spillCleanupSkipped`）。
2. **没有会话标记的录制不能被任何会话领走。** 旧实现让"最新一条无会话录制"对**任何**会话的
   查找都可见，于是 A 对话的 60K 粘贴可能被 B 对话建成附件（发送时就把 A 的内容当成 B 的消息），
   同时把 B 自己的草稿按第 1 条清掉。现在带 key 的 `take`/`peek` **只认自己那一格**。
3. **离开再进同一个对话，原来那枚 chip 的文本要还回来。** 重进会话会拿到新 shell，而 stock 用
   **镜像草稿**重建输入框——chip 在镜像里只是它的 `clipboardText`，也就是 label（"已折叠 5.9 KB"）。
   新编辑器里没有 chip 节点、ref 也真的没了，旧代码把这条记录释放掉：**6K 原文消失，发送的就是那行 label**。
   现在退出记录前先把原文**写回 label 的位置**（span 写入，不用 `setDraft`，其它 chip 不受影响；
   安装 watcher 时也立刻对账一次，因为镜像草稿可能早于订阅落地）。
4. **`spillInFlight` 登记在 `uploadPaste` 之后。** `uploadPaste` 会用**当前**上传快照结算，
   所以"已经 ready"的上传会在登记之前就回调 `onReady`，把会话**永久**标成"有转文件在飞"：
   该会话之后所有保底重试都只会等（诊断 `waiting-spill`）——就是"这个对话再也不出 chip"。
   现在登记在上传之前，结算即清除，插件卸载时也清。

另外两处（同一轮）：定位粘贴段不再只依赖光标（"**全文唯一出现**"也算，打字后不再丢折叠，
`armed.missing` 改成**连续**计数、忙时不计数）；armed 记账按 `pasteId`，并加了"这次粘贴已经有 chip"
的按身份判断（诊断 `armed: already-folded`），不再靠 30 次定位失败来结束。

### 一次粘贴 = 一枚 chip（多枚共存）

每次粘贴**追加**一条折叠记录，不覆盖上一条：chip 是它那段文本的**唯一载体**（文本已不在编辑器里），覆盖就等于把用户上一段粘贴删了。因此展开/删除都带 `ref`，**只作用于点中的那一枚**。

## chip 不能盖住输入框（几何）

`conversation.input.overlay` 挂在 `[data-composer-card]` 里一个 `position:absolute; height:0; inset:0 0 auto` 的 overlay anchor 上，**不参与布局**：rail 会浮在卡片最上面几行之上，把用户输入的字盖住。

所以 rail **自己量自己的高度**，写成卡片上的 `--dshps-chip-band`，再由样式把它变成卡片的 `padding-top`：

```css
[data-composer-card][data-dshps-chip]{padding-top:calc(8px + var(--dshps-chip-band,0px))}
```

用**实测高度**而不是常量：chip 换行成两行时（多枚 chip、窄窗口）常量必然不对。chip 本身也压成单行 28px。

> 旧实现两个错都在这里：`padding-top:60px` 是硬编码；而它的 layout effect 依赖数组是 `[]`，在 mount 时 `ref.current` 还是 `null`，**那个 60px 从未真正加上**。

## 三个真机上踩到的坑（都已写进测试）

**1. 插入必须在编辑器 update 之外做（Lexical #337）。** `reactToDraft` 由草稿订阅触发，而 stock 的 `onEditorUpdate` 是在**编辑器自己 update 内部**同步发布草稿的。此刻调 `insertReference`，stock 的 `applyEdit` 会走短路分支：

```js
if (this.editor._updating) { fn(); return; }   // 不设置 active editor
this.editor.update(...)                        // 只有这条会 oi = e
```

短路分支不设 active editor，Lexical 的 `$`-body 就抛 **#337「没有活跃编辑器」**，chip 静默失败。**解法：把插入推迟到微任务**，等 update 提交后再调。

**2. span 必须用 detect 坐标、且只覆盖刚粘贴的那段。** 旧实现把 `{start:0, end:draft.length}` 交给 `insertReference`：`draft.length` 是**草稿（clipboard）投影**长度，而 span 是**detect 投影**坐标。已经有一枚 chip 时草稿比 detect 文本长，`end` 越界 → `selectSpan` 返回 null → 插入被拒 → **第二段 6k 文本原样留在输入框**（用户报的第二个 bug）。而且整段草稿的 span 会连着把别的 chip 一起换掉，那可是别人文本的唯一载体。

现在 `pastedRunSpan()` 从光标往回量出粘贴的那一段，并校验 `projection.detectText.slice(start,end) === text` 才用。

**3. 插完 chip 不能再 `setDraft("")`。** 展开/删除走的是 `shell.actions.insertText(value, span)`（对**那一枚 chip 的 detect span** 做替换），不是 `setDraft`：`setDraft` 内部 `root.clear()` 后从纯文本重建，会**连带删掉其他 chip**（同为文本唯一载体），范围里还包含 `U+FFFC`。

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
一个包 dsh-paste-spill（宿主半 exports["."] + 浏览器半 exports["./client"]，
cordis.patch.yml 里只有一行；和已装的 dsh-image-gen / dsh-message-rail 同形）

浏览器半  lib/client.js（dsh.client, platform: web）
  草稿订阅（不是 DOM paste 监听）
    ≥ 50000  → 合成 File → 既有附件上传链路 → 真 file 块
    4000–50000 → 注册一个 chip source（inputTriggers.registerSource）
                 → 微任务里插入 chip：只把刚粘贴的那一段换成 chip 节点
                 → 原文按 ref 存进持有表，由 source 的 serialize(ref) 取回
                 → overlay 槽里渲染 chip rail（每次粘贴一枚：前20字 + 展开 + ×）
                       点主体 → 用该 chip 的 detect span 把原文写回原位，释放持有
                       点 ×   → 删掉该 chip 节点（含分隔空格）+ 释放持有
                 → 卡片按实测 rail 高度留出 padding-top，rail 不遮输入
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

### 为什么宿主半和浏览器半在同一个包里

`cordis.patch.yml` 只插**一行**，这一行的包 `dsh-paste-spill` 同时声明了两半：

| 半 | 声明 | 加载方 |
|---|---|---|
| 宿主半 | `exports["."]` → `lib/index.js` + `dsh.bundle.patch` | Loader 按行 `name` 导入 |
| 浏览器半 | `exports["./client"]` → `lib/client.js` + `dsh.client` | web-modules 扫描器按**行所在的包**读 `package.json` 的 `dsh.client` |

扫描器是**按加载器行**去找那个行包自己的 package.json（`dsh-client-modules/lib/index.js` 的 `resolveMeta(loaderName)`），所以一行就够；本机已装的 `dsh-image-gen` / `dsh-message-rail` / `dsh-prompt-optimizer` 全是这个形状。早先把浏览器半拆成独立包，只是沿用 DSH 自己的命名习惯（`@deepseek-ai/dsh-*` vs `@deepseek-ai/dsh-client-ui-*`），没有技术必要——代价是 profile 里多一个必须维护的名字，而那个名字在 9/28 的崩溃恢复里正好被抹掉了。

浏览器半的模块 id 必须**等于包名**（`window.__ModuleLoader__.load({id:"dsh-paste-spill"})`）：浏览器加载器按被请求的名字注册模块，宿主也按行包的名字提供它。

**关键收益**：≥50,000 走真实附件上传，消息里就是合法 `file` 块，`dsh-llm` 的 `fileHandleText` **自动**给模型只读宿主路径。**零模型侧改动、零 session 格式改动、零 stock 包改动。**

## 安装

在本仓库根目录、于**沙箱外**执行（`~/.dsh/profiles/desktop/` 不在 agent 的 workspace 沙箱里）：

```bash
./scripts/install-into-profile.sh
```

脚本做两件事，**两件都必须做**：

1. 把两个包软链进 `~/.dsh/profiles/desktop/node_modules/`；
2. 把包名加进该 profile `package.json` 的 `dsh.profile.bundles`，**并且**在 `dependencies` 里写成 `"link:<绝对路径>"`。

第 2 步里的 `dependencies` 不是可有可无。`reconcileProfilePlugins` 只会把**能作为依赖解析出来**的包名写回 bundles；仅仅列在 bundles 里的名字，一旦遇到整表重写就会**永久消失** —— 例如桌面端的崩溃恢复 `sanitizeProfile()`，它把 bundles 直接替换成内置 web profile 的 `["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]`。2026-09-28 本插件正是这样丢的（profile 里留着两个 `.bak-<epoch-ms>` 指纹，而 `.bak-` 只有 `sanitizeProfile` 会写）。

**装完不必重启应用**（0.1.7-rc.2 起）。`dsh-hmr` 监听 profile 的 `package.json`，**且只在 `dsh.profile.bundles` 的有序列表变化时才重新合成**（`dsh-hmr/lib/index.js:353-376`）；宿主半随之重新加载，浏览器半是页面级模块，**刷一次页面**即可。重启仍是保底手段 —— 而且如果清单本来就没写对，刷新也不会有效果。

自检（只合成并打印，不占端口、不启动服务）：

```bash
E="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
B="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"
ds() { ELECTRON_RUN_AS_NODE=1 "$E" --expose-internals "$B" "$@"; }

# 一次性 HOME 里验证这个包能被合成（node_modules 必须放在 profile 目录内）
rm -rf /tmp/paste-probe && mkdir -p /tmp/paste-probe/profiles/probe/node_modules
cd /tmp/paste-probe/profiles/probe
cat > package.json <<'JSON'
{"name":"probe","private":true,
 "dependencies":{"dsh-paste-spill":"link:<本仓库>/dsh-paste-spill"},
 "dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","dsh-paste-spill"],"patchReload":"live"}}}
JSON
printf '[]\n' > cordis.patch.yml
ln -s <本仓库>/dsh-paste-spill node_modules/dsh-paste-spill
DSH_HOME=/tmp/paste-probe ds --profile probe --dump-config | grep -A 1 paste-spill
```

预期输出**一行** `- id: paste-spill` / `name: dsh-paste-spill`（一个包两半，所以只有一行）。若名字在 bundles 里但包解析不出来，会打印 `dsh: skipping profile bundle "…"`：**不致命，但等于没装**。

三个容易踩的点：`DSH_HOME=/tmp` 时 profile 目录是 `/tmp/profiles/probe`（不是 `/tmp/probe`）；本版本只认 `DSH_HOME`，没有 `DSH_HOME_DIR`；`--profile desktop` 会被 CLI 直接拒绝（"managed exclusively by the Electron application"），桌面 profile 只能由应用内的插件管理器安装。

装好后确认浏览器半真的生效：读 renderer 的 `localStorage["dsh.paste-spill.diag"]`，`build` 应为当前 BUILD_REV，`applyRanAt` 为**刚刚**的时间戳。

## 卸载

```bash
rm ~/.dsh/profiles/desktop/node_modules/dsh-paste-spill
# 再从 ~/.dsh/profiles/desktop/package.json 的 dsh.profile.bundles
# 与 dependencies 里删掉这个名字（两处都要删，否则会被 reconcile 加回来）
```

## 测试

```bash
cd dsh-paste-spill && node --test    # 108 个测试：宿主半 17 + 浏览器半 91
```

## 证据工具（没有 console / CDP 时怎么读真机状态）

```bash
# 渲染层 localStorage：诊断 + 每个会话的视图状态（leveldb 直读，含 Snappy/SSTable/WAL）
python3 scripts/read-leveldb.py "~/Library/Application Support/@deepseek-ai/dsh-desktop/Local Storage/leveldb" --key dsh.paste-spill.diag --stdout-json

# 某次对话真正提交了什么（zstd 多帧拼接，逐帧解压）
node scripts/read-session.mjs ~/.dsh/sessions/<workspace>/session-<id> --users
```

诊断在 `localStorage["dsh.paste-spill.diag"]`：顶层是最后一次的汇总，`bySession.<sessionId>` 是**按会话**的
状态。确认插件真的加载了新一版：`build` 必须等于当前 `BUILD_REV`、`applyRanAt` 是刚刚的时间。

## 设计文档与计划

- 设计：`docs/superpowers/specs/2026-09-20-dsh-paste-spill-design.md`
- 计划：`docs/superpowers/plans/2026-09-20-dsh-paste-spill.md`

## 已知限制

- 每次粘贴一枚 chip，同会话可多枚共存；rail 按需要换行。
- 折叠期间若切换会话：重进时若镜像草稿里只剩 chip 的 label，插件把**原文写回输入框**（不再画 chip），因此原文不会丢、也不会把 label 发出去；但这一轮 chip 本身不复活。
- chip 插入是一次 **revision CAS**：拿到的 `draftRev` 与调用时不一致就会被拒（会在若干次重试后放弃）。最终被拒时**回滚该条折叠记录**：文本原样留在输入框，绝不为它画一枚 chip（随后由 armed retry 接手重试）。
- armed retry 定位粘贴段：优先"光标仍在粘贴段末尾"，失败则接受"这段文本在全文**唯一出现**"（打字后照样能折）。只有出现**两次以上**（例如同一段文本被粘贴两次且都还没折）、或者文本已被改动/删除，才会放弃（连续 30 次 ≈ 6 秒）。
- 同一段文本在同一会话里出现两枚以上未折叠副本时，插件不猜哪一枚是刚才那次粘贴，交给光标规则决定；仍不明确就保持原文。
- 转文件层在附件上传失败时把原文补回编辑器（best-effort）；若补回失败，失败的附件卡仍带重试按钮，内容不会丢失。
- 交付卡带一个 `⌄` 菜单（"用默认应用打开 / 在 Finder 中显示"）。对粘贴文本属赘余，但它收在折叠菜单之后，且在宿主不可用时整体禁用。
