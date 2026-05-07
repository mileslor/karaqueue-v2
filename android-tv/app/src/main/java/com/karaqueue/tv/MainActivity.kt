package com.karaqueue.tv

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Context
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import kotlinx.coroutines.*
import java.net.HttpURLConnection
import java.net.NetworkInterface
import java.net.URL

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var statusText: TextView
    private val prefs get() = getSharedPreferences("kq", Context.MODE_PRIVATE)
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        )

        val root = FrameLayout(this)

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
            webChromeClient = WebChromeClient()
            webViewClient = WebViewClient()
        }
        root.addView(webView, FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)

        statusText = TextView(this).apply {
            setBackgroundColor(Color.parseColor("#CC000000"))
            setTextColor(Color.WHITE)
            textSize = 18f
            gravity = Gravity.CENTER
            visibility = View.GONE
        }
        root.addView(statusText, FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)

        setContentView(root)

        val saved = prefs.getString("server_url", "") ?: ""
        if (saved.isNotEmpty()) loadTv(saved) else startDiscovery()
    }

    private fun startDiscovery() {
        statusText.text = "🔍 搜尋 KaraQueue 伺服器中..."
        statusText.visibility = View.VISIBLE

        scope.launch {
            val found = withContext(Dispatchers.IO) { findServer() }
            statusText.visibility = View.GONE
            if (found != null) {
                prefs.edit().putString("server_url", found).apply()
                loadTv(found)
            } else {
                showSetup("")
            }
        }
    }

    private suspend fun findServer(): String? {
        val localIp = getLocalIp() ?: return null
        val subnet = localIp.substringBeforeLast(".")

        val jobs = (1..254).map { i ->
            CoroutineScope(Dispatchers.IO).async {
                val ip = "$subnet.$i"
                if (ip == localIp) return@async null
                try {
                    val conn = URL("http://$ip:3000/api/ping").openConnection() as HttpURLConnection
                    conn.connectTimeout = 400
                    conn.readTimeout = 400
                    conn.connect()
                    val ok = conn.responseCode == 200
                    conn.disconnect()
                    if (ok) "http://$ip:3000" else null
                } catch (e: Exception) { null }
            }
        }

        // Return first responding IP; cancel rest
        for (job in jobs) {
            val result = job.await()
            if (result != null) {
                jobs.forEach { it.cancel() }
                return result
            }
        }
        return null
    }

    private fun getLocalIp(): String? {
        return NetworkInterface.getNetworkInterfaces()?.toList()
            ?.flatMap { it.inetAddresses.toList() }
            ?.firstOrNull { !it.isLoopbackAddress && it.hostAddress?.contains('.') == true }
            ?.hostAddress
    }

    private fun loadTv(serverUrl: String) {
        val url = serverUrl.trimEnd('/')
        val html = assets.open("tv.html")
            .bufferedReader()
            .readText()
            .replace("__SERVER_URL__", url)
        webView.loadDataWithBaseURL(
            "http://localhost:3000/",
            html, "text/html", "UTF-8", null
        )
    }

    private fun showSetup(current: String) {
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(64, 32, 64, 16)
        }
        val label = TextView(this).apply {
            text = "輸入 KaraQueue 伺服器地址："
            setTextColor(Color.DKGRAY)
            textSize = 14f
            setPadding(0, 0, 0, 12)
        }
        val input = EditText(this).apply {
            hint = "http://192.168.1.xx:3000"
            setText(current)
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
                    showSetup("")
                }
            }
            .setNeutralButton("重新搜尋") { _, _ -> startDiscovery() }
            .show()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        val saved = prefs.getString("server_url", "") ?: ""
        showSetup(saved)
    }

    override fun onDestroy() {
        super.onDestroy()
        scope.cancel()
    }
}
