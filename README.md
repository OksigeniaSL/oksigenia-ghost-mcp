# @oksigenia/ghost-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for **Ghost**, aware of the **Xpresiva** theme. Operate your Ghost content by talking to an AI — locally, with no telemetry, straight against your own Ghost.

It reuses the [`ghost-md-publisher`](https://github.com/OksigeniaSL/ghost-md-publisher) toolkit, so the MCP and the CLI share the same building blocks: the Admin API client, Markdown → native Ghost cards (callouts, bookmarks, video embeds, image captions), image processing (resize + EXIF clean) and the safe upsert.

> Status: **Level 1** (conversational content ops). Levels 2 (Xpresiva-aware validation) and 4 (multilingual publishing) are on the roadmap.

## Requirements

- Node.js 20.9+
- A Ghost site with an Admin API key (Settings → Integrations → Add custom integration).

## Install & build

```bash
npm install
npm run build
```

## Configure your MCP client

Point your MCP client at the built server and pass your Ghost credentials as env. Example (Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ghost": {
      "command": "node",
      "args": ["/absolute/path/to/oksigenia-ghost-mcp/dist/index.js"],
      "env": {
        "GHOST_URL": "https://your-site.com",
        "GHOST_ADMIN_API_KEY": "id:secret",
        "GHOST_API_VERSION": "v5.0"
      }
    }
  }
}
```

## Tools (Level 1)

| Tool | Kind | What it does |
|---|---|---|
| `verify_connection` | read | Check the connection and return basic site info. |
| `list_posts` | read | List posts (filter by status/tag). |
| `get_post` | read | Fetch a post by id or slug, with its HTML, tags and authors. |
| `list_tags` | read | List all tags with post counts. |
| `create_post` | write | Create a post from Markdown (draft by default). Processes local images. Stops if the slug already exists. |
| `update_post` | write | Update the post with a given slug (preserves its status). |
| `upload_image` | write | Process and upload a local image, returns the hosted URL. |

The Markdown accepts the same extras as the CLI: `::video <url>`, `::bookmark <url>` (fetches OpenGraph metadata), and Obsidian-style callouts `> [!warning] ...` → native Ghost cards.

### Guardrails

- New posts are created as **drafts** by default.
- `create_post` **never overwrites** an existing slug — it stops and points you to `update_post`.
- No hard-delete tool.
- Everything runs locally against your own Ghost. No telemetry.

## Roadmap

- Level 2 — Xpresiva-aware: validate `custom_template`, feature-image style and section tags; site audits.
- Level 4 — multilingual: publish a set of translations linked by Xpresiva's internal `#tr-N` pairing.

## License

MIT © Oksigenia
