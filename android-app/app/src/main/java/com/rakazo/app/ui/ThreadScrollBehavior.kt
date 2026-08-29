package com.rakazo.app.ui

internal class ThreadScrollBehavior {
    private var threadId: String? = null
    private var following = true

    fun shouldScrollToLatest(nextThreadId: String): Boolean {
        if (threadId != nextThreadId) {
            threadId = nextThreadId
            following = true
        }
        return following
    }

    fun onUserScroll(canScrollForward: Boolean) {
        following = !canScrollForward
    }

    fun jumpToLatest() {
        following = true
    }
}
