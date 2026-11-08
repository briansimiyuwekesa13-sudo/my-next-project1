package ai.brian.assistant

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/** Everything the UI needs to render, mirrored from the service. */
data class BrianState(
    val listening: Boolean = false,
    val phase: String = "idle",
    val status: String = "Say your wake word",
    val transcript: String = "",
    val lastHeard: String = "",
    val error: String? = null,
)

/**
 * Foreground service that keeps Brian armed in the background.
 *
 * Android requires a visible, ongoing notification while the microphone is in
 * use, which is exactly the privacy indicator the app promises. The service
 * stops listening when the user turns listening off or dismisses the app's
 * notification action.
 */
class BrianService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var settings: BrianSettings
    private lateinit var speech: BrianSpeech
    private var detector: WakeWordDetector? = null
    private var turn: TurnRecognizer? = null
    private lateinit var chat: ChatClient

    override fun onCreate() {
        super.onCreate()
        settings = BrianSettings(this)
        val config = settings.load()
        PhoneActions.rememberWakeWord(config.wakeWord)
        speech = BrianSpeech(this)
        speech.init {
            speech.configure(config.voiceName, "en-US", config.rate, config.pitch)
        }
        chat = ChatClient(config.endpoint)
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopListening()
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_STOP_SPEAKING -> {
                speech.stop()
                publish { it.copy(phase = "wake", status = "Listening for ${settings.load().wakeWord}") }
                armWakeWord()
                return START_STICKY
            }
            else -> {
                startForegroundCompat()
                armWakeWord()
            }
        }
        return START_STICKY
    }

    private fun armWakeWord() {
        val config = settings.load()
        PhoneActions.rememberWakeWord(config.wakeWord)
        if (config.ownerOnly && OwnerVoice.load(this) == null) {
            publish { it.copy(error = "Voice profile missing — enrol your voice in the app.") }
        }
        detector?.stop()
        detector = WakeWordDetector(
            context = this,
            wakeWord = config.wakeWord,
            onWake = { remainder -> onWakeWord(config, remainder) },
            onHeard = { heard -> publish { it.copy(lastHeard = heard) } },
            onError = { message -> publish { it.copy(error = message) } },
        ).also { it.start() }

        publish {
            it.copy(
                listening = true,
                phase = "wake",
                status = "Listening for \"${config.wakeWord}\"",
                error = null,
            )
        }
        updateNotification("Listening for \"${config.wakeWord}\"")
    }

    private fun onWakeWord(config: BrianConfig, remainder: String) {
        detector?.stop()
        detector = null
        publish { it.copy(phase = "listening", status = "I'm listening", transcript = remainder) }

        if (remainder.isNotBlank()) {
            respond(config, remainder)
            return
        }

        turn?.cancel()
        turn = TurnRecognizer(
            context = this,
            language = "en-US",
            onPartial = { partial -> publish { it.copy(transcript = partial) } },
            onFinal = { text -> respond(config, text) },
            onFailed = { message ->
                publish { it.copy(error = message, phase = "wake") }
                armWakeWord()
            },
        ).also { it.listen() }
    }

    private fun respond(config: BrianConfig, text: String) {
        publish { it.copy(phase = "thinking", transcript = text) }

        // Fast local phone actions first — no round trip needed.
        val outcome = PhoneActions.handle(this, text)
        if (outcome != null) {
            when (outcome) {
                is PhoneActions.Outcome.Spoken -> say(config, outcome.reply)
                is PhoneActions.Outcome.Launch -> {
                    runCatching {
                        outcome.intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        startActivity(outcome.intent)
                    }
                    say(config, outcome.reply)
                }
                is PhoneActions.Outcome.NeedsPermission -> say(config, outcome.reply)
            }
            return
        }

        val history = settings.loadHistory()
        scope.launch {
            val reply = chat.ask(config, history, text)
            settings.saveHistory(history + ChatTurn("user", text) + ChatTurn("assistant", reply.reply))
            say(config, reply.reply)
        }
    }

    private fun say(config: BrianConfig, text: String) {
        publish { it.copy(phase = "speaking", status = text) }
        speech.configure(config.voiceName, "en-US", config.rate, config.pitch)
        speech.speak(text) {
            publish { it.copy(phase = "wake", status = "Listening for \"${config.wakeWord}\"") }
            if (config.continuousListening) armWakeWord() else stopListening()
        }
    }

    private fun stopListening() {
        detector?.stop()
        detector = null
        turn?.cancel()
        turn = null
        speech.stop()
        publish { it.copy(listening = false, phase = "idle", status = "Listening is off") }
    }

    private fun publish(update: (BrianState) -> BrianState) {
        BrianBus.state.value = update(BrianBus.state.value)
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Voice assistant",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Shown while Brian is listening for your wake word."
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun startForegroundCompat() {
        val notification = buildNotification("Listening for \"${settings.load().wakeWord}\"")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun updateNotification(status: String) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification(status))
    }

    private fun buildNotification(status: String): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, BrianService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val mute = PendingIntent.getService(
            this,
            2,
            Intent(this, BrianService::class.java).setAction(ACTION_STOP_SPEAKING),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Brian is listening")
            .setContentText(status)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(open)
            .addAction(0, "Stop speaking", mute)
            .addAction(0, "Turn off listening", stop)
            .build()
    }

    override fun onDestroy() {
        stopListening()
        speech.release()
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val CHANNEL_ID = "brian.listening"
        const val NOTIFICATION_ID = 42
        const val ACTION_STOP = "ai.brian.assistant.STOP_LISTENING"
        const val ACTION_STOP_SPEAKING = "ai.brian.assistant.STOP_SPEAKING"

        fun start(context: Context) {
            val intent = Intent(context, BrianService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.startService(Intent(context, BrianService::class.java).setAction(ACTION_STOP))
        }
    }
}

/** Shared, process-wide state between the service and the Compose UI. */
object BrianBus {
    val state = MutableStateFlow(BrianState())
    val stream: StateFlow<BrianState> get() = state
}
