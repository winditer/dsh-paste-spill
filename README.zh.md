# dsh-paste-spill

[English](README.md) | 中文

DSH 输入框的**入站**大文本粘贴处理：**4–50 KB** 的粘贴折叠成一枚 chip（**每次粘贴一枚**，可单独展开或删除），**≥ 50 KB** 的粘贴转成**真附件**，并在 turn 末尾出一张可点开的交付卡。

`dsh-spill` 管的是出站方向（工具输出离开模型）。本插件补上相反的那一半：把一大段日志、diff、JSON 或文档**粘进**输入框时该怎么办。

| 层 | 粘贴大小（UTF-8 字节） | 行为 |
|---|---|---|
| 折叠层 | 4,000 – 50,000 | 刚粘贴的那一段移出编辑器，变成一枚 chip。每次粘贴一枚，多枚共存，先前的 chip 不会被覆盖 |
| 转文件层 | ≥ 50,000 | 文本作为真附件上传：消息里是 `file` 块，turn 末尾出现可点卡片，点击在右侧栏打开文件 |

两层相互独立，且都以**粘贴进来的那段文本**为基准（不是整篇草稿）：折叠层改的是输入框外观，转文件层改的是模型收到什么。小于 4,000 字节的粘贴完全不做处理。

## 折叠层（4,000 – 50,000 字节）

一次粘进 4 KB–50 KB 时，**只有刚粘贴的那一段**移出编辑器，交给插件按 `ref` 持有的 chip。你自己打的字、以及之前粘贴留下的 chip 都不动。

每枚 chip 显示：

- 该段粘贴的前 20 个字符（空白折叠成一行）作为预览；
- `在文本框中显示 ›` / `Show in text box ›` —— 点击把**这一枚** chip 的原文写回它原来的位置并释放；
- `×` —— **只删除这一枚** chip 并释放它的文本（`删除这段文本` / `Delete this text`）。

chip 是编辑器里的真实节点，不是装饰：它注册了一个 `inputTriggers` source，`serialize(ref)` 返回**原文全文**。所以发送出去的就是这段粘贴本身——既不是占位符，也不是附件。

一次粘贴等于一枚 chip，因此第二次粘贴 6 KB 是**追加**一枚，而不是覆盖第一枚：chip 是它那段文本的唯一载体，覆盖就等于把那段粘贴删掉。

浮动的 chip 带自己量自己的高度，作为 `--dshps-chip-band` 写到输入卡片上，卡片再把它变成 `padding-top`。chip 浮在第一行输入之上而不是盖住它；多枚 chip 换行时高度随之变化。

## 转文件层（≥ 50,000 字节）

50,000 字节及以上的粘贴会被合成一个 `File`，走输入框**既有的附件上传链路**，文件名按内容嗅探（`pasted-text-<n>.json` / `.md` / `.py` / `.js` / `.html` / `.csv` / `.txt`）。结果是消息里一个合法的 `file` 块，模型通过 stock 附件处理拿到只读宿主路径——不改 session 格式，也不改模型侧。

宿主半监听 `agent/inbox/inserted` 找出这些粘贴文件，从附件存储解析出宿主路径，并在 `agent/pre-step` 里发布 `deliverables/presented` 事件；stock 的交付 UI 因此在 turn 末尾渲染一张可点卡片，点击在右侧栏打开文件。随后原文从输入框中**就地**清除——只把粘贴那一段自己的 span 写成 `""`，绝不重写整篇草稿，所以其它 chip、手打的文字、光标和 undo 历史都不受影响。

## 截图

<!-- 预留位置。把图片放进 assets/（见 assets/README.md），取消下面两行注释，
     并把 screenshots.json.example 复制成 screenshots.json。

![dsh-paste-spill 效果预览：6 KB 粘贴在 DSH 输入框上方折叠成一枚 chip](assets/screenshot-1.png)
![dsh-paste-spill 效果预览：60 KB 粘贴转成附件，turn 末尾出现交付卡](assets/screenshot-2.png)

-->

目前仓库里还没有真实截图：本节、`assets/README.md` 与 `screenshots.json.example` 就是预留的位置。放入两张图片、取消上面两行注释即可生效——dsh-market 会把本 README 里相对的 `assets/...` 路径解析成 GitHub 图床图片。

## 安装

在 DeepSeek Harness CLI 里装进 **web** profile：

```sh
dsh plugin --profile web add github:winditer/dsh-paste-spill
```

**DSH Desktop** 请在应用内的插件管理器（设置 → 插件）或插件市场里安装；CLI 会拒绝 `--profile desktop`，因为该 profile 由应用自己管理。

从本地 checkout 开发本插件时，用 `scripts/install-into-profile.sh` 把本仓库软链进 desktop profile，并写入依赖条目——没有依赖条目的 bundle 行会在 profile 对账/崩溃恢复时被抹掉。

装好后浏览器半是页面级模块：**刷新一次页面**（或重启）即可生效。

## 兼容性

- `package.json` 里声明 `engines.dsh: ">=0.1.7-rc.2 <0.2.0-0"`，dsh-market 因此能在插件卡上标出要求。已在 DSH **0.1.7-rc.2**（web 与 desktop）上验证。
- 仅 Web UI（`dsh.client.platform: "web"`）：chip、chip 带、附件上传都在浏览器半；宿主半只要 bundle loader 能跑就行。
- 不修改也不替换任何 stock 包。只用公开扩展点：`inputTriggers` source、`conversation.input.overlay` 槽位、既有附件上传，以及 `agent/inbox/inserted` / `agent/pre-step` 会话事件。

## 实现结构

```
包 dsh-paste-spill —— 一行 loader，两半
  浏览器半  lib/client.js     (dsh.client, platform: web)
    草稿 watcher + 粘贴事件
      4000-50000 → 注册 chip source，把粘贴段换成 chip 节点，
                   原文按 ref 持有，在 overlay 里渲染 chip 带
      >= 50000   → 合成 File，走 stock 附件上传
  宿主半     lib/index.js      (exports["."], dsh.bundle.patch)
    agent/inbox/inserted → 记录粘贴附件的宿主路径
    agent/pre-step       → session.append("deliverables/presented", ...)
                           → stock 交付卡 → 右侧栏预览
```

一个包一行：`cordis.patch.yml` 只声明一次 `dsh-paste-spill`；loader 通过 `exports["."]` 导入宿主半，web-modules 扫描器则从同一个 `package.json` 的 `dsh.client` + `exports["./client"]` 发现浏览器半。

## 开发

```sh
node --test            # 108 个测试：宿主半 17（helpers 7 + plugin 10）、浏览器半 91
```

- 插件包**就是**仓库根目录——市场的 `dsh.bundle` 检查读的就是根 `package.json`。
- [docs/internals.md](docs/internals.md) —— 实现笔记：当前设计背后的真机 bug、对抗性评审的结论，以及试过又推翻的调试路径。
- [docs/superpowers/specs/](docs/superpowers/specs/) 与 [docs/superpowers/plans/](docs/superpowers/plans/) —— 设计文档与实施计划。
- [fixtures/](fixtures/) —— 测试用的真实粘贴样本（3 KB / 6 KB / 60 KB）。
- [scripts/read-leveldb.py](scripts/read-leveldb.py) 与 [scripts/read-session.mjs](scripts/read-session.mjs) —— 没有 console 时用来看渲染层 Local Storage 和某次会话真正提交了什么的证据工具。
- 应用内诊断写在 `localStorage["dsh.paste-spill.diag"]`（按会话的事实看 `bySession.<sessionId>`）。确认新构建真的加载了：`build` 必须等于当前 `BUILD_REV`，`applyRanAt` 是刚刚的时间。

## 已知限制

- chip 按会话存活。折叠期间切走再回来，插件会把原文写回输入框（不再为它画 chip），所以文本不会丢，也不会把 chip 的 label 当成消息发出去。
- chip 插入是一次草稿 revision CAS：revision 变了就重试，仍被拒则回滚该条折叠记录——文本留在输入框，绝不为它画 chip。
- 转文件后只有仍能定位到粘贴段时才会就地清除；定位不到就保持原文与附件并存（无害且可恢复），而不是去清空草稿。
- 附件上传失败时把原文 best-effort 写回编辑器；失败的附件卡仍带重试按钮。
- chip 自身的 label（`已折叠 5.9 KB`）目前是中文；chip 的 tooltip 与展开提示已中英双语。

## 许可证

[MIT](LICENSE)