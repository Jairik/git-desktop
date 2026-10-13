# Linting

[What is linting, anyways?](https://en.wikipedia.org/wiki/Lint_%28software%29)

## Tooling

Our linting tooling uses a combination of

* [Prettier](https://github.com/prettier/prettier)
* [ESLint](https://github.com/eslint/eslint)

Most (if not all) editors have integrations for these tools so that they will report errors and fix formatting in realtime. See [tooling](./tooling.md) for how to set these integrations up while developing for desktop.

## Running Checks

Use

```shellsession
$ yarn lint
```

in your local repository to run all linting checks. Each tool will report their errors on the command line.

## Fixing Issues

Some issues found by linters can be automatically fixed. Use

```shellsession
$ yarn lint:fix
```

to automatically fix them. If any issues remain, you'll have to fix them manually (and the output will tell you that).

## Linting Locally

Linting runs locally rather than in CI — this fork has no CI pipelines. Run
`yarn lint:fix` before committing so formatting and lint rules are satisfied.
