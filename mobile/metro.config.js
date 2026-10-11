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
    sourceExts: [...defaultConfig.resolver.sourceExts, 'svg'],
    assetExts: defaultConfig.resolver.assetExts.filter(ext => ext !== 'svg'),
  },
};

module.exports = mergeConfig(defaultConfig, config);
