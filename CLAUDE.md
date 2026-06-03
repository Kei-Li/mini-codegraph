# mini-codegraph — AI Agent Guide

## Overview
mini-codegraph is a lightweight code knowledge graph engine. It parses source code (Java, TypeScript/TSX, Python, Vue, Kotlin) via tree-sitter WASM, stores nodes/edges in SQLite with FTS5 search, and serves code intelligence through MCP tools.

## MCP Tools

| Tool | When to use |
|------|-------------|
| `mini_codegraph_context` | **Primary** — build comprehensive context for a task (callers, callees, implementations, cross-service calls) |
| `mini_codegraph_search` | Find symbols by name across the codebase |
| `mini_codegraph_trace` | "How does X reach Y?" — find call paths between two symbols |
| `mini_codegraph_callers` / `mini_codegraph_callees` | Walk call flow one direction at a time |
| `mini_codegraph_impact` | Check blast radius before editing |
| `mini_codegraph_node` | Get details + source of a single symbol |
| `mini_codegraph_explore` | Survey related symbols grouped by file |
| `mini_codegraph_files` | List indexed file structure |
| `mini_codegraph_status` | Check index health + detected frameworks |
| `mini_codegraph_architecture` | Show microservice architecture, modules, Feign dependencies |
| `mini_codegraph_feign` | List FeignClient interfaces and microservice targets |
| `mini_codegraph_mybatis` | Show MyBatis mapper XML bindings |
| `mini_codegraph_modules` | List indexed modules |
| `mini_codegraph_react` | List React components, hooks, stores, React Query hooks |
| `mini_codegraph_mongo` | List MongoDB @Document entities, repositories, MongoTemplate |
| `mini_codegraph_redis` | List Redis @RedisHash entities, template operations |
| `mini_codegraph_sql` | List SQL tables (DDL), MyBatis/JPA/JDBC SQL statements |

## Rules
- Answer structural questions with MCP tools — do NOT fall back to grep/read for things the graph already knows
- Treat returned source as already read; do not re-read files the graph returned
- Use Explore sub-agents for broad "how does X work?" questions
- Use lightweight tools (`search`, `callers`, `impact`, `node`) directly in main session for targeted lookups

## CLI Commands
- `mini-cg init /path` — Initialize database
- `mini-cg index /path` — Index all files
- `mini-cg sync /path` — Incremental update
- `mini-cg serve /path --daemon` — Start MCP server (daemon mode)
- `mini-cg search <query> /path` — Search symbols
- `mini-cg callers <symbol> /path` / `mini-cg callees <symbol> /path`
- `mini-cg context <task> /path` — Build context
- `mini-cg trace <from> <to> /path` — Find call path
- `mini-cg impact <symbol> /path` — Blast radius
- `mini-cg install` — Install for AI agents
- `mini-cg react` — Show React components, stores, and data queries
- `mini-cg mongo` — Show MongoDB entities and repositories
- `mini-cg redis` — Show Redis hashes and template usage
- `mini-cg sql` — Show SQL tables and statements
- See full list: `mini-cg --help`
