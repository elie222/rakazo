package com.rakazo.notifications

import org.junit.Assert.assertEquals
import org.junit.Test

class MarkdownPreviewTest {
  @Test
  fun `flattens common markdown into one notification line`() {
    assertEquals("bold and italic", markdownToPreview("**bold** and _italic_"))
    assertEquals("label", markdownToPreview("[label](https://example.test/path)"))
    assertEquals("Heading", markdownToPreview("# Heading"))
    assertEquals("code", markdownToPreview("```\ncode\n```"))
    assertEquals("A, B 1, 2", markdownToPreview("| A | B |\n| --- | --- |\n| 1 | 2 |"))
  }

  @Test
  fun `keeps escaped punctuation and caps a huge reply`() {
    assertEquals("*literal*", markdownToPreview("\\*literal\\*"))

    val preview = markdownToPreview("x".repeat(10_000))
    assertEquals(4_096, preview.length)
  }
}
