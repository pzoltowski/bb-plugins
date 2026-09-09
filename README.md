# bb-plugins

BB plugins by Patryk Zoltowski.

| Plugin | Status | What it does |
| --- | --- | --- |
| [muse-acp](plugins/muse-code) | scaffold | Registers Muse Code as a bb agent provider through the `muse-acp` adapter. |

## Layout

One repository, one plugin per directory under `plugins/`, each released on its
own `<plugin>/vX.Y.Z` tag. bb installs a single plugin straight out of the
subdirectory:

```sh
bb plugin install git:https://github.com/pzoltowski/bb-plugins.git@semver:muse-code/:^0.1.0 --plugin muse-code
```

Local development installs the path instead:

```sh
npm install
bb plugin install ./plugins/muse-code
```

## Related repositories

- [`pzoltowski/bb-plugins-mateo`](https://github.com/pzoltowski/bb-plugins-mateo)
  — fork of [MateoCerquetella/bb-plugins](https://github.com/MateoCerquetella/bb-plugins),
  used only to stage pull requests upstream. No plugins of mine live there.
- [`pzoltowski/muse-acp`](https://github.com/pzoltowski/muse-acp) — fork of
  [BrokkAi/muse-acp](https://github.com/BrokkAi/muse-acp), used only to stage
  pull requests upstream.
