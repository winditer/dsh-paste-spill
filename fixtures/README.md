# 手工验证夹具（GUI 端到端）

用这些文件验证两层阈值。**从文件里全选复制**（不要从聊天窗口复制），粘贴进输入框：

| 文件 | 字节数 | 预期 |
| --- | --- | --- |
| `paste-3k.json` | 3031 | 无任何变化，正常内联 |
| `paste-6k.json` | 6008 | 出现**一个**折叠芯片（内容预览 + "在文本框中显示 ›" + `×`），**文本仍在输入框里**（外观被折起）。点芯片 → 解除折叠、**芯片消失**、全文正常显示；点 `×` → 把这段文本**从输入框剪掉**。发送（折叠态或展开态）turn 里都是**原始文本，没有任何文件 chip** |
| `paste-60k.json` | 60154 | **不出现**折叠芯片；文本落盘为真附件（`pasted-text-1.json`），**输入框 chip 与时间线卡片都正常显示**，草稿里的大文本被移走，提交后点卡片可在右侧栏预览 |

阈值是 **UTF-8 字节**：4000 / 50000。

检查内建诊断（无需重启）。**应用根目录下有两个 Local Storage，插件的诊断只在 `Partitions/` 那个里**：

| 目录 | 存什么 |
| --- | --- |
| `Partitions/dsh-desktop-renderer/Local Storage/leveldb` | **本插件的 `dsh.paste-spill.diag`** |
| `Local Storage/leveldb` | `dsh.conversation.chat.*`、`dsh.sessions.current` 等常规键，**没有**插件诊断 |

```bash
RENDERER_STORAGE_DIR="$HOME/Library/Application Support/DSH Desktop/Partitions/dsh-desktop-renderer/Local Storage/leveldb" \
  python3 scripts/read-renderer-storage.py --json dsh.paste-spill.diag
```

**查错时注意两点**：

1. **先确认读的是 `Partitions/` 那个。** 读另一个会得到 "no matching keys found"，看起来像"插件从未执行"，实际上只是找错了分区 —— 这个误判会让排查方向完全跑偏。
2. **诊断 JSON 是累积的**，旧构建写过的键会一直留在里面（例如 `cardRendered`、`watcherInstalled` 这类已从源码删除的键）。所以**不要**只看最后一整份对象，要按"当前源码会写哪些键"来筛；出现源码里已不存在的键，说明那条来自旧构建。

关键字段：
- `build` — 当前加载的构建标记，用于确认改动已热加载
- `lastPasteSource` / `lastPasteBytes` — 剪贴板文本是否被观测到，以及来源（`beforeinput` / `paste`）
- `lastDecision` / `lastRunBytes` — 阈值判定
- `foldStoredBytes` / `foldCollapsed` — 折叠记录与是否成功清空编辑器
- `manualCollapse` / `manualExpand` — 点芯片折叠/展开是否生效（`collapsed` / `expanded`）；折叠**不动草稿**
- `manualExpand` — 点芯片展开时文本是否写回（`restored`）
- `foldDismissed` — 点 `×` 是否删除了这段粘贴（持有 + 附件）
- `sendCommitted` — **发送后是否清理了折叠**（持有 + 记录 + 标记全释放）。看到粘贴/保留却始终没有这个键，就说明发送没有被观察到
- `uploadStartBytes` / `uploadReady` / `uploadFailed` / `uploadFailureDetail` — 转文件那一层
- `spilledTextRemoved` — 成功后被移出草稿
