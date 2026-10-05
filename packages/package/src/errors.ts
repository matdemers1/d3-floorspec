/**
 * Why a file could not be read as a package. Every refusal has a code a program can branch on and a
 * message a person can act on; none is a crash.
 */
export type PackageErrorCode =
  /** Not a ZIP archive at all, or one whose structure contradicts itself. */
  | 'not-a-zip'
  | 'corrupt'
  /** Features a package never needs, refused rather than half-supported. */
  | 'zip64'
  | 'multi-disk'
  | 'encrypted'
  | 'unsupported-method'
  /** An entry that would land outside the package, or is not a plain file. */
  | 'unsafe-path'
  | 'symlink'
  | 'special-file'
  | 'duplicate-path'
  /** Limits (PackageLimits). */
  | 'too-large'
  | 'too-many-entries'
  /** No document where a package keeps it. */
  | 'no-document'
  /** A package cannot be written: two files at one path, or an archive past the ZIP format's own limits. */
  | 'conflict';

export class PackageError extends Error {
  constructor(
    readonly code: PackageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PackageError';
  }
}
