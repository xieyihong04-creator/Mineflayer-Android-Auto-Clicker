package dev.mcbot.console

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.PowerManager
import androidx.core.content.ContextCompat

/**
 * M2 A4/P1: screen, thermal and power-save come from the platform, not the page.
 *
 *  - ACTION_SCREEN_ON/OFF needs no permission and is delivered even when the
 *    WebView is hidden, which is exactly when Page Visibility stops being a
 *    trustworthy authority.
 *  - getCurrentThermalStatus() is OEM-calibrated and needs no baseline, so it
 *    is the primary heat signal; the sysfs delta in the Node core stays as a
 *    fallback for shells that do not report (returns 0 = NONE).
 *  - isPowerSaveMode() replaces `settings get global low_power`, which is not
 *    readable from Termux on this ROM.
 */
class NativeSignals(private val context: Context, private val listener: Listener) {
    interface Listener {
        fun onScreenState(on: Boolean)
        fun onThermalStatus(status: Int)
        fun onPowerSave(on: Boolean)
    }

    private val powerManager =
        context.getSystemService(Context.POWER_SERVICE) as PowerManager
    private var receiver: android.content.BroadcastReceiver? = null
    private var thermalListener: PowerManager.OnThermalStatusChangedListener? = null

    /** Current values, for the initial `init` payload after page load. */
    val screenOn: Boolean get() = powerManager.isInteractive
    val thermal: Int? get() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) powerManager.currentThermalStatus else null
    val powerSave: Boolean get() = powerManager.isPowerSaveMode

    fun start() {
        if (receiver != null) return
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED)
        }
        val r = object : android.content.BroadcastReceiver() {
            override fun onReceive(ctx: Context?, intent: Intent?) {
                when (intent?.action) {
                    Intent.ACTION_SCREEN_ON -> listener.onScreenState(true)
                    Intent.ACTION_SCREEN_OFF -> listener.onScreenState(false)
                    PowerManager.ACTION_POWER_SAVE_MODE_CHANGED -> listener.onPowerSave(powerManager.isPowerSaveMode)
                }
            }
        }
        receiver = r
        // Screen/power-save are protected system broadcasts: NOT_EXPORTED keeps
        // other apps out and the system UID is still delivered.
        ContextCompat.registerReceiver(context, r, filter, ContextCompat.RECEIVER_NOT_EXPORTED)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val tl = PowerManager.OnThermalStatusChangedListener { status ->
                listener.onThermalStatus(status)
            }
            thermalListener = tl
            powerManager.addThermalStatusListener(ContextCompat.getMainExecutor(context), tl)
        }
    }

    fun stop() {
        receiver?.let { context.unregisterReceiver(it) }
        receiver = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            thermalListener?.let { powerManager.removeThermalStatusListener(it) }
        }
        thermalListener = null
    }
}
