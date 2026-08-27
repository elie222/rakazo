package com.rakazo.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class OrganicAvatarTest {
    @Test
    fun identitySeedMatchesTheSharedRakazoAlgorithm() {
        assertEquals(3_344_284, avatarIdentitySeed("maya"))
        assertEquals(1_245_635_613, avatarIdentitySeed("github"))
        assertNotEquals(avatarIdentitySeed("research"), avatarIdentitySeed("calendar"))
    }
}
