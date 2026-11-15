package dev.mcbot.console

import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import android.os.Process
import java.io.File

/**
 * M3 step 3: the bot core, in its own process.
 *
 * nodejs-mobile allows one Node runtime per process and cannot restart it, so
 * the runtime must never share a process with the UI: a crash here would take
 * the WebView (and the whole app) down with it. Running in `:node` makes a bot
 * crash a *process* crash - the watchdog in BridgeService starts this service
 * again, a completely fresh process gets a fresh runtime, and the page
 * reconnects over the mirrored WebSocket on 127.0.0.1.
 *
 * This service is deliberately not foreground: BridgeService (main process,
 * specialUse FGS) is what keeps the app alive, and it also supervises this
 * process. Starting a second FGS would mean two permanent notifications.
 */
class NodeService : Service() {
    private var started = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (started) return START_STICKY
        started = true

        Thread {
            val code = try {
                val dir = NodeBundle.ensure(this)
                mark("bundle ready: ${dir.absolutePath}")
                // Blocks this thread until node exits. args[0] is argv[0].
                startNodeWithArguments(
                    arrayOf(
                        "node",
                        File(dir, NodeBundle.ENTRY).absolutePath,
                        filesDir.absolutePath
                    )
                )
            } catch (t: Throwable) {
                mark("fatal: ${t.message}")
                -1
            }
            // Node exited. It cannot be restarted inside this process (the
            // runtime is single-use), so take the process down and let the
            // main-process watchdog start a clean one.
            mark("node exited with $code")
            Process.killProcess(Process.myPid())
        }.start()

        return START_STICKY
    }

    /** Tiny boot log: stdout never reaches logcat under nodejs-mobile. */
    private fun mark(line: String) {
        try {
            val logs = File(filesDir, "logs").apply { mkdirs() }
            File(logs, "node-boot.log").appendText("${java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS", java.util.Locale.US).format(java.util.Date())} $line\n")
        } catch (_: Throwable) {
        }
    }

    /**
     * nodejs-mobile allows exactly one runtime per process, so this is guarded
     * by `started` and the process is killed when node returns.
     */
    private external fun startNodeWithArguments(arguments: Array<String>): Int

    companion object {
        init {
            System.loadLibrary("native-lib")
            // Loaded explicitly too: libnode.so is what node::Start lives in.
            System.loadLibrary("node")
        }

        fun start(context: Context) {
            // startService is fine while the app holds a foreground service
            // (BridgeService); it is also what restarts a process the system
            // killed, because START_STICKY re-delivers a null intent.
            try {
                context.startService(Intent(context, NodeService::class.java))
            } catch (_: IllegalStateException) {
                // App fully backgrounded and FGS not up yet: BridgeService will
                // start us once it is.
            }
        }
    }
}
