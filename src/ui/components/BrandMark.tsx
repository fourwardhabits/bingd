import { Image } from 'expo-image';

const ICON = require('../../../assets/brand/bingd-icon.svg');

export type BrandMarkProps = {
  size?: 'sm' | 'md' | 'lg';
  decorative?: boolean;
};

const SIZES = {
  sm: { width: 32, height: 19 },
  md: { width: 42, height: 25 },
  lg: { width: 64, height: 38 },
} as const;

export function BrandMark({ size = 'md', decorative = false }: BrandMarkProps) {
  return (
    <Image
      source={ICON}
      style={SIZES[size]}
      contentFit="contain"
      accessibilityLabel={decorative ? undefined : 'bingd mark'}
      accessible={!decorative}
      accessibilityElementsHidden={decorative}
      importantForAccessibility={decorative ? 'no-hide-descendants' : 'auto'}
    />
  );
}

