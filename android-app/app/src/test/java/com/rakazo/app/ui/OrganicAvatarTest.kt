package com.rakazo.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class OrganicAvatarTest {
    @Test
    fun identitySeedMatchesTheSharedRakazoAlgorithm() {
        assertEquals(3_344_284L, avatarIdentitySeed("maya"))
        assertEquals(1_245_635_613L, avatarIdentitySeed("github"))
        assertNotEquals(avatarIdentitySeed("research"), avatarIdentitySeed("calendar"))
    }

    @Test
    fun currentUpstreamGeometryHasTenSmoothShapeFamilies() {
        val pointCounts = (0 until 10).map { seed ->
            organicAvatarPoints(seed.toLong(), -((seed % 360) * Math.PI) / 180).size
        }

        assertEquals(listOf(88, 56, 52, 80, 72, 64, 56, 56, 48, 56), pointCounts)
        assertEquals(
            10,
            (0 until 10).map { seed ->
                organicAvatarPoints(seed.toLong(), -((seed % 360) * Math.PI) / 180)
            }.toSet().size,
        )
    }

    @Test
    fun workingMotionUsesTheUpstreamFamilySpecificChoreography() {
        val floatingStart = workingAvatarFrame(seed = 0, progress = 0f)
        val floatingMiddle = workingAvatarFrame(seed = 0, progress = 0.5f)
        val swayingMiddle = workingAvatarFrame(seed = 2, progress = 0.5f)

        assertNotEquals(floatingStart.translationY, floatingMiddle.translationY)
        assertNotEquals(floatingMiddle.rotationZ, swayingMiddle.rotationZ)
        assertNotEquals(floatingMiddle.eyeOffsetX, swayingMiddle.eyeOffsetX)
    }
}
