import { Button, Screen, Text } from '@/ui/components';

/** Email one-time code, plus Apple and Google sign-in (PRD §8). Every method
 *  resolves to one stable internal user UUID, so a user who signs in a
 *  different way next time is the same account. */
export default function SignInScreen() {
  return (
    <Screen airy>
      <Text variant="display">Keep what you watch.</Text>
      <Text variant="body" tone="secondary">
        Rank films and seasons against each other, and find out whose taste actually
        matches yours.
      </Text>
      <Button label="Continue with email" onPress={() => {}} />
      <Button label="Continue with Apple" kind="secondary" onPress={() => {}} />
      <Button label="Continue with Google" kind="secondary" onPress={() => {}} />
    </Screen>
  );
}
