# Part 7 — PostgreSQL Features for Production Systems

## Table of Contents

- [7.1 JSONB — The Document Store Inside Your Relational Database](#71-jsonb--the-document-store-inside-your-relational-database)
- [7.2 Full-Text Search — Search Without a Separate Service](#72-full-text-search--search-without-a-separate-service)
- [7.3 Arrays — When a Join Table Is Overkill](#73-arrays--when-a-join-table-is-overkill)
- [7.4 Generated Columns — Computed Values Done Right](#74-generated-columns--computed-values-done-right)
- [7.5 Partitioning — Scaling Tables to Billions of Rows](#75-partitioning--scaling-tables-to-billions-of-rows)
- [7.6 Triggers — Invisible Code Attached to Your Tables](#76-triggers--invisible-code-attached-to-your-tables)
- [7.7 Row Level Security (RLS) — Access Control in the Database](#77-row-level-security-rls--access-control-in-the-database)
- [7.8 LISTEN/NOTIFY — Real-Time Events from the Database](#78-listennotify--real-time-events-from-the-database)
- [7.9 Foreign Data Wrappers (FDW) — Querying Across Boundaries](#79-foreign-data-wrappers-fdw--querying-across-boundaries)
- [7.10 Logical Replication vs Physical Replication](#710-logical-replication-vs-physical-replication)
- [7.11 Extensions Ecosystem — Batteries Not Included, But Available](#711-extensions-ecosystem--batteries-not-included-but-available)
- [7.12 Things That Will Bite You in Production](#712-things-that-will-bite-you-in-production)

---

## 7.1 JSONB — The Document Store Inside Your Relational Database

### Concept

If you've worked with MongoDB or stored JSON in application code, you already understand the appeal of schema-flexible data. PostgreSQL's `jsonb` type gives you that flexibility _inside_ a relational database with full transactional guarantees, indexing, and the ability to join JSON data against relational tables.

There are two JSON types in PostgreSQL: `json` and `jsonb`. Forget `json` exists. The `json` type stores the raw text and re-parses it on every operation. `jsonb` stores a decomposed binary representation that supports indexing, is faster for all operators, and strips duplicate keys and insignificant whitespace. The only reason to use `json` is if you need to preserve exact formatting or key ordering — a requirement that virtually never matters in production.

Think of `jsonb` like this: if a relational column is a strongly-typed TypeScript interface, `jsonb` is a `Record<string, unknown>` — flexible but untyped at the database level. You gain schema flexibility but lose the database's ability to enforce constraints on the inner structure.

### Internals — Why JSONB Works This Way

Internally, `jsonb` is stored as a tree of key-value pairs in a binary format. Each value node has a type tag (string, number, boolean, null, object, array) and the keys in objects are sorted. This sorted key storage is why key lookups in `jsonb` objects are O(log n) rather than O(n) — PostgreSQL performs binary search on the keys.

The decomposed storage means that accessing a deeply nested path like `data->'address'->>'city'` doesn't require parsing the entire JSON document. PostgreSQL navigates directly to the requested node in the binary tree.

### All JSONB Operators

Here is the complete operator reference with real examples. Assume this table:

```sql
CREATE TABLE products (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        text NOT NULL,
    attributes  jsonb NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO products (name, attributes) VALUES
('Mechanical Keyboard', '{
    "brand": "Keychron",
    "model": "Q1 Pro",
    "switches": "Gateron Brown",
    "layout": "75%",
    "connectivity": ["bluetooth", "usb-c"],
    "features": {"hot_swap": true, "rgb": true, "knob": true},
    "weight_grams": 1700,
    "price": {"amount": 199.99, "currency": "USD"},
    "tags": ["mechanical", "wireless", "premium"]
}'),
('Webcam', '{
    "brand": "Logitech",
    "model": "C920",
    "resolution": "1080p",
    "features": {"autofocus": true, "stereo_mic": true},
    "connectivity": ["usb-a"],
    "price": {"amount": 69.99, "currency": "USD"},
    "tags": ["video", "streaming"]
}');
```

#### Arrow Operators: Navigating JSON

```sql
-- -> returns jsonb (keeps the JSON type, useful for chaining)
SELECT attributes->'brand' FROM products;
-- Result: "Keychron" (note: this is a jsonb string, with quotes)

-- ->> returns text (extracts as a plain text value)
SELECT attributes->>'brand' FROM products;
-- Result: Keychron (no quotes, this is a text value)

-- #> navigates a path, returns jsonb
SELECT attributes #> '{price,amount}' FROM products WHERE name = 'Mechanical Keyboard';
-- Result: 199.99 (as jsonb numeric)

-- #>> navigates a path, returns text
SELECT attributes #>> '{price,currency}' FROM products WHERE name = 'Mechanical Keyboard';
-- Result: USD (as text)

-- Array access by index (0-based)
SELECT attributes->'connectivity'->0 FROM products WHERE name = 'Mechanical Keyboard';
-- Result: "bluetooth"

SELECT attributes->'connectivity'->>0 FROM products WHERE name = 'Mechanical Keyboard';
-- Result: bluetooth
```

The difference between `->` and `->>` is the same as the difference between `JSON.parse(str)` and just using the string value in JavaScript. Use `->` when you need to chain further or compare against JSON values. Use `->>` when you need the final text value for display, comparison with text, or casting to other types.

#### Containment Operators: Does This JSON Contain That JSON?

```sql
-- @> "contains" — does the left side contain the right side?
SELECT * FROM products
WHERE attributes @> '{"brand": "Keychron"}';
-- Returns the keyboard row

-- Works with nested structures
SELECT * FROM products
WHERE attributes @> '{"features": {"hot_swap": true}}';
-- Returns products where features.hot_swap is true

-- Works with arrays — the array must contain all specified elements
SELECT * FROM products
WHERE attributes @> '{"tags": ["wireless"]}';
-- Returns the keyboard (its tags array contains "wireless")

-- <@ "is contained by" — is the left side contained within the right?
SELECT * FROM products
WHERE '{"brand": "Logitech"}'::jsonb <@ attributes;
-- Returns the webcam row
```

Containment is the most important operator for JSONB queries in production because it's the one that GIN indexes accelerate the most. When you write `WHERE attributes @> '{"brand": "Keychron"}'`, a GIN index can satisfy this without scanning the table.

#### Existence Operators: Do These Keys Exist?

```sql
-- ? checks if a top-level key exists
SELECT * FROM products WHERE attributes ? 'weight_grams';
-- Returns only the keyboard (webcam doesn't have weight_grams)

-- ?| checks if ANY of the specified keys exist
SELECT * FROM products WHERE attributes ?| array['weight_grams', 'resolution'];
-- Returns both products (keyboard has weight_grams, webcam has resolution)

-- ?& checks if ALL specified keys exist
SELECT * FROM products WHERE attributes ?& array['brand', 'model', 'connectivity'];
-- Returns both products (both have all three keys)
```

> **What a senior engineer actually thinks about:**
> The existence operators check top-level keys only. If you need to check for a nested key like `features.hot_swap`, use containment: `attributes @> '{"features": {"hot_swap": true}}'` or check the path: `attributes #> '{features,hot_swap}' IS NOT NULL`. This is a frequent source of confusion.

### JSONB Indexing Strategies

Without an index, every JSONB query does a sequential scan and decompresses every row's JSONB to evaluate the condition. Here are your indexing options:

#### GIN Default Operator Class

```sql
CREATE INDEX idx_products_attributes ON products USING gin (attributes);
```

This supports `@>`, `?`, `?|`, `?&` operators. It indexes every key and value at every nesting level. The index is comprehensive but can be large.

#### GIN jsonb_path_ops

```sql
CREATE INDEX idx_products_attributes_path ON products USING gin (attributes jsonb_path_ops);
```

This only supports the `@>` containment operator, but the index is significantly smaller (typically 2-3x smaller) and faster for containment queries. It hashes the full path to each value rather than indexing individual keys. Use this when your queries are predominantly containment checks.

#### Expression Indexes on Specific Keys

When you query a specific JSONB key repeatedly, a targeted B-tree index is smaller and faster than a GIN index:

```sql
-- B-tree index on a specific extracted value
CREATE INDEX idx_products_brand ON products ((attributes->>'brand'));

-- Now this query uses a standard B-tree index scan
SELECT * FROM products WHERE attributes->>'brand' = 'Keychron';

-- For numeric comparisons, cast the extracted value
CREATE INDEX idx_products_price ON products (((attributes #>> '{price,amount}')::numeric));

SELECT * FROM products
WHERE (attributes #>> '{price,amount}')::numeric < 100.00;
```

Expression indexes are the sweet spot when you have a semi-structured column but query specific paths consistently. They're as fast as indexing a regular column.

#### Concatenation and Merge Operator

```sql
-- || merges two JSONB objects (like Object.assign() or spread in JS)
SELECT '{"name": "Widget"}'::jsonb || '{"color": "red", "size": "large"}'::jsonb;
-- Result: {"name": "Widget", "color": "red", "size": "large"}

-- Right side wins on key conflicts (same as {...a, ...b} in JS)
SELECT '{"price": 10, "name": "Widget"}'::jsonb || '{"price": 15}'::jsonb;
-- Result: {"name": "Widget", "price": 15}

-- Useful for updating multiple keys at once (more ergonomic than nested jsonb_set)
UPDATE products
SET attributes = attributes || '{"on_sale": true, "discount_pct": 20}'::jsonb
WHERE name = 'Mechanical Keyboard';

-- WARNING: || does a shallow merge. Nested objects are replaced, not deep-merged
SELECT '{"features": {"rgb": true, "knob": true}}'::jsonb
    || '{"features": {"hot_swap": true}}'::jsonb;
-- Result: {"features": {"hot_swap": true}}
-- rgb and knob are GONE — the entire "features" key was replaced
-- For deep merges, use jsonb_set on specific paths or || with jsonb_set:
UPDATE products
SET attributes = jsonb_set(
    attributes,
    '{features}',
    attributes->'features' || '{"new_feature": true}'::jsonb
)
WHERE name = 'Mechanical Keyboard';
```

### JSONB Manipulation Functions

#### jsonb_set — Update a Value at a Path

```sql
-- Set a new value at an existing path
UPDATE products
SET attributes = jsonb_set(attributes, '{price,amount}', '179.99')
WHERE name = 'Mechanical Keyboard';

-- Set a value at a new path (create_if_missing defaults to true)
UPDATE products
SET attributes = jsonb_set(attributes, '{on_sale}', 'true')
WHERE name = 'Mechanical Keyboard';

-- Nested path creation — intermediate keys must exist
-- This FAILS if 'dimensions' key doesn't exist:
UPDATE products
SET attributes = jsonb_set(attributes, '{dimensions,width_mm}', '330')
WHERE name = 'Mechanical Keyboard';

-- You need to create the parent object first:
UPDATE products
SET attributes = jsonb_set(
    jsonb_set(attributes, '{dimensions}', '{}'),
    '{dimensions,width_mm}', '330'
)
WHERE name = 'Mechanical Keyboard';
```

#### jsonb_insert — Insert into Arrays

```sql
-- Append to a tags array
UPDATE products
SET attributes = jsonb_insert(
    attributes,
    '{tags, -1}',     -- -1 means after the last element
    '"hot-swappable"',
    true               -- insert after the specified position
)
WHERE name = 'Mechanical Keyboard';

-- Insert at position 0 (beginning of array)
UPDATE products
SET attributes = jsonb_insert(
    attributes,
    '{tags, 0}',
    '"featured"'
)
WHERE name = 'Mechanical Keyboard';
```

#### Removing Keys and Elements

```sql
-- Remove a top-level key with the - operator
UPDATE products
SET attributes = attributes - 'on_sale'
WHERE name = 'Mechanical Keyboard';

-- Remove a nested key with #-
UPDATE products
SET attributes = attributes #- '{features,rgb}'
WHERE name = 'Mechanical Keyboard';

-- Remove an array element by index
UPDATE products
SET attributes = attributes #- '{tags,0}'
WHERE name = 'Mechanical Keyboard';
```

#### Aggregation and Construction Functions

```sql
-- jsonb_agg: aggregate rows into a JSON array
SELECT jsonb_agg(
    jsonb_build_object(
        'id', id,
        'name', name,
        'brand', attributes->>'brand'
    )
) AS product_list
FROM products;
-- Result: [{"id": 1, "name": "Mechanical Keyboard", "brand": "Keychron"}, ...]

-- jsonb_build_object: construct JSON from key-value pairs
SELECT jsonb_build_object(
    'total_products', count(*),
    'brands', jsonb_agg(DISTINCT attributes->>'brand'),
    'generated_at', now()
) AS summary
FROM products;

-- jsonb_each: expand a JSON object into rows (key text, value jsonb)
SELECT key, value
FROM products,
     jsonb_each(attributes->'features')
WHERE name = 'Mechanical Keyboard';
-- Returns:
-- key       | value
-- hot_swap  | true
-- rgb       | true
-- knob      | true

-- jsonb_each_text: same but value is text instead of jsonb
SELECT key, value
FROM products,
     jsonb_each_text(attributes->'price')
WHERE name = 'Mechanical Keyboard';

-- jsonb_to_record: map JSONB to a row type
SELECT *
FROM products,
     jsonb_to_record(attributes->'price') AS price(amount numeric, currency text)
WHERE name = 'Mechanical Keyboard';
-- Now you can use price.amount and price.currency as regular columns
```

#### Array and Object Decomposition Functions

```sql
-- jsonb_array_elements: expand a JSON array into rows (returns jsonb)
-- Think of it as the JSONB equivalent of unnest() for arrays
SELECT jsonb_array_elements(attributes->'tags') AS tag
FROM products
WHERE name = 'Mechanical Keyboard';
-- Returns:
-- "mechanical"
-- "wireless"
-- "premium"

-- jsonb_array_elements_text: same, but returns text (no JSON quotes)
SELECT jsonb_array_elements_text(attributes->'tags') AS tag
FROM products
WHERE name = 'Mechanical Keyboard';
-- Returns:
-- mechanical
-- wireless
-- premium

-- Practical use: find products that have a specific tag (without GIN index)
SELECT DISTINCT p.name
FROM products p,
     jsonb_array_elements_text(p.attributes->'tags') AS tag
WHERE tag = 'wireless';

-- jsonb_object_keys: get all top-level keys of a JSON object
SELECT jsonb_object_keys(attributes) AS key
FROM products
WHERE name = 'Mechanical Keyboard';
-- Returns: brand, model, switches, layout, connectivity, features, ...

-- jsonb_typeof: returns the type of a JSONB value as text
SELECT
    jsonb_typeof(attributes->'brand') AS brand_type,         -- "string"
    jsonb_typeof(attributes->'weight_grams') AS weight_type, -- "number"
    jsonb_typeof(attributes->'tags') AS tags_type,           -- "array"
    jsonb_typeof(attributes->'features') AS features_type,   -- "object"
    jsonb_typeof(attributes->'features'->'rgb') AS rgb_type  -- "boolean"
FROM products
WHERE name = 'Mechanical Keyboard';

-- jsonb_strip_nulls: remove all keys with null values (recursively)
SELECT jsonb_strip_nulls('{"name": "Widget", "color": null, "meta": {"a": 1, "b": null}}'::jsonb);
-- Result: {"meta": {"a": 1}, "name": "Widget"}
-- Useful when building JSON responses where you want to omit unset fields

-- jsonb_pretty: format JSONB with indentation (for debugging and logging)
SELECT jsonb_pretty(attributes)
FROM products
WHERE name = 'Mechanical Keyboard';
-- Returns nicely indented JSON — never use in application queries,
-- only for debugging in psql or admin tools

-- jsonb_populate_record: map JSONB to a composite type (inverse of to_jsonb)
CREATE TYPE product_price AS (amount numeric, currency text);
SELECT (jsonb_populate_record(null::product_price, attributes->'price')).*
FROM products
WHERE name = 'Mechanical Keyboard';
-- Returns: amount = 199.99, currency = USD

-- jsonb_populate_recordset: same but for a JSON array of objects
SELECT *
FROM jsonb_populate_recordset(
    null::product_price,
    '[{"amount": 199.99, "currency": "USD"}, {"amount": 169.99, "currency": "EUR"}]'::jsonb
);
-- Returns two rows with the typed columns
```

### JSONPath Queries (PG 12+)

JSONPath is a standardized query language for JSON, similar to XPath for XML. PostgreSQL 12 introduced `jsonb_path_query`, `jsonb_path_exists`, `jsonb_path_match`, and the `@@` / `@?` operators.

```sql
-- Find products where price amount is less than 100
SELECT * FROM products
WHERE attributes @@ '$.price.amount < 100';

-- jsonb_path_query: extract values matching a path expression
SELECT jsonb_path_query(attributes, '$.tags[*]') AS tag
FROM products
WHERE name = 'Mechanical Keyboard';
-- Returns each tag as a separate row

-- jsonb_path_query_array: return all matches as an array
SELECT jsonb_path_query_array(attributes, '$.connectivity[*]') AS connections
FROM products;

-- jsonb_path_exists: check if a path expression matches anything
SELECT name, jsonb_path_exists(attributes, '$.features.hot_swap ? (@ == true)') AS is_hot_swap
FROM products;

-- Using variables in JSONPath
SELECT * FROM products
WHERE jsonb_path_exists(
    attributes,
    '$.price.amount ? (@ < $max_price)',
    '{"max_price": 150}'
);

-- Complex JSONPath with filters
SELECT jsonb_path_query(
    attributes,
    '$.tags[*] ? (@ starts with "wire")'
) FROM products WHERE name = 'Mechanical Keyboard';
-- Result: "wireless"
```

### When to Use JSONB vs Normalized Tables — Honest Tradeoffs

**Use JSONB when:**
- The schema varies significantly between rows (product attributes across categories)
- You're storing third-party webhook payloads or API responses that you don't control
- The data is read far more than queried/filtered (audit logs, event metadata)
- You need to prototype rapidly and schema will stabilize later
- The JSON structure is a natural document that's always read/written as a whole

**Use normalized tables when:**
- You query or filter on the fields regularly
- You need referential integrity (foreign keys)
- You need to enforce NOT NULL, CHECK, UNIQUE constraints on individual fields
- The data has a stable, known structure
- You need to aggregate on individual fields efficiently
- Multiple rows share the same sub-structure (normalization removes duplication)

**The hybrid approach (what most production systems do):**

```sql
CREATE TABLE orders (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         bigint NOT NULL REFERENCES users(id),
    status          text NOT NULL DEFAULT 'pending',
    total_cents     bigint NOT NULL,
    currency        text NOT NULL DEFAULT 'USD',
    -- Relational: queried, filtered, joined, constrained
    shipping_address_id bigint REFERENCES addresses(id),
    created_at      timestamptz NOT NULL DEFAULT now(),

    -- JSONB: flexible, varies by order, read as a blob
    metadata        jsonb NOT NULL DEFAULT '{}',
    -- Contains things like:
    -- {"source": "ios_app", "campaign": "summer_sale", "affiliate_code": "XYZ",
    --  "gift_message": "Happy Birthday!", "custom_fields": {...}}

    payment_details jsonb NOT NULL DEFAULT '{}',
    -- Contains gateway-specific response data that varies by provider
    -- {"stripe_payment_intent_id": "pi_...", "last4": "4242", ...}
    -- {"paypal_order_id": "...", "payer_email": "...", ...}

    line_items      jsonb NOT NULL
    -- Snapshot of items at time of order (prices may change later)
    -- [{"product_id": 1, "name": "...", "quantity": 2, "unit_price_cents": 1999}, ...]
);

-- Index the JSONB fields you actually query
CREATE INDEX idx_orders_metadata_source ON orders ((metadata->>'source'));
CREATE INDEX idx_orders_payment ON orders USING gin (payment_details jsonb_path_ops);
```

> **What a senior engineer actually thinks about:**
> The biggest JSONB mistake is storing data as JSONB "because it's easier" when it should be relational. Once you have 50 million rows and need to query `attributes->>'brand' = 'X'`, you'll wish you had a regular indexed column. The second biggest mistake is the opposite: creating 30 columns for flexible metadata when a single JSONB column with a GIN index would be cleaner. The right answer is usually a hybrid: relational for your core domain model, JSONB for the genuinely variable parts.

### Common Mistakes

1. **Using `json` instead of `jsonb`**: Always use `jsonb` unless you have a specific reason to preserve formatting.
2. **Forgetting to cast when comparing**: `attributes->>'price' > '9'` does text comparison, not numeric. Use `(attributes->>'price')::numeric > 9`.
3. **GIN index on the whole column when you only query one key**: An expression B-tree index on that key is smaller and faster.
4. **Deeply nesting critical data**: If you need to enforce constraints or join on a value, it belongs in a relational column.
5. **Not setting a DEFAULT**: JSONB columns without a default of `'{}'` or `'[]'` lead to NULL checks everywhere.

### Summary

JSONB gives you document-store flexibility with relational guarantees. Use `->` and `->>` for navigation, `@>` for containment queries backed by GIN indexes, expression indexes for frequently queried paths, and JSONPath for complex queries on PG 12+. Keep your core domain relational, put the genuinely flexible parts in JSONB, and index based on your actual query patterns.

---

## 7.2 Full-Text Search — Search Without a Separate Service

### Concept

Frontend developers are used to calling search APIs — Algolia, Elasticsearch, Typesense. PostgreSQL has a full-text search engine built in. It's not as feature-rich as dedicated search engines, but for many applications it's sufficient and eliminates an entire infrastructure dependency.

Full-text search is fundamentally different from `LIKE` or regex matching. When you search for "running shoes", a `LIKE '%running shoes%'` query requires the exact substring. Full-text search understands that "runs", "running", and "ran" are forms of the same lexeme "run". It tokenizes text, stems words, removes stop words, and matches against normalized representations.

Think of it like the difference between `string.includes(query)` and a proper search SDK in JavaScript — the latter understands tokens, relevance, and fuzzy matching.

### Internals: tsvector and tsquery

PostgreSQL full-text search revolves around two specialized types:

**tsvector** — A sorted list of distinct normalized words (lexemes) with optional position information. This is what your document is processed into.

```sql
SELECT to_tsvector('english', 'The quick brown foxes jumped over the lazy dogs');
-- Result: 'brown':3 'dog':9 'fox':4 'jump':5 'lazi':8 'quick':2
-- Note: "the" and "over" (stop words) are removed
-- "foxes" → "fox", "jumped" → "jump", "lazy" → "lazi" (stemming)
-- Numbers are word positions in the original text
```

**tsquery** — A search query with boolean operators. This is what the user's search input is processed into.

```sql
SELECT to_tsquery('english', 'quick & fox');
-- Result: 'quick' & 'fox'

SELECT to_tsquery('english', 'running | jogging');
-- Result: 'run' | 'jog'  (stemmed)

SELECT to_tsquery('english', '!slow & fox');
-- Result: !'slow' & 'fox'  (NOT slow AND fox)
```

The match operator is `@@`:

```sql
SELECT to_tsvector('english', 'The quick brown fox') @@ to_tsquery('english', 'quick & fox');
-- Result: true
```

### Query Construction Functions

PostgreSQL provides several functions to build tsquery from user input, each with different parsing rules:

```sql
-- to_tsquery: requires explicit operators, most control, fails on syntax errors
SELECT to_tsquery('english', 'web & (development | design)');
-- Result: 'web' & ( 'develop' | 'design' )

-- plainto_tsquery: treats input as space-separated words connected by AND
SELECT plainto_tsquery('english', 'web development best practices');
-- Result: 'web' & 'develop' & 'best' & 'practic'

-- phraseto_tsquery: words must appear in the given order, adjacent
SELECT phraseto_tsquery('english', 'web development');
-- Result: 'web' <-> 'develop'  (<-> is the "followed by" operator)

-- websearch_to_tsquery (PG 11+): Google-like syntax, most user-friendly
SELECT websearch_to_tsquery('english', '"web development" or design -graphic');
-- Result: 'web' <-> 'develop' | 'design' & !'graphic'
-- Supports: quoted phrases, OR, - for NOT
```

For any user-facing search box, `websearch_to_tsquery` is almost always the right choice. It handles the input syntax users expect without crashing on weird input.

### Ranking Functions

Finding matches isn't enough — you need to rank them by relevance.

```sql
-- ts_rank: ranks based on frequency of matching lexemes
-- ts_rank_cd: ranks based on cover density (how close together matches are)

SELECT
    title,
    ts_rank(search_vector, query) AS rank,
    ts_rank_cd(search_vector, query) AS rank_cd
FROM articles, websearch_to_tsquery('english', 'database performance') AS query
WHERE search_vector @@ query
ORDER BY rank DESC;
```

`ts_rank_cd` generally produces better results for longer documents because it considers the proximity of matched terms, not just their frequency. A document where "database" and "performance" appear in the same sentence ranks higher than one where they appear in different paragraphs.

### Highlighting with ts_headline

```sql
SELECT
    title,
    ts_headline(
        'english',
        body,
        websearch_to_tsquery('english', 'database indexing'),
        'StartSel=<mark>, StopSel=</mark>, MaxWords=50, MinWords=20, MaxFragments=3'
    ) AS snippet
FROM articles
WHERE search_vector @@ websearch_to_tsquery('english', 'database indexing')
ORDER BY ts_rank_cd(search_vector, websearch_to_tsquery('english', 'database indexing')) DESC
LIMIT 20;
```

This returns HTML fragments with matched terms wrapped in `<mark>` tags — exactly what you'd render in a search results page.

> **What a senior engineer actually thinks about:**
> `ts_headline` is expensive. It re-processes the original text on every call. Never call it on hundreds of rows. Always `LIMIT` your results first, then apply `ts_headline` only to the rows you'll actually display. A subquery or CTE that filters and limits first, then headlines, is the standard pattern.

### Weights: A, B, C, D

You can assign weights to different parts of a document to influence ranking. Weight A is the highest, D is the lowest.

```sql
-- Assign different weights to title vs body
ALTER TABLE articles ADD COLUMN search_vector tsvector;

UPDATE articles SET search_vector =
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(subtitle, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(tags_text, '')), 'B');

-- The rank function respects weights: matches in the title rank higher
SELECT title, ts_rank(search_vector, query) AS rank
FROM articles, websearch_to_tsquery('english', 'postgres replication') AS query
WHERE search_vector @@ query
ORDER BY rank DESC;

-- You can customize the weight values (default: {0.1, 0.2, 0.4, 1.0} for D,C,B,A)
SELECT title, ts_rank('{0.05, 0.1, 0.5, 1.0}', search_vector, query) AS rank
FROM articles, websearch_to_tsquery('english', 'postgres replication') AS query
WHERE search_vector @@ query
ORDER BY rank DESC;
```

### Dictionaries and Configurations

A text search configuration defines how text is processed: which parser breaks text into tokens, which dictionaries process each token type. The `english` configuration stems English words and removes English stop words. PostgreSQL ships with configurations for many languages.

```sql
-- List available configurations
SELECT cfgname FROM pg_ts_config;

-- See what a configuration does to text
SELECT * FROM ts_debug('english', 'The PostgreSQL database is extremely fast');
-- Shows each token, its type, which dictionaries processed it, and the result

-- Using a different language
SELECT to_tsvector('french', 'Les bases de données sont rapides');
-- Result: 'bas':2 'donné':4 'rapid':6
```

### GIN Index for Full-Text Search

Without an index, the `@@` operator does a sequential scan, calling `to_tsvector()` on every row. That's unacceptable for any real dataset.

```sql
-- Index on a stored tsvector column (preferred approach)
CREATE INDEX idx_articles_search ON articles USING gin (search_vector);

-- Index using an expression (no stored column needed, but slower updates)
CREATE INDEX idx_articles_search_expr ON articles
    USING gin (to_tsvector('english', title || ' ' || body));
```

The stored column approach is preferred because: (1) the tsvector is computed once on write rather than on every index update, (2) you can use weights, and (3) you keep the search vector in sync with a trigger.

### Complete Search Implementation

Here's a production-ready search implementation:

```sql
-- Schema
CREATE TABLE articles (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title           text NOT NULL,
    subtitle        text,
    body            text NOT NULL,
    author_id       bigint NOT NULL REFERENCES users(id),
    published_at    timestamptz,
    status          text NOT NULL DEFAULT 'draft',
    tags            text[] NOT NULL DEFAULT '{}',
    search_vector   tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(subtitle, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(body, '')), 'C')
    ) STORED  -- PG 12+ generated column
);

CREATE INDEX idx_articles_search ON articles USING gin (search_vector);
CREATE INDEX idx_articles_published ON articles (published_at DESC) WHERE status = 'published';

-- Search function returning paginated, ranked results with snippets
CREATE OR REPLACE FUNCTION search_articles(
    search_query text,
    page_num integer DEFAULT 1,
    page_size integer DEFAULT 20
)
RETURNS TABLE (
    id bigint,
    title text,
    subtitle text,
    snippet text,
    author_id bigint,
    published_at timestamptz,
    rank real,
    total_count bigint
)
LANGUAGE sql STABLE
AS $$
    WITH query AS (
        SELECT websearch_to_tsquery('english', search_query) AS q
    ),
    ranked AS (
        SELECT
            a.id,
            a.title,
            a.subtitle,
            a.body,
            a.author_id,
            a.published_at,
            ts_rank_cd(a.search_vector, q.q) AS rank,
            count(*) OVER () AS total_count
        FROM articles a, query q
        WHERE a.status = 'published'
          AND a.search_vector @@ q.q
        ORDER BY rank DESC, a.published_at DESC
        LIMIT page_size
        OFFSET (page_num - 1) * page_size
    )
    SELECT
        r.id,
        r.title,
        r.subtitle,
        ts_headline(
            'english', r.body, q.q,
            'StartSel=<mark>, StopSel=</mark>, MaxWords=40, MinWords=15, MaxFragments=2'
        ) AS snippet,
        r.author_id,
        r.published_at,
        r.rank,
        r.total_count
    FROM ranked r, query q;
$$;

-- Usage
SELECT * FROM search_articles('postgres full text search', 1, 10);
```

### PostgreSQL FTS vs Elasticsearch/Typesense

| Aspect | PostgreSQL FTS | Elasticsearch/Typesense |
|---|---|---|
| **Setup complexity** | Zero — it's built in | Separate cluster to deploy, monitor, secure |
| **Data consistency** | Transactional — search is always in sync | Eventual consistency, needs sync pipeline |
| **Relevance tuning** | Weights, ranking functions, limited | Extensive: BM25, custom scorers, synonyms, ML |
| **Typo tolerance** | Requires pg_trgm extension | Built in |
| **Faceted search** | Manual with aggregation queries | Built-in facet APIs |
| **Autocomplete** | Possible with pg_trgm, limited | Excellent, built-in suggest APIs |
| **Scale** | Good to ~10M documents per table | Designed for billions of documents |
| **Operational cost** | None beyond your existing database | Significant (memory-hungry, cluster management) |

**Use PostgreSQL FTS when:** your dataset is under 10M rows, your search requirements are straightforward (keyword search with ranking), and you don't need typo tolerance or faceted search. This covers the majority of SaaS applications.

**Use Elasticsearch/Typesense when:** you need autocomplete, typo tolerance, faceted search, or you're searching across hundreds of millions of documents. But even then, consider using PG FTS for admin/internal search and the dedicated engine only for user-facing search.

### Common Mistakes

1. **Not storing the tsvector**: Recomputing `to_tsvector()` on every query is expensive. Use a stored generated column or a trigger.
2. **Using `plainto_tsquery` for user-facing search**: Use `websearch_to_tsquery` — it handles quotes, OR, and negation naturally.
3. **Applying `ts_headline` before LIMIT**: Headline generation is expensive. Filter and limit first, then highlight.
4. **Ignoring language configuration**: The default `'english'` stems and removes stop words for English. If your content is multilingual, you need a strategy (multiple columns, language detection, or the `simple` configuration which does no stemming).
5. **Forgetting that FTS doesn't handle typos**: "postgre" won't match "postgresql". Combine with `pg_trgm` for fuzzy matching (see section 7.11).

### Summary

PostgreSQL full-text search gives you stemming, ranking, highlighting, and boolean queries with a GIN index. Use `websearch_to_tsquery` for user input, store your tsvector as a generated column, assign weights to prioritize titles over body text, and always LIMIT before applying `ts_headline`. For most applications under 10M rows, this eliminates the need for a separate search service.

---

## 7.3 Arrays — When a Join Table Is Overkill

### Concept

PostgreSQL supports array columns — a single column that stores an ordered list of values of the same type. If you're a JavaScript developer, think of it as storing an actual `string[]` or `number[]` directly in a database column.

In traditional relational modeling, a many-to-many relationship requires a join table. Tags on a blog post? Create a `tags` table and a `post_tags` join table. But sometimes that's overkill. If you have a short list of values that you write as a unit and query with simple containment checks, arrays are simpler, faster, and easier to reason about.

### Array Type Syntax

```sql
-- Declaring array columns
CREATE TABLE events (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        text NOT NULL,
    tags        text[] NOT NULL DEFAULT '{}',
    scores      integer[],
    schedule    timestamptz[] NOT NULL DEFAULT '{}',
    metadata    text[][] -- multidimensional arrays are supported but rarely useful
);

-- Array literals
INSERT INTO events (name, tags, scores, schedule) VALUES
(
    'Tech Conference',
    ARRAY['tech', 'networking', 'startup'],      -- ARRAY constructor syntax
    '{85, 92, 78, 95}',                           -- String literal syntax
    ARRAY['2025-03-01 09:00:00+00'::timestamptz, '2025-03-02 09:00:00+00'::timestamptz]
),
(
    'Workshop',
    '{"coding", "hands-on", "beginner"}',
    ARRAY[90, 88],
    ARRAY['2025-04-15 10:00:00+00'::timestamptz]
);
```

### Array Operators

```sql
-- ANY: does any element match? (like .some() in JS)
SELECT * FROM events WHERE 'tech' = ANY(tags);
-- Returns events where 'tech' is in the tags array

-- ALL: do all elements match? (like .every() in JS)
SELECT * FROM events WHERE 80 < ALL(scores);
-- Returns events where every score is above 80

-- @> contains: does the left array contain all elements of the right array?
SELECT * FROM events WHERE tags @> ARRAY['tech', 'networking'];
-- Returns events tagged with both 'tech' AND 'networking'

-- <@ is contained by: is the left array a subset of the right?
SELECT * FROM events WHERE tags <@ ARRAY['tech', 'networking', 'startup', 'enterprise'];
-- Returns events whose tags are all within this set

-- && overlap: do the arrays share any elements? (like intersection check)
SELECT * FROM events WHERE tags && ARRAY['beginner', 'startup'];
-- Returns events tagged with 'beginner' OR 'startup'

-- || concatenation: combine arrays
SELECT tags || ARRAY['featured'] FROM events WHERE name = 'Tech Conference';
-- Result: {tech,networking,startup,featured}
```

### Array Functions

```sql
-- array_agg: aggregate column values into an array (the inverse of unnest)
SELECT author_id, array_agg(title ORDER BY published_at DESC) AS recent_titles
FROM articles
WHERE published_at > now() - interval '30 days'
GROUP BY author_id;

-- unnest: expand an array into rows (the inverse of array_agg)
SELECT id, name, unnest(tags) AS tag
FROM events;
-- Returns one row per tag per event:
-- 1 | Tech Conference | tech
-- 1 | Tech Conference | networking
-- 1 | Tech Conference | startup
-- 2 | Workshop        | coding
-- ...

-- array_position: find the index of a value (1-based, like indexOf + 1)
SELECT array_position(ARRAY['a','b','c','d'], 'c');
-- Result: 3

-- array_remove: remove all occurrences of a value
SELECT array_remove(ARRAY[1,2,3,2,1], 2);
-- Result: {1,3,1}

-- array_cat: concatenate two arrays (same as ||)
SELECT array_cat(ARRAY[1,2], ARRAY[3,4]);
-- Result: {1,2,3,4}

-- array_length: get the length of a dimension
SELECT array_length(ARRAY['a','b','c'], 1);
-- Result: 3 (the 1 specifies the first dimension)

-- cardinality: total number of elements across all dimensions
SELECT cardinality(ARRAY['a','b','c']);
-- Result: 3

-- array_to_string / string_to_array: conversion
SELECT array_to_string(ARRAY['a','b','c'], ', ');
-- Result: 'a, b, c'

SELECT string_to_array('a, b, c', ', ');
-- Result: {a,b,c}
```

### GIN Indexes on Arrays

```sql
-- GIN index supports @>, <@, &&, = operators
CREATE INDEX idx_events_tags ON events USING gin (tags);

-- Now these queries use the index:
SELECT * FROM events WHERE tags @> ARRAY['tech'];      -- contains
SELECT * FROM events WHERE tags && ARRAY['tech', 'ai']; -- overlap
```

Without this index, array containment and overlap checks require scanning and decompressing every row. With it, PostgreSQL uses the GIN index to find only matching rows.

### Real Use Cases Where Arrays Beat Join Tables

**Tagging system:**

```sql
-- With a join table: 3 tables, 2 joins
CREATE TABLE tags (id serial PRIMARY KEY, name text UNIQUE NOT NULL);
CREATE TABLE post_tags (post_id bigint REFERENCES posts, tag_id bigint REFERENCES tags);
-- Query: find posts with tags 'tech' AND 'postgres'
SELECT p.* FROM posts p
JOIN post_tags pt1 ON p.id = pt1.post_id
JOIN tags t1 ON pt1.tag_id = t1.id AND t1.name = 'tech'
JOIN post_tags pt2 ON p.id = pt2.post_id
JOIN tags t2 ON pt2.tag_id = t2.id AND t2.name = 'postgres';

-- With arrays: 1 table, no joins
CREATE TABLE posts (id bigint PRIMARY KEY, title text, tags text[]);
CREATE INDEX idx_posts_tags ON posts USING gin (tags);
SELECT * FROM posts WHERE tags @> ARRAY['tech', 'postgres'];
```

The array approach is dramatically simpler and faster when: (1) tags are simple strings without metadata, (2) the tag list per row is small (under ~100), and (3) you don't need to query "all posts for a given tag" as your primary access pattern (though GIN handles this fine too).

**Permission lists:**

```sql
CREATE TABLE documents (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title           text NOT NULL,
    owner_id        bigint NOT NULL REFERENCES users(id),
    viewer_ids      bigint[] NOT NULL DEFAULT '{}',
    editor_ids      bigint[] NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_docs_viewers ON documents USING gin (viewer_ids);
CREATE INDEX idx_docs_editors ON documents USING gin (editor_ids);

-- Find all documents a user can view
SELECT * FROM documents
WHERE owner_id = 42 OR 42 = ANY(viewer_ids) OR 42 = ANY(editor_ids);

-- Add a viewer
UPDATE documents
SET viewer_ids = array_append(viewer_ids, 99)
WHERE id = 1 AND NOT (99 = ANY(viewer_ids));

-- Remove a viewer
UPDATE documents
SET viewer_ids = array_remove(viewer_ids, 99)
WHERE id = 1;
```

### Gotchas with NULL in Arrays

```sql
-- NULL in an array is NOT equal to NULL (just like JS: [null].includes(null) is true, but SQL disagrees)
SELECT NULL = ANY(ARRAY[1, 2, NULL]);
-- Result: NULL (not true, not false — NULL)

-- This means WHERE col = ANY(array_with_nulls) can silently miss rows
SELECT ARRAY[1, NULL, 3] @> ARRAY[NULL];
-- Result: true (containment works differently — it treats NULL as a value)

-- array_remove does NOT remove NULLs
SELECT array_remove(ARRAY[1, NULL, 3], NULL);
-- Result: {1,NULL,3} — NULL cannot be matched with =

-- To remove NULLs, use:
SELECT array_agg(x) FROM unnest(ARRAY[1, NULL, 3]) AS x WHERE x IS NOT NULL;
-- Result: {1,3}
```

> **What a senior engineer actually thinks about:**
> Don't put NULLs in arrays. It's a source of bugs that's hard to debug. Use a DEFAULT of `'{}'` (empty array) instead of allowing NULL arrays, and never store NULL as an array element. If "no value" is meaningful, represent it differently.

### Common Mistakes

1. **Arrays that grow unbounded**: If your array can grow to thousands of elements, you should use a join table. Arrays are best for short, bounded lists.
2. **Thinking `= ANY` works with NULLs**: `NULL = ANY(arr)` returns NULL, not true.
3. **Updating single elements by index**: `UPDATE t SET arr[3] = 'x'` works but is index-based and fragile. Prefer `array_remove` + `array_append` or `array_replace`.
4. **No GIN index**: Without `CREATE INDEX ... USING gin (column)`, the `@>`, `<@`, and `&&` operators cannot use an index.
5. **Using arrays for data with its own attributes**: If each tag needs a color, a description, a created_at, it belongs in a table, not an array.

### Summary

Arrays are ideal for short, homogeneous lists where the items have no attributes of their own: tags, feature flags, permission IDs, category lists. Combine them with GIN indexes for fast containment and overlap queries. Keep them short, avoid NULLs, and reach for a join table when the list grows unbounded or items need their own metadata.

---

## 7.4 Generated Columns — Computed Values Done Right

### Concept

A generated column is a column whose value is automatically computed from other columns in the same row. If you've used computed properties in Vue or derived state in React (`useMemo`), it's the same idea: a value that's always derived from source data.

PostgreSQL 12 introduced `GENERATED ALWAYS AS ... STORED` columns. The value is computed on INSERT and UPDATE and physically stored on disk, just like a regular column. You never set it directly.

### Syntax and Usage

```sql
CREATE TABLE products (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name            text NOT NULL,
    price_cents     integer NOT NULL,
    tax_rate        numeric(5,4) NOT NULL DEFAULT 0.0825,
    total_cents     integer GENERATED ALWAYS AS (
        price_cents + (price_cents * tax_rate)::integer
    ) STORED,
    first_name      text NOT NULL,
    last_name       text NOT NULL,
    full_name       text GENERATED ALWAYS AS (first_name || ' ' || last_name) STORED,
    search_vector   tsvector GENERATED ALWAYS AS (
        to_tsvector('english', coalesce(name, ''))
    ) STORED
);

-- Insert — you cannot specify generated columns
INSERT INTO products (name, price_cents, tax_rate, first_name, last_name)
VALUES ('Widget', 1999, 0.0825, 'Jane', 'Smith');

-- The generated columns are computed automatically:
SELECT name, price_cents, total_cents, full_name FROM products;
-- Widget | 1999 | 2164 | Jane Smith

-- Update — changing source columns recomputes generated columns
UPDATE products SET price_cents = 2499 WHERE name = 'Widget';
-- total_cents is automatically recalculated
```

### Real Use Cases

**Materialized search vectors** (shown above) — the most common use case. Instead of a trigger to maintain a `tsvector` column, use a generated column.

**Denormalized display values:**

```sql
CREATE TABLE addresses (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    street      text NOT NULL,
    city        text NOT NULL,
    state       text NOT NULL,
    zip         text NOT NULL,
    full_address text GENERATED ALWAYS AS (
        street || ', ' || city || ', ' || state || ' ' || zip
    ) STORED
);
```

**Computed flags for filtering:**

```sql
CREATE TABLE inventory (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id      bigint NOT NULL REFERENCES products(id),
    quantity         integer NOT NULL DEFAULT 0,
    reorder_point    integer NOT NULL DEFAULT 10,
    is_low_stock     boolean GENERATED ALWAYS AS (quantity <= reorder_point) STORED
);

CREATE INDEX idx_inventory_low_stock ON inventory (product_id) WHERE is_low_stock;
-- Partial index on the generated column — efficient query for "show me low stock items"
```

### Limitations

Generated columns in PostgreSQL have strict constraints:

1. **STORED only**: PostgreSQL does not support `VIRTUAL` generated columns (computed on read, not stored). MySQL supports both. Virtual generated columns are being discussed for future PostgreSQL versions but as of PG 16, only STORED is available.
2. **No subqueries**: The expression cannot reference other tables or use subqueries.
3. **No cross-column-set references**: Can only reference columns in the same table.
4. **No other generated columns**: A generated column cannot reference another generated column.
5. **Immutable functions only**: The expression must be immutable — `now()` is not allowed because it returns different values at different times.
6. **No DEFAULT on generated columns**: The generation expression is the default.
7. **Cannot INSERT or UPDATE directly**: You get an error if you try.

```sql
-- These all FAIL:
CREATE TABLE bad (
    id bigint PRIMARY KEY,
    user_id bigint,
    -- Cannot use subqueries:
    user_name text GENERATED ALWAYS AS (
        (SELECT name FROM users WHERE id = user_id)
    ) STORED,
    -- Cannot use volatile functions:
    cached_at timestamptz GENERATED ALWAYS AS (now()) STORED
);
```

### Virtual Generated Columns Status

As of PostgreSQL 16, virtual generated columns (which compute on read and don't store data) are not supported. There are active patches and discussion on the PostgreSQL mailing lists. If you need a computed value that doesn't take disk space, use a view or a function:

```sql
-- View approach
CREATE VIEW products_with_total AS
SELECT *, price_cents + (price_cents * tax_rate)::integer AS total_cents
FROM products;

-- Function approach for single-row use
CREATE FUNCTION get_total(p products) RETURNS integer
LANGUAGE sql IMMUTABLE AS $$
    SELECT p.price_cents + (p.price_cents * p.tax_rate)::integer;
$$;

-- Then use: SELECT p.id, p.name, p.get_total FROM products p;
```

> **What a senior engineer actually thinks about:**
> Generated columns replaced a huge chunk of trigger usage. Before PG 12, keeping a `tsvector` column in sync required a trigger. Now it's a one-liner in the `CREATE TABLE`. Anywhere you had a trigger that just computes a column value from other columns in the same row, a generated column is cleaner, less error-prone, and more self-documenting.

### Common Mistakes

1. **Trying to use `now()` or `random()`**: Only immutable expressions are allowed.
2. **Expecting virtual columns**: There's no `VIRTUAL` keyword — everything is `STORED`.
3. **Forgetting generated columns increase row size**: The value is stored on disk, so storage cost is real.
4. **Not indexing generated columns**: Generated columns can be indexed just like regular columns — take advantage of this.

### Summary

Generated columns (PG 12+) automatically compute and store a value derived from other columns in the same row. They're ideal for search vectors, computed display fields, and boolean flags. The expression must be immutable with no subqueries or cross-table references. They replace many trigger-based patterns with a cleaner, declarative approach.

---

## 7.5 Partitioning — Scaling Tables to Billions of Rows

### Concept

Partitioning splits one large logical table into multiple smaller physical tables. Each partition stores a subset of the rows based on a partition key. To the application, it looks like a single table — queries, inserts, and indexes all work transparently. Under the hood, PostgreSQL routes operations to the appropriate partition.

Think of it like code-splitting in a frontend app. You have one logical "app" but the bundler splits it into chunks that load independently. Partitioning splits one logical table into chunks that PostgreSQL can read, write, and maintain independently.

The primary benefit is **partition pruning**: when your WHERE clause matches the partition key, PostgreSQL skips partitions that can't contain matching rows. A query for "January 2025 data" only reads the January 2025 partition, not the entire table spanning years of data.

### When to Partition

Partitioning has overhead and complexity. Don't partition a table with 10 million rows. Consider partitioning when:

- The table has hundreds of millions or billions of rows
- Queries almost always filter on a predictable column (date, tenant_id, region)
- You need to efficiently drop old data (dropping a partition is instantaneous vs DELETE on millions of rows)
- Maintenance operations (VACUUM, reindex) take too long on the full table
- You need to move old data to cheaper storage

### Declarative Partitioning (PG 10+)

PostgreSQL 10 introduced declarative partitioning. Before that, partitioning required manual inheritance and triggers — don't use the old way.

#### Range Partitioning

The most common strategy. Rows are routed to partitions based on value ranges.

```sql
CREATE TABLE sensor_readings (
    id              bigint GENERATED ALWAYS AS IDENTITY,
    sensor_id       integer NOT NULL,
    reading_value   double precision NOT NULL,
    recorded_at     timestamptz NOT NULL,
    metadata        jsonb DEFAULT '{}'
) PARTITION BY RANGE (recorded_at);

-- Create partitions for each month
CREATE TABLE sensor_readings_2025_01
    PARTITION OF sensor_readings
    FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');

CREATE TABLE sensor_readings_2025_02
    PARTITION OF sensor_readings
    FOR VALUES FROM ('2025-02-01') TO ('2025-03-01');

CREATE TABLE sensor_readings_2025_03
    PARTITION OF sensor_readings
    FOR VALUES FROM ('2025-03-01') TO ('2025-04-01');

-- Default partition catches everything that doesn't match a named partition
CREATE TABLE sensor_readings_default
    PARTITION OF sensor_readings DEFAULT;

-- Indexes are defined on the parent and automatically created on each partition
CREATE INDEX idx_sensor_readings_sensor ON sensor_readings (sensor_id, recorded_at);
CREATE INDEX idx_sensor_readings_time ON sensor_readings (recorded_at);
```

**Partition pruning in action:**

```sql
-- This only scans the January 2025 partition
EXPLAIN SELECT * FROM sensor_readings
WHERE recorded_at >= '2025-01-15' AND recorded_at < '2025-02-01';

-- Output shows:
-- Append
--   -> Index Scan using sensor_readings_2025_01_recorded_at_idx on sensor_readings_2025_01
--        Index Cond: (recorded_at >= '2025-01-15' AND recorded_at < '2025-02-01')
-- (The other partitions are pruned entirely)
```

#### List Partitioning

Routes rows based on discrete values. Perfect for multi-tenant systems or categorical data.

```sql
CREATE TABLE tenant_data (
    id          bigint GENERATED ALWAYS AS IDENTITY,
    tenant_id   text NOT NULL,
    payload     jsonb NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
) PARTITION BY LIST (tenant_id);

CREATE TABLE tenant_data_acme
    PARTITION OF tenant_data FOR VALUES IN ('acme');
CREATE TABLE tenant_data_globex
    PARTITION OF tenant_data FOR VALUES IN ('globex');
CREATE TABLE tenant_data_initech
    PARTITION OF tenant_data FOR VALUES IN ('initech');
CREATE TABLE tenant_data_default
    PARTITION OF tenant_data DEFAULT;
```

#### Hash Partitioning (PG 11+)

Distributes rows evenly across partitions using a hash function. Use when there's no natural range or list boundary but you want even distribution.

```sql
CREATE TABLE user_sessions (
    id          bigint GENERATED ALWAYS AS IDENTITY,
    user_id     bigint NOT NULL,
    session_data jsonb NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
) PARTITION BY HASH (user_id);

CREATE TABLE user_sessions_p0
    PARTITION OF user_sessions FOR VALUES WITH (MODULUS 4, REMAINDER 0);
CREATE TABLE user_sessions_p1
    PARTITION OF user_sessions FOR VALUES WITH (MODULUS 4, REMAINDER 1);
CREATE TABLE user_sessions_p2
    PARTITION OF user_sessions FOR VALUES WITH (MODULUS 4, REMAINDER 2);
CREATE TABLE user_sessions_p3
    PARTITION OF user_sessions FOR VALUES WITH (MODULUS 4, REMAINDER 3);
```

Hash partitioning is less common because you can't prune partitions based on range queries, and you can't easily drop a partition without losing arbitrary rows. It's mainly useful for parallel processing.

### Sub-Partitioning

You can partition partitions. The most common pattern is range by time, then list by tenant:

```sql
CREATE TABLE events (
    id          bigint GENERATED ALWAYS AS IDENTITY,
    tenant_id   text NOT NULL,
    event_type  text NOT NULL,
    payload     jsonb NOT NULL,
    occurred_at timestamptz NOT NULL
) PARTITION BY RANGE (occurred_at);

CREATE TABLE events_2025_01
    PARTITION OF events
    FOR VALUES FROM ('2025-01-01') TO ('2025-02-01')
    PARTITION BY LIST (tenant_id);

CREATE TABLE events_2025_01_acme
    PARTITION OF events_2025_01 FOR VALUES IN ('acme');
CREATE TABLE events_2025_01_globex
    PARTITION OF events_2025_01 FOR VALUES IN ('globex');
CREATE TABLE events_2025_01_default
    PARTITION OF events_2025_01 DEFAULT;
```

Sub-partitioning adds significant management complexity. Only use it when queries consistently filter on both dimensions and data volume justifies it.

### Attaching and Detaching Partitions

```sql
-- Create a table independently, then attach it as a partition
CREATE TABLE sensor_readings_2025_04 (
    LIKE sensor_readings INCLUDING ALL
);

-- Attach — PostgreSQL validates that all existing rows fit the constraint
ALTER TABLE sensor_readings
    ATTACH PARTITION sensor_readings_2025_04
    FOR VALUES FROM ('2025-04-01') TO ('2025-05-01');

-- To avoid the validation scan on large tables, add the constraint first:
ALTER TABLE sensor_readings_2025_04
    ADD CONSTRAINT valid_range CHECK (
        recorded_at >= '2025-04-01' AND recorded_at < '2025-05-01'
    );
-- Now ATTACH skips the scan because the constraint already guarantees it
ALTER TABLE sensor_readings
    ATTACH PARTITION sensor_readings_2025_04
    FOR VALUES FROM ('2025-04-01') TO ('2025-05-01');

-- Detach a partition (PG 14+ supports CONCURRENTLY to avoid locks)
ALTER TABLE sensor_readings
    DETACH PARTITION sensor_readings_2025_01;
-- sensor_readings_2025_01 is now a standalone table — archive or drop it

-- PG 14+: detach without blocking queries on other partitions
ALTER TABLE sensor_readings
    DETACH PARTITION sensor_readings_2025_01 CONCURRENTLY;
```

### Partition Maintenance: DROP vs DELETE

This is the killer feature of partitioning for time-series data:

```sql
-- DELETE: scans the table, generates WAL for each row, creates dead tuples needing VACUUM
-- On 100 million rows, this can take hours and bloat the table
DELETE FROM sensor_readings WHERE recorded_at < '2024-01-01';

-- DROP: instant, no WAL, no dead tuples, no VACUUM needed
ALTER TABLE sensor_readings DETACH PARTITION sensor_readings_2023_12;
DROP TABLE sensor_readings_2023_12;
-- This takes milliseconds regardless of row count
```

Automated partition management is a common requirement. Create a cron job or use `pg_cron` to create new partitions ahead of time and drop old ones:

```sql
-- Automation function called by pg_cron monthly
CREATE OR REPLACE FUNCTION maintain_sensor_partitions()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    future_month date := date_trunc('month', now()) + interval '2 months';
    old_month date := date_trunc('month', now()) - interval '13 months';
    partition_name text;
    old_partition text;
BEGIN
    partition_name := 'sensor_readings_' || to_char(future_month, 'YYYY_MM');
    IF NOT EXISTS (
        SELECT 1 FROM pg_class WHERE relname = partition_name
    ) THEN
        EXECUTE format(
            'CREATE TABLE %I PARTITION OF sensor_readings FOR VALUES FROM (%L) TO (%L)',
            partition_name,
            future_month,
            future_month + interval '1 month'
        );
        RAISE NOTICE 'Created partition %', partition_name;
    END IF;

    old_partition := 'sensor_readings_' || to_char(old_month, 'YYYY_MM');
    IF EXISTS (
        SELECT 1 FROM pg_class WHERE relname = old_partition
    ) THEN
        EXECUTE format('ALTER TABLE sensor_readings DETACH PARTITION %I', old_partition);
        EXECUTE format('DROP TABLE %I', old_partition);
        RAISE NOTICE 'Dropped partition %', old_partition;
    END IF;
END;
$$;
```

### Performance Characteristics and Gotchas

**Unique indexes must include the partition key:**

```sql
-- This FAILS:
CREATE UNIQUE INDEX ON sensor_readings (id);
-- ERROR: unique constraint on partitioned table must include all partition columns

-- This works:
CREATE UNIQUE INDEX ON sensor_readings (id, recorded_at);
-- The partition key must be part of the unique constraint
```

This is a fundamental constraint. If you need a globally unique `id`, use a UUID or use a sequence and accept that uniqueness is only guaranteed per partition.

**Foreign key limitations:**

```sql
-- PG 11 and below: foreign keys referencing partitioned tables are NOT supported
-- PG 12+: foreign keys FROM partitioned tables to regular tables work
-- PG 12+: foreign keys TO partitioned tables partially supported
-- PG 15+: foreign keys TO partitioned tables fully supported

-- This works in PG 12+:
ALTER TABLE sensor_readings
    ADD FOREIGN KEY (sensor_id) REFERENCES sensors(id);

-- Referencing a partitioned table (other table → partitioned table) requires PG 15+
```

**Query planner overhead:**

With many partitions (hundreds+), the planner takes longer because it must evaluate the constraint of each partition. PG 14 improved this substantially with partition pruning at planning time. Keep partition count under a few hundred if possible.

**Partition-wise joins (PG 11+) and aggregation (PG 12+):**

```sql
-- If both tables are partitioned on the same key, PG can join partition-to-partition
SET enable_partitionwise_join = on;
SET enable_partitionwise_aggregate = on;
-- These are off by default because they increase planning time
```

> **What a senior engineer actually thinks about:**
> Partitioning is a big operational commitment. Every DDL operation, every migration, every index creation now happens N times (once per partition). Automated partition management is mandatory — if you forget to create next month's partition, inserts fail (unless you have a default partition, which you should). Start with a default partition to catch overflow, create new partitions proactively, and test your maintenance automation thoroughly.

### Common Mistakes

1. **Partitioning too early**: A well-indexed 50M row table is probably fine. Partition when you have a real problem.
2. **Forgetting the default partition**: Without it, inserts that don't match any partition fail.
3. **Not including partition key in unique constraints**: This is required and often surprises people.
4. **Too many partitions**: Daily partitions over 10 years = 3,650 partitions. Query planning slows down. Monthly or weekly is usually sufficient.
5. **Queries without partition key in WHERE**: If you query without the partition key, PostgreSQL scans ALL partitions. The partition key must be in most of your queries.

### Summary

Partitioning splits large tables into manageable physical chunks while presenting a unified logical table. Use range partitioning for time-series, list for multi-tenant, hash for even distribution. The killer feature is instant data removal by dropping partitions. Unique constraints must include the partition key, automate partition creation, and always have a default partition.

---

## 7.6 Triggers — Invisible Code Attached to Your Tables

### Concept

A trigger is a function that PostgreSQL executes automatically when a specific event (INSERT, UPDATE, DELETE, TRUNCATE) happens on a table. If you've used event listeners in the DOM (`element.addEventListener('click', handler)`), triggers are the database equivalent — invisible code that fires in response to data changes.

Triggers are powerful and dangerous. They let you enforce complex business rules, maintain denormalized data, and create audit trails — but they also create invisible side effects that make debugging harder, they cascade in unexpected ways, and they can silently destroy performance.

### Trigger Anatomy

A trigger has two parts: the trigger function (written in PL/pgSQL or another procedural language) and the trigger definition that binds it to a table and event.

```sql
-- Step 1: Create the trigger function
CREATE OR REPLACE FUNCTION update_modified_timestamp()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

-- Step 2: Bind it to a table
CREATE TRIGGER set_updated_at
    BEFORE UPDATE ON orders
    FOR EACH ROW
    EXECUTE FUNCTION update_modified_timestamp();
```

### BEFORE vs AFTER Triggers

**BEFORE triggers** fire before the operation is applied to the row. You can modify the `NEW` record (for INSERT/UPDATE) or prevent the operation by returning NULL.

```sql
-- BEFORE INSERT: normalize data before it's written
CREATE OR REPLACE FUNCTION normalize_email()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.email = lower(trim(NEW.email));
    IF NEW.email !~ '^[^@]+@[^@]+\.[^@]+$' THEN
        RAISE EXCEPTION 'Invalid email: %', NEW.email;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_normalize_email
    BEFORE INSERT OR UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION normalize_email();
```

**AFTER triggers** fire after the operation has been applied. The row is already written. Use these for side effects that don't modify the row itself: audit logging, sending notifications, updating related tables.

```sql
-- AFTER INSERT: maintain a denormalized count
CREATE OR REPLACE FUNCTION update_comment_count()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE posts SET comment_count = comment_count + 1
        WHERE id = NEW.post_id;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE posts SET comment_count = comment_count - 1
        WHERE id = OLD.post_id;
    END IF;
    RETURN NULL; -- AFTER triggers return value is ignored
END;
$$;

CREATE TRIGGER trg_comment_count
    AFTER INSERT OR DELETE ON comments
    FOR EACH ROW
    EXECUTE FUNCTION update_comment_count();
```

### FOR EACH ROW vs FOR EACH STATEMENT

**FOR EACH ROW** fires once per affected row. You have access to `NEW` (for INSERT/UPDATE) and `OLD` (for UPDATE/DELETE).

**FOR EACH STATEMENT** fires once per SQL statement, regardless of how many rows are affected. You don't have `NEW` or `OLD` because there's no single row. Use this for logging or actions that should happen once, not per-row.

```sql
-- Statement-level trigger: log that a bulk operation happened
CREATE OR REPLACE FUNCTION log_bulk_operation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO audit_log (table_name, operation, performed_at)
    VALUES (TG_TABLE_NAME, TG_OP, now());
    RETURN NULL;
END;
$$;

CREATE TRIGGER trg_audit_bulk
    AFTER INSERT OR UPDATE OR DELETE ON orders
    FOR EACH STATEMENT
    EXECUTE FUNCTION log_bulk_operation();
```

### NEW and OLD Records

| Operation | NEW | OLD |
|---|---|---|
| INSERT | The row being inserted | Not available |
| UPDATE | The row after modification | The row before modification |
| DELETE | Not available | The row being deleted |

```sql
-- Audit trigger using both NEW and OLD
CREATE OR REPLACE FUNCTION audit_changes()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO audit_trail (table_name, operation, new_data, changed_at, changed_by)
        VALUES (TG_TABLE_NAME, 'INSERT', to_jsonb(NEW), now(), current_setting('app.current_user_id', true));
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO audit_trail (table_name, operation, old_data, new_data, changed_at, changed_by)
        VALUES (TG_TABLE_NAME, 'UPDATE', to_jsonb(OLD), to_jsonb(NEW), now(), current_setting('app.current_user_id', true));
    ELSIF TG_OP = 'DELETE' THEN
        INSERT INTO audit_trail (table_name, operation, old_data, changed_at, changed_by)
        VALUES (TG_TABLE_NAME, 'DELETE', to_jsonb(OLD), now(), current_setting('app.current_user_id', true));
    END IF;
    RETURN NULL;
END;
$$;

CREATE TABLE audit_trail (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    table_name  text NOT NULL,
    operation   text NOT NULL,
    old_data    jsonb,
    new_data    jsonb,
    changed_at  timestamptz NOT NULL,
    changed_by  text
);

CREATE TRIGGER trg_audit_orders
    AFTER INSERT OR UPDATE OR DELETE ON orders
    FOR EACH ROW
    EXECUTE FUNCTION audit_changes();
```

### Trigger Execution Order

When multiple triggers are defined on the same table and event:

1. BEFORE statement triggers fire (alphabetical by trigger name)
2. For each row:
   a. BEFORE row triggers fire (alphabetical by trigger name)
   b. The operation is performed
   c. AFTER row triggers fire (alphabetical by trigger name)
3. AFTER statement triggers fire (alphabetical by trigger name)

Alphabetical ordering means trigger names matter. If you need ordering, name them accordingly: `trg_01_validate`, `trg_02_transform`, `trg_03_audit`.

### INSTEAD OF Triggers on Views

Regular triggers fire on tables. `INSTEAD OF` triggers fire on views and replace the default operation. They make views writable.

```sql
CREATE VIEW active_users AS
    SELECT id, email, full_name, role
    FROM users
    WHERE status = 'active';

CREATE OR REPLACE FUNCTION handle_active_users_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO users (email, full_name, role, status)
    VALUES (NEW.email, NEW.full_name, NEW.role, 'active');
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_active_users_insert
    INSTEAD OF INSERT ON active_users
    FOR EACH ROW
    EXECUTE FUNCTION handle_active_users_insert();

-- Now you can insert through the view:
INSERT INTO active_users (email, full_name, role)
VALUES ('new@example.com', 'New User', 'member');
```

### Event Triggers (PG 9.3+)

Event triggers fire on DDL events (CREATE, ALTER, DROP) rather than data changes. They're used for schema change auditing and enforcement.

```sql
CREATE OR REPLACE FUNCTION prevent_table_drop()
RETURNS event_trigger LANGUAGE plpgsql AS $$
DECLARE
    obj record;
BEGIN
    FOR obj IN SELECT * FROM pg_event_trigger_dropped_objects()
    LOOP
        IF obj.object_type = 'table' AND obj.schema_name = 'public' THEN
            RAISE EXCEPTION 'Dropping tables in public schema is not allowed. Use a migration.';
        END IF;
    END LOOP;
END;
$$;

CREATE EVENT TRIGGER no_drop_tables
    ON sql_drop
    EXECUTE FUNCTION prevent_table_drop();
```

### When Triggers Are Justified

**Good use cases:**
- Audit trails (the example above)
- Maintaining `updated_at` timestamps
- Enforcing complex cross-row or cross-table business rules that can't be expressed as CHECK constraints
- Maintaining materialized denormalizations (comment counts, search vectors on PG < 12)
- Sending NOTIFY events on data changes

**Questionable use cases:**
- Complex multi-step business logic (put this in application code where it's testable)
- Cascading writes across many tables (use application transactions)
- Anything that should be visible and testable in code review

### Hidden Costs

```sql
-- 1. Cascading triggers: trigger on table A inserts into table B,
--    which has its own trigger that updates table C...
--    Debugging cascade: good luck.

-- 2. Performance: a row-level trigger on a table with a bulk INSERT of 100K rows
--    means the trigger function executes 100,000 times
--    Each execution involves PL/pgSQL interpreter overhead

-- 3. Invisible side effects: an INSERT into orders silently creates
--    an audit log entry, updates a counter, sends a notification...
--    None of this is visible from the SQL statement

-- 4. Transaction scope: triggers run inside the same transaction
--    If the trigger fails, the whole operation rolls back
--    This can be good (consistency) or bad (a notification failure blocks the insert)
```

### Alternatives to Triggers

| Need | Instead of triggers, consider... |
|---|---|
| Computed columns | Generated columns (PG 12+) |
| Validation | CHECK constraints, domains |
| Audit logging | Application-level audit middleware |
| Denormalized counts | Materialized views, application-level cache |
| Complex business rules | Application code with explicit transaction management |
| Timestamp updates | Application-level middleware, ORM hooks |

> **What a senior engineer actually thinks about:**
> I use triggers sparingly and only for things that MUST be enforced at the database level regardless of which application connects. Audit trails and `updated_at` timestamps are my most common use cases. Everything else, I strongly prefer in application code where it's visible, testable, and debuggable. The worst codebase I inherited had 47 triggers across 12 tables creating a web of invisible side effects that took weeks to understand.

### Common Mistakes

1. **Too many triggers**: Every trigger adds overhead and hides behavior. Use the minimum.
2. **Not handling all operations**: A trigger for INSERT but not UPDATE means data goes out of sync on updates.
3. **Trigger functions with side effects outside the database**: HTTP calls, file writes — these can't be rolled back if the transaction fails.
4. **Forgetting that bulk operations fire row triggers per row**: A `DELETE FROM table` deleting 1M rows fires the trigger 1M times.
5. **Naming triggers poorly**: Since execution order is alphabetical, use a naming convention that reflects the intended order.

### Summary

Triggers are automatic functions attached to table events. Use BEFORE for validation and data transformation, AFTER for side effects and audit logging. Use them when behavior MUST be enforced at the database level. But prefer application code, generated columns, and constraints for most cases. Name triggers carefully (alphabetical ordering matters), watch out for cascading triggers, and remember they fire per-row on bulk operations.

---

## 7.7 Row Level Security (RLS) — Access Control in the Database

### Concept

Row Level Security lets you define policies that control which rows a given database user or role can see (SELECT), insert (INSERT), modify (UPDATE), or delete (DELETE). The database enforces these policies transparently — application queries don't need WHERE clauses for access control because the database adds them automatically.

Think of it like middleware in Express or Next.js that intercepts every request and filters data based on the authenticated user — except it's enforced at the database level, making it impossible to bypass even with a direct SQL connection.

RLS is the foundation of multi-tenant security in modern SaaS architectures, particularly with tools like Supabase that use PostgreSQL RLS extensively.

### Enabling RLS

```sql
-- Create a table
CREATE TABLE documents (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   text NOT NULL,
    title       text NOT NULL,
    content     text,
    owner_id    bigint NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS on the table (this doesn't create any policies yet)
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

-- IMPORTANT: With RLS enabled and no policies, ALL rows are hidden for non-superusers
-- The table owner (superuser) bypasses RLS by default
```

### CREATE POLICY Syntax

```sql
-- Basic syntax
CREATE POLICY policy_name ON table_name
    [AS {PERMISSIVE | RESTRICTIVE}]
    [FOR {ALL | SELECT | INSERT | UPDATE | DELETE}]
    [TO {role_name | PUBLIC | CURRENT_USER | SESSION_USER}]
    [USING (expression)]        -- filters existing rows (SELECT, UPDATE, DELETE)
    [WITH CHECK (expression)];  -- validates new/modified rows (INSERT, UPDATE)
```

### USING vs WITH CHECK

This distinction is critical and often confused:

- **USING**: Applied when reading existing rows. Controls which rows you can SELECT, which rows you can UPDATE (the "before" state), and which rows you can DELETE. Think of it as a WHERE clause that's silently appended to every query.
- **WITH CHECK**: Applied when writing rows. Validates the new row on INSERT or the modified row on UPDATE. Think of it as a constraint that checks "is this row valid for you to create?"

```sql
-- Policy: users can only see their own documents
CREATE POLICY select_own_docs ON documents
    FOR SELECT
    USING (owner_id = current_setting('app.current_user_id')::bigint);

-- Policy: users can only insert documents owned by themselves
CREATE POLICY insert_own_docs ON documents
    FOR INSERT
    WITH CHECK (owner_id = current_setting('app.current_user_id')::bigint);

-- Policy: users can update only their own documents, and can't change ownership
CREATE POLICY update_own_docs ON documents
    FOR UPDATE
    USING (owner_id = current_setting('app.current_user_id')::bigint)
    WITH CHECK (owner_id = current_setting('app.current_user_id')::bigint);

-- Policy: users can delete only their own documents
CREATE POLICY delete_own_docs ON documents
    FOR DELETE
    USING (owner_id = current_setting('app.current_user_id')::bigint);
```

### Setting the Application Context

RLS policies reference the "current user" via session settings. Your application sets these on each connection:

```sql
-- In your application's connection setup or transaction:
SET app.current_user_id = '42';
SET app.current_tenant_id = 'acme';

-- These settings last for the session (or transaction, with SET LOCAL)
-- SET LOCAL resets at the end of the transaction — safer for connection pooling:
BEGIN;
SET LOCAL app.current_user_id = '42';
-- ... queries run with this context ...
COMMIT; -- setting is reset
```

### Multi-Tenant SaaS with RLS — Complete Example

```sql
-- Tenants and users
CREATE TABLE tenants (
    id      text PRIMARY KEY,
    name    text NOT NULL
);

CREATE TABLE users (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   text NOT NULL REFERENCES tenants(id),
    email       text NOT NULL,
    role        text NOT NULL DEFAULT 'member'
        CHECK (role IN ('admin', 'member', 'viewer'))
);

-- Tenant-scoped data
CREATE TABLE projects (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   text NOT NULL REFERENCES tenants(id),
    name        text NOT NULL,
    description text,
    created_by  bigint NOT NULL REFERENCES users(id),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id   text NOT NULL REFERENCES tenants(id),
    project_id  bigint NOT NULL REFERENCES projects(id),
    title       text NOT NULL,
    assigned_to bigint REFERENCES users(id),
    status      text NOT NULL DEFAULT 'todo',
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

-- Helper function to get the current tenant
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS text
LANGUAGE sql STABLE
AS $$
    SELECT current_setting('app.current_tenant_id', true);
$$;

CREATE OR REPLACE FUNCTION current_user_role() RETURNS text
LANGUAGE sql STABLE
AS $$
    SELECT current_setting('app.current_user_role', true);
$$;

-- Projects policies
CREATE POLICY tenant_isolation_projects ON projects
    FOR ALL
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- Tasks policies: tenant isolation + role-based access
CREATE POLICY tenant_isolation_tasks ON tasks
    FOR SELECT
    USING (tenant_id = current_tenant_id());

CREATE POLICY task_insert ON tasks
    FOR INSERT
    WITH CHECK (
        tenant_id = current_tenant_id()
        AND current_user_role() IN ('admin', 'member')
    );

CREATE POLICY task_update ON tasks
    FOR UPDATE
    USING (tenant_id = current_tenant_id())
    WITH CHECK (
        tenant_id = current_tenant_id()
        AND (
            current_user_role() = 'admin'
            OR assigned_to = current_setting('app.current_user_id')::bigint
        )
    );

CREATE POLICY task_delete ON tasks
    FOR DELETE
    USING (
        tenant_id = current_tenant_id()
        AND current_user_role() = 'admin'
    );
```

**Application integration (Node.js pseudocode):**

```sql
-- On every API request, your middleware sets context:
BEGIN;
SET LOCAL app.current_tenant_id = 'acme';
SET LOCAL app.current_user_id = '42';
SET LOCAL app.current_user_role = 'member';

-- Now all queries are automatically scoped:
SELECT * FROM projects;           -- only sees acme's projects
SELECT * FROM tasks;              -- only sees acme's tasks
INSERT INTO tasks (tenant_id, project_id, title, assigned_to)
VALUES ('acme', 1, 'New task', 42);  -- succeeds (member can insert)

INSERT INTO tasks (tenant_id, project_id, title, assigned_to)
VALUES ('globex', 1, 'Sneaky task', 42);  -- FAILS: WITH CHECK violation
-- Even if the application has a bug, the database prevents cross-tenant writes

COMMIT;
```

### Combining Multiple Policies

When multiple policies exist on the same table for the same operation:

- **PERMISSIVE policies** (default): Combined with OR — if any permissive policy allows the row, it's visible.
- **RESTRICTIVE policies**: Combined with AND — all restrictive policies must allow the row.

Permissive and restrictive policies are combined: (any permissive passes) AND (all restrictive pass).

```sql
-- Permissive: user can see their own tasks OR tasks assigned to them
CREATE POLICY see_own_tasks ON tasks AS PERMISSIVE
    FOR SELECT
    USING (created_by = current_setting('app.current_user_id')::bigint);

CREATE POLICY see_assigned_tasks ON tasks AS PERMISSIVE
    FOR SELECT
    USING (assigned_to = current_setting('app.current_user_id')::bigint);

-- Restrictive: but only within their tenant (regardless of other policies)
CREATE POLICY enforce_tenant ON tasks AS RESTRICTIVE
    FOR SELECT
    USING (tenant_id = current_tenant_id());

-- Result: user sees tasks where (they created it OR it's assigned to them) AND it's their tenant
```

### BYPASSRLS and FORCE ROW LEVEL SECURITY

```sql
-- Superusers and table owners bypass RLS by default
-- To make even the table owner subject to RLS:
ALTER TABLE documents FORCE ROW LEVEL SECURITY;

-- To grant a role the ability to bypass RLS (for admin/migration scripts):
ALTER ROLE admin_service BYPASSRLS;

-- To explicitly prevent a role from bypassing:
ALTER ROLE app_user NOBYPASSRLS;
```

In production, your application should connect as a role with `NOBYPASSRLS`, while migration scripts and admin tools use a role with `BYPASSRLS`.

### Performance Implications

RLS policies are implemented as additional WHERE clauses. PostgreSQL appends the policy expression to every query against the table. This means:

1. **Index support matters**: If your policy checks `tenant_id = current_tenant_id()`, ensure there's an index on `tenant_id`. Otherwise every query does a sequential scan filtered by the policy.
2. **Function volatility matters**: Policy functions should be `STABLE` or `IMMUTABLE`, not `VOLATILE`. A `VOLATILE` function prevents the planner from using indexes effectively.
3. **Security barrier views**: Views on RLS-protected tables become security barriers. This prevents the optimizer from pushing predicates past the security check, which can affect performance.

```sql
-- Ensure the tenant_id column is indexed for policy evaluation
CREATE INDEX idx_tasks_tenant ON tasks (tenant_id);
CREATE INDEX idx_projects_tenant ON projects (tenant_id);

-- Composite indexes that match common query patterns
CREATE INDEX idx_tasks_tenant_status ON tasks (tenant_id, status);
CREATE INDEX idx_tasks_tenant_assigned ON tasks (tenant_id, assigned_to);
```

> **What a senior engineer actually thinks about:**
> RLS is incredibly powerful for multi-tenant SaaS but comes with a debugging tax. When a query returns no rows unexpectedly, you need to check: is the RLS policy correct? Are the session settings set? Is the user's role correct? Use `SET ROLE` to test as different users. And always test RLS policies in your CI/CD pipeline — a policy bug can either expose data across tenants (security breach) or hide data from legitimate users (support tickets).

### Common Mistakes

1. **Forgetting to enable RLS**: `CREATE POLICY` without `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` does nothing.
2. **Not setting session variables**: If `app.current_tenant_id` isn't set, `current_setting` returns NULL, and your policy matches nothing.
3. **Using `current_setting` without the `true` parameter**: `current_setting('app.x')` throws an error if the setting doesn't exist. `current_setting('app.x', true)` returns NULL.
4. **Superuser bypasses RLS**: If you test as a superuser, everything works. Test as the actual application role.
5. **Connection pooling and session variables**: With PgBouncer in transaction mode, session-level settings don't persist between transactions. Use `SET LOCAL` within each transaction.

### Summary

RLS lets you enforce row-level access control in the database, making it impossible for application bugs to leak data across tenants. Enable RLS on the table, create policies with USING (for reads) and WITH CHECK (for writes), set session variables on each request, and ensure your policy columns are indexed. Use RESTRICTIVE policies for tenant isolation and PERMISSIVE policies for role-based access within a tenant.

---

## 7.8 LISTEN/NOTIFY — Real-Time Events from the Database

### Concept

`LISTEN/NOTIFY` is PostgreSQL's built-in pub/sub system. It allows database sessions to send and receive asynchronous notifications through named channels. If you've used WebSocket events or EventEmitter in Node.js, it's the same pattern: one part of the system broadcasts an event, and any number of listeners receive it.

This is how you can get real-time updates from the database without polling.

### How It Works

```sql
-- Session 1: listen for notifications on a channel
LISTEN order_events;

-- Session 2: send a notification
NOTIFY order_events, '{"order_id": 123, "status": "shipped"}';

-- Session 1 receives:
-- Asynchronous notification "order_events" with payload
-- "{"order_id": 123, "status": "shipped"}" received from server process with PID 12345.

-- You can also use pg_notify() function instead of NOTIFY statement
SELECT pg_notify('order_events', json_build_object(
    'order_id', 123,
    'status', 'shipped',
    'updated_at', now()
)::text);
```

### Combining with Triggers for Real-Time Updates

The most common pattern: a trigger fires NOTIFY whenever data changes.

```sql
CREATE OR REPLACE FUNCTION notify_order_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    payload text;
BEGIN
    payload := json_build_object(
        'operation', TG_OP,
        'order_id', COALESCE(NEW.id, OLD.id),
        'status', CASE WHEN TG_OP = 'DELETE' THEN OLD.status ELSE NEW.status END,
        'user_id', CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END,
        'timestamp', extract(epoch from now())
    )::text;

    PERFORM pg_notify('order_changes', payload);
    RETURN NULL;
END;
$$;

CREATE TRIGGER trg_notify_order_change
    AFTER INSERT OR UPDATE OR DELETE ON orders
    FOR EACH ROW
    EXECUTE FUNCTION notify_order_change();
```

### Using with Node.js

```javascript
// Using the 'pg' library (node-postgres)
const { Client } = require('pg');

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

// Subscribe to channel
await client.query('LISTEN order_changes');

// Handle notifications
client.on('notification', (msg) => {
  const payload = JSON.parse(msg.payload);
  console.log(`Order ${payload.order_id}: ${payload.operation} → ${payload.status}`);

  // Forward to WebSocket clients, trigger background job, etc.
  websocketServer.broadcast(payload);
});

// The connection must stay open — this is a dedicated listener connection
// Don't use this connection for regular queries (it's blocked on LISTEN)
```

### Payload Limitations

The payload is limited to **8000 bytes**. This is a hard limit. If you try to send a larger payload, PostgreSQL raises an error.

Strategies for large payloads:

```sql
-- DON'T: try to send the entire row as payload
-- DO: send a reference (ID) and have the listener fetch the full data

CREATE OR REPLACE FUNCTION notify_change_id_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify(
        'data_changes',
        json_build_object(
            'table', TG_TABLE_NAME,
            'op', TG_OP,
            'id', COALESCE(NEW.id, OLD.id)
        )::text
    );
    RETURN NULL;
END;
$$;

-- Listener fetches the full row by ID when notified
```

### Important Characteristics

1. **Notifications are transactional**: A NOTIFY inside a transaction is only delivered when the transaction commits. If it rolls back, the notification is discarded. This prevents listeners from acting on data that doesn't exist.
2. **No persistence**: If no one is listening when a NOTIFY fires, the notification is lost. There's no replay, no queue, no backlog.
3. **No acknowledgment**: There's no way for the sender to know if anyone received the notification.
4. **Deduplication**: Multiple identical notifications (same channel + payload) within a single transaction are deduplicated to one.
5. **Connection-based**: LISTEN is per-connection. If the connection drops, all subscriptions are lost.

### LISTEN/NOTIFY vs Polling

```sql
-- Polling approach (wasteful):
-- Application runs this every N seconds:
SELECT * FROM orders WHERE updated_at > $last_check_time;

-- LISTEN/NOTIFY approach (efficient):
-- Application receives notifications in real-time, only queries when notified
```

Polling wastes database resources on queries that usually return no rows. LISTEN/NOTIFY delivers events only when something changes. The tradeoff: NOTIFY requires a dedicated persistent connection and has no delivery guarantees.

### When to Use vs Message Queues

| Feature | LISTEN/NOTIFY | Message Queue (Redis, RabbitMQ, SQS) |
|---|---|---|
| **Setup** | Built in, zero configuration | Separate infrastructure |
| **Persistence** | None — fire and forget | Durable (configurable) |
| **Delivery guarantee** | At-most-once | At-least-once or exactly-once |
| **Throughput** | Thousands/sec | Millions/sec |
| **Payload size** | 8000 bytes | Megabytes |
| **Consumer groups** | No | Yes |
| **Transactional** | Yes (notifications sent on commit) | Varies |

**Use LISTEN/NOTIFY when:** you need to wake up a listener in real-time (cache invalidation, WebSocket push, dashboard refresh), the data can be re-fetched if a notification is missed, and you don't need guaranteed delivery.

**Use a message queue when:** you need guaranteed delivery, need to distribute work across multiple consumers, payloads are large, or you need backpressure handling.

> **What a senior engineer actually thinks about:**
> LISTEN/NOTIFY is a lightweight signaling mechanism, not a message queue. I use it to signal "something changed, go check" — the listener then queries the database for the actual data. This way, if a notification is missed (connection drop, restart), the system self-heals on the next poll cycle. I always pair LISTEN/NOTIFY with periodic polling as a fallback.

### Common Mistakes

1. **Using a pooled connection for LISTEN**: Connection pools rotate connections. Your LISTEN is lost when the connection is returned. Use a dedicated, long-lived connection.
2. **Sending large payloads**: Keep payloads small — send IDs, not full records.
3. **Assuming delivery**: NOTIFY is fire-and-forget. Build resilience into listeners.
4. **Too many channels**: Each LISTEN adds overhead. Use a few channels with structured payloads rather than hundreds of channels.
5. **Blocking the listener connection with queries**: The LISTEN connection should only listen. Use a separate connection for queries.

### Summary

LISTEN/NOTIFY is PostgreSQL's built-in pub/sub for real-time notifications. Combine it with triggers to broadcast data changes. Notifications are transactional (delivered on commit), have an 8000-byte payload limit, and are not persisted. Use it for signaling and cache invalidation, pair with polling as a fallback, and use a dedicated connection for listening. For guaranteed delivery or high throughput, use a real message queue.

---

## 7.9 Foreign Data Wrappers (FDW) — Querying Across Boundaries

### Concept

Foreign Data Wrappers let you query external data sources as if they were local PostgreSQL tables. You define a "foreign table" that maps to data living somewhere else — another PostgreSQL instance, a MySQL database, a CSV file, a REST API — and then query it with regular SQL, including JOINs with local tables.

Think of it like GraphQL federation: you present a unified query interface that stitches together data from multiple sources under the hood.

### postgres_fdw — Cross-Database Queries

The most common FDW. It lets you query tables on a remote PostgreSQL server.

```sql
-- Step 1: Install the extension (once per database)
CREATE EXTENSION IF NOT EXISTS postgres_fdw;

-- Step 2: Define the remote server
CREATE SERVER analytics_server
    FOREIGN DATA WRAPPER postgres_fdw
    OPTIONS (host 'analytics-db.internal', port '5432', dbname 'analytics');

-- Step 3: Map local users to remote users
CREATE USER MAPPING FOR app_user
    SERVER analytics_server
    OPTIONS (user 'readonly_user', password 'secure_password');

-- Step 4: Import foreign tables (import all tables from a remote schema)
IMPORT FOREIGN SCHEMA public
    FROM SERVER analytics_server
    INTO analytics_tables;

-- Or define a specific foreign table manually:
CREATE FOREIGN TABLE analytics_events (
    id          bigint,
    event_type  text,
    user_id     bigint,
    payload     jsonb,
    created_at  timestamptz
) SERVER analytics_server
  OPTIONS (schema_name 'public', table_name 'events');

-- Step 5: Query as if it's a local table
SELECT u.email, count(e.id) AS event_count
FROM local_users u
JOIN analytics_events e ON u.id = e.user_id
WHERE e.created_at > now() - interval '7 days'
GROUP BY u.email
ORDER BY event_count DESC
LIMIT 10;
```

### Predicate Pushdown

The query planner pushes WHERE clauses to the remote server when possible. This means `WHERE created_at > '2025-01-01'` is executed on the remote server, not locally after fetching all rows.

```sql
-- Check what gets pushed down with EXPLAIN VERBOSE
EXPLAIN VERBOSE
SELECT * FROM analytics_events
WHERE event_type = 'purchase' AND created_at > '2025-01-01';

-- Output shows the remote query:
-- Foreign Scan on analytics_events
--   Remote SQL: SELECT id, event_type, user_id, payload, created_at
--               FROM public.events
--               WHERE ((event_type = 'purchase') AND (created_at > '2025-01-01'))
```

PG 14+ pushes down more operations including joins, aggregates, and LIMIT in some cases. Earlier versions are more conservative.

### file_fdw — Querying CSV Files

```sql
CREATE EXTENSION IF NOT EXISTS file_fdw;

CREATE SERVER csv_files FOREIGN DATA WRAPPER file_fdw;

CREATE FOREIGN TABLE exchange_rates (
    currency_code   text,
    rate            numeric,
    updated_date    date
) SERVER csv_files
  OPTIONS (
    filename '/var/data/exchange_rates.csv',
    format 'csv',
    header 'true'
  );

-- Query the CSV as a table
SELECT * FROM exchange_rates WHERE currency_code = 'EUR';

-- Join with local data
SELECT o.id, o.total_cents, er.rate,
       (o.total_cents * er.rate / 100)::numeric(10,2) AS converted_amount
FROM orders o
JOIN exchange_rates er ON o.currency = er.currency_code;
```

### Performance Implications

Foreign tables are fundamentally slower than local tables because of network overhead. Keep these guidelines in mind:

1. **Filter early**: Ensure WHERE clauses can be pushed down to minimize data transfer.
2. **Avoid joining large remote tables with large local tables**: The planner may fetch the entire remote table.
3. **Use `fetch_size` option**: Controls how many rows are fetched per network round trip (default 100).
4. **Consider materialized views**: For frequently accessed remote data, materialize it locally and refresh periodically.

```sql
-- Increase fetch_size for large scans
ALTER FOREIGN TABLE analytics_events OPTIONS (ADD fetch_size '10000');

-- Materialized view for frequently-needed remote data
CREATE MATERIALIZED VIEW mv_daily_event_counts AS
SELECT date_trunc('day', created_at) AS day,
       event_type,
       count(*) AS event_count
FROM analytics_events
WHERE created_at > now() - interval '90 days'
GROUP BY 1, 2;

CREATE UNIQUE INDEX ON mv_daily_event_counts (day, event_type);

-- Refresh daily via pg_cron
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_event_counts;
```

### Real Use Cases

1. **Analytics database separation**: Keep your OLTP database fast by querying heavy analytics data from a separate instance via FDW.
2. **Data migration**: During a migration from MySQL to PostgreSQL, use `mysql_fdw` to query both systems from PostgreSQL while migrating.
3. **Reference data**: Static datasets (country codes, exchange rates) loaded from CSV via `file_fdw`.
4. **Cross-service queries**: In a microservices architecture, FDW lets one service query another's database (use sparingly — this creates coupling).

> **What a senior engineer actually thinks about:**
> FDW is great for ad-hoc cross-database queries, data migration, and loading reference data. It's not great as a primary data access pattern in production — network latency, limited pushdown in older PG versions, and error handling (what happens when the remote server is down?) make it fragile. For production cross-service data access, I prefer application-level APIs or data replication. FDW is best for analytics, migration, and development.

### Common Mistakes

1. **Not checking pushdown**: Use `EXPLAIN VERBOSE` to verify that filters are pushed to the remote server.
2. **Ignoring connection limits**: Each foreign table query opens a connection to the remote server. Under load, you can exhaust remote connection limits.
3. **Treating FDW tables as local**: Writes to foreign tables are possible but have limited transactional guarantees (two-phase commit is supported but complex).
4. **Not updating `fetch_size`**: The default of 100 rows per fetch is too small for large scans.

### Summary

FDW lets you query external data sources as local PostgreSQL tables. Use `postgres_fdw` for cross-database queries and `file_fdw` for CSV imports. Verify predicate pushdown with `EXPLAIN VERBOSE`, tune `fetch_size` for bulk reads, and consider materialized views for frequently accessed remote data. Use FDW for analytics and migration, not as a primary data access pattern in latency-sensitive production paths.

---

## 7.10 Logical Replication vs Physical Replication

### Concept

Replication keeps copies of your data across multiple PostgreSQL instances. There are two fundamentally different approaches:

**Physical replication** copies the exact byte-level changes (WAL records) from the primary to replicas. The replica is a byte-for-byte copy of the primary. Think of it like disk mirroring — every bit is identical.

**Logical replication** decodes the WAL into logical changes (INSERT, UPDATE, DELETE on specific tables) and replays them. The replica can have a different schema, different indexes, even different tables. Think of it like subscribing to a changelog — you receive structured events describing what changed.

### Physical Replication

Physical replication is the simpler, more mature option. The primary streams its WAL (Write-Ahead Log) to replicas that replay it.

```
Primary → WAL Stream → Standby Replica (byte-for-byte identical)
```

**Setup is mostly configuration-based (pg_hba.conf, postgresql.conf), not SQL. Key settings:**

```ini
# On the primary (postgresql.conf):
wal_level = replica              # minimum for physical replication
max_wal_senders = 5              # max number of streaming replicas
wal_keep_size = 1GB              # WAL retained for slow replicas (PG 13+)

# On the replica, create a file called standby.signal (PG 12+)
# and set in postgresql.conf:
primary_conninfo = 'host=primary-db port=5432 user=replicator password=...'
```

**Characteristics:**
- Replica is read-only (hot standby)
- Entire database cluster is replicated — you can't choose specific tables
- Replica can serve read queries (read replicas for scaling reads)
- Failover promotes the replica to primary
- Very low replication lag (sub-second typically)
- Schema changes replicate automatically (since WAL includes everything)

**When to use physical replication:**
- High availability / automatic failover
- Read scaling (route SELECT queries to replicas)
- Disaster recovery (replica in different region)
- Point-in-time recovery (PITR)

### Logical Replication (PG 10+)

Logical replication uses a publication/subscription model. The source database publishes changes from specific tables, and the target database subscribes.

```sql
-- On the publisher (source database):
-- Set wal_level = logical in postgresql.conf (requires restart)

-- Create a publication (what to publish)
CREATE PUBLICATION my_pub FOR TABLE orders, users, products;

-- Or publish all tables:
CREATE PUBLICATION all_tables_pub FOR ALL TABLES;

-- Or publish specific operations:
CREATE PUBLICATION inserts_only FOR TABLE audit_log
    WITH (publish = 'insert');  -- only INSERT, not UPDATE/DELETE
```

```sql
-- On the subscriber (target database):
-- The target tables must already exist with compatible schemas

CREATE SUBSCRIPTION my_sub
    CONNECTION 'host=source-db port=5432 dbname=myapp user=replicator password=...'
    PUBLICATION my_pub;

-- The subscription copies existing data (initial snapshot) and then
-- streams ongoing changes

-- Monitor replication status:
SELECT * FROM pg_stat_subscription;
SELECT * FROM pg_subscription_rel;
```

**Characteristics:**
- Replicates specific tables, not the entire cluster
- Target can have additional tables, indexes, and triggers not present on source
- Target is writable (but be careful — conflicts can occur)
- Higher replication lag than physical replication
- Schema changes do NOT replicate — you must apply DDL manually to both sides
- Sequences are not replicated
- Large objects are not replicated

### Key Differences

| Feature | Physical | Logical |
|---|---|---|
| **Granularity** | Entire database cluster | Specific tables |
| **Replica writable** | No (read-only standby) | Yes |
| **Schema changes** | Automatic | Manual on both sides |
| **Cross-version** | Same major version | Different major versions OK |
| **Use for upgrades** | No | Yes (replicate to newer PG version) |
| **Performance overhead** | Minimal | Higher (decoding WAL) |
| **Replication lag** | Sub-second | Seconds to minutes |
| **Conflict handling** | N/A (read-only) | Manual (can break replication) |
| **Sequences** | Replicated | Not replicated |
| **Partition support** | Full | Limited (PG 13+ improves this) |

### Schema Changes and Logical Replication

This is the biggest operational challenge with logical replication:

```sql
-- You add a column on the publisher:
ALTER TABLE orders ADD COLUMN priority text DEFAULT 'normal';

-- The subscriber's orders table does NOT get this column.
-- Replication continues but the new column is silently dropped.

-- If you add a NOT NULL column without a default on the publisher:
ALTER TABLE orders ADD COLUMN required_field text NOT NULL;
-- Replication BREAKS because the subscriber can't insert rows without this column.
```

The operational procedure: apply the DDL change on the subscriber first (add the column), then on the publisher. This way the subscriber is ready when the new data starts arriving.

### Replicating Specific Tables — Real Use Case

```sql
-- Scenario: main application database → analytics database
-- Only replicate the tables the analytics team needs

-- Publisher (main app database):
CREATE PUBLICATION analytics_pub FOR TABLE
    users,
    orders,
    order_items,
    products,
    page_views;

-- Subscriber (analytics database):
-- Create the tables (can have different indexes, no foreign keys needed)
CREATE TABLE users (
    id bigint PRIMARY KEY,
    email text,
    created_at timestamptz
    -- Note: analytics doesn't need password_hash or other sensitive columns
    -- But logical replication sends all columns — filter at the view level
);

CREATE SUBSCRIPTION analytics_sub
    CONNECTION 'host=app-db port=5432 dbname=myapp user=replicator'
    PUBLICATION analytics_pub;
```

PG 15+ added the ability to publish only specific columns:

```sql
-- PG 15+: publish only selected columns
CREATE PUBLICATION filtered_pub FOR TABLE
    users (id, email, created_at, role),  -- excludes password_hash, etc.
    orders (id, user_id, total_cents, status, created_at);
```

### When to Use Which

**Use physical replication for:**
- High availability (primary → standby with automatic failover)
- Read scaling (read replicas)
- Disaster recovery
- Anything where you need a complete, identical copy

**Use logical replication for:**
- Major version upgrades (replicate from PG 14 to PG 16, then switch)
- Selective table replication (main DB → analytics DB)
- Multi-datacenter setups where both sides need to be writable
- Consolidating data from multiple databases into one
- CDC (Change Data Capture) pipelines

> **What a senior engineer actually thinks about:**
> For most production setups, you want physical replication for HA and read scaling — it's simpler, lower lag, and automatic. You add logical replication when you have a specific need: feeding an analytics warehouse, doing a major version upgrade with zero downtime, or publishing changes to a downstream system. Running both simultaneously is common: physical for HA, logical for data distribution.

### Common Mistakes

1. **Forgetting `wal_level = logical`**: Logical replication requires this setting, and changing it requires a restart.
2. **Not handling schema changes**: DDL doesn't replicate. Have a process for coordinating schema changes.
3. **Ignoring replication conflicts**: If both sides write to the same table, conflicts (duplicate key, etc.) break replication.
4. **Sequences on the subscriber**: Sequences aren't replicated. If you failover to the subscriber, sequence values may conflict. Use UUIDs or set subscriber sequences ahead.
5. **Forgetting initial data copy**: `CREATE SUBSCRIPTION` does an initial data copy by default, which can be slow for large tables. Use `copy_data = false` if the data is already there.

### Summary

Physical replication creates an exact byte-level copy for HA and read scaling — it's simpler and faster. Logical replication decodes changes into row-level operations for selective table replication, cross-version upgrades, and data distribution. Schema changes don't replicate with logical replication; sequences don't either. Most production systems use physical for HA and add logical for specific data distribution needs.

---

## 7.11 Extensions Ecosystem — Batteries Not Included, But Available

### Concept

PostgreSQL's extension system is one of its greatest strengths. Extensions add new data types, functions, operators, index types, and even entire subsystems without modifying the core database. Think of it like npm packages, but for your database.

Extensions are written in C and run inside the PostgreSQL server process — they're fast, native, and well-integrated. They're installed per-database with `CREATE EXTENSION`.

### Installing Extensions

```sql
-- Check what's available (installed or not):
SELECT * FROM pg_available_extensions ORDER BY name;

-- Install an extension:
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- See installed extensions:
SELECT * FROM pg_extension;

-- Update to latest version:
ALTER EXTENSION pg_trgm UPDATE;

-- Drop an extension:
DROP EXTENSION pg_trgm;
```

On most systems, extensions are installed from OS packages (e.g., `apt install postgresql-16-postgis-3`). Cloud providers (RDS, Cloud SQL, Supabase) pre-install common extensions and you just `CREATE EXTENSION`.

### pg_trgm — Fuzzy Text Search

`pg_trgm` (trigram) enables similarity-based text search. It breaks strings into trigrams (three-character sequences) and compares them. This powers "did you mean?" functionality and typo-tolerant search.

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- similarity(): returns a number between 0 and 1
SELECT similarity('postgresql', 'postgre');
-- Result: 0.5384615

SELECT similarity('postgresql', 'postgres');
-- Result: 0.7272727

-- % operator: returns true if similarity is above the threshold
SELECT 'postgresql' % 'postgres';  -- true (default threshold is 0.3)

-- Set the similarity threshold
SET pg_trgm.similarity_threshold = 0.4;

-- GIN index for trigram search
CREATE INDEX idx_products_name_trgm ON products USING gin (name gin_trgm_ops);

-- Fuzzy search with ranking
SELECT name, similarity(name, 'mechancal keybord') AS sim
FROM products
WHERE name % 'mechancal keybord'  -- typo-tolerant match
ORDER BY sim DESC;
-- Returns "Mechanical Keyboard" despite the typos

-- GiST index (alternative, supports <-> distance operator for ORDER BY)
CREATE INDEX idx_products_name_trgm_gist ON products USING gist (name gist_trgm_ops);

-- Distance-based search (lower is better)
SELECT name, name <-> 'mechancal keybord' AS distance
FROM products
ORDER BY name <-> 'mechancal keybord'
LIMIT 10;
```

**Combining pg_trgm with full-text search:**

```sql
-- Hybrid search: FTS for relevance, trigram for typo tolerance
SELECT
    a.title,
    ts_rank_cd(a.search_vector, q) AS fts_rank,
    similarity(a.title, 'postgre replicaton') AS trgm_sim
FROM articles a, websearch_to_tsquery('english', 'postgre replicaton') AS q
WHERE a.search_vector @@ q
   OR a.title % 'postgre replicaton'
ORDER BY
    (ts_rank_cd(a.search_vector, q) * 0.7 + similarity(a.title, 'postgre replicaton') * 0.3) DESC
LIMIT 20;
```

### PostGIS — Geospatial Data

PostGIS adds geographic data types and spatial queries. If your application deals with locations, areas, routes, or proximity searches, PostGIS turns PostgreSQL into a full geospatial database.

```sql
CREATE EXTENSION IF NOT EXISTS postgis;

-- Store locations with the geography type (uses lat/long, accounts for earth curvature)
CREATE TABLE stores (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        text NOT NULL,
    location    geography(POINT, 4326) NOT NULL  -- 4326 = WGS84 (standard GPS)
);

-- Insert using longitude, latitude (note: longitude first)
INSERT INTO stores (name, location) VALUES
('Downtown Store', ST_MakePoint(-73.9857, 40.7484)::geography),   -- NYC
('Brooklyn Store', ST_MakePoint(-73.9442, 40.6782)::geography),
('Jersey Store',   ST_MakePoint(-74.0431, 40.7178)::geography);

-- Spatial index
CREATE INDEX idx_stores_location ON stores USING gist (location);

-- Find stores within 5km of a point
SELECT name, ST_Distance(location, ST_MakePoint(-73.9800, 40.7500)::geography) AS distance_meters
FROM stores
WHERE ST_DWithin(location, ST_MakePoint(-73.9800, 40.7500)::geography, 5000)
ORDER BY distance_meters;

-- Find the nearest 3 stores (KNN search using the index)
SELECT name, ST_Distance(location, ST_MakePoint(-73.9800, 40.7500)::geography) AS distance_meters
FROM stores
ORDER BY location <-> ST_MakePoint(-73.9800, 40.7500)::geography
LIMIT 3;
```

PostGIS is a deep topic — it supports polygons, linestrings, spatial joins, routing, and more. If you need geospatial queries, PostGIS is one of the best reasons to use PostgreSQL.

### pg_stat_statements — Query Performance Monitoring

This is the single most important extension for production database monitoring. It tracks execution statistics for all SQL queries.

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
-- Requires adding to shared_preload_libraries in postgresql.conf and a restart

-- Top 10 queries by total execution time
SELECT
    query,
    calls,
    total_exec_time::numeric(12,2) AS total_ms,
    mean_exec_time::numeric(12,2) AS avg_ms,
    rows,
    (100.0 * shared_blks_hit / NULLIF(shared_blks_hit + shared_blks_read, 0))::numeric(5,2) AS cache_hit_pct
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;

-- Top queries by frequency
SELECT query, calls, mean_exec_time::numeric(12,2) AS avg_ms
FROM pg_stat_statements
ORDER BY calls DESC
LIMIT 10;

-- Queries with the worst cache hit ratio (most disk I/O)
SELECT query, calls,
    shared_blks_read,
    shared_blks_hit,
    (100.0 * shared_blks_hit / NULLIF(shared_blks_hit + shared_blks_read, 0))::numeric(5,2) AS cache_hit_pct
FROM pg_stat_statements
WHERE calls > 100
ORDER BY cache_hit_pct ASC
LIMIT 10;

-- Reset statistics (do this after deploying fixes to measure improvement)
SELECT pg_stat_statements_reset();
```

> **What a senior engineer actually thinks about:**
> `pg_stat_statements` is the first thing I install on any production PostgreSQL instance. It answers the question "what's my database actually spending time on?" without external monitoring. The `total_exec_time` view shows where optimization effort pays off most — a query called 10,000 times at 50ms each is a bigger problem than a query called once at 5 seconds.

### uuid-ossp and pgcrypto — UUID Generation

```sql
-- Option 1: uuid-ossp (the traditional choice)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
SELECT uuid_generate_v4();  -- random UUID
SELECT uuid_generate_v1();  -- time-based UUID

-- Option 2: pgcrypto (more general, also generates UUIDs)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SELECT gen_random_uuid();  -- random UUID (PG 13+ has this built-in without extension)

-- PG 13+: gen_random_uuid() is available without any extension
CREATE TABLE entities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL
);
```

If you're on PG 13+, you don't need either extension for UUID generation — `gen_random_uuid()` is built in. For PG 12, use `pgcrypto`.

For UUIDv7 (time-sortable UUIDs, increasingly popular), PostgreSQL 17 adds native support. On earlier versions, use a custom function or the `pg_uuidv7` community extension.

### hstore — Simple Key-Value Storage

`hstore` predates JSONB and stores flat key-value pairs where both keys and values are strings.

```sql
CREATE EXTENSION IF NOT EXISTS hstore;

CREATE TABLE legacy_config (
    id      serial PRIMARY KEY,
    name    text NOT NULL,
    settings hstore NOT NULL DEFAULT ''
);

INSERT INTO legacy_config (name, settings)
VALUES ('app', 'theme => dark, lang => en, timezone => UTC');

-- Query
SELECT settings->'theme' FROM legacy_config WHERE name = 'app';
-- Result: dark

-- Check key existence
SELECT * FROM legacy_config WHERE settings ? 'theme';

-- Convert to JSON
SELECT hstore_to_jsonb(settings) FROM legacy_config;
```

In new projects, use `jsonb` instead of `hstore`. JSONB can do everything hstore does plus nested structures, arrays, and typed values. hstore exists in legacy codebases and for the (rare) case where flat string-to-string mapping with specific hstore operators is needed.

### citext — Case-Insensitive Text

```sql
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
    id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email   citext NOT NULL UNIQUE
);

INSERT INTO users (email) VALUES ('User@Example.com');

-- Case-insensitive comparison without lower() or ILIKE
SELECT * FROM users WHERE email = 'user@example.com';  -- finds it
SELECT * FROM users WHERE email = 'USER@EXAMPLE.COM';  -- finds it too

-- The UNIQUE constraint is also case-insensitive
INSERT INTO users (email) VALUES ('user@example.com');
-- ERROR: duplicate key value violates unique constraint
```

`citext` eliminates the need for `lower()` wrappers and functional indexes on email columns. It uses the database's locale for case folding, which handles non-ASCII characters correctly.

### Extension Summary Table

| Extension | Purpose | When to use |
|---|---|---|
| `pg_trgm` | Fuzzy/similarity text search | Typo-tolerant search, "did you mean" |
| `postgis` | Geospatial data and queries | Any location-based feature |
| `pg_stat_statements` | Query performance tracking | Every production database |
| `uuid-ossp` / `pgcrypto` | UUID generation | PG 12 and below (PG 13+ has built-in) |
| `hstore` | Flat key-value pairs | Legacy; prefer `jsonb` for new projects |
| `citext` | Case-insensitive text type | Email fields, usernames |
| `pg_cron` | Scheduled jobs inside PostgreSQL | Partition maintenance, materialized view refresh |
| `pg_partman` | Automated partition management | If you're using partitioning |

### Common Mistakes

1. **Not installing `pg_stat_statements`**: This is free monitoring. Install it on every production database.
2. **Using `hstore` in new projects**: Use `jsonb` instead — it's strictly more capable.
3. **Forgetting `shared_preload_libraries`**: Some extensions (`pg_stat_statements`, `auto_explain`) require preloading and a server restart.
4. **Assuming cloud providers support all extensions**: AWS RDS, Google Cloud SQL, and Azure all have different supported extension lists. Check before relying on one.

### Summary

PostgreSQL's extension ecosystem adds specialized capabilities without leaving the database. `pg_trgm` for fuzzy search, PostGIS for geospatial, `pg_stat_statements` for performance monitoring, and `citext` for case-insensitive text are the most commonly used. Install `pg_stat_statements` on every production instance. Use `jsonb` instead of `hstore` in new projects. Check your cloud provider's extension support before building around one.

---

## 7.12 Things That Will Bite You in Production

This section collects the sharp edges, gotchas, and failure modes that don't neatly fit into a single topic. These are the things that work fine in development and blow up when you hit real traffic, real data volumes, and real operational complexity.

### 1. JSONB Columns That Grow Without Bound

```sql
-- This seems fine in dev with 10 rows:
UPDATE orders
SET metadata = jsonb_set(metadata, '{activity_log}',
    metadata->'activity_log' || jsonb_build_array(jsonb_build_object(
        'action', 'status_change', 'from', 'pending', 'to', 'shipped', 'at', now()
    ))
);

-- After 6 months in production, some orders have activity logs with 10,000 entries.
-- Each UPDATE rewrites the ENTIRE JSONB column. A 500KB JSONB value is rewritten
-- on every status change. TOAST compression helps but writes are brutal.
-- Dead tuple bloat from the old versions fills your disk.
```

**Fix:** Move unbounded arrays out of JSONB and into their own table.

### 2. GIN Index Bloat

GIN indexes on JSONB and array columns can bloat significantly with heavy write workloads. Unlike B-tree indexes, GIN indexes have a "pending list" for fast inserts that's periodically merged. If your write rate is high, the pending list grows and query performance degrades.

```sql
-- Check GIN index size vs table size
SELECT
    pg_size_pretty(pg_relation_size('idx_products_attributes')) AS index_size,
    pg_size_pretty(pg_relation_size('products')) AS table_size;

-- Force a GIN cleanup (normally happens during VACUUM)
VACUUM products;

-- Tune the pending list behavior
ALTER INDEX idx_products_attributes SET (gin_pending_list_limit = 4096);
-- Default is 4MB. Increase for write-heavy workloads, decrease for read-heavy.
```

### 3. Full-Text Search on Multilingual Content

```sql
-- You set up FTS with 'english' configuration. Works great... until
-- French and German content starts appearing in your database.
-- "Datenbank" doesn't stem to anything useful in the English configuration.

-- Solutions:
-- 1. Store the language per row and use the appropriate configuration
SELECT to_tsvector(
    CASE language_code
        WHEN 'fr' THEN 'french'::regconfig
        WHEN 'de' THEN 'german'::regconfig
        ELSE 'english'::regconfig
    END,
    body
) FROM articles;

-- 2. Use the 'simple' configuration (no stemming, no stop words)
--    Works for all languages but loses stemming benefits
SELECT to_tsvector('simple', body) FROM articles;
```

### 4. RLS Policies and ORM-Generated Queries

When using RLS with an ORM, the ORM doesn't know about RLS. It generates queries and expects certain row counts. RLS silently filters rows, which can cause:

```sql
-- ORM does: UPDATE users SET name = 'New Name' WHERE id = 42;
-- RLS filters it to: ... WHERE id = 42 AND tenant_id = 'acme'
-- If user 42 belongs to a different tenant, UPDATE affects 0 rows
-- The ORM may not raise an error — it just silently does nothing

-- Even worse: DELETE FROM users WHERE id = 42;
-- With RLS, this deletes 0 rows if the user isn't in the current tenant
-- No error, no warning. The application thinks it succeeded.
```

**Fix:** Check affected row counts after UPDATE/DELETE operations. In Node.js with `pg`, check `result.rowCount`.

### 5. Partition Key Not in Queries

```sql
-- You partitioned by recorded_at, but this query doesn't include it:
SELECT * FROM sensor_readings WHERE sensor_id = 42;

-- PostgreSQL scans ALL partitions because it can't prune without the partition key.
-- With 36 monthly partitions, this does 36 index scans instead of 1.

-- Always include the partition key in WHERE clauses:
SELECT * FROM sensor_readings
WHERE sensor_id = 42
  AND recorded_at >= '2025-01-01'
  AND recorded_at < '2025-04-01';
```

### 6. Trigger Cascades That Kill Performance

```sql
-- Trigger on orders updates order_totals
-- Trigger on order_totals updates customer_stats
-- Trigger on customer_stats sends a NOTIFY
-- A bulk insert of 10,000 orders triggers 30,000 operations

-- Use AFTER triggers with FOR EACH STATEMENT where possible,
-- or batch updates instead of per-row triggers.

-- Disable triggers for bulk operations:
ALTER TABLE orders DISABLE TRIGGER trg_update_totals;
-- ... bulk insert ...
ALTER TABLE orders ENABLE TRIGGER trg_update_totals;
-- ... then run a single UPDATE to recalculate ...
```

### 7. LISTEN/NOTIFY Connection Drops

```sql
-- Your Node.js listener crashes. Notifications during downtime are lost.
-- There's no replay mechanism.

-- Always pair LISTEN/NOTIFY with periodic polling:
-- 1. On startup, catch up by querying for recent changes
-- 2. On notification, process the event
-- 3. Every N minutes, poll for anything missed
```

### 8. Logical Replication Slot Growth

If a subscriber goes down or falls behind, the replication slot prevents WAL cleanup. Your disk fills up with WAL files.

```sql
-- Monitor replication lag
SELECT slot_name, active,
    pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) AS lag
FROM pg_replication_slots;

-- If a slot is inactive and lag is growing, drop it before disk fills:
SELECT pg_drop_replication_slot('my_sub');

-- Set a safety limit (PG 13+):
ALTER SYSTEM SET max_slot_wal_keep_size = '10GB';
-- WAL beyond this is discarded even if the slot needs it (slot becomes invalid)
```

### 9. Expression Index Mismatches

```sql
-- You created this index:
CREATE INDEX idx_users_email ON users (lower(email));

-- But your ORM generates:
SELECT * FROM users WHERE email = 'User@Example.com';
-- This does NOT use the index! The expression doesn't match.

-- It must be:
SELECT * FROM users WHERE lower(email) = lower('User@Example.com');

-- Better solution: use citext type and a plain index
```

### 10. Testing Without RLS Enabled

```sql
-- You test as a superuser (postgres). Everything works.
-- In production, the app connects as app_user. RLS kicks in.
-- Queries that returned 100 rows in testing return 0 in production.

-- Always test as the actual application role:
SET ROLE app_user;
SET app.current_tenant_id = 'test_tenant';
-- ... run your tests ...
RESET ROLE;
```

### 11. JSONB Equality is Type-Sensitive

```sql
-- This seems like it should work:
SELECT * FROM products WHERE attributes->>'price' = 100;
-- ERROR: operator does not exist: text = integer

-- ->> returns text. You must compare with text or cast:
SELECT * FROM products WHERE attributes->>'price' = '100';
SELECT * FROM products WHERE (attributes->>'price')::numeric = 100;

-- Containment avoids this problem:
SELECT * FROM products WHERE attributes @> '{"price": 100}';
-- Containment compares JSONB values natively
```

### 12. Array Append Without Deduplication

```sql
-- You use array_append to add tags:
UPDATE posts SET tags = array_append(tags, 'featured') WHERE id = 1;

-- Run it twice: tags = {'tech', 'featured', 'featured'}
-- Arrays don't enforce uniqueness!

-- Deduplicate on write:
UPDATE posts
SET tags = array_append(tags, 'featured')
WHERE id = 1 AND NOT ('featured' = ANY(tags));

-- Or use a function:
CREATE OR REPLACE FUNCTION array_append_unique(arr anyarray, elem anyelement)
RETURNS anyarray LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN elem = ANY(arr) THEN arr ELSE array_append(arr, elem) END;
$$;
```

### 13. Partition Maintenance Failures Are Silent

```sql
-- Your cron job to create next month's partition fails silently.
-- When the month rolls over, inserts to the partitioned table start hitting
-- the default partition (if you have one) or failing (if you don't).

-- Default partition data is hard to move to the correct partition later.
-- Always monitor: verify future partitions exist.

SELECT
    parent.relname AS parent_table,
    child.relname AS partition_name,
    pg_get_expr(child.relpartbound, child.oid) AS partition_range
FROM pg_inherits
JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
JOIN pg_class child ON pg_inherits.inhrelid = child.oid
WHERE parent.relname = 'sensor_readings'
ORDER BY child.relname;
```

### 14. FDW Queries Under Load

```sql
-- A query joining a local table with a foreign table works fine in dev.
-- Under load, each concurrent request opens a connection to the remote server.
-- With 100 concurrent API requests, you have 100 foreign connections.
-- The remote server's max_connections is 100. Connection exhaustion.

-- Solutions:
-- 1. Materialize frequently-accessed foreign data
-- 2. Set connection limits: ALTER SERVER analytics_server OPTIONS (ADD keep_connections 'on');
-- 3. Use a connection pooler on the remote server
```

### 15. pg_stat_statements Without Periodic Reset

```sql
-- pg_stat_statements accumulates data since the last reset.
-- After weeks of uptime, the top queries are dominated by cumulative totals
-- and you can't see recent performance changes.

-- Reset periodically (weekly) and save snapshots:
CREATE TABLE pg_stat_snapshots AS
SELECT now() AS snapshot_at, * FROM pg_stat_statements;

-- Then compare snapshots to detect performance regressions
SELECT pg_stat_statements_reset();
```

> **What a senior engineer actually thinks about:**
> Production databases are operationally complex. Every feature in this chapter — JSONB, FTS, partitioning, triggers, RLS, LISTEN/NOTIFY, FDW, replication — adds capability and complexity. The senior move is to use the minimum set of features needed, monitor everything with `pg_stat_statements`, and have runbooks for the failure modes listed above. Don't adopt a feature because it's cool; adopt it because you've hit the problem it solves and you understand its operational cost.

---

*This completes Part 7. You now understand the major features that make PostgreSQL a production powerhouse: JSONB for flexible data, full-text search for querying natural language, arrays for simple collections, generated columns for computed values, partitioning for massive tables, triggers for automatic behavior, RLS for row-level access control, LISTEN/NOTIFY for real-time events, FDW for cross-boundary queries, replication for availability and distribution, and the extension ecosystem for specialized capabilities. Use them judiciously, monitor their impact, and always understand the operational cost before adopting a feature.*
