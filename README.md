# KaraQueue v2 🎤

本地 WiFi YouTube KTV 點歌系統。主機開 Server，其他裝置用瀏覽器或 App 點歌，電視全屏播放 YouTube。

---

## 下載

### 🖥️ Server（主機必裝）
要喺本地 WiFi 跑 Server，先安裝 [Node.js 18+](https://nodejs.org)，然後：

```bash
git clone https://github.com/mileslor/karaqueue-v2.git
cd karaqueue-v2
npm install
node server.js
```

啟動後主機係 `http://localhost:3000`，其他裝置用 IP 存取。

Server **本身就係完整系統**，唔需要任何 TV 客戶端 App 都可以運作——只要喺電視瀏覽器開 `http://<主機IP>:3000/tv` 即可。

---

### 📺 TV 客戶端 App（可選）

TV App 可以喺任何裝置上面全屏播放 YouTube，解決瀏覽器直接用 IP 播唔到的問題（YouTube 只允許 `localhost` 來源自動播放）。

| 平台 | 下載 |
|------|------|
| 🍎 **Mac** (Apple Silicon) | [KaraQueue TV arm64.dmg](https://github.com/mileslor/karaqueue-v2/releases/latest) |
| 🍎 **Mac** (Intel) | [KaraQueue TV.dmg](https://github.com/mileslor/karaqueue-v2/releases/latest) |
| 🪟 **Windows** | [KaraQueue TV Setup.exe](https://github.com/mileslor/karaqueue-v2/releases/latest) |
| 🐧 **Linux / Steam Deck** | [KaraQueue TV.AppImage](https://github.com/mileslor/karaqueue-v2/releases/latest) |
| 🤖 **Android TV** | [KaraQueueTV-debug.apk](https://github.com/mileslor/karaqueue-v2/releases/latest) |

---

## 使用說明

```
主機（Mac Mini）
  └── node server.js          ← 主系統，處理 Queue + 搜尋
  
電視 / 播放裝置
  ├── Android TV APK          ← 推薦，全屏 YouTube
  ├── KaraQueue TV App        ← Mac/Win/Linux/Steam Deck
  └── 瀏覽器開 /tv            ← 備用（需同一機器）

手機點歌
  └── 瀏覽器開 http://<IP>:3000/remote
  
桌面控制台
  └── 瀏覽器開 http://<IP>:3000
```

### 多房間
- 按 🏠 房間按鈕可以切換/新增房間
- 每個房間獨立 Queue，可以同時多組人 KTV
- TV App 開啟時揀房間，或直接開 `/tv?room=<房間ID>`

### 歌曲分類 AI
設定頁 `/settings` 可以配置 AI API Key，自動分類歌手/性別/語言/年代。
支援 MiniMax / OpenAI / Gemini / Claude。

---

## 技術架構

- **Server**：Node.js + Express + Socket.io
- **播放**：YouTube IFrame Player API（僅限 `localhost` 來源）
- **搜尋**：Invidious API（公共實例，無需 YouTube API Key）
- **歌曲庫**：JSON 檔案，AI 自動分類
- **TV App**：Electron + 內置 HTTP/WebSocket Proxy（將 IP 流量轉到 localhost）
- **Android APK**：WebView `loadDataWithBaseURL("http://localhost/")` 繞過來源限制
