"use client";

import { useActionState } from "react";
import {
  createCertificateAction,
  type CreateCertificateState,
} from "./actions";

const initialState: CreateCertificateState = {
  values: { title: "", recipient: "" },
};

const inputClass =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-zinc-100";

export function CertificateForm() {
  const [state, formAction, pending] = useActionState(
    createCertificateAction,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <Field label="Título" htmlFor="title">
        <input
          id="title"
          name="title"
          required
          maxLength={200}
          defaultValue={state.values.title}
          className={inputClass}
        />
      </Field>

      <Field label="Destinatario" htmlFor="recipient">
        <input
          id="recipient"
          name="recipient"
          required
          maxLength={200}
          defaultValue={state.values.recipient}
          className={inputClass}
        />
      </Field>

      {state.error && (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        {pending ? "Creando…" : "Crear certificado"}
      </button>
    </form>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{hint}</p>
      )}
    </div>
  );
}
