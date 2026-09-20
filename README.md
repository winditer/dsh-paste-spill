# dsh-paste-spill

DSH 的**入站**大文本粘贴处理：`dsh-spill` 管的是工具输出（出站），本插件补上方向相反的那一半。

| 层 | 阈值 | 行为 |
|---|---|---|
| 折叠层 | ≥ **4,000** UTF-8 字节 | 输入框出现"已折叠大文本"卡片，**全文留在草稿中**，提交时原样内联给模型 |
| 转文件层 | ≥ **50,000** UTF-8 字节 | 文本变成**真附件**落盘，消息里是 `file` 块；turn tail 出现可点卡片，点击在右侧栏预览 |

两层相互独立。4,000 是纯 UI 折叠，零语义变化；50,000 改变模型所见。

## 为什么折叠层不替换文本

卡片只是**提示**，不替换、不清空、不改写编辑器内容。这让 slash 命令与 goal 解析看到的草稿与没装插件时完全一致 —— Codex 的同类实现（#25346）因为把文本替换成附件，导致 `/goal` 判空。

## 架构

```
浏览器半  dsh-client-ui-paste-spill
  document 捕获阶段 'paste'
    ≥ 50000  → 合成 File → 既有附件上传链路 → 真 file 块；阻止默认插入
    4000+    → 全文照常进编辑器 + composer.dock 折叠卡片
                 │ 既有 remote 面 fileUploads.upload
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

脚本会把两个包软链进 `~/.dsh/profiles/desktop/node_modules/` 并把包名加进该 profile 的 `dsh.profile.bundles`。profile 的 `patchReload: "live"` 会让改动即时生效；若 GUI 未自动拾取，刷新页面。

> 为什么必须在沙箱外：agent 的文件沙箱是 `workspace-write`，只能写本仓库，写不了 `~/.dsh/profiles/desktop/`。

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

- 折叠卡片按会话跟踪**最近一次**大粘贴；连续多次大粘贴只显示最新的一次。
- 转文件层在附件上传失败时把原文补回编辑器（best-effort）；若补回失败，失败的附件卡仍带重试按钮，内容不会丢失。
- 交付卡带一个 `⌄` 菜单（"用默认应用打开 / 在 Finder 中显示"）。对粘贴文本属赘余，但它收在折叠菜单之后，且在宿主不可用时整体禁用。