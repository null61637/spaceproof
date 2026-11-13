# SpaceProof — frontend

Aplicación Next.js 16 (App Router, React 19, Tailwind CSS 4). La instalación y la ejecución están documentadas en el [README principal](../README.md).

```bash
npm ci
npm run dev     # http://localhost:3000 (requiere el backend en BACKEND_URL)
npm run lint
npm run build   # no necesita el backend en ejecución
```

- `BACKEND_URL` (por defecto `http://localhost:3001`): backend usado por las páginas del servidor, las Server Actions y el proxy `/api/*` (`next.config.ts`). En la imagen Docker se fija al construir.
- `app/`: páginas, formulario (`certificate-form.tsx`) y Server Action (`actions.ts`).
- `lib/api.ts`: cliente del backend, solo del lado del servidor.
