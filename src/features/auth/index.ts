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
  signInWithEmailPassword,
  signInWithGoogle,
  signOut,
  takePendingDisplayName,
  verifyEmailCode,
  type SignInOutcome,
} from './methods';

export { applyInitialVisibility, createProfile, usernameAvailability } from './create-profile';

export { AuthStatusOverlay } from './status-overlay';
