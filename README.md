# keyboard-heart ⌨️❤️

把机械键盘的 RGB 灯变成你电脑的**状态指示器**：任务完成来一波绿色冲击波，报错来一记红色脉冲，需要你输入时底行琥珀呼吸。本地 REST + WebSocket 服务，任何脚本、AI agent、自动化都能调用。

> 协议为独立逆向成果（WebHID 流量分析），无需厂商驱动，无需官方控制台。

![presets](https://img.shields.io/badge/presets-6-green) ![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue)

## 支持设备

| 键盘 | USB ID | 状态 |
|---|---|---|
| MCHOSE Ace 68 Air 2（有线） | `0x3837:0x300A` | ✅ 全键位实测 |
| MCHOSE Ace 68（有线） | `0x41E4:0x2116` | 社区表，未实测 |
| MCHOSE Ace 68（顺序 LED 变体） | `0x41E4:0x2114` | 备用表 |

⚠️ 仅 USB 有线模式；2.4G/蓝牙接收器不暴露灯控接口。

## Quickstart

```bash
git clone https://github.com/lengjingxu/keyboard-heart && cd keyboard-heart
npm install

# 1. 自检：找到键盘、验证权限
npm run doctor

# 2. 起服务（默认 127.0.0.1:8790，仅本机可访问）
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

### REST（默认 `http://127.0.0.1:8790`）

```bash
curl -X POST localhost:8790/fx/success          # 播放预设
curl -X POST localhost:8790/fx/processing      # force 可选：{"force":true}

curl -X POST localhost:8790/keys \              # 静态点亮任意键
  -H 'Content-Type: application/json' \
  -d '{"keys":{"Q":"#ff0000","Space":"#00ff88"}}'

curl -X POST localhost:8790/keys -d '{"all":"#202020"}'
curl -X POST localhost:8790/keys -d '{"grid":[["#ff0000",0,0,"#00ff00"]]}'  # 16×5 网格

curl -X POST localhost:8790/side \              # 侧灯箱
  -d '{"color":"#00ff88","brightness":70}'      # 亮度 0-100

curl -X POST localhost:8790/clear               # 清静态帧+停动画
curl -X POST localhost:8790/off                 # 全灭（含侧灯）
curl localhost:8790/health                      # 设备在线状态
```

### WebSocket（自由发挥动画）

```js
const ws = new WebSocket('ws://127.0.0.1:8790/stream');
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

## 在 ZCode / 自动化里用

任务收尾时一行调用（把 success 换成对应结果）：

```bash
curl -X POST localhost:8790/fx/success    # ZCode hook / automation 的 PostToolUse
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
