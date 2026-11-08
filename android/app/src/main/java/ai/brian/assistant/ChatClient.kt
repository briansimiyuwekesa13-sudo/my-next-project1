package ai.brian.assistant

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class BrianReply(val reply: String, val mode: String, val model: String?)

/**
 * Talks to the deployed Brian web app's `/api/chat` endpoint. The endpoint owns
 * the language model key, so the phone never holds one. If the network is down
 * we fall back to a tiny on-device responder for the essentials.
 */
class ChatClient(private val endpoint: String) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    suspend fun ask(
        config: BrianConfig,
        history: List<ChatTurn>,
        message: String,
    ): BrianReply = withContext(Dispatchers.IO) {
        if (endpoint.isBlank()) return@withContext offline(message, config)

        val payload = JSONObject().apply {
            put("message", message)
            put("history", JSONArray().apply {
                history.takeLast(16).forEach { turn ->
                    put(JSONObject().put("role", turn.role).put("content", turn.content))
                }
            })
            put("settings", JSONObject().apply {
                put("assistantName", config.assistantName)
                put("wakeWord", config.wakeWord)
                put("personality", config.personality)
                put("platform", "android")
            })
        }

        val request = Request.Builder()
            .url("${endpoint.trimEnd('/')}/api/chat")
            .post(payload.toString().toRequestBody("application/json".toMediaType()))
            .header("Accept", "application/json")
            .build()

        runCatching {
            client.newCall(request).execute().use { response ->
                val body = response.body?.string().orEmpty()
                if (!response.isSuccessful || body.isBlank()) return@use offline(message, config)
                val json = JSONObject(body)
                BrianReply(
                    reply = json.optString("reply", "").ifBlank { "I didn't get an answer for that." },
                    mode = json.optString("mode", "ai"),
                    model = json.optString("model", null),
                )
            }
        }.getOrElse { offline(message, config) }
    }

    private fun offline(message: String, config: BrianConfig): BrianReply {
        val text = message.lowercase()
        val reply = when {
            "time" in text -> "It's ${PhoneActions.clock()} right now."
            "date" in text || "day" in text -> "Today is ${PhoneActions.today()}."
            text.contains(config.assistantName.lowercase()) -> "I'm here. I can't reach the network, but I'm listening."
            else -> "I can't reach my brain right now. Check the connection, or ask me the time — that works offline."
        }
        return BrianReply(reply = reply, mode = "offline", model = null)
    }
}
