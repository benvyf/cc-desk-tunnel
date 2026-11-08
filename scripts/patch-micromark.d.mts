export function applyMicromarkPatch(packageDirectory?: string): {
  version: string;
  changed: string[];
};

export function patchMicromarkSource(source: string, relativePath: string): string;

export const micromarkSourceVariants: {
  path: string;
  originalSha256: string;
  patchedSha256: string;
  original: string;
  replacement: string;
}[];
