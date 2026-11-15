package dev.mcbot.probe

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.ViewGroup
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.io.File
import java.io.FileOutputStream
import java.util.zip.ZipInputStream

/**
 * M3 probe host. Its only job: start libnode with probe.js and show the result.
 *
 * Deliberately NOT a service: the probe is a foreground experiment, and keeping
 * it dumb avoids accidentally building the step-3 product integration before
 * the probe has proven that mineflayer can connect inside nodejs-mobile.
 *
 * Launch:
 *   adb shell am start -n dev.mcbot.console.probe/.MainActivity \
 *     --es host 192.168.1.10 --ei port 25565 --es auth 0 --es user Probe
 */
class MainActivity : Activity() {
    private lateinit var output: TextView
    private val ui = Handler(Looper.getMainLooper())
    private var started = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val host = intent.getStringExtra("host") ?: "127.0.0.1"
        val port = intent.getIntExtra("port", 25565)
        val auth = if (intent.getStringExtra("auth") == "1") "1" else "0"
        val user = intent.getStringExtra("user") ?: "Probe"

        output = TextView(this).apply {
            setTextColor(0xFFE6EAF0.toInt())
            textSize = 12f
            setTextIsSelectable(true)
            text = "extracting node bundle…\n"
        }
        val open = Button(this).apply {
            text = "打开结果页面"
            setOnClickListener {
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("http://127.0.0.1:$STATUS_PORT/"))) }
            }
        }
        val scroll = ScrollView(this).apply {
            addView(output, ViewGroup.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF101418.toInt())
            setPadding(24, 24, 24, 24)
            gravity = Gravity.TOP
            addView(scroll, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
            addView(open, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
        }
        setContentView(root)

        val dir = File(filesDir, "node")
        Thread {
            try {
                ensureBundle(dir)
                ui.post { append("bundle ready: ${dir.absolutePath}\nstarting libnode…\n") }
                if (!started) {
                    started = true
                    val args = arrayOf("node", File(dir, "probe.js").absolutePath, host, port.toString(), auth, user)
                    startNodeWithArguments(args)
                    ui.post { append("\nnode exited with the value above\n") }
                }
            } catch (e: Throwable) {
                ui.post { append("FAILED: ${e.message}\n") }
            }
        }.start()
    }

    override fun onResume() {
        super.onResume()
        ui.postDelayed(poll, 1500)
    }

    override fun onPause() {
        ui.removeCallbacks(poll)
        super.onPause()
    }

    private val poll = object : Runnable {
        override fun run() {
            Thread {
                val text = runCatching {
                    val result = File(filesDir, "node/probe-result.json")
                    if (result.exists()) result.readText() else "no probe-result.json yet"
                }.getOrElse { "read failed: ${it.message}" }
                ui.post { output.text = text }
            }.start()
            ui.postDelayed(this, 2000)
        }
    }

    private fun append(line: String) {
        output.append(line)
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
