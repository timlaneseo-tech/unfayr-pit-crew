export type PageType = 'home' | 'service' | 'location' | 'product' | 'collection' | 'article' | 'other';
export type Platform = 'shopify' | 'wordpress' | 'webflow' | 'wix' | 'squarespace' | 'unknown';
export type Field = 'title' | 'meta' | 'h1';
export type Source = 'page' | 'interview' | 'search results';
export interface FieldValues { title: string | null; meta: string | null; h1: string | null }

export interface PageRecord {
  url: string;               // normaliseUrl() form
  slug: string;
  type: PageType;
  title: string | null; meta: string | null; h1s: string[]; h2s: string[];
  intro: string;             // first 100 words of main content
  text: string;              // main-content text, max 20,000 chars (number/claim checks)
  jsonLdTypes: string[]; altMissing: number; altTotal: number; cta: string | null;
  inlinks: number; navLinked: boolean;
  ogTitle: string | null; ogDescription: string | null;   // Open Graph, decoded; null when absent
}

export interface Convention {
  separator: '|' | '–' | ':';
  brand: string;
  brandPosition: 'end' | 'end-if-fits';
  case: 'title' | 'sentence';
  patterns: Partial<Record<PageType, string>>;   // e.g. '{Service} in {City}' (brand appended by rule)
}

export interface Interview {
  brand: string;
  /** appliesTo: the page types an answer may source (for example a price for product, collection, service and location pages). Absent: every page. */
  answers: { id: string; question: string; answer: string | null; appliesTo?: PageType[] }[];
  convention: Convention;
  updatedAt: string;
}

export interface DeepFix { query: string; intro: string; h2s: string[]; faq: { q: string; a: string }[]; schema: string; altFixes: string[]; citationFacts: string[] }

export type LintRule = 'title-length' | 'meta-length' | 'h1-count' | 'duplicate' | 'convention' | 'unsourced-number' | 'unsourced-claim' | 'add-slot' | 'brand-spelling' | 'title-pixels' | 'title-h1-mismatch' | 'near-duplicate' | 'stale-year';
/** block: the row cannot be published until fixed. warn: shown in the workbook, does not block (R5). */
export type LintSeverity = 'block' | 'warn';
export interface LintIssue { rule: LintRule; field: Field; message: string; severity: LintSeverity }
export type LintStatus = 'ok' | 'needs review' | 'has [ADD]';

export interface Proposal {
  url: string; type: PageType; tier: 'top' | 'pattern';
  current: FieldValues; proposed: FieldValues;   // proposed null = keep current
  reason: string; sources: Source[];
  issues: LintIssue[]; status: LintStatus;
  approve: boolean | null;
  deep?: DeepFix;
}
