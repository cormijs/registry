# Cormi Registry

The index of the [Cormi](https://github.com/cormijs/cormi) plugins on npm, which the market of the console reads:

```
https://cdn.jsdelivr.net/gh/cormijs/registry@dist/index.json
```

A GitHub Action syncs it every day (and on every push to `main`):

1. It searches npm for the packages with the `cormi-plugin` keyword, at their latest versions.
2. It reads the manifest of each: the bundlers and UI frameworks it declares to support (the `cormi` field of package.json, read by `conclude()` of `@cormijs/core`).
3. It installs them in a sandbox with every bundler and UI framework, and runs `cormi plugin check` on each: a plugin whose declaration is what the check infers is **verified**.
4. It adds the downloads of the last month, and pushes `index.json` to the `dist` branch.

The format is `RegistryIndex` of `@cormijs/core`. To list a plugin, publish it with the `cormi-plugin` keyword, and declare what it supports (`cormi plugin check --write`).

```sh
npm install
npm run sync            # dist/index.json, without the checks
npm run sync:verify     # with the checks
```
