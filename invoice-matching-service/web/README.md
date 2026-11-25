# Invoice Matching page

The review page (React + TypeScript, Vite). It **only shows** what the API returns: every rule lives in the API, a separate project, **api** (beside this one: [`../api`](../api/README.md)).

Running both together, and what the page shows: the README in the folder that holds both projects ([`../README.md`](../README.md)).

## Set up

Needs **Node 24 or newer** (`node -v`).

```bash
cd ~/Desktop/research/invoice-matching/invoice-matching-service/web
```

The first time only:

```bash
cp -n .env.example .env
```

```bash
npm install
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | The page on http://localhost:5173, with live reload. Start the API too (`npm start` in the api project) |
| `npm run build` | Check the types, then build the page into `dist/` |
| `npm run typecheck` | Check the types only |

## Docker

With the API: `docker compose up --build` in the folder that holds both projects. The page alone, on http://localhost:8080, with the API running on this computer (`npm start` in the api project, with `WEB_ORIGINS=http://localhost:8080`):

```bash
docker build -t invoice-matching-web . && docker run --rm -e API_URL=http://host.docker.internal:3000 -p 127.0.0.1:8080:80 invoice-matching-web
```

`API_URL` must be set: the image's default (`http://api:3000`) only exists inside `compose.yaml`, and nginx won't start without it.

## How it reaches the API

The page calls `/api/…` on its own address. Its server forwards those calls to the API, so the browser talks to one address only (no CORS):

| Where | Who forwards `/api` | To |
|---|---|---|
| `npm run dev` | Vite (`vite.config.ts`) | `API_URL` |
| Docker | nginx (`nginx.conf.template`) | `API_URL` (`http://api:3000` in `compose.yaml`) |

The API answers only the page's addresses: if you open the page somewhere else, add that address to the API's `WEB_ORIGINS`.

## Settings

Set in this folder's `.env`. **No secrets here.** Vite copies every `VITE_` setting into the page, where anyone can read it: AWS keys belong only in the API's `.env`.

| Setting | Default | What it does |
|---|---|---|
| `API_URL` | `http://localhost:3000` | Where the API runs. Change it with the API's `PORT` (or on the command line: `API_URL=http://localhost:3001 npm run dev`) |

## Finding your way in the code

| What | Where |
|---|---|
| The page | `src/App.tsx` → `src/components/` |
| Calls to the API | `src/api.ts` |
| What the API returns | `src/types.ts` (mirrors `api/src/invoices/invoice.view.ts`) |
| Styles | `src/styles/` |
