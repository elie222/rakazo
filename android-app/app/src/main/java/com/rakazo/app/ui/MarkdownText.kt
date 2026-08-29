package com.rakazo.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.rakazo.app.ui.theme.BorderStrong
import com.rakazo.app.ui.theme.Elevated
import com.rakazo.app.ui.theme.FocusBlue
import com.rakazo.app.ui.theme.Surface as SurfaceColor
import com.rakazo.app.ui.theme.TextMuted
import com.rakazo.app.ui.theme.TextPrimary

internal sealed interface MarkdownBlock {
    data class Paragraph(val text: String) : MarkdownBlock
    data class Heading(val level: Int, val text: String) : MarkdownBlock
    data class ListBlock(val items: List<String>, val start: Int? = null) : MarkdownBlock
    data class Quote(val text: String) : MarkdownBlock
    data class Code(val text: String) : MarkdownBlock
    data object Rule : MarkdownBlock
}

private val headingPattern = Regex("^ {0,3}(#{1,6})\\s+(.+?)\\s*#*$")
private val bulletPattern = Regex("^ {0,3}[-+*]\\s+(.+)$")
private val orderedPattern = Regex("^ {0,3}(\\d+)[.)]\\s+(.+)$")
private val quotePattern = Regex("^ {0,3}>\\s?(.*)$")
private val rulePattern = Regex("^ {0,3}((\\*\\s*){3,}|(-\\s*){3,}|(_\\s*){3,})$")
private val fencePattern = Regex("^ {0,3}(`{3,}|~{3,}).*$")

internal fun parseMarkdownBlocks(markdown: String): List<MarkdownBlock> {
    val lines = markdown.replace("\r\n", "\n").replace('\r', '\n').lines()
    val blocks = mutableListOf<MarkdownBlock>()
    val paragraph = mutableListOf<String>()
    fun flushParagraph() {
        if (paragraph.isNotEmpty()) blocks += MarkdownBlock.Paragraph(paragraph.joinToString(" ").trim())
        paragraph.clear()
    }

    var index = 0
    while (index < lines.size) {
        val line = lines[index]
        if (line.isBlank()) {
            flushParagraph()
            index++
            continue
        }

        val fence = fencePattern.matchEntire(line)?.groupValues?.get(1)
        if (fence != null) {
            flushParagraph()
            val code = mutableListOf<String>()
            index++
            while (index < lines.size && !lines[index].trimStart().startsWith(fence.first().toString().repeat(fence.length))) {
                code += lines[index++]
            }
            if (index < lines.size) index++
            blocks += MarkdownBlock.Code(code.joinToString("\n"))
            continue
        }

        headingPattern.matchEntire(line)?.let {
            flushParagraph()
            blocks += MarkdownBlock.Heading(it.groupValues[1].length, it.groupValues[2])
            index++
            continue
        }
        if (rulePattern.matches(line)) {
            flushParagraph()
            blocks += MarkdownBlock.Rule
            index++
            continue
        }

        quotePattern.matchEntire(line)?.let {
            flushParagraph()
            val quote = mutableListOf<String>()
            while (index < lines.size) {
                val match = quotePattern.matchEntire(lines[index]) ?: break
                quote += match.groupValues[1]
                index++
            }
            blocks += MarkdownBlock.Quote(quote.joinToString(" ").trim())
            continue
        }

        val bullet = bulletPattern.matchEntire(line)
        val ordered = orderedPattern.matchEntire(line)
        if (bullet != null || ordered != null) {
            flushParagraph()
            val items = mutableListOf<String>()
            val start = ordered?.groupValues?.get(1)?.toIntOrNull()
            while (index < lines.size) {
                val match = if (start == null) bulletPattern.matchEntire(lines[index]) else orderedPattern.matchEntire(lines[index])
                if (match == null) break
                items += if (start == null) match.groupValues[1] else match.groupValues[2]
                index++
            }
            blocks += MarkdownBlock.ListBlock(items, start)
            continue
        }

        paragraph += line.trim()
        index++
    }
    flushParagraph()
    return blocks
}

@Composable
internal fun MarkdownText(
    markdown: String,
    modifier: Modifier = Modifier,
    color: Color = TextPrimary,
) {
    val blocks = remember(markdown) { parseMarkdownBlocks(markdown) }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(9.dp)) {
        blocks.forEach { block ->
            when (block) {
                is MarkdownBlock.Paragraph -> MarkdownInline(block.text, color)
                is MarkdownBlock.Heading -> MarkdownInline(
                    block.text,
                    color = TextPrimary,
                    style = when (block.level) {
                        1 -> MaterialTheme.typography.titleLarge
                        2 -> MaterialTheme.typography.titleMedium
                        else -> MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold)
                    },
                )
                is MarkdownBlock.ListBlock -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    block.items.forEachIndexed { itemIndex, item ->
                        Row(verticalAlignment = Alignment.Top) {
                            Text(
                                text = block.start?.let { "${it + itemIndex}." } ?: "•",
                                modifier = Modifier.width(24.dp),
                                color = color,
                                style = MaterialTheme.typography.bodyLarge,
                            )
                            MarkdownInline(item, color, Modifier.weight(1f))
                        }
                    }
                }
                is MarkdownBlock.Quote -> Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
                    Box(Modifier.fillMaxHeight().width(2.dp).background(TextMuted, RoundedCornerShape(1.dp)))
                    MarkdownInline(block.text, TextMuted, Modifier.padding(start = 12.dp).weight(1f))
                }
                is MarkdownBlock.Code -> Surface(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(8.dp),
                    color = SurfaceColor,
                    border = androidx.compose.foundation.BorderStroke(1.dp, BorderStrong),
                ) {
                    Text(
                        block.text,
                        modifier = Modifier.horizontalScroll(rememberScrollState()).padding(12.dp),
                        color = TextPrimary,
                        style = MaterialTheme.typography.bodyMedium,
                        fontFamily = FontFamily.Monospace,
                    )
                }
                MarkdownBlock.Rule -> HorizontalDivider(color = BorderStrong)
            }
        }
    }
}

@Composable
private fun MarkdownInline(
    text: String,
    color: Color,
    modifier: Modifier = Modifier,
    style: androidx.compose.ui.text.TextStyle = MaterialTheme.typography.bodyLarge,
) {
    val annotated = remember(text) { inlineMarkdown(text) }
    Text(annotated, modifier = modifier, color = color, style = style)
}

internal fun inlineMarkdown(text: String): AnnotatedString = buildAnnotatedString { appendMarkdown(text) }

private fun AnnotatedString.Builder.appendMarkdown(value: String) {
    var index = 0
    while (index < value.length) {
        if (value[index] == '\\' && index + 1 < value.length) {
            append(value[index + 1])
            index += 2
            continue
        }

        val token = listOf("**", "__", "~~", "`", "*", "_").firstOrNull { value.startsWith(it, index) }
        if (token != null) {
            val end = value.indexOf(token, index + token.length)
            if (end > index + token.length) {
                val content = value.substring(index + token.length, end)
                val span = when (token) {
                    "**", "__" -> SpanStyle(fontWeight = FontWeight.Bold)
                    "~~" -> SpanStyle(textDecoration = TextDecoration.LineThrough)
                    "`" -> SpanStyle(fontFamily = FontFamily.Monospace, background = Elevated)
                    else -> SpanStyle(fontStyle = FontStyle.Italic)
                }
                withStyle(span) {
                    if (token == "`") append(content) else appendMarkdown(content)
                }
                index = end + token.length
                continue
            }
        }

        val labelStart = if (value.startsWith("![", index)) index + 2 else if (value[index] == '[') index + 1 else -1
        if (labelStart >= 0) {
            val labelEnd = value.indexOf(']', labelStart)
            if (labelEnd >= 0 && value.getOrNull(labelEnd + 1) == '(') {
                val urlEnd = value.closingParen(labelEnd + 1)
                if (urlEnd >= 0) {
                    val label = value.substring(labelStart, labelEnd)
                    val url = safeMarkdownUrl(value.substring(labelEnd + 2, urlEnd))
                    if (url != null) {
                        withLink(
                            LinkAnnotation.Url(
                                url,
                                TextLinkStyles(SpanStyle(color = FocusBlue, textDecoration = TextDecoration.Underline)),
                            ),
                        ) { appendMarkdown(label) }
                    } else {
                        appendMarkdown(label)
                    }
                    index = urlEnd + 1
                    continue
                }
            }
        }

        append(value[index])
        index++
    }
}

private fun String.closingParen(open: Int): Int {
    var depth = 1
    for (index in open + 1 until length) {
        if (this[index] == '(') depth++
        if (this[index] == ')' && --depth == 0) return index
    }
    return -1
}

private fun safeMarkdownUrl(value: String): String? {
    val trimmed = value.trim()
    val scheme = trimmed.substringBefore(':', missingDelimiterValue = "").lowercase()
    return trimmed.takeIf { scheme in setOf("http", "https", "mailto", "tel") }
}
