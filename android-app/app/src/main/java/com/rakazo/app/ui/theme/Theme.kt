package com.rakazo.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

val Page = Color(0xFF050506)
val Main = Color(0xFF0D0D0E)
val Surface = Color(0xFF141416)
val Elevated = Color(0xFF1A1A1D)
val Border = Color(0xFF202023)
val BorderStrong = Color(0xFF2A2A2F)
val TextPrimary = Color(0xFFECECEE)
val TextSecondary = Color(0xFFC9C9CE)
val TextMuted = Color(0xFF85858A)
val Cream = Color(0xFFF1F1EF)
val CreamText = Color(0xFF17171A)
val FocusBlue = Color(0xFF4C8DFF)
val UnreadPurple = Color(0xFF8B5CF6)
val Success = Color(0xFF4ECB71)
val Attention = Color(0xFFE65707)
val Danger = Color(0xFFFF5364)

private val QuietColors = darkColorScheme(
    primary = FocusBlue,
    onPrimary = Color.White,
    secondary = Cream,
    onSecondary = CreamText,
    background = Page,
    onBackground = TextPrimary,
    surface = Main,
    onSurface = TextPrimary,
    surfaceVariant = Surface,
    onSurfaceVariant = TextSecondary,
    outline = BorderStrong,
    error = Danger,
)

private val QuietTypography = Typography(
    headlineMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 28.sp,
        lineHeight = 34.sp,
    ),
    titleLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 22.sp,
        lineHeight = 28.sp,
    ),
    titleMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 16.sp,
        lineHeight = 22.sp,
    ),
    bodyLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontSize = 16.sp,
        lineHeight = 24.sp,
    ),
    bodyMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontSize = 14.sp,
        lineHeight = 20.sp,
    ),
    labelMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Medium,
        fontSize = 12.sp,
        lineHeight = 16.sp,
    ),
)

@Composable
fun RakazoTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = QuietColors,
        typography = QuietTypography,
        content = content,
    )
}
