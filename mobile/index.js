/**
 * Must stay first: polyfills crypto.getRandomValues from the platform CSPRNG,
 * which src/utils/crypto.js requires.
 */
import 'react-native-get-random-values';

/** Hermes has no TextEncoder/TextDecoder; needed before any crypto runs. */
import './src/utils/text-encoding-polyfill';

import {AppRegistry} from 'react-native';
import App from './App';

AppRegistry.registerComponent('GhostLinkMobile', () => App);
