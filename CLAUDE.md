# CLAUDE.md

- docs/DESIGN.md is the source of truth. Do not change behaviour it specifies; if something is unclear or seems wrong, stop and ask me.
- Stack: pnpm workspaces; TypeScript strict everywhere except /worker (plain JavaScript, ESM, Node.js 22); AWS CDK v2 in /infra; Vitest; ESLint + Prettier.
- Layout: /infra (CDK), /packages/shared (types, schemas, DynamoDB access, auth, scoring, queue message contracts), /services/api (API Lambdas), /services/pipeline (test-generation, transcribe, record Lambdas), /worker (execution worker + Dockerfile), /web (React app), /scripts, /prompts (Gemini prompt files), /docs.
- Every API handler checks the caller's role and batch access through the shared auth helper. No route skips it.
- Never put secrets in code or config files. Gemini key and Google OAuth secret live in Secrets Manager.
- Write tests for every handler, including permission denials. Mock AWS with aws-sdk-client-mock and Gemini with a fake client.
- Never run cdk deploy, delete AWS resources, or call the real Gemini API unless the prompt explicitly says so.
- Git: use the git identity already configured on this machine. Never add Co-Authored-By or any other trailer, and never mention Claude or AI assistance as the author of code, commit messages, comments or repo files. Describing the product's use of Gemini is fine.
- When a step is done: run pnpm lint, pnpm typecheck and pnpm test; then summarise what you built, any deviation from DESIGN.md, and any manual steps I need to take. Do not start the next step.

## Repo map

- `/infra`: AWS CDK v2 app (stacks and constructs). Nothing is deployed from here without an explicit instruction.
- `/packages/shared`: types, schemas, DynamoDB access, auth helper, scoring, queue message contracts. Used by the API, pipeline and web packages.
- `/services/api`: API Lambda handlers behind API Gateway.
- `/services/pipeline`: test-generation, transcribe and record Lambdas.
- `/worker`: execution worker (plain JavaScript, ESM, Node.js 22) and its Dockerfile.
- `/web`: React single-page app.
- `/scripts`: one-off and maintenance scripts.
- `/prompts`: Gemini prompt files.
- `/docs`: design documents; `DESIGN.md` is the source of truth.
