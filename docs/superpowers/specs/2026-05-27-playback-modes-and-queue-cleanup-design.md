# 播放模式 + 队列清理 设计文档

日期: 2026-05-27
范围: Claudio PWA 增量功能

## 目标

给现有个人电台加两类功能, 让用户对"接下来听什么"有更多掌控:

1. **播放模式切换** — 顺序 / 随机 / 单曲循环
2. **队列批量清理**
   - 「清空」: 一键把待播列表清光
   - 「换一批」: 清空待播列表 + 让 Claude 重新推一批

## 非目标

- 不引入多列表 / 歌单概念, 仍然是单一 `queue`
- 不改变 DJ 间奏 / now_playing / 历史 / 喜欢 等现有流
- 不上自动化测试套件, 沿用手测
- 不为多设备并发播放做新的协调 (现状: 两端各自触发 `audio.ended` 都会推进, 维持现状)

## 关键设计决策

**模式行为的归属**: 客户端驱动 + 服务端持久化。模式作为一个状态字段存在 `state.json`, WS hello 携带, PUT /api/mode 写入; 但"模式如何影响播放" (loop 原地循环 / shuffle 随机抽) 在前端 `audio.ended` handler 里分支处理。理由: 后端 popQueue / DJ 间奏 / now_playing 流不被打扰, 改动小, 模式只是"客户端行为开关 + 服务端持久化"。备选方案 (服务端 /api/next 收 mode 参数内部决定) 被否决: 单曲循环要让服务端知道"当前歌没换", 跟 DJ 间奏 / `playsSinceDjBreak` 计数耦合, 改动面大。

**「换一批」做成专用端点**: `POST /api/queue/refresh` 内部串起"清队列 + 走一次 chat 流水线", 而非前端两步 (先 PUT queue 再 POST chat)。理由: 复用流水线代码, 避免一半成功一半失败的中间态。

## 数据模型变化

`server/state.js` 的 `DEFAULT_STATE` 新增字段:

```js
playMode: 'sequential'   // 'sequential' | 'loop' | 'shuffle'
```

旧 `state.json` 没有此字段时, `load()` 里现有的 `{ ...DEFAULT_STATE, ...JSON.parse(raw) }` spread 会自动补默认值, 老用户兼容。

新增导出: `setPlayMode(mode)` — 校验枚举值 + 写状态 + `save()`。

## API 变化

### 新增

```
PUT /api/mode
  body: { mode: 'sequential' | 'loop' | 'shuffle' }
  → 200 { ok: true, mode } | 400 { error: 'mode 非法' }
  副作用: state.setPlayMode + WS 广播 { type: 'mode_update', playMode }

POST /api/queue/refresh
  → 跟 /api/chat 同样的返回结构 ({ kind: 'chat', say, play, resolved, ... })
  内部行为:
    1. state.setQueue([])
    2. broadcast({ type: 'queue_update', queue: [] })
    3. 调用现有 chat 流水线 (抽出来一个内部函数 runChatTurn('换一批不一样的'))
       — route → claude.invoke → resolvePlayList → state.pushQueue → broadcast dj_broadcast
    4. 把 chat 流水线的结果返回给客户端
```

### WS 消息

- `hello` 增加 `playMode` 字段
- 新增 `{ type: 'mode_update', playMode }` 广播

### 不动 (复用)

- `PUT /api/queue { queue: [] }` 用于「清空」
- 现有所有其他端点 / 消息类型保持不变

## 前端行为 (pwa/app.js)

### 模块状态

```js
let playMode = 'sequential';
```

### WS 处理新增

- `hello`: `playMode = msg.playMode ?? 'sequential'`; 同步模式按钮 UI
- `mode_update`: 同上 (用于多设备同步)

### `audio.ended` 分支

```js
audio.addEventListener('ended', () => advanceByMode());
audio.addEventListener('error', () => {
  // 原有 dedupe 逻辑保留
  advanceByMode();
});

function advanceByMode() {
  if (playMode === 'loop') {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  if (playMode === 'shuffle' && currentQueue.length > 0) {
    const idx = Math.floor(Math.random() * currentQueue.length);
    return jumpToQueueIndex(idx);  // 复用 POST /api/queue/play/:idx
  }
  playNext();
}
```

注: `jumpToQueueIndex(idx)` 是把现有"双击队列项"的逻辑抽成函数 (`pwa/app.js` 行 470-481), shuffle 模式和双击都复用。

### `btnNext` 点击

手动「下一首」按钮的语义: 不管什么模式, 点 ⏭ 永远推进; loop 模式下也跳到下一首, 不在原地循环。理由: 用户主动指令优先于自动行为。

实现: `btnNext` handler 调用 `advanceByMode()` 但临时把 loop 视作 sequential — 抽个参数 `advanceByMode({ userInitiated: true })`, userInitiated 时跳过 loop 分支。

### 模式按钮

`btn-mode` 点击 → 计算下一个模式 → PUT /api/mode → **不立即翻 UI**, 等 WS `mode_update` 回来再翻。理由: 服务端是单一真相源, 防止 PUT 失败时 UI 与服务端不一致。

模式循环顺序: `sequential → shuffle → loop → sequential ...`

### 「清空」 按钮

```js
fetch('/api/queue', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ queue: [] })
});
// queue_update 走 WS 回来, 现有渲染路径处理
```

### 「换一批」按钮

```js
autoPlayArmed = true;
appendChat('user', '换一批不一样的');
btnRefresh.disabled = true;
try {
  const r = await fetch('/api/queue/refresh', { method: 'POST' });
  const data = await r.json();
  if (data.kind === 'chat') appendChat('assistant', data.say, data.reason);
} catch (e) {
  appendChat('assistant', `换一批失败: ${e.message}`);
} finally {
  btnRefresh.disabled = false;
}
```

## UI 改动

### 主控制栏 (`index.html` card-now > .controls)

在 `#btn-next` 后、`#btn-like` 前插入:

```html
<button id="btn-mode" class="ctrl" title="顺序播放">
  <span class="mode-icon" data-mode="sequential">→</span>
  <span class="mode-icon" data-mode="shuffle" hidden>⇄</span>
  <span class="mode-icon" data-mode="loop" hidden>↻</span>
</button>
```

JS 切换三个 span 的 `hidden`, 同步更新 `title` (顺序播放 / 随机播放 / 单曲循环), 非默认模式加 `.active` class 复用现有 `ctrl-fb.active` 的视觉强调。

字符图标用 unicode 顶上, 跟现有 ▶ ⏭ ⏸ 风格一致; SVG 化留作后续。

### 队列工具栏 (新增, 在 card-list 内)

`.tabs` 是 tab 切换控件, 不混塞功能键; 在 `.tabs` 下面 / `#queue-list` 上面新加一个 toolbar:

```html
<div class="queue-toolbar" data-tab="queue">
  <button class="q-action" id="btn-queue-clear" title="清空待播列表">清空</button>
  <button class="q-action" id="btn-queue-refresh" title="让 Claude 重新推一批">换一批</button>
</div>
```

现有 tab 切换逻辑按 `data-tab` 显隐 `.tab-pane` (`pwa/app.js` 行 538-547), 让 toolbar 也参与同样的显隐 — 切到「已播」/「喜欢」 tab 时 toolbar 隐藏。

**禁用条件**:
- 「清空」: `currentQueue.length === 0` 时禁用
- 「换一批」: 队列为空时仍可点 ("空了, 推一批" 也是合理意图); 仅在请求飞行中禁用

### CSS

`pwa/style.css` 加 `.queue-toolbar` 和 `.q-action` 的样式, 复用现有 ctrl/queue 视觉语言 (mono 字体 + 圆角按钮)。本设计不规定具体 CSS 数值, 实现时跟现有按钮风格保持一致。

## 错误处理 / 边角

- **空队列 + 随机/单曲循环 + 当前歌结束**: 没东西可放 → 暂停, 保留 nowPlaying (现有 `playNext` 里 `if (!song) { audio.pause(); return; }` 已覆盖)。loop 模式如果当前歌的 `audio.src` 还在, 一直循环这首; 队列空与否不影响 loop。
- **单曲循环 + 手动 ⏭**: 走 sequential 推进, 模式不变。新歌播完继续循环新歌。
- **shuffle 抽到死链**: 现有 `audio.error` handler 复用 `advanceByMode()`, 再随机抽一首。
- **PUT /api/mode 失败**: 不预翻 UI, 在 chat 历史 appendChat 一行错误信息。不自动重试 (一次操作出问题用户会再点)。
- **换一批 + Claude 失败**: 队列已清, Claude 没返回 → 队列空。appendChat 一行错误, 用户可再点或自己说想听的。这是可接受的, 清队列是用户的主动决策。
- **换一批 vs 用户 chat 提交竞态**: 用一个全局 `inflight` 标记同步互斥 — 任一在飞时, 另一边禁用。实现上 `btnSend` 和 `btn-queue-refresh` 共享同一 disabled 来源。
- **换一批 在当前歌播放中触发**: 不停当前歌, 只清队列 + 推新一批。当前歌结束后按模式自然进入新队列。
- **多设备 (电脑 + 手机) 模式同步**: WS `mode_update` 广播保证两端按钮一致。

## 手测清单

实施后逐项过一遍:

- [ ] 顺序模式 → 一首播完自动切下一首 (回归测试, 现状)
- [ ] 切随机 → 当前歌播完应切到队列里随机一首
- [ ] 切单曲循环 → 当前歌播完原地重播
- [ ] 单曲循环下点 ⏭ → 跳到下一首, 新歌播完继续循环
- [ ] 切到随机, 点 ⏭ → 跳到随机一首 (而非顺序下一首)
- [ ] 重启服务器 → 模式仍是上次设置的
- [ ] 同时打开电脑 + 手机, 一端切模式 → 另一端按钮跟着翻
- [ ] 队列有歌 → 点「清空」 → 队列变空, 当前歌继续播
- [ ] 队列空 → 「清空」按钮变灰不可点
- [ ] 队列有歌 → 点「换一批」 → 队列清掉 + 立即出现新一批 + chat 历史多一行「换一批不一样的」
- [ ] 队列空 → 点「换一批」 → 可点, 推一批新歌进来
- [ ] 换一批请求飞行时, 「换一批」和「送出」 按钮都禁用
- [ ] 模拟 claude.invoke 抛错 (临时改 prompts) → chat 显示错误, 队列空着 (不崩)

## 范围外 (将来可考虑)

- 模式按钮 SVG 化 (现在用 unicode)
- 「换一批」前给一个确认提示 (现在直接清, 凭撤销 — 但实际无撤销, 接受这个风险, 因为换一批就是用户主动想换)
- 自动化测试套件
- 多设备并发 `audio.ended` 抢推进的协调
