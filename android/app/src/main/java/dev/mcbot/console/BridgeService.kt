package dev.mcbot.console

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.net.HttpURLConnection
import java.net.URL

/**
 * M2 A1 + M3 step 3: the foreground service that owns the app's life.
 *
 * `dataSync` is forbidden here on purpose: Android 15 caps it at 6h per 24h and
 * would silently stop the shell overnight. `specialUse` has no time cap, but it
 * must declare a subtype property in the manifest (see AndroidManifest.xml).
 *
 * Since step 3 it has a second job: supervising the Node core. Node runs in the
 * `:node` process (NodeService) because nodejs-mobile cannot restart a runtime
 * in-process. This service is the one thing guaranteed to stay alive, so it
 * starts that process and, if /api/health stops answering, starts it again -
 * a fresh process gets a fresh Node runtime. The WebView never has to know:
 * the page reconnects over the M1 WebSocket by itself.
 */
class BridgeService : Service() {
    private val ui = Handler(Looper.getMainLooper())
    private var consecutiveFailures = 0
    private var startedAt = 0L
    private var lastRestartAt = 0L
    private var restarts = 0
    // Exhaustion is terminal for this watchdog run: keeping retries alive all
    // night would look like work while the bot is actually dead. Opening the
    // app (onStartCommand) clears it and starts the core again by hand.
    private var watching = false
    private var exhausted = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, getString(R.string.fgs_channel), NotificationManager.IMPORTANCE_LOW).apply {
                description = getString(R.string.fgs_channel_desc)
                setShowBadge(false)
            }
        )
        manager.createNotificationChannel(
            NotificationChannel(ALERT_CHANNEL_ID, getString(R.string.alert_channel), NotificationManager.IMPORTANCE_HIGH).apply {
                description = getString(R.string.alert_channel_desc)
                setShowBadge(true)
            }
        )
        startedAt = SystemClock.elapsedRealtime()
        NodeService.start(this)
        startWatchdog()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val tap = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(getString(R.string.fgs_title))
            .setContentText(getString(R.string.fgs_text))
            .setContentIntent(tap)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFY_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFY_ID, notification)
        }
        // A sticky restart of this service must also revive the core. Opening
        // the app after the restart cap was hit is the manual recovery path.
        if (exhausted) {
            exhausted = false
            restarts = 0
            consecutiveFailures = 0
            startedAt = SystemClock.elapsedRealtime()
        }
        NodeService.start(this)
        startWatchdog()
        return START_STICKY
    }

    override fun onDestroy() {
        ui.removeCallbacksAndMessages(null)
        watching = false
        super.onDestroy()
    }

    private fun startWatchdog() {
        if (watching) return
        watching = true
        ui.postDelayed(watchdog, WATCH_INTERVAL_MS)
    }

    /**
     * Four missed 15 s checks (a minute of silence) after a 90 s grace period
     * count as "the core is gone". The grace covers the first launch, where
     * ~130 MB of JS and minecraft-data have to be extracted before Node even
     * starts.
     *
     * After MAX_RESTARTS the core is a code bug, not a transient kill: post an
     * explicit alert and STOP. Silent surrender would look exactly like a
     * healthy night while the bot is actually offline.
     */
    private val watchdog = object : Runnable {
        override fun run() {
            Thread {
                val healthy = healthOk(port())
                ui.post {
                    if (healthy) {
                        consecutiveFailures = 0
                    } else {
                        consecutiveFailures += 1
                        val now = SystemClock.elapsedRealtime()
                        val graceOver = now - startedAt > STARTUP_GRACE_MS
                        val coolEnough = now - lastRestartAt > MIN_RESTART_INTERVAL_MS
                        if (graceOver && coolEnough && consecutiveFailures >= 4) {
                            if (restarts >= MAX_RESTARTS) {
                                alertExhausted()
                                return@post
                            }
                            consecutiveFailures = 0
                            restarts += 1
                            lastRestartAt = now
                            NodeService.start(this@BridgeService)
                        }
                    }
                    ui.postDelayed(this, WATCH_INTERVAL_MS)
                }
            }.start()
        }
    }

    private fun alertExhausted() {
        if (exhausted) return
        exhausted = true
        watching = false
        ui.removeCallbacks(watchdog)
        val tap = PendingIntent.getActivity(
            this,
            1,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        val alert = NotificationCompat.Builder(this, ALERT_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(getString(R.string.restart_limit_title))
            .setContentText(getString(R.string.restart_limit_text, restarts))
            .setStyle(NotificationCompat.BigTextStyle().bigText(getString(R.string.restart_limit_text, restarts)))
            .setContentIntent(tap)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        try {
            manager.notify(ALERT_NOTIFY_ID, alert)
        } catch (_: SecurityException) {
            // Notifications revoked: the alert cannot be shown, but stopping is
            // still correct - and the user will see the dead HUD when they open.
        }
    }

    /** Same prefs key MainActivity writes when an explicit port is passed. */
    private fun port(): Int {
        val stored = getSharedPreferences("shell", MODE_PRIVATE).getInt("port", MainActivity.DEFAULT_PORT)
        return if (stored in 1024..65535) stored else MainActivity.DEFAULT_PORT
    }

    private fun healthOk(port: Int): Boolean = try {
        val conn = URL("http://127.0.0.1:$port/api/health").openConnection() as HttpURLConnection
        conn.connectTimeout = 1500
        conn.readTimeout = 1500
        conn.inputStream.use { it.readBytes() }
        conn.disconnect()
        true
    } catch (_: Exception) {
        false
    }

    companion object {
        private const val CHANNEL_ID = "bridge"
        private const val ALERT_CHANNEL_ID = "bridge-alert"
        private const val NOTIFY_ID = 1001
        private const val ALERT_NOTIFY_ID = 1002
        private const val WATCH_INTERVAL_MS = 15000L
        private const val STARTUP_GRACE_MS = 90000L
        private const val MIN_RESTART_INTERVAL_MS = 60000L
        // A core that keeps dying is a code bug, not a transient kill: keep the
        // app honest instead of restarting in a loop all night.
        private const val MAX_RESTARTS = 10

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, BridgeService::class.java))
        }
    }
}
