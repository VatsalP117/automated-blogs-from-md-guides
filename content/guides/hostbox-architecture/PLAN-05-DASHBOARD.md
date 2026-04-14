# Phase 5 — Web Dashboard Implementation Plan

> **Hostbox** · Vite + React + TypeScript + Tailwind CSS + shadcn/ui  
> **Directory:** `web/`  
> **Embeds into:** Go binary via `//go:embed web/dist/*`

---

## Table of Contents

1. [Overview](#1-overview)
2. [Tech Stack & Versions](#2-tech-stack--versions)
3. [Directory Structure](#3-directory-structure)
4. [Project Scaffolding](#4-project-scaffolding)
5. [Tailwind & Design Tokens](#5-tailwind--design-tokens)
6. [shadcn/ui Components](#6-shadcnui-components)
7. [TypeScript Type Definitions](#7-typescript-type-definitions)
8. [API Client Architecture](#8-api-client-architecture)
9. [Auth State (Zustand)](#9-auth-state-zustand)
10. [React Router Configuration](#10-react-router-configuration)
11. [TanStack Query Setup](#11-tanstack-query-setup)
12. [SSE Integration](#12-sse-integration)
13. [Shared Components](#13-shared-components)
14. [Page Implementations](#14-page-implementations)
15. [Build & Embed Pipeline](#15-build--embed-pipeline)
16. [Implementation Order](#16-implementation-order)
17. [Testing Strategy](#17-testing-strategy)
18. [Performance Considerations](#18-performance-considerations)

---

## 1. Overview

Phase 5 builds the entire web dashboard as a Vite + React + TypeScript single-page application. The SPA is compiled to static assets in `web/dist/` and embedded into the Go binary via `embed.FS`. In production there is no Node.js runtime — only the Go binary serves the pre-built HTML/JS/CSS.

**Key constraints:**
- Bundle size target: < 300KB gzipped (excluding source maps)
- Must work on 512MB RAM VPS (the Go binary serves the SPA; Caddy proxies)
- All API calls go to `/api/v1/*` — same origin, no CORS issues for the dashboard itself
- Access tokens stored in memory only (never `localStorage`) for security
- Refresh tokens are httpOnly cookies — browser handles them automatically
- SSE for real-time build log streaming; polling (5s) for deployment status

---

## 2. Tech Stack & Versions

| Package | Version | Purpose |
|---------|---------|---------|
| `vite` | `^5.4` | Build tool, dev server, HMR |
| `react` | `^18.3` | UI library |
| `react-dom` | `^18.3` | React DOM renderer |
| `typescript` | `^5.5` | Type system (strict mode) |
| `tailwindcss` | `^3.4` | Utility-first CSS |
| `postcss` | `^8.4` | CSS processing |
| `autoprefixer` | `^10.4` | Vendor prefixes |
| `@radix-ui/*` | latest | Accessible primitives (via shadcn/ui) |
| `react-router-dom` | `^6.26` | Client-side routing |
| `@tanstack/react-query` | `^5.56` | Server state management |
| `zustand` | `^4.5` | Client state (auth token) |
| `date-fns` | `^3.6` | Date formatting |
| `clsx` | `^2.1` | Conditional class names |
| `tailwind-merge` | `^2.5` | Merge Tailwind classes |
| `class-variance-authority` | `^0.7` | Component variant API (shadcn dep) |
| `lucide-react` | `^0.441` | Icons (shadcn default icon set) |
| `sonner` | `^1.5` | Toast notifications |
| `cmdk` | `^1.0` | Command palette (Cmd+K) |
| `ansi-to-react` | `^6.1` | ANSI color code rendering in log viewer |

**Dev dependencies:**

| Package | Version | Purpose |
|---------|---------|---------|
| `@types/react` | `^18.3` | React type definitions |
| `@types/react-dom` | `^18.3` | ReactDOM type definitions |
| `@vitejs/plugin-react-swc` | `^3.7` | React Fast Refresh with SWC |
| `eslint` | `^9.10` | Linting |
| `@eslint/js` | `^9.10` | ESLint config |
| `typescript-eslint` | `^8.5` | TypeScript ESLint rules |
| `eslint-plugin-react-hooks` | `^5.1` | React Hooks lint rules |
| `eslint-plugin-react-refresh` | `^0.4` | React Refresh lint rules |
| `prettier` | `^3.3` | Code formatting |
| `prettier-plugin-tailwindcss` | `^0.6` | Tailwind class sorting |

---

## 3. Directory Structure

```
web/
├── index.html                          # Vite entry HTML
├── package.json
├── package-lock.json
├── tsconfig.json                       # TypeScript config (strict)
├── tsconfig.node.json                  # Node-targeted TS config for vite.config
├── vite.config.ts                      # Vite configuration
├── tailwind.config.ts                  # Tailwind configuration
├── postcss.config.js                   # PostCSS config
├── eslint.config.js                    # ESLint flat config
├── .prettierrc                         # Prettier config
├── components.json                     # shadcn/ui configuration
├── public/
│   └── favicon.svg                     # Hostbox favicon
│
├── src/
│   ├── main.tsx                        # React entry point, mounts <App />
│   ├── app.tsx                         # <App /> — providers + router
│   ├── globals.css                     # Tailwind directives + CSS variables
│   ├── vite-env.d.ts                   # Vite client types
│   │
│   ├── types/
│   │   ├── api.ts                      # All API response/request types
│   │   ├── models.ts                   # Domain model interfaces (User, Project, etc.)
│   │   └── events.ts                   # SSE event payload types
│   │
│   ├── lib/
│   │   ├── utils.ts                    # cn() helper, formatBytes, etc.
│   │   ├── api-client.ts              # Singleton fetch wrapper with auth
│   │   ├── constants.ts               # Route paths, status enums, framework list
│   │   └── date.ts                     # date-fns wrappers (timeAgo, formatDate)
│   │
│   ├── stores/
│   │   └── auth-store.ts              # Zustand store for access token + user
│   │
│   ├── hooks/
│   │   ├── use-auth.ts                 # useAuth() — login, logout, refresh, user
│   │   ├── use-setup-status.ts         # useSetupStatus() — check if setup complete
│   │   ├── use-projects.ts             # useProjects(), useProject(id), useCreateProject()
│   │   ├── use-deployments.ts          # useDeployments(projectId), useDeployment(id)
│   │   ├── use-deployment-logs.ts      # useDeploymentLogs(id) — SSE hook
│   │   ├── use-domains.ts              # useDomains(projectId), useAddDomain(), etc.
│   │   ├── use-env-vars.ts             # useEnvVars(projectId), useBulkImport()
│   │   ├── use-github.ts              # useInstallations(), useRepos(installationId)
│   │   ├── use-notifications.ts        # useNotifications(projectId), CRUD hooks
│   │   ├── use-admin.ts               # useAdminStats(), useAdminUsers(), etc.
│   │   ├── use-user.ts                # useProfile(), useChangePassword(), useSessions()
│   │   └── use-media-query.ts          # useMediaQuery() — responsive breakpoints
│   │
│   ├── components/
│   │   ├── ui/                         # shadcn/ui generated components (DO NOT EDIT)
│   │   │   ├── accordion.tsx
│   │   │   ├── alert.tsx
│   │   │   ├── alert-dialog.tsx
│   │   │   ├── avatar.tsx
│   │   │   ├── badge.tsx
│   │   │   ├── breadcrumb.tsx
│   │   │   ├── button.tsx
│   │   │   ├── card.tsx
│   │   │   ├── checkbox.tsx
│   │   │   ├── collapsible.tsx
│   │   │   ├── command.tsx
│   │   │   ├── dialog.tsx
│   │   │   ├── dropdown-menu.tsx
│   │   │   ├── form.tsx
│   │   │   ├── input.tsx
│   │   │   ├── label.tsx
│   │   │   ├── pagination.tsx
│   │   │   ├── popover.tsx
│   │   │   ├── progress.tsx
│   │   │   ├── scroll-area.tsx
│   │   │   ├── select.tsx
│   │   │   ├── separator.tsx
│   │   │   ├── sheet.tsx
│   │   │   ├── skeleton.tsx
│   │   │   ├── sonner.tsx
│   │   │   ├── switch.tsx
│   │   │   ├── table.tsx
│   │   │   ├── tabs.tsx
│   │   │   ├── textarea.tsx
│   │   │   ├── tooltip.tsx
│   │   │   └── toggle.tsx
│   │   │
│   │   ├── layout/
│   │   │   ├── root-layout.tsx         # Full page layout (sidebar + topbar + main)
│   │   │   ├── auth-layout.tsx         # Centered card layout for login/setup pages
│   │   │   ├── sidebar.tsx             # Collapsible sidebar navigation
│   │   │   ├── topbar.tsx              # Top bar with breadcrumbs + user menu
│   │   │   ├── mobile-nav.tsx          # Mobile hamburger menu (Sheet-based)
│   │   │   └── command-palette.tsx     # Cmd+K command palette (cmdk)
│   │   │
│   │   ├── shared/
│   │   │   ├── auth-guard.tsx          # Redirect to /login if not authenticated
│   │   │   ├── setup-guard.tsx         # Redirect to /setup if setup incomplete
│   │   │   ├── admin-guard.tsx         # Redirect to / if not admin
│   │   │   ├── page-header.tsx         # Page title + description + actions slot
│   │   │   ├── empty-state.tsx         # Empty state illustration + message + action
│   │   │   ├── loading-page.tsx        # Full-page skeleton loader
│   │   │   ├── error-boundary.tsx      # React error boundary with fallback UI
│   │   │   ├── confirmation-dialog.tsx # Reusable "Are you sure?" dialog
│   │   │   ├── status-badge.tsx        # Deployment status badge (queued/building/ready/failed/cancelled)
│   │   │   ├── framework-badge.tsx     # Framework icon + name badge
│   │   │   ├── commit-info.tsx         # Truncated SHA + message + author avatar
│   │   │   ├── time-ago.tsx            # Relative timestamp ("3 minutes ago")
│   │   │   ├── copy-button.tsx         # Click-to-copy with tooltip feedback
│   │   │   ├── search-input.tsx        # Debounced search input with icon
│   │   │   ├── data-table.tsx          # Generic data table with sort/pagination
│   │   │   ├── pagination-controls.tsx # Page navigation (previous/next/page numbers)
│   │   │   └── external-link.tsx       # Link with external icon
│   │   │
│   │   ├── projects/
│   │   │   ├── project-card.tsx        # Project card for grid view
│   │   │   ├── project-header.tsx      # Project detail page header (name, repo, URL, actions)
│   │   │   ├── project-tabs.tsx        # Tab navigation (Deployments | Settings | Domains | Env | Notifications)
│   │   │   ├── create-project-wizard.tsx       # Multi-step project creation form
│   │   │   ├── github-repo-picker.tsx          # Installation selector + repo list
│   │   │   ├── build-settings-form.tsx         # Framework, build cmd, install cmd, output dir, etc.
│   │   │   └── framework-select.tsx            # Framework selection dropdown with icons
│   │   │
│   │   ├── deployments/
│   │   │   ├── deployment-list.tsx              # List of deployments with status, commit, branch
│   │   │   ├── deployment-row.tsx               # Single deployment row in the list
│   │   │   ├── deployment-header.tsx            # Deployment detail header (status, commit, actions)
│   │   │   ├── deployment-actions.tsx           # Promote / Rollback / Cancel buttons
│   │   │   ├── build-progress.tsx               # Step indicator: Clone → Install → Build → Deploy
│   │   │   └── log-viewer.tsx                   # Terminal-style build log viewer
│   │   │
│   │   ├── domains/
│   │   │   ├── domain-list.tsx                  # List of domains with status
│   │   │   ├── domain-card.tsx                  # Single domain with DNS instructions
│   │   │   ├── add-domain-form.tsx              # Form to add new custom domain
│   │   │   └── dns-instructions.tsx             # DNS record instructions display
│   │   │
│   │   ├── env-vars/
│   │   │   ├── env-var-table.tsx                # Table of environment variables
│   │   │   ├── env-var-row.tsx                  # Single env var row (key, masked value, scope, actions)
│   │   │   ├── add-env-var-form.tsx             # Form to add single env var
│   │   │   ├── env-var-import-dialog.tsx        # .env file import modal (paste or upload)
│   │   │   └── env-var-scope-badge.tsx          # Scope badge (all/production/preview)
│   │   │
│   │   ├── notifications/
│   │   │   ├── notification-list.tsx            # List of webhook configs
│   │   │   ├── notification-card.tsx            # Single notification config card
│   │   │   ├── add-notification-form.tsx        # Form to add webhook
│   │   │   └── event-toggle-list.tsx            # Checkboxes for event types
│   │   │
│   │   └── admin/
│   │       ├── system-stats.tsx                 # RAM, disk, build queue, uptime cards
│   │       ├── disk-usage-bar.tsx               # Visual disk usage progress bar
│   │       ├── user-table.tsx                   # Admin user list table
│   │       ├── activity-log.tsx                 # Recent activity feed
│   │       ├── activity-row.tsx                 # Single activity log entry
│   │       └── admin-settings-form.tsx          # Platform settings form
│   │
│   └── pages/
│       ├── setup-page.tsx                       # /setup — first-run wizard
│       ├── login-page.tsx                       # /login
│       ├── forgot-password-page.tsx             # /forgot-password
│       ├── reset-password-page.tsx              # /reset-password?token=xxx
│       ├── dashboard-page.tsx                   # / — overview
│       ├── projects-page.tsx                    # /projects — card grid
│       ├── create-project-page.tsx              # /projects/new — wizard
│       ├── project-detail-page.tsx              # /projects/:id — tabs container
│       ├── deployments-tab.tsx                  # /projects/:id (Deployments tab content)
│       ├── deployment-detail-page.tsx           # /projects/:id/deployments/:deploymentId
│       ├── project-settings-tab.tsx             # /projects/:id/settings tab content
│       ├── domains-tab.tsx                      # /projects/:id/domains tab content
│       ├── env-vars-tab.tsx                     # /projects/:id/env tab content
│       ├── notifications-tab.tsx                # /projects/:id/notifications tab content
│       ├── admin-page.tsx                       # /admin — system admin
│       ├── profile-page.tsx                     # /profile — user settings
│       └── not-found-page.tsx                   # 404 catch-all
│
└── dist/                                        # Vite build output (git-ignored)
    ├── index.html
    ├── assets/
    │   ├── index-[hash].js
    │   └── index-[hash].css
    └── favicon.svg
```

**Total file count:** ~95 source files

---

## 4. Project Scaffolding

### 4.1 `web/package.json`

```json
{
  "name": "hostbox-dashboard",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite --port 3000",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "lint": "eslint .",
    "format": "prettier --write \"src/**/*.{ts,tsx}\""
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26.2",
    "@tanstack/react-query": "^5.56.2",
    "zustand": "^4.5.5",
    "date-fns": "^3.6.0",
    "clsx": "^2.1.1",
    "tailwind-merge": "^2.5.2",
    "class-variance-authority": "^0.7.0",
    "lucide-react": "^0.441.0",
    "sonner": "^1.5.0",
    "cmdk": "^1.0.0",
    "ansi-to-react": "^6.1.6"
  },
  "devDependencies": {
    "@types/react": "^18.3.8",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react-swc": "^3.7.0",
    "typescript": "^5.5.4",
    "vite": "^5.4.6",
    "tailwindcss": "^3.4.12",
    "postcss": "^8.4.47",
    "autoprefixer": "^10.4.20",
    "eslint": "^9.10.0",
    "@eslint/js": "^9.10.0",
    "typescript-eslint": "^8.5.0",
    "eslint-plugin-react-hooks": "^5.1.0-rc.0",
    "eslint-plugin-react-refresh": "^0.4.12",
    "prettier": "^3.3.3",
    "prettier-plugin-tailwindcss": "^0.6.6"
  }
}
```

### 4.2 `web/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,

    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",

    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,

    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src"]
}
```

### 4.3 `web/tsconfig.node.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "ESNext",
    "skipLibCheck": true,

    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,

    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["vite.config.ts"]
}
```

### 4.4 `web/vite.config.ts`

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 3000,
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom", "react-router-dom"],
          query: ["@tanstack/react-query"],
        },
      },
    },
  },
});
```

### 4.5 `web/tailwind.config.ts`

```ts
import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "ui-monospace",
          "SFMono-Regular",
          "monospace",
        ],
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        pulse: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.5" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "pulse-slow": "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
```

### 4.6 `web/postcss.config.js`

```js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

### 4.7 `web/components.json` (shadcn/ui config)

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "default",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "tailwind.config.ts",
    "css": "src/globals.css",
    "baseColor": "zinc",
    "cssVariables": true,
    "prefix": ""
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  }
}
```

### 4.8 `web/index.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="Hostbox — Self-hosted deployment platform" />
    <title>Hostbox</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

### 4.9 `web/.prettierrc`

```json
{
  "semi": true,
  "singleQuote": false,
  "tabWidth": 2,
  "trailingComma": "all",
  "plugins": ["prettier-plugin-tailwindcss"]
}
```

---

## 5. Tailwind & Design Tokens

### 5.1 Color Scheme (CSS Variables)

File: `web/src/globals.css`

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 240 10% 3.9%;

    --card: 0 0% 100%;
    --card-foreground: 240 10% 3.9%;

    --popover: 0 0% 100%;
    --popover-foreground: 240 10% 3.9%;

    --primary: 240 5.9% 10%;
    --primary-foreground: 0 0% 98%;

    --secondary: 240 4.8% 95.9%;
    --secondary-foreground: 240 5.9% 10%;

    --muted: 240 4.8% 95.9%;
    --muted-foreground: 240 3.8% 46.1%;

    --accent: 240 4.8% 95.9%;
    --accent-foreground: 240 5.9% 10%;

    --destructive: 0 84.2% 60.2%;
    --destructive-foreground: 0 0% 98%;

    --success: 142 76% 36%;
    --success-foreground: 0 0% 98%;

    --warning: 38 92% 50%;
    --warning-foreground: 0 0% 98%;

    --border: 240 5.9% 90%;
    --input: 240 5.9% 90%;
    --ring: 240 5.9% 10%;

    --radius: 0.5rem;
  }

  .dark {
    --background: 240 10% 3.9%;
    --foreground: 0 0% 98%;

    --card: 240 10% 3.9%;
    --card-foreground: 0 0% 98%;

    --popover: 240 10% 3.9%;
    --popover-foreground: 0 0% 98%;

    --primary: 0 0% 98%;
    --primary-foreground: 240 5.9% 10%;

    --secondary: 240 3.7% 15.9%;
    --secondary-foreground: 0 0% 98%;

    --muted: 240 3.7% 15.9%;
    --muted-foreground: 240 5% 64.9%;

    --accent: 240 3.7% 15.9%;
    --accent-foreground: 0 0% 98%;

    --destructive: 0 62.8% 30.6%;
    --destructive-foreground: 0 0% 98%;

    --success: 142 76% 36%;
    --success-foreground: 0 0% 98%;

    --warning: 38 92% 50%;
    --warning-foreground: 0 0% 98%;

    --border: 240 3.7% 15.9%;
    --input: 240 3.7% 15.9%;
    --ring: 240 4.9% 83.9%;
  }
}

@layer base {
  * {
    @apply border-border;
  }
  body {
    @apply bg-background text-foreground;
    font-feature-settings: "rlig" 1, "calt" 1;
  }
}

/* Log viewer terminal styling */
.log-viewer {
  @apply font-mono text-sm leading-relaxed;
  background: hsl(240 10% 5%);
  color: hsl(0 0% 85%);
}

.log-viewer .log-line-number {
  @apply select-none text-muted-foreground/50;
  min-width: 4ch;
}

/* ANSI color overrides for log viewer */
.log-viewer .ansi-red { color: hsl(0 84% 60%); }
.log-viewer .ansi-green { color: hsl(142 76% 56%); }
.log-viewer .ansi-yellow { color: hsl(38 92% 60%); }
.log-viewer .ansi-blue { color: hsl(217 91% 65%); }
.log-viewer .ansi-magenta { color: hsl(292 84% 65%); }
.log-viewer .ansi-cyan { color: hsl(187 85% 53%); }
.log-viewer .ansi-bold { font-weight: 700; }
```

### 5.2 Status Badge Color Map

| Status | Light Mode | Dark Mode | Tailwind Classes |
|--------|-----------|-----------|-----------------|
| `queued` | Gray | Gray | `bg-muted text-muted-foreground` |
| `building` | Blue + pulse | Blue + pulse | `bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 animate-pulse-slow` |
| `ready` | Green | Green | `bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400` |
| `failed` | Red | Red | `bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400` |
| `cancelled` | Dark gray | Dark gray | `bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400` |

### 5.3 Framework Badge Icons

| Framework | Icon Source | Display Name |
|-----------|-----------|-------------|
| `nextjs` | Custom SVG or Lucide `Hexagon` | Next.js |
| `vite` | Custom SVG or Lucide `Zap` | Vite |
| `cra` | Lucide `Atom` | Create React App |
| `astro` | Custom SVG or Lucide `Rocket` | Astro |
| `gatsby` | Lucide `Circle` | Gatsby |
| `nuxt` | Lucide `Triangle` | Nuxt |
| `sveltekit` | Lucide `Flame` | SvelteKit |
| `hugo` | Lucide `FileText` | Hugo |
| `plain-html` | Lucide `Globe` | Static HTML |
| `unknown` | Lucide `HelpCircle` | Unknown |

---

## 6. shadcn/ui Components

Install these components via `npx shadcn@latest add <component>`:

### 6.1 Required Components (install all)

| Component | Used In |
|-----------|---------|
| `accordion` | FAQ sections, collapsible settings groups |
| `alert` | Error messages, info banners |
| `alert-dialog` | Confirmation dialogs (delete project, etc.) |
| `avatar` | User avatars, commit author avatars |
| `badge` | Status badges, framework badges, scope badges |
| `breadcrumb` | Page breadcrumb navigation in topbar |
| `button` | Everywhere — primary/secondary/destructive/ghost/outline variants |
| `card` | Project cards, stats cards, domain cards, notification cards |
| `checkbox` | Event toggles in notifications, settings toggles |
| `collapsible` | Sidebar sections, advanced settings |
| `command` | Command palette (Cmd+K) |
| `dialog` | Modals: add domain, import env vars, confirmation |
| `dropdown-menu` | User menu, project actions, deployment actions |
| `form` | All forms (react-hook-form integration via shadcn) |
| `input` | Text inputs across all forms |
| `label` | Form field labels |
| `pagination` | Deployment lists, project lists, admin activity log |
| `popover` | Tooltips, copy feedback |
| `progress` | Disk usage bar, build progress |
| `scroll-area` | Log viewer scroll container, long lists |
| `select` | Framework select, scope select, node version select |
| `separator` | Visual dividers between sections |
| `sheet` | Mobile navigation drawer |
| `skeleton` | Loading states for every component |
| `sonner` | Toast notifications (success, error, info) |
| `switch` | Toggle switches (auto-deploy, preview deployments) |
| `table` | Env var table, user table, activity log |
| `tabs` | Project detail tabs (Deployments / Settings / Domains / Env / Notifications) |
| `textarea` | .env file paste input |
| `tooltip` | Hover hints, copy feedback, truncated text |
| `toggle` | Theme toggle (light/dark) |

### 6.2 Additional Radix Dependencies (auto-installed with shadcn)

These come in via shadcn's component definitions:
- `@radix-ui/react-accordion`
- `@radix-ui/react-alert-dialog`
- `@radix-ui/react-avatar`
- `@radix-ui/react-checkbox`
- `@radix-ui/react-collapsible`
- `@radix-ui/react-dialog`
- `@radix-ui/react-dropdown-menu`
- `@radix-ui/react-label`
- `@radix-ui/react-popover`
- `@radix-ui/react-progress`
- `@radix-ui/react-scroll-area`
- `@radix-ui/react-select`
- `@radix-ui/react-separator`
- `@radix-ui/react-slot`
- `@radix-ui/react-switch`
- `@radix-ui/react-tabs`
- `@radix-ui/react-toggle`
- `@radix-ui/react-tooltip`
- `react-hook-form` (via `form` component)
- `@hookform/resolvers`
- `zod` (validation via `form` component)

---

## 7. TypeScript Type Definitions

### 7.1 `src/types/models.ts` — Domain Models

```ts
// ─── Enums ───────────────────────────────────────────

export type DeploymentStatus =
  | "queued"
  | "building"
  | "ready"
  | "failed"
  | "cancelled";

export type EnvVarScope = "all" | "production" | "preview";

export type NotificationChannel = "discord" | "slack" | "webhook";

export type NotificationEvent =
  | "deploy_started"
  | "deploy_success"
  | "deploy_failed"
  | "domain_verified";

export type Framework =
  | "nextjs"
  | "vite"
  | "cra"
  | "astro"
  | "gatsby"
  | "nuxt"
  | "sveltekit"
  | "hugo"
  | "plain-html"
  | "unknown";

export type ActivityAction =
  | "project.created"
  | "project.updated"
  | "project.deleted"
  | "deployment.created"
  | "deployment.cancelled"
  | "deployment.rolled_back"
  | "domain.added"
  | "domain.verified"
  | "domain.deleted"
  | "env_var.created"
  | "env_var.updated"
  | "env_var.deleted"
  | "user.login"
  | "user.logout"
  | "user.created"
  | "settings.updated";

export type ResourceType =
  | "project"
  | "deployment"
  | "domain"
  | "env_var"
  | "user"
  | "settings";

// ─── Models ──────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  display_name: string;
  is_admin: boolean;
  email_verified: boolean;
  created_at: string; // ISO 8601
  updated_at: string;
}

export interface Project {
  id: string;
  owner_id: string;
  name: string;
  slug: string;
  github_repo: string | null; // "owner/repo"
  github_installation_id: number | null;
  production_branch: string;
  framework: Framework | null;
  build_command: string | null;
  install_command: string | null;
  output_directory: string | null;
  root_directory: string;
  node_version: string;
  auto_deploy: boolean;
  preview_deployments: boolean;
  created_at: string;
  updated_at: string;
}

export interface Deployment {
  id: string;
  project_id: string;
  commit_sha: string;
  commit_message: string | null;
  commit_author: string | null;
  branch: string;
  status: DeploymentStatus;
  is_production: boolean;
  deployment_url: string | null;
  artifact_path: string;
  artifact_size_bytes: number | null;
  log_path: string;
  error_message: string | null;
  is_rollback: boolean;
  rollback_source_id: string | null;
  github_pr_number: number | null;
  build_duration_ms: number | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface Domain {
  id: string;
  project_id: string;
  domain: string;
  verified: boolean;
  verified_at: string | null;
  last_checked_at: string | null;
  created_at: string;
}

export interface EnvVar {
  id: string;
  project_id: string;
  key: string;
  value: string; // "••••••••" for secrets
  is_secret: boolean;
  scope: EnvVarScope;
  created_at: string;
  updated_at: string;
}

export interface NotificationConfig {
  id: string;
  project_id: string | null;
  channel: NotificationChannel;
  webhook_url: string; // masked in responses
  events: string; // comma-separated
  enabled: boolean;
  created_at: string;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string; // "owner/repo"
  url: string;
  description: string;
  private: boolean;
  default_branch: string;
}

export interface GitHubInstallation {
  id: number;
  account: {
    login: string;
    type: "User" | "Organization";
    avatar_url: string;
  };
  created_at: string;
}

export interface Session {
  id: string;
  user_agent: string;
  ip_address: string;
  is_current: boolean;
  last_active_at: string;
  expires_at: string;
  created_at: string;
}

export interface Activity {
  id: string;
  user_id: string;
  user_email: string;
  action: ActivityAction;
  resource_type: ResourceType;
  resource_id: string;
  resource_name: string | null;
  metadata: Record<string, unknown> | null;
  ip_address: string;
  created_at: string;
}

export interface SystemStats {
  disk_usage: {
    total_bytes: number;
    used_bytes: number;
    available_bytes: number;
    deployment_bytes: number;
  };
  project_count: number;
  deployment_count: number;
  active_builds: number;
  uptime_seconds: number;
}

export interface PlatformSettings {
  registration_enabled: boolean;
  max_projects: number;
  max_concurrent_builds: number;
  artifact_retention_days: number;
}

export interface DnsInstructions {
  a_record: string;
  cname_record: string;
}
```

### 7.2 `src/types/api.ts` — API Request/Response Types

```ts
import type {
  User,
  Project,
  Deployment,
  Domain,
  EnvVar,
  NotificationConfig,
  GitHubRepo,
  GitHubInstallation,
  SystemStats,
  PlatformSettings,
  Activity,
  Session,
  DnsInstructions,
  DeploymentStatus,
  EnvVarScope,
  NotificationChannel,
} from "./models";

// ─── Pagination ──────────────────────────────────────

export interface Pagination {
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: Pagination;
}

// ─── Error ───────────────────────────────────────────

export interface ApiErrorDetail {
  field: string;
  message: string;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: ApiErrorDetail[];
  };
}

// ─── Setup ───────────────────────────────────────────

export interface SetupStatusResponse {
  setup_complete: boolean;
}

export interface SetupRequest {
  email: string;
  password: string;
  display_name: string;
  platform_domain: string;
}

export interface SetupResponse {
  user: User;
  access_token: string;
}

// ─── Auth ────────────────────────────────────────────

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  user: User;
  access_token: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  display_name?: string;
}

export interface RegisterResponse {
  user: User;
  access_token: string;
}

export interface RefreshResponse {
  access_token: string;
}

export interface ForgotPasswordRequest {
  email: string;
}

export interface ResetPasswordRequest {
  token: string;
  new_password: string;
}

export interface ChangePasswordRequest {
  current_password: string;
  new_password: string;
}

export interface UpdateProfileRequest {
  display_name?: string;
  email?: string;
  current_password?: string;
}

export interface MeResponse {
  user: User;
}

export interface LogoutAllResponse {
  success: boolean;
  sessions_revoked: number;
}

// ─── Projects ────────────────────────────────────────

export interface CreateProjectRequest {
  name: string;
  github_repo?: string;
  github_installation_id?: number;
  build_command?: string;
  install_command?: string;
  output_directory?: string;
  root_directory?: string;
  node_version?: string;
}

export interface UpdateProjectRequest {
  name?: string;
  build_command?: string;
  install_command?: string;
  output_directory?: string;
  root_directory?: string;
  node_version?: string;
  production_branch?: string;
  auto_deploy?: boolean;
  preview_deployments?: boolean;
}

export interface ProjectListResponse {
  projects: Project[];
  pagination: Pagination;
}

export interface ProjectDetailResponse {
  project: Project;
  latest_deployment: Deployment | null;
  domains: Domain[];
}

// ─── Deployments ─────────────────────────────────────

export interface CreateDeploymentRequest {
  branch?: string;
  commit_sha?: string;
}

export interface DeploymentListResponse {
  deployments: Deployment[];
  pagination: Pagination;
}

export interface DeploymentResponse {
  deployment: Deployment;
}

export interface LogsResponse {
  lines: string[];
  total_lines: number;
  has_more: boolean;
}

// ─── Domains ─────────────────────────────────────────

export interface CreateDomainRequest {
  domain: string;
}

export interface CreateDomainResponse {
  domain: Domain;
  dns_instructions: DnsInstructions;
}

export interface DomainListResponse {
  domains: Domain[];
}

export interface VerifyDomainResponse {
  domain: Domain;
}

// ─── Environment Variables ───────────────────────────

export interface CreateEnvVarRequest {
  key: string;
  value: string;
  is_secret?: boolean;
  scope?: EnvVarScope;
}

export interface UpdateEnvVarRequest {
  value?: string;
  is_secret?: boolean;
  scope?: EnvVarScope;
}

export interface BulkImportEnvVarRequest {
  env_vars: CreateEnvVarRequest[];
}

export interface EnvVarListResponse {
  env_vars: EnvVar[];
}

export interface BulkImportEnvVarResponse {
  env_vars: EnvVar[];
  created: number;
  updated: number;
}

// ─── GitHub ──────────────────────────────────────────

export interface GitHubReposResponse {
  repos: GitHubRepo[];
  pagination: Pagination;
}

export interface GitHubInstallationsResponse {
  installations: GitHubInstallation[];
}

// ─── Notifications ───────────────────────────────────

export interface CreateNotificationRequest {
  channel: NotificationChannel;
  webhook_url: string;
  events?: string[];
}

export interface UpdateNotificationRequest {
  webhook_url?: string;
  events?: string[];
  enabled?: boolean;
}

export interface NotificationListResponse {
  notifications: NotificationConfig[];
}

// ─── Admin ───────────────────────────────────────────

export interface AdminStatsResponse extends SystemStats {}

export interface AdminUsersResponse {
  users: User[];
}

export interface AdminActivityResponse {
  activities: Activity[];
  pagination: Pagination;
}

export interface UpdateSettingsRequest {
  registration_enabled?: boolean;
  max_projects?: number;
  max_concurrent_builds?: number;
  artifact_retention_days?: number;
}

export interface AdminSettingsResponse {
  settings: PlatformSettings;
}

// ─── User Profile ────────────────────────────────────

export interface SessionsResponse {
  sessions: Session[];
}

// ─── Health ──────────────────────────────────────────

export interface HealthResponse {
  status: "ok";
  version: string;
  uptime_seconds: number;
}

// ─── Query Params ────────────────────────────────────

export interface PaginationParams {
  page?: number;
  per_page?: number;
}

export interface DeploymentListParams extends PaginationParams {
  status?: DeploymentStatus;
  branch?: string;
}

export interface ProjectListParams extends PaginationParams {
  search?: string;
}

export interface AdminActivityParams extends PaginationParams {
  action?: string;
  resource_type?: string;
}

export interface GitHubReposParams extends PaginationParams {
  installation_id: number;
}
```

### 7.3 `src/types/events.ts` — SSE Event Types

```ts
export interface LogEvent {
  line: number;
  message: string;
  timestamp: string;
}

export interface StatusEvent {
  status: string;
  phase: string;
}

export interface ErrorEvent {
  message: string;
}

export interface CompleteEvent {
  status: "ready" | "failed";
  duration_ms: number;
  url?: string;
  artifact_size_bytes?: number;
  error?: string;
}

export type SSEEventType = "log" | "status" | "error" | "complete";

export interface SSEMessage {
  id?: string;
  event: SSEEventType;
  data: LogEvent | StatusEvent | ErrorEvent | CompleteEvent;
}
```

---

## 8. API Client Architecture

### 8.1 `src/lib/api-client.ts`

The API client is a **singleton class** that wraps `fetch()` with:

- **Token injection**: Reads the access token from the Zustand auth store and attaches it as `Authorization: Bearer <token>`.
- **Auto-refresh on 401**: When a request returns `401 Unauthorized`, the client automatically calls `POST /api/v1/auth/refresh` (using the httpOnly cookie). If refresh succeeds, the original request is retried with the new token. If refresh fails, the user is redirected to `/login`.
- **JSON serialization**: Automatically serializes request bodies and parses responses.
- **Error normalization**: All API errors are converted to a typed `ApiError` object.

```ts
// Skeleton structure — full implementation during build

import { useAuthStore } from "@/stores/auth-store";
import type { ApiError } from "@/types/api";

class ApiClient {
  private baseUrl = "/api/v1";
  private refreshPromise: Promise<string> | null = null;

  private getToken(): string | null {
    return useAuthStore.getState().accessToken;
  }

  private setToken(token: string): void {
    useAuthStore.getState().setAccessToken(token);
  }

  private clearAuth(): void {
    useAuthStore.getState().logout();
  }

  private async refreshToken(): Promise<string> {
    // Deduplicate concurrent refresh attempts
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = fetch(`${this.baseUrl}/auth/refresh`, {
      method: "POST",
      credentials: "include", // send httpOnly cookie
    })
      .then(async (res) => {
        if (!res.ok) throw new Error("Refresh failed");
        const data = await res.json();
        this.setToken(data.access_token);
        return data.access_token as string;
      })
      .finally(() => {
        this.refreshPromise = null;
      });

    return this.refreshPromise;
  }

  async request<T>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      params?: Record<string, string | number | undefined>;
      skipAuth?: boolean;
    },
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`, window.location.origin);

    if (options?.params) {
      Object.entries(options.params).forEach(([key, value]) => {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      });
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    const token = this.getToken();
    if (token && !options?.skipAuth) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    let res = await fetch(url.toString(), {
      method,
      headers,
      credentials: "include",
      body: options?.body ? JSON.stringify(options.body) : undefined,
    });

    // Auto-refresh on 401
    if (res.status === 401 && !options?.skipAuth) {
      try {
        const newToken = await this.refreshToken();
        headers["Authorization"] = `Bearer ${newToken}`;
        res = await fetch(url.toString(), {
          method,
          headers,
          credentials: "include",
          body: options?.body ? JSON.stringify(options.body) : undefined,
        });
      } catch {
        this.clearAuth();
        window.location.href = "/login";
        throw new Error("Session expired");
      }
    }

    if (!res.ok) {
      const error: ApiError = await res.json().catch(() => ({
        error: {
          code: "UNKNOWN",
          message: res.statusText,
        },
      }));
      throw error;
    }

    return res.json() as Promise<T>;
  }

  // Convenience methods
  get<T>(path: string, params?: Record<string, string | number | undefined>) {
    return this.request<T>("GET", path, { params });
  }

  post<T>(path: string, body?: unknown) {
    return this.request<T>("POST", path, { body });
  }

  patch<T>(path: string, body?: unknown) {
    return this.request<T>("PATCH", path, { body });
  }

  put<T>(path: string, body?: unknown) {
    return this.request<T>("PUT", path, { body });
  }

  delete<T>(path: string) {
    return this.request<T>("DELETE", path);
  }
}

export const api = new ApiClient();
```

---

## 9. Auth State (Zustand)

### 9.1 `src/stores/auth-store.ts`

```ts
import { create } from "zustand";
import type { User } from "@/types/models";

interface AuthState {
  accessToken: string | null;
  user: User | null;
  isAuthenticated: boolean;

  setAccessToken: (token: string) => void;
  setUser: (user: User) => void;
  login: (token: string, user: User) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  user: null,
  isAuthenticated: false,

  setAccessToken: (token) => set({ accessToken: token }),
  setUser: (user) => set({ user }),
  login: (token, user) =>
    set({ accessToken: token, user, isAuthenticated: true }),
  logout: () =>
    set({ accessToken: null, user: null, isAuthenticated: false }),
}));
```

**Key design decisions:**
- Token is stored in memory (Zustand store), NOT `localStorage`.
- On page refresh, the token is gone — user is bootstrapped via `POST /api/v1/auth/refresh` using the httpOnly cookie.
- This provides XSS protection: even if JavaScript is injected, it cannot exfiltrate the refresh token.

---

## 10. React Router Configuration

### 10.1 Route Map

| Path | Page Component | Layout | Guard |
|------|---------------|--------|-------|
| `/setup` | `SetupPage` | `AuthLayout` | `SetupGuard` (only if not setup) |
| `/login` | `LoginPage` | `AuthLayout` | Redirect to `/` if authenticated |
| `/forgot-password` | `ForgotPasswordPage` | `AuthLayout` | None |
| `/reset-password` | `ResetPasswordPage` | `AuthLayout` | None |
| `/` | `DashboardPage` | `RootLayout` | `AuthGuard` |
| `/projects` | `ProjectsPage` | `RootLayout` | `AuthGuard` |
| `/projects/new` | `CreateProjectPage` | `RootLayout` | `AuthGuard` |
| `/projects/:id` | `ProjectDetailPage` | `RootLayout` | `AuthGuard` |
| `/projects/:id/deployments/:deploymentId` | `DeploymentDetailPage` | `RootLayout` | `AuthGuard` |
| `/admin` | `AdminPage` | `RootLayout` | `AuthGuard` + `AdminGuard` |
| `/profile` | `ProfilePage` | `RootLayout` | `AuthGuard` |
| `*` | `NotFoundPage` | `AuthLayout` | None |

### 10.2 `src/app.tsx`

```tsx
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";

import { RootLayout } from "@/components/layout/root-layout";
import { AuthLayout } from "@/components/layout/auth-layout";
import { AuthGuard } from "@/components/shared/auth-guard";
import { SetupGuard } from "@/components/shared/setup-guard";
import { AdminGuard } from "@/components/shared/admin-guard";
import { ErrorBoundary } from "@/components/shared/error-boundary";

import { SetupPage } from "@/pages/setup-page";
import { LoginPage } from "@/pages/login-page";
import { ForgotPasswordPage } from "@/pages/forgot-password-page";
import { ResetPasswordPage } from "@/pages/reset-password-page";
import { DashboardPage } from "@/pages/dashboard-page";
import { ProjectsPage } from "@/pages/projects-page";
import { CreateProjectPage } from "@/pages/create-project-page";
import { ProjectDetailPage } from "@/pages/project-detail-page";
import { DeploymentDetailPage } from "@/pages/deployment-detail-page";
import { AdminPage } from "@/pages/admin-page";
import { ProfilePage } from "@/pages/profile-page";
import { NotFoundPage } from "@/pages/not-found-page";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000, // 30s
    },
  },
});

export function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Routes>
            {/* Public auth routes */}
            <Route element={<AuthLayout />}>
              <Route path="/setup" element={<SetupGuard><SetupPage /></SetupGuard>} />
              <Route path="/login" element={<LoginPage />} />
              <Route path="/forgot-password" element={<ForgotPasswordPage />} />
              <Route path="/reset-password" element={<ResetPasswordPage />} />
            </Route>

            {/* Protected routes */}
            <Route element={<AuthGuard><RootLayout /></AuthGuard>}>
              <Route index element={<DashboardPage />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/projects/new" element={<CreateProjectPage />} />
              <Route path="/projects/:id" element={<ProjectDetailPage />} />
              <Route path="/projects/:id/deployments/:deploymentId" element={<DeploymentDetailPage />} />
              <Route path="/profile" element={<ProfilePage />} />

              {/* Admin routes */}
              <Route element={<AdminGuard />}>
                <Route path="/admin" element={<AdminPage />} />
              </Route>
            </Route>

            {/* Catch-all */}
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </BrowserRouter>
        <Toaster position="bottom-right" richColors />
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
```

---

## 11. TanStack Query Setup

### 11.1 Query Key Convention

All query keys follow a consistent naming pattern for cache invalidation:

```ts
// src/lib/constants.ts (partial — query keys section)

export const queryKeys = {
  // Setup
  setupStatus: ["setup-status"] as const,

  // Auth
  me: ["me"] as const,
  sessions: ["sessions"] as const,

  // Projects
  projects: (params?: { page?: number; search?: string }) =>
    ["projects", params] as const,
  project: (id: string) => ["project", id] as const,

  // Deployments
  deployments: (projectId: string, params?: { page?: number; status?: string; branch?: string }) =>
    ["deployments", projectId, params] as const,
  deployment: (id: string) => ["deployment", id] as const,
  deploymentLogs: (id: string) => ["deployment-logs", id] as const,

  // Domains
  domains: (projectId: string) => ["domains", projectId] as const,

  // Env Vars
  envVars: (projectId: string) => ["env-vars", projectId] as const,

  // GitHub
  installations: ["github-installations"] as const,
  repos: (installationId: number) => ["github-repos", installationId] as const,

  // Notifications
  notifications: (projectId: string) => ["notifications", projectId] as const,

  // Admin
  adminStats: ["admin-stats"] as const,
  adminUsers: ["admin-users"] as const,
  adminActivity: (params?: { page?: number }) => ["admin-activity", params] as const,
  adminSettings: ["admin-settings"] as const,
} as const;
```

### 11.2 Hook Pattern — Example: `useProjects`

Each query hook follows this pattern:

```ts
// src/hooks/use-projects.ts

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { queryKeys } from "@/lib/constants";
import type {
  ProjectListResponse,
  ProjectDetailResponse,
  CreateProjectRequest,
  UpdateProjectRequest,
  ProjectListParams,
} from "@/types/api";

// ─── Queries ─────────────────────────────────────────

export function useProjects(params?: ProjectListParams) {
  return useQuery({
    queryKey: queryKeys.projects(params),
    queryFn: () =>
      api.get<ProjectListResponse>("/projects", {
        page: params?.page,
        per_page: params?.per_page,
        search: params?.search,
      }),
  });
}

export function useProject(id: string) {
  return useQuery({
    queryKey: queryKeys.project(id),
    queryFn: () => api.get<ProjectDetailResponse>(`/projects/${id}`),
    enabled: !!id,
  });
}

// ─── Mutations ───────────────────────────────────────

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateProjectRequest) =>
      api.post<{ project: Project }>("/projects", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

export function useUpdateProject(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateProjectRequest) =>
      api.patch<{ project: Project }>(`/projects/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.project(id) });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

export function useDeleteProject(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<{ success: boolean }>(`/projects/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}
```

### 11.3 Complete Hook Inventory

Every hook, what it wraps, and what endpoints it calls:

| Hook File | Exported Hooks | API Endpoints |
|-----------|---------------|--------------|
| `use-auth.ts` | `useLogin()`, `useLogout()`, `useLogoutAll()`, `useRegister()`, `useBootstrapAuth()` | `POST /auth/login`, `POST /auth/logout`, `POST /auth/logout-all`, `POST /auth/register`, `POST /auth/refresh` + `GET /auth/me` |
| `use-setup-status.ts` | `useSetupStatus()`, `useSetup()` | `GET /setup/status`, `POST /setup` |
| `use-projects.ts` | `useProjects(params)`, `useProject(id)`, `useCreateProject()`, `useUpdateProject(id)`, `useDeleteProject(id)` | `GET /projects`, `GET /projects/:id`, `POST /projects`, `PATCH /projects/:id`, `DELETE /projects/:id` |
| `use-deployments.ts` | `useDeployments(projectId, params)`, `useDeployment(id)`, `useCreateDeployment(projectId)`, `useCancelDeployment(id)`, `useRollbackDeployment(id)`, `useDeploymentLogsQuery(id)` | `GET /projects/:id/deployments`, `GET /deployments/:id`, `POST /projects/:id/deployments`, `POST /deployments/:id/cancel`, `POST /deployments/:id/rollback`, `GET /deployments/:id/logs` |
| `use-deployment-logs.ts` | `useDeploymentLogs(id)` | `GET /deployments/:id/logs/stream` (SSE) |
| `use-domains.ts` | `useDomains(projectId)`, `useAddDomain(projectId)`, `useVerifyDomain()`, `useDeleteDomain()` | `GET /projects/:id/domains`, `POST /projects/:id/domains`, `POST /domains/:id/verify`, `DELETE /domains/:id` |
| `use-env-vars.ts` | `useEnvVars(projectId)`, `useCreateEnvVar(projectId)`, `useUpdateEnvVar()`, `useDeleteEnvVar()`, `useBulkImportEnvVars(projectId)` | `GET /projects/:id/env-vars`, `POST /projects/:id/env-vars`, `PATCH /env-vars/:id`, `DELETE /env-vars/:id`, `POST /projects/:id/env-vars/bulk` |
| `use-github.ts` | `useInstallations()`, `useRepos(installationId)` | `GET /github/installations`, `GET /github/repos` |
| `use-notifications.ts` | `useNotifications(projectId)`, `useCreateNotification(projectId)`, `useUpdateNotification()`, `useDeleteNotification()`, `useTestNotification()` | `GET /projects/:id/notifications`, `POST /projects/:id/notifications`, `PATCH /notifications/:id`, `DELETE /notifications/:id`, `POST /notifications/:id/test` |
| `use-admin.ts` | `useAdminStats()`, `useAdminUsers()`, `useAdminActivity(params)`, `useAdminSettings()`, `useUpdateAdminSettings()` | `GET /admin/stats`, `GET /admin/users`, `GET /admin/activity`, `GET /admin/settings`, `POST /admin/settings` |
| `use-user.ts` | `useProfile()`, `useUpdateProfile()`, `useChangePassword()`, `useSessions()`, `useRevokeSession()`, `useForgotPassword()`, `useResetPassword()` | `GET /auth/me`, `PATCH /auth/me`, `PUT /auth/me/password`, `GET /auth/sessions`, `DELETE /auth/sessions/:id`, `POST /auth/forgot-password`, `POST /auth/reset-password` |
| `use-media-query.ts` | `useMediaQuery(query)`, `useIsMobile()` | None (browser API only) |

### 11.4 Polling for Active Deployments

The `useDeployment(id)` hook enables automatic polling when a deployment is in a non-terminal state:

```ts
export function useDeployment(id: string) {
  return useQuery({
    queryKey: queryKeys.deployment(id),
    queryFn: () => api.get<DeploymentResponse>(`/deployments/${id}`),
    enabled: !!id,
    refetchInterval: (query) => {
      const status = query.state.data?.deployment.status;
      if (status === "queued" || status === "building") {
        return 5_000; // Poll every 5s while build is active
      }
      return false; // Stop polling when terminal
    },
  });
}
```

---

## 12. SSE Integration

### 12.1 `src/hooks/use-deployment-logs.ts`

```ts
import { useEffect, useRef, useCallback, useState } from "react";
import { useAuthStore } from "@/stores/auth-store";
import type { LogEvent, StatusEvent, ErrorEvent, CompleteEvent } from "@/types/events";

interface UseDeploymentLogsOptions {
  enabled?: boolean;
}

interface UseDeploymentLogsReturn {
  lines: LogEvent[];
  status: StatusEvent | null;
  error: ErrorEvent | null;
  complete: CompleteEvent | null;
  isConnected: boolean;
  isComplete: boolean;
}

export function useDeploymentLogs(
  deploymentId: string,
  options?: UseDeploymentLogsOptions,
): UseDeploymentLogsReturn {
  const [lines, setLines] = useState<LogEvent[]>([]);
  const [status, setStatus] = useState<StatusEvent | null>(null);
  const [error, setError] = useState<ErrorEvent | null>(null);
  const [complete, setComplete] = useState<CompleteEvent | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  const lastEventIdRef = useRef<string | undefined>(undefined);
  const retryCountRef = useRef(0);
  const maxRetries = 5;

  const connect = useCallback(() => {
    const token = useAuthStore.getState().accessToken;
    if (!token || !deploymentId) return;

    // Build URL with auth token as query param (EventSource cannot set headers)
    let url = `/api/v1/deployments/${deploymentId}/logs/stream?token=${encodeURIComponent(token)}`;
    if (lastEventIdRef.current) {
      url += `&lastEventId=${encodeURIComponent(lastEventIdRef.current)}`;
    }

    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onopen = () => {
      setIsConnected(true);
      retryCountRef.current = 0;
    };

    es.addEventListener("log", (event) => {
      lastEventIdRef.current = event.lastEventId;
      const data: LogEvent = JSON.parse(event.data);
      setLines((prev) => [...prev, data]);
    });

    es.addEventListener("status", (event) => {
      lastEventIdRef.current = event.lastEventId;
      const data: StatusEvent = JSON.parse(event.data);
      setStatus(data);
    });

    es.addEventListener("error", (event) => {
      if (event.data) {
        const data: ErrorEvent = JSON.parse(event.data);
        setError(data);
      }
    });

    es.addEventListener("complete", (event) => {
      lastEventIdRef.current = event.lastEventId;
      const data: CompleteEvent = JSON.parse(event.data);
      setComplete(data);
      es.close();
      setIsConnected(false);
    });

    es.onerror = () => {
      es.close();
      setIsConnected(false);

      // Reconnect with exponential backoff
      if (retryCountRef.current < maxRetries && !complete) {
        const delay = Math.min(1000 * 2 ** retryCountRef.current, 30_000);
        retryCountRef.current++;
        setTimeout(connect, delay);
      }
    };
  }, [deploymentId, complete]);

  useEffect(() => {
    if (options?.enabled === false) return;

    connect();

    return () => {
      eventSourceRef.current?.close();
      setIsConnected(false);
    };
  }, [connect, options?.enabled]);

  return {
    lines,
    status,
    error,
    complete,
    isConnected,
    isComplete: complete !== null,
  };
}
```

### 12.2 SSE Authentication Note

`EventSource` cannot set custom headers. Two approaches:

1. **Query parameter token** (used above): `?token=<access_token>` — the Go backend must accept tokens from query params on the SSE endpoint specifically.
2. **Cookie-only auth for SSE**: The Go backend validates the httpOnly refresh cookie instead of the Bearer token for this endpoint.

The plan uses approach 1 (query param) because it's simpler and the endpoint is read-only.

---

## 13. Shared Components

### 13.1 `src/lib/utils.ts`

```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

export function truncateSha(sha: string): string {
  return sha.slice(0, 7);
}

export function parseEnvFile(content: string): Array<{ key: string; value: string }> {
  return content
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => {
      const eqIndex = line.indexOf("=");
      if (eqIndex === -1) return null;
      const key = line.slice(0, eqIndex).trim();
      let value = line.slice(eqIndex + 1).trim();
      // Strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return { key, value };
    })
    .filter(Boolean) as Array<{ key: string; value: string }>;
}
```

### 13.2 `src/lib/date.ts`

```ts
import { formatDistanceToNow, format, parseISO } from "date-fns";

export function timeAgo(dateStr: string): string {
  return formatDistanceToNow(parseISO(dateStr), { addSuffix: true });
}

export function formatDate(dateStr: string): string {
  return format(parseISO(dateStr), "MMM d, yyyy 'at' h:mm a");
}

export function formatDateShort(dateStr: string): string {
  return format(parseISO(dateStr), "MMM d, yyyy");
}
```

### 13.3 `src/lib/constants.ts`

```ts
import type { DeploymentStatus, Framework } from "@/types/models";

// ─── Route Paths ─────────────────────────────────────

export const routes = {
  setup: "/setup",
  login: "/login",
  forgotPassword: "/forgot-password",
  resetPassword: "/reset-password",
  dashboard: "/",
  projects: "/projects",
  newProject: "/projects/new",
  project: (id: string) => `/projects/${id}`,
  deployment: (projectId: string, deploymentId: string) =>
    `/projects/${projectId}/deployments/${deploymentId}`,
  admin: "/admin",
  profile: "/profile",
} as const;

// ─── Status Labels & Colors ─────────────────────────

export const statusConfig: Record<
  DeploymentStatus,
  { label: string; className: string; dotClassName: string }
> = {
  queued: {
    label: "Queued",
    className: "bg-muted text-muted-foreground",
    dotClassName: "bg-muted-foreground",
  },
  building: {
    label: "Building",
    className: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
    dotClassName: "bg-blue-500 animate-pulse-slow",
  },
  ready: {
    label: "Ready",
    className: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
    dotClassName: "bg-green-500",
  },
  failed: {
    label: "Failed",
    className: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
    dotClassName: "bg-red-500",
  },
  cancelled: {
    label: "Cancelled",
    className: "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
    dotClassName: "bg-zinc-500",
  },
};

// ─── Framework Display Names ─────────────────────────

export const frameworkConfig: Record<
  Framework,
  { label: string; icon: string }
> = {
  nextjs: { label: "Next.js", icon: "Hexagon" },
  vite: { label: "Vite", icon: "Zap" },
  cra: { label: "Create React App", icon: "Atom" },
  astro: { label: "Astro", icon: "Rocket" },
  gatsby: { label: "Gatsby", icon: "Circle" },
  nuxt: { label: "Nuxt", icon: "Triangle" },
  sveltekit: { label: "SvelteKit", icon: "Flame" },
  hugo: { label: "Hugo", icon: "FileText" },
  "plain-html": { label: "Static HTML", icon: "Globe" },
  unknown: { label: "Unknown", icon: "HelpCircle" },
};

// ─── Node.js Versions ────────────────────────────────

export const nodeVersions = ["22", "20", "18"] as const;

// ─── Query Keys (see Section 11.1 for full definition) ───

export const queryKeys = { /* ... */ } as const;
```

### 13.4 Key Shared Components — Specifications

#### `auth-guard.tsx`
- On mount, attempts to bootstrap auth via `POST /api/v1/auth/refresh` → `GET /api/v1/auth/me`.
- If successful, stores token + user in Zustand store, renders `<Outlet />`.
- If failed, redirects to `/login` via `<Navigate to="/login" />`.
- While bootstrapping, shows `<LoadingPage />` (full-page spinner/skeleton).

#### `setup-guard.tsx`
- Queries `GET /api/v1/setup/status`.
- If `setup_complete === true`, redirects to `/login`.
- If `setup_complete === false`, renders children (the setup page).
- While loading, shows `<LoadingPage />`.

#### `admin-guard.tsx`
- Reads `user.is_admin` from Zustand store.
- If admin, renders `<Outlet />`.
- If not admin, redirects to `/`.

#### `status-badge.tsx`
- Props: `status: DeploymentStatus`
- Renders a `<Badge>` with a colored dot + label from `statusConfig`.
- Building status gets `animate-pulse-slow` on the dot.

#### `framework-badge.tsx`
- Props: `framework: Framework | null`
- Renders a small badge with the framework's Lucide icon + label.
- Returns null if `framework` is null.

#### `commit-info.tsx`
- Props: `sha: string`, `message?: string`, `author?: string`
- Renders: truncated SHA (7 chars) with `<CopyButton>`, commit message (truncated to 60 chars), author name.
- SHA displayed in monospace font.

#### `log-viewer.tsx`
- Props: `lines: LogEvent[]`, `isStreaming: boolean`, `onCopy: () => void`
- Terminal-style component: dark background (`hsl(240 10% 5%)`), monospace font.
- Each line: line number (gray, right-aligned) + message content.
- Auto-scrolls to bottom when `isStreaming` is true (uses `useRef` + `scrollIntoView`).
- User scroll-up pauses auto-scroll; scrolling back to bottom resumes it.
- ANSI color rendering via `ansi-to-react`.
- "Copy log" button in top-right corner.
- Wrapped in `<ScrollArea>` with max-height.

#### `empty-state.tsx`
- Props: `icon: LucideIcon`, `title: string`, `description: string`, `action?: { label: string, onClick: () => void }`
- Centered vertically in container, icon + text + optional CTA button.

#### `confirmation-dialog.tsx`
- Props: `open: boolean`, `onOpenChange`, `title: string`, `description: string`, `confirmLabel?: string`, `variant?: "default" | "destructive"`, `onConfirm: () => void`, `isLoading?: boolean`
- Uses shadcn `AlertDialog`.
- Destructive variant shows red confirm button.
- Disables buttons and shows spinner when `isLoading`.

#### `page-header.tsx`
- Props: `title: string`, `description?: string`, `children?: ReactNode` (action slot)
- Renders heading + description + right-aligned action buttons.

#### `search-input.tsx`
- Props: `value: string`, `onChange: (value: string) => void`, `placeholder?: string`
- Debounced (300ms) search input with Lucide `Search` icon.
- Uses `useDeferredValue` or a custom debounce.

#### `data-table.tsx`
- Generic component wrapping shadcn `<Table>`.
- Props: `columns: Column[]`, `data: T[]`, `isLoading: boolean`
- Shows `<Skeleton>` rows when loading.
- Shows `<EmptyState>` when data is empty.

#### `pagination-controls.tsx`
- Props: `pagination: Pagination`, `onPageChange: (page: number) => void`
- Uses shadcn `<Pagination>` components.
- Shows "Page X of Y" with previous/next buttons.

---

## 14. Page Implementations

### 14.1 Setup Page (`/setup`)

**File:** `src/pages/setup-page.tsx`

**Components used:** `Card`, `Input`, `Button`, `Form` (react-hook-form + zod)

**Form fields:**
- Display Name (`string`, required)
- Email (`string`, required, email format)
- Password (`string`, required, min 8 chars)
- Confirm Password (`string`, must match password)
- Platform Domain (`string`, required, e.g., `hostbox.example.com`)

**Validation schema (zod):**
```ts
const setupSchema = z.object({
  display_name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  confirm_password: z.string(),
  platform_domain: z.string().min(1, "Platform domain is required"),
}).refine((data) => data.password === data.confirm_password, {
  message: "Passwords do not match",
  path: ["confirm_password"],
});
```

**Behavior:**
1. Submit → `POST /api/v1/setup` with `{ email, password, display_name, platform_domain }`.
2. On success → store token + user in Zustand → redirect to `/`.
3. Show toast on error.

**Layout:** `AuthLayout` (centered card, Hostbox logo above).

---

### 14.2 Login Page (`/login`)

**File:** `src/pages/login-page.tsx`

**Components used:** `Card`, `Input`, `Button`, `Form`

**Form fields:**
- Email (`string`, required)
- Password (`string`, required)

**Behavior:**
1. If already authenticated (Zustand), redirect to `/`.
2. Submit → `POST /api/v1/auth/login`.
3. On success → `login(token, user)` in Zustand → redirect to `/`.
4. On error → show inline error message.
5. Link to `/forgot-password` below form.
6. Link to `/setup` if setup not complete (conditional).

---

### 14.3 Forgot Password Page (`/forgot-password`)

**File:** `src/pages/forgot-password-page.tsx`

**Form fields:** Email only.

**Behavior:**
1. Submit → `POST /api/v1/auth/forgot-password`.
2. Always show success message: "If an account with that email exists, we've sent a password reset link."
3. Link back to `/login`.

---

### 14.4 Reset Password Page (`/reset-password?token=xxx`)

**File:** `src/pages/reset-password-page.tsx`

**Form fields:**
- New Password (`string`, min 8 chars)
- Confirm Password (`string`, must match)

**Behavior:**
1. Read `token` from URL search params.
2. Submit → `POST /api/v1/auth/reset-password` with `{ token, new_password }`.
3. On success → show success message + link to `/login`.
4. On error → show error (invalid/expired token).

---

### 14.5 Dashboard Page (`/`)

**File:** `src/pages/dashboard-page.tsx`

**Components used:** `Card`, `Button`, `StatusBadge`, `TimeAgo`, `Skeleton`

**Layout sections:**
1. **Welcome header**: "Welcome back, {user.display_name}"
2. **Stats row** (4 cards):
   - Total Projects (number)
   - Total Deployments (number)
   - Active Builds (number, with building animation if > 0)
   - Disk Usage (formatted bytes with progress bar)
3. **Recent Deployments** (last 5):
   - Table: project name, commit, branch, status badge, time ago
   - Click → deployment detail page
4. **Quick Actions**:
   - "Create Project" button → `/projects/new`

**Data hooks:** `useAdminStats()`, `useProjects({ per_page: 5 })` (for recent), custom query for recent deployments across all projects.

---

### 14.6 Projects Page (`/projects`)

**File:** `src/pages/projects-page.tsx`

**Components used:** `Card`, `Button`, `SearchInput`, `Skeleton`, `EmptyState`, `PaginationControls`

**Layout:**
1. `<PageHeader title="Projects">` with "New Project" `<Button>`.
2. `<SearchInput>` for filtering by project name.
3. **Card grid** (responsive: 1 col mobile, 2 col tablet, 3 col desktop):
   - Each card: `<ProjectCard>` showing name, repo link, framework badge, last deployment status, deployment URL, time ago.
4. `<PaginationControls>` at bottom.
5. `<EmptyState>` when no projects: icon=`FolderPlus`, message="No projects yet", action="Create your first project".

**Data hooks:** `useProjects(params)` with debounced search.

---

### 14.7 Create Project Page (`/projects/new`)

**File:** `src/pages/create-project-page.tsx`

**Component:** `<CreateProjectWizard>` — multi-step form.

**Steps:**

**Step 1: Connect Repository**
- `<GitHubRepoPicker>`
- Lists GitHub App installations via `useInstallations()`.
- User selects an installation → lists repos via `useRepos(installationId)`.
- Repos displayed as a searchable list with name, description, visibility badge.
- Click a repo → advances to Step 2.
- "Skip" option for manual project (no GitHub).

**Step 2: Configure Build Settings**
- `<BuildSettingsForm>`
- Framework auto-detected (displayed as `<FrameworkBadge>`) — can override via `<FrameworkSelect>`.
- Fields (all pre-filled from detection, editable):
  - Build Command (`Input`, e.g., `npm run build`)
  - Install Command (`Input`, e.g., `npm ci`)
  - Output Directory (`Input`, e.g., `dist`)
  - Root Directory (`Input`, default `/`)
  - Node Version (`Select`: 22 | 20 | 18)
  - Project Name (`Input`, auto-generated from repo name, editable)

**Step 3: Environment Variables (Optional)**
- `<AddEnvVarForm>` — can add key-value pairs.
- "Skip" button to create without env vars.

**Submit:** `POST /api/v1/projects` → redirect to `/projects/:id`.

**State management:** Local `useState` for wizard step + accumulated form data.

---

### 14.8 Project Detail Page (`/projects/:id`)

**File:** `src/pages/project-detail-page.tsx`

**Components used:** `Tabs`, `Button`, `Badge`, `ExternalLink`

**Layout:**
1. `<ProjectHeader>`:
   - Project name (h1)
   - GitHub repo link (external icon)
   - Production URL (external link)
   - Framework badge
   - Actions: "Deploy" button (triggers manual deploy), "Redeploy" dropdown
2. `<ProjectTabs>`: tabbed navigation using shadcn `<Tabs>`:
   - **Deployments** (default tab) → `<DeploymentsTab>`
   - **Settings** → `<ProjectSettingsTab>`
   - **Domains** → `<DomainsTab>`
   - **Environment** → `<EnvVarsTab>`
   - **Notifications** → `<NotificationsTab>`

**Data hooks:** `useProject(id)` for the header, child tabs have their own hooks.

**Tab routing:** Uses URL search params (`?tab=settings`) or React Router nested state. Tabs are loaded lazily within the same page — no separate routes for tabs.

---

### 14.9 Deployments Tab

**File:** `src/pages/deployments-tab.tsx`

**Components used:** `Table`, `StatusBadge`, `CommitInfo`, `TimeAgo`, `PaginationControls`, `Select`

**Layout:**
1. Filter bar: branch filter (`<Select>`), status filter (`<Select>`).
2. Deployment list (table):
   - Columns: Status (badge) | Commit (SHA + message) | Branch | Duration | Time
   - Click row → `/projects/:id/deployments/:deploymentId`
3. `<PaginationControls>`.

**Data hooks:** `useDeployments(projectId, { page, status, branch })`.

---

### 14.10 Deployment Detail Page (`/projects/:id/deployments/:deploymentId`)

**File:** `src/pages/deployment-detail-page.tsx`

**Components used:** `Card`, `StatusBadge`, `CommitInfo`, `BuildProgress`, `LogViewer`, `Button`, `TimeAgo`

**Layout:**
1. **Breadcrumb**: Projects > {project.name} > Deployments > {deployment.id}
2. `<DeploymentHeader>`:
   - Status badge (large)
   - Commit SHA + message + author
   - Branch name
   - Build duration (formatted)
   - Artifact size (formatted bytes)
   - Deployment URL (clickable, if ready)
   - Timestamp
3. `<DeploymentActions>`:
   - If `building` or `queued` → "Cancel Build" button
   - If `ready` and not production → "Promote to Production" button
   - If `ready` → "Rollback to This" button
4. `<BuildProgress>`: 4-step indicator (Clone → Install → Build → Deploy) — highlighted based on `status` SSE event.
5. `<LogViewer>`:
   - If deployment is in `building` state → uses `useDeploymentLogs(deploymentId)` SSE hook.
   - If deployment is in terminal state (`ready`/`failed`/`cancelled`) → fetches full log via `GET /deployments/:id/logs`.
   - Terminal-style display with ANSI colors.
   - Auto-scroll during streaming.
   - "Copy Log" button.

**Data hooks:** `useDeployment(id)` (with 5s polling if building), `useDeploymentLogs(id)`.

---

### 14.11 Project Settings Tab

**File:** `src/pages/project-settings-tab.tsx`

**Components used:** `Card`, `Form`, `Input`, `Select`, `Switch`, `Button`, `Separator`, `AlertDialog`

**Sections:**

1. **Build Settings** (Card):
   - Framework (`<FrameworkSelect>`)
   - Build Command (`<Input>`)
   - Install Command (`<Input>`)
   - Output Directory (`<Input>`)
   - Root Directory (`<Input>`)
   - Node Version (`<Select>`)
   - "Save" button

2. **Deploy Settings** (Card):
   - Auto Deploy (`<Switch>` — toggle auto-deploy on push)
   - Preview Deployments (`<Switch>` — toggle PR preview deploys)
   - Production Branch (`<Input>`, default: `main`)
   - "Save" button

3. **Danger Zone** (Card, red border):
   - "Delete Project" button → `<ConfirmationDialog variant="destructive">`
   - Confirmation requires typing project name.
   - On confirm → `DELETE /api/v1/projects/:id` → redirect to `/projects`.

**Data hooks:** `useProject(id)`, `useUpdateProject(id)`, `useDeleteProject(id)`.

---

### 14.12 Domains Tab

**File:** `src/pages/domains-tab.tsx`

**Components used:** `Card`, `Button`, `Badge`, `Dialog`, `Input`, `Table`

**Layout:**
1. "Add Domain" button → opens `<AddDomainForm>` dialog.
2. Domain list:
   - Each domain as a `<DomainCard>`:
     - Domain name (h3)
     - Verification status badge (Verified ✓ / Pending ⏳ / Failed ✗)
     - `<DnsInstructions>`: A record + CNAME record in a code-style block.
     - "Verify" button (triggers `POST /domains/:id/verify`)
     - "Delete" button → `<ConfirmationDialog>`
     - Last checked timestamp.
3. `<EmptyState>` when no domains.

**Data hooks:** `useDomains(projectId)`, `useAddDomain(projectId)`, `useVerifyDomain()`, `useDeleteDomain()`.

---

### 14.13 Environment Variables Tab

**File:** `src/pages/env-vars-tab.tsx`

**Components used:** `Table`, `Button`, `Dialog`, `Input`, `Select`, `Badge`, `Textarea`

**Layout:**
1. Header: "Environment Variables" + "Add Variable" button + "Import .env" button.
2. `<EnvVarTable>`:
   - Columns: Key | Value | Scope | Actions
   - Value: masked as `••••••••` for secrets; `<Toggle>` to reveal (fetches from API? No — values are never returned for secrets. Toggle only works for non-secret values.)
   - Scope: `<EnvVarScopeBadge>` (all / production / preview)
   - Actions: Edit (inline), Delete
3. `<AddEnvVarForm>` dialog:
   - Key (`<Input>`, validated: alphanumeric + underscore)
   - Value (`<Textarea>`)
   - Scope (`<Select>`: all / production / preview)
   - Is Secret (`<Checkbox>`)
4. `<EnvVarImportDialog>`:
   - `<Textarea>` for pasting .env file contents.
   - Preview parsed variables before import.
   - Scope selector for all imported vars.
   - Submit → `POST /projects/:id/env-vars/bulk`.
5. `<EmptyState>` when no variables.

**Data hooks:** `useEnvVars(projectId)`, `useCreateEnvVar(projectId)`, `useUpdateEnvVar()`, `useDeleteEnvVar()`, `useBulkImportEnvVars(projectId)`.

---

### 14.14 Notifications Tab

**File:** `src/pages/notifications-tab.tsx`

**Components used:** `Card`, `Button`, `Dialog`, `Input`, `Select`, `Checkbox`, `Switch`

**Layout:**
1. Header: "Notifications" + "Add Webhook" button.
2. `<NotificationList>`:
   - Each config as `<NotificationCard>`:
     - Channel icon + label (Discord / Slack / Webhook)
     - Webhook URL (masked)
     - Enabled/disabled toggle (`<Switch>`)
     - Event toggles: checkboxes for each event type
     - "Test" button (sends test notification)
     - "Delete" button
3. `<AddNotificationForm>` dialog:
   - Channel (`<Select>`: Discord / Slack / Webhook)
   - Webhook URL (`<Input>`)
   - Events (`<EventToggleList>` — checkboxes for: deploy_started, deploy_success, deploy_failed, domain_verified)
4. `<EmptyState>` when no notifications configured.

**Data hooks:** `useNotifications(projectId)`, `useCreateNotification(projectId)`, `useUpdateNotification()`, `useDeleteNotification()`, `useTestNotification()`.

---

### 14.15 Admin Page (`/admin`)

**File:** `src/pages/admin-page.tsx`

**Components used:** `Tabs`, `Card`, `Table`, `Progress`, `Badge`, `Button`, `Form`, `Input`, `Switch`

**Tabs:**

1. **Overview** (default):
   - `<SystemStats>`:
     - RAM usage (if available from API)
     - Disk usage: `<DiskUsageBar>` — `<Progress>` with used/total bytes
     - Active builds count
     - Total projects count
     - Total deployments count
     - Uptime (formatted: "3 days, 4 hours")
   - Data hook: `useAdminStats()`

2. **Users**:
   - `<UserTable>`:
     - Columns: Name | Email | Role (Admin badge) | Email Verified | Joined
     - No create/delete in v1 (users self-register or are created via setup)
   - Data hook: `useAdminUsers()`

3. **Activity Log**:
   - `<ActivityLog>`:
     - Chronological list of actions.
     - Each `<ActivityRow>`: timestamp + user email + action description + resource link.
     - Filterable by action type, resource type.
     - Paginated.
   - Data hook: `useAdminActivity(params)`

4. **Settings**:
   - `<AdminSettingsForm>`:
     - Registration Enabled (`<Switch>`)
     - Max Projects per User (`<Input type="number">`)
     - Max Concurrent Builds (`<Input type="number">`)
     - Artifact Retention Days (`<Input type="number">`)
     - "Save" button.
   - Data hook: `useAdminSettings()`, `useUpdateAdminSettings()`

---

### 14.16 Profile Page (`/profile`)

**File:** `src/pages/profile-page.tsx`

**Components used:** `Card`, `Form`, `Input`, `Button`, `Table`, `Badge`, `Separator`

**Sections:**

1. **Profile** (Card):
   - Display Name (`<Input>`)
   - Email (`<Input>`)
   - "Save" button.
   - Hook: `useUpdateProfile()`

2. **Change Password** (Card):
   - Current Password (`<Input type="password">`)
   - New Password (`<Input type="password">`)
   - Confirm Password (`<Input type="password">`)
   - "Change Password" button.
   - Hook: `useChangePassword()`

3. **Active Sessions** (Card):
   - `<Table>`:
     - Columns: Browser/Device (parsed from user_agent) | IP | Last Active | Status
     - Current session highlighted with "Current" badge.
     - "Revoke" button per session (except current).
     - "Revoke All Other Sessions" button at top.
   - Hook: `useSessions()`, `useRevokeSession()`

---

### 14.17 Not Found Page (`/404`)

**File:** `src/pages/not-found-page.tsx`

**Layout:** Centered content, `AuthLayout`.

**Content:**
- Large "404" heading.
- "Page not found" subtext.
- "Back to Dashboard" button → `/`.

---

## 15. Build & Embed Pipeline

### 15.1 Development Workflow

```bash
# Terminal 1 — Go backend
go run cmd/api/main.go

# Terminal 2 — Vite dev server
cd web && npm run dev
```

Vite dev server runs on `:3000` and proxies `/api/*` to Go on `:8080` (configured in `vite.config.ts`).

### 15.2 Production Build

```bash
# Step 1: Build the web dashboard
cd web && npm ci && npm run build
# Output: web/dist/index.html, web/dist/assets/*

# Step 2: Build the Go binary (embeds web/dist/)
cd .. && go build -o hostbox cmd/api/main.go
```

### 15.3 Go Embedding Code

```go
// cmd/api/main.go (relevant portion)

package main

import (
    "embed"
    "io/fs"
    "net/http"
    "strings"

    "github.com/labstack/echo/v4"
)

//go:embed web/dist/*
var webFS embed.FS

func setupSPAHandler(e *echo.Echo) {
    // Strip "web/dist" prefix to serve from root
    distFS, _ := fs.Sub(webFS, "web/dist")
    fileServer := http.FileServer(http.FS(distFS))

    // Serve static files; fallback to index.html for SPA routes
    e.GET("/*", echo.WrapHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Don't intercept API routes
        if strings.HasPrefix(r.URL.Path, "/api/") {
            http.NotFound(w, r)
            return
        }

        // Try to serve static file
        path := r.URL.Path
        if path == "/" {
            path = "/index.html"
        }

        // Check if file exists in embedded FS
        f, err := distFS.Open(strings.TrimPrefix(path, "/"))
        if err != nil {
            // File not found — serve index.html (SPA fallback)
            r.URL.Path = "/index.html"
            fileServer.ServeHTTP(w, r)
            return
        }
        f.Close()

        // File exists — serve it
        fileServer.ServeHTTP(w, r)
    })))
}
```

### 15.4 `.gitignore` additions

```
web/dist/
web/node_modules/
```

---

## 16. Implementation Order

### Sprint 1: Foundation (Days 1–3)

| # | Task | Files Created |
|---|------|--------------|
| 1.1 | Scaffold Vite + React project in `web/` | `package.json`, `vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `index.html`, `postcss.config.js` |
| 1.2 | Install and configure Tailwind CSS | `tailwind.config.ts`, `src/globals.css` |
| 1.3 | Initialize shadcn/ui | `components.json`, install all 30 shadcn components into `src/components/ui/` |
| 1.4 | Create utility files | `src/lib/utils.ts`, `src/lib/date.ts`, `src/lib/constants.ts` |
| 1.5 | Create all TypeScript type definitions | `src/types/models.ts`, `src/types/api.ts`, `src/types/events.ts` |
| 1.6 | Build API client | `src/lib/api-client.ts` |
| 1.7 | Build Zustand auth store | `src/stores/auth-store.ts` |
| 1.8 | Set up React Router skeleton | `src/app.tsx`, `src/main.tsx` |

### Sprint 2: Auth & Layout (Days 4–6)

| # | Task | Files Created |
|---|------|--------------|
| 2.1 | Build auth hooks | `src/hooks/use-auth.ts`, `src/hooks/use-setup-status.ts` |
| 2.2 | Build layout components | `src/components/layout/root-layout.tsx`, `auth-layout.tsx`, `sidebar.tsx`, `topbar.tsx`, `mobile-nav.tsx` |
| 2.3 | Build guard components | `src/components/shared/auth-guard.tsx`, `setup-guard.tsx`, `admin-guard.tsx` |
| 2.4 | Build Setup Page | `src/pages/setup-page.tsx` |
| 2.5 | Build Login Page | `src/pages/login-page.tsx` |
| 2.6 | Build Forgot/Reset Password Pages | `src/pages/forgot-password-page.tsx`, `src/pages/reset-password-page.tsx` |
| 2.7 | Build shared components | `error-boundary.tsx`, `loading-page.tsx`, `page-header.tsx`, `empty-state.tsx`, `confirmation-dialog.tsx`, `toast` setup |

### Sprint 3: Dashboard & Projects (Days 7–10)

| # | Task | Files Created |
|---|------|--------------|
| 3.1 | Build shared status/display components | `status-badge.tsx`, `framework-badge.tsx`, `commit-info.tsx`, `time-ago.tsx`, `copy-button.tsx`, `search-input.tsx`, `data-table.tsx`, `pagination-controls.tsx`, `external-link.tsx` |
| 3.2 | Build project hooks | `src/hooks/use-projects.ts`, `src/hooks/use-github.ts` |
| 3.3 | Build Dashboard Page | `src/pages/dashboard-page.tsx` |
| 3.4 | Build Projects Page | `src/pages/projects-page.tsx`, `src/components/projects/project-card.tsx` |
| 3.5 | Build Create Project Wizard | `src/pages/create-project-page.tsx`, `create-project-wizard.tsx`, `github-repo-picker.tsx`, `build-settings-form.tsx`, `framework-select.tsx` |
| 3.6 | Build Project Detail shell | `src/pages/project-detail-page.tsx`, `project-header.tsx`, `project-tabs.tsx` |

### Sprint 4: Deployments & Build Logs (Days 11–14)

| # | Task | Files Created |
|---|------|--------------|
| 4.1 | Build deployment hooks | `src/hooks/use-deployments.ts` |
| 4.2 | Build SSE hook | `src/hooks/use-deployment-logs.ts` |
| 4.3 | Build Deployments Tab | `src/pages/deployments-tab.tsx`, `deployment-list.tsx`, `deployment-row.tsx` |
| 4.4 | Build Deployment Detail Page | `src/pages/deployment-detail-page.tsx`, `deployment-header.tsx`, `deployment-actions.tsx`, `build-progress.tsx` |
| 4.5 | Build Log Viewer | `src/components/deployments/log-viewer.tsx` |
| 4.6 | Integrate SSE with Log Viewer | Wire `useDeploymentLogs` → `<LogViewer>` with auto-scroll, ANSI support |

### Sprint 5: Domains, Env Vars, Notifications (Days 15–18)

| # | Task | Files Created |
|---|------|--------------|
| 5.1 | Build domain hooks + components | `src/hooks/use-domains.ts`, `domain-list.tsx`, `domain-card.tsx`, `add-domain-form.tsx`, `dns-instructions.tsx` |
| 5.2 | Build Domains Tab | `src/pages/domains-tab.tsx` |
| 5.3 | Build env var hooks + components | `src/hooks/use-env-vars.ts`, `env-var-table.tsx`, `env-var-row.tsx`, `add-env-var-form.tsx`, `env-var-import-dialog.tsx`, `env-var-scope-badge.tsx` |
| 5.4 | Build Env Vars Tab | `src/pages/env-vars-tab.tsx` |
| 5.5 | Build notification hooks + components | `src/hooks/use-notifications.ts`, `notification-list.tsx`, `notification-card.tsx`, `add-notification-form.tsx`, `event-toggle-list.tsx` |
| 5.6 | Build Notifications Tab | `src/pages/notifications-tab.tsx` |

### Sprint 6: Settings, Admin, Profile (Days 19–22)

| # | Task | Files Created |
|---|------|--------------|
| 6.1 | Build Project Settings Tab | `src/pages/project-settings-tab.tsx` |
| 6.2 | Build admin hooks | `src/hooks/use-admin.ts` |
| 6.3 | Build admin components | `system-stats.tsx`, `disk-usage-bar.tsx`, `user-table.tsx`, `activity-log.tsx`, `activity-row.tsx`, `admin-settings-form.tsx` |
| 6.4 | Build Admin Page | `src/pages/admin-page.tsx` |
| 6.5 | Build profile hooks + page | `src/hooks/use-user.ts`, `src/pages/profile-page.tsx` |
| 6.6 | Build Command Palette | `src/components/layout/command-palette.tsx` |
| 6.7 | Build 404 page | `src/pages/not-found-page.tsx` |
| 6.8 | Build media query hook | `src/hooks/use-media-query.ts` |

### Sprint 7: Polish & Integration (Days 23–25)

| # | Task |
|---|------|
| 7.1 | Dark mode toggle in topbar (system preference detection + manual toggle via `class` on `<html>`) |
| 7.2 | Loading skeleton states for every page/component |
| 7.3 | Error states and error boundary fallback UI |
| 7.4 | Toast notifications for all mutation success/failure |
| 7.5 | Mobile responsive testing + sidebar collapse behavior |
| 7.6 | Keyboard shortcuts (Cmd+K for command palette) |
| 7.7 | Go embed.FS integration + SPA fallback handler |
| 7.8 | Production build optimization (code splitting, tree shaking, chunk analysis) |
| 7.9 | End-to-end smoke test: setup → login → create project → deploy → view logs → domain → env vars |

---

## 17. Testing Strategy

### 17.1 Unit Tests (optional for v1, recommended)

- **Tool:** Vitest (Vite-native, drop-in replacement for Jest)
- **Focus:** Utility functions (`utils.ts`, `date.ts`, `constants.ts`), Zustand store, API client error handling, `.env` file parser.
- **Config addition to `package.json`:**
  ```json
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  }
  ```

### 17.2 Component Tests (optional for v1)

- **Tool:** Vitest + React Testing Library
- **Focus:** Guard components (AuthGuard, SetupGuard), form validation, SSE hook behavior.

### 17.3 Manual Testing Checklist

- [ ] Setup wizard creates admin account successfully
- [ ] Login redirects to dashboard
- [ ] Token refresh works transparently (wait 15 min or simulate expiry)
- [ ] Forgot/reset password flow
- [ ] Create project wizard (with and without GitHub)
- [ ] Build log streaming via SSE (watch a live build)
- [ ] Build log display for completed builds
- [ ] Auto-scroll behavior in log viewer (pause on scroll up, resume on scroll down)
- [ ] Cancel build
- [ ] Rollback deployment
- [ ] Add/verify/delete custom domain
- [ ] Create/edit/delete environment variables
- [ ] Bulk import .env file
- [ ] Notification webhook CRUD + test
- [ ] Admin panel: stats display, user list, activity log, settings update
- [ ] Profile: change name, change password, view sessions, revoke session
- [ ] Dark mode toggle
- [ ] Mobile responsive layout (sidebar collapse, mobile nav)
- [ ] Command palette (Cmd+K) navigation
- [ ] 404 page for unknown routes
- [ ] Error boundary catches component crashes
- [ ] SPA routing works when served from Go embed.FS

---

## 18. Performance Considerations

### 18.1 Bundle Size Budget

| Chunk | Target |
|-------|--------|
| `vendor` (React, ReactDOM, React Router) | < 50KB gzipped |
| `query` (TanStack Query) | < 15KB gzipped |
| `app` (all application code) | < 100KB gzipped |
| `ui` (shadcn/ui + Radix) | < 80KB gzipped |
| CSS | < 30KB gzipped |
| **Total** | **< 275KB gzipped** |

### 18.2 Optimization Techniques

1. **Code splitting:** `manualChunks` in Vite config for vendor/query separation.
2. **Tree shaking:** Only import specific Lucide icons (not the entire set).
3. **Lazy loading:** Consider `React.lazy()` for admin page and log viewer (heavy components).
4. **Image optimization:** SVG favicon, no raster images.
5. **CSS purging:** Tailwind CSS purges unused utilities at build time.
6. **Deferred hydration:** SPA doesn't need SSR — immediate client-side rendering.

### 18.3 Runtime Performance

1. **TanStack Query caching:** 30s `staleTime` prevents duplicate requests.
2. **SSE cleanup:** `useDeploymentLogs` hook cleans up `EventSource` on unmount.
3. **Polling control:** Polling only active for non-terminal deployment states.
4. **Debounced search:** 300ms debounce on search inputs.
5. **Virtual scrolling:** Consider for log viewer if logs exceed 10,000 lines (future optimization).
6. **Memoization:** `React.memo` on expensive list items (`DeploymentRow`, `ProjectCard`).

---

*End of Phase 5 Implementation Plan*
