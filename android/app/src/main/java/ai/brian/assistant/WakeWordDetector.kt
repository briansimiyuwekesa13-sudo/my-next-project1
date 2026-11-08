package ai.brian.assistant

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer

/**
 * Continuous on-device wake-word watcher.
 *
 * The platform recognizer runs with `EXTRA_PREFER_OFFLINE`, so the audio used to
 * spot the wake phrase is processed on the phone. Only once the wake phrase is
 * matched does the assistant start a real conversational turn. Nothing is stored.
 */
class WakeWordDetector(
    private val context: Context,
    private val wakeWord: String,
    private val onWake: (remainder: String) -> Unit,
    private val onHeard: (String) -> Unit = {},
    private val onError: (String) -> Unit = {},
) : RecognitionListener {

    private val main = Handler(Looper.getMainLooper())
    private var recognizer: SpeechRecognizer? = null
    private var running = false
    private var restartDelay = 250L

    fun start() {
        if (running) return
        running = true
        main.post { createRecognizer()?.startListening(listenIntent()) }
    }

    fun stop() {
        running = false
        main.post {
            recognizer?.stopListening()
            recognizer?.destroy()
            recognizer = null
        }
    }

    fun updateWakeWord(word: String) {
        // Restart so the new phrase takes effect immediately.
        if (!running) return
        stop()
        main.postDelayed({ start() }, 200)
    }

    private fun createRecognizer(): SpeechRecognizer? {
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            onError("No speech recognition service is available on this device.")
            running = false
            return null
        }
        val instance = SpeechRecognizer.createSpeechRecognizer(context)
        instance.setRecognitionListener(this)
        recognizer = instance
        return instance
    }

    private fun listenIntent(): Intent =
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1200L)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1200L)
        }

    private fun restart() {
        if (!running) return
        recognizer?.destroy()
        recognizer = null
        main.postDelayed({
            if (running) createRecognizer()?.startListening(listenIntent())
        }, restartDelay)
        // Back off gently if the service keeps erroring, so we never hot-loop.
        restartDelay = (restartDelay + 250L).coerceAtMost(2500L)
    }

    private fun handle(text: String) {
        if (text.isBlank()) return
        onHeard(text)
        val match = WakeWord.match(text, wakeWord)
        if (match.matched) {
            restartDelay = 250L
            val remainder = match.remainder.trim()
            if (remainder.length > 2) {
                onWake(remainder)
            } else {
                onWake("")
            }
        }
    }

    override fun onResults(results: Bundle?) {
        results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            ?.firstOrNull()
            ?.let(::handle)
        restart()
    }

    override fun onPartialResults(partialResults: Bundle?) {
        partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            ?.firstOrNull()
            ?.let(::handle)
    }

    override fun onError(error: Int) {
        when (error) {
            SpeechRecognizer.ERROR_NO_MATCH,
            SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> restartDelay = 250L
            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS ->
                onError("Microphone permission is required to listen for the wake word.")
            SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> restartDelay = 800L
            else -> Unit
        }
        restart()
    }

    override fun onReadyForSpeech(params: Bundle?) = Unit
    override fun onBeginningOfSpeech() = Unit
    override fun onRmsChanged(rmsdB: Float) = Unit
    override fun onBufferReceived(buffer: ByteArray?) = Unit
    override fun onEndOfSpeech() = Unit
    override fun onEvent(eventType: Int, params: Bundle?) = Unit
}

/** Wake-phrase matching that tolerates the recognizer's spelling drift. */
object WakeWord {

    data class Match(val matched: Boolean, val remainder: String)

    private val FILLERS = setOf("hey", "hi", "ok", "okay", "yo", "hello")

    fun match(transcript: String, wakeWord: String): Match {
        val heard = tokens(transcript)
        val phrase = tokens(wakeWord)
        if (phrase.isEmpty()) return Match(false, transcript)

        for (start in 0..maxOf(0, heard.size - 1)) {
            if (start + phrase.size > heard.size) break
            var all = true
            for (offset in phrase.indices) {
                if (!similar(heard[start + offset], phrase[offset])) {
                    all = false
                    break
                }
            }
            if (all) {
                val remainder = heard.drop(start + phrase.size).joinToString(" ")
                return Match(true, remainder)
            }
        }
        return Match(false, transcript)
    }

    fun tokens(text: String): List<String> =
        text.lowercase()
            .replace(Regex("[^a-z0-9' ]"), " ")
            .split(' ')
            .filter { it.isNotBlank() && it !in FILLERS || it in setOf("hi", "hey") && false }

    private fun similar(a: String, b: String): Boolean {
        if (a == b) return true
        if (a.length < 3 || b.length < 3) return false
        return levenshtein(a, b) <= if (b.length >= 6) 2 else 1
    }

    private fun levenshtein(a: String, b: String): Int {
        var previous = IntArray(b.length + 1) { it }
        for (i in 1..a.length) {
            val current = IntArray(b.length + 1)
            current[0] = i
            for (j in 1..b.length) {
                val cost = if (a[i - 1] == b[j - 1]) 0 else 1
                current[j] = minOf(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost)
            }
            previous = current
        }
        return previous[b.length]
    }
}
