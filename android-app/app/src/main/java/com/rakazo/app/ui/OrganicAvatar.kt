package com.rakazo.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

internal fun avatarIdentitySeed(identity: String): Int {
    var hash = 0
    identity.forEach { character -> hash = (hash shl 5) - hash + character.code }
    return abs(hash)
}

private fun organicAvatarPoints(seed: Int): List<Offset> {
    val phase = (seed % 360) * PI / 180
    val family = (seed + 1) % 4
    val lobes = listOf(2, 3, 4, 5)[family]
    val amplitude = listOf(0.045, 0.14, 0.09, 0.025)[family]
    return List(12) { index ->
        val angle = index / 12.0 * PI * 2
        val radius = 50 * (
            1 + amplitude * sin(angle * lobes + phase) +
                0.025 * sin(angle * 2 - phase)
            )
        Offset(
            x = (cos(angle) * radius * 1.08).toFloat(),
            y = (sin(angle) * radius * 0.82).toFloat(),
        )
    }
}
@Composable
fun OrganicAvatar(
    identity: String,
    color: Color,
    modifier: Modifier = Modifier,
    size: Dp = 48.dp,
    working: Boolean = false,
) {
    val seed = avatarIdentitySeed(identity)
    val points = organicAvatarPoints(seed)
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

        if (working) {
            drawPath(path, Color.White, style = Stroke(width = 2.dp.toPx()))
        }
        drawPath(path, color)

        rotate(degrees = ((seed % 9) - 4).toFloat()) {
            listOf(-14f, 7f).forEach { x ->
                drawRoundRect(
                    color = Color(0xFF101014),
                    topLeft = Offset(
                        this.size.width / 2 + x * scale,
                        this.size.height / 2 - 12f * scale,
                    ),
                    size = Size(7f * scale, 24f * scale),
                    cornerRadius = androidx.compose.ui.geometry.CornerRadius(3.5f * scale),
                )
            }
        }
    }
}
