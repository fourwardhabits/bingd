// Learn more: https://docs.sentry.io/platforms/react-native/manual-setup/expo/
//
// Why this file exists: production runs OTA bundles, and an OTA bundle's source map can
// only be matched to a crash by its Debug ID. `getSentryExpoConfig` is Expo's default Metro
// config plus Sentry's serializer, which writes that Debug ID into each bundle and its map.
// Without it, `upload_sentry_sourcemaps` in .eas/workflows/ota-production.yml uploads maps
// that no event can refer to, and production stacks stay minified.
//
// Store binaries already upload maps by release/dist from the native build
// (`createBundleReleaseJsAndAssets_SentryUpload_*`, "Upload Debug Symbols to Sentry").
// This changes the JS bundle only: Metro config is not a native-fingerprint input, so no
// runtime moves (checked locally with @expo/fingerprint, both platforms).
const { getSentryExpoConfig } = require('@sentry/react-native/metro');

module.exports = getSentryExpoConfig(__dirname);
