const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { networkInterfaces, hostname } = require('os');
const { join } = require('path');
const fs = require('fs');

// Load .env
const envFile = join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf-8').split('\n').forEach(line => {
    const m = line.match(/^([^=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  });
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(express.static(join(__dirname, 'public')));
app.use(express.json());

app.get('/api/ping', (_req, res) => res.json({ app: 'karaqueue', version: '2' }));
app.get('/tv', (_req, res) => res.sendFile(join(__dirname, 'public', 'tv.html')));
app.get('/settings', (_req, res) => res.sendFile(join(__dirname, 'public', 'settings.html')));
app.get('/remote', (_req, res) => res.sendFile(join(__dirname, 'public', 'remote.html')));
app.get('/playlists', (_req, res) => res.sendFile(join(__dirname, 'public', 'playlists.html')));

const playlistsDir = join(__dirname, 'playlists');
if (!fs.existsSync(playlistsDir)) fs.mkdirSync(playlistsDir, { recursive: true });

const songsDbPath = process.env.SONGS_DB_PATH || join(__dirname, 'songs-db.json');
function loadSongsDb() {
  try { if (fs.existsSync(songsDbPath)) return JSON.parse(fs.readFileSync(songsDbPath, 'utf-8')); } catch (_) {}
  return [];
}
function saveSongsDb(db) { fs.writeFileSync(songsDbPath, JSON.stringify(db, null, 2)); }

const AI_SYSTEM_PROMPT = `你係歌曲分類系統，只輸出一行JSON，不加任何說明。

規則：
1. 標題格式通常係「歌手 - 歌名」，取橫線前嘅部分作歌手名
2. 同一人有中英文名並排（如「古巨基 Leo Ku」）→ 取中文名「古巨基」
3. 多位唔同歌手 → 用「/」分隔，如「古巨基 / MC 張天賦」
4. 已清除標題中嘅 Karaoke、KTV、伴奏、純音樂、MV、Official 等噪音字眼，毋需理會
5. gender：獨唱男=男，獨唱女=女，男女組合/樂隊=組合，男女合唱=合唱

例子：
標題：古巨基 Leo Ku - 大雄 → {"singer":"古巨基","gender":"男","language":"廣東話","era":"00年代"}
標題：古巨基 MC 張天賦 - 自我安慰 → {"singer":"古巨基 / MC 張天賦","gender":"男","language":"廣東話","era":"20年代"}
標題：鄭秀文 - 終身美麗 → {"singer":"鄭秀文","gender":"女","language":"廣東話","era":"00年代"}
標題：Beyond - 海闊天空 → {"singer":"Beyond","gender":"組合","language":"廣東話","era":"90年代"}
標題：容祖兒 x 古巨基 - 我的驕傲 → {"singer":"容祖兒 / 古巨基","gender":"合唱","language":"廣東話","era":"00年代"}
標題：Taylor Swift - Shake It Off → {"singer":"Taylor Swift","gender":"女","language":"英文","era":"10年代"}

輸出格式（JSON only）：{"singer":"歌手名","gender":"男|女|組合|合唱","language":"廣東話|普通話|英文|日文|其他","era":"70年代|80年代|90年代|00年代|10年代|20年代"}`;

function getActiveAI() {
  const provider = (process.env.AI_PROVIDER || 'minimax').toLowerCase();
  const keyMap = {
    minimax: process.env.MINIMAX_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    gemini: process.env.GEMINI_API_KEY,
    claude: process.env.ANTHROPIC_API_KEY,
  };
  return { provider, key: keyMap[provider] || '' };
}

async function callAI(provider, key, userContent) {
  switch (provider) {
    case 'openai': {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'system', content: AI_SYSTEM_PROMPT }, { role: 'user', content: userContent }],
          max_tokens: 150,
          response_format: { type: 'json_object' }
        }),
        signal: AbortSignal.timeout(15000)
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message);
      return d.choices?.[0]?.message?.content || '';
    }
    case 'gemini': {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: AI_SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: userContent }] }],
          generationConfig: { maxOutputTokens: 150, responseMimeType: 'application/json' }
        }),
        signal: AbortSignal.timeout(15000)
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message);
      return d.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }
    case 'claude': {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 150,
          system: AI_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userContent }]
        }),
        signal: AbortSignal.timeout(15000)
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
      return d.content?.[0]?.text || '';
    }
    default: { // minimax
      const r = await fetch('https://api.minimaxi.com/v1/text/chatcompletion_v2', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'MiniMax-M2.5-highspeed',
          messages: [{ role: 'system', content: AI_SYSTEM_PROMPT }, { role: 'user', content: userContent }],
          max_tokens: 500
        }),
        signal: AbortSignal.timeout(15000)
      });
      const d = await r.json();
      return d.choices?.[0]?.message?.content || '';
    }
  }
}

function cleanTitle(title) {
  return title.replace(/\s*[|｜]\s*(伴奏|純音樂|Karaoke|KTV|MV|Official|官方|backing track|instrumental)[^|｜]*/gi, '').trim();
}

// Returns 'saved' | 'duplicate' | 'no-key' | 'failed'
async function classifyAndSave(video) {
  const db = loadSongsDb();
  if (db.find(s => s.ytId === video.videoId)) return 'duplicate';
  const { provider, key } = getActiveAI();
  if (!key) return 'no-key';
  const cleaned = cleanTitle(video.title);
  try {
    const userContent = `標題：${cleaned}\n頻道：${video.author || ''}`;
    const text = await callAI(provider, key, userContent);
    const m = text.match(/\{[\s\S]*?\}/);
    if (!m) {
      console.error(`[Catalog] ${provider} 未返 JSON，原文: ${text.slice(0, 200)}`);
      return 'failed';
    }
    const c = JSON.parse(m[0]);
    const singer = c.singer || video.author || '';
    const entry = {
      ytId: video.videoId,
      title: video.title,
      singer,
      thumbnail: `https://i.ytimg.com/vi/${video.videoId}/mqdefault.jpg`,
      gender: c.gender || '未知',
      language: c.language || '其他',
      era: c.era || '未知',
      titleFirstChar: (video.title || '')[0] || '',
      singerFirstChar: singer[0] || '',
      addedAt: new Date().toISOString()
    };
    db.push(entry);
    saveSongsDb(db);
    io.emit('catalog-updated', entry);
    console.log(`[Catalog] 新增 (${provider}): ${entry.title} (${entry.singer}, ${entry.gender})`);
    return 'saved';
  } catch (e) {
    console.error(`[Catalog] ${provider} 分類失敗:`, e.message);
    return 'failed';
  }
}

function getLocalIP() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

let queue = [];
let currentIndex = -1;
let videoEndedTimer = null;
let playStartTime = null;
let playingVideo = null;
let autoClassify = true;

function checkPlayTime() {
  if (!playingVideo || !playStartTime) return;
  const elapsed = Date.now() - playStartTime;
  const v = playingVideo;
  playingVideo = null; playStartTime = null;
  if (autoClassify && elapsed >= 120000) {
    classifyAndSave(v).then(r => {
      if (r === 'failed') console.warn(`[Catalog] 自動分類失敗，請人手加入: ${v.title}`);
    }).catch(() => {});
  }
}

app.get('/api/qr', async (req, res) => {
  const ip = getLocalIP();
  const base = `http://${ip}:3000`;
  try {
    const qrRemote = await QRCode.toDataURL(`${base}/remote`, { width: 250, margin: 1 });
    const qrControl = await QRCode.toDataURL(`${base}`, { width: 250, margin: 1 });
    res.json({ base, ip, qrRemote, qrControl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function validPlaylistName(name) {
  return /^[\w一-鿿\- ]{1,40}$/.test(name);
}

app.get('/api/playlists', (_req, res) => {
  const files = fs.readdirSync(playlistsDir).filter(f => f.endsWith('.json'));
  res.json(files.map(f => f.replace('.json', '')));
});

app.get('/api/playlists/:name', (req, res) => {
  if (!validPlaylistName(req.params.name)) return res.status(400).json({ error: 'Invalid name' });
  const fp = join(playlistsDir, `${req.params.name}.json`);
  if (fs.existsSync(fp)) res.json(JSON.parse(fs.readFileSync(fp, 'utf-8')));
  else res.status(404).json({ error: 'Not found' });
});

app.post('/api/playlists/:name', (req, res) => {
  if (!validPlaylistName(req.params.name)) return res.status(400).json({ error: 'Invalid name' });
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Invalid data' });
  const fp = join(playlistsDir, `${req.params.name}.json`);
  fs.writeFileSync(fp, JSON.stringify(req.body, null, 2));
  res.json({ ok: true });
});

app.delete('/api/playlists/:name', (req, res) => {
  if (!validPlaylistName(req.params.name)) return res.status(400).json({ error: 'Invalid name' });
  const fp = join(playlistsDir, `${req.params.name}.json`);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  res.json({ ok: true });
});

app.get('/api/search', async (req, res) => {
  const q = req.query.q;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  if (!q) return res.json([]);
  const instances = [
    'https://iv.melmac.space',
    'https://invidious.slipfox.xyz',
    'https://inv.nadeko.net',
    'https://invidious.fdn.fr',
    'https://invidious.privacyredirect.com',
    'https://yt.dragonbanane.de',
  ];
  for (const host of instances) {
    try {
      const r = await fetch(`${host}/api/v1/search?q=${encodeURIComponent(q)}&type=video&page=${page}&region=HK&hl=zh-TW`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const data = await r.json();
      const videos = data.filter(v => v.type === 'video');
      if (!videos.length) continue;
      return res.json(videos.map(v => ({
        videoId: v.videoId,
        title: v.title,
        author: v.author,
        duration: v.lengthSeconds,
        thumbnail: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
      })));
    } catch (_) { continue; }
  }
  res.json([]);
});

app.get('/api/video/:id', async (req, res) => {
  const id = req.params.id;
  if (!/^[\w-]{11}$/.test(id)) return res.status(400).json({ error: 'Invalid ID' });
  const instances = [
    'https://iv.melmac.space',
    'https://invidious.slipfox.xyz',
    'https://inv.nadeko.net',
    'https://invidious.fdn.fr',
  ];
  for (const host of instances) {
    try {
      const r = await fetch(`${host}/api/v1/videos/${id}`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const v = await r.json();
      return res.json({
        videoId: v.videoId,
        title: v.title,
        author: v.author,
        duration: v.lengthSeconds,
        thumbnail: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
      });
    } catch (_) { continue; }
  }
  res.json({
    videoId: id,
    title: `YouTube 影片`,
    author: '',
    duration: 0,
    thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
  });
});

app.get('/api/ytplaylist/:id', async (req, res) => {
  const id = req.params.id;
  if (!/^[A-Za-z0-9_-]{10,60}$/.test(id)) return res.status(400).json({ error: 'Invalid playlist ID' });
  const instances = [
    'https://iv.melmac.space',
    'https://invidious.slipfox.xyz',
    'https://inv.nadeko.net',
    'https://invidious.fdn.fr',
    'https://invidious.privacyredirect.com',
    'https://yt.dragonbanane.de',
  ];
  for (const host of instances) {
    try {
      const r = await fetch(`${host}/api/v1/playlists/${id}?page=1`, { signal: AbortSignal.timeout(12000) });
      if (!r.ok) continue;
      const data = await r.json();
      const videos = (data.videos || [])
        .filter(v => v.videoId && /^[\w-]{11}$/.test(v.videoId))
        .map(v => ({
          videoId: v.videoId,
          title: v.title,
          author: v.author,
          duration: v.lengthSeconds,
          thumbnail: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
        }));
      return res.json({ title: data.title || id, videos });
    } catch (_) { continue; }
  }
  res.status(500).json({ error: '無法載入播放清單，請稍後再試' });
});

function saveEnvKey(key, value) {
  let lines = [];
  try { lines = fs.readFileSync(envFile, 'utf-8').split('\n').filter(l => l.trim()); } catch {}
  const idx = lines.findIndex(l => l.startsWith(key + '='));
  const entry = `${key}=${value}`;
  if (idx >= 0) lines[idx] = entry; else lines.push(entry);
  fs.writeFileSync(envFile, lines.join('\n') + '\n');
  process.env[key] = value;
}

const PROVIDER_KEY_MAP = { minimax: 'MINIMAX_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', claude: 'ANTHROPIC_API_KEY' };

app.get('/api/settings', (_req, res) => {
  const { provider, key } = getActiveAI();
  res.json({ autoClassify, provider, hasApiKey: !!key, songsDbPath });
});

app.post('/api/settings', async (req, res) => {
  const { apiKey, autoClassify: ac, provider } = req.body || {};
  if (provider) saveEnvKey('AI_PROVIDER', provider);
  if (apiKey !== undefined && apiKey !== '') {
    const envKey = PROVIDER_KEY_MAP[provider || process.env.AI_PROVIDER || 'minimax'] || 'MINIMAX_API_KEY';
    saveEnvKey(envKey, apiKey);
  }
  if (ac !== undefined) autoClassify = !!ac;
  res.json({ ok: true });
});

app.post('/api/settings/test-key', async (req, res) => {
  const provider = (req.body?.provider || process.env.AI_PROVIDER || 'minimax').toLowerCase();
  const envKey = PROVIDER_KEY_MAP[provider] || 'MINIMAX_API_KEY';
  const key = req.body?.apiKey || process.env[envKey] || '';
  if (!key) return res.json({ ok: false, msg: '未填 API Key' });
  try {
    await callAI(provider, key, '標題：測試\n頻道：test');
    res.json({ ok: true, msg: `${provider} API Key 有效 ✓` });
  } catch (e) {
    res.json({ ok: false, msg: '連線失敗：' + e.message });
  }
});

app.post('/api/settings/auto-classify', (req, res) => {
  autoClassify = !!req.body.enabled;
  res.json({ autoClassify });
});

app.get('/api/catalog', (_req, res) => res.json(loadSongsDb()));

app.post('/api/catalog/add', async (req, res) => {
  const { videoId, title, author, thumbnail } = req.body || {};
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) return res.status(400).json({ error: 'Invalid videoId' });
  const video = { videoId, title: title || '', author: author || '', thumbnail: thumbnail || '' };
  const result = await classifyAndSave(video);
  if (result === 'saved' || result === 'duplicate') return res.json({ ok: true });
  if (result === 'no-key' || result === 'failed') return res.json({ ok: false, needManual: true });
  res.json({ ok: false, needManual: true });
});

app.post('/api/catalog/manual-add', (req, res) => {
  const { videoId, title, singer, gender, language, era, thumbnail } = req.body || {};
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) return res.status(400).json({ error: 'Invalid videoId' });
  if (!singer) return res.status(400).json({ error: 'singer required' });
  const db = loadSongsDb();
  if (db.find(s => s.ytId === videoId)) return res.json({ ok: true, duplicate: true });
  const entry = {
    ytId: videoId,
    title: title || '',
    singer: singer.trim(),
    thumbnail: thumbnail || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    gender: gender || '未知',
    language: language || '廣東話',
    era: era || '未知',
    titleFirstChar: (title || '')[0] || '',
    singerFirstChar: singer.trim()[0] || '',
    addedAt: new Date().toISOString()
  };
  db.push(entry);
  saveSongsDb(db);
  io.emit('catalog-updated', entry);
  console.log(`[Catalog] 人手新增: ${entry.title} (${entry.singer})`);
  res.json({ ok: true });
});

app.delete('/api/catalog/:ytId', (req, res) => {
  const ytId = req.params.ytId;
  if (!/^[\w-]{11}$/.test(ytId)) return res.status(400).json({ error: 'Invalid ID' });
  saveSongsDb(loadSongsDb().filter(s => s.ytId !== ytId));
  res.json({ ok: true });
});

io.on('connection', socket => {
  socket.emit('state', { queue, currentIndex });

  socket.on('add', video => {
    if (!video?.videoId || !/^[\w-]{11}$/.test(video.videoId)) return;
    const wasEmpty = currentIndex === -1;
    queue.push({ ...video, addedBy: video.addedBy || 'Guest', volume: 70 });
    if (currentIndex === -1) currentIndex = 0;
    io.emit('state', { queue, currentIndex });
    if (wasEmpty) emitPlay(queue[currentIndex]);
  });

  socket.on('add-next', video => {
    if (!video?.videoId || !/^[\w-]{11}$/.test(video.videoId)) return;
    const wasEmpty = currentIndex === -1;
    const insertAt = currentIndex === -1 ? 0 : currentIndex + 1;
    queue.splice(insertAt, 0, { ...video, addedBy: video.addedBy || 'Guest', volume: 70 });
    if (currentIndex === -1) currentIndex = 0;
    io.emit('state', { queue, currentIndex });
    if (wasEmpty) emitPlay(queue[currentIndex]);
  });

  socket.on('song-volume', ({ idx, delta }) => {
    if (idx < 0 || idx >= queue.length) return;
    const cur = queue[idx].volume ?? 70;
    queue[idx].volume = Math.max(0, Math.min(100, cur + delta));
    io.emit('state', { queue, currentIndex });
    if (idx === currentIndex) io.emit('volume', queue[idx].volume);
  });

  socket.on('remove', idx => {
    if (idx < 0 || idx >= queue.length) return;
    if (idx === currentIndex) return;
    queue.splice(idx, 1);
    if (queue.length === 0) { currentIndex = -1; }
    else if (idx < currentIndex) { currentIndex--; }
    io.emit('state', { queue, currentIndex });
  });

  socket.on('play-index', idx => {
    if (idx < 0 || idx >= queue.length || idx === currentIndex) return;
    checkPlayTime();
    if (currentIndex >= 0 && currentIndex < queue.length) {
      queue.splice(currentIndex, 1);
      if (idx > currentIndex) idx--;
    }
    const [song] = queue.splice(idx, 1);
    queue.unshift(song);
    currentIndex = 0;
    io.emit('state', { queue, currentIndex });
    emitPlay(queue[0]);
  });

  socket.on('next', () => {
    checkPlayTime();
    if (currentIndex >= 0 && currentIndex < queue.length) queue.splice(currentIndex, 1);
    if (queue.length === 0) {
      currentIndex = -1;
      io.emit('state', { queue, currentIndex });
      io.emit('stop');
    } else {
      if (currentIndex >= queue.length) currentIndex = 0;
      io.emit('state', { queue, currentIndex });
      emitPlay(queue[currentIndex]);
    }
  });

  socket.on('prev', () => {
    if (currentIndex >= 0 && queue[currentIndex]) emitPlay(queue[currentIndex]);
  });

  socket.on('replay', () => {
    if (currentIndex >= 0 && queue[currentIndex]) {
      emitPlay(queue[currentIndex]);
    }
  });

  socket.on('stop', () => {
    checkPlayTime();
    io.emit('stop');
  });

  socket.on('skip', () => {
    checkPlayTime();
    if (currentIndex >= 0 && currentIndex < queue.length) {
      queue.splice(currentIndex, 1);
    }
    if (queue.length === 0) {
      currentIndex = -1;
      io.emit('state', { queue, currentIndex });
      io.emit('stop');
    } else {
      if (currentIndex >= queue.length) currentIndex = 0;
      io.emit('state', { queue, currentIndex });
      emitPlay(queue[currentIndex]);
    }
  });

  socket.on('volume', val => {
    const v = Math.max(0, Math.min(100, Number(val)));
    if (!isNaN(v)) io.emit('volume', v);
  });

  socket.on('clear', () => {
    queue = [];
    currentIndex = -1;
    io.emit('state', { queue, currentIndex });
    io.emit('stop');
  });

  socket.on('reorder', ({ from, to }) => {
    if (from === to || from < 0 || from >= queue.length || to < 0 || to >= queue.length) return;
    if (from === currentIndex) return;
    const [item] = queue.splice(from, 1);
    queue.splice(to, 0, item);
    if (from < currentIndex && to >= currentIndex) currentIndex--;
    else if (from > currentIndex && to <= currentIndex) currentIndex++;
    io.emit('state', { queue, currentIndex });
  });

  socket.on('video-ended', () => {
    if (videoEndedTimer) return;
    videoEndedTimer = setTimeout(() => { videoEndedTimer = null; }, 3000);
    checkPlayTime();
    if (currentIndex >= 0 && currentIndex < queue.length) {
      queue.splice(currentIndex, 1);
    }
    if (queue.length === 0) {
      currentIndex = -1;
      io.emit('state', { queue, currentIndex });
      io.emit('loop');
    } else {
      if (currentIndex >= queue.length) currentIndex = 0;
      io.emit('state', { queue, currentIndex });
      emitPlay(queue[currentIndex]);
    }
  });
});

function emitPlay(song) {
  playingVideo = { videoId: song.videoId, title: song.title, author: song.author || '', thumbnail: song.thumbnail || '' };
  playStartTime = Date.now();
  io.emit('play', { videoId: song.videoId, volume: song.volume ?? 70 });
}

const PORT = 3000;
httpServer.listen(PORT, async () => {
  const ip = getLocalIP();
  const localName = `${hostname()}.local`;
  const remoteUrl = `http://${localName}:${PORT}/remote`;
  console.log(`\nKaraQueue 啟動！`);
  console.log(`電視畫面:   http://localhost:${PORT}/tv`);
  console.log(`控制台:     http://localhost:${PORT}`);
  console.log(`手機遙控:   ${remoteUrl}`);
  console.log(`備用(IP):   http://${ip}:${PORT}/remote`);
  console.log(`手機掃碼點歌 👇`);
  const qr = await QRCode.toString(remoteUrl, { type: 'terminal', small: true });
  console.log(qr);
  console.log(`按 Ctrl+C 停止伺服器\n`);
});
