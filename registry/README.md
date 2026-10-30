# Lumen package index

`index.json` lists the packages that `name = "^1.2"` in a `lumen.toml` can find. Each entry gives a git url and the versions released; a version `1.2.0` is the git tag `v1.2.0` in that repository.

```json
{
  "packages": {
    "colors": { "git": "https://github.com/someone/lumen-colors.git", "versions": ["1.0.0", "1.1.0"] }
  }
}
```

To add a package, push the tags to your repository and open a pull request that adds or extends your entry here.
Set `LUMEN_REGISTRY` to another index (an https or `file://` url, or a path) to use your own.
