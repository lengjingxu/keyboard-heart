<!-- 贴进项目的 CLAUDE.md / AGENTS.md，让 AI 自主使用键盘反馈 -->

## 键盘灯光反馈（本机运行 keyboard-heart 服务，端口 8791）

用 curl 调用，静默失败即可（`>/dev/null 2>&1 || true`），不要为此打断主任务：

| 时机 | 命令 |
|---|---|
| 开始执行预计超过 30 秒的多步任务前 | `curl -s -X POST localhost:8791/fx/processing` |
| 任务成功完成 | `curl -s -X POST localhost:8791/fx/success` |
| 构建失败/测试挂了且无法自行解决 | `curl -s -X POST localhost:8791/fx/failure` |
| 需要用户输入、确认或权限 | `curl -s -X POST localhost:8791/fx/needInput` |
| 普通通知（不区分成败） | `curl -s -X POST localhost:8791/fx/notify` |

规则：短任务（<30s）不要触发；同一时刻只保留最新一个信号；processing 会被后续 success/failure 自动接管，无需手动清除。
