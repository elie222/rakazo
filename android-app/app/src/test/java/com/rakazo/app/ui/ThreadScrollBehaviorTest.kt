package com.rakazo.app.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ThreadScrollBehaviorTest {
    @Test
    fun opensAtLatestAndOnlyFollowsWhileReaderRemainsAtTheEnd() {
        val behavior = ThreadScrollBehavior()

        assertTrue(behavior.shouldScrollToLatest("thread-1"))
        behavior.onUserScroll(canScrollForward = true)
        assertFalse(behavior.shouldScrollToLatest("thread-1"))
        behavior.onUserScroll(canScrollForward = false)
        assertTrue(behavior.shouldScrollToLatest("thread-1"))
    }
}
