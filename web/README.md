# Web app

React + Vite + TypeScript single-page app for the Paper DSA Exam Judge. It signs in with Google through the Cognito hosted UI and calls the API with the ID token. It is hosted on Vercel.

## Commands

Run from the repository root (a pnpm workspace; `@yulove/shared` is used as source, so there is nothing to build first).

| Command                                     | Does                                                                                               |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `AWS_PROFILE=<profile> pnpm web:env`        | Writes `web/public/config.json` for local development from the deployed stacks (gitignored)        |
| `pnpm --filter @yulove/web dev`             | Dev server on http://localhost:5173 (the port is fixed because Cognito allows exactly that origin) |
| `pnpm --filter @yulove/web test`            | Vitest and React Testing Library                                                                   |
| `pnpm --filter @yulove/web build`           | Typecheck and build to `web/dist`. Needs no environment variables                                  |
| `pnpm --filter @yulove/web build:vercel`    | `build`, then writes `dist/config.json` from the `DSA_*` variables below. Fails if any is missing  |
| `AWS_PROFILE=<profile> pnpm web:vercel-env` | Prints the three values to paste into Vercel                                                       |

## Runtime config

The app loads `/config.json` before it starts, so no deployment-specific value is baked into the build. It needs three keys: `apiUrl`, `cognitoDomain` and `clientId`. The redirect and logout URLs are not configured: the app uses `window.location.origin` (`<origin>/auth/callback` and `<origin>/`), so every origin it is served from has to be in `webOrigin` in `infra/cdk.json`.

## Deploying on Vercel

Create a Vercel project from this repository with these settings (`web/vercel.json` holds the same commands, so they apply even if the dashboard fields are left alone; Root Directory can only be set in the dashboard):

| Setting                                                              | Value                                                                  |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Root Directory                                                       | `web`                                                                  |
| Include source files outside of the Root Directory in the Build Step | **On**. The build needs `@yulove/shared` and the root `pnpm-lock.yaml` |
| Framework Preset                                                     | Vite                                                                   |
| Install Command                                                      | `cd .. && pnpm install --frozen-lockfile --filter @yulove/web...`      |
| Build Command                                                        | `pnpm run build:vercel`                                                |
| Output Directory                                                     | `dist`                                                                 |
| Node.js Version                                                      | 22.x                                                                   |

The install command runs at the workspace root and installs `@yulove/web` plus the workspace packages it depends on (`@yulove/shared`), not infra, the API or the worker.

**Environment variables** (Project Settings → Environment Variables), for every environment that builds (Production, and Preview if you want previews):

| Name                 | Value                                                                     |
| -------------------- | ------------------------------------------------------------------------- |
| `DSA_API_URL`        | The API URL (the `ApiUrl` output of `DsaJudgeApi`)                        |
| `DSA_COGNITO_DOMAIN` | The hosted UI domain (the `HostedUiBaseUrl` output of `DsaJudgeAuth`)     |
| `DSA_CLIENT_ID`      | The user pool client id (the `UserPoolClientId` output of `DsaJudgeAuth`) |

`AWS_PROFILE=<profile> pnpm web:vercel-env` prints all three as `NAME=value` lines. They are public identifiers, not secrets. The build writes them to `dist/config.json`, so changing one needs a redeploy.

**Allow the site to sign in and call the API.** After the first deploy, add the site's address to `webOrigin` in `infra/cdk.json`, comma-separated and keeping localhost, for example:

```json
"webOrigin": "http://localhost:5173,https://your-project.vercel.app"
```

Then redeploy the Data, Auth and Api stacks. That sets the Cognito callback and logout URLs, the API CORS origins and the bucket CORS origins. Cognito matches callback URLs exactly, so a Vercel preview deployment (each has its own address) can't sign in unless its address is listed too; use the production domain.

All paths are rewritten to `/index.html` (single-page app), and `/config.json` is never cached.
