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
  EMAIL_OTP_TYPES,
  isAppleSignInAvailable,
  oauthRedirectUrl,
  resendSignUpCode,
  sendEmailCode,
  signInWithApple,
  signInWithEmailPassword,
  signInWithGoogle,
  signOut,
  signUpWithEmailPassword,
  takePendingDisplayName,
  verifyEmailCode,
  verifySignUpCode,
  type PasswordSignInOutcome,
  type SignInOutcome,
  type SignUpOutcome,
  type VerifyMode,
} from './methods';

export { applyInitialVisibility, createProfile, usernameAvailability } from './create-profile';

export { AuthStatusOverlay } from './status-overlay';

export { RouteErrorBoundary } from './RouteErrorBoundary';
