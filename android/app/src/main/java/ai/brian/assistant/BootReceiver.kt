package ai.brian.assistant

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

/** Restores background listening after a reboot when the user left it enabled. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val config = BrianSettings(context).load()
        if (!config.continuousListening) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
            !android.provider.Settings.canDrawOverlays(context)
        ) {
            // Background start from boot is only allowed for services the user
            // already enabled; the persistent notification explains the state.
        }
        runCatching { BrianService.start(context) }
    }
}
