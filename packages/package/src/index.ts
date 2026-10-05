/**
 * @floorspec/package — the `.floorspec` package (FLR-T-9.1): a Floorspec document and its assets as
 * one deterministic ZIP or the identical unpacked folder, and both read back under limits that a
 * hostile archive cannot get past. Isomorphic (FLR-ADR-010): the editor opens a package in the
 * browser, the server on import and export, the CLI on disk. README.md defines the layout.
 */
export { PackageError, type PackageErrorCode } from './errors.js';
export { crc32 } from './crc32.js';
export { comparePaths, isSafePath, pathProblem, MAX_PATH_BYTES, MAX_SEGMENT_BYTES } from './paths.js';
export { isZip, readZip, writeZip, type ReadZip, type ZipEntry, type ZipLimits } from './zip.js';
export {
  DEFAULT_LIMITS,
  DOCUMENT_NAME,
  PACKAGE_EXTENSION,
  PACKAGE_MEDIA_TYPE,
  openEntries,
  packageEntries,
  packageZip,
  packagedAssets,
  parseDocument,
  readPackage,
  type BuiltPackage,
  type OpenedPackage,
  type PackageLimits,
  type PackagedAsset,
} from './package.js';
export { documentToBatch, type BatchOp, type BatchOptions } from './batch.js';
