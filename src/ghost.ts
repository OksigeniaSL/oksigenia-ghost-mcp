// Thin Ghost layer for the MCP server. Reuses the ghost-md-publisher toolkit
// (Admin API client, markdown→HTML with native cards, image processing, upsert)
// so the MCP and the CLI share exactly the same battle-tested building blocks.

import { getClient, verifyClient } from '@oksigenia/ghost-md-publisher/lib/ghost-client';
import { upsertPost } from '@oksigenia/ghost-md-publisher/lib/posts';
import { render } from '@oksigenia/ghost-md-publisher/lib/markdown';
import { resolveBookmarks } from '@oksigenia/ghost-md-publisher/lib/bookmarks';
import { findLocalImages, uploadAll, rewriteContent } from '@oksigenia/ghost-md-publisher/lib/images';
import { processImage } from '@oksigenia/ghost-md-publisher/lib/image-processing';

let _client: any = null;
function client(): any {
  if (!_client) _client = getClient(); // reads GHOST_URL / GHOST_ADMIN_API_KEY / GHOST_API_VERSION from env
  return _client;
}

// ── Xpresiva knowledge (the theme's conventions the MCP is aware of) ──────────
// The theme's own custom_theme_settings can't be read via the Admin API (Ghost
// returns 403 for integration tokens), so "Xpresiva-aware" means these baked-in
// conventions, not reading the live theme config.
export const XPRESIVA_TEMPLATES = ['custom-wide-feature-image', 'custom-full-feature-image'];
export const XPRESIVA_LOCALES = ['en', 'es', 'fr', 'de', 'pt', 'it', 'nl'];
const RESERVED_INTERNAL = new Set([
  ...XPRESIVA_LOCALES.map((l) => `hash-${l}`),
  'hash-historical',
]);

function readingTime(html: string | undefined): number {
  const words = (html || '').replace(/<[^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

export async function verify(): Promise<{ ok: boolean; site?: any }> {
  const c = client();
  await verifyClient(c); // throws with a clear message if URL/key are wrong
  let site: any = undefined;
  try {
    site = await c.site.read();
  } catch {
    /* site read is best-effort; verifyClient already proved the connection */
  }
  return { ok: true, site };
}

export interface ListPostsArgs {
  status?: 'draft' | 'published' | 'scheduled' | 'all';
  tag?: string;
  limit?: number;
}

export async function listPosts(args: ListPostsArgs): Promise<any[]> {
  const filters: string[] = [];
  if (args.status && args.status !== 'all') filters.push(`status:${args.status}`);
  if (args.tag) filters.push(`tag:${args.tag}`);
  const res = await client().posts.browse({
    filter: filters.join('+') || undefined,
    limit: args.limit ?? 15,
    order: 'updated_at DESC',
    fields: 'id,title,slug,status,updated_at,published_at,url,visibility',
  });
  return res.map((p: any) => ({
    id: p.id,
    title: p.title,
    slug: p.slug,
    status: p.status,
    updated_at: p.updated_at,
    url: p.url,
  }));
}

export async function getPost(args: { id?: string; slug?: string }): Promise<any> {
  if (!args.id && !args.slug) throw new Error('Provide either id or slug.');
  const key = args.id ? { id: args.id } : { slug: args.slug };
  const p = await client().posts.read({ ...key, formats: 'html' }, { include: 'tags,authors' });
  return {
    id: p.id,
    title: p.title,
    slug: p.slug,
    status: p.status,
    url: p.url,
    updated_at: p.updated_at,
    published_at: p.published_at,
    custom_template: p.custom_template,
    feature_image: p.feature_image,
    excerpt: p.custom_excerpt,
    tags: (p.tags || []).map((t: any) => t.name),
    authors: (p.authors || []).map((a: any) => a.slug),
    html: p.html,
  };
}

export async function uploadImage(args: { path: string; max_width?: number; format?: string; quality?: number }): Promise<{ url: string }> {
  const c = client();
  const processed = await processImage(args.path, {
    enabled: true,
    maxWidth: args.max_width ?? 1920,
    format: args.format ?? 'auto',
    quality: args.quality ?? 82,
    exif: { Software: 'ghost-mcp' },
  });
  const toUpload = typeof processed === 'string' ? processed : processed.path;
  const res = await c.images.upload({ file: toUpload, purpose: 'image' });
  return { url: res.url };
}

export async function listTags(): Promise<any[]> {
  const res = await client().tags.browse({ limit: 'all', fields: 'id,name,slug,visibility,count' });
  return res.map((t: any) => ({ name: t.name, slug: t.slug, visibility: t.visibility, count: t.count?.posts }));
}

export interface WritePostArgs {
  title: string;
  markdown: string;
  slug?: string;
  tags?: string[];
  status?: 'draft' | 'published' | 'scheduled';
  excerpt?: string;
  feature_image?: string;
  feature_image_alt?: string;
  custom_template?: string;
  author?: string;
  published_at?: string;
  base_dir?: string;
  force?: boolean;
}

// Shared pipeline (mirrors the CLI): local images → bookmarks → render → upsert.
export async function writePost(args: WritePostArgs): Promise<
  | { created: false; blocked: true; existing: any }
  | { created: boolean; post: { id: string; url: string; status: string; slug: string } }
> {
  const c = client();
  const data: any = {
    title: args.title,
    slug: args.slug,
    status: args.status ?? 'draft',
    tags: args.tags ?? [],
    excerpt: args.excerpt,
    feature_image: args.feature_image,
    feature_image_alt: args.feature_image_alt,
    template: args.custom_template,
    author: args.author,
    published_at: args.published_at,
  };

  let body = args.markdown;

  // 1) local images referenced in the markdown → process (resize/EXIF) + upload + rewrite
  const baseDir = args.base_dir || process.cwd();
  const images = findLocalImages(body, data, baseDir);
  if (images.length) {
    const processingConfig = {
      enabled: true,
      maxWidth: 1920,
      format: 'auto',
      quality: 82,
      exif: {
        Copyright: process.env.IMAGE_COPYRIGHT || '',
        Artist: process.env.IMAGE_ARTIST || args.author || '',
        Software: 'ghost-mcp',
        ImageDescription: args.title || '',
      },
    };
    const urlMap = await uploadAll(c, images, { dryRun: false, processingConfig, perImageMeta: {} });
    body = rewriteContent(body, urlMap);
    if (data.feature_image && urlMap.has(data.feature_image)) data.feature_image = urlMap.get(data.feature_image);
  }

  // 2) ::bookmark <url> → native bookmark cards (fetches OpenGraph)
  body = await resolveBookmarks(body);

  // 3) markdown → HTML (native callouts/embeds/image cards)
  const html = render(body, {});

  // 4) create or update (upsert by slug); the guard lives in upsertPost
  const result = await upsertPost(c, data, html, { force: args.force ?? false });

  if ('blocked' in result && result.blocked) {
    return { created: false, blocked: true, existing: result.existing };
  }
  if ('post' in result) {
    const p = result.post;
    return { created: true, post: { id: p.id, url: p.url, status: p.status, slug: p.slug } };
  }
  throw new Error('Unexpected upsert result.');
}

// ── Level 2: Xpresiva-aware checks (read/suggest only) ───────────────────────

function checkFields(p: {
  custom_template?: string;
  feature_image?: string;
  feature_image_alt?: string;
  excerpt?: string;
  html?: string;
}): string[] {
  const findings: string[] = [];
  const tpl = p.custom_template || '';
  if (tpl && !XPRESIVA_TEMPLATES.includes(tpl)) {
    findings.push(`custom_template "${tpl}" is not an Xpresiva template (expected one of ${XPRESIVA_TEMPLATES.join(', ')}, or empty for the default).`);
  }
  if (XPRESIVA_TEMPLATES.includes(tpl) && !p.feature_image) {
    findings.push(`template "${tpl}" is built around a feature image, but the post has none.`);
  }
  if (p.feature_image && !p.feature_image_alt) {
    findings.push('feature image has no alt text (hurts SEO and accessibility).');
  }
  if (p.excerpt && p.excerpt.length > 300) {
    findings.push(`excerpt is ${p.excerpt.length} chars; Ghost rejects custom_excerpt over 300.`);
  }
  return findings;
}

export async function checkPost(args: { id?: string; slug?: string }): Promise<{ slug: string; title: string; reading_time_min: number; findings: string[] }> {
  const p = await getPost(args);
  return {
    slug: p.slug,
    title: p.title,
    reading_time_min: readingTime(p.html),
    findings: checkFields({ custom_template: p.custom_template, feature_image: p.feature_image, feature_image_alt: p.feature_image_alt, excerpt: p.excerpt, html: p.html }),
  };
}

export async function auditSite(args: { limit?: number; stale_days?: number }): Promise<{ scanned: number; flagged: any[]; truncated: boolean }> {
  const cap = Math.min(args.limit ?? 100, 100);
  const res = await client().posts.browse({
    limit: cap,
    order: 'updated_at DESC',
    fields: 'id,title,slug,status,updated_at,feature_image,feature_image_alt,custom_template,custom_excerpt',
  });
  const staleDays = args.stale_days ?? 90;
  const staleBefore = Date.now() - staleDays * 86400_000;
  const flagged: any[] = [];
  for (const p of res) {
    const issues = checkFields({
      custom_template: p.custom_template,
      feature_image: p.feature_image,
      feature_image_alt: p.feature_image_alt,
      excerpt: p.custom_excerpt,
    });
    if (!p.feature_image) issues.push('no feature image.');
    if (p.status === 'draft' && p.updated_at && Date.parse(p.updated_at) < staleBefore) {
      issues.push(`stale draft (not touched in ${staleDays}+ days).`);
    }
    if (issues.length) flagged.push({ slug: p.slug, title: p.title, status: p.status, issues });
  }
  return { scanned: res.length, flagged, truncated: res.length >= cap };
}

export async function setCustomTemplate(args: { id?: string; slug?: string; template: string }): Promise<{ slug: string; custom_template: string }> {
  const tpl = args.template === 'default' ? '' : args.template;
  if (tpl && !XPRESIVA_TEMPLATES.includes(tpl)) {
    throw new Error(`"${tpl}" is not an Xpresiva template. Use one of ${XPRESIVA_TEMPLATES.join(', ')}, or "default" to clear it.`);
  }
  if (!args.id && !args.slug) throw new Error('Provide either id or slug.');
  const key = args.id ? { id: args.id } : { slug: args.slug };
  const existing = await client().posts.read({ ...key, fields: 'id,slug,updated_at' });
  const updated = await client().posts.edit({ id: existing.id, updated_at: existing.updated_at, custom_template: tpl || null });
  return { slug: updated.slug, custom_template: updated.custom_template || '(default)' };
}

// ── Level 4: multilingual — publish a set of linked translations ─────────────

export interface TranslationVersion {
  locale: string;
  title: string;
  markdown: string;
  slug?: string;
  tags?: string[];
  status?: 'draft' | 'published' | 'scheduled';
  excerpt?: string;
  feature_image?: string;
  feature_image_alt?: string;
  base_dir?: string;
}

export async function publishTranslationSet(args: { pair: string; versions: TranslationVersion[]; force?: boolean }): Promise<{ pair: string; results: any[] }> {
  // The translation-group tag is a single "free" internal tag shared by every
  // version (Xpresiva pairs them by it, e.g. #tr-1). It must not be a language
  // or the #historical tag.
  const bare = args.pair.replace(/^#/, '');
  if (RESERVED_INTERNAL.has(`hash-${bare}`)) {
    throw new Error(`"${args.pair}" is a reserved tag (a language or #historical); pick a pairing tag like "tr-1".`);
  }
  const pairTag = `#${bare}`;

  const results: any[] = [];
  for (const v of args.versions) {
    if (!XPRESIVA_LOCALES.includes(v.locale)) {
      results.push({ locale: v.locale, error: `unknown locale (Xpresiva supports ${XPRESIVA_LOCALES.join(', ')}).` });
      continue;
    }
    // language internal tag + the shared pairing tag, plus any public tags
    const tags = [...(v.tags ?? []), `#${v.locale}`, pairTag];
    try {
      const r = await writePost({
        title: v.title,
        markdown: v.markdown,
        slug: v.slug,
        tags,
        status: v.status ?? 'draft',
        excerpt: v.excerpt,
        feature_image: v.feature_image,
        feature_image_alt: v.feature_image_alt,
        base_dir: v.base_dir,
        force: args.force ?? false,
      });
      if ('blocked' in r && r.blocked) {
        results.push({ locale: v.locale, blocked: true, existing_slug: r.existing.slug, note: 'slug exists; pass force to overwrite.' });
      } else {
        results.push({ locale: v.locale, ...(r as any).post });
      }
    } catch (err: any) {
      results.push({ locale: v.locale, error: err?.message || String(err) });
    }
  }
  return { pair: pairTag, results };
}
