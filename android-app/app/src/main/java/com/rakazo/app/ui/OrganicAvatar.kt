package com.rakazo.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sign
import kotlin.math.sin
import kotlin.math.sqrt

internal fun avatarIdentitySeed(identity: String): Long {
    var hash = 0
    identity.forEach { character -> hash = (hash shl 5) - hash + character.code }
    return abs(hash.toLong())
}

internal fun organicAvatarPoints(seed: Long, phaseOffset: Double = 0.0): List<Offset> {
    val phase = (seed % 360) * PI / 180 + phaseOffset
    val family = (seed % 10).toInt()
    val xScale = 1 + sin(phase) * 0.035
    val yScale = 1 + cos(phase) * 0.025
    val shear = sin(phase * 1.7) * 0.025
    var points = ORGANIC_AVATAR_TEMPLATES[family].map { point ->
        Offset(
            x = (point.x * xScale + point.y * shear).toFloat(),
            y = (point.y * yScale).toFloat(),
        )
    }
    repeat(if (family in 3..5) 1 else 2) {
        val source = points
        points = source.flatMapIndexed { index, point ->
            val next = source[(index + 1) % source.size]
            listOf(
                point * 0.75f + next * 0.25f,
                point * 0.25f + next * 0.75f,
            )
        }
    }
    return points
}

private val ORGANIC_AVATAR_TEMPLATES = listOf(
    offsets(
        -43 to 22, -51 to 16, -53 to 6, -49 to -4, -40 to -12, -30 to -13, -27 to -24,
        -18 to -34, -6 to -36, 4 to -32, 12 to -42, 25 to -45, 37 to -38, 43 to -27,
        42 to -17, 51 to -11, 56 to 0, 54 to 12, 46 to 20, 30 to 24, 0 to 25, -29 to 25,
    ),
    offsets(
        0 to -52, 12 to -35, 28 to -17, 39 to 2, 42 to 21, 34 to 38, 19 to 49,
        0 to 52, -19 to 49, -34 to 38, -42 to 21, -39 to 2, -28 to -17, -12 to -35,
    ),
    offsets(
        -42 to -23, -27 to -40, -7 to -46, 14 to -40, 33 to -27, 46 to -8, 46 to 14,
        35 to 34, 14 to 46, -8 to 46, -29 to 38, -43 to 21, -48 to 0,
    ),
    radialOffsets(40) { angle -> 44 + cos(angle * 5) * 5 },
    radialOffsets(36) { angle -> 43 + cos(angle * 6) * 7 },
    List(32) { index ->
        val angle = index / 32.0 * PI * 2
        val x = cos(angle)
        val y = sin(angle)
        Offset(
            (sign(x) * sqrt(abs(x)) * 46).toFloat(),
            (sign(y) * sqrt(abs(y)) * 43).toFloat(),
        )
    },
    offsets(
        0 to 48, -14 to 36, -32 to 20, -45 to 0, -43 to -20, -29 to -36, -10 to -39,
        0 to -27, 10 to -39, 29 to -36, 43 to -20, 45 to 0, 32 to 20, 14 to 36,
    ),
    offsets(
        -48 to 35, -38 to 22, -34 to -8, -27 to -31, -12 to -44, 0 to -48, 12 to -44,
        27 to -31, 34 to -8, 38 to 22, 48 to 35, 26 to 42, 0 to 44, -26 to 42,
    ),
    offsets(
        -45 to -19, -28 to -38, -4 to -46, 22 to -41, 42 to -25, 49 to -2,
        42 to 23, 22 to 42, -4 to 47, -29 to 38, -46 to 18, -50 to 0,
    ),
    offsets(
        -50 to 0, -45 to -20, -30 to -38, 0 to -48, 30 to -38, 45 to -20, 50 to 0,
        35 to 10, 18 to 12, 16 to 38, 0 to 46, -16 to 38, -18 to 12, -35 to 10,
    ),
)

private fun offsets(vararg points: Pair<Int, Int>) = points.map { (x, y) -> Offset(x.toFloat(), y.toFloat()) }

private fun radialOffsets(count: Int, radius: (Double) -> Double) = List(count) { index ->
    val angle = index / count.toDouble() * PI * 2
    val value = radius(angle)
    Offset((cos(angle) * value).toFloat(), (sin(angle) * value).toFloat())
}

internal data class WorkingAvatarFrame(
    val translationX: Float = 0f,
    val translationY: Float = 0f,
    val scaleX: Float = 1f,
    val scaleY: Float = 1f,
    val rotationZ: Float = 0f,
    val eyeOffsetX: Float = 0f,
    val eyeOffsetY: Float = 0f,
)

internal fun workingAvatarFrame(seed: Long, progress: Float): WorkingAvatarFrame {
    val middle = ((1 - cos(progress * PI * 2)) / 2).toFloat()
    val body = when ((seed % 10).toInt()) {
        0 -> WorkingAvatarFrame(translationY = 2f - 5f * middle, scaleX = 1.02f - 0.04f * middle)
        1 -> WorkingAvatarFrame(
            translationY = 2f - 5f * middle,
            scaleX = 1.04f - 0.08f * middle,
            scaleY = 0.96f + 0.09f * middle,
        )
        2, 8 -> WorkingAvatarFrame(translationX = -1f + 2f * middle, rotationZ = -3f + 6f * middle)
        3, 4 -> WorkingAvatarFrame(
            scaleX = 0.98f + 0.06f * middle,
            scaleY = 0.98f + 0.06f * middle,
            rotationZ = -4f + 8f * middle,
        )
        5, 9 -> WorkingAvatarFrame(scaleX = 1.04f - 0.08f * middle, scaleY = 0.96f + 0.08f * middle)
        6 -> WorkingAvatarFrame(scaleX = 0.96f + 0.10f * middle, scaleY = 0.96f + 0.10f * middle)
        else -> WorkingAvatarFrame(rotationZ = -4f + 9f * middle)
    }
    val angle = progress * PI * 2
    val eyeX = when ((seed % 4).toInt()) {
        0 -> (sin(angle) * 9).toFloat()
        1 -> (cos(angle) * 7).toFloat()
        2 -> (cos(angle) * 8).toFloat()
        else -> (sin(angle * 2) * 6).toFloat()
    }
    val eyeY = when ((seed % 4).toInt()) {
        0 -> (cos(angle) * 2).toFloat()
        1 -> (sin(angle) * 4).toFloat()
        2 -> (sin(angle) * 3).toFloat()
        else -> (cos(angle * 2) * 3).toFloat()
    }
    return body.copy(eyeOffsetX = eyeX, eyeOffsetY = eyeY)
}

private val WORKING_DURATIONS_MS = intArrayOf(1800, 1350, 1600, 2400, 1350, 1350, 1100, 1350, 1600, 1350)
@Composable
fun OrganicAvatar(
    identity: String,
    color: Color,
    modifier: Modifier = Modifier,
    size: Dp = 48.dp,
    working: Boolean = false,
) {
    val seed = avatarIdentitySeed(identity)
    if (working) {
        val transition = rememberInfiniteTransition(label = "Working avatar")
        val progress by transition.animateFloat(
            initialValue = 0f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(
                animation = tween(WORKING_DURATIONS_MS[(seed % 10).toInt()], easing = LinearEasing),
                repeatMode = RepeatMode.Restart,
            ),
            label = "Working avatar motion",
        )
        OrganicAvatarCanvas(seed, color, modifier, size, working = true, progress = progress)
    } else {
        OrganicAvatarCanvas(seed, color, modifier, size, working = false, progress = 0f)
    }
}

@Composable
private fun OrganicAvatarCanvas(
    seed: Long,
    color: Color,
    modifier: Modifier,
    size: Dp,
    working: Boolean,
    progress: Float,
) {
    val morph = ((1 - cos(progress * PI * 2)) / 2) * 0.42
    val points = organicAvatarPoints(seed, morph)
    val frame = if (working) workingAvatarFrame(seed, progress) else WorkingAvatarFrame()
    Canvas(modifier = modifier.size(size)) {
        val scale = min(this.size.width, this.size.height) / 120f
        fun map(point: Offset) = Offset(
            x = this.size.width / 2 + point.x * scale,
            y = this.size.height / 2 + point.y * scale,
        )

        val path = Path().apply {
            val first = map(points.first())
            moveTo(first.x, first.y)
            points.indices.forEach { index ->
                val before = points[(index - 1 + points.size) % points.size]
                val current = points[index]
                val next = points[(index + 1) % points.size]
                val after = points[(index + 2) % points.size]
                val control1 = map(current + (next - before) / 6f)
                val control2 = map(next - (after - current) / 6f)
                val end = map(next)
                cubicTo(control1.x, control1.y, control2.x, control2.y, end.x, end.y)
            }
            close()
        }

        val center = Offset(this.size.width / 2, this.size.height / 2)
        withTransform({
            translate(frame.translationX * scale, frame.translationY * scale)
            rotate(frame.rotationZ, center)
            scale(frame.scaleX, frame.scaleY, center)
        }) {
            drawPath(path, color)
            val eyeCenter = Offset(frame.eyeOffsetX * scale, frame.eyeOffsetY * scale)
            withTransform({ rotate(((seed % 9) - 4).toFloat(), center) }) {
                listOf(-14f, 7f).forEach { x ->
                    drawRoundRect(
                        color = Color(0xFF101014),
                        topLeft = Offset(
                            this.size.width / 2 + x * scale + eyeCenter.x,
                            this.size.height / 2 - 12f * scale + eyeCenter.y,
                        ),
                        size = Size(7f * scale, 24f * scale),
                        cornerRadius = androidx.compose.ui.geometry.CornerRadius(3.5f * scale),
                    )
                }
            }
        }
    }
}
