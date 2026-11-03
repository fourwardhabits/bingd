// Render only: aliases native-only modules to web stubs in the exported copy.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);
const stubs = { 'expo-notifications': path.join(__dirname, 'shims/expo-notifications.js') };
const original = config.resolver.resolveRequest;

config.resolver.resolveRequest = (ctx, name, platform) => {
  if (platform === 'web' && stubs[name]) return { type: 'sourceFile', filePath: stubs[name] };
  return original ? original(ctx, name, platform) : ctx.resolveRequest(ctx, name, platform);
};

module.exports = config;
