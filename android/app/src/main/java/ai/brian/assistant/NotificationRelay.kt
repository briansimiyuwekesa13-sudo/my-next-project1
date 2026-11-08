package ai.brian.assistant

import android.app.Notification
import android.content.ComponentName
import android.content.Context
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.text.TextUtils

/**
 * Opt-in notification reader. Access is granted by the user in Android's
 * notification-access screen; until then Brian simply cannot see notifications.
 */
class NotificationRelay : NotificationListenerService() {

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        val notification = sbn?.notification ?: return
        if (notification.flags and Notification.FLAG_ONGOING_EVENT != 0) return
        val title = notification.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
        val body = notification.extras.getCharSequence(Notification.EXTRA_TEXT)?.toString().orEmpty()
        if (title.isBlank() && body.isBlank()) return
        synchronized(lock) {
            recent.addFirst("${sbn.packageName.substringAfterLast('.')}: ${title.ifBlank { body }}")
            while (recent.size > 12) recent.removeLast()
        }
    }

    companion object {
        private val lock = Any()
        private val recent = ArrayDeque<String>()

        fun isEnabled(context: Context): Boolean {
            val flat = Settings.Secure.getString(
                context.contentResolver,
                "enabled_notification_listeners",
            ) ?: return false
            val component = ComponentName(context, NotificationRelay::class.java)
            return !TextUtils.isEmpty(flat) && flat.contains(component.flattenToString()) ||
                flat.contains(context.packageName)
        }

        fun summary(): String = synchronized(lock) {
            if (recent.isEmpty()) return "You have no new notifications."
            val count = recent.size
            val lines = recent.take(4).joinToString(". ")
            "You have $count recent notifications. $lines"
        }
    }
}
