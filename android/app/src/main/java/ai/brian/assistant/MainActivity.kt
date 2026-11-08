package ai.brian.assistant

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
            if (result[Manifest.permission.RECORD_AUDIO] == true) BrianService.start(this)
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { BrianTheme { BrianScreen(onRequestPermissions = ::ensurePermissions) } }
    }

    private fun ensurePermissions() {
        val needed = mutableListOf(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            needed.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        val missing = needed.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) {
            BrianService.start(this)
        } else {
            permissionLauncher.launch(missing.toTypedArray())
        }
    }
}

@Composable
private fun BrianTheme(content: @Composable () -> Unit) {
    androidx.compose.material3.MaterialTheme(
        colorScheme = androidx.compose.material3.darkColorScheme(
            primary = Color(0xFF5CE1E6),
            secondary = Color(0xFFA78BFA),
            background = Color(0xFF05060C),
            surface = Color(0xFF101526),
            onBackground = Color(0xFFEAF1FF),
            onSurface = Color(0xFFEAF1FF),
        ),
        content = content,
    )
}

@Composable
private fun BrianScreen(onRequestPermissions: () -> Unit) {
    val context = LocalContext.current
    val state by BrianBus.stream.collectAsState()
    val scope = rememberCoroutineScope()

    val settings = remember { BrianSettings(context) }
    var config by remember { mutableStateOf(settings.load()) }
    var showSettings by remember { mutableStateOf(false) }
    var enrolMessage by remember { mutableStateOf<String?>(null) }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Brush.verticalGradient(listOf(Color(0xFF0A1024), Color(0xFF05060C))))
            .padding(20.dp),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = config.assistantName.uppercase(),
                color = Color(0xFF9DB6DD),
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 4.sp,
            )
            Spacer(Modifier.height(28.dp))

            Orb(active = state.listening, speaking = state.phase == "speaking")

            Spacer(Modifier.height(22.dp))
            Text(state.status, color = Color(0xFFEAF1FF), fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
            if (state.transcript.isNotBlank()) {
                Spacer(Modifier.height(8.dp))
                Text(
                    text = "\"${state.transcript}\"",
                    color = Color(0xFF93A4C4),
                    fontSize = 13.sp,
                )
            }
            state.error?.let {
                Spacer(Modifier.height(10.dp))
                Text(it, color = Color(0xFFFB7185), fontSize = 12.sp)
            }

            Spacer(Modifier.height(24.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Button(
                    onClick = {
                        if (state.listening) BrianService.stop(context) else onRequestPermissions()
                    },
                    shape = RoundedCornerShape(14.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = if (state.listening) Color(0xFF2A3350) else Color(0xFF22D3EE),
                    ),
                ) {
                    Text(if (state.listening) "Stop listening" else "Start listening")
                }
                if (state.phase == "speaking") {
                    Button(
                        onClick = {
                            context.startService(
                                Intent(context, BrianService::class.java)
                                    .setAction(BrianService.ACTION_STOP_SPEAKING),
                            )
                        },
                        shape = RoundedCornerShape(14.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF7C3AED)),
                    ) { Text("Interrupt") }
                }
            }

            Spacer(Modifier.height(20.dp))
            TextButton(onClick = { showSettings = !showSettings }) {
                Text(if (showSettings) "Hide settings" else "Settings", color = Color(0xFF5CE1E6))
            }

            if (showSettings) {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(18.dp),
                    colors = CardDefaults.cardColors(containerColor = Color(0xFF101526)),
                ) {
                    Column(Modifier.padding(18.dp)) {
                        Text("WAKE WORD", color = Color(0xFF9DB6DD), fontSize = 11.sp, letterSpacing = 2.sp)
                        Spacer(Modifier.height(6.dp))
                        OutlinedTextField(
                            value = config.wakeWord,
                            onValueChange = {
                                config = config.copy(wakeWord = it)
                                settings.save(config)
                                BrianBus.state.value = BrianBus.state.value.copy(status = "Say \"$it\"")
                            },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                            modifier = Modifier.fillMaxWidth(),
                        )

                        Spacer(Modifier.height(14.dp))
                        Text("SPEAKING VOICE", color = Color(0xFF9DB6DD), fontSize = 11.sp, letterSpacing = 2.sp)
                        Spacer(Modifier.height(6.dp))
                        Text(
                            config.voiceName ?: "Automatic — best installed voice",
                            color = Color(0xFFEAF1FF),
                            fontSize = 13.sp,
                        )

                        Spacer(Modifier.height(12.dp))
                        Text("SPEECH SPEED — ${"%.2f".format(config.rate)}×", color = Color(0xFF9DB6DD), fontSize = 11.sp)
                        Slider(
                            value = config.rate,
                            onValueChange = {
                                config = config.copy(rate = it)
                                settings.save(config)
                            },
                            valueRange = 0.6f..1.6f,
                        )

                        Spacer(Modifier.height(8.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text("Background listening", color = Color(0xFFEAF1FF), fontSize = 14.sp)
                                Text(
                                    "Stay armed for the wake word with a visible notification.",
                                    color = Color(0xFF93A4C4),
                                    fontSize = 11.sp,
                                )
                            }
                            Switch(
                                checked = config.continuousListening,
                                onCheckedChange = {
                                    config = config.copy(continuousListening = it)
                                    settings.save(config)
                                    if (it) onRequestPermissions() else BrianService.stop(context)
                                },
                            )
                        }

                        Spacer(Modifier.height(8.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text("Respond only to my voice", color = Color(0xFFEAF1FF), fontSize = 14.sp)
                                Text(
                                    if (OwnerVoice.load(context) == null) "Enrol your voice first."
                                    else "A local acoustic profile gates replies.",
                                    color = Color(0xFF93A4C4),
                                    fontSize = 11.sp,
                                )
                            }
                            Switch(
                                checked = config.ownerOnly,
                                onCheckedChange = {
                                    config = config.copy(ownerOnly = it)
                                    settings.save(config)
                                },
                            )
                        }

                        Spacer(Modifier.height(12.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Button(
                                onClick = {
                                    scope.launch {
                                        enrolMessage = "Speak normally for five seconds…"
                                        val profile = OwnerVoice.enrol(context)
                                        if (profile == null) {
                                            enrolMessage = "I didn't catch enough speech — try somewhere quieter."
                                        } else {
                                            OwnerVoice.save(context, profile)
                                            enrolMessage =
                                                "Saved from ${profile.samples} samples (${profile.pitch.toInt()} Hz)."
                                        }
                                    }
                                },
                                shape = RoundedCornerShape(12.dp),
                            ) { Text("Enrol my voice") }

                            TextButton(onClick = {
                                OwnerVoice.clear(context)
                                config = config.copy(ownerOnly = false)
                                settings.save(config)
                                enrolMessage = "Voice profile deleted."
                            }) { Text("Delete profile", color = Color(0xFFFB7185)) }
                        }
                        enrolMessage?.let {
                            Spacer(Modifier.height(8.dp))
                            Text(it, color = Color(0xFF93A4C4), fontSize = 12.sp)
                        }

                        Spacer(Modifier.height(16.dp))
                        TextButton(onClick = {
                            settings.clearHistory()
                            enrolMessage = "Conversation history cleared."
                        }) { Text("Clear conversation history", color = Color(0xFF93A4C4)) }
                    }
                }
            }

            Spacer(Modifier.height(20.dp))
            Text(
                "Microphone is only open while the notification is showing.",
                color = Color(0xFF5F6E8C),
                fontSize = 11.sp,
            )
        }
    }
}

@Composable
private fun Orb(active: Boolean, speaking: Boolean) {
    val primary = Color(0xFF5CE1E6)
    val accent = if (speaking) Color(0xFFF472B6) else Color(0xFFA78BFA)

    Canvas(modifier = Modifier.size(210.dp)) {
        val center = Offset(size.width / 2f, size.height / 2f)
        val radius = size.minDimension / 2f
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(primary.copy(alpha = 0.30f), Color.Transparent),
                center = center,
                radius = radius,
            ),
            radius = radius,
            center = center,
        )
        drawCircle(
            brush = Brush.sweepGradient(listOf(primary, accent, primary)),
            radius = radius * 0.78f,
            center = center,
            style = Stroke(width = if (active) 6f else 3f),
        )
        drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(primary, accent),
                center = center,
                radius = radius * 0.5f,
            ),
            radius = radius * 0.42f,
            center = center,
        )
    }
}
