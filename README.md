# GitHub Desktop (fork)

This repository is a personal fork of
[GitHub Desktop](https://github.com/desktop/desktop) — an open-source
[Electron](https://www.electronjs.org/)-based Git app. It is written in
[TypeScript](https://www.typescriptlang.org) and uses
[React](https://reactjs.org/).

> **This fork has been condensed into a minimal local server-client client: a
> Rust backend daemon, a React web client, and a thin Electron shell. See
> [`docs/architecture/README.md`](docs/architecture/README.md) and
> [`docs/BUILD.md`](docs/BUILD.md).** The legacy Electron app in [`app/`](app) is
> retained for reference and incremental porting, but the active product shape is
> the `server/` + `client/` (+ `desktop/`) split.
>
> The one big difference from upstream: upstream is a single Electron app (UI +
> git engine in one process); this fork splits that into `server/` (a Rust
> `axum` daemon that runs the `git` CLI and exposes a documented JSON-RPC API on
> `127.0.0.1:4789`) and `client/` (a standalone React/TypeScript/Vite web client
> that is a thin client over that API). GitHub-specific features are thin and
> optional: PRs/CI surface through the `gh` CLI, and local AI agents (the
> `opencode`/`claude`/`codex` CLIs, auto-detected) add commit-message generation,
> file comments and reviews. None of it is part of the core local Git engine.

<picture>
  <source
    srcset="https://user-images.githubusercontent.com/634063/202742848-63fa1488-6254-49b5-af7c-96a6b50ea8af.png"
    media="(prefers-color-scheme: dark)"
  />
  <img
    width="1072"
    src="https://user-images.githubusercontent.com/634063/202742985-bb3b3b94-8aca-404a-8d8a-fd6a6f030672.png"
    alt="A screenshot of the application showing changes being viewed and committed with two attributed co-authors"
  />
</picture>

## Where can I get it?

There are no public releases — this is a local, self-maintained build. Build it
yourself:

```
yarn install
yarn build:prod
```

The packaged app lands in `out/`. See
[`docs/contributing/setup.md`](docs/contributing/setup.md) for the full
environment setup per platform, and
[`docs/technical/packaging.md`](docs/technical/packaging.md) for how packaging
works.

If you'd rather use the supported upstream product, the official installers are
published by GitHub at [desktop.github.com](https://desktop.github.com).

## I have a problem

Because this fork has its own issue tracker, please report problems here rather
than on the upstream repository.

First, check the [known issues](docs/known-issues.md) to see whether your issue
is already tracked and has a workaround. If not, open a new issue with enough
information to reproduce it.

## How can I contribute?

The [documentation](docs) folder contains everything you need to get familiar
with the source — start with
[`docs/contributing/setup.md`](docs/contributing/setup.md), then the
[engineering values](docs/contributing/engineering-values.md) and
[style guide](docs/contributing/styleguide.md).

## Building Desktop

To set up your development environment for building, check out:
[`setup.md`](docs/contributing/setup.md).

## More Resources

See [desktop.github.com](https://desktop.github.com) for more product-oriented
information about the upstream GitHub Desktop application.

See the [getting started documentation](https://docs.github.com/en/desktop/overview/getting-started-with-github-desktop)
for more information on how to set up, authenticate, and configure the
application.

## License

**[MIT](LICENSE)**

The MIT license grant is not for GitHub's trademarks, which include the logo
designs. GitHub reserves all trademark and copyright rights in and to all
GitHub trademarks. GitHub's logos include, for instance, the stylized
Invertocat designs that include "logo" in the file title in the following
folder: [logos](app/static/logos).

GitHub® and its stylized versions and the Invertocat mark are GitHub's
Trademarks or registered Trademarks. When using GitHub's logos, be sure to
follow the GitHub [logo guidelines](https://github.com/logos).
