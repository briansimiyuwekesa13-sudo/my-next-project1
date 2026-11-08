package ai.brian.assistant

import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.abs
import kotlin.math.sqrt

/**
 * On-device owner-voice check.
 *
 * We keep only averaged acoustic numbers (pitch, brightness and their spreads),
 * never audio. The comparison is a heuristic used to ignore other voices, not a
 * security boundary.
 */
data class VoiceProfile(
    val pitch: Double,
    val centroid: Double,
    val pitchSpread: Double,
    val centroidSpread: Double,
    val samples: Int,
)

object OwnerVoice {

    private const val SAMPLE_RATE = 16_000
    private const val MIN_RMS = 0.012
    private const val PREFS = "brian.voice"
    private const val KEY = "profile"

    fun load(context: Context): VoiceProfile? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val raw = prefs.getString(KEY, null) ?: return null
        val parts = raw.split(",").mapNotNull { it.toDoubleOrNull() }
        if (parts.size < 5) return null
        return VoiceProfile(parts[0], parts[1], parts[2], parts[3], parts[4].toInt())
    }

    fun save(context: Context, profile: VoiceProfile) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(
                KEY,
                "${profile.pitch},${profile.centroid},${profile.pitchSpread},${profile.centroidSpread},${profile.samples}",
            )
            .apply()
    }

    fun clear(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY).apply()
    }

    /** Records roughly [seconds] of speech and returns an averaged profile. */
    suspend fun enrol(context: Context, seconds: Int = 5): VoiceProfile? = withContext(Dispatchers.IO) {
        val minBuffer = AudioRecord.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minBuffer <= 0) return@withContext null

        val bufferSize = maxOf(minBuffer, SAMPLE_RATE / 2)
        val recorder = AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            bufferSize,
        )
        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            recorder.release()
            return@withContext null
        }

        val samples = ShortArray(bufferSize)
        val pitches = ArrayList<Double>()
        val centroids = ArrayList<Double>()
        val deadline = System.currentTimeMillis() + seconds * 1000L

        try {
            recorder.startRecording()
            while (System.currentTimeMillis() < deadline) {
                val read = recorder.read(samples, 0, samples.size)
                if (read <= 0) continue

                val doubles = DoubleArray(read) { samples[it] / 32768.0 }
                val rms = sqrt(doubles.sumOf { it * it } / read)
                if (rms < MIN_RMS) continue

                val pitch = estimatePitch(doubles, SAMPLE_RATE)
                if (pitch > 70 && pitch < 420) {
                    pitches.add(pitch)
                    centroids.add(estimateCentroid(doubles, SAMPLE_RATE))
                }
            }
        } finally {
            runCatching { recorder.stop() }
            recorder.release()
        }

        if (pitches.size < 8 || centroids.size < 8) return@withContext null
        val pitchMean = pitches.average()
        val centroidMean = centroids.average()
        VoiceProfile(
            pitch = pitchMean,
            centroid = centroidMean,
            pitchSpread = maxOf(stdev(pitches, pitchMean), 8.0),
            centroidSpread = maxOf(stdev(centroids, centroidMean), 150.0),
            samples = pitches.size,
        )
    }

    /** True when the given pitch is plausibly the enrolled speaker. */
    fun matches(profile: VoiceProfile, pitch: Double, centroid: Double): Boolean {
        if (pitch <= 0.0) return true
        val pitchDelta = abs(pitch - profile.pitch) / maxOf(profile.pitchSpread * 2.2, 22.0)
        val centroidDelta = abs(centroid - profile.centroid) / maxOf(profile.centroidSpread * 2.2, 320.0)
        return sqrt(pitchDelta * pitchDelta + centroidDelta * centroidDelta) <= 1.6
    }

    private fun stdev(values: List<Double>, mean: Double): Double =
        sqrt(values.sumOf { (it - mean) * (it - mean) } / values.size)

    private fun estimatePitch(frame: DoubleArray, sampleRate: Int): Double {
        val minLag = sampleRate / 420
        val maxLag = sampleRate / 70
        if (frame.size <= maxLag) return 0.0

        var bestLag = 0
        var bestCorrelation = 0.0
        for (lag in minLag..maxLag) {
            var correlation = 0.0
            for (i in 0 until frame.size - lag) {
                correlation += frame[i] * frame[i + lag]
            }
            if (correlation > bestCorrelation) {
                bestCorrelation = correlation
                bestLag = lag
            }
        }
        return if (bestLag == 0 || bestCorrelation <= 0.0) 0.0 else sampleRate.toDouble() / bestLag
    }

    /** Zero-crossing rate as a cheap brightness proxy. */
    private fun estimateCentroid(frame: DoubleArray, sampleRate: Int): Double {
        var crossings = 0
        for (i in 1 until frame.size) {
            if ((frame[i - 1] >= 0 && frame[i] < 0) || (frame[i - 1] < 0 && frame[i] >= 0)) crossings++
        }
        val duration = frame.size.toDouble() / sampleRate
        return (crossings / 2.0) / maxOf(duration, 1e-6)
    }
}
