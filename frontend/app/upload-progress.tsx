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
        className="h-1.5 w-full overflow-hidden rounded-full [&::-moz-progress-bar]:bg-accent [&::-webkit-progress-bar]:bg-panel-raised [&::-webkit-progress-value]:bg-accent"
      />
      <p className="hint">
        {sent
          ? "Archivo enviado. Calculando la huella en el servidor…"
          : `Subiendo… ${percent} %`}
      </p>
    </div>
  );
}
