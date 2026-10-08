# AGENTS.md

Guidance for AI coding agents working on this repository. Keep entries short, concrete, and verifiable.

## Project

OpenCode Router (OCR) — a local LLM gateway / cascaded router. Bun workspaces: `backend/` (Fastify + pino) and `frontend/` (React + Vite).

## Common commands

- `bun run typecheck` — **run this after any code change** (typechecks both backend and frontend; exit 0 = clean).
- `bun run build` — full build (`tsc -p backend && vite build frontend`).
- `bun run build:frontend` — frontend only (writes to `frontend/dist/`).
- `bun test backend/tests` — backend test suite.

## Frontend conventions

### Dropdowns: always use `Combobox`, never native `<select>`

The native `<select>` popup cannot be themed (it ignores the custom CSS themes), so **every** dropdown in the app must render through `frontend/src/components/Combobox.tsx` for visual consistency. This rule is also documented in that file's header comment.

```tsx
import { Combobox } from '../components/Combobox';

<Combobox
  value={level}
  onChange={setLevel}
  options={[
    { value: '', label: t('logs.levelAll') },
    { value: 'info', label: 'INFO+' },
  ]}
  style={{ fontSize: '12px', padding: '5px 10px', width: '140px' }}
/>
```

API: `value: string`, `onChange: (v: string) => void`, `options: { value, label, meta? }[]`, optional `placeholder`, `clearable`. The filter input only appears when `options.length > 8`.
