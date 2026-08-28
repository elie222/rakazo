package com.rakazo.app.network

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.io.IOException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

interface SessionStore {
    var endpoint: String
    var token: String
}

class SessionStorageException(message: String, cause: Throwable? = null) : IOException(message, cause)

class SessionManager(private val store: SessionStore) {
    val endpoint get() = store.endpoint
    val token get() = store.token

    fun useEndpoint(value: String) {
        if (value != store.endpoint) store.token = ""
        store.endpoint = value
    }

    fun signedIn(value: String) {
        store.token = value
    }

    fun signedOut() {
        store.token = ""
    }
}

class AndroidSessionStore(context: Context) : SessionStore {
    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    override var endpoint: String
        get() = preferences.getString(ENDPOINT, "").orEmpty()
        set(value) = commit { putString(ENDPOINT, value) }

    override var token: String
        get() {
            val encoded = preferences.getString(TOKEN, null) ?: return ""
            return runCatching {
                val bytes = Base64.decode(encoded, Base64.NO_WRAP)
                val cipher = Cipher.getInstance(TRANSFORMATION)
                cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, IV_SIZE))
                String(cipher.doFinal(bytes, IV_SIZE, bytes.size - IV_SIZE), Charsets.UTF_8)
            }.getOrElse {
                commit { remove(TOKEN) }
                ""
            }
        }
        set(value) {
            try {
                if (value.isEmpty()) {
                    commit { remove(TOKEN) }
                    return
                }
                val cipher = Cipher.getInstance(TRANSFORMATION)
                cipher.init(Cipher.ENCRYPT_MODE, key())
                val encrypted = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
                commit { putString(TOKEN, Base64.encodeToString(encrypted, Base64.NO_WRAP)) }
            } catch (error: SessionStorageException) {
                throw error
            } catch (error: Exception) {
                throw SessionStorageException("Could not store the session securely", error)
            }
        }

    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
            generateKey()
        }
    }

    private fun commit(change: android.content.SharedPreferences.Editor.() -> Unit) {
        if (!preferences.edit().apply(change).commit()) {
            throw SessionStorageException("Could not persist session state")
        }
    }

    private companion object {
        const val PREFERENCES = "com.rakazo.app.session"
        const val ENDPOINT = "endpoint"
        const val TOKEN = "token"
        const val KEY_ALIAS = "rakazo.session"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_SIZE = 12
    }
}
