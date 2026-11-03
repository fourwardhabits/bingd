import { Image } from 'expo-image';

const ICON = require('../../../assets/brand/bingd-icon.svg');
const ICON_SMALL = require('../../../assets/brand/bingd-icon-small.svg');
const ICON_REVERSED = require('../../../assets/brand/bingd-icon-reversed.svg');

export type BrandMarkProps = {
  size?: 'sm' | 'md' | 'lg';
  decorative?: boolean;
  reversed?: boolean;
};

const SIZES = {
  sm: { width: 35, height: 21 },
  md: { width: 42, height: 25 },
  lg: { width: 64, height: 38 },
} as const;

export function BrandMark({ size = 'md', decorative = false, reversed = false }: BrandMarkProps) {
  return (
    <Image
      source={reversed ? ICON_REVERSED : size === 'sm' ? ICON_SMALL : ICON}
      style={SIZES[size]}
      contentFit="contain"
      accessibilityLabel={decorative ? undefined : 'bingd mark'}
      accessible={!decorative}
      accessibilityElementsHidden={decorative}
      importantForAccessibility={decorative ? 'no-hide-descendants' : 'auto'}
    />
  );
}

