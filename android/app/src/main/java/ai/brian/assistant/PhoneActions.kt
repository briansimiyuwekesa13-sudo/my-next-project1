package ai.brian.assistant

import android.Manifest
import android.app.Activity
import android.app.AlarmManager
import android.app.SearchManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.AlarmClock
import android.provider.CalendarContract
import android.provider.Settings
import androidx.core.content.ContextCompat
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.util.Locale

/**
 * Turns plain language into real phone actions. Everything here is explicit and
 * permission-checked; when a permission is missing we return a sentence telling
 * the user what to grant instead of failing silently.
 */
object PhoneActions {

    sealed class Outcome {
        data class Spoken(val reply: String) : Outcome()
        data class Launch(val intent: Intent, val reply: String) : Outcome()
        data class NeedsPermission(val permission: String, val reply: String) : Outcome()
    }

    fun clock(): String = LocalTime.now().format(DateTimeFormatter.ofPattern("h:mm a"))

    fun today(): String =
        LocalDate.now().format(DateTimeFormatter.ofPattern("EEEE, d MMMM", Locale.getDefault()))

    /** Handles the supported intents; returns null when the model should answer instead. */
    fun handle(context: Context, text: String): Outcome? {
        val lower = text.lowercase().trim()

        when {
            Regex("\\btime\\b|what time").containsMatchIn(lower) && !lower.contains("alarm") ->
                return Outcome.Spoken("It's ${clock()}.")

            Regex("\\bdate\\b|what day|today").containsMatchIn(lower) && !lower.contains("remind") ->
                return Outcome.Spoken("Today is ${today()}.")

            Regex("\\b(open|launch|start)\\s+(the\\s+)?").containsMatchIn(lower) ->
                openApp(context, lower)?.let { return it }

            Regex("\\bcall\\b|\\bdial\\b|phone").containsMatchIn(lower) ->
                call(context, lower)?.let { return it }

            Regex("\\b(alarm|wake me)\\b").containsMatchIn(lower) ->
                return alarm(context, lower)

            Regex("\\b(remind|reminder|remind me)\\b").containsMatchIn(lower) ->
                return reminder(context, lower)

            Regex("\\bnotifications?\\b").containsMatchIn(lower) && Regex("read|check|any").containsMatchIn(lower) ->
                return Outcome.Spoken(NotificationRelay.summary())

            Regex("\\b(wifi|wi-fi|bluetooth|brightness|airplane|do not disturb)\\b").containsMatchIn(lower) ->
                return Outcome.Launch(
                    Intent(Settings.ACTION_SETTINGS),
                    "Opening settings — Android keeps radios under your control, so I'll take you there.",
                )

            Regex("\\b(search|google|look up)\\b").containsMatchIn(lower) ->
                return search(context, text)

            Regex("\\bstop listening\\b|\\bgo to sleep\\b|\\bthat's all\\b").containsMatchIn(lower) ->
                return Outcome.Spoken("Okay, going quiet. Say ${WakeWordName.current} when you need me.")
        }
        return null
    }

    private object WakeWordName {
        var current: String = "Hey Brian"
    }

    fun rememberWakeWord(word: String) {
        WakeWordName.current = word
    }

    private fun call(context: Context, lower: String): Outcome? {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CALL_PHONE) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return Outcome.NeedsPermission(
                Manifest.permission.CALL_PHONE,
                "I need call permission before I can dial for you.",
            )
        }
        val target = lower
            .replace(Regex("^(please\\s+)?(call|dial|phone)\\s+"), "")
            .replace(Regex("\\b(on speaker|for me|now)\\b"), "")
            .trim()
        if (target.isBlank()) return Outcome.Spoken("Who would you like me to call?")

        val digits = target.filter { it.isDigit() || it == '+' }
        val uri = if (digits.length >= 5) Uri.parse("tel:$digits") else Uri.parse("tel:")
        return Outcome.Launch(
            Intent(Intent.ACTION_CALL, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            if (digits.length >= 5) "Calling $digits." else "Opening the dialler for $target.",
        )
    }

    private fun openApp(context: Context, lower: String): Outcome? {
        val name = lower
            .replace(Regex("^(please\\s+)?(open|launch|start)\\s+(the\\s+)?"), "")
            .replace(Regex("\\b(app|application)\\b"), "")
            .trim()
        if (name.isBlank()) return null

        val pm = context.packageManager
        val installed = pm.getInstalledApplications(PackageManager.GET_META_DATA)
        val match = installed.firstOrNull { app ->
            val label = pm.getApplicationLabel(app).toString().lowercase()
            label == name || label.replace(" ", "").contains(name.replace(" ", ""))
        }
        if (match != null) {
            val intent = pm.getLaunchIntentForPackage(match.packageName)
            if (intent != null) {
                return Outcome.Launch(
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    "Opening ${pm.getApplicationLabel(match)}.",
                )
            }
        }

        // Not installed: hand over to the Play Store so the user stays in control.
        return Outcome.Launch(
            Intent(Intent.ACTION_VIEW, Uri.parse("market://search?q=$name")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            "I couldn't find $name installed, so I'm opening the store.",
        )
    }

    private fun alarm(context: Context, lower: String): Outcome {
        val (hour, minute) = parseTime(lower) ?: (7 to 0)
        val intent = Intent(AlarmClock.ACTION_SET_ALARM).apply {
            putExtra(AlarmClock.EXTRA_HOUR, hour)
            putExtra(AlarmClock.EXTRA_MINUTES, minute)
            putExtra(AlarmClock.EXTRA_SKIP_UI, false)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        val label = LocalTime.of(hour, minute).format(DateTimeFormatter.ofPattern("h:mm a"))
        return Outcome.Launch(intent, "Setting an alarm for $label.")
    }

    private fun reminder(context: Context, lower: String): Outcome {
        val minutes = Regex("in (\\d+) ?(minute|minutes|min)").find(lower)?.groupValues?.get(1)?.toIntOrNull()
        val what = lower
            .replace(Regex("^(please\\s+)?(remind me|reminder|remind)\\s*(to|about)?"), "")
            .replace(Regex("in \\d+ ?(minute|minutes|min|hour|hours)"), "")
            .trim()
            .ifBlank { "my reminder" }

        if (minutes != null) {
            val trigger = LocalDateTime.now().plusMinutes(minutes.toLong())
            val intent = Intent(AlarmClock.ACTION_SET_ALARM).apply {
                putExtra(AlarmClock.EXTRA_HOUR, trigger.hour)
                putExtra(AlarmClock.EXTRA_MINUTES, trigger.minute)
                putExtra(AlarmClock.EXTRA_MESSAGE, what)
                putExtra(AlarmClock.EXTRA_SKIP_UI, false)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            return Outcome.Launch(intent, "I'll remind you to $what in $minutes minutes.")
        }

        val intent = Intent(Intent.ACTION_INSERT).apply {
            data = CalendarContract.Events.CONTENT_URI
            putExtra(CalendarContract.Events.TITLE, what)
            putExtra(CalendarContract.Events.DESCRIPTION, "Reminder created by Brian")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return Outcome.Launch(intent, "Opening your calendar to save “$what”.")
    }

    private fun search(context: Context, text: String): Outcome {
        val query = text.replace(Regex("^(please\\s+)?(search|google|look up)\\s+(for\\s+)?"), "").trim()
        val intent = Intent(Intent.ACTION_WEB_SEARCH).apply {
            putExtra(SearchManager.QUERY, query)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        return try {
            Outcome.Launch(intent, "Searching for $query.")
        } catch (_: ActivityNotFoundException) {
            Outcome.Launch(
                Intent(Intent.ACTION_VIEW, Uri.parse("https://www.google.com/search?q=${Uri.encode(query)}")),
                "Searching for $query.",
            )
        }
    }

    private fun parseTime(text: String): Pair<Int, Int>? {
        val match = Regex("(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?").find(text) ?: return null
        var hour = match.groupValues[1].toIntOrNull() ?: return null
        val minute = match.groupValues[2].toIntOrNull() ?: 0
        val suffix = match.groupValues[3]
        if (suffix == "pm" && hour < 12) hour += 12
        if (suffix == "am" && hour == 12) hour = 0
        if (hour !in 0..23 || minute !in 0..59) return null
        return hour to minute
    }

    /** Best-effort notification summary for the read-aloud feature. */
    fun readNotifications(activity: Activity): Outcome =
        if (!NotificationRelay.isEnabled(activity)) {
            Outcome.Launch(
                Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS")
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                "Notification access is off. Enable Brian in notification access and I can read them aloud.",
            )
        } else {
            Outcome.Spoken(NotificationRelay.summary())
        }
}
