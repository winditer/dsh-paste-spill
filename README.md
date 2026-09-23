# dsh-paste-spill

DSH 的**入站**大文本粘贴处理：`dsh-spill` 管的是工具输出（出站），本插件补上方向相反的那一半。

| 层 | 阈值 | 行为 |
|---|---|---|
| 折叠层 | **4,000 – 50,000** UTF-8 字节 | 输入框出现**一个**芯片（内容预览 + "在文本框中显示 ›" + `×`）。**文本原样留在输入框里，只是外观被折起来** —— 没有任何附件 |
| 转文件层 | ≥ **50,000** UTF-8 字节 | 文本变成**真附件**落盘，消息里是 `file` 块；turn tail 出现可点卡片，点击在右侧栏预览。**附件卡正常显示** |

两层相互独立：4,000 层只改变**外观**（纯展示），50,000 改变模型所见。

## 折叠是纯展示的

折叠**不动草稿**：文本一直留在编辑器里，插件只是给它套一个 CSS 高度钳制（`data-dshps-folded` + `max-height` + 渐隐遮罩），让输入框看起来像被折起来了。因此：

- **发送折叠态或展开态，turn 里都是原始文本** —— 编辑器里的内容就是真身，stock 的提交路径直接序列化它（`compose()` 里 `draft: this.projection.clipboardText`），插件不需要、也无法旁路。
- **不会出现任何文件 chip**：折叠层从不挂附件。

## 折叠芯片的两个动作

| 操作 | 行为 |
|---|---|
| 粘贴 4000–50000 字节 | 文本**留在输入框**，上方出现**一枚芯片**；外观被折起 |
| 点芯片主体（`在文本框中显示 ›`） | **解除折叠**，全文恢复正常显示，**芯片随即消失**（没有东西可折叠了） |
| 点右上角 `×` | **直接删除**：把这段粘贴的文本**从输入框里剪掉**，并清掉折叠状态 |
| **发送** | 草稿被 stock 清空，芯片与折叠记录一起清掉，不留任何状态 |

**为什么 × 必须真的删文本**：折叠态下文本还在输入框里，所以只卸载芯片会让"已删除"的粘贴继续留在输入框里 —— 看起来删了、其实没删。

**为什么展开不写回文本**：`setDraft` 会**整段重建编辑器**（`root.clear()` 后逐行重填），对一次纯外观切换来说既没必要、也会丢掉光标位置与撤销历史。

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
    4000–50000 → 记一条 fold 记录（文本留在编辑器里）
                 → 给输入框套 CSS 钳制 + 在 overlay 槽里渲染一枚芯片
                     点芯片 → 解除钳制，芯片卸载（草稿一字未动）
                     点 ×   → 把这段文本剪出草稿 + 清掉折叠状态
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

- 折叠芯片按会话跟踪**最近一次**大粘贴；连续多次大粘贴只显示最新的一次。
- 折叠是**纯外观**的：文本始终在编辑器里，所以它**可以被选中、会被 slash/命令解析看到**（这正是"发送折叠态即发送原文"的代价与收益）。
- 折叠期间若切换会话，折叠记录仍在内存中（不落盘）；展开路径依赖同一个插件实例。
- 转文件层在附件上传失败时把原文补回编辑器（best-effort）；若补回失败，失败的附件卡仍带重试按钮，内容不会丢失。
- 交付卡带一个 `⌄` 菜单（"用默认应用打开 / 在 Finder 中显示"）。对粘贴文本属赘余，但它收在折叠菜单之后，且在宿主不可用时整体禁用。
