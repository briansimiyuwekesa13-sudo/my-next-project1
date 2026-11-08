package ai.brian.assistant

import android.content.Context
import android.content.SharedPreferences

/**
 * User-controlled configuration. Stored in app-private preferences so nothing
 * about the user's setup leaves the device unless they ask a question.
 */
data class BrianConfig(
    val assistantName: String = "Brian",
    val wakeWord: String = "Hey Brian",
    val personality: String = "friendly",
    val voiceName: String? = null,
    val rate: Float = 1.0f,
    val pitch: Float = 1.0f,
    val continuousListening: Boolean = true,
    val ownerOnly: Boolean = false,
    val endpoint: String = BuildConfig.BRIAN_ENDPOINT,
)

class BrianSettings(context: Context) {

    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("brian.settings", Context.MODE_PRIVATE)

    fun load(): BrianConfig = BrianConfig(
        assistantName = prefs.getString(KEY_NAME, "Brian") ?: "Brian",
        wakeWord = prefs.getString(KEY_WAKE, "Hey Brian") ?: "Hey Brian",
        personality = prefs.getString(KEY_PERSONALITY, "friendly") ?: "friendly",
        voiceName = prefs.getString(KEY_VOICE, null),
        rate = prefs.getFloat(KEY_RATE, 1.0f),
        pitch = prefs.getFloat(KEY_PITCH, 1.0f),
        continuousListening = prefs.getBoolean(KEY_CONTINUOUS, true),
        ownerOnly = prefs.getBoolean(KEY_OWNER_ONLY, false),
    )

    fun save(config: BrianConfig) {
        prefs.edit()
            .putString(KEY_NAME, config.assistantName)
            .putString(KEY_WAKE, config.wakeWord)
            .putString(KEY_PERSONALITY, config.personality)
            .putString(KEY_VOICE, config.voiceName)
            .putFloat(KEY_RATE, config.rate)
            .putFloat(KEY_PITCH, config.pitch)
            .putBoolean(KEY_CONTINUOUS, config.continuousListening)
            .putBoolean(KEY_OWNER_ONLY, config.ownerOnly)
            .apply()
    }

    /** Rolling conversation used for context; capped so it never grows unbounded. */
    fun loadHistory(): List<ChatTurn> {
        val raw = prefs.getString(KEY_HISTORY, null) ?: return emptyList()
        return raw.split(ENTRY_SEP)
            .mapNotNull { entry ->
                val parts = entry.split(FIELD_SEP, limit = 2)
                if (parts.size != 2) null else ChatTurn(parts[0], parts[1])
            }
            .takeLast(MAX_HISTORY)
    }

    fun saveHistory(turns: List<ChatTurn>) {
        val encoded = turns.takeLast(MAX_HISTORY)
            .joinToString(ENTRY_SEP) { "${it.role}$FIELD_SEP${it.content.replace(ENTRY_SEP, " ")}" }
        prefs.edit().putString(KEY_HISTORY, encoded).apply()
    }

    fun clearHistory() {
        prefs.edit().remove(KEY_HISTORY).apply()
    }

    private companion object {
        const val KEY_NAME = "name"
        const val KEY_WAKE = "wake"
        const val KEY_PERSONALITY = "personality"
        const val KEY_VOICE = "voice"
        const val KEY_RATE = "rate"
        const val KEY_PITCH = "pitch"
        const val KEY_CONTINUOUS = "continuous"
        const val KEY_OWNER_ONLY = "owner_only"
        const val KEY_HISTORY = "history"
        const val MAX_HISTORY = 20
        const val ENTRY_SEP = "\u241E"
        const val FIELD_SEP = "\u241F"
    }
}

data class ChatTurn(val role: String, val content: String)
