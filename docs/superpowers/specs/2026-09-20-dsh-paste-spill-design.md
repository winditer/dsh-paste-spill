# dsh-paste-spill — 设计文档

> 日期：2026-09-20
> 状态：已实施（§0 记录实施期更正；§4.3 记录折叠层的两次形态更正：
> "仅提示" → "输入框内折叠" → "输入框内的折叠卡片，框外无任何提示"）
> 插件名：`dsh-paste-spill`（SPEC §10 已定）
> 目标环境：DSH Desktop `0.1.5-rc.2`，checkout `/Applications/DSH Desktop.app/Contents/Resources/app/`
> 依据：`dsh-paste-spill-investigation.md`（SPEC），本设计**更正了 SPEC 中三处不成立的机制**（见 §9）

---

## 0. 实施期更正：检测机制从 `paste` 事件改为草稿订阅

原设计（§4）在 `document` 上装捕获阶段 `paste` 监听器，命中输入框时 `preventDefault()` 并合成文件。**该机制经应用内实测证伪**，已整体替换。

**实测证据**（诊断写入渲染进程 Local Storage，宿主侧读取）：

- 监听器确实安装成功、`apply()` 四个服务全部就绪；
- 草稿确实变了（长度 2 → 15 → 18）；
- 但**没有任何一次 `paste` 事件到达该监听器**，`foldStore` 始终为空，卡片始终 `cardHasRecord: false`。

**根因**：输入框是 Lexical 的 contenteditable。`paste` 事件按焦点派发，浏览器只保证送给当前聚焦元素；且 Lexical 的 `PASTE_COMMAND`（`ui-conversation` 的 `insertFromPaste` 分支）走自己的编辑器状态机，捕获阶段的 `preventDefault()` 并不能压住它。因此"监听 paste 事件"既不保证收到、也不保证拦得住。

**替换机制**：订阅 `shell.state`（InputState store，`compose()` 发布的快照），用**前后两次草稿的 diff** 识别插入内容。优势：

1. 与焦点无关，不可能漏掉插入；
2. 一次粘贴在 Lexical 里是**单个 `editor.update`**，因此只触发一次 `rev += 1`，diff 必然拿到完整粘贴内容，不会被分片；
3. **不需要 `preventDefault()`**：转文件层改为"上传 `ready` 后再 `setDraft()` 还原到粘贴前的值"。失败时文本仍原样留在编辑器中，本身就是完整兜底，无需恢复逻辑；上传中不做移除，因此上传失败**不可能丢文本**。

**第二次更正：diff 不足以测量"覆盖粘贴"。** 实测第二轮发现，把一份 JSON 粘贴到**已有的、结构相似的** JSON 之上时，公共前后缀裁剪后的"插入内容"只剩差异部分（实测 8877 字节），于是一份约 50000 字节的粘贴被低估、永远跨不过阈值。原因很直接：**diff 只能反映净变化量，无法反映实际到达的字节数**。

修法：用 `beforeinput`（`insertFromPaste` / `insertFromPasteAsQuotation`，其 `dataTransfer` 携带真实剪贴板文本）与 `paste`（`clipboardData`）两条来源把粘贴文本记进一个"单槽收件箱"，草稿变更时优先用这份**真实文本**判定阈值，diff 仅作为兜底（打字、IME、拖拽）。收件箱条目有 4 秒时效，避免把陈旧条目算到后续无关编辑上。

同时修正移除逻辑：转文件层成功后**只移除粘贴的那部分文本**，而不是把草稿清空或还原成粘贴前的内容——粘贴既可能是追加、也可能是替换，清空会丢掉无关文本，还原会让用户已替换掉的旧内容复活。

**由此得到的一个关键不变量**：折叠层记录的文本**直接来自草稿自身**，所以 `keepFoldFor` 的 `draft.includes(record.text)` 按构造必然成立。原设计比较的是"剪贴板原始字符串"与"编辑器归一化投影文本"两个不同来源，可能合理地不相等；该隐患随之消失（`test/bundle.test.js` 有测试固定此不变量）。

---

## 1. 要解决的问题

Codex 在输入框粘贴大段文本时会自动转成文件（Desktop 生成 `Pasted text.txt` 附件，TUI 显示 `[Pasted Content N chars]`）。DSH **没有**输入侧的这个能力：`dsh-spill` 管的是**工具输出**，是方向相反的既有机制。

本设计实现它的**入站对偶**：

| 层 | 阈值 | 行为 |
|---|---|---|
| 折叠层 | ≥ **4,000** UTF-8 字节 | 输入框出现**一个**芯片（内容预览 + "在文本框中显示 ›" + `×`），**编辑器清空**、文本由插件持有；点芯片写回全文，点 `×` 删除（持有 + 附件）；折叠时自动挂 sidecar 附件保证提交不为空 |
| 转文件层 | ≥ **50,000** UTF-8 字节 | 文本变成**真附件**落盘，消息里是 `file` 块；turn tail 出现可点卡片，点击在右侧栏预览 |

两层**独立**（SPEC §4.3：`两层不要合并成一个开关`）。4,000 是纯 UI 折叠，零语义变化；50,000 改变模型所见，必须显式。

**用户已确认的两项决策：**
- **A. 折叠层形态 = 输入框**内部**的折叠卡（`conversation.input.overlay`），框外不放任何提示；不做编辑器内 chip**
  - 实施期更正：最初落在 `conversation.composer.dock`、后又改到 `conversation.input.dock`，两者都在 `[data-composer-card]` **之外**（`input.dock` 是卡片的前一个兄弟节点），只能"提示"而不能"在框内折叠"。最终只保留 `conversation.input.overlay` 一处注册。
- **B. 包结构 = 两包**

---

## 2. 阈值口径

采用 **UTF-8 字节**，不是字符：

- 对齐 `dsh-spill-policy` 的 `maxInlineBytes: 50000`（`dsh-base/cordis.patch.yml:380-386`），使"什么算大文本"在整个 harness 中只有一个答案；
- 中文下按字符会过早触发（1000 字符中文仅约 3KB）；
- `dsh-token-meter` 按字节密度估算（`CHARS_PER_TOKEN = 4`），字节口径可互相推理。

Codex 的 `LARGE_PASTE_CHAR_THRESHOLD = 1000` 是**纯 UI 折叠**阈值、不落盘（`codex-rs/tui/src/bottom_pane/chat_composer.rs:404`），与我们的 4,000 折叠层同性质；照抄 1000 会得到一个折叠阈值而非转文件阈值。

---

## 3. 架构总览

两个包，职责按**进程边界**切分（这是与 SPEC §10.3 三分结构的关键差异，理由见 §9.3）。

```
┌─ 浏览器 (client half) ──────────────────────────────────────┐
│ dsh-client-ui-paste-spill                                   │
│                                                             │
│  ① document 捕获阶段 'paste' 监听                            │
│       └ 取 clipboardData text/plain，测 UTF-8 字节           │
│                                                             │
│  ② bytes ≥ 50000 → 合成 File → addFiles()（现成上传链路）     │
│       └ 消息里就是真 file 块；composer 显示附件卡             │
│       └ 阻止默认粘贴（文本不进编辑器）                        │
│                                                             │
│  ③ 4000 ≤ bytes < 50000 → 全文照常进编辑器 + 记一份折叠元数据  │
│       └ 输入框内部渲染一张折叠卡（编辑区上方、框内）           │
│       └ 提交时全文原样内联（不做任何替换）                    │
└─────────────────────────────────────────────────────────────┘
                          │ 上传经 fileUploads.upload（既有 remote 面）
                          ▼
┌─ 宿主 (host half) ──────────────────────────────────────────┐
│ dsh-paste-spill                                             │
│  ④ agent/inbox/inserted 观察：本轮提交里有哪些附件            │
│       └ 对每个 file 块调 attachments.fileHostPath(ref)        │
│       └ 记入 pending（按 session）——此 hook 内不 append       │
│  ⑤ agent/pre-step 观察：turn 已打开                           │
│       └ session.append("deliverables/presented", {turn,       │
│           callId, files:[{path, description}]})              │
└─────────────────────────────────────────────────────────────┘
                          │ 事件流
                          ▼
   现成 dsh-client-ui-deliverables（已挂载）
   → 投影为 turn tail 的 PresentedFileCard
   → 点击 → openFile(path) → 右侧栏 documentpreview
```

**关键收益**：≥50,000 走**真实附件上传**，消息里就是合法 `file` 块 ⇒ `dsh-llm` 的 `fileHandleText`（`lib/index.js:599-604`）**自动**给模型只读宿主路径 ⇒ **零模型侧改动、零 session 格式改动**。

---

## 4. 包一：`dsh-client-ui-paste-spill`（客户端）

### 4.1 粘贴捕获

stock 里**没有 paste 钩子**：`PASTE_COMMAND` 是包内闭包注册的（`ui-conversation:15259-15273`），`pasteText` 是内部 React 回调（`:16000`）。因此在 `document` **捕获阶段**监听 `paste`：

- 该手法有现成先例：`dsh-client-ui-sidebar-documentpreview/lib/client.js:5550` 即 `document.addEventListener("paste", this.paste.bind(this), { signal })`。
- 捕获阶段先于编辑器的 `PASTE_COMMAND`，可 `preventDefault()` 阻止文本进编辑器。
- 只处理 `text/plain`；`clipboardData.items` 里有 `kind === "file"` 时**直接放行**，交给 stock 的文件粘贴路径，不干预。
- 忽略来自输入框之外的粘贴（用 `event.target` 判定是否在 composer 的 contenteditable 内；不在则完全放行）。

字节数按 `new TextEncoder().encode(text).byteLength` 计算（`TextEncoder` 是 WHATWG 标准，浏览器原生）。

### 4.2 转文件层（≥ 50,000 字节）

复用 DSH **现成的附件上传链路**，而不是自造 remote 接口：

1. `new File([text], name, { type: "text/plain" })` —— 浏览器原生，粘贴的文本可以直接合成一个 `File`；
2. 交给**草稿附件链路**：`ctx.conversation.createDrafts(sessionId, [file])` → `shell.addAttachments(drafts.map(d => d.id))`（见 §4.4 的 API 路径；内部走 `beginFileUpload` 上传，经 `dsh-client-file-upload` 的 remote 面 `fileUploads.upload`）；
3. `preventDefault()` 阻止原文进编辑器 —— 文本从"内联"变成"附件"，这就是转文件的语义。

**不新增 remote 面**。SPEC §6.3 方案 A（加 `remote.attachments.hostPath`）被否决：它需要向浏览器暴露任意宿主路径，是新增的攻击面；而我们**根本不需要**客户端知道宿主路径（路径由宿主侧在 §5 取到）。

**命名**：按 SPEC §5.4，文件名须过 `fileLeafName()` 清洗（`dsh-attachment-local:638-644`），且 `ensureFileReference()` 要求 `ref.name` 已是清洗后的形态（`:645-649`）。客户端合成 `File` 时用朴素名（如 `pasted-1.txt`），实际落盘名由宿主侧 `fileLeafName` 规范化。

**扩展名**（SPEC §7.1「扩展名要有意义」）：按内容轻量猜测（代码 vs 文本），至少让代码保住高亮；猜不出时退回 `.txt`。猜不中不影响正确性，只是语法高亮体验。

**上传失败的降级**（SPEC §7.1）：失败的正确降级是"保留原始内联文本"。但上传是**异步**的，其结果不在 `createDrafts`/`addAttachments` 的返回值里（见 §12-1）。因此实现时二选一：能可靠观测失败则失败时把原文补回编辑器；**观测不可靠则保守地始终保留内联原文**（不 `preventDefault()`）。两种都绝不静默丢内容。

### 4.3 折叠层（4,000 ≤ bytes < 50,000）—— 输入框内折叠

> **本节已修订。** 折叠层被改过两次形态，逐版记录如下，**前两版勿再实现**。最终形态在 §4.3.1：`conversation.input.overlay` 一处注册，框内一张折叠卡，框外无提示。
>
> 1. **`conversation.composer.dock` 在空白会话不渲染。** 它只在 `variant === "composer" && input !== void 0 && sessionId !== void 0` 下渲染，而 `variant` 在 `sessionId === void 0 || shellPhase === "blank" && …` 时为 `"hero"`。空白会话（也就是粘贴大文本的第一现场）该槽位根本不渲染 —— 卡片无论如何都不会出现。
> 2. **卡片不能同时依赖两个 store。** 初版卡片要求"折叠记录 + 会话草稿"同时成立，但 draft hook 由 `standardProps` **按 session binding 只物化一次并缓存**（WeakMap keyed by scopeBinding），早于 shell 创建的 binding 会永久持有空 store，卡片据此判定"文本已消失"而永久隐藏。现在折叠记录是卡片唯一数据源，生命周期由 draft watcher（唯一能看到每次修订的地方）通过 `sentinels` 掌握。
> 3. **折叠卡必须在输入框内部，框外不留任何提示。** 前两版分别落在 `conversation.composer.dock` 和 `conversation.input.dock`（后者修掉了"空白会话不渲染"的问题）。但**这两个槽位都在 `[data-composer-card]` 之外**：`composer.dock` 在 `composerBar` 里、与此无关；`input.dock` 由 `composerBar` 渲染成卡片的**前一个兄弟节点**。用户两次反馈说得正是这件事："现在只有提示，我希望直接在输入框中显示折叠样式"、"我需要和附件一样的折叠在输入框内部，不需要在外部提示"——只要还在框外，就永远只能"提示"而不能"在框内折叠"。`conversation.input.overlay` 是唯一渲染在卡片**内部**的可用槽位（渲染点 `sessionId !== void 0 && <div class=overlayAnchor>{renderSlot("conversation.input.overlay", {})}</div>`），因此现在是**唯一的注册点**。

**由更正 1–3 收敛出的最终形状**：`conversation.input.overlay` 一处注册、一个组件 `PasteFoldChip`，同时负责①渲染框内的折叠卡 ②给卡片打上 `data-dshps-folded`。两者必须同源：卡片可见性与它施加的折叠样式若来自两处，就会出现"卡在框内、折叠样式却没施加"的不一致状态。

#### 4.3.1 输入框内的折叠卡（`conversation.input.overlay`）

```js
ctx.slots.inject("conversation.input.overlay", () => ctx.slots.register({
  name: "conversation.input.overlay",
  id: "paste-spill",
  order: 0,
  locale: NS,
  inject: (sessionId) => ({ sessionId, hooks: { pasteFold: foldStore, foldExpanded: expandStore }, setFoldExpanded }),
}, PasteFoldChip));
```

为什么是 `input.overlay`（四个候选都已逐个核对）：

| 候选 | 结论 |
| --- | --- |
| `conversation.input.dock` | `kind:"list"`、与 variant 无关，但由 `composerBar` 渲染成 `[data-composer-card]` 的**前一个兄弟节点** —— 在框外。**已废弃** |
| `conversation.input.attachments`（在卡片内） | `kind: "single"`，已被 `dsh-client-ui-attachment` 独占；且渲染器 `renderOutletContent` 对 single 只取 `entriesOfSlot(...)[0]`，第二个注册者被静默丢弃。**不可用** |
| 编辑器内的真 chip | `editor` 是 `SessionInputShell` 私有字段，插件拿不到；要往别人的 Lexical 实例注册 node 并**重建提交内容**，正是破坏 `/goal` 解析的做法（Codex #25346）。**不做** |
| `conversation.input.overlay` | `kind: "list"`、`scope: "session"`，与 stock 的 `input-trigger`/`commands`/`message-feedback` 共用；渲染点在 `[data-composer-card]` **内部**、编辑区之上。**采用** |

**卡片形态（已修订，参照 Codex）**：**单个**芯片，两行高（48px），不再有"已折叠大文本 · N 字节 · N 行"这种状态行。复用 stock 附件卡的视觉语言（`.5px solid var(--dsw-alias-border-l2)`、`background:var(--dsw-specific-input-major)`、`border-radius:12px`），内容是：

```
[≡]  {"readings": {"b…        (×)
     在文本框中显示 ›
```

- 上行 = **内容预览**（`foldPreview`：把折叠文本压成一行、40 字符后加省略号），让用户认得折叠的是哪一段；纯空白文本才退回标签文案。
- 下行 = **动作**`在文本框中显示 ›`。
- 右上角 `×` = 关闭。
- 结构是 `div` 容器 + **两个兄弟 `<button>`**（展开按钮、关闭按钮），不是嵌套按钮 —— 嵌套 `<button>` 是非法 HTML。展开按钮占满芯片主体，键盘可达（`aria-expanded`）。

**两个意图必须分开**：点主体 = **展开写回**；点 `×` = **关闭即删除**（释放持有 **+ 卸掉 sidecar 附件**）。`×` 的 onClick 必须 `stopPropagation()`，否则同一次点击会既删除又展开。删除必须连附件一起 —— 否则输入框看着"已删除"、下一次发送却仍带着该文件。

**定位**：`conversation.input.overlay` 的锚点是**浮动层**（`.p_FcLG_overlayAnchor{height:0;position:absolute;inset:0 0 auto}`），而卡片本身 `position:relative`，所以芯片用绝对定位落在卡片顶部，并让卡片为它**预留一条带**：

```css
[data-composer-card][data-dshps-chip]{padding-top:60px}   /* 8 + 48 + 4 */
.dshps-chip{position:absolute;top:8px;left:12px;width:fit-content;height:48px;…}
```

`:has()` 不是必须的：`data-dshps-chip` 由 `applyFoldToCard` 直接打在卡片上，所以"芯片是否占位"用的是自身属性，只和 `data-dshps-folded` 一样是同一个组件写的。带高由 `CHIP_TOP_PX + CHIP_HEIGHT_PX + CHIP_GAP_PX` 三个 JS 常量算出并**插值进**样式串，避免与定位各写一份而失步（测试断言 `padding-top ≥ top + height`）。宽度用 `fit-content` 而非 `left+right` 双钉，否则会被拉成横贯整卡的 banner。

**为什么折叠时展开入口有两个、而框外没有**：芯片主体（按钮）是主入口；另一个是折叠区底部的渐隐带（见 4.3.2）。框外不再有任何提示元素。

#### 4.3.2 折叠样式与渐隐带

真正的"折叠"施加在编辑区上，由同一个组件的 `useLayoutEffect` 完成。它通过 ``anchorRef.current.closest("[data-composer-card]")`` 找到**自己所在会话**的卡片并打上 `data-dshps-folded`——这是"多会话同时打开时不会压错输入框"的关键：它只沿自身祖先链向上，绝不 `document.querySelector`。

用 `useLayoutEffect` 而非 `useEffect`：属性必须与"显示折叠"在同一次提交里生效，否则首帧会先画出 4 万字的全文再突然收起。

样式（纯 CSS，不包裹/不复制任何 stock 节点）：

```css
[data-composer-card][data-dshps-folded] [data-input-scroll]{
  max-height:84px;                       /* ≈3 行 */
  mask-image:linear-gradient(to bottom,#000 calc(100% - 30px),transparent);
  cursor:pointer}
```

`[data-input-scroll]` 是 stock 的滚动容器（原 `max-height:var(--dsh-composer-text-max-height)`，即 `336px`），只覆盖高度。该 stock 规则是单类、无 `!important`，所以本选择器靠两个属性选择器（≥3 个属性测试）在特异性上稳压它 —— 测试断言了这一点，因为一旦被简化成单类，折叠会**静默失效且无任何报错**。`mask-image` 让切边渐隐进卡片背景，读起来是"下面还有"而不是渲染错误。`FADE_PX=30` 与 `FOLD_CLAMP_PX=84` 是 JS 常量并**插值进**样式串，避免与命中判定各写一份而失步。

**渐隐带**用 `mousedown` **捕获阶段**命中判定（`clientY >= rect.bottom - FADE_PX`）后 `preventDefault()` 再展开。用捕获阶段是因为等到冒泡时插入点已被放置、容器已滚动，渐隐带会从指针下移开。**只有渐隐带可点**：可见文字行的点击完全照旧，因此折叠后仍能点进输入框追加"总结一下"，不会误展开。

**展开后带是否保留**：`applyFoldToCard` 的第三个参数 `hasChip` 仍与 `collapsed` 分开。展开会把持有文本写回编辑器、芯片随即消失，所以带在下一帧释放；分开传参保证的是"带只跟芯片的**存在**走"，而不是跟某个布尔状态走 —— 否则短暂的不一致就会让文字在带与无带之间跳一下。折叠态下 `hasChip` 与 `collapsed` 同时为真，带保留是主路径。

**卸载清理**：会话切走时由一个卸载 effect 清掉 `data-dshps-folded` 与 `data-dshps-chip`。残留属性会把**下一个**会话的输入框裁掉一大截，而屏幕上没有任何东西解释这件事。

#### 4.3.3 折叠的语义：真清空 + 持有 + 回写（**已修订**）

> **本节已修订，取代"仅表现层"的旧设计。** 用户明确要求："我希望折叠后，输入框中清空，展开后才显示原始内容。" 因此折叠不再是纯表现层：文本会被**真的移出编辑器**并由插件持有。旧设计的"文本始终在草稿里"是刻意选择（理由见下），但与用户要的交互直接冲突，故按用户要求改掉，并补上防止丢文本的机制。

**新语义**：折叠 = **清空编辑器 + 持有文本**；展开 = **写回文本**。

- 折叠时：只把**粘贴的那一段**从草稿中切除（`removePastedText`），用户自己写的其余文字保留；被切除的文本存进 `holdStore`（按 session 键的独立容器）。
- 展开时：把持有的文本**追加**写回草稿（不覆盖用户折叠期间新输入的内容），然后释放持有。
- 编辑器因此是真的空的 —— 这就是用户要看到的效果。

**为什么持有物必须独立于折叠记录**：折叠记录的生命周期由"文本是否还在草稿里"决定（§4.3.1 更正 2），而持有文本按定义**不在**草稿里 —— 复用同一份记录会被 watcher 立刻判为过期而清掉。所以 `holdStore` 是独立容器；并且 watcher 在**持有期间跳过记录清理**（否则折叠会立刻销毁展开所需的那份文本，变成永久数据丢失）。芯片可见性相应改为 `foldApplies(record) || 持有存在`。

**为什么必须挂 sidecar 附件（关键，防止静默丢文本）**：stock 的提交路径直接读编辑器内容（`compose()` 里 `draft: this.projection.clipboardText`），插件**无法从外部改写、也没有可拦截的 hook**。因此"清空后直接点发送"会把内容发成**空**。解法：折叠时同时用**既有附件上传链路**（`createDrafts` + `addAttachments`，与 ≥50000 转文件层同一条已验证的路）挂一个承载同样文本的 sidecar 文件，消息里就是合法 `file` 块，提交不会丢内容。

**顺序是安全性的全部**：先挂附件，**只在附件被接受之后**才清空草稿。附件被拒（提交面被锁）时降级为"文本原样留在编辑器 + 芯片在上方"，即旧行为；绝不出现"空编辑器 + 无人发送的文本"。

**sidecar 的文件卡被 CSS 隐藏（用户要求"只保留上部分内容"）**：附件仍存在于草稿并随消息发出，只是卡片不显示：

```css
[data-composer-card] [title^="folded-text-"]{display:none}
```

选择器按 stock 卡片自身的 `title` 属性（`FileCard` 里 `title: name`，即文件名）匹配，并限定在 `[data-composer-card]` 内：

- 前缀 `folded-text-` 是本插件独有的（`FOLD_NAME_PREFIX`，stock 中无同名前缀），所以**只隐藏折叠层的 sidecar**，用户拖进来的真实附件不受影响；
- 限定在输入框卡片内，避免命中页面上其他同 `title` 的元素；
- 用 `display:none` 而非 `visibility:hidden`，卡片不占位、不留空隙。

**为什么折叠层必须有自己的前缀（关键）**：两层都会挂文件，若共用 `pasted-text-`，隐藏规则无法区分它们，会把 **≥50000 层的附件卡一并隐藏** —— 而那张卡（"文本变成真附件"的可视结果）正是那一层存在的意义。因此：

| 层 | 前缀 | 输入框卡片 | 时间线卡片 |
|---|---|---|---|
| 折叠层 sidecar | `folded-text-` | 隐藏 | **不生成** |
| ≥50000 落盘附件 | `pasted-text-` | 显示 | 生成（可点击预览） |

**折叠层不生成时间线卡片**：折叠的可见身份只有输入框芯片，再生成一张 `deliverables/presented` 大卡会把同一段粘贴展示两遍（实机反馈："需要删除"）。所以宿主半分成两个判定：

- `isSpillAttachmentName`（仅 `pasted-text-`）—— 决定是否发 `deliverables/presented`；
- `isFoldAttachmentName`（仅 `folded-text-`）—— 折叠 sidecar，仅用于承载提交。

两者不可合并：合成一个"两个前缀都算"的判定，正是最初误发时间线卡片的原因。

**由此产生的取舍**：隐藏卡片同时隐藏了 stock 的上传进度/失败重试/删除入口。删除入口由芯片的 `×` 承担（按 attachment id 卸载，不依赖任何 DOM），但**上传失败将不再可见** —— 此时消息里可能带一个未 ready 的附件。这是"只保留芯片"这一要求的直接代价。

**发送必须清理（关键，修复状态跨交互累积）**：stock 的 `commitSend()` 会清空草稿并收走被接收的附件，但插件此前**没有任何地方观察"发送完成"**。而 watcher 在持有期间**刻意跳过**记录清理（§4.3.3 的守卫，防止折叠摧毁自己的文本），于是"发送后的空草稿"与"折叠产生的空草稿"在 watcher 眼里**完全一样** —— 持有与记录因此永久存活，造成三个实机症状：芯片删不掉、输入框里留着看不见的占位、每次新粘贴都撞上旧状态并堆积 sidecar。

判定用**两个条件同时成立**：

```js
current === ""                       // 草稿已空
&& sidecarGone                       // 且我们自己挂的 sidecar 已不在 attachmentIds 里
&& (folded || held)                  // 且此前确实处于折叠/持有态
```

- `sidecarGone` 要求"我们记录过的 id 曾经存在、现在全部消失"。**不存在的 sidecar 不算 gone**：那正是折叠建立持有期间的状态，误判会把刚建立的折叠立刻清掉。
- `ours.length > 0` 这个前置条件把 **≥50000 层排除在外**：spill 从不挂 sidecar，所以永远不会被当成发送 —— 而 spill 同样以"草稿变空 + 附件被移除"结束，若不排除会抢走它的 revision，导致上传轮询停摆。
- 发送后 `sidecarIds` 是 **删除而非卸载**：附件已经随消息发出，此时卸载等于删掉用户刚发出去的文件。

**旧设计原本要避开的坑，现在的实际状态**：

- **斜杠命令 / goal**：折叠态下草稿确实为空，因此与"未装插件"不再一致 —— 这是本交互的**已知取舍**。折叠后若要输入 `/goal`，需先展开写回。sidecar 保证**内容**不丢，但不再保证"编辑框所见即命令解析所见"。
- **无需 `sinkSerialized` 展开**：仍然成立，因为回写走 `setDraft`，不参与提交序列化。

卡片与折叠状态仍按 `sessionId` 跟踪。`expanded`（用户是否手动展开）存在**独立的 session store** 里，并与折叠记录**同步清除** —— 否则"展开过一次 → 清空草稿 → 再次粘贴"会让新文本一出现就是展开态。

**已知取舍**：折叠态下编辑器为空，被折叠的文本**无法直接选中**，也无法在折叠态下追加进同一段文本 —— 展开即恢复。展开时新输入的内容与回写的文本以换行分隔并存。

### 4.4 客户端依赖与取用（已核对的 API 路径）

**两个清单不可混淆**（这是 `dsh-temp-chat` 与 stock 插件的共同形状）：

| 清单 | 位置 | 内容 | 作用 |
|---|---|---|---|
| `dsh.client.inject` | `package.json` | **npm 包名**（如 `@deepseek-ai/dsh-client-ui-conversation`） | 声明加载顺序依赖；决定哪个包先加载 |
| 插件自身 `inject` | `lib/client.js` 里 `return { inject: [...], apply(ctx){...} }` | **cordis 服务名**（如 `"conversation"`、`"sessions"`） | 授权 `ctx.<service>` 访问。**未声明的服务访问会被 reject**（`dsh-cordis-client-runner/lib/client.js:314-323`） |

**已核对的 cordis 服务名**（`super(ctx, "<name>")` 实测）：

| 服务名 | 提供者 | 我们是否需要 |
|---|---|---|
| `slots` | `dsh-client-ui-renderer:995` | ✅ 注册 `conversation.input.overlay` |
| `conversation` | `dsh-client-ui-conversation:2857` | ✅ `createDrafts` |
| `sessions` | `dsh-client-ui-session`（`ctx.sessions.list`，`:322`） | ✅ 当前会话 id |
| `locale` | `dsh-client-locale` | ✅ 文案 |
| `fileUpload` | `dsh-client-file-upload:158` | 备选（直接上传时） |
| `uiSession` | `dsh-client-ui-session:99` | 备选 |

因此客户端插件返回：

```js
return {
  inject: ["slots", "conversation", "sessions", "locale"],
  apply(ctx) { /* ... */ },
};
```

**取当前会话 id**：`ctx.sessions.list.getSnapshot().current`（`dsh-client-ui-session/lib/client.js:204` 即此用法）。

**落附件到草稿**：

- `ctx.conversation.createDrafts(sessionId, [file])`（`dsh-client-ui-conversation:2972`）→ 草稿描述符数组；对非图片**立即** `beginFileUpload`；
- 再加入草稿：`ctx.conversation.input.for(actx).addAttachments(ids)`（shell 公开方法，`:12776`）。槽位注入面的 `addFiles`（`:16765-16800`）正是 `createDrafts` + `addAttachments` 的组合，**但它只在 React 内可用**；我们的 `paste` 监听是 ctx 级的，所以走 `ctx.conversation` / `input.shell(id)`（`:13469`）。

> **注意**：`createDrafts` 依赖该 session 已有 binding。无 binding（如空白 shell）时**直接放行原文**，不做任何转换。

> **`ctx.conversation` 是根单例服务**（`super(ctx, "conversation")`，`:2857`，无 scope），可直接在插件 ctx 上访问，不需要 session-scope ctx。而 `conversation.input.for(actx)` **需要** session-scope ctx（`:13409` 会抛 `requires a session scope`），所以插件级优先用 `input.shell(sessionId)`。

### 4.5 包形态

`package.json`（形状照 `dsh-temp-chat`，一个已验证可用的第三方插件）：

```json
{
  "name": "@deepseek-ai/dsh-client-ui-paste-spill",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-ui-session",
        "@deepseek-ai/dsh-client-locale"
      ],
      "immediately": true
    }
  }
}
```

- `lib/index.js` = 宿主半的**占位**（与 `dsh-message-rail` / `dsh-ui-attachment` 同构：宿主半不做事，`lib/client.js` 承载 UI）。写 `export function apply() {}`。
- `lib/client.js` = `window.__ModuleLoader__.load({ id, factory: (require) => {...} })` 工厂包，**纯 JS + `require("react")`，无 JSX/import**（浏览器半的既有约定）。
- **无构建步骤**（已更正）：本机没有 esbuild 或任何打包器。`lib/client.js` **既是源码也是产物**，手写为 `window.__ModuleLoader__` 工厂包 —— 与 `dsh-message-rail` 的发布形态一致。纯逻辑在工厂内实现，并挂在 `module.exports.__internals` 上供 `node --test` 直接断言，避免"源码/产物两份、逻辑漂移"。
- `immediately: true` 让插件在启动时立即激活（与 `dsh-temp-chat` 一致），因为我们要在编辑器出现前就挂上 `paste` 监听。

---

## 5. 包二：`dsh-paste-spill`（宿主）

### 5.1 捕获（`agent/inbox/inserted`）

```js
ctx.on("agent/inbox/inserted", ({ agent, message }) => { ... });
```

- 该 hook 在 `agent/inbox/spliced` 的 append **返回之后**触发（`dsh-agent-loop/lib/index.js:206-208`），因此**不在 append 重入窗口内**。
- 从 `message.content` 里取出 `type === "file"` 的块，对每个 `attachment` 调同进程服务 `ctx.get("attachments").fileHostPath(ref)`（`dsh-attachment/lib/index.js:1039-1041`；`dsh-llm:2208-2217` 是同样用法）。
- 记入 **pending**（按 session 键）。**此 hook 内绝不 `session.append`** —— 见 §5.4 的重入约束。

只对"本轮由粘贴产生的"附件落 `presented`（避免把用户手动拖入的普通附件也标成交付物）。判定方式：客户端在合成 `File` 时给文件名加一个稳定前缀（如 `pasted-`），宿主按名匹配；这样不影响上传链路，也不改任何格式。

### 5.2 落盘事件（`agent/pre-step`）

**形状照抄 `dsh-plan-mode` 的已验证实现**（`dsh-plan-mode/lib/index.js:143-166`）：

```js
ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
  const decision = await next();                       // 先走瀑布，尊重别人的决定
  if (decision.kind === "reject" || signal.aborted) return decision;
  const pending = this.pending.get(agent.session);     // WeakMap 按 session 键（plan-mode 同款）
  if (pending === undefined) return decision;
  this.pending.delete(agent.session);                   // 先删，保证只 append 一次
  try {
    const boundary = ctx.sessionProjections.stateOf(agent.session, "turnBoundary");
    // boundary 可能为 undefined（投影未注册）；openTurnStartSeq === null 表示无开着的 turn；
    // lastTurn 初值是 0（init），而 isPresentedData 要求 turn >= 1 —— 三个条件都要挡。
    if (boundary === undefined || boundary.openTurnStartSeq === null || boundary.lastTurn < 1) return decision;
    agent.session.append("deliverables/presented", {
      turn: boundary.lastTurn,                          // 已由上面保证 ≥1
      callId: `paste:${pending.attachmentId.slice(0, 12)}`,
      files: [{ path: pending.path, description: "粘贴的大文本" }],
    });
  } catch (error) {
    ctx.logger.warn("dsh-paste-spill: failed to append presented event: %o", error);
  }
  return decision;
});
```

- 此时 `turn/start` **已落盘**，`turnBoundary` 投影的 `openTurnStartSeq` 非空、`lastTurn` 可读（`dsh-agent-loop:1301-1320`，读法见 `dsh-tool-present:78`），满足"事件必须写在 turn 打开之后"的硬约束；
- `lastTurn` 的初值是 **0**（`init`），而 `isPresentedData` 要求 `turn >= 1` —— 因此三个条件都要挡：`boundary === undefined`（投影未注册）、`openTurnStartSeq === null`（无开着的 turn）、`lastTurn < 1`；
- **必须先 `await next()`**，再读 pending、再 append —— plan-mode 就是这样（`:145-157`），既不短路瀑布，也不在决策前产生副作用；
- `pending` 用 `WeakMap` 按 `agent.session` 键：plan-mode 的 `pendingIntents` 即此形状（`:143` 附近），避免 sessionId 字符串泄漏与跨会话串味；
- 失败**只 warn 不抛** —— 绝不把成功的用户提交变成错误（spill 的既有约定，SPEC §7.1）。

### 5.3 复用 `deliverables/presented` 的三个已知后果

| 维度 | 结论 |
|---|---|
| 格式校验 | ✅ 不在任何 released disposition 表 → v3 按 opaque 事件处理，**零格式改动** |
| 类型白名单 | ✅ 已在 `KNOWN_SESSION_EVENT_TYPES` |
| 是否进模型请求 | ✅ **不会**——非 surface 事件，对模型零影响 |
| callId 必填 | ⚠️ 合成 `paste:<id 前 12 位>` |
| turn 必须已打开 | ⚠️ 因此必须落在 `turn/start` 之后（§5.2） |
| 自动渲染 | ⚠️ 自动渲染 `PresentedFileCard` —— **这正是我们要的** |
| 额外入口 | ⚠️ 卡片带 `⌄` 菜单 → "用默认应用打开 / 在 Finder 中显示"。对粘贴文本属赘余；但该菜单在 `host === null \|\| !host.available` 时禁用，且收在 chevron 之后，**接受** |

**白送的能力**：
- 点击卡片/「打开」→ `openFile(file.path)` → `openFile` → `ctx.sidebarRight.openResource(fileAddressFor(sessionId, cwd, path))` → 右侧栏 `documentpreview`（`dsh-client-ui-deliverables:804-806`，`:8319-8325`）。**这就是"默认在右侧栏预览"**；
- 4 个以上自动折叠成「全部 N 个文件」；
- `chatFileMentions.forClosing`（`:956-966`）：助手结尾用行内代码提到该路径时自动变可点链接。

### 5.4 为什么不在 `session/event` 里 append

SPEC §6.4.1/§9.3-1 提出"在 `session/event` 收到 `turn/start` 时 append"，并把它列为待实测项。**已实测否定**：

```js
// dsh-session/lib/index.js:1181
if (entry?.appending) throw new Error("session append cannot reenter while another append is being published");
```

`append` 全程持 `entry.appending = true`（`:1191`，`finally` 在 `:1206` 清除），并在**设置该标记之后**同步派发 `session/event`（`:1202`）。因此在 `session/event` 处理器里调 `append` **必定命中重入守卫抛错**，而该错误被 `invokeContainedSessionObservers`（`:968-977`）**只记日志地吞掉** → 表现为**静默失效**。`dsh-agent-instructions:1263` 与 `dsh-agent-presets:1337` 两个"先例"都是只读不写，正是这个原因。

`agent/pre-step` 不受此限（它在 append 返回之后才运行），且 plan-mode 已证明可写。

### 5.5 `turn/start` 与 `user/message` 的时序

取自磁盘会话日志（SPEC §6.4.1 已验证）：

```
seq 3  agent/inbox/spliced  target=next-turn   ← 提交进 inbox
seq 4  turn/start           turn=1             ← turn 打开
seq 5  agent/inbox/spliced  target=next-turn
seq 6  step/start           turn=1             ← pre-step 在此附近
seq 7  user/message                            ← 用户消息落在此后
```

我们的 `presented` 事件落在 step/start 附近，**晚于 turn/start(1)**，因此不会触发客户端归约器的"update 早于 start"抛错（`ui-conversation:1829`、`:1876`）。

### 5.6 包形态

```json
{
  "name": "@deepseek-ai/dsh-paste-spill",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./lib/index.js",
    "./package.json": "./package.json"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/dsh-agent": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-session": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-attachment": "^0.1.5-rc.2"
  }
}
```

宿主半是 `apply(ctx)` 的普通 cordis 插件（ESM，无浏览器产物）。**`inject` 只列真正用属性访问的服务**：

```js
export const inject = ["sessionProjections"];   // 读 turnBoundary 投影
```

- `agent/inbox/inserted`、`agent/pre-step` 是**事件/钩子名**，经 `ctx.on(...)` 订阅，**不列入 `inject`**；
- `ctx.get("attachments")` 是**可选查找**，不做 inject 门禁（`dsh-llm:2205` 即此用法），故 `attachments` 不必列入；
- `ctx.sessionProjections.stateOf(...)` 是**属性访问**，必须声明（参照 `dsh-tool-present:8-13` 的 `["tools","fs","sessionProjections"]`）。
- `ctx.logger` 是框架内置，无需声明。

---

## 6. 安装与挂载

两个包都装进 desktop profile：

1. 写包到 `~/.dsh/profiles/desktop/node_modules/<name>/`（或作为 workspace 包 link）；
2. 在 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 加两个包名；
3. 在 profile 的 `cordis.patch.yml` 用 `insert:` 追加两行：

```yaml
- insert:
    - id: paste-spill
      name: dsh-paste-spill
    - id: ui-paste-spill
      name: dsh-client-ui-paste-spill
```

`applyEntryPatches`（`dsh-app-boot/lib/index.js:59-106`）的 `insert:` 语义是**追加行**，因此不触碰任何 stock 行 —— 零上游改动。

> **当前环境限制**：本会话沙箱为 `workspace-write`，`~/.dsh/profiles/desktop/` **写不进去**（已实测 `Operation not permitted`）。因此本设计交付**可用于挂载的完整包源码 + 构建产物**，挂载到 profile 的那一步需要你在沙箱外执行（或提升沙箱权限）。

---

## 7. 错误处理与降级

| 场景 | 行为 |
|---|---|
| 上传失败 | 见 §12-1：能可靠观测则把原文补回编辑器；否则保守地始终保留内联原文。绝不静默丢内容 |
| `fileHostPath` 返回 `undefined` | 该文件不写 `presented`；文本仍以附件正常提交，只是历史里少一个可点入口 |
| `session.append` 抛错 | 按 plan-mode 方式 `ctx.logger.warn` 吞掉；用户提交**不受影响** |
| pending 与 turn 对不上 | 丢弃 pending（宁可少一次提示，不可错挂到别的 turn） |
| 非 composer 区域的粘贴 | 完全放行，不干预 |
| 粘贴内容同时含文件与文本 | 放行给 stock 文件路径，不干预 |
| 非 UTF-8 / 二进制文本 | 按 `TextEncoder` 结果计数，不特殊处理 |

---

## 8. 测试策略

**客户端（可在浏览器/Node 下测纯函数）**
- 字节计数：ASCII / 中文 / emoji / 混合，边界 3999 / 4000 / 49999 / 50000；
- 文件名与扩展名猜测：代码 vs 文本 vs 未知；
- 阈值分流：<4000 不触发；4000–49999 只出框内折叠卡（`input.dock` 不注册、框外无元素）；≥50000 只走附件。

**宿主（纯函数 + 事件合同）**
- `agent/inbox/inserted` 只从 `message.content` 提取 `file` 块，不误抓 text 块；
- pending 的 key 与清理；
- `deliverables/presented` 的 payload 形状过 `isPresentedData` 的等价校验（`turn`≥1、`callId` 非空、`files` 数组）；
- **回归**：确认不在 `session/event` 里 append（可用一个断言脚本复现 `:1181` 的重入抛错，作为"为什么不用它"的可执行证据）。

**端到端（需在 GUI 人工验证，沙箱外）**
1. 粘贴 5,000 字节 → 编辑器有全文 + **框内**折叠卡（框外不得出现任何元素）；提交后模型请求里是**内联全文**；
2. 粘贴 60,000 字节 → composer 出现 `pasted-*.txt` 附件卡；提交后消息里是 `file` 块；turn tail 出现交付卡；
3. 点交付卡 → 右侧栏 documentpreview **打开的是附件库里的文件**（这条同时验证 SPEC §6.1 的"工作区外可读"在真实 GUI 里成立）；
4. 助手结尾用行内代码提到该路径 → 变可点链接。

---

## 9. 对 SPEC 的三处更正

本设计在实现前核对源码，发现 SPEC 有三处机制不成立。**这些更正直接决定了上面的架构。**

### 9.1 §6.5.3 / 决策 7「给 `client.js:1253-1269` 的 fileCard 加 onClick」—— 落不了地

那处是发行版 stock 包 `dsh-client-ui-chat` 的 `UserStyleBubble` 内部，渲染裸 `<span className={fileCard} title={name}>`，**没有 `onClick`、没有 slot、不是 chain/keyed 扩展点**。插件无法从外部给它挂点击。SPEC 的决策 7 因此不可实现。

→ 用户的决策（turn tail 复用 `PresentedFileCard`）**正确绕开**了这一点，且白送右侧栏预览链路。

### 9.2 §6.6.1 / 决策 5「chip 层复用 `registerSource` + `serializeReference`」—— 机制不成立

- `registerSource`（`dsh-client-ui-input-trigger/lib/client.js:792`）只注册**触发器选择器的候选源**，不提供任何"从外部把 chip 插进编辑器"的能力；
- 真正插 chip 的是 shell **私有**方法 `insertReference(ref, span)`（`ui-conversation:12976`），且带 CAS：`if (span.draftRev !== this.rev) return false` —— 必须有**当次实时 revision 的 span**；事件通道 `slash/input-insert-reference`（`:13449`）由包内 `execute()` 派发，外部插件无法伪造一个合法 span；
- 编辑器 `nodes: [ReferenceChipNode, TextRefNode]` 是包内构造参数（`:12680`），`ReferenceChipNode` **未导出**。

→ 要做真 chip 只能 **shadow 整个 `dsh-client-ui-conversation`**。用户决策 A（输入框内折叠卡）避免了这一步。

### 9.3 §10.3 三分结构 —— 第三包在本场景失效

SPEC 主张拆出 `dsh-paste-spill-policy` 承载阈值。但：

- 两个阈值都必须在**客户端**判定（粘贴发生在 composer，4000 是纯客户端行为）；
- `dsh-web-app/cordis.patch.yml` 的 **39 个 `client-ui-*` 行全部没有 `config:`** —— 实测统计；
- 机制原因：entry 的 `config` 按行挂在**宿主** entry 上（`dsh-spill-policy` 就是这样经 `apply(ctx, config)` 拿到 `maxInlineBytes` 的）；而客户端半跑在 `dsh-cordis-client-runner`，其 `apply(ctx, config)` 的 config 来自**客户端插件记录本身**（`lib/client.js:618`），**不是**宿主那一行。

→ 独立 policy 包无法把阈值送到真正需要它的半边。三包的收益（"可关闭 = 卸包"）在 profile 的 `cordis.patch.yml` 里删一行同样可得。**采用两包**。

若日后要暴露给用户，正道是 `ctx.settingsScope.bind({ namespace: "paste-spill", schema: { foldBytes, spillBytes, enabled } })`（`dsh-client-ui-settings:1143`；用法见 `ui-chat:8275`），由设置页提供 UI —— 而不是假装一个 policy 包能跨进程送配置。

### 9.4 沿用的 SPEC 结论（已独立复核为真）

- §5 存储位置：`<DSH_HOME>/attachments/v1/files/`，复用附件库；`fileLeafName` 清洗规则；
- §6.1 工作区外可读：`dsh-api-workspace-files` 的 `confine()` **只被 `list()` 调用**（`:505`），`read`/`stat`/`locateFile` 不围栏 → 附件库路径可在右侧栏打开；
- §6.4 复用 `deliverables/presented`（零格式改动、对模型零影响、非 surface）；
- §7.1 四条坑（slash/goal、失败保留内联、可关闭、扩展名有意义）；
- §4.3 两层独立、`50000` 字节口径。

---

## 10. 范围（YAGNI）

**做**：两层阈值；输入框**内**的折叠卡（`conversation.input.overlay`，框外无提示）；转文件走真实附件上传；宿主侧取宿主路径并落 `presented`；复用现成交付卡做右侧栏预览。

**不做**（明确排除）：
- 编辑器内 chip（决策 A 已排除；需 shadow stock，风险高）；
- shadow 任何 stock 包；
- 「可关闭」设置项 —— 等真有需求时用 `settingsScope` 正经做；
- 工作区 vs 附件库的选择（SPEC 决策 6：一律落附件库）；
- "转回内联"动作；
- 修改 session 格式、新增 remote 面、修改任何 stock 包。

---

## 11. 交付物

```
/Users/haifeng/Documents/dsh-paste-spill/
├── dsh-paste-spill/                   宿主包
│   ├── package.json
│   ├── src/index.js                   阈值常量 + 两个 hook
│   └── lib/index.js                   构建产物（ESM）
├── dsh-client-ui-paste-spill/         客户端包
│   ├── package.json
│   ├── lib/client.js                  草稿订阅 + 框内折叠卡 + CSS（既是源码也是产物）
│   └── lib/{index.js,client.js}       构建产物
├── docs/superpowers/specs/2026-09-20-dsh-paste-spill-design.md
└── README.md                          挂载说明（沙箱外执行那一步）
```

---

## 12. 已解决：上传失败的观测方式

原设计把"如何观测上传失败"留作待验证项。**已核对源码，答案是可观测**：

`ctx.conversation.fileUploads` 是公开的 snapshot store（`dsh-client-ui-conversation/lib/client.js:2842`），每个草稿附件条目从 `uploading` 迁移到 `ready`（带 `receiptId`、`file`）或 `error`（带 `message`）（`:3015-3061`），并有 `getSnapshot()` / `subscribe()`。

因此**不需要**"始终保留内联原文"的保守降级：转文件层正常 `preventDefault()`，并订阅 `fileUploads`；仅在条目落到 `error` 时把原文补回编辑器（`shell.paste(text)`）。附件上传失败时 composer 本来就会显示带重试按钮的失败附件卡，内容不会丢失。

**另一项（捕获阶段 `preventDefault()`）**：实现照 DOM 标准做捕获阶段监听并 `preventDefault()`；若发现 Lexical 仍插入文本，退回"不 preventDefault"的保守路线（代价：大文本双重表示）。此项需在真实 GUI 走一遍 §8 的端到端用例 1–3 确认。

### 12.1 其它已核对、无需再验的点

- 取当前会话 id：`ctx.sessions.list.getSnapshot().current`（`dsh-client-ui-session/lib/client.js:204` 同款用法）；
- session-scope 槽的 `inject(sessionId)` **会收到 sessionId**（`ui-conversation:16717` 的 `composer.bar` 即此形状）→ 折叠卡能在组件内定位会话；
- `conversation.input.overlay` 是 `{kind:"list", scope:"session"}`，注册形状 `{name, id, order, locale, inject}`；stock 占用者 `dsh-client-ui-input-trigger`/`dsh-client-ui-commands`/`dsh-client-ui-message-feedback`，因此 `id` 必须用 `"paste-spill"` 以免冲突；
- `fileHostPath(ref)` 必须传**合法 durable ref**（`{attachmentId, name, bytes}`，且 `name === fileLeafName(name)`），否则抛 `INVALID_ATTACHMENT_REF`（`dsh-attachment-local:645-649`）→ 宿主侧应 try/catch 并跳过该文件；
- `agent/inbox/inserted` 的 payload 是 `{ agent, message }`（`dsh-agent/lib/index.js:209-220` 的 `agentEvents` 会把 `agent` 融合进每个 payload），`message.content` 里的 `file` 块形状为 `{type:"file", attachment:{attachmentId, name, bytes}}`；
- composer 的 contenteditable 宿主带 **`data-composer-input`** 属性（`ui-conversation:15155-15165` 的 `ComposerContentEditable`），这是判定"粘贴发生在输入框内"的可靠选择器。

### 12.2 实现阶段新增的两条更正

1. **无构建步骤**（见 §4.5）：本机没有 esbuild 或任何打包器，`lib/client.js` 手写为工厂包并直接发布，与 `dsh-message-rail` 一致。纯逻辑挂在 `__internals` 上供测试直接断言。
2. **客户端的两个清单不同源**（见 §4.4）：`package.json` 的 `dsh.client.inject` 是**npm 包名**（加载顺序），而插件自身返回的 `inject` 是**cordis 服务名**（`["slots","conversation","sessions","locale"]`，授权 `ctx.<service>` 访问）。实测 `dsh-client-ui-conversation` 以 `super(ctx, "conversation")` 提供 `conversation`、`:2857`；`sessions` 经 `ctx.get("sessions")` 访问、`dsh-client-ui-session:3183`。