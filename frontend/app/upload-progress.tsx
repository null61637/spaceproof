/** Progress of a file upload; `fraction` goes from 0 to 1. */
export function UploadProgress({ fraction }: { fraction: number }) {
  const percent = Math.round(fraction * 100);
  // All bytes sent: the server is still hashing and answering.
  const sent = fraction >= 1;
  return (
    <div className="flex flex-col gap-1.5" role="status" aria-live="polite">
      <progress
        value={fraction}
        max={1}
        aria-label="Progreso de la subida"
        className="h-2 w-full overflow-hidden rounded-full [&::-moz-progress-bar]:bg-zinc-900 [&::-webkit-progress-bar]:bg-zinc-200 [&::-webkit-progress-value]:bg-zinc-900 dark:[&::-moz-progress-bar]:bg-zinc-100 dark:[&::-webkit-progress-bar]:bg-zinc-800 dark:[&::-webkit-progress-value]:bg-zinc-100"
      />
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        {sent
          ? "Archivo enviado. Esperando la respuesta del servidor…"
          : `Subiendo… ${percent} %`}
      </p>
    </div>
  );
}
