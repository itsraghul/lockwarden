# lock-warden

This is a typo-guard alias for [`lockwarden`](https://www.npmjs.com/package/lockwarden) — a security tool must not let the most natural mistyping of its name execute someone else's code, so we own it.

It contains no code of its own; it depends on `lockwarden` and re-executes its CLI.

```bash
npx lockwarden check <pkg>@<version>   # ← use this
npx lock-warden check <pkg>@<version>  # works too, same thing
```

MIT © Raghul
