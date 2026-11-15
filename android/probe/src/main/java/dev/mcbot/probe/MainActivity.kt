package dev.mcbot.probe

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import android.widget.TextView
import java.io.File
import java.io.FileOutputStream
import java.util.zip.ZipInputStream

/**
 * M3 probe host. Its only job: start libnode with probe.js, then show the page
 * that libnode serves on 127.0.0.1:3999 inside a WebView.
 *
 * The screen used to dump raw JSON, which is useless on a phone. The real UI is
 * the page in probe.js (form + verdict + steps); this WebView exists so the app
 * opens straight into it instead of asking the user to find a browser.
 *
 * Deliberately NOT a service: the probe is a foreground experiment, and keeping
 * it dumb avoids accidentally building the step-3 product integration before
 * the probe has proven that mineflayer can connect inside nodejs-mobile.
 *
 * Launch (all optional, the page can override them):
 *   adb shell am start -n dev.mcbot.console.probe/.MainActivity \
 *     --es host 192.168.1.10 --ei port 25565 --es auth 0 --es user Probe
 */
class MainActivity : Activity() {
    private lateinit var statusBar: TextView
    private lateinit var web: WebView
    private val ui = Handler(Looper.getMainLooper())
    private var started = false
    private var retries = 0

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val host = intent.getStringExtra("host") ?: "127.0.0.1"
        val port = intent.getIntExtra("port", 25565)
        val auth = if (intent.getStringExtra("auth") == "1") "1" else "0"
        val user = intent.getStringExtra("user") ?: "Probe"

        statusBar = TextView(this).apply {
            setTextColor(0xFF8E9BAB.toInt())
            textSize = 12f
            setPadding(32, 24, 32, 16)
            text = "正在解压 node 包…"
        }
        web = WebView(this).apply {
            setBackgroundColor(0xFF0E1116.toInt())
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.textZoom = 100
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String?) {
                    retries = 0
                    statusBar.text = "libnode 已就绪 · 127.0.0.1:$STATUS_PORT"
                }

                override fun onReceivedError(
                    view: WebView,
                    request: android.webkit.WebResourceRequest,
                    error: android.webkit.WebResourceError
                ) {
                    // libnode needs a moment to bind the port; retry from the UI thread.
                    if (retries++ < 20) {
                        statusBar.text = "等待 libnode 监听 $STATUS_PORT…（${retries}/20）"
                        ui.postDelayed({ view.loadUrl(pageUrl()) }, 700)
                    } else {
                        statusBar.text = "libnode 没有起来：看看上方日志或 adb logcat"
                    }
                }
            }
        }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF0E1116.toInt())
            addView(statusBar, LinearLayout.LayoutParams(MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
            addView(web, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
        }
        setContentView(root)

        val dir = File(filesDir, "node")
        Thread {
            try {
                ensureBundle(dir)
                ui.post { statusBar.text = "node 包已就绪，启动 libnode…" }
                if (!started) {
                    started = true
                    val args = arrayOf("node", File(dir, "probe.js").absolutePath, host, port.toString(), auth, user)
                    // Blocks this thread until node exits; the UI stays alive.
                    val code = startNodeWithArguments(args)
                    ui.post { statusBar.text = "libnode 已退出（$code）" }
                }
            } catch (e: Throwable) {
                ui.post { statusBar.text = "启动失败：${e.message}" }
            }
        }.start()

        // Start polling immediately; onReceivedError drives the retries.
        ui.postDelayed({ web.loadUrl(pageUrl()) }, 400)
    }

    private fun pageUrl() = "http://127.0.0.1:$STATUS_PORT/"

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    /** assets/node.zip -> filesDir/node (probe.js + pruned node_modules). */
    private fun ensureBundle(dest: File) {
        val stamp = File(dest, ".bundle-ok")
        if (stamp.exists()) return
        dest.mkdirs()
        assets.open("node.zip").use { raw ->
            ZipInputStream(raw.buffered()).use { zin ->
                while (true) {
                    val entry = zin.nextEntry ?: break
                    val target = File(dest, entry.name)
                    if (entry.isDirectory) {
                        target.mkdirs()
                    } else {
                        target.parentFile?.mkdirs()
                        FileOutputStream(target).use { zin.copyTo(it) }
                    }
                    zin.closeEntry()
                }
            }
        }
        stamp.writeText("ok")
    }

    /**
     * nodejs-mobile allows exactly one runtime per process and does not support
     * restarting it, so this is called once (see `started`).
     */
    private external fun startNodeWithArguments(arguments: Array<String>): Int

    companion object {
        private const val STATUS_PORT = 3999
        init {
            System.loadLibrary("native-lib")
            // Loaded explicitly too: libnode.so is what node::Start lives in.
            System.loadLibrary("node")
        }
    }
}
