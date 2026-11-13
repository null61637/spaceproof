"use client";

import { useEffect, useState } from "react";
import {
  explorerAddressUrl,
  explorerTxUrl,
  formatDate,
  type Verification,
} from "@/lib/certificates";

type Tone = "ok" | "bad" | "unknown" | "info";

// While the anchor is on its way, ask again every few seconds, for a while.
const POLL_MS = 4000;
const MAX_POLLS = 75;

/**
 * What to say about the anchoring of a certificate, from a verification of
 * its record (no file involved). Success is only ever said for VALID: every
 * state this page does not know falls through to "unknown".
 */
function describe(result: Verification): {
  tone: Tone;
  title: string;
  text: string;
  /** Still moving: keep asking. */
  live: boolean;
} {
  const sending = result.anchor?.status;
  switch (result.reason) {
    case "RECORD_MISMATCH":
      return {
        tone: "bad",
        title: "El registro del certificado fue alterado",
        text: "Los datos guardados no coinciden con el hash del certificado. No se consultó Avalanche.",
        live: false,
      };
    case "ANCHOR_RECORD_MISMATCH":
      return {
        tone: "bad",
        title: "El registro de anclaje no coincide con Avalanche",
        text: "El hash del certificado está en el contrato, pero la transacción o la fecha que SpaceProof tiene guardadas no son las que muestra la blockchain.",
        live: false,
      };
    case "NOT_ANCHORED":
      if (result.status === "INVALID") {
        return {
          tone: "bad",
          title: "Figura como confirmado, pero no está en Avalanche",
          text: "SpaceProof tiene este anclaje como confirmado y el contrato respondió que el hash no está registrado.",
          live: false,
        };
      }
      if (sending === "SUBMITTED") {
        return {
          tone: "info",
          title: "Transacción enviada, esperando confirmación",
          text: "El hash del certificado se envió al contrato. Todavía no figura registrado en Avalanche.",
          live: true,
        };
      }
      if (sending === "FAILED") {
        return {
          tone: "bad",
          title: "El anclaje falló",
          text: "SpaceProof no logró registrar el hash en Avalanche después de varios intentos. El certificado no está anclado.",
          live: false,
        };
      }
      if (sending === "PENDING") {
        return {
          tone: "info",
          title: "En cola para anclarse",
          text: "El certificado está emitido. Su hash todavía no se envió a Avalanche.",
          live: true,
        };
      }
      return {
        tone: "unknown",
        title: "No registrado en Avalanche",
        text: "El contrato respondió que el hash de este certificado no está registrado, y no hay un anclaje en curso.",
        live: false,
      };
    case "ANCHOR_TARGET_MISMATCH":
      return {
        tone: "unknown",
        title: "No verificable: el anclaje apunta a otro contrato",
        text: "El registro de anclaje de este certificado nombra un contrato distinto del que este servidor consulta. No se pudo comprobar.",
        live: false,
      };
    case "ANCHOR_NOT_CONFIGURED":
      return {
        tone: "unknown",
        title: "No verificable: sin conexión con Avalanche",
        text: "Este servidor no tiene configurada la lectura del contrato. El certificado existe, pero su anclaje no se puede comprobar desde aquí.",
        live: false,
      };
    case "ANCHOR_UNAVAILABLE":
      return {
        tone: "unknown",
        title: "No verificable: Avalanche no respondió",
        text: "No se pudo consultar la blockchain en este momento. Esto no dice nada sobre el certificado: intentá de nuevo.",
        live: false,
      };
    case "FILE_MISMATCH":
    case null:
      break;
  }
  if (result.status === "VALID") {
    return {
      tone: "ok",
      title: "Registrado en Avalanche",
      text: `El contrato tiene registrado el hash de este certificado${
        result.anchoredAt ? ` desde el ${formatDate(result.anchoredAt)}` : ""
      }.`,
      live: false,
    };
  }
  return {
    tone: "unknown",
    title: "Estado no reconocido",
    text: "El servidor devolvió un resultado que esta página no sabe interpretar.",
    live: false,
  };
}

const CHIP_TONE: Record<string, string> = {
  PENDING: "text-info",
  SUBMITTED: "text-info",
  CONFIRMED: "text-ok",
  FAILED: "text-bad",
};

/** The anchoring of a certificate, read live and refreshed while it moves. */
export function AnchorStatus({ certificateId }: { certificateId: string }) {
  const [result, setResult] = useState<Verification | null>(null);
  const [failed, setFailed] = useState(false);
  const [polls, setPolls] = useState(0);

  // Each change of `tick` asks the server once.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/certificates/${encodeURIComponent(certificateId)}/verify`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<Verification>;
      })
      .then((body) => {
        setResult(body);
        setFailed(false);
      })
      .catch((error: { name?: string }) => {
        if (error.name !== "AbortError") setFailed(true);
      });
    return () => controller.abort();
  }, [certificateId, tick]);

  const outcome = result && describe(result);
  const polling = Boolean(outcome?.live) && polls < MAX_POLLS;

  useEffect(() => {
    if (!polling) return;
    const timer = setTimeout(() => {
      setPolls((n) => n + 1);
      setTick((n) => n + 1);
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [polling, tick]);

  const refresh = () => {
    setPolls(0);
    setTick((n) => n + 1);
  };

  if (result === null || outcome === null) {
    return failed ? (
      <div className="tone tone-unknown flex flex-col items-start gap-3 p-5">
        <p className="font-semibold">No se pudo consultar el estado</p>
        <p className="text-sm text-muted">
          El servidor no respondió. El certificado no cambió.
        </p>
        <button type="button" onClick={refresh} className="btn-secondary">
          Reintentar
        </button>
      </div>
    ) : (
      <div
        role="status"
        aria-label="Consultando Avalanche"
        className="skeleton h-28"
      />
    );
  }

  const anchor = result.anchor ?? null;
  const txUrl = anchor && explorerTxUrl(anchor.chainId, anchor.txHash);
  const contractUrl =
    anchor && explorerAddressUrl(anchor.chainId, anchor.contractAddress);

  return (
    <div
      role="status"
      aria-live="polite"
      className={`tone tone-${outcome.tone} flex flex-col gap-3 p-5`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="eyebrow">Anclaje en Avalanche</p>
        {anchor && (
          <span
            className={`chip ${CHIP_TONE[anchor.status] ?? "text-muted"} ${
              polling ? "chip-live" : ""
            }`}
          >
            {anchor.status}
          </span>
        )}
      </div>
      <p className="text-lg font-semibold">{outcome.title}</p>
      <p className="text-sm text-muted">{outcome.text}</p>

      {(txUrl || contractUrl) && (
        <dl className="mt-1 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[7rem_1fr]">
          {txUrl && anchor?.txHash && (
            <>
              <dt className="text-muted">Transacción</dt>
              <dd className="min-w-0">
                <a
                  href={txUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="link hash"
                >
                  {anchor.txHash}
                </a>
              </dd>
            </>
          )}
          {contractUrl && anchor && (
            <>
              <dt className="text-muted">Contrato</dt>
              <dd className="min-w-0">
                <a
                  href={contractUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="link hash"
                >
                  {anchor.contractAddress}
                </a>
              </dd>
            </>
          )}
        </dl>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={refresh} className="btn-secondary">
          Actualizar
        </button>
        {polling && <span className="hint">Se actualiza solo…</span>}
        {failed && (
          <span className="hint">
            La última consulta no respondió; se muestra el estado anterior.
          </span>
        )}
      </div>
    </div>
  );
}
