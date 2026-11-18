package com.rakazo.notifications

import org.junit.Assert.assertEquals
import org.junit.Test

class MarkdownPreviewTest {
  @Test
  fun `normalizes CR LF and CRLF before reading Markdown blocks`() {
    val cases = listOf(
      "# Heading\n## Subheading" to "Heading Subheading",
      "- first\n- second\n1. third" to "first second third",
      "```ts\nconst x = 1;\n```\nAfter" to "const x = 1; After",
      "| A | B |\n| --- | --- |\n| 1 | 2 |" to "A, B 1, 2",
    )
    for (eol in listOf("\n", "\r\n", "\r")) {
      for ((source, expected) in cases) {
        assertEquals(expected, markdownToPreview(source.replace("\n", eol)))
      }
    }
    assertEquals("A B C D", markdownToPreview("# A\r\n- B\r> C\n## D"))
  }

  @Test
  fun `removes complete and unfinished HTML comments`() {
    for (source in listOf(
      "a <!-- x > hidden --> b",
      "a <!-- x > hidden\nmore --> b",
      "a <!-- an unmatched ' quote > hidden --> b",
      "a <!-- <b>hidden</b> --> b",
      "a <!-- x > hidden --> <!-- more > hidden --> b",
    )) assertEquals("a b", markdownToPreview(source))
    assertEquals("a", markdownToPreview("a <!-- hidden"))
    assertEquals("a", markdownToPreview("a <!-- x > hidden"))
    assertEquals("<!-- x > hidden -->", markdownToPreview("`<!-- x > hidden -->`"))
    assertEquals("<!-- x > hidden -->", markdownToPreview("\\<!-- x > hidden -->"))
  }

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
