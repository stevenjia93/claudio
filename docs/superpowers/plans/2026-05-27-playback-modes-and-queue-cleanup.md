# 播放模式 + 队列清理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Claudio 个人电台加三种播放模式 (顺序/随机/单曲循环) 以及两个队列批量清理按钮 (清空 / 换一批)。

**Architecture:** 播放模式存服务端 `state.json` 持久化, 但具体行为 (loop 原地重播 / shuffle 随机抽) 在前端 `audio.ended` handler 分支处理。「清空」复用 `PUT /api/queue { queue: [] }`; 「换一批」新加 `POST /api/queue/refresh`, 内部清队列 + 调 chat 流水线 (固定 prompt `换一批不一样的`)。WS 多设备同步模式状态。

**Tech Stack:** Node.js + Express + `ws` (后端) · 原生 JS PWA (前端) · JSON 文件持久化 (`state/state.json`)

**项目无自动化测试套件** (spec 第 9 节明确"沿用手测"), 每个任务结束以"启服务手测 + 提交"代替"跑测试套件"。

**Spec:** `docs/superpowers/specs/2026-05-27-playback-modes-and-queue-cleanup-design.md`

---

## 文件清单

- **修改** `server/state.js` — 加 playMode 字段 + setPlayMode export
- **修改** `server/server.js` — 加 PUT /api/mode 端点, 加 POST /api/queue/refresh, 抽 runChatTurn 内部函数, WS hello 加 playMode
- **修改** `pwa/index.html` — 加 #btn-mode 节点, 加 .queue-toolbar 节点
- **修改** `pwa/style.css` — 加 .queue-toolbar / .q-action / .ctrl 上的模式按钮样式 (主要复用现有 ctrl)
- **修改** `pwa/app.js` — 加 playMode 模块状态 + WS hello/mode_update 处理 + advanceByMode + 模式按钮 + 清空 + 换一批 + inflight 互斥

## 启动 / 手测环境

每个任务结束前都按下面流程手测:

```bash
# 1. 启服务
cd /Users/zejia/Claudes/claudio/server
node server.js
# 期望: 监听 8080, 输出 "Claudio @ http://localhost:8080"

# 2. 浏览器开 http://localhost:8080
# 3. 按任务的"手测"小节操作并确认行为
```

如果环境没配 Claude API key, 用 `MOCK_CLAUDE=1 node server.js` 启动 (server 已有 mock 路径, 见 server.js:108)。

---

## Task 1: 后端 `state.js` 加 playMode 字段

**Files:**
- Modify: `server/state.js`

- [ ] **Step 1: 在 DEFAULT_STATE 加 playMode 字段**

文件 `server/state.js`, 在 `DEFAULT_STATE` 对象 (现行 8-22 行) 的 `prefs: {}` 之前插入:

```js
playMode: 'sequential',   // 'sequential' | 'loop' | 'shuffle'
```

完整 `DEFAULT_STATE` 改后:

```js
const DEFAULT_STATE = {
  messages: [],
  plays: [],
  queue: [],
  nowPlaying: null,
  feedback: {
    liked: [],
    disliked: []
  },
  playsSinceDjBreak: 0,
  djBreakAt: 2,
  playMode: 'sequential',   // 'sequential' | 'loop' | 'shuffle'
  plan: null,
  prefs: {}
};
```

- [ ] **Step 2: 加 setPlayMode export**

在文件末尾 (现有 `addFeedback` 之后) 加:

```js
const VALID_PLAY_MODES = new Set(['sequential', 'loop', 'shuffle']);

export function setPlayMode(mode) {
  if (!VALID_PLAY_MODES.has(mode)) {
    throw new Error(`非法 playMode: ${mode}`);
  }
  state.playMode = mode;
  save();
}
```

- [ ] **Step 3: 手测 state 加载**

启服务 (`MOCK_CLAUDE=1 node server.js`), 期望:
- 服务正常启动, 没有报错
- 服务器一启动会触发 `state.load()`, 老 `state.json` 没 playMode 字段 → spread 自动补成 `'sequential'`

确认 `state/state.json` 在服务空跑几秒后被回写, 文件里出现 `"playMode": "sequential"` 这一行 (节流 200ms, 等一下):

```bash
sleep 1 && grep playMode /Users/zejia/Claudes/claudio/state/state.json
```

期望输出包含 `"playMode": "sequential"`。

如果没出现, 说明本次启动没触发 save() — 这可以接受 (老 state.json 字段不全, 但下次 setPlayMode/setQueue 等 save 时会带上)。

- [ ] **Step 4: Commit**

```bash
git add server/state.js
git commit -m "state: 加 playMode 字段 + setPlayMode export"
```

---

## Task 2: 后端 PUT /api/mode + WS 携带 playMode

**Files:**
- Modify: `server/server.js`

- [ ] **Step 1: WS hello 携带 playMode**

文件 `server/server.js`, 现行 35-42 行的 `wss.on('connection', ...)` 里, 把 `ws.send` 的 payload 加 `playMode`:

```js
wss.on('connection', ws => {
  clients.add(ws);
  const s = state.get();
  ws.send(JSON.stringify({
    type: 'hello',
    nowPlaying: s.nowPlaying,
    queue: s.queue,
    feedback: s.feedback || { liked: [], disliked: [] },
    playMode: s.playMode || 'sequential'
  }));
  ws.on('close', () => clients.delete(ws));
});
```

- [ ] **Step 2: 加 PUT /api/mode 端点**

在 `app.get('/api/sources', ...)` (现行 245-247) 之后插入:

```js
// ——— API: 播放模式 ———
app.put('/api/mode', (req, res) => {
  const { mode } = req.body || {};
  try {
    state.setPlayMode(mode);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  broadcast({ type: 'mode_update', playMode: mode });
  res.json({ ok: true, mode });
});
```

- [ ] **Step 3: 手测 PUT /api/mode**

启服务 (`MOCK_CLAUDE=1 node server.js`), 另开终端:

```bash
# 设置成 shuffle
curl -X PUT http://localhost:8080/api/mode \
  -H 'Content-Type: application/json' \
  -d '{"mode":"shuffle"}'
# 期望: {"ok":true,"mode":"shuffle"}

# 非法值
curl -X PUT http://localhost:8080/api/mode \
  -H 'Content-Type: application/json' \
  -d '{"mode":"banana"}'
# 期望: {"error":"非法 playMode: banana"} + HTTP 400

# 落库验证
sleep 1 && grep playMode /Users/zejia/Claudes/claudio/state/state.json
# 期望: "playMode": "shuffle",

# 改回 sequential 防止影响后续测试
curl -X PUT http://localhost:8080/api/mode \
  -H 'Content-Type: application/json' \
  -d '{"mode":"sequential"}'
```

打开浏览器到 http://localhost:8080, 浏览器开发者工具 → Network → WS → /stream, 看到第一条消息 (hello) 里有 `"playMode":"sequential"`。

- [ ] **Step 4: Commit**

```bash
git add server/server.js
git commit -m "server: PUT /api/mode + WS hello 携带 playMode"
```

---

## Task 3: 后端 POST /api/queue/refresh + 抽 runChatTurn

**Files:**
- Modify: `server/server.js`

- [ ] **Step 1: 把现有 chat 流水线抽成 runChatTurn 内部函数**

现行 `app.post('/api/chat', async (req, res) => {...})` (80-138 行) 把"3) 自然语言: 走 Claude 大脑"分支 (106-133 行) 的核心逻辑抽出来。

在 `resolvePlayList` 函数下方 (现行第 78 行之后) 加:

```js
// 走一次 Claude 流水线: 解析歌名 + TTS + 广播 + 返回 brain 结果
// 抽出来给 /api/chat 和 /api/queue/refresh 复用
async function runChatTurn(text) {
  state.appendMessage('user', text);
  const prompt = await assemble(text);
  const brain = MOCK_CLAUDE ? await claude.mockInvoke(prompt) : await claude.invoke(prompt);

  state.appendMessage('assistant', brain.say);

  const itemsP = resolvePlayList(brain.play);
  const audioP = brain.say
    ? tts.synthesize(brain.say).catch(e => {
        console.warn('[tts] 合成挂了:', e.message);
        return null;
      })
    : Promise.resolve(null);
  const [items, audioUrl] = await Promise.all([itemsP, audioP]);
  state.pushQueue(items);
  items.forEach(it => state.appendPlay({ ...it, source: 'claude' }));

  broadcast({
    type: 'dj_broadcast',
    say: brain.say,
    reason: brain.reason,
    segue: brain.segue,
    audio_url: audioUrl,
    queue: state.get().queue
  });

  return { kind: 'chat', ...brain, resolved: items, audio_url: audioUrl };
}
```

- [ ] **Step 2: 改 /api/chat 调用 runChatTurn**

替换 `app.post('/api/chat', ...)` 的整个函数 (现行 80-138 行) 为:

```js
app.post('/api/chat', async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text 必填' });

  const decision = route(text);

  try {
    // 1) 控制命令
    if (decision.kind === 'control') {
      state.appendMessage('user', text);
      broadcast({ type: 'control', cmd: decision.payload.cmd });
      state.appendMessage('assistant', `[${decision.payload.cmd}]`);
      return res.json({ kind: 'control', cmd: decision.payload.cmd });
    }

    // 2) 直连放歌
    if (decision.kind === 'play_direct') {
      state.appendMessage('user', text);
      const items = await resolvePlayList([decision.payload.query]);
      state.pushQueue(items);
      items.forEach(it => state.appendPlay({ ...it, source: 'direct' }));
      broadcast({ type: 'queue_update', queue: state.get().queue });
      state.appendMessage('assistant', `已加入队列: ${items.map(i => i.song).join(', ')}`);
      return res.json({ kind: 'play_direct', added: items });
    }

    // 3) 自然语言: 走 Claude 大脑
    const result = await runChatTurn(decision.payload.text);
    res.json(result);
  } catch (e) {
    console.error('[chat] 出错:', e);
    res.status(500).json({ error: e.message });
  }
});
```

注: `runChatTurn` 内部已经 `state.appendMessage('user', text)`, 所以 chat 分支的 user 消息记录由 runChatTurn 负责。control / play_direct 分支保留独立的 appendMessage 调用 (它们不走 runChatTurn)。

- [ ] **Step 3: 加 POST /api/queue/refresh**

在 PUT /api/mode 之后插入:

```js
// ——— API: 换一批 (清队列 + 让 Claude 重新推) ———
app.post('/api/queue/refresh', async (req, res) => {
  // 1) 先清队列, 广播让前端立即看到队列空
  state.setQueue([]);
  broadcast({ type: 'queue_update', queue: [] });

  // 2) 走一次 chat 流水线, 固定 prompt
  try {
    const result = await runChatTurn('换一批不一样的');
    res.json(result);
  } catch (e) {
    console.error('[refresh] 出错:', e);
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 4: 手测 chat 回归 + refresh**

启服务 (`MOCK_CLAUDE=1 node server.js`)。

浏览器 http://localhost:8080, 在输入框输入 `来一首发呆的`, 送出。

期望 (回归):
- chat 历史里出现你的消息和 claude 的回复
- 待播队列里出现新歌 (mock claude 返回的几首)
- DJ 开始说话, 第一首开始播

```bash
# 直接调 refresh
curl -X POST http://localhost:8080/api/queue/refresh
# 期望: 返回 { kind: 'chat', say, play, resolved, ... } JSON
```

浏览器观察:
- 队列先变空 (queue_update)
- 然后队列被新一批填充 (dj_broadcast)
- chat 历史多一行 `换一批不一样的` (user) 和 claude 回复 (assistant)

- [ ] **Step 5: Commit**

```bash
git add server/server.js
git commit -m "server: 抽 runChatTurn + 加 POST /api/queue/refresh"
```

---

## Task 4: 前端 HTML — 模式按钮 + 队列 toolbar

**Files:**
- Modify: `pwa/index.html`

- [ ] **Step 1: 在主控制栏插模式按钮**

文件 `pwa/index.html`, 找到 `<div class="controls">` 块 (现行 63-82 行), 在 `<button id="btn-next" ...>⏭</button>` 之后、`<button id="btn-like" ...>` 之前插入:

```html
<button id="btn-mode" class="ctrl" title="顺序播放">
  <span class="mode-icon" data-mode="sequential">→</span>
  <span class="mode-icon" data-mode="shuffle" hidden>⇄</span>
  <span class="mode-icon" data-mode="loop" hidden>↻</span>
</button>
```

- [ ] **Step 2: 加队列 toolbar**

找到 `card-list` 块 (现行 96-115 行), 在 `<div class="tabs" ...>...</div>` 之后、`<ul id="queue-list" ...>` 之前插入:

```html
<div class="queue-toolbar" data-tab="queue">
  <button class="q-action" id="btn-queue-clear" title="清空待播列表">清空</button>
  <button class="q-action" id="btn-queue-refresh" title="让 Claude 重新推一批">换一批</button>
</div>
```

- [ ] **Step 3: 手测 DOM 节点存在 + tab 切换**

刷新浏览器 http://localhost:8080, 打开 DevTools Console:

```js
document.getElementById('btn-mode')        // 期望: 非 null, HTMLButtonElement
document.getElementById('btn-queue-clear') // 期望: 非 null
document.getElementById('btn-queue-refresh')// 期望: 非 null
document.querySelector('.queue-toolbar')   // 期望: 非 null
```

视觉上:
- 主控制栏 (▶ ⏭ … ♥ ✕) 现在多了一个按钮 (→ 单字符), 位置在 ⏭ 后、♥ 前
- 队列 tab 顶上 (tabs 行之下) 出现两个按钮 [清空] [换一批]
- 点 tabs 切到「已播」, queue-toolbar **目前还会一直显示** — 这正常, 因为现有 tab 切换 JS 只控制 `.tab-pane` 的 hidden, 还没处理 toolbar。下个任务在 JS 里加 toolbar 显隐, 这里只看节点存在性。

按钮点了暂时无反应 (handler 还没接), 这正常。

- [ ] **Step 4: Commit**

```bash
git add pwa/index.html
git commit -m "html: 加 #btn-mode 模式按钮 + 队列 toolbar (清空/换一批)"
```

---

## Task 5: 前端 CSS — toolbar / 模式按钮样式

**Files:**
- Modify: `pwa/style.css`

- [ ] **Step 1: 加 queue-toolbar 和 q-action 样式**

文件末尾 (`.ctrl-send:disabled` 之后, 或文件最末尾) 追加:

```css
/* ============================================
   队列 toolbar (清空 / 换一批)
   ============================================ */
.queue-toolbar {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
}
.q-action {
  flex: 1;
  background: transparent;
  border: 1px solid var(--border);
  color: var(--ink-dim);
  font-family: var(--font-zh);
  font-size: 12px;
  padding: 6px 10px;
  border-radius: 8px;
  cursor: pointer;
  transition: color 0.18s, border-color 0.18s, background 0.18s;
}
.q-action:hover:not(:disabled) {
  color: var(--ink);
  border-color: var(--border-hi);
  background: rgba(255,255,255,0.03);
}
.q-action:active:not(:disabled) { transform: translateY(1px); }
.q-action:disabled { opacity: 0.4; cursor: not-allowed; }

/* ============================================
   模式按钮 (顺序 / 随机 / 单曲循环)
   ============================================ */
#btn-mode {
  font-family: var(--font-mono);
  font-size: 16px;
  line-height: 1;
}
#btn-mode .mode-icon { display: inline-block; }
#btn-mode.active {
  color: var(--teal);
  border-color: var(--teal-dim);
}
```

注: `#btn-mode` 已经继承 `.ctrl` 的大部分样式 (现行 579-613), 这里只加模式特定的微调; `.active` class 给非默认模式 (shuffle/loop) 一点视觉强调 (青色, 跟现有 ws-pill live 风格呼应)。

- [ ] **Step 2: 手测视觉**

刷新浏览器:
- 队列 toolbar 的两个按钮看起来跟现有 .ctrl 风格一致, 平时灰一点, hover 变亮
- 模式按钮跟 ▶ ⏭ 风格一致
- (模式还没接 JS, 还看不到 active 态切换, 下个任务做)

- [ ] **Step 3: Commit**

```bash
git add pwa/style.css
git commit -m "css: 加 queue-toolbar + #btn-mode 样式"
```

---

## Task 6: 前端 app.js — playMode 状态 + WS 处理 + 模式按钮

**Files:**
- Modify: `pwa/app.js`

- [ ] **Step 1: 加模块状态 + 节点引用**

文件 `pwa/app.js` 顶部 (现行 38-43 行, `let currentQueue = []` 那一组), 加:

```js
let playMode = 'sequential';
```

同样在顶部 DOM 引用区 (现行 9-36 行), 加:

```js
const btnMode = $('btn-mode');
const btnQueueClear = $('btn-queue-clear');
const btnQueueRefresh = $('btn-queue-refresh');
```

- [ ] **Step 2: 加 reflectPlayModeUI 函数**

在 `reflectFeedbackButtons` 函数附近 (现行 241-246 行后面) 加:

```js
function reflectPlayModeUI() {
  if (!btnMode) return;
  btnMode.querySelectorAll('.mode-icon').forEach(el => {
    el.hidden = el.dataset.mode !== playMode;
  });
  const titles = {
    sequential: '顺序播放',
    shuffle: '随机播放',
    loop: '单曲循环'
  };
  btnMode.title = titles[playMode] || '播放模式';
  btnMode.classList.toggle('active', playMode !== 'sequential');
}
```

- [ ] **Step 3: WS hello / mode_update 处理**

修改 `handleWs(msg)` (现行 63-103 行) 的 `case 'hello'` 分支, 在 feedback 处理之后加 playMode 处理:

```js
case 'hello':
  if (msg.feedback) feedback = msg.feedback;
  if (likedCount) likedCount.textContent = String((feedback.liked || []).length);
  playMode = msg.playMode || 'sequential';
  reflectPlayModeUI();
  renderQueue(msg.queue || []);
  if (msg.nowPlaying) renderNowPlaying(msg.nowPlaying);
  refreshHistory();
  break;
```

在 `case 'feedback':` 分支后面加一个新 case:

```js
case 'mode_update':
  playMode = msg.playMode || 'sequential';
  reflectPlayModeUI();
  break;
```

- [ ] **Step 4: 模式按钮点击**

在文件靠下的事件绑定区 (任选一个位置, 比如 `btnDislike.addEventListener` 之后, 现行 222-230 行附近) 加:

```js
btnMode.addEventListener('click', async () => {
  const order = ['sequential', 'shuffle', 'loop'];
  const next = order[(order.indexOf(playMode) + 1) % order.length];
  try {
    await fetch('/api/mode', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: next })
    });
    // 不在这里翻 UI, 等 WS mode_update 回来再翻
  } catch (e) {
    appendChat('assistant', `切模式失败: ${e.message}`);
  }
});
```

- [ ] **Step 5: 处理 toolbar 在非「待播」tab 时隐藏**

修改 `bindTabs` 函数 (现行 534-547 行) 让 toolbar 跟着 tab 切换显隐:

```js
(function bindTabs() {
  const tabs = document.querySelectorAll('.tabs .tab');
  const toolbar = document.querySelector('.queue-toolbar');
  tabs.forEach(t => {
    t.addEventListener('click', () => {
      const target = t.dataset.tab;
      tabs.forEach(x => x.classList.toggle('tab-active', x === t));
      document.querySelectorAll('.tab-pane').forEach(p => {
        p.hidden = p.dataset.tab !== target;
      });
      if (toolbar) toolbar.hidden = target !== 'queue';
      if (target === 'liked') renderLiked();
      if (target === 'history') refreshHistory();
    });
  });
})();
```

- [ ] **Step 6: 手测模式按钮**

启服务, 浏览器刷新 http://localhost:8080:

- 模式按钮初始显示 `→` (顺序), title 是「顺序播放」, 无 active 高亮
- 点一下 → 变 `⇄` (随机), title 「随机播放」, 有 teal 高亮 (active 态)
- 再点一下 → 变 `↻` (单曲循环), title 「单曲循环」
- 再点 → 回到 `→`
- 浏览器刷新 → 模式保留 (因为是 WS hello 拿的服务端状态)
- 切到「已播」tab → queue toolbar (清空/换一批) 消失
- 切回「待播」 → toolbar 出现

如果你打开两个浏览器窗口 (或电脑 + 手机同 WiFi), 一边点模式按钮 → 另一边按钮跟着翻, 这是 mode_update 广播生效。

- [ ] **Step 7: Commit**

```bash
git add pwa/app.js
git commit -m "app.js: playMode 状态 + WS hello/mode_update 处理 + 模式按钮"
```

---

## Task 7: 前端 app.js — advanceByMode + audio.ended/error/btnNext

**Files:**
- Modify: `pwa/app.js`

- [ ] **Step 1: 抽 jumpToQueueIndex 函数**

把现有"双击队列项立即播"的 inline 逻辑 (现行 470-481 行 `li.addEventListener('dblclick', ...)`) 抽成共享函数。

在 `playNext` 函数附近 (现行 281-300 行后面) 加:

```js
// 跳到队列里某个位置的歌, 立即播 (复用 POST /api/queue/play/:idx)
// 双击队列项和 shuffle 模式都走这里
async function jumpToQueueIndex(idx) {
  try {
    const r = await fetch(`/api/queue/play/${idx}`, { method: 'POST' });
    const np = await r.json();
    if (np?.url) {
      audio.src = np.url;
      await audio.play().catch(() => {});
    }
  } catch (e) {
    console.warn('[jump]', e.message);
  }
}
```

修改 `bindQueueItem` 里的双击 handler (现行 470-481 行), 把内联 fetch 换成调用:

```js
// 双击 → 插队立即播
li.addEventListener('dblclick', (e) => {
  e.preventDefault();
  autoPlayArmed = true;
  jumpToQueueIndex(idx);
});
```

- [ ] **Step 2: 加 advanceByMode**

在 `jumpToQueueIndex` 之后加:

```js
// 按当前播放模式推进一首
// userInitiated=true 时跳过 loop 分支 (手动 ⏭ 永远跳下一首)
function advanceByMode({ userInitiated = false } = {}) {
  if (playMode === 'loop' && !userInitiated) {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  if (playMode === 'shuffle' && currentQueue.length > 0) {
    const idx = Math.floor(Math.random() * currentQueue.length);
    return jumpToQueueIndex(idx);
  }
  playNext();
}
```

- [ ] **Step 3: audio.ended / audio.error 改用 advanceByMode**

修改 `audio.addEventListener('ended', () => playNext())` (现行 256 行) 为:

```js
audio.addEventListener('ended', () => advanceByMode());
```

修改 `audio.addEventListener('error', ...)` (现行 260-267 行), 把里面的 `playNext()` 替换成 `advanceByMode()`:

```js
audio.addEventListener('error', () => {
  if (!audio.currentSrc) return;
  const now = Date.now();
  if (now - lastAudioError < 1500) return;
  lastAudioError = now;
  console.warn('[music] 歌加载失败,跳下一首');
  advanceByMode();
});
```

- [ ] **Step 4: btnNext 改用 advanceByMode userInitiated**

修改 `btnNext.addEventListener('click', ...)` (现行 194-197 行) 为:

```js
btnNext.addEventListener('click', () => {
  autoPlayArmed = true;
  advanceByMode({ userInitiated: true });
});
```

- [ ] **Step 5: 手测三种模式**

启服务, 浏览器 http://localhost:8080:

**模式 = 顺序** (默认):
- 输入 `来 5 首发呆的` (或任何会让 mock claude 推 ≥ 5 首的指令)
- 等队列里有歌, 第一首开始播
- 拖进度条到歌尾让它"播完", 或在 console 跑 `audio.currentTime = audio.duration - 0.5`
- 期望: 自动切到队列的下一首 (跟现状一致)

**模式 = 随机**:
- 点模式按钮切到 `⇄`
- 等下一首播完 (再拖进度条到尾)
- 期望: 切到的不一定是队列里第 1 首; 反复几次能切到不同位置

**模式 = 单曲循环**:
- 点模式按钮切到 `↻`
- 拖进度条到尾
- 期望: 当前这首歌从头开始重新播
- 现在点 ⏭ (手动下一首)
- 期望: 跳到下一首 (不是原地重播), 新歌播完继续循环新歌

**双击队列重听 (回归)**:
- 模式回到 `→`
- 双击队列里某首
- 期望: 立即播那首 (现状, jumpToQueueIndex 抽出来后行为不变)

- [ ] **Step 6: Commit**

```bash
git add pwa/app.js
git commit -m "app.js: advanceByMode + 各模式分支 (ended/error/⏭)"
```

---

## Task 8: 前端 app.js — 清空 + 换一批 + inflight 互斥

**Files:**
- Modify: `pwa/app.js`

- [ ] **Step 1: inflight 标记 + 反映到按钮 disabled**

在文件靠近顶部状态那一组 (现行 38-43 行) 加:

```js
let chatInflight = false;
```

加个 helper, 放在 `reflectPlayModeUI` 附近:

```js
function reflectInflight() {
  btnSend.disabled = chatInflight;
  if (btnQueueRefresh) btnQueueRefresh.disabled = chatInflight;
}
```

修改 `chatForm` 的 submit handler (现行 110-152 行), 把 `btnSend.disabled = true/false` 换成 `chatInflight = true/false` + `reflectInflight()`:

把 `btnSend.disabled = true;` (现行 118 行) 替换成:

```js
chatInflight = true;
reflectInflight();
```

把 `} finally { btnSend.disabled = false; chatInput.focus(); }` (现行 148-151 行) 替换成:

```js
} finally {
  chatInflight = false;
  reflectInflight();
  chatInput.focus();
}
```

- [ ] **Step 2: 「清空」按钮**

加事件绑定 (放在 btnMode handler 附近):

```js
btnQueueClear.addEventListener('click', async () => {
  if (currentQueue.length === 0) return;
  try {
    await fetch('/api/queue', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queue: [] })
    });
    // 服务端广播 queue_update, 现有路径处理 UI
  } catch (e) {
    appendChat('assistant', `清空失败: ${e.message}`);
  }
});
```

- [ ] **Step 3: 「换一批」按钮**

加事件绑定:

```js
btnQueueRefresh.addEventListener('click', async () => {
  if (chatInflight) return;
  autoPlayArmed = true;
  appendChat('user', '换一批不一样的');
  chatInflight = true;
  reflectInflight();
  try {
    const r = await fetch('/api/queue/refresh', { method: 'POST' });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`HTTP ${r.status}: ${t.slice(0, 120)}`);
    }
    const data = await r.json();
    if (data.kind === 'chat') {
      appendChat('assistant', data.say, data.reason);
    }
  } catch (e) {
    appendChat('assistant', `换一批失败: ${e.message}`);
  } finally {
    chatInflight = false;
    reflectInflight();
  }
});
```

- [ ] **Step 4: 「清空」按钮在空队列时禁用**

修改 `renderQueue` 函数 (现行 432-454 行) 末尾加:

```js
function renderQueue(queue) {
  currentQueue = queue || [];
  queueCount.textContent = String(currentQueue.length);
  queueList.innerHTML = '';
  if (currentQueue.length === 0) {
    queueList.innerHTML = '<li class="queue-empty">队列是空的</li>';
  } else {
    currentQueue.forEach((item, i) => {
      const li = document.createElement('li');
      li.draggable = true;
      li.dataset.idx = String(i);
      li.innerHTML = `
        <span class="q-grip" title="拖动重排">⋮⋮</span>
        <span class="idx">${i + 1}.</span>
        <span class="song">${escapeHtml(item.song)}</span>
        <span class="artist">${escapeHtml(item.artist)}</span>
        <button class="q-remove" title="从队列移除">✕</button>
      `;
      bindQueueItem(li, i);
      queueList.appendChild(li);
    });
  }
  if (btnQueueClear) btnQueueClear.disabled = currentQueue.length === 0;
}
```

(把原来的 `if (...) { ...; return; }` 改成 if/else, 让 disabled 那一行无论队列空否都跑。)

- [ ] **Step 5: 初始 disabled 设置**

文件中部 (DOM 引用拿到之后的初始化区域), 加一行让"清空"按钮初始就根据当前 queue 状态正确显示:

把 `connectWs();` (现行 105 行) 这一行替换成:

```js
if (btnQueueClear) btnQueueClear.disabled = true; // 初始空, WS hello 回来 renderQueue 会重算
connectWs();
```

- [ ] **Step 6: 手测清空 / 换一批 / 互斥**

启服务 (`MOCK_CLAUDE=1 node server.js`), 浏览器:

**清空**:
- 让队列有几首歌 (输入 `来几首发呆的`)
- 点「清空」 → 待播列表清光, 当前歌继续播
- 现在「清空」按钮变灰不可点
- queueCount 变 0

**换一批**:
- 让队列有几首歌
- 点「换一批」 → 队列瞬间清掉 + chat 历史多一行「换一批不一样的」(user) + 一两秒后队列被新一批填进来 + chat 多一行 claude 回复
- 当前正在播的歌不被打断

**空队列时换一批**:
- 把队列清光
- 点「换一批」 → 仍可点 → 推一批新歌进来

**互斥**:
- 点「换一批」, 立即在 chat 输入框打字按 cmd+enter (或点送出)
- 期望: 「送出」按钮在换一批飞行期间是 disabled 的; 反过来也成立 (chat 飞行期间, 「换一批」也 disabled)
- 检查: 换一批飞行中点「换一批」 → 第二次点没反应 (`if (chatInflight) return`)

**失败路径**:
- 临时杀掉 server (Ctrl+C)
- 点「清空」或「换一批」 → chat 历史出现红字"失败: …"
- 重启 server

- [ ] **Step 7: Commit**

```bash
git add pwa/app.js
git commit -m "app.js: 清空 + 换一批 按钮 + inflight 互斥"
```

---

## Task 9: 走完手测清单 + 收尾

**Files:** (无新改动, 走 spec 末尾的手测清单)

- [ ] **Step 1: 逐项走完 spec 手测清单**

打开 `docs/superpowers/specs/2026-05-27-playback-modes-and-queue-cleanup-design.md`, 找到「手测清单」一节, 每条都过一遍, 勾选 / 记录问题:

```
[ ] 顺序模式 → 一首播完自动切下一首
[ ] 切随机 → 当前歌播完应切到队列里随机一首
[ ] 切单曲循环 → 当前歌播完原地重播
[ ] 单曲循环下点 ⏭ → 跳到下一首, 新歌播完继续循环
[ ] 切到随机, 点 ⏭ → 跳到随机一首 (而非顺序下一首)
[ ] 重启服务器 → 模式仍是上次设置的
[ ] 同时打开电脑 + 手机, 一端切模式 → 另一端按钮跟着翻
[ ] 队列有歌 → 点「清空」 → 队列变空, 当前歌继续播
[ ] 队列空 → 「清空」按钮变灰不可点
[ ] 队列有歌 → 点「换一批」 → 队列清掉 + 立即出现新一批 + chat 历史多一行
[ ] 队列空 → 点「换一批」 → 可点, 推一批新歌进来
[ ] 换一批请求飞行时, 「换一批」和「送出」 按钮都禁用
[ ] 模拟 claude.invoke 抛错 (临时改 prompts) → chat 显示错误, 队列空着 (不崩)
```

模拟 claude.invoke 抛错的简单做法:
```bash
# 临时改 server/claude.js 让 invoke 抛错, 或:
# 不设 ANTHROPIC_API_KEY 且不用 MOCK_CLAUDE 启动 → invoke 会抛
node server.js
# 然后点「换一批」 → chat 应显示错误
```

测完恢复正常启动。

- [ ] **Step 2: 修发现的 bug**

如果手测发现问题, 针对性修一下, 提交格式:

```bash
git add <修过的文件>
git commit -m "fix: <问题描述>"
```

如果一切正常, 跳过此步。

- [ ] **Step 3: README 更新 (可选, 看是否需要)**

`README.md` 已有"队列管理"小节, 看一眼是否需要补充模式 / 清空 / 换一批 的说明。如果只是小一节, 可以加几行:

```bash
grep -n "队列" README.md
```

如果你想加, 在合适位置插入说明; 这是 nice-to-have, 不影响功能。如果不加, 跳过。

- [ ] **Step 4: 终结 commit (如果有 README 改动)**

```bash
git add README.md
git commit -m "docs: README 加播放模式 + 清空/换一批 说明"
```

---

## 完成检查

- [ ] 所有任务勾完
- [ ] `git log --oneline` 看一下提交链路清晰
- [ ] `git status` 干净
- [ ] 手测清单全过
