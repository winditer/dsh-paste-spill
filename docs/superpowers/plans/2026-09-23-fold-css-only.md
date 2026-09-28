# 折叠 chip:改为"只改外观、绝不改编辑器"

> **已被取代（2026-09-28）**：这份计划的前提是"原文必须留在草稿里"。后来发现
> `inputTriggers` 的 chip source 在提交时会用 `codec.serialize(ref)` 把 chip 换成原文
> （stock 自己的图片/`@file` chip 就是这么工作的），所以**原文可以离开编辑器**、由插件按
> `ref` 持有，turn 里依旧是纯文本。
>
> 现行实现（见 `README.md`）因此是：**每次粘贴把那一小段文本换成一枚 chip 节点**，多枚
> 共存；展开/`×` 都只作用于点中的那一枚；chip rail 用实测高度给卡片留 padding-top，
> 不遮输入框。stock 的 chip 隐藏改用 `[data-composer-chip="folded-text"]`（稳定属性，
> 不是 CSS-module 哈希）。本文仅作历史记录。

## 已验证的事实(决定了方案)

1. **图片 chip 的工作方式**:粘贴 → `intakeFiles` → attachment → 由
   `conversation.input.attachments` 这个 `kind:"single"` slot 渲染到编辑器**上方**的
   rail。**编辑器草稿完全不被修改**,所以打字/光标/撤销/多次粘贴都正常。
2. **文件 attachment 到不了模型**(`dsh-llm/lib/index.js:600` `fileHandleText`):
   模型收到的是
   `[File "…" (6000 bytes, sha256:…): verbatim read-only copy saved at "…" …]`
   —— **是句柄文字,不是原文**。所以走 attachment 永远无法把原文送进 turn。
3. `content = [...attachments, ...text === "" ? [] : [{type:"text", text}]]`
   `text` 来自**草稿**。→ **原文必须在草稿里**,才能以 `type:"text"` 逐字进入 turn。

## 结论

唯一同时满足"原文逐字进 turn" + "不毁编辑器"的形状:

- **原文留在草稿里**(发送时 `type:"text"` 带上它)
- **只用 CSS 把它藏起来**(clamp + mask),**不替换任何节点**
- chip 用**我们自己的 overlay** 画在编辑器上方(rail 形式)
- **绝不调用 `insertReference`,绝不 `setDraft`**

前五轮所有 bug(rev CAS / detect 与 clipboard 坐标 / 原子节点孤儿 / copy 投影 label
sentinel / 重复粘贴互相覆盖)都源于**改写编辑器**。这个方案从根上消除它们。

## 具体改动

### 1. 删除编辑器改写
- `insertFoldChip` 整个函数删除(含 `foldSpanFor`、`foldTag`、重试循环、`settleTurn`)
- `reactToDraft` 的 fold 分支:不再 defer、不再 insert;只写 record + 标记"需要 clamp"
- `holdStore` / `foldTextByRef` 保留但**只用于**"展开时不该丢失文本"的语义 ——
  实际上文本一直在草稿里,所以 hold 的作用变为"告诉 watcher 别把 record 退掉"
- `setDraft` 的调用点(1699、1201)删除

### 2. 折叠 = 纯 CSS clamp
已有基础:`FOLD_ATTR`(data-dshps-folded)、`[data-input-scroll]`、`max-height` +
`mask-image`。现在它从"fallback"变成**唯一机制**。
- clamp 的判定依据:该 session 有 fold record,且草稿里**仍含**该 record 的 sentinel
- 多次粘贴:每次 paste 都写一条 record(带唯一 tag),clamp 与 chip 一一对应

### 3. chip overlay:镜像图片 chip 的交互
- 位置:编辑器**上方**,与附件 rail 同区(`dshps-chip-band`)
- 内容:类型图标 + 标签(`已折叠 5.9 KB`)+ 前 20 字预览 + 展开动作 + `×`
- **多个 chip 并排**(flex wrap),对应多次粘贴
- `×`:从草稿里**删除该段原文**(`removePastedText`),再删 record
- 展开:移除该 chip 的 clamp(文本本来就在,不需要写回)→ **无 setDraft**
- 发送:文本在草稿里,天然可发送

### 4. 多次粘贴
每次 detection 到 4000-50000 的新 run:
- 写 record 到该 session 的 **list**(不再是单条),key 用唯一 ref
- 每个 record 记住自己的 `text`(用于 `×` 删除)和 `sentinels`(用于存活判定)
- clamp 的高度 = 各 record 对应的行数之和?不 —— 文本是连续的,
  取"总高度超出 N 行就 clamp"即可;chip 数量与 record 数量一致

### 5. 文本输入
因为不再动编辑器,光标与打字**天然正常**。这是本方案的主要收益。

## 验证
- 单元:record 增删、clamp 判定、`×` 删除对应文本、展开不改草稿
- 场景(用 /tmp/sim.js 的忠实模型):
  1. 连续粘贴 3 次 → 3 个 chip,draft 含全部原文
  2. 展开 → 删除 → 粘贴 → 光标/文本正常
  3. 粘贴后**继续打字** → 文本正常追加
- 撤回验证:每个行为都要有"改坏→测试失败"的负向验证

## 风险
- clamp 只藏住可见区域,`Ctrl+A`/`Ctrl+C` 仍能拿到全文(可接受,甚至更正确)
- 需要确认 clamp 高度与 chip 不重叠(已有 `CHIP_BAND_PX` 经验值)