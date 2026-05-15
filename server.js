const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { networkInterfaces, hostname } = require('os');
const { join } = require('path');
const fs = require('fs');
const { Converter } = require('opencc-js');
const s2t = Converter({ from: 'cn', to: 'tw' });

// Load .env
const envFile = join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf-8').split('\n').forEach(line => {
    const m = line.match(/^([^=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  });
}

const APP_VERSION = JSON.parse(fs.readFileSync(join(__dirname, 'package.json'), 'utf-8')).version;

let updateInfo = null;
async function checkForUpdates() {
  try {
    const r = await fetch('https://api.github.com/repos/mileslor/karaqueue-v2/releases/latest', {
      headers: { 'User-Agent': `KaraQueue/${APP_VERSION}` },
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) return;
    const data = await r.json();
    const latest = (data.tag_name || '').replace(/^v/, '');
    updateInfo = { hasUpdate: latest && latest !== APP_VERSION, latestVersion: latest, downloadUrl: data.html_url };
    if (updateInfo.hasUpdate) console.log(`[Update] 有新版本：v${latest}`);
  } catch (e) { console.log('[Update] 檢查失敗:', e.message); }
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

const playlistsMetaPath = join(playlistsDir, '.meta.json');
function readMeta() {
  try { if (fs.existsSync(playlistsMetaPath)) return JSON.parse(fs.readFileSync(playlistsMetaPath, 'utf-8')); } catch (_) {}
  return {};
}
function writeMeta(meta) { fs.writeFileSync(playlistsMetaPath, JSON.stringify(meta, null, 2)); }
function isLocked(name) { const m = readMeta(); return !!(m[name] && m[name].locked); }

const songsDbPath = process.env.SONGS_DB_PATH || join(__dirname, 'songs-db.json');
function loadSongsDb() {
  try { if (fs.existsSync(songsDbPath)) return JSON.parse(fs.readFileSync(songsDbPath, 'utf-8')); } catch (_) {}
  return [];
}
function saveSongsDb(db) { fs.writeFileSync(songsDbPath, JSON.stringify(db, null, 2)); }

// ─── Lyrics cache ──────────────────────────────────────────────────────
const lyricsCachePath = join(__dirname, 'lyrics-cache.json');
function loadLyricsCache() {
  try { if (fs.existsSync(lyricsCachePath)) return JSON.parse(fs.readFileSync(lyricsCachePath, 'utf-8')); } catch (_) {}
  return {};
}
function saveLyricsCache(cache) { fs.writeFileSync(lyricsCachePath, JSON.stringify(cache)); }

function parseTitleForSearch(title) {
  const cleaned = title.replace(/\s*[|｜]\s*(伴奏|純音樂|Karaoke|KTV|MV|Official|官方|backing\s*track|instrumental)[^|｜]*/gi, '').trim();
  const parts = cleaned.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) return { artist: parts[0].trim(), track: parts[1].trim() };
  return { artist: '', track: cleaned };
}

async function fetchNeteaseLyrics(title) {
  const { artist, track } = parseTitleForSearch(title);
  const query = encodeURIComponent(`${artist} ${track}`.trim());
  const sr = await fetch(`http://music.163.com/api/search/get?s=${query}&type=1&limit=3`, {
    headers: { 'Referer': 'http://music.163.com/', 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(8000)
  });
  if (!sr.ok) return null;
  const sd = await sr.json();
  const songId = sd?.result?.songs?.[0]?.id;
  if (!songId) return null;

  const lr = await fetch(`http://music.163.com/api/song/lyric?id=${songId}&lv=1&kv=1&tv=-1`, {
    headers: { 'Referer': 'http://music.163.com/', 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(8000)
  });
  if (!lr.ok) return null;
  const ld = await lr.json();
  const lrc = ld?.lrc?.lyric || '';
  if (!lrc || lrc.length < 20 || !lrc.includes('[')) return null;
  return s2t(lrc);
}

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
      volume: defaultVol(),
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

let autoClassify = process.env.AUTO_CLASSIFY === 'true';
function defaultVol() { return Math.max(0, Math.min(100, parseInt(process.env.DEFAULT_VOLUME) || 70)); }

// ─── Multi-room management ────────────────────────────────────────────
const rooms = new Map();

function genRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do { id = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(id));
  return id;
}

const ROOM_COLORS = ['#e94560','#7c3aed','#0ea5e9','#10b981','#f59e0b','#ec4899','#06b6d4','#84cc16'];
let _colorIdx = 0;

function createRoom(name, fixedId, color) {
  const id = fixedId || genRoomId();
  const room = {
    id, name: name || `房間 ${id}`,
    color: color || ROOM_COLORS[_colorIdx++ % ROOM_COLORS.length],
    queue: [], currentIndex: -1,
    videoEndedTimer: null, playStartTime: null, playingVideo: null,
    shuffleMode: false, globalLyricsOffset: 0, createdAt: Date.now()
  };
  rooms.set(id, room);
  return room;
}

// Always-present default room for backward compat
createRoom('預設房間', 'default');

function maybeShuffleNext(room) {
  if (!room.shuffleMode) return;
  const nextIdx = room.currentIndex + 1;
  const remaining = room.queue.length - nextIdx - 1;
  if (remaining > 0) {
    const swapIdx = nextIdx + 1 + Math.floor(Math.random() * remaining);
    [room.queue[nextIdx], room.queue[swapIdx]] = [room.queue[swapIdx], room.queue[nextIdx]];
  }
}

function checkPlayTime(room) {
  if (!room.playingVideo || !room.playStartTime) return;
  const elapsed = Date.now() - room.playStartTime;
  const v = room.playingVideo;
  room.playingVideo = null; room.playStartTime = null;
  if (autoClassify && elapsed >= 120000) {
    classifyAndSave(v).then(r => {
      if (r === 'failed') console.warn(`[Catalog] 自動分類失敗: ${v.title}`);
    }).catch(() => {});
  }
}

function emitRoomState(room) {
  io.to(room.id).emit('state', { queue: room.queue, currentIndex: room.currentIndex, shuffleMode: room.shuffleMode, globalLyricsOffset: room.globalLyricsOffset || 0 });
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
  const files = fs.readdirSync(playlistsDir).filter(f => f.endsWith('.json') && f !== '.meta.json');
  const meta = readMeta();
  res.json(files.map(f => {
    const name = f.replace('.json', '');
    return { name, locked: !!(meta[name] && meta[name].locked) };
  }));
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
  if (isLocked(req.params.name)) return res.status(403).json({ error: 'Playlist is locked' });
  const fp = join(playlistsDir, `${req.params.name}.json`);
  fs.writeFileSync(fp, JSON.stringify(req.body, null, 2));
  res.json({ ok: true });
});

app.post('/api/playlists/:name/add-song', (req, res) => {
  if (!validPlaylistName(req.params.name)) return res.status(400).json({ error: 'Invalid name' });
  if (isLocked(req.params.name)) return res.status(403).json({ error: 'Playlist is locked' });
  const fp = join(playlistsDir, `${req.params.name}.json`);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  const songs = JSON.parse(fs.readFileSync(fp, 'utf-8'));
  songs.push(req.body);
  fs.writeFileSync(fp, JSON.stringify(songs, null, 2));
  res.json({ ok: true });
});

app.patch('/api/playlists/:name/lock', (req, res) => {
  if (!validPlaylistName(req.params.name)) return res.status(400).json({ error: 'Invalid name' });
  const fp = join(playlistsDir, `${req.params.name}.json`);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  const meta = readMeta();
  if (!meta[req.params.name]) meta[req.params.name] = {};
  meta[req.params.name].locked = !meta[req.params.name].locked;
  writeMeta(meta);
  res.json({ ok: true, locked: meta[req.params.name].locked });
});

app.delete('/api/playlists/:name', (req, res) => {
  if (!validPlaylistName(req.params.name)) return res.status(400).json({ error: 'Invalid name' });
  if (isLocked(req.params.name)) return res.status(403).json({ error: 'Playlist is locked' });
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
  res.json({ autoClassify, provider, hasApiKey: !!key, songsDbPath, defaultVolume: defaultVol(), autoUpdate: process.env.AUTO_UPDATE === 'true' });
});

app.get('/api/update-check', (_req, res) => {
  res.json({ currentVersion: APP_VERSION, autoUpdate: process.env.AUTO_UPDATE === 'true', ...updateInfo });
});

app.post('/api/settings', async (req, res) => {
  const { apiKey, autoClassify: ac, provider, defaultVolume: dv, autoUpdate: au } = req.body || {};
  if (provider) saveEnvKey('AI_PROVIDER', provider);
  if (apiKey !== undefined && apiKey !== '') {
    const envKey = PROVIDER_KEY_MAP[provider || process.env.AI_PROVIDER || 'minimax'] || 'MINIMAX_API_KEY';
    saveEnvKey(envKey, apiKey);
  }
  if (ac !== undefined) { autoClassify = !!ac; saveEnvKey('AUTO_CLASSIFY', autoClassify ? 'true' : 'false'); }
  if (dv !== undefined) saveEnvKey('DEFAULT_VOLUME', String(Math.max(0, Math.min(100, parseInt(dv) || 70))));
  if (au !== undefined) saveEnvKey('AUTO_UPDATE', au ? 'true' : 'false');
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

app.get('/api/lyrics', async (req, res) => {
  const { videoId, title } = req.query;
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) return res.json({ found: false });
  const cache = loadLyricsCache();
  if (videoId in cache) {
    return res.json(cache[videoId] ? { found: true, lrc: cache[videoId] } : { found: false });
  }
  try {
    const lrc = await fetchNeteaseLyrics(title || '');
    cache[videoId] = lrc || null;
    saveLyricsCache(cache);
    return res.json(lrc ? { found: true, lrc } : { found: false });
  } catch (e) {
    console.error('[Lyrics]', e.message);
    return res.json({ found: false });
  }
});

app.post('/api/queue/reset-volumes', (_req, res) => {
  const vol = defaultVol();
  for (const room of rooms.values()) {
    room.queue.forEach(s => { s.volume = vol; });
    emitRoomState(room);
    if (room.currentIndex >= 0) io.to(room.id).emit('volume', vol);
  }
  res.json({ ok: true, volume: vol });
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
  const { videoId, title, singer, gender, language, era, thumbnail, volume } = req.body || {};
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
    volume: Math.max(0, Math.min(100, parseInt(volume) || defaultVol())),
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

app.delete('/api/catalog', (_req, res) => {
  saveSongsDb([]);
  io.emit('catalog-reloaded', []);
  res.json({ ok: true });
});

app.post('/api/catalog/import', (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Invalid data' });
  const valid = req.body.filter(s => s.ytId && /^[\w-]{11}$/.test(s.ytId));
  saveSongsDb(valid);
  io.emit('catalog-reloaded', valid);
  res.json({ ok: true, count: valid.length });
});

app.delete('/api/catalog/:ytId', (req, res) => {
  const ytId = req.params.ytId;
  if (!/^[\w-]{11}$/.test(ytId)) return res.status(400).json({ error: 'Invalid ID' });
  saveSongsDb(loadSongsDb().filter(s => s.ytId !== ytId));
  res.json({ ok: true });
});

// ─── Room API ────────────────────────────────────────────────────────
app.get('/api/rooms', (_req, res) => {
  res.json([...rooms.values()].map(r => ({
    id: r.id, name: r.name, color: r.color, queueLen: r.queue.length,
    currentIndex: r.currentIndex, createdAt: r.createdAt
  })));
});

app.post('/api/rooms', (req, res) => {
  const name = (req.body?.name || '').trim().slice(0, 40) || undefined;
  const color = req.body?.color || undefined;
  const room = createRoom(name, null, color);
  res.json({ id: room.id, name: room.name, color: room.color });
});

app.delete('/api/rooms/:id', (req, res) => {
  const id = req.params.id;
  if (id === 'default') return res.status(400).json({ error: '不可刪除預設房間' });
  if (!rooms.has(id)) return res.status(404).json({ error: 'Not found' });
  rooms.delete(id);
  io.to(id).emit('room-closed');
  res.json({ ok: true });
});

// ─── Socket.IO ───────────────────────────────────────────────────────
function emitPlay(room, song) {
  room.playingVideo = { videoId: song.videoId, title: song.title, author: song.author || '', thumbnail: song.thumbnail || '' };
  room.playStartTime = Date.now();
  io.to(room.id).emit('play', { videoId: song.videoId, volume: song.volume ?? 70 });
}

io.on('connection', socket => {
  let room = rooms.get('default');
  socket.join(room.id);
  socket.emit('state', { queue: room.queue, currentIndex: room.currentIndex, shuffleMode: room.shuffleMode });
  socket.emit('room-info', { id: room.id, name: room.name, color: room.color });

  socket.on('join-room', ({ roomId }) => {
    const target = rooms.get(roomId) || rooms.get('default');
    socket.leave(room.id);
    room = target;
    socket.join(room.id);
    socket.emit('state', { queue: room.queue, currentIndex: room.currentIndex, shuffleMode: room.shuffleMode });
    socket.emit('room-info', { id: room.id, name: room.name, color: room.color });
  });

  socket.on('add', video => {
    if (!video?.videoId || !/^[\w-]{11}$/.test(video.videoId)) return;
    const wasEmpty = room.currentIndex === -1;
    const catalogEntry = loadSongsDb().find(s => s.ytId === video.videoId);
    const lyricsExtra = {};
    if (catalogEntry?.lyricsEnabled === false) lyricsExtra.lyricsEnabled = false;
    if (catalogEntry?.lyricsOffset) lyricsExtra.lyricsOffset = catalogEntry.lyricsOffset;
    room.queue.push({ ...video, addedBy: video.addedBy || 'Guest', volume: video.volume ?? defaultVol(), ...lyricsExtra });
    if (room.currentIndex === -1) room.currentIndex = 0;
    emitRoomState(room);
    if (wasEmpty) emitPlay(room, room.queue[room.currentIndex]);
  });

  socket.on('add-next', video => {
    if (!video?.videoId || !/^[\w-]{11}$/.test(video.videoId)) return;
    const wasEmpty = room.currentIndex === -1;
    const insertAt = room.currentIndex === -1 ? 0 : room.currentIndex + 1;
    const catalogEntry2 = loadSongsDb().find(s => s.ytId === video.videoId);
    const lyricsExtra2 = {};
    if (catalogEntry2?.lyricsEnabled === false) lyricsExtra2.lyricsEnabled = false;
    if (catalogEntry2?.lyricsOffset) lyricsExtra2.lyricsOffset = catalogEntry2.lyricsOffset;
    room.queue.splice(insertAt, 0, { ...video, addedBy: video.addedBy || 'Guest', volume: video.volume ?? defaultVol(), ...lyricsExtra2 });
    if (room.currentIndex === -1) room.currentIndex = 0;
    emitRoomState(room);
    if (wasEmpty) emitPlay(room, room.queue[room.currentIndex]);
  });

  socket.on('song-volume', ({ idx, delta }) => {
    if (idx < 0 || idx >= room.queue.length) return;
    const cur = room.queue[idx].volume ?? defaultVol();
    room.queue[idx].volume = Math.max(0, Math.min(100, cur + delta));
    emitRoomState(room);
    if (idx === room.currentIndex) io.to(room.id).emit('volume', room.queue[idx].volume);
    const db = loadSongsDb();
    const catalogEntry = db.find(s => s.ytId === room.queue[idx].videoId);
    if (catalogEntry) { catalogEntry.volume = room.queue[idx].volume; saveSongsDb(db); io.emit('catalog-updated', catalogEntry); }
  });

  socket.on('remove', idx => {
    if (idx < 0 || idx >= room.queue.length) return;
    if (idx === room.currentIndex) return;
    room.queue.splice(idx, 1);
    if (room.queue.length === 0) { room.currentIndex = -1; }
    else if (idx < room.currentIndex) { room.currentIndex--; }
    emitRoomState(room);
  });

  socket.on('play-index', idx => {
    if (idx < 0 || idx >= room.queue.length || idx === room.currentIndex) return;
    checkPlayTime(room);
    if (room.currentIndex >= 0 && room.currentIndex < room.queue.length) {
      room.queue.splice(room.currentIndex, 1);
      if (idx > room.currentIndex) idx--;
    }
    const [song] = room.queue.splice(idx, 1);
    room.queue.unshift(song);
    room.currentIndex = 0;
    emitRoomState(room);
    emitPlay(room, room.queue[0]);
  });

  socket.on('next', () => {
    checkPlayTime(room);
    if (room.currentIndex >= 0 && room.currentIndex < room.queue.length) room.queue.splice(room.currentIndex, 1);
    if (room.queue.length === 0) {
      room.currentIndex = -1;
      emitRoomState(room);
      io.to(room.id).emit('stop');
    } else {
      if (room.currentIndex >= room.queue.length) room.currentIndex = 0;
      maybeShuffleNext(room);
      emitRoomState(room);
      emitPlay(room, room.queue[room.currentIndex]);
    }
  });

  socket.on('prev', () => {
    if (room.currentIndex >= 0 && room.queue[room.currentIndex]) emitPlay(room, room.queue[room.currentIndex]);
  });

  socket.on('replay', () => {
    if (room.currentIndex >= 0 && room.queue[room.currentIndex]) emitPlay(room, room.queue[room.currentIndex]);
  });

  socket.on('stop', () => {
    checkPlayTime(room);
    io.to(room.id).emit('stop');
  });

  socket.on('skip', () => {
    checkPlayTime(room);
    if (room.currentIndex >= 0 && room.currentIndex < room.queue.length) room.queue.splice(room.currentIndex, 1);
    if (room.queue.length === 0) {
      room.currentIndex = -1;
      emitRoomState(room);
      io.to(room.id).emit('stop');
    } else {
      if (room.currentIndex >= room.queue.length) room.currentIndex = 0;
      maybeShuffleNext(room);
      emitRoomState(room);
      emitPlay(room, room.queue[room.currentIndex]);
    }
  });

  socket.on('volume', val => {
    const v = Math.max(0, Math.min(100, Number(val)));
    if (!isNaN(v)) io.to(room.id).emit('volume', v);
  });

  socket.on('clear', () => {
    room.queue = [];
    room.currentIndex = -1;
    emitRoomState(room);
    io.to(room.id).emit('stop');
  });

  socket.on('reorder', ({ from, to }) => {
    if (from === to || from < 0 || from >= room.queue.length || to < 0 || to >= room.queue.length) return;
    if (from === room.currentIndex) return;
    const [item] = room.queue.splice(from, 1);
    room.queue.splice(to, 0, item);
    if (from < room.currentIndex && to >= room.currentIndex) room.currentIndex--;
    else if (from > room.currentIndex && to <= room.currentIndex) room.currentIndex++;
    emitRoomState(room);
  });

  socket.on('video-ended', () => {
    if (room.videoEndedTimer) return;
    room.videoEndedTimer = setTimeout(() => { room.videoEndedTimer = null; }, 3000);
    checkPlayTime(room);
    if (room.currentIndex >= 0 && room.currentIndex < room.queue.length) room.queue.splice(room.currentIndex, 1);
    if (room.queue.length === 0) {
      room.currentIndex = -1;
      emitRoomState(room);
      io.to(room.id).emit('loop');
    } else {
      if (room.currentIndex >= room.queue.length) room.currentIndex = 0;
      maybeShuffleNext(room);
      emitRoomState(room);
      emitPlay(room, room.queue[room.currentIndex]);
    }
  });

  socket.on('toggle-shuffle', () => {
    room.shuffleMode = !room.shuffleMode;
    emitRoomState(room);
  });

  socket.on('toggle-lyrics', () => {
    const song = room.queue[room.currentIndex];
    if (!song) return;
    song.lyricsEnabled = song.lyricsEnabled === false ? true : false;
    emitRoomState(room);
    // save preference to catalog
    const db = loadSongsDb();
    const entry = db.find(s => s.ytId === song.videoId);
    if (entry) { entry.lyricsEnabled = song.lyricsEnabled; saveSongsDb(db); }
  });

  socket.on('lyrics-offset', ({ idx, delta }) => {
    const i = (idx != null && idx >= 0) ? idx : room.currentIndex;
    if (i < 0 || i >= room.queue.length) return;
    room.queue[i].lyricsOffset = Math.round(((room.queue[i].lyricsOffset || 0) + delta) * 10) / 10;
    emitRoomState(room);
    // save offset to catalog
    const db = loadSongsDb();
    const entry = db.find(s => s.ytId === room.queue[i].videoId);
    if (entry) { entry.lyricsOffset = room.queue[i].lyricsOffset; saveSongsDb(db); }
  });

  socket.on('global-lyrics-offset', ({ delta }) => {
    room.globalLyricsOffset = Math.round(((room.globalLyricsOffset || 0) + delta) * 10) / 10;
    io.to(room.id).emit('global-lyrics-offset', room.globalLyricsOffset);
  });

  socket.on('edit-lyrics', ({ videoId, lrc }) => {
    if (!videoId || !/^[\w-]{11}$/.test(videoId)) return;
    const cache = loadLyricsCache();
    cache[videoId] = lrc || null;
    saveLyricsCache(cache);
    io.to(room.id).emit('lyrics-updated', { videoId, lrc: lrc || null });
  });

  socket.on('refresh-lyrics', async ({ videoId, title }) => {
    if (!videoId || !/^[\w-]{11}$/.test(videoId)) return;
    const cache = loadLyricsCache();
    delete cache[videoId];
    saveLyricsCache(cache);
    socket.emit('lyrics-refreshing', { videoId });
    try {
      const lrc = await fetchNeteaseLyrics(title || '');
      cache[videoId] = lrc || null;
      saveLyricsCache(cache);
      io.to(room.id).emit('lyrics-updated', { videoId, lrc: lrc || null });
    } catch (e) {
      io.to(room.id).emit('lyrics-updated', { videoId, lrc: null });
    }
  });
});

const PORT = 3000;
httpServer.listen(PORT, async () => {
  if (process.env.AUTO_UPDATE === 'true') checkForUpdates();
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
