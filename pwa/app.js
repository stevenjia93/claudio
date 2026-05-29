// ============================================
// app.js — Claudio PWA 前端逻辑
// 包括: 播放器 / 歌词同步 / 可拖动进度 / 鼠标动效
// ============================================

const $ = (id) => document.getElementById(id);
const audio = $('audio');
const djAudio = new Audio();
djAudio.preload = 'auto';

const songName = $('song-name');
const songArtist = $('song-artist');
const cover = $('cover');
const progressBar = $('progress-bar');
const progressFill = $('progress-fill');
const progressThumb = $('progress-thumb');
const tCurrent = $('t-current');
const tTotal = $('t-total');
const queueList = $('queue-list');
const queueCount = $('queue-count');
const historyList = $('history-list');
const historyCount = $('history-count');
const likedList = $('liked-list');
const likedCount = $('liked-count');
const chatForm = $('chat-form');
const chatInput = $('chat-input');
const chatHistory = $('chat-history');
const btnSend = $('btn-send');
const btnPlay = $('btn-play');
const btnNext = $('btn-next');
const btnLike = $('btn-like');
const btnDislike = $('btn-dislike');
const btnMode = $('btn-mode');
const btnQueueClear = $('btn-queue-clear');
const btnQueueRefresh = $('btn-queue-refresh');
const btnTabsMore = $('btn-tabs-more');
const btnDjLang = $('btn-dj-lang');
const dislikedOverlay = $('disliked-overlay');
const dislikedList = $('disliked-list');
const dislikedCount = $('disliked-count');
const btnDislikedClose = $('btn-disliked-close');
const undoToast = $('undo-toast');
const undoToastText = $('undo-toast-text');
const undoToastBtn = $('undo-toast-btn');
const wsPill = $('ws-pill');
const brandName = $('brand-name');
const djCardOverlay = $('dj-card-overlay');
const djCardClose = $('dj-card-close');
const djCardTagline = $('dj-card-tagline');
const djCardIntro = $('dj-card-intro');
const djCardListener = $('dj-card-listener');
const djCardOnair = $('dj-card-onair');
const djCardGenres = $('dj-card-genres');
const djCardAvatarImg = $('dj-card-avatar-img');
const djCardListening = $('dj-card-listening');
const djCardShortList = $('dj-card-short-list');
const djCardLongList = $('dj-card-long-list');
const cardNow = document.querySelector('.card-now');
const cardLyrics = $('card-lyrics');
const lyricsTrack = $('lyrics-track');

let currentQueue = [];
let currentSong = null;
let autoPlayArmed = false;
let lyrics = [];          // [{t: seconds, text: string}]
let currentLyricIndex = -1;
let feedback = { liked: [], disliked: [] };
let playMode = 'sequential';
let djLanguage = 'en';   // 'en' | 'zh' — DJ 说话用哪种, 跟服务器 state 同步
let chatInflight = false;
// chat 后队列异步填充时用: dj_broadcast 来时队列还空, 标记一下;
// queue_update 一到, 强切到新歌 (即使当前歌还在放)
let pendingAutoStart = false;

// ============================================
// 1. WebSocket
// ============================================
let ws;
function connectWs() {
  // HTTPS 页面 → wss; HTTP → ws. Cloudflare Tunnel 等 HTTPS 反代时必须切.
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${wsProto}//${location.host}/stream`);
  ws.onopen = () => {
    wsPill.textContent = '● ws';
    wsPill.classList.add('live');
  };
  ws.onclose = () => {
    wsPill.textContent = '○ ws';
    wsPill.classList.remove('live');
    setTimeout(connectWs, 3000);
  };
  ws.onmessage = (evt) => handleWs(JSON.parse(evt.data));
}

function handleWs(msg) {
  switch (msg.type) {
    case 'hello':
      if (msg.feedback) feedback = msg.feedback;
      if (likedCount) likedCount.textContent = String((feedback.liked || []).length);
      if (dislikedCount) dislikedCount.textContent = String((feedback.disliked || []).length);
      playMode = msg.playMode || 'sequential';
      reflectPlayModeUI();
      djLanguage = msg.djLanguage || 'en';
      reflectDjLanguageUI();
      renderQueue(msg.queue || []);
      if (msg.nowPlaying) renderNowPlaying(msg.nowPlaying);
      refreshHistory();
      break;
    case 'queue_update':
      renderQueue(msg.queue);
      // chat 刚发完 dj_broadcast 时队列还空, 现在歌后台解析好了 → 强切到第一首新歌
      // (即使当前歌还在播也打断, 因为用户已经表态"换一批")
      if (pendingAutoStart && currentQueue.length > 0) {
        pendingAutoStart = false;
        playNext();
      } else {
        maybeStartPlayback();
      }
      break;
    case 'now_playing':
      renderQueue(msg.queue);
      renderNowPlaying(msg.nowPlaying);
      refreshHistory();             // 切歌后刷一下"已播"
      break;
    case 'dj_broadcast':
      // DJ 文本只在右侧 chat 历史里渲染 (chat 提交那条 fetch 已经 appendChat 过了),
      // 不再单独的 DJ 卡。这里只刷队列 + 启声音。
      renderQueue(msg.queue);
      speakThenPlay(msg.say, msg.audio_url);
      break;
    case 'dj_intro':
      // 间奏报幕: 不切歌, 只 duck 当前 audio + 播 DJ + 完了渐回
      appendChat('assistant', msg.say, '间奏');
      speakIntro(msg.say, msg.audio_url);
      break;
    case 'control':
      applyControl(msg.cmd);
      break;
    case 'feedback':
      feedback = msg.feedback || feedback;
      reflectFeedbackButtons();
      if (likedCount) likedCount.textContent = String((feedback.liked || []).length);
      if (dislikedCount) dislikedCount.textContent = String((feedback.disliked || []).length);
      // 如果"喜欢"tab 当前是激活的, 重新渲染
      if (!document.querySelector('[data-tab="liked"]').hidden) renderLiked();
      // 讨厌 overlay 开着也重渲染 (用户在面板里点 ✕ 后会经此路径刷新)
      if (dislikedOverlay && !dislikedOverlay.hidden) renderDisliked();
      break;
    case 'mode_update':
      playMode = msg.playMode || 'sequential';
      reflectPlayModeUI();
      break;
    case 'dj_language_update':
      djLanguage = msg.djLanguage || 'en';
      reflectDjLanguageUI();
      break;
  }
}

if (btnQueueClear) btnQueueClear.disabled = true; // 初始空, WS hello 回来 renderQueue 会重算
connectWs();

// ============================================
// 2. 聊天
// ============================================
chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;

  autoPlayArmed = true;
  appendChat('user', text);
  chatInput.value = '';
  chatInflight = true;
  reflectInflight();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`HTTP ${res.status}: ${t.slice(0, 120)}`);
    }
    const data = await res.json();

    if (data.kind === 'chat') {
      appendChat('assistant', data.say, data.reason);
      // 注: HTTP 现在早 return (歌后台解析), data.resolved 永远是空, 不再用它判 0-songs warning
    } else if (data.kind === 'play_direct') {
      const names = (data.added || []).map(s => `${s.song} - ${s.artist}`).join(', ');
      appendChat('assistant', `已排好: ${names || '(没找到能播的)'}`);
    } else if (data.kind === 'control') {
      appendChat('assistant', `[${data.cmd}]`);
    }
  } catch (err) {
    appendChat('assistant', `出错了: ${err.message}`);
  } finally {
    chatInflight = false;
    reflectInflight();
    chatInput.focus();
  }
});

function appendChat(role, content, meta) {
  const li = document.createElement('li');
  li.className = role;
  const label = role === 'user' ? '我' : 'claudio';
  li.innerHTML = `<span class="meta">${label}</span>${escapeHtml(content)}`;
  if (meta) {
    const r = document.createElement('span');
    r.className = 'meta';
    r.style.marginTop = '4px';
    r.textContent = `// ${meta}`;
    li.appendChild(r);
  }
  chatHistory.appendChild(li);
  chatHistory.scrollTop = chatHistory.scrollHeight;
}

// ============================================
// 3. 歌曲音频
// ============================================
btnPlay.addEventListener('click', () => {
  autoPlayArmed = true;
  if (!audio.paused) {
    audio.pause();
    return;
  }
  // 已有 src,直接续播
  if (audio.src) {
    audio.play().catch(err => console.warn('play 被挡:', err.message));
    return;
  }
  // 没 src 但 nowPlaying 还在 — 重新装 src 重播,不要去 /api/next 把当前歌弄丢
  if (currentSong?.url) {
    audio.src = proxiedAudioUrl(currentSong.url);
    audio.play().catch(err => console.warn('play 被挡:', err.message));
    return;
  }
  // 真的什么都没有,才去队列要下一首
  playNext();
});

btnNext.addEventListener('click', () => {
  autoPlayArmed = true;
  advanceByMode({ userInitiated: true });
});

// like / dislike — 当前播放的歌
// songOverride 用于撤回 toast / disliked 面板 (那时 currentSong 可能已经切走)
async function sendFeedback(action, songOverride) {
  const song = songOverride || (currentSong?.song ? {
    song: currentSong.song,
    artist: currentSong.artist,
    source: currentSong.source || ''
  } : null);
  if (!song) return;
  await fetch('/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, song })
  }).catch(e => console.warn('[feedback]', e.message));
}

// 点 ♡ 标记 like; 再点变 ♥ → 再点取消
btnLike.addEventListener('click', () => {
  const st = feedbackStateForCurrent();
  sendFeedback(st === 'like' ? 'clear' : 'like');
});

// 点 💔: 标记 dislike + 自动切下一首; 已 dislike 状态再点取消
btnDislike.addEventListener('click', () => {
  const st = feedbackStateForCurrent();
  if (st === 'dislike') {
    sendFeedback('clear');
  } else {
    // 拍快照: 下一行 playNext 会替换 currentSong, 不快照 toast 撤回时拿不到对的歌
    const snapshot = {
      song: currentSong.song,
      artist: currentSong.artist,
      source: currentSong.source || ''
    };
    sendFeedback('dislike');
    showUndoToast(snapshot);
    autoPlayArmed = true;
    playNext();
  }
});

btnMode.addEventListener('click', async () => {
  const order = ['sequential', 'shuffle', 'loop'];
  const next = order[(order.indexOf(playMode) + 1) % order.length];
  try {
    const r = await fetch('/api/mode', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: next })
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`HTTP ${r.status}: ${t.slice(0, 120)}`);
    }
    // 不在这里翻 UI, 等 WS mode_update 回来再翻
  } catch (e) {
    appendChat('assistant', `切模式失败: ${e.message}`);
  }
});

if (btnDjLang) btnDjLang.addEventListener('click', async () => {
  const next = djLanguage === 'zh' ? 'en' : 'zh';
  try {
    const r = await fetch('/api/dj-language', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: next })
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`HTTP ${r.status}: ${t.slice(0, 120)}`);
    }
    // 不在这里翻 UI, 等 WS dj_language_update 回来再翻 (服务端是单一真相源)
  } catch (e) {
    appendChat('assistant', `切 DJ 语种失败: ${e.message}`);
  }
});

btnQueueClear.addEventListener('click', async () => {
  if (currentQueue.length === 0) return;
  try {
    const r = await fetch('/api/queue', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queue: [] })
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`HTTP ${r.status}: ${t.slice(0, 120)}`);
    }
    // 服务端广播 queue_update, 现有路径处理 UI
  } catch (e) {
    appendChat('assistant', `清空失败: ${e.message}`);
  }
});

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

// 当前歌在 feedback 里的状态 (♥ / ✕ / 无)
function feedbackStateForCurrent() {
  if (!currentSong?.song) return null;
  const sig = `${(currentSong.song || '').toLowerCase()}|${(currentSong.artist || '').toLowerCase()}`;
  if (feedback.liked?.some(f => `${(f.song || '').toLowerCase()}|${(f.artist || '').toLowerCase()}` === sig)) return 'like';
  if (feedback.disliked?.some(f => `${(f.song || '').toLowerCase()}|${(f.artist || '').toLowerCase()}` === sig)) return 'dislike';
  return null;
}

function reflectFeedbackButtons() {
  const st = feedbackStateForCurrent();
  btnLike.classList.toggle('active', st === 'like');
  btnDislike.classList.toggle('active', st === 'dislike');
  // SVG 心 — active 时 .heart-fill 显示, css 里控制
}

function reflectPlayModeUI() {
  if (!btnMode) return;
  btnMode.querySelectorAll('.mode-icon').forEach(el => {
    // SVG 元素没有 hidden IDL 属性, 必须显式 toggleAttribute
    el.toggleAttribute('hidden', el.dataset.mode !== playMode);
  });
  const titles = {
    sequential: '顺序播放',
    shuffle: '随机播放',
    loop: '单曲循环'
  };
  const label = titles[playMode] || '播放模式';
  btnMode.title = label;
  btnMode.setAttribute('aria-label', label);
  btnMode.classList.toggle('active', playMode !== 'sequential');
}

function reflectDjLanguageUI() {
  if (!btnDjLang) return;
  btnDjLang.textContent = djLanguage === 'zh' ? '🎙 中' : '🎙 EN';
  btnDjLang.title = djLanguage === 'zh' ? 'DJ 中文 (点切英文)' : 'DJ 英文 (点切中文)';
}

function reflectInflight() {
  btnSend.disabled = chatInflight;
  if (btnQueueRefresh) btnQueueRefresh.disabled = chatInflight;
}

// ============================================
//  Dislike 撤回: 5s toast + 隐藏管理面板
// ============================================
let undoToastTimer = null;
function showUndoToast(songSnapshot) {
  if (!undoToast || !songSnapshot) return;
  undoToastText.textContent = `已不喜欢: ${songSnapshot.song} - ${songSnapshot.artist}`;
  undoToastBtn.onclick = () => {
    sendFeedback('clear', songSnapshot);
    hideUndoToast();
  };
  undoToast.classList.remove('fading');
  undoToast.hidden = false;
  clearTimeout(undoToastTimer);
  undoToastTimer = setTimeout(() => {
    undoToast.classList.add('fading');
    setTimeout(hideUndoToast, 500);
  }, 5000);
}
function hideUndoToast() {
  if (!undoToast) return;
  undoToast.hidden = true;
  undoToast.classList.remove('fading');
  clearTimeout(undoToastTimer);
}

function renderDisliked() {
  if (!dislikedList || !dislikedCount) return;
  const items = (feedback.disliked || []).slice().reverse();
  dislikedCount.textContent = String(items.length);
  dislikedList.innerHTML = '';
  if (!items.length) {
    dislikedList.innerHTML = '<li class="disliked-empty">还没标过讨厌的</li>';
    return;
  }
  for (const p of items) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="d-song">${escapeHtml(p.song || '')}</span>
      <span class="d-artist">${escapeHtml(p.artist || '')}</span>
      <button class="d-clear" title="从讨厌清单移除, Claude 重新可推">✕</button>
    `;
    li.querySelector('.d-clear').addEventListener('click', () => {
      sendFeedback('clear', { song: p.song, artist: p.artist, source: p.source || '' });
      // 不立刻 re-render — 等 WS feedback 广播回来再刷, 状态唯一来源
    });
    dislikedList.appendChild(li);
  }
}

function openDislikedOverlay() {
  if (!dislikedOverlay) return;
  renderDisliked();
  dislikedOverlay.hidden = false;
}
function closeDislikedOverlay() {
  if (dislikedOverlay) dislikedOverlay.hidden = true;
}

if (btnTabsMore) btnTabsMore.addEventListener('click', openDislikedOverlay);
if (btnDislikedClose) btnDislikedClose.addEventListener('click', closeDislikedOverlay);
// 点遮罩 (面板外) 也关
if (dislikedOverlay) {
  dislikedOverlay.addEventListener('click', (e) => {
    if (e.target === dislikedOverlay) closeDislikedOverlay();
  });
}

// ============================================
//  DJ profile 浮层 — 点顶部 "Claudio" 字打开
// ============================================
async function openDjCard() {
  if (!djCardOverlay) return;
  // 先展示, 数据并行拉
  djCardOverlay.hidden = false;
  try {
    const r = await fetch('/api/dj-card');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (djCardTagline) djCardTagline.textContent = d.tagline || '—';
    if (djCardOnair)   djCardOnair.textContent = d.onAir || '24/7';
    if (djCardListener) djCardListener.textContent = String(d.listeners ?? '?');
    // description: 每行一个 div, 英文行 italic 处理 (粗略检测全拉丁字符)
    if (djCardIntro) {
      djCardIntro.innerHTML = '';
      for (const line of (d.description || [])) {
        const div = document.createElement('div');
        const isEn = /^[\sA-Za-z0-9.,!?'"\-:;()&🎧🎙️]+$/.test(line);
        if (isEn) div.classList.add('en');
        div.textContent = line;
        djCardIntro.appendChild(div);
      }
    }
    // 最近沉迷 / 长期挚爱 — Spotify 数据子集. 两个都空就整个 hidden
    function fillList(ul, items) {
      if (!ul) return;
      ul.innerHTML = '';
      if (items.length === 0) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = '(数据少, 还在攒)';
        ul.appendChild(li);
        return;
      }
      for (const name of items) {
        const li = document.createElement('li');
        li.textContent = name;
        ul.appendChild(li);
      }
    }
    const shortItems = d.topShort || [];
    const longItems = d.topLong || [];
    fillList(djCardShortList, shortItems);
    fillList(djCardLongList, longItems);
    if (djCardListening) {
      djCardListening.hidden = (shortItems.length === 0 && longItems.length === 0);
    }
    // genres chips
    if (djCardGenres) {
      djCardGenres.innerHTML = '';
      for (const g of (d.genres || [])) {
        const span = document.createElement('span');
        span.className = 'dj-genre-chip';
        span.textContent = g;
        djCardGenres.appendChild(span);
      }
    }
  } catch (e) {
    console.warn('[dj-card]', e.message);
  }
}
function closeDjCard() {
  if (djCardOverlay) djCardOverlay.hidden = true;
}
// 头像: 默认显示 SVG fallback. img 加载成功才 .loaded 显示, 覆盖 SVG.
// 加载失败 (404) 啥都不做, img display:none 保持, SVG 可见.
if (djCardAvatarImg) {
  djCardAvatarImg.addEventListener('load', () => {
    // 自然加载 (有 broken 图标的也算 load) — 只在 naturalHeight > 0 才算真有图
    if (djCardAvatarImg.naturalHeight > 0) {
      djCardAvatarImg.classList.add('loaded');
    }
  });
}
if (brandName) {
  brandName.addEventListener('click', openDjCard);
  brandName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDjCard(); }
  });
}
if (djCardClose) djCardClose.addEventListener('click', closeDjCard);
if (djCardOverlay) {
  djCardOverlay.addEventListener('click', (e) => {
    if (e.target === djCardOverlay) closeDjCard();
  });
}
// Escape 关
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && djCardOverlay && !djCardOverlay.hidden) closeDjCard();
});

audio.addEventListener('play', () => {
  btnPlay.textContent = '⏸';
  cardNow.classList.add('playing');
});
audio.addEventListener('pause', () => {
  btnPlay.textContent = '▶';
  cardNow.classList.remove('playing');
});
audio.addEventListener('ended', () => advanceByMode());

// 防死循环: 空 src / 频繁报错时不再触发 next
let lastAudioError = 0;
audio.addEventListener('error', () => {
  if (!audio.currentSrc) return;
  const now = Date.now();
  if (now - lastAudioError < 1500) return;
  lastAudioError = now;
  console.warn('[music] 歌加载失败,跳下一首');
  advanceByMode();
});

// 给 <audio crossorigin="anonymous"> 喂 url 必须带 CORS header.
// netease 等 CDN 直链不带 CORS, 包到 /api/proxy/audio 转一手 (server 端加 CORS).
// 本地相对路径 (/api/proxy/yt/...) 不动 — server.js 已经直接给那条加了 CORS header.
function proxiedAudioUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  if (rawUrl.startsWith('/')) return rawUrl;       // 已经走本地 proxy
  return '/api/proxy/audio?url=' + encodeURIComponent(rawUrl);
}

audio.addEventListener('timeupdate', () => {
  if (!audio.duration) return;
  if (!progressBar.classList.contains('dragging')) {
    setProgressVisual(audio.currentTime / audio.duration);
  }
  tCurrent.textContent = fmtTime(audio.currentTime);
  tTotal.textContent = fmtTime(audio.duration);
  syncLyrics(audio.currentTime);
});
audio.addEventListener('loadedmetadata', () => {
  tTotal.textContent = fmtTime(audio.duration);
});

async function playNext() {
  try {
    const res = await fetch('/api/next');
    const song = await res.json();
    if (!song) {
      // 队列空了 — 只暂停,保留 nowPlaying / 歌词 / 封面,
      // 让用户还能看到刚才在听啥,点 Play 也能从头重播
      audio.pause();
      return;
    }
    if (!song.url) {
      console.warn('[music] 没有直链,跳过:', song.song);
      return playNext();
    }
    audio.src = proxiedAudioUrl(song.url);
    await audio.play().catch(err => console.warn('audio play 被挡:', err.message));
  } catch (e) {
    console.error('playNext 出错:', e);
  }
}

// 跳到队列里某个位置的歌, 立即播 (复用 POST /api/queue/play/:idx)
// 双击队列项和 shuffle 模式都走这里
async function jumpToQueueIndex(idx) {
  try {
    const r = await fetch(`/api/queue/play/${idx}`, { method: 'POST' });
    const np = await r.json();
    if (np?.url) {
      audio.src = proxiedAudioUrl(np.url);
      await audio.play().catch(() => {});
    }
  } catch (e) {
    console.warn('[jump]', e.message);
  }
}

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

function maybeStartPlayback() {
  if (autoPlayArmed && audio.paused && currentQueue.length > 0) {
    playNext();
  }
}

// ============================================
// 4. DJ 说话 — 边说边放
//    DJ 一开口就启下一首,把音乐压到 22% 当背景音,
//    DJ 说完渐变回 100%。模拟真电台 DJ 在歌前奏上配音。
// ============================================
function rampVolume(el, target, ms = 1000) {
  const start = el.volume;
  const t0 = performance.now();
  const tick = () => {
    const k = Math.min(1, (performance.now() - t0) / ms);
    el.volume = start + (target - start) * k;
    if (k < 1) requestAnimationFrame(tick);
  };
  tick();
}

function speakThenPlay(text, audioUrl) {
  const DUCK = 0.22;
  let restored = false;
  const duck = () => { audio.volume = DUCK; };
  const restore = () => {
    if (restored) return;
    restored = true;
    rampVolume(audio, 1.0, 1300);
  };

  const startNext = () => {
    // DJ 一开口就推进, 让前奏当背景
    if (!autoPlayArmed) return;
    if (currentQueue.length > 0) {
      playNext();
    } else {
      // 队列空: 歌还在后台解析中. 等 queue_update 到再切到新歌.
      // 当前歌继续播 (被 ducked), DJ 在上面说话.
      pendingAutoStart = true;
    }
  };

  if (audioUrl) {
    // 真人嗓 ElevenLabs
    djAudio.src = audioUrl;
    djAudio.volume = 1.0;
    // 等音频加载好再压低 + 启下一首,避免黑屏
    djAudio.onloadeddata = () => { duck(); startNext(); };
    djAudio.onended = restore;
    djAudio.onerror = () => {
      console.warn('[dj] mp3 失败,降级浏览器 TTS');
      speakBrowser(text, restore);
    };
    djAudio.play().catch(err => {
      console.warn('[dj] play 被挡:', err.message);
      restore();
      startNext();
    });
    return;
  }

  // 浏览器 TTS 兜底
  duck();
  startNext();
  speakBrowser(text, restore);
}

// 间奏报幕: 跟 speakThenPlay 不同 — 不切歌, 不启 next, 只压低当前歌音量,
// 让 DJ 在歌的某一段上配音, 说完渐回原音量
function speakIntro(text, audioUrl) {
  const DUCK = 0.20;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    rampVolume(audio, 1.0, 1300);
  };
  const duck = () => { audio.volume = DUCK; };

  if (audioUrl) {
    djAudio.src = audioUrl;
    djAudio.volume = 1.0;
    djAudio.onloadeddata = duck;
    djAudio.onended = restore;
    djAudio.onerror = () => speakBrowser(text, restore);
    djAudio.play().catch(() => restore());
    return;
  }
  duck();
  speakBrowser(text, restore);
}

function speakBrowser(text, onDone) {
  if (!text || !('speechSynthesis' in window)) {
    setTimeout(onDone, 200);
    return;
  }
  const utter = new SpeechSynthesisUtterance(text);
  const hasChinese = /[一-鿿]/.test(text);
  utter.lang = hasChinese ? 'zh-CN' : 'en-US';
  utter.rate = 1.0;
  const voices = speechSynthesis.getVoices();
  const v = voices.find(v => v.lang.startsWith(hasChinese ? 'zh' : 'en'));
  if (v) utter.voice = v;
  utter.onend = onDone;
  utter.onerror = onDone;
  speechSynthesis.speak(utter);
}
speechSynthesis.onvoiceschanged = () => {};

// ============================================
// 5. 控制命令
// ============================================
function applyControl(cmd) {
  switch (cmd) {
    case 'pause':
      audio.pause();
      djAudio.pause();
      break;
    case 'resume': audio.play(); break;
    case 'next': playNext(); break;
    case 'stop':
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      djAudio.pause();
      djAudio.removeAttribute('src');
      speechSynthesis.cancel();
      break;
  }
}

// ============================================
// 6. 渲染
// ============================================
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

// —— 单个队列项: 删除按钮 + HTML5 拖拽重排 ——
let _dragFromIdx = -1;

function bindQueueItem(li, idx) {
  // 删除
  const x = li.querySelector('.q-remove');
  x.addEventListener('click', async (e) => {
    e.stopPropagation();
    li.style.opacity = '0.4';
    await fetch(`/api/queue/${idx}`, { method: 'DELETE' }).catch(() => {});
    // server 会广播 queue_update, 这里不用手动 render
  });

  // 双击 → 插队立即播
  li.addEventListener('dblclick', (e) => {
    e.preventDefault();
    autoPlayArmed = true;
    jumpToQueueIndex(idx);
  });

  // 拖拽
  li.addEventListener('dragstart', (e) => {
    _dragFromIdx = idx;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(idx)); } catch {}
  });
  li.addEventListener('dragend', () => {
    li.classList.remove('dragging');
    _dragFromIdx = -1;
    document.querySelectorAll('.queue-list li').forEach(el =>
      el.classList.remove('drop-target-above', 'drop-target-below'));
  });
  li.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = li.getBoundingClientRect();
    const above = (e.clientY - r.top) < r.height / 2;
    li.classList.toggle('drop-target-above', above);
    li.classList.toggle('drop-target-below', !above);
  });
  li.addEventListener('dragleave', () => {
    li.classList.remove('drop-target-above', 'drop-target-below');
  });
  li.addEventListener('drop', async (e) => {
    e.preventDefault();
    li.classList.remove('drop-target-above', 'drop-target-below');
    const from = _dragFromIdx;
    if (from < 0 || from === idx) return;
    const r = li.getBoundingClientRect();
    const above = (e.clientY - r.top) < r.height / 2;
    let to = above ? idx : idx + 1;
    if (from < to) to -= 1;
    if (from === to) return;

    // 本地预览,马上重排
    const next = currentQueue.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    renderQueue(next);

    // 落库
    await fetch('/api/queue', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queue: next })
    }).catch(() => {});
  });
}

// —— Tabs (待播 / 已播 / 喜欢) ——
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

// 喜欢列表 — 来自 feedback.liked, 双击重听
function renderLiked() {
  if (!likedList) return;
  const items = (feedback.liked || []).slice().reverse();   // 新的在前
  likedCount.textContent = String(items.length);
  likedList.innerHTML = '';
  if (!items.length) {
    likedList.innerHTML = '<li class="history-empty">还没标过喜欢的</li>';
    return;
  }
  for (const p of items) {
    const li = document.createElement('li');
    li.title = '双击重听';
    li.innerHTML = `
      <span class="h-replay">♥</span>
      <span class="h-song">${escapeHtml(p.song || '')}</span>
      <span class="h-artist">${escapeHtml(p.artist || '')}</span>
    `;
    li.addEventListener('dblclick', async () => {
      autoPlayArmed = true;
      // liked 里只有元信息没有 url, 现搜然后插队立即播 (不入队)
      try {
        const r = await fetch('/api/play-now', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ song: p.song, artist: p.artist })
        });
        const np = await r.json();
        if (np?.url) {
          audio.src = proxiedAudioUrl(np.url);
          await audio.play().catch(()=>{});
        }
      } catch (e) { console.warn('[liked replay]', e.message); }
    });
    likedList.appendChild(li);
  }
}

// 已播过列表 — 双击 → 立即重听
async function refreshHistory() {
  if (!historyList) return;
  let plays = [];
  try {
    plays = await fetch('/api/history?limit=20').then(r => r.json());
  } catch {}
  historyCount.textContent = String(plays.length);
  historyList.innerHTML = '';
  if (!plays.length) {
    historyList.innerHTML = '<li class="history-empty">还没听过歌</li>';
    return;
  }
  const fmtAgo = (ts) => {
    const d = (Date.now() - ts) / 1000;
    if (d < 60) return '刚才';
    if (d < 3600) return `${Math.floor(d/60)}分钟前`;
    if (d < 86400) return `${Math.floor(d/3600)}小时前`;
    return `${Math.floor(d/86400)}天前`;
  };
  for (const p of plays) {
    const li = document.createElement('li');
    li.title = '双击重听';
    li.innerHTML = `
      <span class="h-replay">↻</span>
      <span class="h-song">${escapeHtml(p.song || '')}</span>
      <span class="h-artist">${escapeHtml(p.artist || '')}</span>
      <span class="h-time">${fmtAgo(p.ts || Date.now())}</span>
    `;
    li.addEventListener('dblclick', async () => {
      autoPlayArmed = true;
      try {
        const r = await fetch('/api/history/replay', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ song: p })
        });
        const np = await r.json();
        if (np?.url) {
          audio.src = proxiedAudioUrl(np.url);
          await audio.play().catch(()=>{});
        }
      } catch (e) { console.warn('[replay]', e.message); }
    });
    historyList.appendChild(li);
  }
}

function renderNowPlaying(song) {
  // 同一首歌不重新加载 (避免 WS 重连导致歌词被清掉重拉)
  if (song?.id && currentSong?.id === song.id) {
    currentSong = song;
    reflectFeedbackButtons();
    return;
  }
  currentSong = song;
  reflectFeedbackButtons();
  if (!song) {
    songName.textContent = '—';
    songArtist.textContent = '队列空了';
    setProgressVisual(0);
    tCurrent.textContent = '0:00';
    tTotal.textContent = '0:00';
    cover.classList.remove('has-img');
    cover.style.removeProperty('--cover-url');
    setLyrics([]);
    return;
  }
  songName.textContent = song.song;
  songArtist.textContent = song.artist;

  // 封面
  if (song.picUrl) {
    cover.style.setProperty('--cover-url', `url("${song.picUrl}")`);
    cover.classList.add('has-img');
  } else {
    cover.classList.remove('has-img');
    cover.style.removeProperty('--cover-url');
  }

  // 歌词 — 异步拉,不阻塞
  if (song.id) loadLyrics(song.id, song.source);
  else setLyrics([]);
}

// ============================================
// 7. 歌词
// ============================================
// 多 loadLyrics 并发时,只让最新的那次落地,
// 防止旧歌的 fetch 慢回来覆盖新歌的空歌词
let _lyricLoadId = 0;
async function loadLyrics(songId, source) {
  const myId = ++_lyricLoadId;
  try {
    const path = source ? `/api/lyric/${source}/${songId}` : `/api/lyric/${songId}`;
    const res = await fetch(path);
    const data = await res.json();
    if (myId !== _lyricLoadId) return;     // 已被新的 load 取代
    setLyrics(parseLrc(data.lyric || ''));
  } catch (e) {
    if (myId !== _lyricLoadId) return;
    console.warn('[lyrics] 拿不到:', e.message);
    setLyrics([]);
  }
}

// 元信息行: 作词/作曲/编曲/制作人/BPM/风格/KEY 等
// QQ 的 LRC 还用 "词:" "曲:" 短前缀,也得抓
const META_RE = /^\s*(作词|作曲|编曲|词|曲|编|制作人|监制|混音|母带|和声|和音|合声|录音|演奏|吉他|贝斯|贝司|鼓|键盘|弦乐|出品|发行|厂牌|曲风|风格|BPM|KEY|TIME|TEMPO|TUNING|MUSIC|LYRICS|PRODUCER|MIXING|MASTERING|BASS|GUITAR|DRUMS)\s*[:：]/i;

function isMetaLine(text) {
  if (META_RE.test(text)) return true;
  // 形如 "G major" "120 BPM" 单独一行的纯标签也滤掉
  if (/^\s*\d+\s*(bpm|key)\s*$/i.test(text)) return true;
  return false;
}

// LRC 解析: [mm:ss.xx] 文本; 纯文本兜底成 t=-1
function parseLrc(raw) {
  if (!raw) return [];
  const lines = raw.split('\n');
  const out = [];
  const re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  let timed = 0;
  for (const line of lines) {
    const text = line.replace(re, '').trim();
    if (!text) continue;
    if (isMetaLine(text)) continue;       // 跳过元信息
    let m;
    re.lastIndex = 0;
    let matched = false;
    while ((m = re.exec(line)) !== null) {
      matched = true;
      timed++;
      const min = +m[1];
      const sec = +m[2];
      const ms = m[3] ? +`0.${m[3]}` : 0;
      out.push({ t: min * 60 + sec + ms, text });
    }
    if (!matched) out.push({ t: -1, text });
  }
  if (timed === 0) return out;             // 纯文本模式
  return out.filter(o => o.t >= 0).sort((a, b) => a.t - b.t);
}

function setLyrics(arr) {
  lyrics = arr;
  currentLyricIndex = -1;
  lyricsTrack.innerHTML = '';
  const win = lyricsTrack.parentElement;
  if (win) win.scrollTop = 0;
  if (!arr.length) {
    cardLyrics.hidden = true;
    return;
  }
  cardLyrics.hidden = false;
  arr.forEach((l, i) => {
    const div = document.createElement('div');
    div.className = 'line';
    if (l.t < 0) div.classList.add('unsynced');
    div.textContent = l.text;
    div.dataset.idx = String(i);
    // 双击 → seek 到这一行的时间戳 (有时间戳的才行)
    if (l.t >= 0) {
      div.addEventListener('dblclick', () => {
        if (audio.duration) {
          audio.currentTime = l.t;
          syncLyrics(l.t);
          // 双击后立即归位 (用户主动定位)
          _userControlling = false;
          autoScrollToCurrent();
        }
      });
    }
    lyricsTrack.appendChild(div);
  });
  if (arr.some(l => l.t >= 0)) highlightLyric(0);
  else lyricsTrack.firstElementChild?.classList.add('current');
}

function syncLyrics(t) {
  if (!lyrics.length) return;
  // 纯文本模式 (全部 t<0) 不同步
  if (!lyrics.some(l => l.t >= 0)) return;
  let idx = -1;
  for (let i = 0; i < lyrics.length; i++) {
    if (lyrics[i].t >= 0 && lyrics[i].t <= t) idx = i;
    else if (lyrics[i].t > t) break;
  }
  if (idx !== currentLyricIndex) highlightLyric(idx);
}

function highlightLyric(idx) {
  const lines = lyricsTrack.children;
  if (currentLyricIndex >= 0 && lines[currentLyricIndex]) {
    lines[currentLyricIndex].classList.remove('current');
  }
  if (idx >= 0 && lines[idx]) {
    lines[idx].classList.add('current');
  }
  currentLyricIndex = idx;
  // 自动滚到当前 — 用户手动看的时候不打扰
  if (!_userControlling) autoScrollToCurrent();
}

// 把当前高亮行滚到窗口中心 (用 scrollTop, 不再依赖 transform/margin)
function autoScrollToCurrent() {
  const cur = lyricsTrack.querySelector('.line.current');
  if (!cur) return;
  const win = lyricsTrack.parentElement;
  if (!win) return;
  const target = cur.offsetTop - win.clientHeight / 2 + cur.offsetHeight / 2;
  _suppressScrollListener = true;
  win.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  // 平滑滚动需要点时间, 等 600ms 再放开 listener
  clearTimeout(_suppressTimer);
  _suppressTimer = setTimeout(() => { _suppressScrollListener = false; }, 600);
}

// —— 用户手动滚动检测 ——
let _userControlling = false;
let _returnTimer = null;
let _suppressScrollListener = false;
let _suppressTimer = null;

(function bindLyricsManualScroll() {
  const win = lyricsTrack.parentElement;
  if (!win) return;
  win.addEventListener('scroll', () => {
    // 程序自己 scroll 时不算用户操作
    if (_suppressScrollListener) return;
    _userControlling = true;
    clearTimeout(_returnTimer);
    _returnTimer = setTimeout(() => {
      _userControlling = false;
      autoScrollToCurrent();
    }, 4000);
  }, { passive: true });
})();

// ============================================
// 8. 可拖动进度条
// ============================================
(function setupProgressDrag() {
  let dragging = false;

  function pctFromEvent(clientX) {
    const r = progressBar.getBoundingClientRect();
    const p = (clientX - r.left) / r.width;
    return Math.max(0, Math.min(1, p));
  }

  function setProgressFromPct(p) {
    setProgressVisual(p);
    if (audio.duration && isFinite(audio.duration)) {
      audio.currentTime = audio.duration * p;
      syncLyrics(audio.currentTime);
    }
    tCurrent.textContent = fmtTime((audio.duration || 0) * p);
  }

  progressBar.addEventListener('pointerdown', (e) => {
    if (!audio.duration) return;
    dragging = true;
    progressBar.classList.add('dragging');
    progressBar.setPointerCapture(e.pointerId);
    setProgressFromPct(pctFromEvent(e.clientX));
  });
  progressBar.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    setProgressVisual(pctFromEvent(e.clientX));
    tCurrent.textContent = fmtTime((audio.duration || 0) * pctFromEvent(e.clientX));
  });
  progressBar.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    setProgressFromPct(pctFromEvent(e.clientX));
    dragging = false;
    progressBar.classList.remove('dragging');
    try { progressBar.releasePointerCapture(e.pointerId); } catch {}
  });
  progressBar.addEventListener('pointercancel', () => {
    dragging = false;
    progressBar.classList.remove('dragging');
  });

  // 键盘: 左右箭头 ±5s
  progressBar.addEventListener('keydown', (e) => {
    if (!audio.duration) return;
    if (e.key === 'ArrowLeft') {
      audio.currentTime = Math.max(0, audio.currentTime - 5);
    } else if (e.key === 'ArrowRight') {
      audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
    }
  });
})();

function setProgressVisual(p) {
  const pct = Math.max(0, Math.min(1, p)) * 100;
  progressFill.style.width = pct + '%';
  progressThumb.style.left = pct + '%';
}

// ============================================
// utils
// ============================================
function fmtTime(sec) {
  if (!isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && document.activeElement === chatInput) {
    chatForm.requestSubmit();
  }
});

// ============================================
// 9. 鼠标动效: 聚光 + 水波纹 + 点击涟漪 + 卡片光斑
// ============================================
(function setupCursorFx() {
  const bubbles = document.getElementById('bubbles');
  if (!bubbles) return;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let pendingX = window.innerWidth / 2;
  let pendingY = window.innerHeight / 3;
  let rafId = 0;
  const flushCursor = () => {
    document.body.style.setProperty('--mx', pendingX + 'px');
    document.body.style.setProperty('--my', pendingY + 'px');
    rafId = 0;
  };

  const cards = Array.from(document.querySelectorAll('.card'));
  function updateCardSpot(card, x, y) {
    const rect = card.getBoundingClientRect();
    card.style.setProperty('--cmx', (x - rect.left) + 'px');
    card.style.setProperty('--cmy', (y - rect.top)  + 'px');
  }

  let lastX = pendingX, lastY = pendingY, lastSpawn = 0;

  function onMove(x, y) {
    pendingX = x;
    pendingY = y;
    if (!rafId) rafId = requestAnimationFrame(flushCursor);

    for (const c of cards) updateCardSpot(c, x, y);

    if (reduced) return;
    const dx = x - lastX, dy = y - lastY;
    const dist = Math.hypot(dx, dy);
    const now = performance.now();
    // 节流: 距离够远 + 间隔够长才喷一圈,慢悠悠像水滴
    if (dist > 42 && now - lastSpawn > 220) {
      spawnWave(x, y);
      lastX = x; lastY = y; lastSpawn = now;
    }
  }

  window.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY), { passive: true });
  window.addEventListener('touchmove', (e) => {
    const t = e.touches[0]; if (t) onMove(t.clientX, t.clientY);
  }, { passive: true });

  function spawnWave(x, y) {
    const w = document.createElement('div');
    w.className = 'wave';
    w.style.left = x + 'px';
    w.style.top  = y + 'px';
    bubbles.appendChild(w);
    setTimeout(() => w.remove(), 2700);
  }

  window.addEventListener('click', (e) => {
    if (reduced) return;
    const r = document.createElement('div');
    r.className = 'ripple';
    r.style.left = e.clientX + 'px';
    r.style.top  = e.clientY + 'px';
    bubbles.appendChild(r);
    setTimeout(() => r.remove(), 1600);
  }, { passive: true });

  flushCursor();
})();

// ============================================
// 10. 流星 — 不定期一颗,从屏幕一角对角划过
// ============================================
(function setupShootingStars() {
  const layer = document.getElementById('shooting-stars');
  if (!layer) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) return;

  function spawn() {
    const s = document.createElement('div');
    s.className = 'shooting-star';
    // 随机起点 (左上区) + 角度 25-50 度 (向右下划)
    const startX = Math.random() * 60;       // 0-60% vw
    const startY = Math.random() * 35;       // 0-35% vh
    const angle = 22 + Math.random() * 28;
    s.style.left = startX + 'vw';
    s.style.top  = startY + 'vh';
    s.style.setProperty('--rot', angle + 'deg');
    layer.appendChild(s);
    setTimeout(() => s.remove(), 2600);
  }

  // 入场先来一颗,后面每 6-18s 一颗
  function schedule() {
    const delay = 6000 + Math.random() * 12000;
    setTimeout(() => { spawn(); schedule(); }, delay);
  }
  setTimeout(spawn, 2500);
  schedule();
})();

// ============================================
// 11. 天色 — 按当前小时切 overlay 色 (CSS 自己 60s 平滑过渡)
//     夜深 → 拂晓暖 → 白天清凉 → 黄金小时琥珀 → 夜
// ============================================
(function setupSky() {
  // 几个时段端点 (24h). 在端点之间 CSS @property + transition 自己漂.
  // 取 hour ∈ [0,24), 找最近一段
  const PALETTE = [
    // hour, top, bot
    [ 0, 'rgba(7, 6, 15, 0.55)',  'rgba(7, 6, 15, 0.78)'  ],  // 深夜
    [ 5, 'rgba(50, 25, 38, 0.42)','rgba(20, 15, 25, 0.65)' ], // 拂晓 (暖)
    [ 9, 'rgba(15, 28, 50, 0.28)','rgba(10, 18, 32, 0.50)' ], // 白天 (清凉, 让底图露多一点)
    [17, 'rgba(60, 28, 12, 0.38)','rgba(28, 14, 18, 0.62)' ], // 黄金小时
    [20, 'rgba(7, 6, 15, 0.55)',  'rgba(7, 6, 15, 0.78)'  ],  // 入夜
  ];

  function paletteForNow() {
    const h = new Date().getHours();
    // 找 <= 当前的最后一段
    let pick = PALETTE[0];
    for (const row of PALETTE) {
      if (row[0] <= h) pick = row;
    }
    return pick;
  }

  function apply() {
    const [, top, bot] = paletteForNow();
    document.documentElement.style.setProperty('--sky-top', top);
    document.documentElement.style.setProperty('--sky-bot', bot);
  }
  apply();
  // 每 5 分钟 check 一次, 切到新时段 CSS 会自己 60s 漂过去
  setInterval(apply, 5 * 60 * 1000);
})();

// ============================================
// 12. 电台时钟 — 顶部 brand 下方, 一秒一跳, 冒号呼吸
// ============================================
(function setupClock() {
  const elClock = document.getElementById('t-clock');
  const elDate = document.getElementById('t-date');
  if (!elClock || !elDate) return;

  const dayCh = ['周日','周一','周二','周三','周四','周五','周六'];
  const pad = (n) => String(n).padStart(2, '0');

  function tick() {
    const d = new Date();
    // hh:mm:ss, 冒号有自己的 span 方便 CSS 加呼吸动画
    elClock.innerHTML = `${pad(d.getHours())}<span class="colon">:</span>${pad(d.getMinutes())}<span class="colon">:</span>${pad(d.getSeconds())}`;
    elDate.textContent = `${d.getMonth() + 1}月${d.getDate()}日 ${dayCh[d.getDay()]}`;
  }
  tick();
  // 对齐到下一秒边界, 看起来跟系统时间同步
  const driftToNextSecond = 1000 - (Date.now() % 1000);
  setTimeout(() => { tick(); setInterval(tick, 1000); }, driftToNextSecond);
})();

// ============================================
// 13. 音频可视化 — 用 Web Audio analyser 提取 bass 强度,
//      实时驱动专辑封面的 scale / 旋转 / 阴影. 不加新 UI 元素, 直接接管
//      原本的 cover-pulse CSS 动画 (JS inline style 自然覆盖 CSS).
//      浏览器自动播放策略要求 AudioContext 在用户手势后才能开, 我们等
//      audio 第一次 play 事件触发再 init.
// ============================================
(function setupAudioVisualizer() {
  const artwork = document.querySelector('.card-now .artwork');
  const canvas = document.getElementById('viz-bars');
  if (!artwork || !canvas) return;
  const REDUCE_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (REDUCE_MOTION) return;

  const ctx = canvas.getContext('2d');
  const BAR_COUNT = 56;        // 56 根条
  const dpr = window.devicePixelRatio || 1;

  // 处理 retina + 自适应宽度: ResizeObserver 重新 set canvas 的内部分辨率
  function fitCanvas() {
    const rect = canvas.getBoundingClientRect();
    canvas.width  = Math.max(1, Math.floor(rect.width  * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  }
  fitCanvas();
  new ResizeObserver(fitCanvas).observe(canvas);

  let audioCtx = null;
  let analyser = null;
  let bins = null;
  let smoothed = null;         // 每根 bar 一个低通后的强度
  let bass = 0;                // 封面用的轻反应
  let initFailed = false;

  function lazyInit() {
    if (audioCtx || initFailed) return;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaElementSource(audio);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;                   // 256 bins, 给 bars 分组够细
      analyser.smoothingTimeConstant = 0.78;
      bins = new Uint8Array(analyser.frequencyBinCount);
      smoothed = new Float32Array(BAR_COUNT);
      src.connect(analyser);
      analyser.connect(audioCtx.destination);   // 别忘了 destination, 不然就没声音了
      requestAnimationFrame(tick);
    } catch (e) {
      console.warn('[viz] Web Audio init 失败:', e.message);
      initFailed = true;
    }
  }

  audio.addEventListener('play', () => {
    lazyInit();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  });

  // 频谱条用 log 分布映射到 BAR_COUNT — 让低频不被高频压扁
  // 只取低-中频段 (前 ~70% 的 bin, 高频通常空气感太弱画出来看不见)
  const USEFUL_BINS = () => Math.floor((analyser?.frequencyBinCount || 256) * 0.7);
  function drawBars() {
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const useful = USEFUL_BINS();
    const barOuterW = W / BAR_COUNT;
    const barInnerW = barOuterW * 0.55;
    const radius = Math.min(barInnerW / 2, 4 * dpr);

    // 渐变色: 中段偏粉 (跟 claudio 主色 var(--coral) 呼应)
    const grad = ctx.createLinearGradient(0, H, 0, 0);
    grad.addColorStop(0, 'rgba(255, 107, 142, 0.95)');
    grad.addColorStop(1, 'rgba(180, 140, 255, 0.95)');
    ctx.fillStyle = grad;

    for (let i = 0; i < BAR_COUNT; i++) {
      // log 分布 (低频拿到更多 bin)
      const lo = Math.floor(Math.pow(i / BAR_COUNT, 1.7) * useful);
      const hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / BAR_COUNT, 1.7) * useful));
      let max = 0;
      for (let j = lo; j < hi && j < useful; j++) {
        if (bins[j] > max) max = bins[j];
      }
      const target = max / 255;          // 0-1
      // 每根 bar 独立低通 (上跳快, 下落慢, 像 EQ 表头)
      const prev = smoothed[i];
      smoothed[i] = target > prev ? prev * 0.4 + target * 0.6 : prev * 0.85 + target * 0.15;

      const barH = Math.max(2 * dpr, smoothed[i] * H);
      const x = i * barOuterW + (barOuterW - barInnerW) / 2;
      const y = H - barH;
      // 圆角矩形 (Path2D + roundRect 现代浏览器都有)
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, barInnerW, barH, radius);
      else ctx.rect(x, y, barInnerW, barH);
      ctx.fill();
    }
  }

  function tick() {
    requestAnimationFrame(tick);
    if (!analyser) return;

    if (audio.paused) {
      // 暂停: 清画布 + 清封面 inline (留给 CSS pulse 接手)
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (artwork.style.transform) {
        artwork.style.transform = '';
        artwork.style.boxShadow = '';
        bass = 0;
        if (smoothed) smoothed.fill(0);
      }
      return;
    }
    analyser.getByteFrequencyData(bins);

    // 封面 bass 反应 — 收着点, 不抢 bars 戏
    let sum = 0;
    for (let i = 0; i < 6; i++) sum += bins[i];
    const raw = (sum / 6) / 255;
    bass = bass * 0.6 + raw * 0.4;
    const scale = 1 + bass * 0.04;             // 1.00 - 1.04 (比之前 0.07 弱)
    artwork.style.transform = `scale(${scale.toFixed(3)})`;
    artwork.style.boxShadow =
      `0 ${(6 + bass * 8).toFixed(1)}px ${(22 + bass * 14).toFixed(0)}px -8px rgba(255,107,142,${(0.40 + bass * 0.25).toFixed(2)})`;

    // 主视觉: 频谱条
    drawBars();
  }
})();
