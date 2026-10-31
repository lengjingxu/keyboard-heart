# keyboard-heart ⌨️❤️

**给 Codex、Claude Code 和所有 AI 编码工具一个键盘状态灯**：AI 完成任务 → 绿色波纹扫过键盘；报错 → 右上角红色脉冲 ×3；等待你的批准 → 底行琥珀逐行生长。本地 REST + WebSocket 服务，两条接线方式：

- **hooks 自动接线**（AI 无感知）：Codex 加一行 `notify` / `hooks` 配置，Claude Code 合并一段 hooks JSON——AI 每次答完/请求批准，灯光自动反馈
- **提示词驱动**（AI 自主发挥）：把预设提示词贴进 CLAUDE.md / AGENTS.md，AI 在长任务开始、成功、失败、需要输入时自主打灯

开放每键 REST + WebSocket 原始控制，任何脚本都能自由发挥。

> 协议为独立逆向成果（WebHID 流量分析），无需厂商驱动，无需官方控制台。

![presets](https://img.shields.io/badge/presets-6-green) ![backends](https://img.shields.io/badge/backends-3-blue) ![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue)

## 30 秒接入你的 AI

**Codex**（`~/.codex/hooks.json`，推荐）：

```json
{ "_keyboard_heart": true, "hooks": [{ "type": "command", "command": "curl -s -X POST http://127.0.0.1:8791/fx/success >/dev/null 2>&1 || true" }] }
```

**Claude Code**（合并进 `~/.claude/settings.json`）：见 [integrations/claude-code-hooks.json](integrations/claude-code-hooks.json)。

**任何 AI / 脚本**（一行 curl）：

```bash
curl -X POST localhost:8791/fx/success
```

完整接入说明见下方 [接入 AI 编码工具](#接入-ai-编码工具) 章节。

## 支持的键盘

三层后端，覆盖 **12 款 MCHOSE 型号（直连）+ OpenRGB 生态数百款 + QMK/VIA 生态 1000+ 配置**：

### ① MCHOSE 直连（`KB_BACKEND=hid`，默认）— 12 款

协议独立逆向（55 DD 实时推流 + cmd=06 侧灯配置），设备档案由 `profiles/` 数据文件驱动。

**真机验证（1）**

| 键盘 | USB ID |
|---|---|
| MCHOSE Ace 68 Air 2 | `0x3837:0x300A` |

**社区表即插即用（2）**

| 键盘 | USB ID | 来源 |
|---|---|---|
| MCHOSE Ace 68（有线） | `0x41E4:0x2116` | SignalRGB 社区插件 |
| MCHOSE Ace 68（顺序 LED 变体） | `0x41E4:0x2114` | 社区 PR |

**候选表已就绪、等真机校准（9）**：Ace 68 air ii / air iii / gt / i / iii / pro / turbo 8k / turbo 16k / v2 iii —— 键位表已从厂商控制台资产自动提取（68/68 键全命中），`kbctl doctor` 列出，认领流程见 [贡献指南](docs/CONTRIBUTING-PROFILES.md)。

**同路线待解锁（22 款 MCHOSE）**：ACE60/Pro/X 系列、ACE75、G75 v2、G87 v2、G98、GOD60、GT75、JET75、K87、K99、MIX87、ZERO75X 等（需先贡献对应尺寸 layout）。

### ② OpenRGB 生态（`KB_BACKEND=openrgb`）— 数百款、100+ 品牌，逐键全功能

接入 [OpenRGB](https://openrgb.org) SDK（127.0.0.1:6742）即获得逐键控制，六个预设动画、每键 API、WS 帧流原样工作。覆盖 Corsair、Razer、Logitech、SteelSeries、ASUS ROG、MSI、Redragon、Womier 等品牌的键盘/鼠标/鼠标垫/灯带。

### ③ QMK / VIA（`KB_BACKEND=via`）— 1000+ 键盘配置，全局氛围

任意启用 VIA 的 QMK 键盘（raw HID 0xFF60:0x61）。标准 QMK 固件只开放全局亮度/颜色/灯效（无逐键协议），动画降级为平均色——语义保留（success 绿 / failure 红 / needInput 琥珀），适合当任务状态氛围灯。

⚠️ 仅 USB 有线模式；2.4G/蓝牙接收器不暴露灯控接口。

## Quickstart

```bash
git clone https://github.com/lengjingxu/keyboard-heart && cd keyboard-heart
npm install

# 1. 自检：找到键盘、验证权限
npm run doctor

# 2. 起服务（默认 127.0.0.1:8791，仅本机可访问）
npm start

# 3. 播放
npm link          # 首次：把 kbctl 装进 PATH
kbctl fx success
```

## 让 AI 帮你装

把下面这段话丢给任意 AI 编码助手（ZCode / Claude Code / Cursor…）：

```text
请帮我安装并启动 keyboard-heart（https://github.com/lengjingxu/keyboard-heart）：
1. clone 到本地，npm install，运行 npm run doctor 自检
2. 后台启动服务（npm start），确认 kbctl health 返回设备在线
3. 注册 launchd/systemd 开机自启（运行 ./install.sh --launchd 或 --systemd）
4. 用 kbctl fx success 验收，并告诉我怎么在自动化里调用
```

## 六个预设

| 预设 | 触发场景 | 效果 |
|---|---|---|
| `success` | 任务完成 | 绿色波纹从左下角扫过全板 |
| `failure` | 报错/失败 | 右上角红色脉冲爆发 ×3 |
| `needInput` | 等你输入/确认 | 琥珀逐行上生长→缩回→底行呼吸（长驻） |
| `notify` | 普通通知 | 白色涟漪从中心扩散 |
| `processing` | 开始干活 | 青色彗星外圈跑马（长驻） |
| `heartbeat` | 纯属可爱 | 红色小心心双搏动 |

优先级：`failure` > `success`/`notify`/`needInput` > `processing`/`heartbeat`。长驻动画会被更高优先级事件自动接管，结束后回到静态帧；`force: true` 强制替换。

## API

### REST（默认 `http://127.0.0.1:8791`）

```bash
curl -X POST localhost:8791/fx/success          # 播放预设
curl -X POST localhost:8791/fx/processing      # force 可选：{"force":true}

curl -X POST localhost:8791/keys \              # 静态点亮任意键
  -H 'Content-Type: application/json' \
  -d '{"keys":{"Q":"#ff0000","Space":"#00ff88"}}'

curl -X POST localhost:8791/keys -d '{"all":"#202020"}'
curl -X POST localhost:8791/keys -d '{"grid":[["#ff0000",0,0,"#00ff00"]]}'  # 16×5 网格

curl -X POST localhost:8791/side \              # 侧灯箱
  -d '{"color":"#00ff88","brightness":70}'      # 亮度 0-100

curl -X POST localhost:8791/clear               # 清静态帧+停动画
curl -X POST localhost:8791/off                 # 全灭（含侧灯）
curl localhost:8791/health                      # 设备在线状态
```

### WebSocket（自由发挥动画）

```js
const ws = new WebSocket('ws://127.0.0.1:8791/stream');
setInterval(() => {
  ws.send(JSON.stringify({ op: 'frame', keys: { Q: '#ff2020' } }));  // 每帧合并进静态帧，服务端 20fps 持续推流
}, 50);
// op: frame(keys|all|grid) | side | clear | fx | health
```

服务端架构：**单写入口**（唯一持有 HID 的进程），所有客户端的帧合并进 20fps 调度器——因为板载灯效引擎会持续刷屏，只有持续推流才能稳定显示自定义画面（协议关键发现）。

### kbctl 速查

```bash
kbctl fx <name>            # 六个预设
kbctl key Q=ff0000 A=00ff00
kbctl all RRGGBB
kbctl side RRGGBB [0-100]
kbctl clear | off
kbctl health | state
kbctl doctor               # 不需要服务，直接探测设备
```

KB_HOST/KB_PORT 环境变量可指向远程服务。

## 通用后端：QMK/VIA 与 OpenRGB

除了 MCHOSE 直连 HID，keyboard-heart 兼容两个**通用标准**（`KB_BACKEND` 环境变量选择）：

### OpenRGB（推荐的全彩逐键后端）

[OpenRGB](https://openrgb.org) 支持几百款 RGB 设备。启动 OpenRGB（勾选 SDK Server，端口 6742），然后：

```bash
KB_BACKEND=openrgb npm start
```

- 自动发现服务器上的键盘（`KB_OPENRGB_DEVICE=<索引|名称>` 可指定）
- 通过 LED 名称映射到 65% 网格——六个预设动画、每键 API、WS 帧流**全部原样可用**
- 未匹配名称的 LED 按自身序号渲染，全板动画不受影响

### VIA / QMK（全局氛围后端）

任意开启 VIA 支持的 QMK 键盘（raw HID 0xFF60:0x61）：

```bash
KB_BACKEND=via npm start
```

⚠️ 标准 QMK 固件只开放**全局**亮度/颜色/灯效（逐键颜色不在标准协议内），因此 VIA 后端把每键动画降级为其平均色，适合当"任务状态氛围灯"。预设语义保留：success 绿、failure 红、needInput 琥珀。

默认 `KB_BACKEND=hid` 走 MCHOSE 直连协议（profiles/ 档案表）。



两条路线可以叠加：**hooks 自动触发**（工具生命周期事件直连灯光，AI 无感知）+ **提示词驱动**（写进 CLAUDE.md/AGENTS.md，AI 按任务状态自主调用）。

### Claude Code（hooks 自动触发）

把 `integrations/claude-code-hooks.json` 的内容合并进 `~/.claude/settings.json`（或项目级 `.claude/settings.json`），也可在 Claude Code 里运行 `/hooks` 可视化添加：

- `Stop`（Claude 完成响应）→ `fx success`
- `Notification`（请求权限/等待输入）→ `fx needInput`

### Codex CLI

**hooks（推荐，需 Codex `features.hooks = true`）**：往 `~/.codex/hooks.json` 的 `Stop` / `PermissionRequest` 数组各追加一项（与 otty/CodexIsland 等 hook 并列；注意 Codex 只支持一条 `notify`，hooks 可多条）：

```json
{ "_keyboard_heart": true, "hooks": [{ "type": "command", "command": "curl -s -X POST http://127.0.0.1:8791/fx/success >/dev/null 2>&1 || true" }] }
```

（`PermissionRequest` 里把 success 换成 needInput；新 hook 首次触发时 Codex 会请求信任确认。）

**notify 桥接（兜底）**：没开 hooks 时，在 `~/.codex/config.toml` 加（绝对路径；Codex 只支持一条 notify，会覆盖已有配置）：

```toml
notify = ["/absolute/path/to/keyboard-heart/integrations/codex-notify.sh"]
```

桥接脚本解析事件：任务轮完成 → `success`，请求批准 → `needInput`，其余 → `notify`。

### 提示词驱动（任何支持 CLAUDE.md / AGENTS.md 的 agent）

把 `integrations/agent-prompt.md` 的内容贴进项目的 CLAUDE.md / AGENTS.md，AI 就会自主在长任务开始时打 `processing`、完成时打 `success/failure`、需要输入时打 `needInput`。

### ZCode / 任意自动化

一行 curl 即可（PostToolUse hook、workflow、cron 均可）：

```bash
curl -X POST localhost:8791/fx/success
```

长任务的推荐姿势：开始时 `processing`，结束时 `success` 或 `failure`。

## 架构

```
lib/grid.js        设备档案 + 16×5 网格几何（键名→LED 槽位映射表）
lib/device.js      HID 传输：55 DD 七包推流 / cmd=06 侧灯配置对 / 拔插重连
lib/animations.js  六个预设（几何参数化，改起来直观）
lib/scheduler.js   单写入口 20fps 帧调度 + 优先级抢占 + 静态帧恢复
server.js          REST + WS（仅绑定 127.0.0.1）
bin/kbctl.js       CLI 客户端
heart.js           离线 CLI（不依赖服务，直接驱动设备）
```

新增键盘支持：在 `lib/grid.js` 的 `PROFILES` 加一条（vendorId/productId/键位表），键位表可从厂商控制台资产提取，`node heart.js rainbow` 实拍校准。

## 致谢

- [Luk-Krn/mchose_ace68](https://github.com/Luk-Krn/mchose_ace68) — 有线版 Ace 68 的 SignalRGB 插件，本项目的起点
- MCHOSE 官方 WebHID 控制台 — 矩阵键位表与侧灯配置协议的来源

## License

MIT
