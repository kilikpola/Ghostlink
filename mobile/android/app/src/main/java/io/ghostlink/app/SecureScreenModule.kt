package io.ghostlink.app

import android.view.WindowManager
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise

/**
 * Sets FLAG_SECURE on the activity window while a recovery phrase is shown:
 * no screenshots, screen recording or recent-apps preview. Reference counted,
 * because the next secure screen may mount before the previous one unmounts.
 */
class SecureScreenModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  private var holders = 0

  override fun getName() = "SecureScreen"

  /** Take a reference and set the flag. Safe to call from several screens. */
  @ReactMethod
  fun acquire(promise: Promise) {
    val activity = currentActivity
    if (activity == null) {
      // The caller must be able to tell "protected" from "could not protect".
      promise.reject("no_activity", "No current activity to secure")
      return
    }
    activity.runOnUiThread {
      holders += 1
      activity.window.setFlags(
          WindowManager.LayoutParams.FLAG_SECURE,
          WindowManager.LayoutParams.FLAG_SECURE
      )
    }
    promise.resolve(true)
  }

  /** Release a reference; the flag clears when the last holder goes. */
  @ReactMethod
  fun release(promise: Promise) {
    val activity = currentActivity
    if (activity == null) {
      promise.resolve(false)
      return
    }
    activity.runOnUiThread {
      holders = maxOf(0, holders - 1)
      if (holders == 0) {
        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
      }
    }
    promise.resolve(true)
  }

  /** Whether the window is currently protected. Used by tests and diagnostics. */
  @ReactMethod
  fun isSecure(promise: Promise) {
    val activity = currentActivity
    if (activity == null) {
      promise.resolve(false)
      return
    }
    val flags = activity.window.attributes.flags
    promise.resolve((flags and WindowManager.LayoutParams.FLAG_SECURE) != 0)
  }
}
