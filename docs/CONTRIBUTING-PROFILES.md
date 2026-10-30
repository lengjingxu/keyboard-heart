# 贡献新键盘支持（Profile 贡献指南）

keyboard-heart 的设备支持全部由 `profiles/*.json` 数据文件驱动——**新增键盘不需要改任何代码**，只需一张键位表。

## Profile 结构

```json
{
  "id": "ace68_air_2",                          // 唯一 id（文件同名）
  "name": "MCHOSE Ace 68 Air 2",                // 展示名
  "vendorId": "0x3837",                         // USB VID（十六进制字符串）
  "productId": "0x300a",                        // USB PID；null = 候选（未确认）
  "interface": 1,                               // HID 接口号（灯控口）
  "layout": "65",                               // profiles/layouts/ 里的布局 id
  "table": [18, 56, ...],                       // 与 layout.keys 等长；值=LED 槽位，-1=无独立灯
  "verified": true,                             // 真机逐键验证过才可 true
  "source": "出处说明",
  "quirks": ["已知怪癖"]
}
```

规则：
- `productId` 非 null 的 profile 参与 USB 自动识别；**同 VID:PID 只能有一个 detectable profile**
- 候选（productId: null / verified: false）不会影响检测，`kbctl doctor` 会列出
- 布局文件 `profiles/layouts/<id>.json` 提供 `keys`（物理键名行优先）和 `positions`（16×5 网格坐标，动画几何用）

## 三条获取键位表的路线（成本从低到高）

### 路线 A：厂商是 MCHOSE → 自动提取

厂商控制台为每块板下发 `default-keys-<device>.js` 资产，`index` 字段即矩阵/LED 槽位（已在 ace68 家族验证）：

```bash
node tools/gen-mchose-profiles.js          # 批量生成家族候选
```

非 65% 尺寸（60/75/87/98）需要先贡献对应 `layouts/<size>.json`。

### 路线 B：有 SignalRGB 插件 → 自动导入

社区插件的 VID/PID + 键位表可直接转换（按物理坐标对齐，已用 mchose_ace68 插件验证 68/68 一致）：

```bash
node tools/signalrgb-import.js \
  https://raw.githubusercontent.com/<user>/<plugin>/HEAD/hid/<file>.js
```

### 路线 C：都没有 → 手工校准

1. 用 `system_profiler SPUSBDataType`（macOS）拿到 VID/PID
2. 手写一张全 `-1` 的候选 profile（可以先只填 guess）
3. 点亮全板彩虹并逐键记录：`node heart.js rainbow` 配合拍照，或用 WS 通道逐槽点亮
4. 填好 `table` 后用 `node heart.js heart` 验证

## 验收清单（PR 前）

- [ ] `npm test` 通过（会校验表长度、槽位范围、无重复槽位）
- [ ] `kbctl doctor` 能识别设备且显示 profile 名
- [ ] `node heart.js heart`（或服务端 `kbctl fx heartbeat`）在**真机**上形状正确
- [ ] `verified: true` 只在逐键确认过才标；否则留 false 并在 quirks 里写明待办
- [ ] 发现的固件怪癖写进 `quirks`（例：air_2 的 Del/Ins 出厂对调、引号键无独立灯位）

## 参考资产

- 厂商控制台资产索引：`https://www.mchose.com.cn/cizhou/CZ_SHARED_DATA/asset-manifest.json`
- SignalRGB 插件仓库：按品牌在 signalrgb.com 搜索，插件源码一般在 GitHub `hid/*.js`
- 同族固件可能共享键位表模块（ace68 家族内部就有 4 组共享），stub 文件 `var s=t(<moduleId>)` 会指向宿主
