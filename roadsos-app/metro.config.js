const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// Tell the Metro bundler to safely package WebAssembly files
config.resolver.assetExts.push('wasm');

module.exports = config;