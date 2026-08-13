export {
  AuthProvider,
  useAuth,
  useAuthRouting,
  useCurrentProfile,
  type AuthState,
  type Profile,
} from './session';

export {
  clearPendingDisplayName,
  isAppleSignInAvailable,
  oauthRedirectUrl,
  sendEmailCode,
  signInWithApple,
  signInWithGoogle,
  signOut,
  takePendingDisplayName,
  verifyEmailCode,
  type SignInOutcome,
} from './methods';

export { createProfile, usernameAvailability } from './create-profile';
