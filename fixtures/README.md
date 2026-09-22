# 手工验证夹具（GUI 端到端）

用这些文件验证两层阈值。**从文件里全选复制**（不要从聊天窗口复制），粘贴进输入框：

| 文件 | 字节数 | 预期 |
| --- | --- | --- |
| `paste-3k.json` | 3031 | 无任何变化，正常内联 |
| `paste-6k.json` | 6008 | 出现折叠芯片，编辑器被清空并挂上 sidecar 附件；点芯片写回全文 |
| `paste-60k.json` | 60154 | 生成附件 chip，草稿里的大文本被移走，提交后 turn tail 出现可点击卡片、右侧栏可预览 |

阈值是 **UTF-8 字节**：4000 / 50000。

检查内建诊断（无需重启）。渲染进程的 Local Storage 在应用根目录下，
**不是** `Partitions/dsh-desktop-renderer/`：

```bash
RENDERER_STORAGE_DIR="$HOME/Library/Application Support/DSH Desktop/Local Storage/leveldb" \
  python3 scripts/read-renderer-storage.py --json dsh.paste-spill.diag
```

关键字段：
- `build` — 当前加载的构建标记，用于确认改动已热加载
- `lastPasteSource` / `lastPasteBytes` — 剪贴板文本是否被观测到，以及来源（`beforeinput` / `paste`）
- `lastDecision` / `lastRunBytes` — 阈值判定
- `foldStoredBytes` / `foldCollapsed` — 折叠记录与是否成功清空编辑器
- `foldSidecarAttached` — 承载文本的 sidecar 附件是否挂上（**为 `false` 则编辑器不会被清空**）
- `manualExpand` — 点芯片展开时文本是否写回（`restored`）
- `uploadStartBytes` / `uploadReady` / `uploadFailed` / `uploadFailureDetail` — 转文件那一层
- `spilledTextRemoved` — 成功后被移出草稿
