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
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-start gap-3 px-4 py-10 sm:px-6">
      <h1 className="text-xl font-semibold">No se pudieron cargar los datos</h1>
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        El servidor no respondió correctamente. Verificá que el backend esté en
        ejecución e intentá de nuevo.
      </p>
      <button
        onClick={() => retry()}
        className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        Reintentar
      </button>
    </main>
  );
}
