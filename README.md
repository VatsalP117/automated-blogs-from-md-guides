# Markdown Relay

Markdown Relay turns repository folders into a deployable publication site.

The current implementation is optimized for sequential Markdown guides, but the content model is already broader than that:

- A `collection` points at a source directory.
- Each directory inside that collection becomes an `item`.
- Each Markdown file inside the item becomes an `entry`.
- A single item can render as a merged article, a chapter-by-chapter series, or both.

This keeps v1 fast to ship while leaving room for notes, changelogs, case studies, and other repo-native content later.

## What is built

- Astro static site with direct deployment support
- Config-driven content discovery via `autoblog.config.ts`
- Markdown ingestion from repo folders using `gray-matter` and `marked`
- Directory-level item metadata through `README.md`, `index.md`, or `_index.md`
- Collection pages, merged item pages, and per-entry pages
- GitHub Pages deploy workflow
- Pull request validation workflow

## Content model

By default, this repo expects content like:

```text
content/
  guides/
    go-basics/
      index.md
      01-getting-started.md
      02-variables-and-types.md
      03-control-flow.md
```

Rules:

- Each folder under a collection source becomes one published item.
- `README.md`, `index.md`, or `_index.md` is optional item-level metadata and intro content.
- Numbered filenames control order by default.
- Frontmatter can override order with `order`.
- Frontmatter can override route slugs with `slug`.
- Frontmatter can set `viewMode` to `merged`, `series`, or `both`.

## Configuration

Edit `autoblog.config.ts` to add collections or change defaults.

Example:

```ts
import type { AutoBlogConfig } from "./src/lib/content/types";

const config: AutoBlogConfig = {
  site: {
    title: "Markdown Relay",
    tagline: "Repository-native publishing",
    description: "Generate a polished static publication from repo content.",
    language: "en-US",
    heroEyebrow: "Config-driven publishing",
    heroTitle: "Turn repo folders into a deployable learning library.",
    heroDescription: "Build merged articles, series pages, or both."
  },
  collections: [
    {
      id: "guides",
      title: "Guides",
      description: "Ordered learning tracks",
      source: "content/guides",
      route: "guides",
      defaultViewMode: "both",
      orderBy: "filename",
      typeLabel: "Guide"
    },
    {
      id: "notes",
      title: "Notes",
      description: "Shorter standalone writing",
      source: "content/notes",
      route: "notes",
      defaultViewMode: "merged",
      orderBy: "frontmatter",
      typeLabel: "Note"
    }
  ]
};

export default config;
```

## Local development

```bash
npm install
npm run dev
```

Useful commands:

- `npm run build` builds the static site into `dist/`
- `npm run check` runs Astro’s type and template diagnostics
- `npm run preview` previews the production build locally

## Deployment

This repo ships with two GitHub workflows:

- `.github/workflows/deploy-pages.yml` deploys directly to GitHub Pages on pushes to `main`
- `.github/workflows/pull-request-check.yml` validates PRs with `npm run check` and `npm run build`

That gives you both publishing modes you asked for:

- Direct publish: push to `main`
- Review-first publish: protect `main`, require PRs, and merge after review

### GitHub Pages setup

1. In GitHub, set the Pages source to `GitHub Actions`.
2. Push this repo to GitHub.
3. Let the deploy workflow publish the site.

The deploy workflow defaults to project-site URLs like `https://OWNER.github.io/REPO`.

If you use a custom domain or a `username.github.io` repository, set repository variables:

- `SITE_URL` to the full site origin, for example `https://notes.example.com`
- `BASE_PATH` to `/` for root deploys, or another subpath if required

Those are consumed by `astro.config.mjs`.

## Future extension path

This is not a hosted product yet, but the project is structured to make that transition easier:

- Content discovery is isolated in `src/lib/content/load-site.ts`
- Publication rules live in config, not page components
- The current filesystem loader can later be swapped for a GitHub API or GitHub App source adapter
- The existing collection model is generic enough to support more than tutorials

## Validation status

Current local verification:

- `npm run build`
- `npm run check`
