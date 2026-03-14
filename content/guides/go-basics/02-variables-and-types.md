---
title: Variables and Types
description: Understand explicit declarations, short assignment, and Go's preference for readable type usage.
---

# Variables and Types

Go gives you a small set of declaration patterns and expects you to use the simplest one that fits the situation.

## Declare explicitly

Use `var` when the zero value matters or when you want to make the type obvious:

```go
var retries int
var name string = "gopher"
```

## Prefer short declarations in local scope

Inside functions, short declarations keep code compact:

```go
count := 3
label := "ready"
```

The compiler still infers the type, but the code remains easy to scan.
