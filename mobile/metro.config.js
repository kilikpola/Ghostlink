const path = require('path');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

const defaultConfig = getDefaultConfig(__dirname);

// npm workspaces hoist node_modules to the repo root, outside Metro's project
// root, so watch it and add it to the module search path.
const repoRoot = path.resolve(__dirname, '..');

const config = {
  watchFolders: [repoRoot],
  transformer: {
    getTransformOptions: async () => ({
      transform: {
        experimentalImportSupport: false,
        inlineRequires: true,
      },
    }),
  },
  resolver: {
    nodeModulesPaths: [
      path.resolve(__dirname, 'node_modules'),
      path.resolve(repoRoot, 'node_modules'),
    ],
    // react-native-push-notification's iOS entry imports
    // @react-native-community/push-notification-ios, which is not installed,
    // so the iOS bundle could not build at all. Notifications are a
    // placeholder (App.js's handlers are TODOs) and Android-only for now: on
    // iOS the module resolves empty, and App.js already skips a module that
    // has no configure().
    resolveRequest: (context, moduleName, platform) => {
      if (platform === 'ios' && moduleName === 'react-native-push-notification') {
        return {type: 'empty'};
      }
      return context.resolveRequest(context, moduleName, platform);
    },
    sourceExts: [...defaultConfig.resolver.sourceExts, 'svg'],
    assetExts: defaultConfig.resolver.assetExts.filter(ext => ext !== 'svg'),
  },
};

module.exports = mergeConfig(defaultConfig, config);
