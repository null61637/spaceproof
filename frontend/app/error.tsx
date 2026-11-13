"use client";

import { useEffect } from "react";

export default function ErrorPage({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-start gap-4 px-4 py-16 sm:px-6">
      <p className="eyebrow">Sin conexión con el servidor</p>
      <h1 className="text-2xl font-semibold">No se pudieron cargar los datos</h1>
      <p className="text-sm text-muted">
        El servidor de SpaceProof no respondió. No se perdió nada: intentá de
        nuevo en unos segundos.
      </p>
      <button onClick={() => retry()} className="btn">
        Reintentar
      </button>
    </main>
  );
}
