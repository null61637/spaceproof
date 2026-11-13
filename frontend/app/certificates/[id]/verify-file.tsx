"use client";

import { useRef, useState } from "react";
import {
  MAX_FILE_BYTES,
  explorerTxUrl,
  formatBytes,
  formatDate,
  type Verification,
} from "@/lib/certificates";
import { UploadError, fileProblem, uploadFile } from "@/lib/upload";
import { UploadProgress } from "../../upload-progress";

type Tone = "ok" | "bad" | "unknown";

const toneClass: Record<Tone, string> = {
  ok: "tone-ok",
  bad: "tone-bad",
  unknown: "tone-unknown",
};

// The verdict in one word, as the API names it. Anything that is not VALID
// or INVALID is shown as not verified, PENDING included.
const VERDICT: Record<Tone, { word: string; className: string }> = {
  ok: { word: "VÁLIDO", className: "text-ok" },
  bad: { word: "INVÁLIDO", className: "text-bad" },
  unknown: { word: "NO VERIFICABLE", className: "text-unknown" },
};

// One message per result of the API (docs/API_EMISION_VERIFICACION.md). The
// words are about integrity only: matching the certificate says nothing about
// where the file comes from or who made it.
function describe(result: Verification): {
  tone: Tone;
  title: string;
  text: string;
} {
  switch (result.reason) {
    case "FILE_MISMATCH":
      return {
        tone: "bad",
        title: "Archivo alterado o distinto",
        text: "Este archivo no coincide con el que se certificó: fue modificado o es otro archivo.",
      };
    case "RECORD_MISMATCH":
      return {
        tone: "bad",
        title: "Manifiesto alterado",
        text: "Los datos guardados de este certificado no coinciden con su hash: el registro fue alterado después de emitirse.",
      };
    case "ANCHOR_RECORD_MISMATCH":
      return {
        tone: "bad",
        title: "El registro de anclaje no coincide con Avalanche",
        text: "El archivo y el manifiesto coinciden, y el hash está en el contrato, pero la transacción o la fecha que SpaceProof tiene guardadas no son las que muestra la blockchain. El registro de anclaje fue alterado o es incorrecto.",
      };
    case "NOT_ANCHORED":
      if (result.status === "INVALID") {
        return {
          tone: "bad",
          title: "Figura como confirmado, pero no está en Avalanche",
          text: "El archivo y el manifiesto coinciden con lo guardado en SpaceProof, pero el contrato respondió que el hash no está registrado, aunque SpaceProof lo tiene como confirmado.",
        };
      }
      return {
        tone: "unknown",
        title: "Coincide, pero todavía no está registrado en Avalanche",
        text: "El archivo y el manifiesto coinciden con lo certificado en SpaceProof. Avalanche respondió que el hash del certificado todavía no está registrado: sin ese registro independiente, esto no es una verificación completa.",
      };
    case "ANCHOR_TARGET_MISMATCH":
      return {
        tone: "unknown",
        title: "No verificable en Avalanche: otro contrato",
        text: "El archivo y el manifiesto coinciden con lo guardado en SpaceProof, pero el anclaje de este certificado apunta a un contrato distinto del que este servidor consulta. No se pudo comprobar.",
      };
    case "ANCHOR_NOT_CONFIGURED":
      return {
        tone: "unknown",
        title: "No verificable en Avalanche: sin conexión configurada",
        text: "El archivo y el manifiesto coinciden con lo guardado en SpaceProof, pero este servidor no tiene configurada la lectura del contrato. Sin esa comprobación independiente, esto no es una verificación completa.",
      };
    case "ANCHOR_UNAVAILABLE":
      return {
        tone: "unknown",
        title: "No verificable en Avalanche: sin respuesta",
        text: "El archivo y el manifiesto coinciden con lo guardado en SpaceProof, pero no se pudo consultar Avalanche. Sin esa comprobación, esto no es una verificación completa. Intentá de nuevo en unos minutos.",
      };
    case null:
      break;
  }
  if (result.status === "VALID") {
    return {
      tone: "ok",
      title: "Integridad verificada",
      text: `El archivo y sus metadatos coinciden, bit a bit, con lo que se certificó, y el hash del certificado está registrado en Avalanche${
        result.anchoredAt ? ` desde el ${formatDate(result.anchoredAt)}` : ""
      }.`,
    };
  }
  // A status this interface does not know is never shown as a success.
  return {
    tone: "unknown",
    title: "Resultado no reconocido",
    text: "El servidor devolvió un resultado que esta página no sabe interpretar.",
  };
}

const CHECK_TEXT: Record<string, string> = {
  MATCH: "coincide",
  MISMATCH: "no coincide",
  NOT_CHECKED: "no se comprobó",
  ANCHORED: "registrado",
  NOT_ANCHORED: "no registrado",
  NOT_CONFIGURED: "sin conexión configurada",
  UNAVAILABLE: "sin respuesta",
};

export function VerifyFile({ certificateId }: { certificateId: string }) {
  const [result, setResult] = useState<Verification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const upload = useRef<AbortController | null>(null);
  const sending = progress !== null;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending) return;
    setError(null);
    setResult(null);

    const file = new FormData(event.currentTarget).get("file");
    if (!(file instanceof File) || file.name === "") {
      return setError("Elegí el archivo que querés comprobar.");
    }
    // No TIFF check here: an altered file must be reported as altered.
    const problem = await fileProblem(file, { requireTiff: false });
    if (problem) return setError(problem);

    const controller = new AbortController();
    upload.current = controller;
    setProgress(0);
    try {
      setResult(
        await uploadFile<Verification>({
          url: `/api/certificates/${encodeURIComponent(certificateId)}/verify-file`,
          file,
          onProgress: setProgress,
          signal: controller.signal,
        }),
      );
    } catch (failure) {
      if (!(failure instanceof UploadError && failure.aborted)) {
        setError(
          failure instanceof UploadError
            ? failure.message
            : "No se pudo verificar el archivo. Intentá de nuevo.",
        );
      }
    } finally {
      setProgress(null);
    }
  }

  const outcome = result && describe(result);
  const txUrl =
    result?.anchor && explorerTxUrl(result.anchor.chainId, result.anchor.txHash);

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-3">
        <label htmlFor="verify-file" className="label">
          Archivo a comprobar
        </label>
        <input
          id="verify-file"
          name="file"
          type="file"
          required
          disabled={sending}
          className="file-input"
        />
        <p className="hint">
          Hasta {formatBytes(MAX_FILE_BYTES)}. El archivo se usa solo para
          calcular su huella: no se guarda.
        </p>

        {sending && <UploadProgress fraction={progress} />}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={sending}
            className="btn"
          >
            {sending ? "Verificando…" : "Verificar archivo"}
          </button>
          {sending && (
            <button
              type="button"
              onClick={() => upload.current?.abort()}
              className="btn-secondary"
            >
              Cancelar
            </button>
          )}
        </div>
      </form>

      {error && (
        <p
          role="alert"
          className="alert-error"
        >
          {error}
        </p>
      )}

      {result && outcome && (
        <div
          role="status"
          aria-live="polite"
          className={`tone ${toneClass[outcome.tone]} flex flex-col gap-3 p-5`}
        >
          <p
            className={`text-2xl font-semibold tracking-tight ${VERDICT[outcome.tone].className}`}
          >
            {VERDICT[outcome.tone].word}
          </p>
          <p className="text-base font-semibold">{outcome.title}</p>
          <p className="text-sm text-muted">{outcome.text}</p>

          <ul className="grid gap-1 text-sm sm:grid-cols-3">
            <li>
              <span className="text-muted">Archivo:</span>{" "}
              {CHECK_TEXT[result.checks.file] ?? "desconocido"}
            </li>
            <li>
              <span className="text-muted">Manifiesto:</span>{" "}
              {CHECK_TEXT[result.checks.record] ?? "desconocido"}
            </li>
            <li>
              <span className="text-muted">Avalanche:</span>{" "}
              {CHECK_TEXT[result.checks.anchor] ?? "desconocido"}
            </li>
          </ul>
          {txUrl && (
            <a
              href={txUrl}
              target="_blank"
              rel="noreferrer"
              className="link text-sm"
            >
              Ver la transacción de anclaje en Snowtrace
            </a>
          )}

          <details className="text-xs text-muted">
            <summary className="cursor-pointer font-medium">
              Detalle técnico
            </summary>
            <dl className="mt-2 flex flex-col gap-2">
              {result.file && (
                <>
                  <Hash
                    label="SHA-256 del archivo certificado"
                    value={result.file.storedSha256}
                  />
                  <Hash
                    label={`SHA-256 del archivo recibido (${formatBytes(result.file.receivedSizeBytes)})`}
                    value={result.file.receivedSha256}
                  />
                </>
              )}
              <Hash
                label="Hash del manifiesto guardado"
                value={result.storedHash}
              />
              <Hash
                label="Hash del manifiesto recalculado"
                value={result.computedHash}
              />
            </dl>
          </details>
        </div>
      )}
    </div>
  );
}

function Hash({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-medium">{label}</dt>
      <dd>
        <code className="hash text-xs">{value}</code>
      </dd>
    </div>
  );
}
