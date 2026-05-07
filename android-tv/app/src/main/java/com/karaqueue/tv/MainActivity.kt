package com.karaqueue.tv

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Context
import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private val prefs get() = getSharedPreferences("kq", Context.MODE_PRIVATE)

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        )

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
            webChromeClient = WebChromeClient()
            webViewClient = WebViewClient()
        }
        setContentView(webView)

        val serverUrl = prefs.getString("server_url", "") ?: ""
        if (serverUrl.isEmpty()) showSetup() else loadTv(serverUrl)
    }

    private fun loadTv(serverUrl: String) {
        val url = serverUrl.trimEnd('/')
        // Read tv.html from assets and replace server URL placeholder
        val html = assets.open("tv.html")
            .bufferedReader()
            .readText()
            .replace("__SERVER_URL__", url)

        // Use localhost:3000 as base URL so YouTube IFrame API works
        // (YouTube only allows autoplay on localhost origins)
        // Socket.IO and other resources use explicit server URL via __SERVER_URL__
        webView.loadDataWithBaseURL(
            "http://localhost:3000/",
            html,
            "text/html",
            "UTF-8",
            null
        )
    }

    private fun showSetup() {
        val saved = prefs.getString("server_url", "") ?: ""
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(64, 32, 64, 16)
        }
        val label = TextView(this).apply {
            text = "輸入 KaraQueue 伺服器地址（Mac 電腦 IP）："
            setTextColor(Color.DKGRAY)
            textSize = 14f
            setPadding(0, 0, 0, 12)
        }
        val input = EditText(this).apply {
            hint = "http://192.168.1.xx:3000"
            if (saved.isNotEmpty()) setText(saved)
        }
        layout.addView(label)
        layout.addView(input)

        AlertDialog.Builder(this)
            .setTitle("🎤 KaraQueue TV")
            .setView(layout)
            .setCancelable(false)
            .setPositiveButton("連接") { _, _ ->
                val url = input.text.toString().trim()
                if (url.isNotEmpty()) {
                    prefs.edit().putString("server_url", url).apply()
                    loadTv(url)
                } else {
                    showSetup()
                }
            }
            .show()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        // Back button shows settings (for TV remote back key)
        showSetup()
    }
}
