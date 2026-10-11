package io.ghostlink.app

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.concurrent.Executors
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * PBKDF2 in native code on a background pool, off the JS thread (pure-JS
 * PBKDF2 takes minutes under Hermes).
 *
 * Implemented over javax.crypto.Mac rather than SecretKeyFactory: the password
 * is explicitly the phrase's UTF-8 bytes (output must match @noble byte for
 * byte), and PBKDF2WithHmacSHA512 needs API 26 while minSdk is 24.
 */
class Pbkdf2Module(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  private val pool = Executors.newFixedThreadPool(2) { r ->
    Thread(r, "ghostlink-pbkdf2").apply { isDaemon = true }
  }

  override fun getName() = "Pbkdf2"

  /**
   * @param password  the recovery phrase; hashed as its UTF-8 bytes
   * @param salt      domain-separation string; hashed as its UTF-8 bytes
   * @param iterations PBKDF2 `c`
   * @param keyLength  desired output in bytes
   * @param hash      "sha256" or "sha512"
   * @return lowercase hex of the derived key
   */
  @ReactMethod
  fun derive(
      password: String,
      salt: String,
      iterations: Int,
      keyLength: Int,
      hash: String,
      promise: Promise
  ) {
    pool.execute {
      try {
        val algorithm = when (hash.lowercase()) {
          "sha256" -> "HmacSHA256"
          "sha512" -> "HmacSHA512"
          else -> {
            promise.reject("E_HASH", "Unsupported hash: $hash")
            return@execute
          }
        }
        if (iterations < 1 || keyLength < 1 || keyLength > 1024) {
          promise.reject("E_PARAMS", "Bad iterations/keyLength")
          return@execute
        }
        val out = pbkdf2(
            password.toByteArray(Charsets.UTF_8),
            salt.toByteArray(Charsets.UTF_8),
            iterations,
            keyLength,
            algorithm
        )
        promise.resolve(out.joinToString("") { "%02x".format(it) })
      } catch (e: Throwable) {
        // Rejecting sends the caller back to the JS implementation rather than
        // leaving it without a key.
        promise.reject("E_PBKDF2", e.message ?: e.toString(), e)
      }
    }
  }

  /** RFC 8018 PBKDF2. */
  private fun pbkdf2(
      password: ByteArray,
      salt: ByteArray,
      iterations: Int,
      keyLength: Int,
      algorithm: String
  ): ByteArray {
    val mac = Mac.getInstance(algorithm)
    mac.init(SecretKeySpec(password, algorithm))
    val hLen = mac.macLength
    val blocks = (keyLength + hLen - 1) / hLen
    val out = ByteArray(keyLength)
    var offset = 0

    for (i in 1..blocks) {
      // U1 = PRF(P, S || INT_32_BE(i))
      mac.update(salt)
      mac.update(byteArrayOf(
          (i ushr 24).toByte(), (i ushr 16).toByte(), (i ushr 8).toByte(), i.toByte()))
      var u = mac.doFinal()
      val t = u.copyOf()

      // T_i = U1 xor U2 xor ... xor Uc
      for (round in 2..iterations) {
        u = mac.doFinal(u)
        for (k in t.indices) t[k] = (t[k].toInt() xor u[k].toInt()).toByte()
      }

      val take = minOf(hLen, keyLength - offset)
      System.arraycopy(t, 0, out, offset, take)
      offset += take
    }
    return out
  }
}
