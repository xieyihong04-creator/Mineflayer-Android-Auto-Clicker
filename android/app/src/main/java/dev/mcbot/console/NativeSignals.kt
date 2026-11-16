package dev.mcbot.console

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import androidx.core.content.ContextCompat

/**
 * All external signals come from the platform here, not from the page and not
 * from sysfs.
 *
 *  - ACTION_SCREEN_ON/OFF needs no permission and is delivered even when the
 *    WebView is hidden, which is exactly when Page Visibility stops being a
 *    trustworthy authority.
 *  - getCurrentThermalStatus() is OEM-calibrated and needs no baseline, so it
 *    is the primary heat signal; the sysfs delta in the Node core stays as a
 *    fallback for shells that do not report (returns 0 = NONE).
 *  - isPowerSaveMode() replaces `settings get global low_power`, which is not
 *    readable from Termux on this ROM.
 *  - ACTION_BATTERY_CHANGED (sticky) replaces BOTH sysfs and `termux-battery-status`.
 *    Measured on the target device: `/sys/class/power_supply` is DAC world
 *    readable but EACCES anyway - SELinux, permanent without root. Once Node
 *    moved into the app there was no Termux:API to fall back to, so battery
 *    would have been null forever and L3 (<10% disconnect) / L0 (<20%
 *    downgrade) would never fire. This receiver is the fix, and it is also why
 *    the app no longer needs Termux at all.
 */
class NativeSignals(private val context: Context, private val listener: Listener) {
    interface Listener {
        fun onScreenState(on: Boolean)
        fun onThermalStatus(status: Int)
        fun onPowerSave(on: Boolean)
        fun onBattery(reading: BatteryReading?)
    }

    /**
     * `level` is percent (0-100), `charging` follows the two-field rule
     * (EXTRA_PLUGGED and EXTRA_STATUS, conflict => not charging), `tempC` is
     * the battery temperature in Celsius (null when the ROM sends garbage).
     */
    data class BatteryReading(
        val level: Int?,
        val charging: Boolean?,
        val tempC: Double?,
        val chargeCounterUah: Long?,
        val cycleCount: Int?
    )

    private val powerManager =
        context.getSystemService(Context.POWER_SERVICE) as PowerManager
    private val batteryManager =
        context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
    private var receiver: android.content.BroadcastReceiver? = null
    private var thermalListener: PowerManager.OnThermalStatusChangedListener? = null

    /** Current values, for the initial `init` payload after page load. */
    val screenOn: Boolean get() = powerManager.isInteractive
    val thermal: Int? get() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) powerManager.currentThermalStatus else null
    val powerSave: Boolean get() = powerManager.isPowerSaveMode

    /** Sticky read of the last ACTION_BATTERY_CHANGED, no receiver needed. */
    fun batteryNow(): BatteryReading? = parseBattery(
        // A null receiver is the documented way to read a sticky broadcast and
        // needs no receiver flag on any API level.
        context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    )

    fun start() {
        if (receiver != null) return
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED)
            addAction(Intent.ACTION_BATTERY_CHANGED)
        }
        val r = object : android.content.BroadcastReceiver() {
            override fun onReceive(ctx: Context?, intent: Intent?) {
                when (intent?.action) {
                    Intent.ACTION_SCREEN_ON -> listener.onScreenState(true)
                    Intent.ACTION_SCREEN_OFF -> listener.onScreenState(false)
                    PowerManager.ACTION_POWER_SAVE_MODE_CHANGED -> listener.onPowerSave(powerManager.isPowerSaveMode)
                    Intent.ACTION_BATTERY_CHANGED -> listener.onBattery(parseBattery(intent))
                }
            }
        }
        receiver = r
        // Screen/power/battery are protected system broadcasts: NOT_EXPORTED
        // keeps other apps out and the system UID is still delivered.
        ContextCompat.registerReceiver(context, r, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        // Battery broadcasts only arrive on change; the sticky value is the
        // initial reading (and usually answers immediately on registration).
        batteryNow()?.let { listener.onBattery(it) }

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

    private fun parseBattery(intent: Intent?): BatteryReading? {
        if (intent == null) return null
        val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        val percent = if (level >= 0 && scale > 0) {
            ((level * 100f) / scale).toInt().coerceIn(0, 100)
        } else {
            null
        }

        // Two independent fields; a disagreement means "not charging" rather
        // than a guess (the same rule the sysfs path uses).
        val plugged = intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0
        val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        val statusSaysCharging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
            status == BatteryManager.BATTERY_STATUS_FULL
        val charging = when {
            status < 0 -> if (plugged) true else null
            else -> plugged && statusSaysCharging
        }

        val tenths = intent.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE)
        val tempC = if (tenths == Int.MIN_VALUE) null else tenths / 10.0
        // 0/absent and absurd values are ROM junk, not 0 C.
        val saneTemp = tempC?.takeIf { it > -30.0 && it < 100.0 }

        val counter = batteryManager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER)
            .takeIf { it > 0 }?.toLong()
        val cycle = if (Build.VERSION.SDK_INT >= 34) {
            // Cycle count ships as an extra in the broadcast; there is no
            // BATTERY_PROPERTY_CYCLE in this SDK. String constants are inlined
            // so reading it is safe on older ROMs too (absent -> -1).
            intent.getIntExtra(BatteryManager.EXTRA_CYCLE_COUNT, -1).takeIf { it > 0 }
        } else {
            null
        }
        return BatteryReading(percent, charging, saneTemp, counter, cycle)
    }
}
