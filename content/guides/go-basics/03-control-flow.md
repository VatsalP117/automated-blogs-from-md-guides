---
title: Control Flow
description: Explore conditionals, loops, and the intentionally narrow set of control-flow constructs in Go.
---

# Control Flow

Go stays opinionated here too: one loop keyword, straightforward conditionals, and very little syntactic ceremony.

## If statements

An `if` statement can include a short setup clause:

```go
if err := run(); err != nil {
    log.Fatal(err)
}
```

## For loops

`for` handles the jobs that other languages split across `while`, `do while`, and classic counted loops:

```go
for i := 0; i < 3; i++ {
    fmt.Println(i)
}
```

That small surface area is part of what makes unfamiliar Go code readable so quickly.
