/**
 * Block screenshots while a recovery phrase is on screen, via FLAG_SECURE
 * (SecureScreenModule): no screenshots, screen recording or recent-apps
 * preview. Android only; callers learn whether protection is in place.
 */

import {useEffect, useState} from 'react';
import {NativeModules, Platform} from 'react-native';

const {SecureScreen} = NativeModules;

/** Is the native module present in this build? */
export const SECURE_SCREEN_AVAILABLE =
  Platform.OS === 'android' && !!SecureScreen && typeof SecureScreen.acquire === 'function';

/**
 * Hold the screen secure while the component is mounted.
 *
 * @returns {{secured: boolean, available: boolean}} whether protection is
 *   actually applied
 */
export function useSecureScreen() {
  return useSecureScreenWhen(true);
}

/** Hold the screen secure only while `active` is true (hooks cannot be conditional). */
export function useSecureScreenWhen(active) {
  const [secured, setSecured] = useState(false);

  useEffect(() => {
    if (!SECURE_SCREEN_AVAILABLE || !active) {
      setSecured(false);
      return undefined;
    }

    let cancelled = false;
    SecureScreen.acquire()
      .then(() => {
        if (!cancelled) setSecured(true);
      })
      .catch(() => {
        // No activity, or the window refused the flag. Report honestly.
        if (!cancelled) setSecured(false);
      });

    return () => {
      cancelled = true;
      // Reference counted natively, so releasing here cannot drop the flag
      // while another secure screen is still mounted.
      SecureScreen.release().catch(() => {});
    };
  }, [active]);

  return {secured, available: SECURE_SCREEN_AVAILABLE};
}

export default useSecureScreen;
