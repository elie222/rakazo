package com.rakazo.app.ui

import androidx.compose.ui.text.font.FontWeight
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownTextTest {
    @Test
    fun parsesAssistantMarkdownIntoStructuredBlocksAndInlineStyles() {
        val blocks = parseMarkdownBlocks(
            """
            There are a few potentially actionable items.

            - **Google:** Confirm the sign-in.
            - **Notion:** Review the new-device login.

            Everything else is informational.
            """.trimIndent(),
        )

        assertEquals(3, blocks.size)
        assertEquals(2, (blocks[1] as MarkdownBlock.ListBlock).items.size)
        val item = inlineMarkdown((blocks[1] as MarkdownBlock.ListBlock).items.first())
        assertEquals("Google: Confirm the sign-in.", item.text)
        assertTrue(item.spanStyles.any { it.item.fontWeight == FontWeight.Bold && it.start == 0 && it.end == 7 })

        val unsafeLink = inlineMarkdown("[bad](javascript:alert(1))")
        assertEquals("bad", unsafeLink.text)
        assertTrue(unsafeLink.getLinkAnnotations(0, unsafeLink.length).isEmpty())
    }
}
