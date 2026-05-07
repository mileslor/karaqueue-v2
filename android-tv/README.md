# KaraQueue TV — Android APK

將 KaraQueue TV 畫面安裝入 Android TV 盒子，繞過 YouTube localhost 限制。

## 原理

APK 用 `loadDataWithBaseURL("http://localhost:3000/")` 令 WebView 以 `localhost` 為 origin，
YouTube IFrame API 接受 localhost autoplay。Socket.IO 直連 Mac 伺服器 IP。

## 需要

- Android Studio（免費，下載：developer.android.com/studio）
- Android TV 盒子（Android 6.0+）
- Mac 要開緊 KaraQueue server（`node server.js`）

## Build 步驟

1. 用 Android Studio 開啟 `android-tv/` 資料夾
2. 等 Gradle sync 完成
3. Build → Build APK(s) → 等幾分鐘
4. APK 喺 `app/build/outputs/apk/debug/app-debug.apk`

## 安裝到電視盒

**USB 方式：**
1. 將 APK 複製到 USB 手指
2. 插入 TV 盒，用檔案管理員安裝（需要先開「未知來源」）

**ADB 方式（盒子開 ADB debugging）：**
```bash
adb connect 192.168.1.xx
adb install app-debug.apk
```

## 首次使用

開 App 後會彈出設定畫面，輸入 Mac 的 IP 同 port，例如：
```
http://192.168.1.74:3000
```
之後按「返回鍵」可重新設定 IP。
