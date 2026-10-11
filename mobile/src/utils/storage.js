/**
 * The app's one storage handle: AsyncStorage for the bytes,
 * react-native-encrypted-storage for the data key, the platform CSPRNG
 * (react-native-get-random-values, imported in index.js) for keys and nonces.
 * Every read and write of app data goes through here; see secret-storage.js
 * for what is sealed and why.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import EncryptedStorage from 'react-native-encrypted-storage';
import {createSecretStorage} from './secret-storage';

function randomBytes(n) {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export const storage = createSecretStorage({
  plain: AsyncStorage,
  secure: EncryptedStorage,
  randomBytes,
});

export {STORAGE_CLASSIFICATION, SECRET_KEYS, RETIRED_KEYS} from './secret-storage';
