// Oksigenia Ghost MCP — a Model Context Protocol server to operate Ghost by talking
// to an AI, locally and with no telemetry. Level 1: conversational content ops.
// It reuses the ghost-md-publisher toolkit (same building blocks as the CLI).

import dotenv from 'dotenv';
dotenv.config({ quiet: true });

// CRITICAL for a stdio MCP server: stdout is the JSON-RPC channel. Anything written
// to stdout that isn't a protocol message corrupts the stream. The reused publisher
// lib occasionally console.log()s (e.g. status-preserved notices), so route every
// console.log to stderr. The transport writes to process.stdout directly, unaffected.
console.log = (...args: unknown[]) => console.error(...args);

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as ghost from './ghost.js';

const server = new McpServer({ name: 'oksigenia-ghost-mcp', version: '0.1.0' });

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const ok = (v: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }],
});
const fail = (msg: string): ToolResult => ({ content: [{ type: 'text', text: msg }], isError: true });

// Wrap a handler so any thrown error becomes a clean tool error instead of crashing.
function guard<A>(fn: (args: A) => Promise<ToolResult>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return await fn(args);
    } catch (err: any) {
      return fail(`Error: ${err?.message || String(err)}`);
    }
  };
}

const READ = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, openWorldHint: true } as const;

// ── Level 1: read ──────────────────────────────────────────────────────────

server.registerTool(
  'verify_connection',
  {
    title: 'Verify the connection to Ghost',
    description: 'Check that the Admin API URL and key work, and return basic site info.',
    inputSchema: {},
    annotations: { ...READ, title: 'Verify Ghost connection' },
  },
  guard(async () => {
    const r = await ghost.verify();
    const site = r.site ? { title: r.site.title, url: r.site.url, version: r.site.version } : undefined;
    return ok({ connected: true, site });
  })
);

server.registerTool(
  'list_posts',
  {
    title: 'List posts',
    description: 'List posts, most recently updated first. Filter by status and/or tag.',
    inputSchema: {
      status: z.enum(['draft', 'published', 'scheduled', 'all']).optional().describe('Filter by status (default: all).'),
      tag: z.string().optional().describe('Filter by tag slug.'),
      limit: z.number().int().min(1).max(50).optional().describe('Max posts to return (default 15).'),
    },
    annotations: { ...READ, title: 'List Ghost posts' },
  },
  guard(async (args) => ok(await ghost.listPosts(args)))
);

server.registerTool(
  'get_post',
  {
    title: 'Get a post',
    description: 'Fetch a single post by id or slug, including its HTML, tags and authors.',
    inputSchema: {
      id: z.string().optional().describe('Post id.'),
      slug: z.string().optional().describe('Post slug (use this or id).'),
    },
    annotations: { ...READ, title: 'Get a Ghost post' },
  },
  guard(async (args) => ok(await ghost.getPost(args)))
);

server.registerTool(
  'list_tags',
  {
    title: 'List tags',
    description: 'List all tags in the site (public and internal), with post counts.',
    inputSchema: {},
    annotations: { ...READ, title: 'List Ghost tags' },
  },
  guard(async () => ok(await ghost.listTags()))
);

// ── Level 1: write (guarded) ────────────────────────────────────────────────

const writeShape = {
  title: z.string().describe('Post title.'),
  markdown: z.string().describe('Post body in Markdown. Supports ::video, ::bookmark and Obsidian-style > [!type] callouts.'),
  slug: z.string().optional().describe('Slug. If omitted on create, Ghost derives it from the title.'),
  tags: z.array(z.string()).optional().describe('Tag names.'),
  status: z.enum(['draft', 'published', 'scheduled']).optional().describe('Default: draft.'),
  excerpt: z.string().optional().describe('Custom excerpt (max 300 chars).'),
  feature_image: z.string().optional().describe('Feature image: a URL, or a local path to upload.'),
  feature_image_alt: z.string().optional().describe('Feature image alt text (max 191 chars).'),
  custom_template: z.string().optional().describe('Ghost custom template, e.g. custom-wide-feature-image.'),
  author: z.string().optional().describe('Author slug or email.'),
  published_at: z.string().optional().describe('ISO date, only used when status is scheduled.'),
  base_dir: z.string().optional().describe('Directory to resolve local image paths against (default: cwd).'),
};

server.registerTool(
  'create_post',
  {
    title: 'Create a post (draft by default)',
    description:
      'Create a post from Markdown. Local images in the body/feature image are processed and uploaded. ' +
      'Creates a draft unless status says otherwise. If a post with the same slug already exists it will NOT ' +
      'overwrite it — use update_post for that.',
    inputSchema: writeShape,
    annotations: { ...WRITE, destructiveHint: false, idempotentHint: false, title: 'Create a Ghost post' },
  },
  guard(async (args: any) => {
    const r = await ghost.writePost({ ...args, force: false });
    if ('blocked' in r && r.blocked) {
      const e = r.existing;
      return ok(
        `A post with slug "${e.slug}" already exists (title: "${e.title}", status: ${e.status}). ` +
          `Not overwriting. Call update_post with the same slug to change it on purpose.`
      );
    }
    return ok({ created: true, ...(r as any).post });
  })
);

server.registerTool(
  'update_post',
  {
    title: 'Update an existing post',
    description:
      'Update the post that has this slug, overwriting its content. The existing status is preserved ' +
      '(a published post stays published). Use create_post for brand-new posts.',
    inputSchema: { ...writeShape, slug: z.string().describe('Slug of the existing post to update.') },
    annotations: { ...WRITE, destructiveHint: true, idempotentHint: true, title: 'Update a Ghost post' },
  },
  guard(async (args: any) => {
    const r = await ghost.writePost({ ...args, force: true });
    return ok({ updated: true, ...(r as any).post });
  })
);

server.registerTool(
  'upload_image',
  {
    title: 'Upload an image to Ghost',
    description: 'Process a local image (resize, format, EXIF clean) and upload it to Ghost. Returns the hosted URL.',
    inputSchema: {
      path: z.string().describe('Local path to the image file.'),
      max_width: z.number().int().optional().describe('Max width in px (default 1920).'),
      format: z.enum(['auto', 'webp', 'jpeg', 'png', 'preserve']).optional().describe('Output format (default auto).'),
      quality: z.number().int().min(1).max(100).optional().describe('Quality 1-100 (default 82).'),
    },
    annotations: { ...WRITE, destructiveHint: false, idempotentHint: false, title: 'Upload an image' },
  },
  guard(async (args) => ok(await ghost.uploadImage(args)))
);

// ── boot ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('oksigenia-ghost-mcp ready (stdio).');
}

main().catch((err) => {
  console.error('Fatal:', err?.message || err);
  process.exit(1);
});
