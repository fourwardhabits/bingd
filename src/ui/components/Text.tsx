import {
  Text as RNText,
  type TextProps as RNTextProps,
  type TextStyle,
} from 'react-native';

import { theme } from '../tokens';
import type { TypographyToken } from '../tokens';

type Tone = 'primary' | 'secondary' | 'tertiary' | 'inverse' | 'onFill' | 'action';

export type TextProps = RNTextProps & {
  variant?: TypographyToken;
  tone?: Tone;
};

/**
 * The only text primitive. Screens do not use react-native's Text directly,
 * because that is how a font family or a non-token colour slips in.
 *
 * Dynamic Type scaling is inherited from the token: display sizes cap at 130%,
 * everything else scales without a ceiling (design-system.md §4).
 */
export function Text({ variant = 'body', tone = 'primary', style, ...rest }: TextProps) {
  const toneColor =
    tone === 'action' ? theme.semantic.action : theme.text[tone as keyof typeof theme.text];

  const { maxFontSizeMultiplier, ...typeStyle }: TextStyle & {
    maxFontSizeMultiplier?: number;
  } = theme.typography[variant];

  return (
    <RNText
      maxFontSizeMultiplier={maxFontSizeMultiplier}
      style={[typeStyle, { color: toneColor }, style]}
      {...rest}
    />
  );
}
