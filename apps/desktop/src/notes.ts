// The notes are written for the repository, where a link to another of its files is a path. Shown in the
// program, such a link points at that file on GitHub as the version has it.
export function absoluteLinks(text: string, repository: string, version: string) {
  return text.replace(
    /\]\((?!https?:|#|mailto:)([^)\s]+)\)/g,
    (_link, path: string) => `](${repository}/blob/v${version}/${path.replace(/^\.?\//, '')})`,
  );
}
// One version's section of CHANGELOG.md, without its heading; null when the file has none for it.
export function releaseSection(changelog: string, version: string) {
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const start = lines.indexOf(`## ${version}`);
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return (
    lines
      .slice(start + 1, end < 0 ? undefined : end)
      .join('\n')
      .trim() || null
  );
}
// For the in-app notes: a link to a file of the repository or to a GitHub page becomes its words only, so the
// dialog sends nobody to GitHub; other links stay.
export function withoutRepositoryLinks(text: string) {
  return text.replace(
    /\[([^\]]*)\]\((?:https?:\/\/(?:www\.)?github\.com\/[^)\s]*|(?!https?:|#|mailto:)[^)\s]+)\)/g,
    '$1',
  );
}
