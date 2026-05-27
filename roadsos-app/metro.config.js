// metro.config.js
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Tell the bundler to allow WebAssembly files so SQLite doesn't crash the web compiler
config.resolver.assetExts.push('wasm');

module.exports = config;