# 手工验证夹具（GUI 端到端）

用这些文件验证两层阈值。**从文件里全选复制**（不要从聊天窗口复制），粘贴进输入框：

| 文件 | 字节数 | 预期 |
| --- | --- | --- |
| `paste-3k.json` | 3031 | 无任何变化，正常内联 |
| `paste-6k.json` | 6008 | 出现折叠卡片，全文仍留在输入框 |
| `paste-60k.json` | 60154 | 生成附件 chip，草稿里的大文本被移走，提交后 turn tail 出现可点击卡片、右侧栏可预览 |

阈值是 **UTF-8 字节**：4000 / 50000。

检查内建诊断（无需重启）：

```bash
python3 scripts/read-renderer-storage.py --json dsh.paste-spill.diag
```

关键字段：
- `build` — 当前加载的构建标记，用于确认改动已热加载
- `lastPasteSource` / `lastPasteBytes` — 剪贴板文本是否被观测到，以及来源（`beforeinput` / `paste`）
- `lastDecision` / `lastRunBytes` — 阈值判定
- `uploadStartBytes` / `uploadReady` / `uploadFailed` / `uploadFailureDetail` — 转文件那一层
- `spilledTextRemoved` — 成功后被移出草稿
