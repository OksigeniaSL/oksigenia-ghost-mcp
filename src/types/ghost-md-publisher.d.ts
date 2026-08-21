// Ambient type declarations for the (JS/CJS) internals of @oksigenia/ghost-md-publisher.
// The package ships no .d.ts; we declare only the surface we consume. Loose `any`
// on Ghost payloads is deliberate for v1 — the Admin API shapes are large and stable.

declare module '@oksigenia/ghost-md-publisher/lib/ghost-client' {
  export function getClient(): any;
  export function verifyClient(client: any): Promise<void>;
}

declare module '@oksigenia/ghost-md-publisher/lib/posts' {
  export function upsertPost(
    client: any,
    frontmatter: any,
    html: string,
    opts?: { dryRun?: boolean; force?: boolean }
  ): Promise<
    | { dryRun: true; payload: any }
    | { dryRun: false; post: any }
    | { blocked: true; existing: { id: string; title: string; slug: string; status: string; url: string } }
  >;
}

declare module '@oksigenia/ghost-md-publisher/lib/markdown' {
  export function render(
    md: string,
    opts?: { historicalDate?: string; historicalYear?: string | number; historicalDateClass?: string }
  ): string;
}

declare module '@oksigenia/ghost-md-publisher/lib/bookmarks' {
  export function resolveBookmarks(md: string, opts?: { timeoutMs?: number }): Promise<string>;
}

declare module '@oksigenia/ghost-md-publisher/lib/images' {
  export function findLocalImages(content: string, frontmatter: any, baseDir: string): any[];
  export function uploadAll(client: any, images: any[], opts?: any): Promise<Map<string, string>>;
  export function rewriteContent(content: string, urlMap: Map<string, string>): string;
}

declare module '@oksigenia/ghost-md-publisher/lib/image-processing' {
  export function processImage(path: string, opts?: any): Promise<{ path: string; [k: string]: any } | string>;
  export const DEFAULTS: any;
}
