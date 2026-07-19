# MCP (`mcp`)

**Type:** service · **Routes:** `/mcp` · **Default:** disabled · **Title:** MCP

An in-process [Model Context Protocol](https://modelcontextprotocol.io) server at
`/mcp` (streamable-HTTP transport) exposing 28 tools so Claude or any MCP client can
manage the blog directly — posts, tags, media, themes, settings, analytics. Off by
default: it's a powerful remote-control surface that admins must consciously enable
from `/light/plugins`. Authenticates via its own OAuth 2.1 provider or an API key,
both resolving to the same single admin principal as every other auth surface.
Disabling the plugin 404s `/mcp` entirely.

See [MCP Server](../features/mcp.md) for the full tool list and auth flow.
