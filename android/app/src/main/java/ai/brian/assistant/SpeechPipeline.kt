package ai.brian.assistant

import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale

/**
 * Natural-sounding speech out, and one free-form listening turn in.
 *
 * The voice is chosen from the user's installed voices, preferring higher-quality
 * (network/neural) engines, so replies do not sound robotic. `stop()` supports
 * barge-in: speaking is cancelled the moment the user starts talking again.
 */
class BrianSpeech(private val context: Context) {

    private var tts: TextToSpeech? = null
    private var ready = false
    private var pending: String? = null
    private var onDone: (() -> Unit)? = null
    private var currentVoice: String? = null
    private var rate = 1.0f
    private var pitch = 1.0f

    fun init(onReady: () -> Unit) {
        if (tts != null) return
        tts = TextToSpeech(context) { status ->
            ready = status == TextToSpeech.SUCCESS
            if (ready) {
                tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(utteranceId: String?) = Unit
                    override fun onDone(utteranceId: String?) {
                        Handler(Looper.getMainLooper()).post { onDone?.invoke() }
                    }

                    @Deprecated("Deprecated in Java")
                    override fun onError(utteranceId: String?) {
                        Handler(Looper.getMainLooper()).post { onDone?.invoke() }
                    }
                })
                pending?.let { speak(it, onDone) }
                pending = null
                onReady()
            }
        }
    }

    fun configure(voiceName: String?, language: String, rate: Float, pitch: Float) {
        this.rate = rate
        this.pitch = pitch
        currentVoice = voiceName
        val engine = tts ?: return
        val locale = Locale.forLanguageTag(language)
        val voices = engine.voices.orEmpty()
        val chosen = voices.firstOrNull { it.name == voiceName }
            ?: voices
                .filter { it.locale.language == locale.language }
                .sortedByDescending { if (it.isNetworkConnectionRequired) 2 else 1 }
                .firstOrNull()
        if (chosen != null) engine.voice = chosen
        engine.language = chosen?.locale ?: locale
        engine.setSpeechRate(rate)
        engine.setPitch(pitch)
    }

    fun speak(text: String, done: (() -> Unit)? = null) {
        onDone = done
        val engine = tts
        if (engine == null || !ready) {
            pending = text
            return
        }
        engine.setSpeechRate(rate)
        engine.setPitch(pitch)
        engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, "brian-${System.currentTimeMillis()}")
    }

    /** Barge-in: stop mid-sentence and let the caller start listening again. */
    fun stop() {
        tts?.stop()
        onDone = null
    }

    fun release() {
        tts?.stop()
        tts?.shutdown()
        tts = null
        ready = false
    }
}

/** One conversational listening turn with free-form dictation. */
class TurnRecognizer(
    private val context: Context,
    private val language: String,
    private val onPartial: (String) -> Unit,
    private val onFinal: (String) -> Unit,
    private val onFailed: (String) -> Unit,
) : RecognitionListener {

    private var recognizer: SpeechRecognizer? = null
    private var finished = false

    fun listen() {
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            onFailed("Speech recognition is not available on this device.")
            return
        }
        recognizer?.destroy()
        recognizer = SpeechRecognizer.createSpeechRecognizer(context).also {
            it.setRecognitionListener(this)
            it.startListening(
                android.content.Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
                    putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                    putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
                },
            )
        }
    }

    fun cancel() {
        finished = true
        recognizer?.cancel()
        recognizer?.destroy()
        recognizer = null
    }

    override fun onPartialResults(partialResults: Bundle?) {
        partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            ?.firstOrNull()
            ?.let(onPartial)
    }

    override fun onResults(results: Bundle?) {
        if (finished) return
        finished = true
        val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
        if (text.isBlank()) onFailed("I didn't catch that.") else onFinal(text)
    }

    override fun onError(error: Int) {
        if (finished) return
        finished = true
        val message = when (error) {
            SpeechRecognizer.ERROR_NO_MATCH,
            SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "I didn't catch that."
            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Microphone permission is missing."
            SpeechRecognizer.ERROR_NETWORK,
            SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "The speech service is unreachable."
            else -> "Something went wrong while listening."
        }
        onFailed(message)
    }

    override fun onReadyForSpeech(params: Bundle?) = Unit
    override fun onBeginningOfSpeech() = Unit
    override fun onRmsChanged(rmsdB: Float) = Unit
    override fun onBufferReceived(buffer: ByteArray?) = Unit
    override fun onEndOfSpeech() = Unit
    override fun onEvent(eventType: Int, params: Bundle?) = Unit
}
