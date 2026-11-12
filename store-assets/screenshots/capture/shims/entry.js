// Render only. react-native-web hard-codes hairlineWidth to 1, and a 3x phone draws a
// single device pixel. Set before any component module reads it, so these renders match a
// device instead of drawing every outline three times too heavy.
const { StyleSheet } = require('react-native');

StyleSheet.hairlineWidth = 1 / 3;
require('expo-router/entry');
