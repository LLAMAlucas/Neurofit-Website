# Archived designs

Kept so the site can be switched back without digging through git history.

## `site-fog-glass/` — the marketing site as it was live until 2026-10-13

The pale foggy-blue theme with liquid-glass buttons and the particle body in fog. It is an exact
copy of `site/` at commit `4cbe657`, which is also tagged **`design/fog-glass`**.

It is self-contained: `npm ci && npm run build` works, and `npm run check` passes. Nothing else in
the repo imports it, and neither Vercel project builds it until you point one at it.

### Switching neurofit-training.com back

- **No code change:**
  1. In Vercel, open project `neurofit-website` → Settings → Build & Deployment → Root Directory.
  2. Set it to `archive/site-fog-glass`, then redeploy.

  To return to the new design, set it back to `site`.
- **In the repo:** replace `site/` with this folder, then commit and push to `main`:
  ```
  git rm -r site
  git mv archive/site-fog-glass site
  ```

This copy is frozen. Anything changed in `site/` after 2026-10-13 is not in it, such as wording or
the comparison chart's data.

### The tracker's old look (try.neurofit-training.com)

The tracker is not copied here. Its look is woven through the app, so a frozen copy of the whole
app would miss every later fix.

The tag `design/fog-glass` marks the last commit with the glass tracker.
`git diff design/fog-glass main -- src/neurofit` shows what the dark theme changed. Files can be
restored from the tag with `git checkout design/fog-glass -- <paths>`; any later changes to those
files then have to be merged by hand.
