/** Element types of the official extensions: the generated types of their members, with Core's members. */
import type { ExtensionElement } from '../model/document.js';

type CoreMembers = 'fallback' | 'host' | 'clearances' | 'name' | 'extras';
/** An element of an extension kind: the kind's own members (generated from its schema) and Core's (12.5). */
export type Element<T> = Omit<T, CoreMembers> & ExtensionElement;
