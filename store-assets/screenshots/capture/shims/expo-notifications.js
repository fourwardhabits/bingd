// Render only. Push is native-only and has no web implementation.
const noop = () => {};
const sub = () => ({ remove: noop });

module.exports = {
  getLastNotificationResponse: () => null,
  getLastNotificationResponseAsync: async () => null,
  clearLastNotificationResponse: noop,
  clearLastNotificationResponseAsync: async () => {},
  useLastNotificationResponse: () => null,
  setNotificationHandler: noop,
  setNotificationChannelAsync: async () => null,
  setNotificationCategoryAsync: async () => null,
  addNotificationResponseReceivedListener: sub,
  addNotificationReceivedListener: sub,
  addPushTokenListener: sub,
  getPermissionsAsync: async () => ({ status: 'undetermined', granted: false, canAskAgain: true }),
  requestPermissionsAsync: async () => ({ status: 'denied', granted: false, canAskAgain: false }),
  getDevicePushTokenAsync: async () => ({ type: 'web', data: 'mock' }),
  getExpoPushTokenAsync: async () => ({ type: 'expo', data: 'mock' }),
  setBadgeCountAsync: async () => true,
  getBadgeCountAsync: async () => 0,
  dismissAllNotificationsAsync: async () => {},
  AndroidImportance: { MAX: 5, HIGH: 4, DEFAULT: 3 },
  IosAuthorizationStatus: { NOT_DETERMINED: 0, DENIED: 1, AUTHORIZED: 2, PROVISIONAL: 3 },
};
