package dev.mcbot.console

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.Gravity
import android.view.ViewGroup
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * M2 shell: a WebView pointed at the Node core on 127.0.0.1 plus a foreground
 * service that keeps the process alive with the screen off.
 *
 * The Node core owns the protocol and the tier logic; this app only
 *   1. pre-checks /api/health (and protoVersion) so a missing `npm start`
 *      is explained instead of showing a blank page,
 *   2. injects the native signals into the page via window.mcbotNative,
 *   3. walks the user through the HyperOS background restrictions.
 *
 * It never calls webView.onPause()/onStop Loading(): JS must keep running while
 * the activity is stopped, otherwise the 45s screen heartbeat dies exactly when
 * the screen goes off.
 */
class MainActivity : Activity(), NativeSignals.Listener {
    private lateinit var webView: WebView
    private lateinit var overlay: LinearLayout
    private lateinit var overlayText: TextView
    private lateinit var retryButton: Button
    private val ui = Handler(Looper.getMainLooper())

    private lateinit var signals: NativeSignals
    private var pageReady = false
    private var port = DEFAULT_PORT
    private var lastScreen = false
    private var lastThermal: Int? = null
    private var lastPowerSave: Boolean? = null
    private var lastBattery: NativeSignals.BatteryReading? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        port = intent.getIntExtra(EXTRA_PORT, prefs().getInt(PREF_PORT, DEFAULT_PORT))
            .let { if (it in 1024..65535) it else DEFAULT_PORT }

        val root = FrameLayout(this)
        webView = WebView(this)
        webView.setBackgroundColor(0xFF101418.toInt())
        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            cacheMode = WebSettings.LOAD_NO_CACHE
            // The page is local; nothing else should ever load inside it.
            setGeolocationEnabled(false)
        }
        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                pageReady = true
                pushInit()
            }
        }
        root.addView(webView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))

        overlay = buildOverlay()
        root.addView(overlay, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        setContentView(root)

        // Registered for the whole activity lifetime, not onStart: the screen
        // broadcast must still arrive after the activity is stopped.
        signals = NativeSignals(this, this)
        signals.start()
        BridgeService.start(this)
        ui.postDelayed(heartbeat, HEARTBEAT_MS)

        askNotifications()
        askBatteryExemptionOnce()
        loadWhenCoreUp()
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        val requested = intent?.getIntExtra(EXTRA_PORT, 0) ?: 0
        if (requested in 1024..65535 && requested != port) {
            port = requested
            prefs().edit().putInt(PREF_PORT, requested).apply()
            pageReady = false
            loadWhenCoreUp()
        }
    }

    override fun onDestroy() {
        ui.removeCallbacksAndMessages(null)
        signals.stop()
        webView.destroy()
        super.onDestroy()
    }

    // ------------------------------------------------------------- native -> JS

    override fun onScreenState(on: Boolean) {
        lastScreen = on
        js(jsCall("screen($on)"))
    }

    override fun onThermalStatus(status: Int) {
        lastThermal = status
        js(jsCall("thermal($status)"))
    }

    override fun onPowerSave(on: Boolean) {
        lastPowerSave = on
        js(jsCall("powerSave($on)"))
    }

    /**
     * The sticky battery broadcast is the ONLY battery source once Node lives
     * inside the app: sysfs is SELinux-denied and Termux:API may not exist.
     * Push on every change; the 60 s heartbeat re-sends it so the core's
     * 5-minute staleness window never expires while the shell is alive.
     */
    override fun onBattery(reading: NativeSignals.BatteryReading?) {
        lastBattery = reading
        val level = reading?.level ?: return
        js(jsCall("battery(${batteryArgs(reading, level)})"))
    }

    private fun pushInit() {
        lastScreen = signals.screenOn
        lastThermal = signals.thermal
        lastPowerSave = signals.powerSave
        lastBattery = signals.batteryNow()
        val thermal = lastThermal?.toString() ?: "null"
        val battery = lastBattery?.let { b ->
            val level = b.level
            if (level == null) "null" else "{level:$level,charging:${b.charging},tempC:${b.tempC},chargeCounterUah:${b.chargeCounterUah},cycle:${b.cycleCount}}"
        } ?: "null"
        js(jsCall("init({screenOn:$lastScreen,thermal:$thermal,powerSave:$lastPowerSave,battery:$battery})"))
    }

    /** `level, charging, tempC, chargeCounterUah, cycle` as a JS argument list. */
    private fun batteryArgs(reading: NativeSignals.BatteryReading, level: Int): String =
        "$level,${reading.charging},${reading.tempC},${reading.chargeCounterUah},${reading.cycleCount}"

    /**
     * The core treats a native reading as stale after 5 minutes (so a dead app
     * cannot pin the tier). Thermal status rarely changes, so re-send it: an
     * unchanged value is still proof that the shell is alive. Battery level
     * drifts slowly too, and its heartbeat is what keeps L3 alive all night.
     */
    private val heartbeat = object : Runnable {
        override fun run() {
            if (pageReady) {
                lastThermal?.let { js(jsCall("thermal($it)")) }
                lastPowerSave?.let { js(jsCall("powerSave($it)")) }
                lastBattery?.level?.let { level ->
                    js(jsCall("battery(${batteryArgs(lastBattery!!, level)})"))
                }
            }
            ui.postDelayed(this, HEARTBEAT_MS)
        }
    }

    private fun jsCall(call: String) = "try{window.mcbotNative&&window.mcbotNative.$call}catch(e){}"

    private fun js(code: String) {
        if (!pageReady) return
        webView.post { webView.evaluateJavascript(code, null) }
    }

    // ---------------------------------------------------------------- core gate

    /**
     * Since step 3 the core is in this APK (process `:node`), started by
     * BridgeService. First launch extracts ~130 MB of JS + minecraft-data and
     * then boots Node, which takes a while on a phone - so poll instead of
     * showing "start npm in Termux" once and giving up.
     */
    private fun loadWhenCoreUp(attempt: Int = 0) {
        if (attempt == 0) {
            showOverlay(getString(R.string.core_waiting_hint), retryEnabled = false)
        } else {
            showOverlay(getString(R.string.core_starting, attempt, CORE_WAIT_TRIES), retryEnabled = true)
        }
        Thread {
            val health = probeHealth()
            ui.post {
                if (health == null) {
                    if (attempt < CORE_WAIT_TRIES) {
                        ui.postDelayed({ loadWhenCoreUp(attempt + 1) }, CORE_POLL_MS)
                    } else {
                        showOverlay(getString(R.string.core_waiting, port), retryEnabled = true)
                    }
                    return@post
                }
                val version = health.optInt("protoVersion", -1)
                if (version != PROTO_VERSION) {
                    showOverlay(getString(R.string.proto_mismatch, version, PROTO_VERSION), retryEnabled = true)
                    return@post
                }
                overlay.visibility = LinearLayout.GONE
                webView.loadUrl("http://127.0.0.1:$port/")
            }
        }.start()
    }

    private fun probeHealth(): JSONObject? = try {
        val conn = URL("http://127.0.0.1:$port/api/health").openConnection() as HttpURLConnection
        conn.connectTimeout = 1500
        conn.readTimeout = 1500
        val body = conn.inputStream.bufferedReader().use { it.readText() }
        conn.disconnect()
        JSONObject(body)
    } catch (e: Exception) {
        null
    }

    // --------------------------------------------------------------- overlay UI

    private fun buildOverlay(): LinearLayout {
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(0xFF101418.toInt())
            setPadding(48, 48, 48, 48)
        }
        overlayText = TextView(this).apply {
            setTextColor(0xFFE6EAF0.toInt())
            textSize = 14f
            gravity = Gravity.CENTER
        }
        box.addView(overlayText, LinearLayout.LayoutParams(MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
        }
        retryButton = Button(this).apply {
            text = getString(R.string.retry)
            setOnClickListener { loadWhenCoreUp() }
        }
        val guide = Button(this).apply {
            text = getString(R.string.hyperos_guide)
            setOnClickListener { showHyperosGuide() }
        }
        row.addView(retryButton)
        row.addView(guide)
        box.addView(row, LinearLayout.LayoutParams(MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        return box
    }

    private fun showOverlay(message: String, retryEnabled: Boolean) {
        overlay.visibility = LinearLayout.VISIBLE
        overlayText.text = message
        retryButton.isEnabled = retryEnabled
    }

    private fun showHyperosGuide() {
        AlertDialog.Builder(this)
            .setTitle(R.string.hyperos_guide)
            .setMessage(R.string.hyperos_body)
            .setPositiveButton(R.string.open_app_settings) { _, _ -> openAppDetails(packageName) }
            .setNegativeButton(R.string.close, null)
            .show()
    }

    private fun openAppDetails(pkg: String) {
        try {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$pkg")))
        } catch (e: Exception) {
            // HyperOS hides this page for some builds; the settings root is a
            // usable manual fallback.
            try {
                startActivity(Intent(Settings.ACTION_SETTINGS))
            } catch (_: Exception) {
            }
        }
    }

    // ---------------------------------------------------------------- permissions

    private fun askNotifications() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFICATIONS)
    }

    /** A2: once, so HyperOS cannot freeze the app (and the bot) while the screen is off. */
    private fun askBatteryExemptionOnce() {
        if (prefs().getBoolean(PREF_BATTERY_ASKED, false)) return
        prefs().edit().putBoolean(PREF_BATTERY_ASKED, true).apply()
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        if (pm.isIgnoringBatteryOptimizations(packageName)) return
        try {
            startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
            )
        } catch (e: Exception) {
            openAppDetails(packageName)
        }
    }

    private fun prefs() = getSharedPreferences("shell", MODE_PRIVATE)

    companion object {
        const val DEFAULT_PORT = 8765
        const val PROTO_VERSION = 1
        private const val EXTRA_PORT = "port"
        private const val PREF_PORT = "port"
        private const val PREF_BATTERY_ASKED = "batteryAsked"
        private const val REQ_NOTIFICATIONS = 41
        private const val HEARTBEAT_MS = 60000L
        // First launch: extract the bundle + boot Node before /api/health answers.
        private const val CORE_POLL_MS = 1500L
        private const val CORE_WAIT_TRIES = 120
    }
}
