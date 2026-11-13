# SpaceProof — frontend

Aplicación Next.js 16 (App Router, React 19, Tailwind CSS 4). La instalación y la ejecución están documentadas en el [README principal](../README.md).

```bash
npm ci
npm run dev     # http://localhost:3000 (requiere el backend en BACKEND_URL)
npm run lint
npm run build   # no necesita el backend en ejecución
```

- `BACKEND_URL` (por defecto `http://localhost:3001`): backend usado por las páginas del servidor y por el proxy `/api/*` (`app/api/[...path]/route.ts`), que la lee al ejecutarse.
- `app/`: páginas, formulario de emisión (`certificate-form.tsx`), verificación de archivos (`certificates/[id]/verify-file.tsx`) y proxy en flujo hacia el backend (`api/[...path]/route.ts`).
- `lib/api.ts`: lecturas del backend, solo del lado del servidor. `lib/upload.ts`: subida de archivos desde el navegador. `lib/certificates.ts`: tipos y utilidades compartidos.
