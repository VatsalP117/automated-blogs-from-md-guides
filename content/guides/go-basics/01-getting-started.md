---
title: Getting Started With Go
description: Install the toolchain, create your first module, and understand the structure of a minimal Go project.
---

# Getting Started With Go

Go keeps the first-run experience intentionally small. Once the compiler is installed, most of the early workflow revolves around a handful of commands.

## Install and verify

Start by installing the latest stable release for your platform. Once that is done, confirm the toolchain is available:

```bash
go version
```

## Create a module

Every non-trivial project should live inside a module:

```bash
mkdir hello-go
cd hello-go
go mod init example.com/hello-go
```

The `go.mod` file becomes the root of dependency and version management for the project.
