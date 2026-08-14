import { Text } from './Text';

export type TitleMetadataProps = {
  year?: number | string | null;
  runtimeMinutes?: number | null;
  genres?: string[] | null;
  director?: string | null;
  bucketLabel?: string | null;
  showYear?: boolean;
};

function formatTitleMetadata({
  year,
  runtimeMinutes,
  genres,
  director,
  bucketLabel,
  showYear = true,
}: TitleMetadataProps): string {
  const parts = [
    bucketLabel ?? null,
    showYear && year ? String(year) : null,
    runtimeMinutes ? `${runtimeMinutes}m` : null,
    genres?.length ? genres.slice(0, 2).join(' · ') : null,
    director ?? null,
  ].filter(Boolean);

  return parts.join(' · ');
}

export function TitleMetadata(props: TitleMetadataProps) {
  const content = formatTitleMetadata(props);
  if (!content) return null;

  return (
    <Text variant="footnote" tone="secondary" numberOfLines={1}>
      {content}
    </Text>
  );
}
