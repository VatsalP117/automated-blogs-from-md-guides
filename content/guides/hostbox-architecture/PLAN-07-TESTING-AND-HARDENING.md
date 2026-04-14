# Phase 7: Testing, Security Hardening & Production Readiness

> **Goal**: Bring Hostbox to production-grade quality with comprehensive testing, security
> hardening, performance tuning, Docker production setup, documentation, and CI/CD pipelines.

---

## Table of Contents

- [Part A — Testing Strategy](#part-a--testing-strategy)
  - [A1. Unit Tests](#a1-unit-tests)
  - [A2. Repository Tests](#a2-repository-tests)
  - [A3. Service Tests](#a3-service-tests)
  - [A4. Integration Tests (HTTP)](#a4-integration-tests-http)
  - [A5. Build Pipeline Tests](#a5-build-pipeline-tests)
  - [A6. Frontend Tests](#a6-frontend-tests)
- [Part B — Security Hardening](#part-b--security-hardening)
  - [B1. Input Sanitization Audit](#b1-input-sanitization-audit)
  - [B2. Build Container Hardening](#b2-build-container-hardening)
  - [B3. Secret Scrubbing](#b3-secret-scrubbing)
  - [B4. HTTP Security Headers](#b4-http-security-headers)
  - [B5. Rate Limiter Hardening](#b5-rate-limiter-hardening)
  - [B6. Auth Hardening](#b6-auth-hardening)
- [Part C — Performance Optimization](#part-c--performance-optimization)
  - [C1. SQLite Tuning](#c1-sqlite-tuning)
  - [C2. Memory Profiling](#c2-memory-profiling)
  - [C3. Build Performance](#c3-build-performance)
  - [C4. API Performance](#c4-api-performance)
- [Part D — Docker Production Setup](#part-d--docker-production-setup)
  - [D1. Production Compose](#d1-production-compose)
  - [D2. Development Compose](#d2-development-compose)
  - [D3. Health Check Endpoint](#d3-health-check-endpoint)
- [Part E — Documentation](#part-e--documentation)
- [Part F — CI/CD (GitHub Actions)](#part-f--cicd-github-actions)
  - [F1. Test Workflow](#f1-test-workflow)
  - [F2. Release Workflow](#f2-release-workflow)

---

## Part A — Testing Strategy

### A1. Unit Tests

Each file listed below is a standalone `_test.go` that tests one internal utility package
in full isolation — no database, no network, no Docker.

---

#### A1.1 Encryption Utility

**File**: `internal/platform/crypto/encrypt_test.go`

```
func TestEncryptDecryptRoundTrip(t *testing.T)
    - Encrypt a known plaintext, decrypt, assert original value is recovered.
    - Test with empty plaintext.
    - Test with large plaintext (1 MB).
    - Test with binary data (non-UTF-8).

func TestEncryptProducesDifferentCiphertext(t *testing.T)
    - Encrypt the same plaintext twice, assert the two ciphertexts differ (random nonce).

func TestDecryptWithWrongKey(t *testing.T)
    - Encrypt with key A, attempt to decrypt with key B, expect error.

func TestDecryptTamperedCiphertext(t *testing.T)
    - Encrypt, flip a bit in the ciphertext, attempt decrypt, expect authentication error.

func TestDecryptTruncatedCiphertext(t *testing.T)
    - Encrypt, truncate the ciphertext by 1 byte, expect error.

func TestDecryptWrongAAD(t *testing.T)
    - Encrypt with AAD "project_1:API_KEY", decrypt with AAD "project_2:API_KEY", expect error.
    - Encrypt with AAD "project_1:API_KEY", decrypt with AAD "project_1:OTHER_KEY", expect error.

func TestDecryptEmptyInput(t *testing.T)
    - Decrypt nil/empty slice, expect error (not panic).

func TestNewEncryptorInvalidKeyLength(t *testing.T)
    - Pass a 16-byte key (not 32), expect error.
    - Pass a 64-byte key, expect error.
    - Pass an empty key, expect error.
```

---

#### A1.2 Framework Detection

**File**: `internal/services/build/detect_test.go`

Each test creates a minimal `package.json` (and optionally a lockfile) in `t.TempDir()`,
then calls `DetectFramework(dir)`.

```
func TestDetectNextjs(t *testing.T)
    - package.json with "next" in dependencies.
    - Assert: framework="nextjs", buildCmd="npm run build", outputDir="out".

func TestDetectVite(t *testing.T)
    - package.json with "vite" in devDependencies.
    - Assert: framework="vite", buildCmd="npm run build", outputDir="dist".

func TestDetectCRA(t *testing.T)
    - package.json with "react-scripts" in dependencies.
    - Assert: framework="cra", buildCmd="npm run build", outputDir="build".

func TestDetectAstro(t *testing.T)
    - package.json with "astro" in dependencies.
    - Assert: framework="astro", buildCmd="npm run build", outputDir="dist".

func TestDetectGatsby(t *testing.T)
    - package.json with "gatsby" in dependencies.
    - Assert: framework="gatsby", buildCmd="npm run build", outputDir="public".

func TestDetectNuxt(t *testing.T)
    - package.json with "nuxt" in dependencies.
    - Assert: framework="nuxt", buildCmd="npm run generate", outputDir=".output/public".

func TestDetectSvelteKit(t *testing.T)
    - package.json with "@sveltejs/kit" in dependencies.
    - Assert: framework="sveltekit", buildCmd="npm run build", outputDir="build".

func TestDetectHugo(t *testing.T)
    - No package.json, but a hugo.toml in root.
    - Assert: framework="hugo", buildCmd="hugo --minify", outputDir="public".

func TestDetectPlainHTML(t *testing.T)
    - No package.json, but an index.html in root.
    - Assert: framework="static", buildCmd="", outputDir=".".

func TestDetectUnknownFallback(t *testing.T)
    - package.json with only unknown deps, no recognized framework.
    - Assert: framework="unknown", buildCmd="npm run build", outputDir="dist".

func TestDetectEmptyDirectory(t *testing.T)
    - Empty temp dir, no files at all.
    - Assert: returns error or falls back to "static".

func TestDetectMultipleFrameworks(t *testing.T)
    - package.json with both "next" and "vite" (Next.js should win — priority order).
    - Assert: framework="nextjs".

func TestDetectMonorepoRootDirectory(t *testing.T)
    - package.json in ./packages/web/ (simulating rootDirectory override).
    - Call DetectFramework with rootDirectory="packages/web".
    - Assert: correct detection.

func TestDetectCustomScripts(t *testing.T)
    - package.json with "vite" but scripts.build is "vite build --mode production".
    - Assert: buildCmd="npm run build" (we always use npm run build, not the raw script).
```

---

#### A1.3 Package Manager Detection

**File**: `internal/services/build/pkgmanager_test.go`

```
func TestDetectPnpm(t *testing.T)
    - Create pnpm-lock.yaml in temp dir.
    - Assert: manager="pnpm", installCmd="pnpm install --frozen-lockfile".

func TestDetectYarn(t *testing.T)
    - Create yarn.lock in temp dir.
    - Assert: manager="yarn", installCmd="yarn install --frozen-lockfile".

func TestDetectBun(t *testing.T)
    - Create bun.lockb in temp dir.
    - Assert: manager="bun", installCmd="bun install".

func TestDetectNpmFromLockfile(t *testing.T)
    - Create package-lock.json in temp dir.
    - Assert: manager="npm", installCmd="npm ci".

func TestDetectNpmFallback(t *testing.T)
    - Only package.json, no lockfile.
    - Assert: manager="npm", installCmd="npm install".

func TestDetectPriorityOrder(t *testing.T)
    - Create both pnpm-lock.yaml and package-lock.json.
    - Assert: pnpm wins (pnpm > yarn > bun > npm).

func TestDetectNoPackageJson(t *testing.T)
    - No package.json at all (e.g., Hugo project).
    - Assert: manager="", installCmd="".
```

---

#### A1.4 Deployment URL Generation

**File**: `internal/services/deployment/url_test.go`

```
func TestGeneratePreviewURL(t *testing.T)
    - Input: slug="my-app", deploymentID="a1b2c3d4e5f6", domain="hostbox.example.com".
    - Assert: "https://my-app-a1b2c3d4.hostbox.example.com".

func TestGenerateBranchStableURL(t *testing.T)
    - Input: slug="my-app", branch="feat/login", domain="hostbox.example.com".
    - Assert: "https://my-app-feat-login.hostbox.example.com".

func TestGenerateProductionURL(t *testing.T)
    - Input: slug="my-app", domain="hostbox.example.com", isProduction=true.
    - Assert: "https://my-app.hostbox.example.com".

func TestBranchSlugSanitization(t *testing.T)
    - "feat/add-login" → "feat-add-login".
    - "dependabot/npm_and_yarn/lodash-4.17.21" → truncated and sanitized.
    - "UPPER-CASE" → "upper-case".
    - "a--b" → "a-b" (collapse multiple hyphens).
    - Leading/trailing hyphens stripped.

func TestURLWithHTTPSDisabled(t *testing.T)
    - config.HTTPS=false → "http://..." prefix.
```

---

#### A1.5 JWT Token Generation & Validation

**File**: `internal/services/auth/jwt_test.go`

```
func TestGenerateAccessToken(t *testing.T)
    - Generate token for a user, parse it, assert claims (sub, email, admin, iat, exp).
    - Assert: expiry is 15 minutes from now.

func TestGenerateRefreshToken(t *testing.T)
    - Generate refresh token, assert it is a crypto-random string of expected length.
    - Generate two tokens, assert they differ.

func TestValidateValidToken(t *testing.T)
    - Generate token, validate it, assert claims are returned.

func TestValidateExpiredToken(t *testing.T)
    - Generate token with exp in the past, validate, assert error.

func TestValidateTokenWrongSigningKey(t *testing.T)
    - Generate with key A, validate with key B, assert error.

func TestValidateTokenMalformed(t *testing.T)
    - Validate "not.a.jwt", assert error.
    - Validate "", assert error.
    - Validate random bytes, assert error.

func TestValidateTokenTamperedPayload(t *testing.T)
    - Generate token, decode base64 payload, change email, re-encode (signature now invalid).
    - Validate, assert error.

func TestValidateTokenClockSkew(t *testing.T)
    - Generate token with iat = now + 5s (slight clock drift). 
    - Validate should still succeed (allowing small leeway).

func TestRefreshTokenHash(t *testing.T)
    - Hash a refresh token (SHA-256), assert deterministic output.
    - Hash two different tokens, assert different hashes.
```

---

#### A1.6 Rate Limiter (Token Bucket)

**File**: `internal/api/middleware/ratelimit_test.go`

```
func TestRateLimiterAllowsWithinLimit(t *testing.T)
    - Create limiter: 10 req/min. Send 10 requests, assert all allowed.

func TestRateLimiterBlocksOverLimit(t *testing.T)
    - Create limiter: 5 req/min. Send 6 requests, assert 6th is rejected.

func TestRateLimiterBurst(t *testing.T)
    - Create limiter: 10 req/min, burst=3. Send 3 rapid requests, assert all allowed.
    - Send 4th immediately, assert rejected.

func TestRateLimiterRefillsOverTime(t *testing.T)
    - Create limiter: 60 req/min (1/sec). Drain tokens. Wait 1 second. Assert 1 token available.

func TestRateLimiterPerIPIsolation(t *testing.T)
    - Drain tokens for IP "1.1.1.1". Assert IP "2.2.2.2" still has full bucket.

func TestRateLimiterCleanupStaleBuckets(t *testing.T)
    - Create 100 buckets. Advance time past cleanup threshold.
    - Trigger cleanup. Assert stale buckets are removed.
    - Assert active buckets are retained.

func TestRateLimiterConcurrentAccess(t *testing.T)
    - 100 goroutines hitting the same IP simultaneously.
    - Assert: no races (run with -race), total allowed <= limit.

func TestRateLimiterReturnsHeaders(t *testing.T)
    - After a request, assert X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
      headers are set with correct values.
```

---

#### A1.7 Nanoid Generation

**File**: `internal/platform/nanoid/nanoid_test.go`

```
func TestNanoidLength(t *testing.T)
    - Generate with default length (21), assert len == 21.
    - Generate with length 8, assert len == 8.

func TestNanoidCharset(t *testing.T)
    - Generate 1000 IDs, assert all characters are in URL-safe alphabet [A-Za-z0-9_-].

func TestNanoidUniqueness(t *testing.T)
    - Generate 10,000 IDs, assert no duplicates.

func TestNanoidConcurrentSafety(t *testing.T)
    - Generate IDs from 50 goroutines, collect into sync.Map, assert no duplicates and no panic.
```

---

#### A1.8 Domain Validation

**File**: `internal/services/domain/validate_test.go`

```
func TestValidDomains(t *testing.T)
    - "example.com" → valid.
    - "sub.example.com" → valid.
    - "my-app.example.co.uk" → valid.
    - "a.b.c.d.example.com" → valid.

func TestInvalidDomains(t *testing.T)
    - "" → invalid.
    - "example" → invalid (no TLD).
    - "-example.com" → invalid (leading hyphen).
    - "example-.com" → invalid (trailing hyphen).
    - "exam ple.com" → invalid (space).
    - "example..com" → invalid (consecutive dots).
    - "*.example.com" → invalid (wildcard not allowed for custom domains).
    - "localhost" → invalid.
    - "127.0.0.1" → invalid (IP not domain).
    - "example.com:8080" → invalid (port not allowed).
    - String > 253 chars → invalid.
    - Label > 63 chars → invalid.

func TestReservedDomains(t *testing.T)
    - "hostbox.example.com" → invalid (matches platform domain).
    - "anything.hostbox.example.com" → invalid (subdomain of platform).
```

---

#### A1.9 Slug Generation

**File**: `internal/services/project/slug_test.go`

```
func TestSlugFromName(t *testing.T)
    - "My App" → "my-app".
    - "Hello World 123" → "hello-world-123".
    - "  Leading Spaces  " → "leading-spaces".
    - "UPPERCASE" → "uppercase".
    - "special!@#$chars" → "specialchars" or "special-chars".
    - "a--b--c" → "a-b-c" (collapse hyphens).
    - "----" → "" or error (empty after sanitization).

func TestSlugMaxLength(t *testing.T)
    - Input > 48 chars → truncated at word boundary.

func TestSlugUniqueness(t *testing.T)
    - "my-app" exists → "my-app-1".
    - "my-app-1" exists → "my-app-2".
    - (Requires a check function/callback; test with mock.)
```

---

#### A1.10 Config Loading

**File**: `internal/platform/config/config_test.go`

```
func TestLoadDefaults(t *testing.T)
    - No env vars set (except required). Assert default values:
      - Port=8080, LogLevel="info", MaxConcurrentBuilds=1, etc.

func TestLoadFromEnv(t *testing.T)
    - Set PORT=9090, LOG_LEVEL=debug. Load config. Assert overrides applied.

func TestRequiredFieldsMissing(t *testing.T)
    - Unset PLATFORM_DOMAIN. Load config. Assert error with descriptive message.
    - Unset JWT_SECRET. Load config. Assert error.

func TestJWTSecretMinLength(t *testing.T)
    - Set JWT_SECRET to 10 chars (< 32 required). Assert validation error.

func TestEncryptionKeyValidation(t *testing.T)
    - Set ENCRYPTION_KEY to non-hex string. Assert validation error.
    - Set ENCRYPTION_KEY to 16-byte hex (too short). Assert validation error.

func TestBooleanParsing(t *testing.T)
    - PLATFORM_HTTPS="true" → true.
    - PLATFORM_HTTPS="false" → false.
    - PLATFORM_HTTPS="1" → true.
    - PLATFORM_HTTPS="invalid" → error.

func TestIntegerParsing(t *testing.T)
    - SMTP_PORT="587" → 587.
    - SMTP_PORT="abc" → error.
    - SMTP_PORT="-1" → error (validation: must be > 0).
```

---

#### A1.11 Build Logger

**File**: `internal/services/build/logger_test.go`

```
func TestBuildLoggerWritesToFile(t *testing.T)
    - Create a logger with a temp file and a mock SSE hub.
    - Write 5 lines. Assert file contains exactly 5 lines with timestamps.

func TestBuildLoggerPublishesToSSE(t *testing.T)
    - Create logger with mock SSE hub.
    - Write a line. Assert SSE hub received an event with correct data.

func TestBuildLoggerLineNumbers(t *testing.T)
    - Write 3 lines. Assert SSE events have IDs 1, 2, 3.

func TestBuildLoggerConcurrentWrites(t *testing.T)
    - 10 goroutines writing simultaneously.
    - Assert: no data races (-race), all lines present in file, line numbers sequential.

func TestBuildLoggerFlush(t *testing.T)
    - Write lines, call Flush. Assert file contents are persisted immediately.

func TestBuildLoggerStatusEvent(t *testing.T)
    - Call logger.Status("building", "Installing dependencies...").
    - Assert: SSE hub received a "status" event, not a "log" event.

func TestBuildLoggerCompleteEvent(t *testing.T)
    - Call logger.Complete("ready", 45000, "https://...").
    - Assert: SSE hub received a "complete" event with correct data.
```

---

#### A1.12 Caddy Config Builder

**File**: `internal/platform/caddy/config_test.go`

```
func TestBuildPreviewDeploymentRoute(t *testing.T)
    - Input: slug="my-app", deployID="abc123", projectID="p1", domain="hostbox.dev".
    - Assert JSON route matches host "my-app-abc123.hostbox.dev" with file_server root
      "/app/deployments/p1/abc123".

func TestBuildBranchStableRoute(t *testing.T)
    - Input: slug="my-app", branch="feat-login", projectID="p1", domain="hostbox.dev".
    - Assert host matches "my-app-feat-login.hostbox.dev".

func TestBuildCustomDomainRoute(t *testing.T)
    - Input: domain="myapp.com", projectID="p1", deployID="d1".
    - Assert JSON route with host "myapp.com", file_server root "/app/deployments/p1/d1".

func TestBuildSPARoute(t *testing.T)
    - Framework is "vite" (SPA mode).
    - Assert route includes try_files rewrite to /index.html.

func TestBuildStaticRoute(t *testing.T)
    - Framework is "hugo" (static mode).
    - Assert route does NOT include SPA fallback.

func TestBuildFullConfig(t *testing.T)
    - Input: 3 deployments + 2 custom domains.
    - Assert: full Caddy JSON config has correct structure with all routes.

func TestBuildConfigSecurityHeaders(t *testing.T)
    - Assert every route includes X-Frame-Options, X-Content-Type-Options headers.

func TestBuildConfigGzipEncoding(t *testing.T)
    - Assert every route includes the gzip encode handler.

func TestBuildPlatformRoute(t *testing.T)
    - Assert platform route reverse-proxies /api/* to localhost:8080.
    - Assert dashboard fallback route.
```

---

#### A1.13 GitHub Webhook Signature Verification

**File**: `internal/services/github/webhook_test.go`

```
func TestVerifyValidSignature(t *testing.T)
    - Compute HMAC-SHA256 of body with known secret.
    - Call VerifySignature(body, "sha256=<hex>", secret).
    - Assert: no error.

func TestVerifyInvalidSignature(t *testing.T)
    - Provide wrong signature. Assert error.

func TestVerifyEmptySignature(t *testing.T)
    - Provide empty X-Hub-Signature-256 header. Assert error.

func TestVerifyMalformedSignature(t *testing.T)
    - Provide "sha256=" (no hash). Assert error.
    - Provide "sha1=abc" (wrong algorithm prefix). Assert error.
    - Provide "not-a-signature". Assert error.

func TestVerifyEmptyBody(t *testing.T)
    - Verify with empty body and valid signature for empty body. Assert: ok.

func TestVerifyTimingSafe(t *testing.T)
    - Verify the implementation uses hmac.Equal or crypto/subtle.ConstantTimeCompare,
      not bytes.Equal or ==.
    - (This is a code-review test — inspect the source. Or: measure timing for valid vs
      invalid signatures and assert they are within tolerance.)
```

---

#### A1.14 PR Comment Body Generation

**File**: `internal/services/github/comment_test.go`

```
func TestBuildCommentBodySuccess(t *testing.T)
    - Input: deployment with status="ready", URL, commit, duration.
    - Assert output contains:
      - "<!-- hostbox-preview-deployment -->" marker.
      - Preview URL as a Markdown link.
      - Commit SHA (truncated to 7 chars).
      - Build duration in human-readable format.
      - Status emoji ✅.

func TestBuildCommentBodyFailure(t *testing.T)
    - Input: deployment with status="failed", error message.
    - Assert output contains ❌ and error summary.

func TestBuildCommentBodyMultipleDeployments(t *testing.T)
    - Input: project with 2 active previews (different PRs).
    - Assert: table rows for each deployment.

func TestCommentBodyContainsMarker(t *testing.T)
    - Assert every generated comment contains the HTML comment marker for update detection.
```

---

### A2. Repository Tests

All repository tests run against a **real SQLite database** (in-memory: `file::memory:?cache=shared`)
with migrations applied. Each test gets a fresh database via a helper.

**Helper**: `internal/repository/testutil_test.go`

```go
// setupTestDB creates an in-memory SQLite DB with all migrations applied.
func setupTestDB(t *testing.T) *sql.DB {
    t.Helper()
    db, err := sql.Open("sqlite3", "file::memory:?cache=shared&_journal_mode=WAL&_foreign_keys=ON")
    require.NoError(t, err)
    t.Cleanup(func() { db.Close() })
    runMigrations(t, db)
    return db
}
```

---

#### A2.1 User Repository

**File**: `internal/repository/user_repo_test.go`

```
func TestUserRepo_Create(t *testing.T)
    - Create a user, assert no error and ID is set.

func TestUserRepo_GetByID(t *testing.T)
    - Create user, GetByID, assert fields match.

func TestUserRepo_GetByEmail(t *testing.T)
    - Create user, GetByEmail, assert found.

func TestUserRepo_GetByEmail_NotFound(t *testing.T)
    - GetByEmail for non-existent email, assert ErrNotFound.

func TestUserRepo_Update(t *testing.T)
    - Create user, update display_name, fetch again, assert change persisted.

func TestUserRepo_UniqueEmailConstraint(t *testing.T)
    - Create user with email A. Create another user with email A. Assert unique constraint error.

func TestUserRepo_List(t *testing.T)
    - Create 5 users. List all. Assert count == 5.

func TestUserRepo_Delete(t *testing.T)
    - Create user. Delete. GetByID. Assert ErrNotFound.

func TestUserRepo_CascadeDeleteSessions(t *testing.T)
    - Create user + 3 sessions. Delete user. Assert sessions are also deleted.
```

---

#### A2.2 Session Repository

**File**: `internal/repository/session_repo_test.go`

```
func TestSessionRepo_Create(t *testing.T)
func TestSessionRepo_GetByTokenHash(t *testing.T)
func TestSessionRepo_DeleteByID(t *testing.T)
func TestSessionRepo_DeleteAllForUser(t *testing.T)
    - Create 3 sessions for user. DeleteAllForUser. Assert count == 0.
func TestSessionRepo_DeleteExpired(t *testing.T)
    - Create 2 expired + 1 valid session. DeleteExpired. Assert only 1 remains.
func TestSessionRepo_ListByUser(t *testing.T)
```

---

#### A2.3 Project Repository

**File**: `internal/repository/project_repo_test.go`

```
func TestProjectRepo_Create(t *testing.T)
func TestProjectRepo_GetByID(t *testing.T)
func TestProjectRepo_GetBySlug(t *testing.T)
func TestProjectRepo_UniqueSlugConstraint(t *testing.T)
func TestProjectRepo_ListByOwner(t *testing.T)
    - Create 3 projects for user A, 2 for user B.
    - ListByOwner(A) returns 3.
func TestProjectRepo_ListByOwner_Pagination(t *testing.T)
    - Create 25 projects. List with page=1, perPage=10. Assert 10 returned, total=25.
    - List with page=3. Assert 5 returned.
func TestProjectRepo_Update(t *testing.T)
func TestProjectRepo_Delete(t *testing.T)
func TestProjectRepo_CascadeDeleteDeployments(t *testing.T)
    - Create project + 3 deployments. Delete project. Assert deployments gone.
func TestProjectRepo_CascadeDeleteDomains(t *testing.T)
func TestProjectRepo_CascadeDeleteEnvVars(t *testing.T)
func TestProjectRepo_ForeignKeyOwner(t *testing.T)
    - Create project with non-existent owner_id. Assert foreign key violation.
func TestProjectRepo_FindByGitHubRepo(t *testing.T)
```

---

#### A2.4 Deployment Repository

**File**: `internal/repository/deployment_repo_test.go`

```
func TestDeploymentRepo_Create(t *testing.T)
func TestDeploymentRepo_GetByID(t *testing.T)
func TestDeploymentRepo_ListByProject(t *testing.T)
func TestDeploymentRepo_ListByProject_FilterByStatus(t *testing.T)
    - Create deployments with mixed statuses. Filter by "ready". Assert count.
func TestDeploymentRepo_ListByProject_FilterByBranch(t *testing.T)
func TestDeploymentRepo_ListByProject_Pagination(t *testing.T)
func TestDeploymentRepo_UpdateStatus(t *testing.T)
    - Create with "queued", update to "building", assert persisted.
func TestDeploymentRepo_FindQueuedOrBuilding(t *testing.T)
    - Create 1 queued + 1 building + 1 ready for same project+branch.
    - FindQueuedOrBuilding returns the queued one (or building one).
func TestDeploymentRepo_FindQueuedOrBuilding_NotFound(t *testing.T)
    - All deployments are "ready". Assert: nil returned.
func TestDeploymentRepo_ForeignKeyProject(t *testing.T)
func TestDeploymentRepo_GetLatestByProjectAndBranch(t *testing.T)
    - Create 3 deployments for same project+branch. Assert latest is returned.
func TestDeploymentRepo_CountByProject(t *testing.T)
```

---

#### A2.5 Domain Repository

**File**: `internal/repository/domain_repo_test.go`

```
func TestDomainRepo_Create(t *testing.T)
func TestDomainRepo_GetByID(t *testing.T)
func TestDomainRepo_GetByDomain(t *testing.T)
func TestDomainRepo_UniqueDomainConstraint(t *testing.T)
func TestDomainRepo_ListByProject(t *testing.T)
func TestDomainRepo_ListVerified(t *testing.T)
    - Create 3 domains (2 verified, 1 not). ListVerified returns 2.
func TestDomainRepo_UpdateVerified(t *testing.T)
func TestDomainRepo_Delete(t *testing.T)
func TestDomainRepo_ForeignKeyProject(t *testing.T)
```

---

#### A2.6 EnvVar Repository

**File**: `internal/repository/envvar_repo_test.go`

```
func TestEnvVarRepo_Create(t *testing.T)
func TestEnvVarRepo_GetByID(t *testing.T)
func TestEnvVarRepo_ListByProject(t *testing.T)
func TestEnvVarRepo_ListByProjectAndScope(t *testing.T)
    - Create vars with scope "all", "preview", "production".
    - ListByProjectAndScope("preview") returns "all" + "preview" vars.
func TestEnvVarRepo_Update(t *testing.T)
func TestEnvVarRepo_Delete(t *testing.T)
func TestEnvVarRepo_UniqueProjectKeyScope(t *testing.T)
    - Create env var (project_id=p1, key=API_KEY, scope=all).
    - Create another with same (project_id, key, scope) → error.
    - Create with same key but different scope → OK.
func TestEnvVarRepo_BulkCreate(t *testing.T)
    - Create 10 env vars in one call. Assert all 10 persisted.
func TestEnvVarRepo_CascadeOnProjectDelete(t *testing.T)
```

---

#### A2.7 Notification Config Repository

**File**: `internal/repository/notification_repo_test.go`

```
func TestNotificationRepo_Create(t *testing.T)
func TestNotificationRepo_ListByProject(t *testing.T)
func TestNotificationRepo_ListGlobal(t *testing.T)
    - Create config with project_id=NULL. Assert returned by ListGlobal.
func TestNotificationRepo_Update(t *testing.T)
func TestNotificationRepo_Delete(t *testing.T)
```

---

#### A2.8 Activity Log Repository

**File**: `internal/repository/activity_repo_test.go`

```
func TestActivityRepo_Log(t *testing.T)
func TestActivityRepo_ListRecent(t *testing.T)
func TestActivityRepo_ListByResource(t *testing.T)
func TestActivityRepo_Pagination(t *testing.T)
func TestActivityRepo_UserSetNullOnDelete(t *testing.T)
    - Create activity with user_id. Delete user. Assert activity still exists with user_id=NULL.
```

---

#### A2.9 Settings Repository

**File**: `internal/repository/settings_repo_test.go`

```
func TestSettingsRepo_Get(t *testing.T)
func TestSettingsRepo_Set(t *testing.T)
func TestSettingsRepo_GetNonExistent(t *testing.T)
    - Get a key that doesn't exist. Assert: error or default value.
func TestSettingsRepo_SetUpdatesExisting(t *testing.T)
    - Set "max_projects"="50". Set again to "100". Assert "100".
```

---

#### A2.10 Cross-Cutting Repository Tests

**File**: `internal/repository/crosscutting_test.go`

```
func TestConcurrentReadWrite(t *testing.T)
    - Launch 10 writer goroutines and 10 reader goroutines.
    - Writers: create projects. Readers: list projects.
    - Assert: no errors, no data races (run with -race).
    - Validates WAL mode works correctly.

func TestMigrationFromScratch(t *testing.T)
    - Open empty in-memory DB. Run all migrations.
    - Assert: all tables exist, all indexes exist, settings pre-populated.

func TestMigrationIdempotent(t *testing.T)
    - Run migrations. Run again. Assert: no error (migrations already applied).

func TestTransactionRollback(t *testing.T)
    - Begin tx. Create project. Create deployment with invalid FK. Rollback.
    - Assert: neither project nor deployment exist.
```

---

### A3. Service Tests

Service tests use **mocked repositories** (interfaces) to test business logic
in isolation. Use `gomock` or hand-written mocks.

**Mock generation** (if using mockgen):
```bash
mockgen -source=internal/repository/interfaces.go -destination=internal/repository/mocks/mocks.go
```

---

#### A3.1 Auth Service

**File**: `internal/services/auth/auth_service_test.go`

```
func TestAuthService_Register(t *testing.T)
    - Mock: UserRepo.GetByEmail returns ErrNotFound, UserRepo.Create succeeds.
    - Assert: user created, access token returned, refresh cookie set.

func TestAuthService_Register_DuplicateEmail(t *testing.T)
    - Mock: UserRepo.GetByEmail returns existing user.
    - Assert: CONFLICT error returned.

func TestAuthService_Register_WeakPassword(t *testing.T)
    - Input: password="123". Assert: VALIDATION_ERROR.

func TestAuthService_Register_DisabledRegistration(t *testing.T)
    - Mock: SettingsRepo.Get("registration_enabled") returns "false".
    - Assert: FORBIDDEN error.

func TestAuthService_Login(t *testing.T)
    - Mock: UserRepo.GetByEmail returns user with hashed password.
    - Input: correct password.
    - Assert: access token + refresh token session created.

func TestAuthService_Login_WrongPassword(t *testing.T)
    - Input: wrong password. Assert: UNAUTHORIZED error.

func TestAuthService_Login_NonExistentUser(t *testing.T)
    - Mock: UserRepo.GetByEmail returns ErrNotFound.
    - Assert: UNAUTHORIZED (generic — no email enumeration).

func TestAuthService_Refresh(t *testing.T)
    - Mock: SessionRepo.GetByTokenHash returns valid session.
    - Assert: new access token returned.

func TestAuthService_Refresh_ExpiredSession(t *testing.T)
    - Mock: session with expires_at in the past.
    - Assert: UNAUTHORIZED error, session deleted.

func TestAuthService_Refresh_InvalidToken(t *testing.T)
    - Mock: SessionRepo.GetByTokenHash returns ErrNotFound.
    - Assert: UNAUTHORIZED.

func TestAuthService_Logout(t *testing.T)
    - Mock: SessionRepo.DeleteByID succeeds.
    - Assert: session deleted.

func TestAuthService_LogoutAll(t *testing.T)
    - Mock: SessionRepo.DeleteAllForUser succeeds.
    - Assert: returns count of sessions revoked.

func TestAuthService_ForgotPassword(t *testing.T)
    - Mock: user exists, SMTP configured.
    - Assert: reset token stored, email "sent" (mock SMTP).
    - Always returns success even for non-existent email.

func TestAuthService_ResetPassword(t *testing.T)
    - Mock: valid reset token exists.
    - Assert: password updated, token consumed, all sessions revoked.

func TestAuthService_ResetPassword_ExpiredToken(t *testing.T)
    - Mock: token expired. Assert: error.

func TestAuthService_ResetPassword_UsedToken(t *testing.T)
    - Mock: token already used. Assert: error.
```

---

#### A3.2 Project Service

**File**: `internal/services/project/project_service_test.go`

```
func TestProjectService_Create(t *testing.T)
    - Mock: slug is unique. Assert: project created with auto-generated slug.

func TestProjectService_Create_SlugCollision(t *testing.T)
    - Mock: first slug check returns conflict, second (with suffix) is unique.
    - Assert: slug gets a numeric suffix.

func TestProjectService_Create_MaxProjectsReached(t *testing.T)
    - Mock: user has 50 projects, limit is 50.
    - Assert: error with descriptive message.

func TestProjectService_Update(t *testing.T)
    - Assert: fields updated, updated_at changed.

func TestProjectService_Update_NotOwner(t *testing.T)
    - User B tries to update User A's project. Assert: FORBIDDEN.

func TestProjectService_Delete(t *testing.T)
    - Mock: project exists with deployments, domains, env vars.
    - Assert: project deleted (cascade handled by DB or service).
    - Assert: activity logged.

func TestProjectService_Delete_NotOwner(t *testing.T)
    - Assert: FORBIDDEN.

func TestProjectService_GetBySlug(t *testing.T)
func TestProjectService_List_Pagination(t *testing.T)
```

---

#### A3.3 Deployment Service

**File**: `internal/services/deployment/deployment_service_test.go`

```
func TestDeploymentService_Create(t *testing.T)
    - Mock: no existing queued/building deployment.
    - Assert: deployment created with status="queued", enqueued to worker pool.

func TestDeploymentService_Create_Deduplication(t *testing.T)
    - Mock: existing queued deployment for same project+branch.
    - Assert: old deployment cancelled, new one created.

func TestDeploymentService_Create_DeduplicationBuilding(t *testing.T)
    - Mock: existing building deployment.
    - Assert: Docker container stopped, old deployment cancelled, new one created.

func TestDeploymentService_StatusTransitions(t *testing.T)
    - queued → building: OK.
    - building → ready: OK.
    - building → failed: OK.
    - queued → cancelled: OK.
    - ready → building: INVALID (cannot re-enter building).
    - failed → ready: INVALID.

func TestDeploymentService_Cancel(t *testing.T)
    - Cancel a queued deployment: status → cancelled.
    - Cancel a building deployment: Docker container stopped, status → cancelled.
    - Cancel a ready deployment: error (can't cancel completed).

func TestDeploymentService_Rollback(t *testing.T)
    - Mock: target deployment is "ready" with artifacts.
    - Assert: new deployment created with is_rollback=true, rollback_source_id set.
    - Assert: Caddy route updated to point to original artifacts.

func TestDeploymentService_Rollback_FailedDeployment(t *testing.T)
    - Target deployment has status="failed". Assert: error.

func TestDeploymentService_Rollback_MissingArtifacts(t *testing.T)
    - Target deployment artifacts were garbage-collected. Assert: error.
```

---

#### A3.4 Domain Service

**File**: `internal/services/domain/domain_service_test.go`

```
func TestDomainService_Add(t *testing.T)
    - Mock: domain doesn't exist yet.
    - Assert: domain created, DNS instructions returned.

func TestDomainService_Add_AlreadyExists(t *testing.T)
    - Mock: domain belongs to another project. Assert: CONFLICT.

func TestDomainService_Add_MaxDomainsReached(t *testing.T)
    - Project already has 10 domains (limit). Assert: error.

func TestDomainService_Verify_Success(t *testing.T)
    - Mock DNS resolver: domain resolves to server IP.
    - Assert: verified=true, Caddy route created.

func TestDomainService_Verify_WrongIP(t *testing.T)
    - Mock DNS resolver: domain resolves to different IP.
    - Assert: verified=false, descriptive error.

func TestDomainService_Verify_NXDOMAIN(t *testing.T)
    - Mock DNS resolver: NXDOMAIN. Assert: verified=false.

func TestDomainService_Delete(t *testing.T)
    - Assert: domain deleted, Caddy route removed.

func TestDomainService_ReVerify(t *testing.T)
    - Previously verified domain now resolves to wrong IP.
    - Assert: verified set to false, but not deleted (grace period).
```

---

#### A3.5 EnvVar Service

**File**: `internal/services/build/envvar_service_test.go`

```
func TestEnvVarService_Create(t *testing.T)
    - Create env var. Assert: value is encrypted before storage.

func TestEnvVarService_Get_Secret(t *testing.T)
    - Fetch a secret env var. Assert: value is "••••••••" (masked).

func TestEnvVarService_Get_NonSecret(t *testing.T)
    - Fetch non-secret env var. Assert: value is decrypted and returned.

func TestEnvVarService_EncryptDecryptRoundTrip(t *testing.T)
    - Create with value "my-secret". Read raw from DB (encrypted).
    - Decrypt manually. Assert original value recovered.

func TestEnvVarService_ResolveForDeployment_Production(t *testing.T)
    - 3 vars: scope=all, scope=production, scope=preview.
    - Resolve for production deployment. Assert: "all" + "production" returned.

func TestEnvVarService_ResolveForDeployment_Preview(t *testing.T)
    - Resolve for preview deployment. Assert: "all" + "preview" returned.

func TestEnvVarService_BuiltInVarsInjected(t *testing.T)
    - Resolve for a deployment. Assert: CI, HOSTBOX, HOSTBOX_URL, etc. are present.

func TestEnvVarService_BuiltInVarsCannotBeOverridden(t *testing.T)
    - User sets CI="false". Resolve. Assert: CI="true" (built-in wins).

func TestEnvVarService_BulkImport(t *testing.T)
    - Import 5 vars. Assert all 5 created.
    - Import again with 3 overlapping keys + 2 new. Assert: 3 updated, 2 created.
```

---

#### A3.6 GitHub Service

**File**: `internal/services/github/github_service_test.go`

```
func TestGitHubService_HandlePushEvent_ProductionBranch(t *testing.T)
    - Mock: project with production_branch="main", auto_deploy=true.
    - Push to "main". Assert: production deployment created.

func TestGitHubService_HandlePushEvent_FeatureBranch_WithPR(t *testing.T)
    - Push to "feat/login" which has an open PR. Assert: preview deployment created.

func TestGitHubService_HandlePushEvent_FeatureBranch_NoPR(t *testing.T)
    - Push to "feat/login" with no open PR. Assert: no deployment created.

func TestGitHubService_HandlePushEvent_AutoDeployDisabled(t *testing.T)
    - project.auto_deploy=false. Assert: no deployment.

func TestGitHubService_HandlePREvent_Opened(t *testing.T)
    - PR opened. Assert: preview deployment created.

func TestGitHubService_HandlePREvent_Synchronized(t *testing.T)
    - PR synchronized (new push). Assert: new preview deployment, old cancelled.

func TestGitHubService_HandlePREvent_Closed(t *testing.T)
    - PR closed. Assert: preview deployments marked inactive.

func TestGitHubService_HandlePREvent_PreviewsDisabled(t *testing.T)
    - project.preview_deployments=false. Assert: no deployment.

func TestGitHubService_TokenCaching(t *testing.T)
    - Request token for installation 123. Mock GitHub API returns token.
    - Request again. Assert: no second API call (cached).
    - Advance time past expiry. Request again. Assert: new API call made.

func TestGitHubService_WebhookParseEvents(t *testing.T)
    - Parse raw push event JSON. Assert fields extracted correctly.
    - Parse raw PR event JSON. Assert fields extracted correctly.
    - Parse installation event. Assert fields extracted correctly.
```

---

### A4. Integration Tests (HTTP)

Full HTTP integration tests using `httptest.Server` with a real Echo app, real in-memory SQLite,
and real service layer. External dependencies (Docker, GitHub API) are mocked.

**File**: `internal/api/integration_test.go`  
**Build tag**: `//go:build integration`

**Test helper**:
```go
func setupIntegrationServer(t *testing.T) (*httptest.Server, *TestClient) {
    t.Helper()
    db := setupTestDB(t)
    // Initialize all real services with the in-memory DB
    // Mock: Docker client, GitHub client, DNS resolver
    app := api.NewApp(db, mockDocker, mockGitHub, mockDNS)
    server := httptest.NewServer(app.Echo)
    t.Cleanup(server.Close)
    client := NewTestClient(server.URL)
    return server, client
}
```

---

#### A4.1 Auth Flow Integration

**File**: `internal/api/auth_integration_test.go`

```
func TestIntegration_FullAuthFlow(t *testing.T)
    Step 1: POST /api/v1/setup — create admin account.
    Step 2: POST /api/v1/auth/login — login, receive access token + refresh cookie.
    Step 3: GET /api/v1/auth/me — access protected route with token.
    Step 4: Wait for token to "expire" (or use a short-lived test token).
    Step 5: POST /api/v1/auth/refresh — get new access token using refresh cookie.
    Step 6: GET /api/v1/auth/me — verify new token works.
    Step 7: POST /api/v1/auth/logout — invalidate session.
    Step 8: POST /api/v1/auth/refresh — assert fails (session revoked).

func TestIntegration_RegisterWhenDisabled(t *testing.T)
    - Setup complete. Registration disabled. POST /auth/register → 403.

func TestIntegration_ProtectedRouteWithoutToken(t *testing.T)
    - GET /api/v1/projects without Authorization header → 401.

func TestIntegration_ProtectedRouteWithExpiredToken(t *testing.T)
    - GET /api/v1/projects with an expired JWT → 401.

func TestIntegration_SetupOnlyOnce(t *testing.T)
    - POST /setup twice. Second time → 403 (setup already complete).
```

---

#### A4.2 Project CRUD Integration

**File**: `internal/api/project_integration_test.go`

```
func TestIntegration_ProjectCRUD(t *testing.T)
    Step 1: POST /api/v1/projects — create project "My App".
    Step 2: GET /api/v1/projects — list, assert 1 project.
    Step 3: GET /api/v1/projects/:id — get by ID, assert fields.
    Step 4: PATCH /api/v1/projects/:id — update name.
    Step 5: GET /api/v1/projects/:id — verify update.
    Step 6: DELETE /api/v1/projects/:id — delete.
    Step 7: GET /api/v1/projects — list, assert 0 projects.

func TestIntegration_ProjectSlugAutoGeneration(t *testing.T)
    - Create "My Cool App" → slug = "my-cool-app".

func TestIntegration_ProjectValidation(t *testing.T)
    - POST /projects with empty name → 400 with validation details.
    - POST /projects with name > 100 chars → 400.
    - POST /projects with invalid node_version → 400.
```

---

#### A4.3 Deployment Flow Integration

**File**: `internal/api/deployment_integration_test.go`

```
func TestIntegration_DeploymentTrigger(t *testing.T)
    Step 1: Create project.
    Step 2: POST /api/v1/projects/:id/deployments {branch: "main"}.
    Step 3: Assert deployment created with status="queued".
    Step 4: GET /api/v1/deployments/:id — verify fields.

func TestIntegration_DeploymentCancel(t *testing.T)
    - Create deployment (queued). POST /deployments/:id/cancel. Assert status="cancelled".

func TestIntegration_DeploymentRollback(t *testing.T)
    - Create 2 "ready" deployments. POST /deployments/:id1/rollback.
    - Assert: new deployment created with is_rollback=true.

func TestIntegration_DeploymentList_Pagination(t *testing.T)
    - Create 25 deployments. GET ?page=2&per_page=10. Assert 10 returned.

func TestIntegration_DeploymentList_FilterByBranch(t *testing.T)
    - Create deployments on "main" and "feat/login". Filter by branch. Assert correct count.
```

---

#### A4.4 Domain Flow Integration

**File**: `internal/api/domain_integration_test.go`

```
func TestIntegration_DomainAddAndVerify(t *testing.T)
    Step 1: Create project.
    Step 2: POST /projects/:id/domains {domain: "myapp.com"}.
    Step 3: Assert: domain created with verified=false, dns_instructions returned.
    Step 4: Mock DNS resolver to return server IP.
    Step 5: POST /domains/:id/verify.
    Step 6: Assert: verified=true.

func TestIntegration_DomainVerifyFails(t *testing.T)
    - Mock DNS resolver returns wrong IP. POST /verify. Assert verified remains false.

func TestIntegration_DomainDelete(t *testing.T)
    - Add domain. DELETE /domains/:id. Assert gone.

func TestIntegration_DomainDuplicate(t *testing.T)
    - Add "myapp.com" to project A. Add "myapp.com" to project B → 409 CONFLICT.
```

---

#### A4.5 Env Var Flow Integration

**File**: `internal/api/envvar_integration_test.go`

```
func TestIntegration_EnvVarCRUD(t *testing.T)
    Step 1: Create project.
    Step 2: POST /projects/:id/env-vars {key: "API_KEY", value: "secret123", is_secret: true}.
    Step 3: GET /projects/:id/env-vars. Assert: value is "••••••••".
    Step 4: PATCH /env-vars/:id {value: "newsecret"}.
    Step 5: DELETE /env-vars/:id.
    Step 6: GET. Assert: empty.

func TestIntegration_EnvVarBulkImport(t *testing.T)
    - POST /env-vars/bulk with 5 vars. Assert all created.

func TestIntegration_EnvVarScoping(t *testing.T)
    - Create vars with different scopes. List. Assert scope field correct.
```

---

#### A4.6 Rate Limiter Integration

**File**: `internal/api/ratelimit_integration_test.go`

```
func TestIntegration_RateLimiter_AuthEndpoints(t *testing.T)
    - Send 11 POST /auth/login requests rapidly. Assert 11th returns 429.
    - Assert: X-RateLimit-Remaining header decrements correctly.

func TestIntegration_RateLimiter_APIEndpoints(t *testing.T)
    - Send 101 GET /projects rapidly. Assert 101st returns 429.

func TestIntegration_RateLimiter_RetryAfter(t *testing.T)
    - Exceed limit. Assert: response contains Retry-After header.
```

---

#### A4.7 CORS Integration

**File**: `internal/api/cors_integration_test.go`

```
func TestIntegration_CORS_AllowedOrigin(t *testing.T)
    - Send OPTIONS request with Origin: https://hostbox.example.com.
    - Assert: Access-Control-Allow-Origin header present.

func TestIntegration_CORS_DisallowedOrigin(t *testing.T)
    - Send OPTIONS with Origin: https://evil.com.
    - Assert: no CORS headers (or request blocked).

func TestIntegration_CORS_Methods(t *testing.T)
    - Assert: GET, POST, PATCH, DELETE allowed.
    - Assert: Access-Control-Allow-Headers includes Authorization, Content-Type.
```

---

#### A4.8 Error Response Integration

**File**: `internal/api/error_integration_test.go`

```
func TestIntegration_Error_ValidationError(t *testing.T)
    - POST /projects with invalid body. Assert 400 + error.code="VALIDATION_ERROR" + details array.

func TestIntegration_Error_NotFound(t *testing.T)
    - GET /projects/nonexistent. Assert 404 + error.code="NOT_FOUND".

func TestIntegration_Error_Unauthorized(t *testing.T)
    - GET /projects without token. Assert 401 + error.code="UNAUTHORIZED".

func TestIntegration_Error_Forbidden(t *testing.T)
    - Non-admin hits /admin/stats. Assert 403 + error.code="FORBIDDEN".

func TestIntegration_Error_Conflict(t *testing.T)
    - Create project, create again with same slug. Assert 409.

func TestIntegration_Error_SetupRequired(t *testing.T)
    - Before setup. Hit /projects. Assert 503 + error.code="SETUP_REQUIRED".

func TestIntegration_Error_ContentType(t *testing.T)
    - All error responses have Content-Type: application/json.

func TestIntegration_Error_NoStackTraces(t *testing.T)
    - Trigger a 500 error. Assert: response does NOT contain Go stack traces or file paths.
```

---

### A5. Build Pipeline Tests

These tests require Docker and are skipped in environments without it.

**File**: `internal/worker/build_pipeline_test.go`  
**Build tag**: `//go:build docker`

```
func TestBuildPipeline_SimpleViteProject(t *testing.T)
    - Create a minimal Vite project (package.json + index.html + main.js) in temp dir.
    - Run full build pipeline. Assert:
      - Status transitions: queued → building → ready.
      - Artifact path exists and contains index.html.
      - Artifact size > 0.
      - Build duration recorded.
      - Log file written.

func TestBuildPipeline_NextjsStaticExport(t *testing.T)
    - Create minimal Next.js project with `output: 'export'` in next.config.js.
    - Run build. Assert: output dir "out" copied correctly.

func TestBuildPipeline_EnvVarsInjected(t *testing.T)
    - Set env var NEXT_PUBLIC_API_URL="https://api.example.com".
    - Build a project that echoes the env var to a file during build.
    - Assert: env var was available inside build container.

func TestBuildPipeline_BuildCancellation(t *testing.T)
    - Start a build with a long-running command (sleep 300).
    - Cancel after 2 seconds.
    - Assert: status → cancelled, Docker container removed.

func TestBuildPipeline_BuildTimeout(t *testing.T)
    - Set timeout to 5 seconds. Build a project with sleep 30 in build command.
    - Assert: status → failed, error message mentions timeout.

func TestBuildPipeline_CacheReuse(t *testing.T)
    - Build a Vite project (first build). Record duration_1.
    - Build again (cache warm). Record duration_2.
    - Assert: duration_2 < duration_1 (at least 2x faster is typical).

func TestBuildPipeline_FrameworkDetectionAccuracy(t *testing.T)
    - Table-driven test with 8 minimal projects (one per framework).
    - For each: create project, detect framework, assert correct detection.
    - Frameworks: nextjs, vite, cra, astro, gatsby, nuxt, sveltekit, static.

func TestBuildPipeline_BuildFailure(t *testing.T)
    - Project with invalid build command ("exit 1").
    - Assert: status → failed, error_message populated, log contains error output.

func TestBuildPipeline_ContainerCleanup(t *testing.T)
    - Run a build (success or failure).
    - Assert: no lingering containers named "build-*".

func TestBuildPipeline_PnpmInstall(t *testing.T)
    - Project with pnpm-lock.yaml. Assert: install command uses pnpm.

func TestBuildPipeline_YarnInstall(t *testing.T)
    - Project with yarn.lock. Assert: install command uses yarn.
```

---

### A6. Frontend Tests

**Tooling**: Vitest + React Testing Library + jsdom  
**Config**: `web/vitest.config.ts`

```typescript
// web/vitest.config.ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      reporter: ['text', 'lcov'],
      exclude: ['node_modules/', 'src/test/'],
    },
  },
});
```

```typescript
// web/src/test/setup.ts
import '@testing-library/jest-dom';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
```

---

#### A6.1 Component Tests

**File**: `web/src/components/__tests__/DeploymentStatusBadge.test.tsx`

```
test('renders "Ready" badge with green color for ready status')
test('renders "Building" badge with animated spinner for building status')
test('renders "Failed" badge with red color for failed status')
test('renders "Queued" badge with gray color for queued status')
test('renders "Cancelled" badge for cancelled status')
```

**File**: `web/src/components/__tests__/LogViewer.test.tsx`

```
test('renders log lines with line numbers')
test('auto-scrolls to bottom when new lines added')
test('disables auto-scroll when user scrolls up')
test('re-enables auto-scroll when user scrolls to bottom')
test('displays ANSI colors correctly')
test('shows loading skeleton when no lines yet')
test('shows "Build complete" message on complete event')
```

**File**: `web/src/components/__tests__/EnvVarEditor.test.tsx`

```
test('renders list of environment variables')
test('masks secret values with dots')
test('reveals secret value on eye icon click')
test('adds new env var via form')
test('deletes env var with confirmation')
test('validates key format (uppercase, underscores)')
test('shows scope selector (all/preview/production)')
test('bulk import from textarea parses KEY=VALUE lines')
```

**File**: `web/src/components/__tests__/DomainCard.test.tsx`

```
test('shows DNS instructions for unverified domain')
test('shows green check for verified domain')
test('verify button triggers verification')
test('shows SSL status after verification')
test('delete button removes domain with confirmation')
```

**File**: `web/src/components/__tests__/SetupWizard.test.tsx`

```
test('renders step 1: create admin account')
test('validates email format')
test('validates password minimum length')
test('advances to step 2 on submit')
test('submits setup and redirects to dashboard')
```

---

#### A6.2 API Client Tests

**File**: `web/src/lib/__tests__/api.test.ts`

```
test('GET request with auth header')
test('POST request with JSON body')
test('auto-refresh on 401 response')
test('throws UnauthorizedError when refresh fails')
test('includes credentials for cookies')
test('parses JSON error response')
test('handles network errors gracefully')
test('concurrent requests during token refresh are queued')
```

---

#### A6.3 SSE Hook Tests

**File**: `web/src/lib/__tests__/useLogStream.test.ts`

```
test('connects to SSE endpoint on mount')
test('receives and appends log events')
test('receives status events')
test('handles complete event and closes connection')
test('reconnects on connection drop with exponential backoff')
test('sends Last-Event-ID on reconnect')
test('cleans up EventSource on unmount')
test('handles error events')
```

---

#### A6.4 Auth Hook Tests

**File**: `web/src/lib/__tests__/useAuth.test.ts`

```
test('login stores access token in memory')
test('logout clears token and redirects to login')
test('isAuthenticated returns true when token present')
test('auto-refresh before token expiry')
test('redirects to login when refresh fails')
test('provides current user data')
```

---

## Part B — Security Hardening

### B1. Input Sanitization Audit

**Checklist** (each item requires a manual audit + automated test):

| # | Check | File(s) to Audit | Test |
|---|-------|-------------------|------|
| 1 | All SQL queries use parameterized statements (`?` placeholders) | `internal/repository/*.go` | Grep for string concatenation in SQL queries: `grep -rn 'fmt.Sprintf.*SELECT\|fmt.Sprintf.*INSERT\|fmt.Sprintf.*UPDATE\|fmt.Sprintf.*DELETE' internal/repository/` — must return 0 results |
| 2 | XSS prevention in SSE log output | `internal/services/build/logger.go`, `internal/api/handlers/deployment.go` | Inject `<script>alert(1)</script>` as a log line. Assert: output is escaped in SSE data field |
| 3 | Path traversal in file operations | `internal/worker/build.go`, `internal/services/deployment/` | Test with `../../etc/passwd` as project slug, deployment ID, or output dir. Assert: path is sanitized and stays under `/app/deployments/` |
| 4 | Command injection prevention | `internal/worker/build.go`, `internal/platform/docker/` | Audit all `exec.Command` or Docker exec calls. Assert: no user input is passed to shell commands. All commands should use argument arrays, never shell strings |
| 5 | JSON injection in API responses | `internal/api/handlers/*.go` | All responses use `c.JSON()` (Echo's built-in JSON encoder). No manual string building |
| 6 | Header injection | `internal/api/middleware/` | Audit all `c.Response().Header().Set()` calls. Assert: no user input in header values |
| 7 | URL validation for webhooks | `internal/services/github/`, `internal/services/notification/` | Test with `javascript:`, `file://`, SSRF payloads (internal IPs). Assert: only https:// URLs accepted for webhook URLs |

**Implementation file**: `internal/platform/sanitize/sanitize.go`

```go
// SanitizeLogLine escapes HTML-sensitive characters in build log output.
func SanitizeLogLine(line string) string

// SafeJoinPath joins path components and ensures the result is under the base directory.
func SafeJoinPath(base string, components ...string) (string, error)

// ValidateWebhookURL ensures URL is HTTPS and not an internal/private IP.
func ValidateWebhookURL(rawURL string) error
```

---

### B2. Build Container Hardening

**Test file**: `internal/worker/container_security_test.go`  
**Build tag**: `//go:build docker`

```
func TestContainer_SecurityFlags(t *testing.T)
    - Inspect the created container config. Assert:
      - CapDrop includes "ALL".
      - SecurityOpt includes "no-new-privileges:true".
      - ReadonlyRootfs is true (except /tmp and output dirs).
      - PidsLimit == 256.
      - Memory limit set.
      - CPU quota set.

func TestContainer_NoHostNetworkAccess(t *testing.T)
    - Inside build container, run: curl http://169.254.169.254/ (cloud metadata).
    - Assert: connection refused or timeout (network isolation).

func TestContainer_NoDockerSocketAccess(t *testing.T)
    - Assert: /var/run/docker.sock is NOT mounted inside build container.

func TestContainer_CannotWriteOutsideAllowedDirs(t *testing.T)
    - Inside container, try: touch /etc/test, touch /root/test.
    - Assert: permission denied.

func TestContainer_NetworkIsolation(t *testing.T)
    - Option: build containers use --network=none if internet is not needed.
    - For internet-requiring builds: use a restricted Docker network that blocks
      access to host network and metadata services.

func TestContainer_ResourceLimits(t *testing.T)
    - Start a container that tries to allocate 1GB memory (limit is 512MB).
    - Assert: OOM killed.
    - Start a container that forks 500 processes (limit is 256 PIDs).
    - Assert: cannot fork.
```

**Changes to implement** in `internal/platform/docker/container.go`:

```go
containerConfig := &container.Config{
    Image: image,
    Env:   envVars,
}

hostConfig := &container.HostConfig{
    Resources: container.Resources{
        Memory:    512 * 1024 * 1024, // 512 MB
        NanoCPUs:  1e9,               // 1 CPU
        PidsLimit: int64Ptr(256),
    },
    SecurityOpt:    []string{"no-new-privileges:true"},
    CapDrop:        []string{"ALL"},
    ReadonlyRootfs: false, // must be false for npm install to work
    Tmpfs: map[string]string{
        "/tmp": "rw,noexec,nosuid,size=100m",
    },
    NetworkMode: "hostbox-build", // restricted network
}
```

Create a restricted Docker network:
```bash
docker network create hostbox-build \
  --internal \
  --driver bridge \
  --opt com.docker.network.bridge.enable_ip_masquerade=false
```

---

### B3. Secret Scrubbing

**File**: `internal/services/build/scrubber.go`

```go
// LogScrubber replaces secret values in log lines before they are written.
type LogScrubber struct {
    secrets []string // plaintext values to scrub
}

func NewLogScrubber(envVars map[string]string) *LogScrubber {
    // Collect all values that should be scrubbed
    // Only scrub values longer than 3 characters (avoid replacing "a" everywhere)
}

func (s *LogScrubber) Scrub(line string) string {
    for _, secret := range s.secrets {
        line = strings.ReplaceAll(line, secret, "[REDACTED]")
    }
    return line
}
```

**Test file**: `internal/services/build/scrubber_test.go`

```
func TestScrubber_RedactsSecrets(t *testing.T)
    - Secrets: ["my-api-key-123", "database-password"].
    - Input: "Connecting to API with key my-api-key-123".
    - Assert: "Connecting to API with key [REDACTED]".

func TestScrubber_MultipleSecretsInOneLine(t *testing.T)
func TestScrubber_SkipsShortValues(t *testing.T)
    - Secret "ab" (2 chars) is NOT scrubbed (too short, too many false positives).

func TestScrubber_HandlesEmptySecrets(t *testing.T)
func TestScrubber_PreservesNonSecretLines(t *testing.T)
```

**Audit checklist for log statements**:

| Location | What to check |
|----------|--------------|
| `internal/services/auth/*.go` | Never log passwords, tokens, refresh tokens |
| `internal/services/github/*.go` | Never log installation tokens, PEM keys |
| `internal/platform/config/config.go` | Never log JWT_SECRET, ENCRYPTION_KEY, SMTP_PASS, GITHUB_APP_PEM |
| `internal/services/build/envvar_service.go` | Never log decrypted env var values |
| `internal/api/middleware/logger.go` | Strip Authorization header from logged requests |
| Error messages returned to API clients | Never include internal paths, DB errors, or stack traces |

---

### B4. HTTP Security Headers

**File**: `internal/api/middleware/security.go`

```go
func SecurityHeaders() echo.MiddlewareFunc {
    return func(next echo.HandlerFunc) echo.HandlerFunc {
        return func(c echo.Context) error {
            h := c.Response().Header()
            h.Set("Content-Security-Policy",
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "+
                "img-src 'self' data: https:; connect-src 'self'; font-src 'self'; "+
                "frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
            h.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload")
            h.Set("X-Frame-Options", "DENY")
            h.Set("X-Content-Type-Options", "nosniff")
            h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
            h.Set("Permissions-Policy",
                "camera=(), microphone=(), geolocation=(), payment=()")
            h.Set("X-XSS-Protection", "0") // Disabled, CSP is sufficient
            return next(c)
        }
    }
}
```

**Test file**: `internal/api/middleware/security_test.go`

```
func TestSecurityHeaders_AllPresent(t *testing.T)
    - Send a request through the middleware.
    - Assert ALL of the following headers are present:
      - Content-Security-Policy
      - Strict-Transport-Security
      - X-Frame-Options: DENY
      - X-Content-Type-Options: nosniff
      - Referrer-Policy
      - Permissions-Policy

func TestSecurityHeaders_CSPDirectives(t *testing.T)
    - Parse CSP header. Assert: default-src 'self', frame-ancestors 'none'.

func TestSecurityHeaders_HSTSMaxAge(t *testing.T)
    - Assert: max-age >= 63072000 (2 years).

func TestSecurityHeaders_APIResponsesIncludeHeaders(t *testing.T)
    - Integration test: hit /api/v1/health. Assert security headers present.

func TestSecurityHeaders_StaticFilesIncludeHeaders(t *testing.T)
    - Integration test: hit /. Assert security headers present on dashboard.
```

---

### B5. Rate Limiter Hardening

**File**: `internal/api/middleware/ratelimit_hardening_test.go`

```
func TestRateLimiter_UnderLoad(t *testing.T)
    - 50 concurrent goroutines, each sending 20 requests.
    - Assert: total allowed <= limit * number_of_unique_IPs.
    - Assert: no data races.

func TestRateLimiter_BurstHandling(t *testing.T)
    - Send burst of 100 requests in < 1ms.
    - Assert: only burst-size requests allowed, rest are 429.

func TestRateLimiter_StaleBucketCleanup(t *testing.T)
    - Create 10,000 buckets. Advance clock 15 minutes.
    - Trigger cleanup. Assert memory returned (bucket count < 100).

func TestRateLimiter_DifferentLimitsPerRoute(t *testing.T)
    - Auth route limit: 10/min. API route limit: 100/min.
    - Exhaust auth limit. Assert: API route still works.

func TestRateLimiter_IPExtraction(t *testing.T)
    - Test with X-Forwarded-For header. Assert: real client IP is used, not proxy IP.
    - Test with X-Real-IP header.
    - Test with no proxy headers (use RemoteAddr).
```

---

### B6. Auth Hardening

**File**: `internal/services/auth/auth_hardening_test.go`

```
func TestAuth_BcryptTimingSafe(t *testing.T)
    - bcrypt.CompareHashAndPassword is inherently timing-safe.
    - Document this in test as a verification checkpoint.

func TestAuth_ConstantTimeTokenComparison(t *testing.T)
    - Assert that refresh token lookup uses SHA-256 hash comparison.
    - The DB lookup (indexed by hash) already prevents timing attacks on the token itself.
    - Verify: subtle.ConstantTimeCompare is used if any in-memory comparison exists.

func TestAuth_PasswordMinimumRequirements(t *testing.T)
    - Assert: minimum 8 characters enforced.
    - Assert: maximum 72 characters (bcrypt limit) enforced.

func TestAuth_JWTClockSkewHandling(t *testing.T)
    - Generate token with server clock 30 seconds ahead.
    - Validate on server with "normal" clock. Assert: succeeds (leeway applied).
    - Generate token with clock 10 minutes ahead. Assert: fails (leeway exceeded).

func TestAuth_SessionLimitPerUser(t *testing.T)
    - Create 100 sessions for one user. Assert: oldest sessions are pruned
      (or a maximum is enforced, e.g., 10 active sessions per user).

func TestAuth_RefreshTokenRotation(t *testing.T)
    - Use refresh token. Assert: old token is invalidated, new one issued.
    - Try to use old token again. Assert: fails.
    - (Prevents refresh token replay attacks.)

func TestAuth_LoginDoesNotEnumerateEmails(t *testing.T)
    - Login with non-existent email: measure response time.
    - Login with existing email + wrong password: measure response time.
    - Assert: times are within 100ms of each other (bcrypt on both paths).
```

---

## Part C — Performance Optimization

### C1. SQLite Tuning

**File**: `internal/platform/database/sqlite.go` (modifications)

```go
func OpenDB(path string) (*sql.DB, error) {
    dsn := fmt.Sprintf("file:%s?_journal_mode=WAL&_busy_timeout=5000&_foreign_keys=ON&_synchronous=NORMAL&_cache_size=-20000", path)
    // _cache_size=-20000  → 20MB page cache (negative = KB, not pages)
    db, err := sql.Open("sqlite3", dsn)
    if err != nil {
        return nil, err
    }

    db.SetMaxOpenConns(1)
    db.SetMaxIdleConns(1)
    db.SetConnMaxLifetime(0)

    // Run PRAGMA optimize on startup (analyzes tables)
    db.Exec("PRAGMA optimize")

    return db, nil
}

// RunPeriodicOptimize should be called every 6 hours.
func RunPeriodicOptimize(db *sql.DB) {
    db.Exec("PRAGMA optimize")
}
```

**Index audit** (run `EXPLAIN QUERY PLAN` for each common query):

| Query | Expected Index | File |
|-------|---------------|------|
| `SELECT * FROM deployments WHERE project_id=? ORDER BY created_at DESC LIMIT ?` | `idx_deployments_project_id` or composite index | `deployment_repo.go` |
| `SELECT * FROM deployments WHERE project_id=? AND status IN ('queued','building')` | `idx_deployments_project_status` | `deployment_repo.go` |
| `SELECT * FROM deployments WHERE project_id=? AND branch=?` | `idx_deployments_project_branch` | `deployment_repo.go` |
| `SELECT * FROM sessions WHERE user_id=?` | `idx_sessions_user_id` | `session_repo.go` |
| `SELECT * FROM sessions WHERE expires_at < datetime('now')` | `idx_sessions_expires_at` | `session_repo.go` |
| `SELECT * FROM domains WHERE project_id=?` | `idx_domains_project_id` | `domain_repo.go` |
| `SELECT * FROM env_vars WHERE project_id=?` | `idx_env_vars_project_id` | `envvar_repo.go` |
| `SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?` | `idx_activity_log_created_at` | `activity_repo.go` |
| `SELECT * FROM projects WHERE github_repo=?` | `idx_projects_github_repo` | `project_repo.go` |
| `SELECT * FROM projects WHERE owner_id=?` | `idx_projects_owner_id` | `project_repo.go` |

**Benchmark file**: `internal/repository/bench_test.go`

```
func BenchmarkDeploymentList_100(b *testing.B)
    - 100 deployments in DB. Benchmark ListByProject.
    - Target: < 1ms per query.

func BenchmarkDeploymentList_10000(b *testing.B)
    - 10,000 deployments. Benchmark paginated list.
    - Target: < 5ms per query.

func BenchmarkProjectList_1000(b *testing.B)
    - 1,000 projects. Benchmark ListByOwner with pagination.

func BenchmarkConcurrentReadsAndWrite(b *testing.B)
    - 1 writer goroutine (inserts). 10 reader goroutines (selects).
    - Benchmark throughput.
```

**WAL size monitoring**: Add to health check endpoint.

```go
func GetWALSize(dbPath string) (int64, error) {
    info, err := os.Stat(dbPath + "-wal")
    if err != nil {
        return 0, nil // No WAL file = checkpoint already done
    }
    return info.Size(), nil
}
```

If WAL file exceeds 50MB, trigger a checkpoint:
```go
db.Exec("PRAGMA wal_checkpoint(TRUNCATE)")
```

---

### C2. Memory Profiling

**Target**: < 200MB idle (Go process + loaded caches)

**Profiling setup** in `cmd/api/main.go`:

```go
import _ "net/http/pprof"

// In main(), only in debug mode:
if config.Debug {
    go func() {
        log.Println("pprof listening on :6060")
        http.ListenAndServe("localhost:6060", nil)
    }()
}
```

**Test file**: `internal/api/memory_test.go`  
**Build tag**: `//go:build memory`

```
func TestMemory_IdleFootprint(t *testing.T)
    - Start the full application.
    - Take a heap profile after 5 seconds of idle.
    - Assert: HeapInuse < 200MB.

func TestMemory_SSESubscriberCleanup(t *testing.T)
    - Subscribe 100 SSE clients. Disconnect all. Wait 5 seconds.
    - Take heap profile. Assert: subscriber-related allocations are freed.
    - No goroutine leaks (runtime.NumGoroutine() returns to baseline).

func TestMemory_BuildContainerCleanup(t *testing.T)
    - Run 5 builds sequentially. After each, check memory.
    - Assert: memory does not monotonically increase (no leak).

func TestMemory_RateLimiterBucketCleanup(t *testing.T)
    - Create 10,000 rate limit buckets. Trigger cleanup.
    - Assert: buckets removed, memory reclaimed.
```

---

### C3. Build Performance

**Benchmark file**: `internal/worker/build_bench_test.go`  
**Build tag**: `//go:build docker`

```
func BenchmarkBuild_ViteColdCache(b *testing.B)
    - Clean cache. Build a small Vite project. Record time.
    - Baseline expectation: < 60 seconds.

func BenchmarkBuild_ViteWarmCache(b *testing.B)
    - Build once (warm cache). Benchmark subsequent builds.
    - Target: 2-5x faster than cold cache.

func TestBuild_CacheHitRate(t *testing.T)
    - Build project twice. Measure install time for both.
    - Assert: second install time < 50% of first (cache hit on node_modules).

func TestBuild_ShallowClone(t *testing.T)
    - Clone a large repo. Assert: --depth=1 --single-branch used.
    - Assert: .git directory is minimal.
```

**Optimization: pre-pull common images** (on Hostbox startup or install):

```go
func PrePullImages(ctx context.Context, docker *client.Client) {
    images := []string{
        "node:18-slim",
        "node:20-slim",
        "node:22-slim",
    }
    for _, img := range images {
        docker.ImagePull(ctx, img, image.PullOptions{})
    }
}
```

---

### C4. API Performance

**Benchmark file**: `internal/api/api_bench_test.go`

```
func BenchmarkAPI_HealthCheck(b *testing.B)
    - Target: < 1ms (no DB access).

func BenchmarkAPI_ListProjects(b *testing.B)
    - 50 projects in DB. Paginated list.
    - Target: < 50ms.

func BenchmarkAPI_ListDeployments(b *testing.B)
    - 100 deployments. Paginated list.
    - Target: < 50ms.

func BenchmarkAPI_CreateDeployment(b *testing.B)
    - Target: < 100ms (DB write + queue).

func BenchmarkAPI_GetDeployment(b *testing.B)
    - Target: < 20ms (single row read).

func BenchmarkAPI_JWTValidation(b *testing.B)
    - Benchmark HMAC-SHA256 JWT validation.
    - Target: < 0.1ms per validation.

func BenchmarkAPI_JSONSerialization(b *testing.B)
    - Serialize a deployment response (medium-sized struct).
    - Target: < 0.05ms.
```

---

## Part D — Docker Production Setup

### D1. Production Compose

**File**: `docker-compose.yml`

```yaml
version: "3.8"

services:
  hostbox:
    image: ghcr.io/hostbox/hostbox:latest
    container_name: hostbox
    restart: unless-stopped
    depends_on:
      caddy:
        condition: service_healthy
    volumes:
      - hostbox_data:/app/data
      - hostbox_deployments:/app/deployments
      - hostbox_logs:/app/logs
      - hostbox_cache:/cache
      - /var/run/docker.sock:/var/run/docker.sock:ro
    environment:
      - DATABASE_URL=file:/app/data/hostbox.db
      - JWT_SECRET=${JWT_SECRET}
      - ENCRYPTION_KEY=${ENCRYPTION_KEY}
      - PLATFORM_DOMAIN=${PLATFORM_DOMAIN}
      - PLATFORM_HTTPS=${PLATFORM_HTTPS:-true}
      - PLATFORM_NAME=${PLATFORM_NAME:-Hostbox}
      - GITHUB_APP_ID=${GITHUB_APP_ID}
      - GITHUB_APP_SLUG=${GITHUB_APP_SLUG}
      - GITHUB_APP_PEM=${GITHUB_APP_PEM}
      - GITHUB_WEBHOOK_SECRET=${GITHUB_WEBHOOK_SECRET}
      - SMTP_HOST=${SMTP_HOST:-}
      - SMTP_PORT=${SMTP_PORT:-587}
      - SMTP_USER=${SMTP_USER:-}
      - SMTP_PASS=${SMTP_PASS:-}
      - EMAIL_FROM=${EMAIL_FROM:-}
      - LOG_LEVEL=${LOG_LEVEL:-info}
      - CADDY_ADMIN_URL=http://caddy:2019
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:8080/api/v1/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: "1.0"
        reservations:
          memory: 128M
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

  caddy:
    image: ghcr.io/hostbox/caddy:latest
    container_name: hostbox-caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"  # HTTP/3
    volumes:
      - hostbox_deployments:/app/deployments:ro
      - caddy_data:/data
      - caddy_config:/config
    environment:
      - PLATFORM_DOMAIN=${PLATFORM_DOMAIN}
      - ACME_EMAIL=${ACME_EMAIL:-admin@${PLATFORM_DOMAIN}}
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:2019/config/"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 5s
    deploy:
      resources:
        limits:
          memory: 256M
          cpus: "0.5"
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  hostbox_data:
    driver: local
  hostbox_deployments:
    driver: local
  hostbox_logs:
    driver: local
  hostbox_cache:
    driver: local
  caddy_data:
    driver: local
  caddy_config:
    driver: local
```

**File**: `.env.production.example`

```bash
# ========================
# Hostbox Production Config
# ========================

# Platform
PLATFORM_DOMAIN=hostbox.example.com
PLATFORM_HTTPS=true
PLATFORM_NAME=Hostbox

# Security (REQUIRED — generate with: openssl rand -hex 32)
JWT_SECRET=
ENCRYPTION_KEY=

# GitHub App
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_APP_PEM=
GITHUB_WEBHOOK_SECRET=

# ACME / SSL
ACME_EMAIL=admin@example.com

# SMTP (optional — leave blank to skip email features)
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
EMAIL_FROM=

# Logging
LOG_LEVEL=info
```

---

### D2. Development Compose

**File**: `docker-compose.dev.yml`

```yaml
version: "3.8"

services:
  hostbox-api:
    build:
      context: .
      dockerfile: docker/Dockerfile.dev
    container_name: hostbox-api-dev
    volumes:
      - .:/app
      - go_mod_cache:/go/pkg/mod
      - go_build_cache:/root/.cache/go-build
      - /var/run/docker.sock:/var/run/docker.sock
    ports:
      - "8080:8080"   # API server
      - "6060:6060"   # pprof (debug)
      - "2345:2345"   # delve debugger
    environment:
      - DATABASE_URL=file:/app/data/dev.db
      - JWT_SECRET=dev-secret-change-me-in-production-please
      - ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000
      - PLATFORM_DOMAIN=localhost
      - PLATFORM_HTTPS=false
      - LOG_LEVEL=debug
      - CADDY_ADMIN_URL=http://caddy:2019
    command: >
      air -c .air.toml

  web:
    image: node:20-slim
    container_name: hostbox-web-dev
    working_dir: /app/web
    volumes:
      - ./web:/app/web
      - web_node_modules:/app/web/node_modules
    ports:
      - "3000:3000"
    command: >
      sh -c "npm install && npm run dev -- --host 0.0.0.0"
    environment:
      - VITE_API_URL=http://localhost:8080

  caddy:
    image: caddy:2-alpine
    container_name: hostbox-caddy-dev
    ports:
      - "80:80"
    volumes:
      - ./docker/caddy/Caddyfile.dev:/etc/caddy/Caddyfile
      - caddy_dev_data:/data
    depends_on:
      - hostbox-api
      - web

volumes:
  go_mod_cache:
  go_build_cache:
  web_node_modules:
  caddy_dev_data:
```

**File**: `docker/Dockerfile.dev`

```dockerfile
FROM golang:1.22-alpine

RUN apk add --no-cache git gcc musl-dev sqlite-dev

# Install Air for hot-reload
RUN go install github.com/air-verse/air@latest

# Install Delve for debugging
RUN go install github.com/go-delve/delve/cmd/dlv@latest

WORKDIR /app

# Pre-download Go modules
COPY go.mod go.sum ./
RUN go mod download

EXPOSE 8080 6060 2345
```

**File**: `.air.toml`

```toml
root = "."
tmp_dir = ".air"

[build]
  cmd = "go build -gcflags='all=-N -l' -o .air/hostbox ./cmd/api"
  bin = ".air/hostbox"
  full_bin = ".air/hostbox"
  include_ext = ["go", "tpl", "tmpl", "html", "sql"]
  exclude_dir = ["web", "node_modules", ".git", ".air", "docker"]
  delay = 1000

[log]
  time = false

[misc]
  clean_on_exit = true
```

---

### D3. Health Check Endpoint

**File**: `internal/api/handlers/health.go`

```go
type HealthResponse struct {
    Status  string       `json:"status"`           // "healthy" or "degraded"
    Version string       `json:"version"`
    Uptime  string       `json:"uptime"`
    Checks  HealthChecks `json:"checks"`
}

type HealthChecks struct {
    DB     HealthCheck `json:"db"`
    Docker HealthCheck `json:"docker"`
    Disk   DiskHealth  `json:"disk"`
}

type HealthCheck struct {
    Status  string `json:"status"`   // "ok" or "error"
    Latency string `json:"latency"`  // e.g., "2ms"
    Error   string `json:"error,omitempty"`
}

type DiskHealth struct {
    Status string `json:"status"`
    Used   string `json:"used"`     // e.g., "2.1GB"
    Free   string `json:"free"`     // e.g., "8.5GB"
    Total  string `json:"total"`    // e.g., "10GB"
}
```

**Handler logic**:

```go
func (h *HealthHandler) GetHealth(c echo.Context) error {
    resp := HealthResponse{
        Version: version.Version,
        Uptime:  time.Since(h.startTime).Round(time.Second).String(),
    }

    // 1. Check DB
    start := time.Now()
    err := h.db.PingContext(c.Request().Context())
    dbLatency := time.Since(start)
    if err != nil {
        resp.Checks.DB = HealthCheck{Status: "error", Latency: dbLatency.String(), Error: "connection failed"}
    } else {
        resp.Checks.DB = HealthCheck{Status: "ok", Latency: dbLatency.String()}
    }

    // 2. Check Docker
    start = time.Now()
    _, err = h.docker.Ping(c.Request().Context())
    dockerLatency := time.Since(start)
    if err != nil {
        resp.Checks.Docker = HealthCheck{Status: "error", Latency: dockerLatency.String(), Error: "connection failed"}
    } else {
        resp.Checks.Docker = HealthCheck{Status: "ok", Latency: dockerLatency.String()}
    }

    // 3. Check Disk
    used, free, total := getDiskUsage("/app")
    resp.Checks.Disk = DiskHealth{
        Status: diskStatus(free, total),
        Used:   humanize.Bytes(used),
        Free:   humanize.Bytes(free),
        Total:  humanize.Bytes(total),
    }

    // Determine overall status
    if resp.Checks.DB.Status == "ok" && resp.Checks.Docker.Status == "ok" {
        resp.Status = "healthy"
        return c.JSON(200, resp)
    }
    resp.Status = "degraded"
    return c.JSON(503, resp)
}
```

**Example response**:

```json
{
  "status": "healthy",
  "version": "1.0.0",
  "uptime": "2d3h15m",
  "checks": {
    "db": { "status": "ok", "latency": "1ms" },
    "docker": { "status": "ok", "latency": "5ms" },
    "disk": {
      "status": "ok",
      "used": "2.1 GB",
      "free": "8.5 GB",
      "total": "10 GB"
    }
  }
}
```

---

## Part E — Documentation

### E1. README.md

**File**: `README.md`

Sections:
1. **Hero**: Logo + tagline + badges (CI, release, license, Go version)
2. **Features**: Bullet list with emoji icons
3. **Quick Start**: 3-step install (one-liner + config + access dashboard)
4. **Screenshots**: Dashboard, deployment log, project settings (4 screenshots)
5. **Architecture**: Brief diagram (link to full ARCHITECTURE.md)
6. **Self-Hosting**: Link to SELF-HOSTING.md
7. **CLI**: Quick reference of common commands
8. **Contributing**: Link to CONTRIBUTING.md
9. **License**: MIT

### E2. docs/CONTRIBUTING.md

Sections:
1. **Development Setup**:
   - Prerequisites (Go 1.22+, Node 20+, Docker, SQLite)
   - Clone + `docker compose -f docker-compose.dev.yml up`
   - OR manual: `go run ./cmd/api` + `cd web && npm run dev`
2. **Code Structure**: Directory tree with descriptions
3. **Code Style**:
   - Go: `gofmt` + `golangci-lint` (config in `.golangci.yml`)
   - TypeScript: ESLint + Prettier (config in `web/.eslintrc`)
   - Commit messages: Conventional Commits (`feat:`, `fix:`, `docs:`, etc.)
4. **Testing**:
   - `go test ./...` (unit + service tests)
   - `go test -tags=integration ./...` (integration tests)
   - `go test -tags=docker ./...` (build pipeline tests — requires Docker)
   - `cd web && npm test` (frontend tests)
5. **PR Process**:
   - Fork → branch → commit → PR
   - All tests must pass
   - At least 1 approval required
6. **Release Process**: Tag-based via GitHub Actions

### E3. docs/SELF-HOSTING.md

Sections:
1. **Requirements**: VPS specs (512MB+ RAM, 10GB+ disk, Ubuntu 22.04+)
2. **DNS Setup**:
   - A record: `hostbox.example.com → VPS IP`
   - Wildcard: `*.hostbox.example.com → VPS IP`
   - Provider-specific guides: DigitalOcean, Cloudflare, Namecheap
3. **Firewall**: Ports 80, 443, 22 (ssh)
4. **Installation**: One-liner script or manual Docker Compose
5. **Configuration**: `.env` file reference with all variables
6. **GitHub App Setup**: Step-by-step with screenshots
7. **Updating**: `docker compose pull && docker compose up -d`
8. **Backup**: `docker exec hostbox hostbox backup`
9. **Troubleshooting**: Common issues and solutions
10. **Provider Guides**: DigitalOcean, Hetzner, Linode, Vultr, AWS Lightsail

### E4. In-Code Documentation

All exported functions, types, and interfaces must have godoc comments:

```go
// DeploymentService handles the lifecycle of deployments including creation,
// status transitions, cancellation, and rollbacks.
type DeploymentService struct { ... }

// Create creates a new deployment for the given project and branch.
// It handles deduplication by cancelling any existing queued or building
// deployment for the same project+branch combination.
// Returns the created deployment and any error encountered.
func (s *DeploymentService) Create(ctx context.Context, req CreateDeploymentRequest) (*Deployment, error) { ... }
```

**Verification**: Run `go doc ./...` and ensure no "missing comment" warnings.

---

## Part F — CI/CD (GitHub Actions)

### F1. Test Workflow

**File**: `.github/workflows/test.yml`

```yaml
name: Test

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

permissions:
  contents: read

jobs:
  go-test:
    name: Go Tests
    runs-on: ubuntu-latest
    strategy:
      matrix:
        go-version: ["1.22"]
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: ${{ matrix.go-version }}
          cache: true

      - name: Install dependencies
        run: go mod download

      - name: Run go vet
        run: go vet ./...

      - name: Install staticcheck
        run: go install honnef.co/go/tools/cmd/staticcheck@latest

      - name: Run staticcheck
        run: staticcheck ./...

      - name: Run unit tests
        run: go test -v -race -coverprofile=coverage-unit.out -covermode=atomic ./...
        env:
          CGO_ENABLED: 1

      - name: Run integration tests
        run: go test -v -race -tags=integration -coverprofile=coverage-integration.out -covermode=atomic ./...
        env:
          CGO_ENABLED: 1

      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          files: coverage-unit.out,coverage-integration.out
          fail_ci_if_error: false

      - name: Build binary
        run: go build -o hostbox ./cmd/api

      - name: Build CLI
        run: go build -o hostbox-cli ./cmd/cli

  go-lint:
    name: Go Lint
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: "1.22"
          cache: true

      - name: Run golangci-lint
        uses: golangci/golangci-lint-action@v4
        with:
          version: v1.57
          args: --timeout=5m

  frontend-test:
    name: Frontend Tests
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: web
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
          cache-dependency-path: web/package-lock.json

      - name: Install dependencies
        run: npm ci

      - name: Run linter
        run: npm run lint

      - name: Run type check
        run: npm run typecheck

      - name: Run tests
        run: npm test -- --coverage

      - name: Build
        run: npm run build

  docker-build:
    name: Docker Build Test
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build hostbox image
        uses: docker/build-push-action@v5
        with:
          context: .
          file: docker/Dockerfile
          push: false
          tags: hostbox/hostbox:test
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Build caddy image
        uses: docker/build-push-action@v5
        with:
          context: docker/caddy
          push: false
          tags: hostbox/caddy:test
```

---

### F2. Release Workflow

**File**: `.github/workflows/release.yml`

```yaml
name: Release

on:
  push:
    tags:
      - "v*"

permissions:
  contents: write
  packages: write

env:
  REGISTRY: ghcr.io
  IMAGE_NAME_HOSTBOX: ghcr.io/${{ github.repository_owner }}/hostbox
  IMAGE_NAME_CADDY: ghcr.io/${{ github.repository_owner }}/caddy

jobs:
  test:
    name: Run Tests
    uses: ./.github/workflows/test.yml

  build-binaries:
    name: Build Binaries
    runs-on: ubuntu-latest
    needs: test
    strategy:
      matrix:
        include:
          - goos: linux
            goarch: amd64
            suffix: linux-amd64
          - goos: linux
            goarch: arm64
            suffix: linux-arm64
          - goos: darwin
            goarch: amd64
            suffix: darwin-amd64
          - goos: darwin
            goarch: arm64
            suffix: darwin-arm64
          - goos: windows
            goarch: amd64
            suffix: windows-amd64.exe
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: "1.22"
          cache: true

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
          cache-dependency-path: web/package-lock.json

      - name: Build frontend
        working-directory: web
        run: |
          npm ci
          npm run build

      - name: Build API server binary
        env:
          GOOS: ${{ matrix.goos }}
          GOARCH: ${{ matrix.goarch }}
          CGO_ENABLED: 0
        run: |
          VERSION=${GITHUB_REF_NAME}
          go build -ldflags "-s -w -X main.version=${VERSION}" \
            -o hostbox-${{ matrix.suffix }} ./cmd/api

      - name: Build CLI binary
        env:
          GOOS: ${{ matrix.goos }}
          GOARCH: ${{ matrix.goarch }}
          CGO_ENABLED: 0
        run: |
          VERSION=${GITHUB_REF_NAME}
          go build -ldflags "-s -w -X main.version=${VERSION}" \
            -o hostbox-cli-${{ matrix.suffix }} ./cmd/cli

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: binaries-${{ matrix.suffix }}
          path: |
            hostbox-${{ matrix.suffix }}
            hostbox-cli-${{ matrix.suffix }}

  build-docker:
    name: Build & Push Docker Images
    runs-on: ubuntu-latest
    needs: test
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up QEMU
        uses: docker/setup-qemu-action@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract version metadata
        id: meta-hostbox
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.IMAGE_NAME_HOSTBOX }}
          tags: |
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=semver,pattern={{major}}
            type=raw,value=latest,enable={{is_default_branch}}

      - name: Build and push hostbox image
        uses: docker/build-push-action@v5
        with:
          context: .
          file: docker/Dockerfile
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta-hostbox.outputs.tags }}
          labels: ${{ steps.meta-hostbox.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Extract caddy metadata
        id: meta-caddy
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.IMAGE_NAME_CADDY }}
          tags: |
            type=semver,pattern={{version}}
            type=raw,value=latest,enable={{is_default_branch}}

      - name: Build and push caddy image
        uses: docker/build-push-action@v5
        with:
          context: docker/caddy
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta-caddy.outputs.tags }}
          labels: ${{ steps.meta-caddy.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  create-release:
    name: Create GitHub Release
    runs-on: ubuntu-latest
    needs: [build-binaries, build-docker]
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Download all artifacts
        uses: actions/download-artifact@v4
        with:
          path: dist
          merge-multiple: true

      - name: Generate changelog
        id: changelog
        run: |
          # Get the previous tag
          PREV_TAG=$(git tag --sort=-v:refname | head -2 | tail -1)
          CURRENT_TAG=${GITHUB_REF_NAME}

          echo "## What's Changed" > changelog.md
          echo "" >> changelog.md

          # Group commits by type
          echo "### 🚀 Features" >> changelog.md
          git log ${PREV_TAG}..${CURRENT_TAG} --pretty=format:"- %s (%h)" --grep="^feat" >> changelog.md || true
          echo "" >> changelog.md

          echo "### 🐛 Bug Fixes" >> changelog.md
          git log ${PREV_TAG}..${CURRENT_TAG} --pretty=format:"- %s (%h)" --grep="^fix" >> changelog.md || true
          echo "" >> changelog.md

          echo "### 📖 Documentation" >> changelog.md
          git log ${PREV_TAG}..${CURRENT_TAG} --pretty=format:"- %s (%h)" --grep="^docs" >> changelog.md || true
          echo "" >> changelog.md

          echo "### 🐳 Docker" >> changelog.md
          echo "\`\`\`bash" >> changelog.md
          echo "docker pull ${REGISTRY}/${IMAGE_NAME_HOSTBOX}:${CURRENT_TAG#v}" >> changelog.md
          echo "docker pull ${REGISTRY}/${IMAGE_NAME_CADDY}:${CURRENT_TAG#v}" >> changelog.md
          echo "\`\`\`" >> changelog.md
          echo "" >> changelog.md

          echo "### 📦 Binary Downloads" >> changelog.md
          echo "| Platform | Server | CLI |" >> changelog.md
          echo "|----------|--------|-----|" >> changelog.md
          echo "| Linux amd64 | \`hostbox-linux-amd64\` | \`hostbox-cli-linux-amd64\` |" >> changelog.md
          echo "| Linux arm64 | \`hostbox-linux-arm64\` | \`hostbox-cli-linux-arm64\` |" >> changelog.md
          echo "| macOS amd64 | \`hostbox-darwin-amd64\` | \`hostbox-cli-darwin-amd64\` |" >> changelog.md
          echo "| macOS arm64 | \`hostbox-darwin-arm64\` | \`hostbox-cli-darwin-arm64\` |" >> changelog.md
          echo "| Windows amd64 | \`hostbox-windows-amd64.exe\` | \`hostbox-cli-windows-amd64.exe\` |" >> changelog.md
        env:
          REGISTRY: ${{ env.REGISTRY }}
          IMAGE_NAME_HOSTBOX: ${{ env.IMAGE_NAME_HOSTBOX }}
          IMAGE_NAME_CADDY: ${{ env.IMAGE_NAME_CADDY }}

      - name: Create checksums
        run: |
          cd dist
          sha256sum hostbox-* hostbox-cli-* > checksums.txt

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          body_path: changelog.md
          files: |
            dist/hostbox-*
            dist/hostbox-cli-*
            dist/checksums.txt
          draft: false
          prerelease: ${{ contains(github.ref_name, '-rc') || contains(github.ref_name, '-beta') || contains(github.ref_name, '-alpha') }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

## Appendix: Test Coverage Targets

| Package | Target |
|---------|--------|
| `internal/platform/crypto` | 100% |
| `internal/platform/nanoid` | 100% |
| `internal/platform/config` | 90% |
| `internal/platform/caddy` | 85% |
| `internal/services/auth` | 90% |
| `internal/services/build` (detection, logger, scrubber) | 95% |
| `internal/services/deployment` | 85% |
| `internal/services/domain` | 85% |
| `internal/services/github` | 80% |
| `internal/services/project` | 85% |
| `internal/repository/*` | 90% |
| `internal/api/middleware` | 85% |
| `internal/api/handlers` | 75% (covered mostly by integration tests) |
| `web/src/lib` | 85% |
| `web/src/components` | 70% |
| **Overall Go** | **≥ 80%** |
| **Overall Frontend** | **≥ 75%** |

---

## Appendix: Performance Targets Summary

| Metric | Target |
|--------|--------|
| API read latency (p95) | < 50ms |
| API write latency (p95) | < 100ms |
| JWT validation | < 0.1ms |
| Health check | < 5ms |
| Idle memory (Go + SQLite) | < 200MB |
| Build (cold cache, small Vite app) | < 60s |
| Build (warm cache, small Vite app) | < 30s |
| SQLite query (paginated list, 10k rows) | < 5ms |
| SSE event delivery | < 10ms from Docker stdout to browser |
| Caddy config reload | < 100ms |
| Container startup | < 2s |
| Graceful shutdown | < 5s (60s with in-flight build) |

---

## Appendix: File Tree Summary

```
.github/
  workflows/
    test.yml                      # CI test pipeline
    release.yml                   # Release pipeline

docker/
  Dockerfile                      # Production multi-stage build
  Dockerfile.dev                  # Development with hot-reload
  caddy/
    Caddyfile                     # Base Caddy config
    Caddyfile.dev                 # Dev Caddy config
    Dockerfile                    # Custom Caddy with DNS modules

docker-compose.yml                # Production compose
docker-compose.dev.yml            # Development compose
.air.toml                         # Go hot-reload config
.env.production.example           # Production env template

internal/
  platform/
    crypto/
      encrypt_test.go
    nanoid/
      nanoid_test.go
    config/
      config_test.go
    caddy/
      config_test.go
    database/
      sqlite.go                   # SQLite tuning
    sanitize/
      sanitize.go                 # Input sanitization utilities
      sanitize_test.go

  repository/
    testutil_test.go              # Shared test DB helper
    user_repo_test.go
    session_repo_test.go
    project_repo_test.go
    deployment_repo_test.go
    domain_repo_test.go
    envvar_repo_test.go
    notification_repo_test.go
    activity_repo_test.go
    settings_repo_test.go
    crosscutting_test.go
    bench_test.go

  services/
    auth/
      auth_service_test.go
      auth_hardening_test.go
      jwt_test.go
    build/
      detect_test.go
      pkgmanager_test.go
      logger_test.go
      scrubber.go
      scrubber_test.go
      envvar_service_test.go
    deployment/
      deployment_service_test.go
      url_test.go
    domain/
      domain_service_test.go
      validate_test.go
    github/
      github_service_test.go
      webhook_test.go
      comment_test.go
    project/
      project_service_test.go
      slug_test.go

  api/
    handlers/
      health.go                   # Health check endpoint
    middleware/
      ratelimit_test.go
      ratelimit_hardening_test.go
      security.go                 # Security headers middleware
      security_test.go
    integration_test.go           # HTTP integration test helper
    auth_integration_test.go
    project_integration_test.go
    deployment_integration_test.go
    domain_integration_test.go
    envvar_integration_test.go
    ratelimit_integration_test.go
    cors_integration_test.go
    error_integration_test.go
    api_bench_test.go
    memory_test.go

  worker/
    build_pipeline_test.go
    build_bench_test.go
    container_security_test.go

web/
  vitest.config.ts
  src/
    test/
      setup.ts
    components/
      __tests__/
        DeploymentStatusBadge.test.tsx
        LogViewer.test.tsx
        EnvVarEditor.test.tsx
        DomainCard.test.tsx
        SetupWizard.test.tsx
    lib/
      __tests__/
        api.test.ts
        useLogStream.test.ts
        useAuth.test.ts

docs/
  ARCHITECTURE.md                 # (existing)
  CONTRIBUTING.md                 # New
  SELF-HOSTING.md                 # New
  PLAN-07-TESTING-AND-HARDENING.md  # This file
```
